// Formation controller (see docs/FORMATIONS.md for the design and sources).
//
// An invisible anchor carries the formation. Members are assigned to typed
// slots (Hungarian on squared distances) and steer to them with feed-forward
// offset pursuit. Three movement modes:
//   sync  - every member walks straight (or paths) to its destination slot at a
//           speed chosen so that all arrive together (short moves, re-forming,
//           big turns, deploying at the end of a march)
//   rigid - the anchor follows a corner-rounded path; slots are rigid offsets
//   march - the hidden AoE2 "marching formation": a 3-wide column whose slots
//           snake along the path; it deploys into the battle layout near the end

import { NavGrid } from './navgrid';
import { angleDiff, clamp, dist, type Vec2 } from './math';
import { SmoothPath } from './smoothPath';
import {
  assignSlots,
  computeLayout,
  layoutExtent,
  slotToWorld,
  type Extent,
  type FormationShape,
  type Pose,
  type Slot,
} from './formationLayout';
import type { Unit } from './unit';

export type FormationPhase = 'idle' | 'forming' | 'moving' | 'engaged';
export type MoveMode = 'sync' | 'rigid' | 'march';

export const FORMATION = {
  /** Units further than this from the main group at order time walk on their own (AoE2: ~10 tiles). */
  joinRadius: 40,
  /** Moves longer than this use the marching column (AoE2 DE: 30 tiles, 0 A.D.: 32). */
  marchDistance: 100,
  /** Anchor runs at this fraction of the slowest member's speed. */
  headroom: 0.9,
  /** Proportional gain of the member control law (1/s). */
  gain: 1.5,
  /** Lag (u) at which the anchor starts slowing down, and at which it stops. */
  lagStart: 4,
  lagStop: 14,
  /** Members within this distance of their slot count as in place. */
  settled: 0.8,
  /** Seconds without contact before an engaged formation re-forms. */
  calmTime: 2,
  /** Heading change (rad) above which a rigid move becomes a full re-form. */
  rigidTurn: (35 * Math.PI) / 180,
  /** Heading change (rad) at the end of a rigid move handled by pivoting rather than re-forming. */
  pivotTurn: (50 * Math.PI) / 180,
};

/** Catch-up multiplier: how much faster than its walk speed a member may hurry to its slot. */
export function catchUp(u: Unit): number {
  return u.kind === 'catapult' ? 1.2 : 1.4;
}

export interface FormationHost {
  nav: NavGrid;
  time: number;
  /** True if any enemy of `u` is within `radius` of it. */
  enemyWithin(u: Unit, radius: number): boolean;
  /** Acquisition radius used for attack-move contact checks. */
  contactRadius(u: Unit): number;
}

interface SyncTarget {
  target: Vec2;
  speed: number;
}

let nextFormationId = 1;

export class Formation {
  readonly id = nextFormationId++;
  members: Unit[] = [];
  shape: FormationShape;
  /** Player-set frontage (u), from a right-drag; undefined = automatic. */
  width: number | undefined;

  slots: Slot[] = [];
  extent: Extent = { halfWidth: 0, front: 0, back: 0 };
  layoutMode: 'battle' | 'march' = 'battle';
  pose: Pose;
  phase: FormationPhase = 'idle';
  mode: MoveMode = 'sync';

  path: SmoothPath | null = null;
  s = 0;
  dest: Vec2 | null = null;
  finalHeading = 0;
  attackMove = false;

  private sync = new Map<number, SyncTarget>();
  private syncStarted = 0;
  private syncDuration = 0;
  private prevSlotWorld = new Map<number, Vec2>();
  private lagZeroSince = -1;
  private idleTimer = 0;
  private calmSince = -1;
  private contactCheckAt = 0;
  private relayoutAt = -1;
  private pivoting = false;

  constructor(
    readonly team: number,
    members: Unit[],
    shape: FormationShape = 'line',
  ) {
    this.shape = shape;
    for (const u of members) this.attach(u);
    const c = this.centroid();
    this.pose = { pos: c, heading: members.length ? members[0].facing : 0 };
    this.finalHeading = this.pose.heading;
  }

  // ---------------------------------------------------------------------------
  // Membership

  private attach(u: Unit): void {
    if (u.formation && u.formation !== this) u.formation.remove(u);
    u.formation = this;
    u.memberFlag = 'ok';
    u.order = { kind: 'idle' };
    if (!this.members.includes(u)) this.members.push(u);
  }

  /** Removes a unit (death, reassignment). Layout is refreshed after a short debounce. */
  remove(u: Unit): void {
    const i = this.members.indexOf(u);
    if (i < 0) return;
    this.members.splice(i, 1);
    u.formation = null;
    u.slot = -1;
    u.memberFlag = 'ok';
    this.prevSlotWorld.delete(u.id);
    this.sync.delete(u.id);
    this.relayoutAt = -2; // resolved to "now + debounce" on the next update
  }

  add(units: Unit[], host: FormationHost): void {
    for (const u of units) this.attach(u);
    this.relayout(host);
  }

  get alive(): boolean {
    return this.members.length > 0;
  }

  get kinds() {
    return this.members.map((m) => m.kind);
  }

  centroid(subset?: Unit[]): Vec2 {
    const list = subset ?? this.members;
    if (!list.length) return this.pose ? { ...this.pose.pos } : { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    for (const u of list) {
      x += u.pos.x;
      y += u.pos.y;
    }
    return { x: x / list.length, y: y / list.length };
  }

  /** Members that are walking with the formation (not stragglers, not fighting). */
  private active(): Unit[] {
    return this.members.filter((u) => u.memberFlag === 'ok');
  }

  slotWorld(u: Unit): Vec2 {
    const slot = this.slots[u.slot];
    if (!slot) return { ...u.pos };
    if (this.layoutMode === 'march' && this.path) {
      const p = this.path.poseAt(this.s + slot.y);
      return slotToWorld({ pos: p.pos, heading: p.heading }, { x: slot.x, y: 0 });
    }
    return slotToWorld(this.pose, slot);
  }

  /** World position of a unit's slot in the destination (final) pose of the current order. */
  private layoutAndAssign(shape: FormationShape | 'column', pose: Pose, keepPrevious = false): void {
    const members = this.members;
    this.slots = computeLayout(
      members.map((m) => m.kind),
      shape,
      shape === 'column' || shape === 'box' ? undefined : this.width,
    );
    this.extent = layoutExtent(this.slots);
    const prev = keepPrevious ? new Map(members.map((m) => [m.id, m.slot])) : undefined;
    const assignment = assignSlots(members, this.slots, pose, prev, keepPrevious ? 4 : 0);
    for (const m of members) m.slot = assignment.get(m.id) ?? -1;
  }

  // ---------------------------------------------------------------------------
  // Orders

  /**
   * Move the formation so that its centre ends at `dest`, facing `heading`
   * (defaults to the direction of travel). `front`, if given, places the front
   * row's centre there instead (used by drag-to-face).
   */
  orderMove(
    host: FormationHost,
    dest: Vec2,
    opts: { heading?: number; width?: number; attackMove?: boolean; shape?: FormationShape; frontAnchored?: boolean } = {},
  ): void {
    if (!this.members.length) return;
    if (opts.shape) this.shape = opts.shape;
    if (opts.width !== undefined) this.width = opts.width;
    this.attackMove = !!opts.attackMove;
    this.calmSince = -1;
    this.idleTimer = 0;
    this.pivoting = false;

    // Everybody drops what they were doing and follows the formation again.
    for (const u of this.members) {
      u.memberFlag = 'ok';
      u.target = null;
      u.targetOrdered = false;
      u.order = { kind: 'idle' };
      u.path = [];
    }

    // Stragglers: units far from the main body walk on their own (AoE2 join radius).
    const main = this.mainCluster();
    for (const u of this.members) if (!main.has(u)) u.memberFlag = 'straggler';
    const body = this.members.filter((u) => main.has(u));
    const start = this.centroid(body);

    const travel = { x: dest.x - start.x, y: dest.y - start.y };
    const travelLen = Math.hypot(travel.x, travel.y);
    const heading = opts.heading ?? (travelLen > 2 ? Math.atan2(travel.y, travel.x) : this.pose.heading);
    this.finalHeading = heading;

    // Destination anchor: centre of the battle layout (or behind the front row).
    const battleSlots = computeLayout(this.kinds, this.shape, this.shape === 'box' ? undefined : this.width);
    const battleExtent = layoutExtent(battleSlots);
    let anchor = { ...dest };
    if (opts.frontAnchored) {
      anchor = { x: dest.x - Math.cos(heading) * battleExtent.front, y: dest.y - Math.sin(heading) * battleExtent.front };
    }
    const maxRadius = Math.max(...this.members.map((m) => m.radius));
    anchor = host.nav.nearestPassable(anchor, maxRadius + 1, 60) ?? anchor;
    this.dest = anchor;

    const waypoints = host.nav.findPath(start, anchor, Math.min(battleExtent.halfWidth, maxRadius + 2)) ??
      host.nav.findPath(start, anchor, maxRadius) ?? [anchor];
    const pathPts = [start, ...waypoints];
    let pathLen = 0;
    for (let i = 1; i < pathPts.length; i++) pathLen += dist(pathPts[i - 1], pathPts[i]);

    const formed = this.phase !== 'engaged' && this.isFormed() && this.layoutMode === 'battle' && this.sameLayout(battleSlots);
    const initialHeading = pathPts.length > 1 ? Math.atan2(pathPts[1].y - pathPts[0].y, pathPts[1].x - pathPts[0].x) : heading;

    if (pathLen > FORMATION.marchDistance && this.members.length >= 4) {
      // Long move: marching column along the path, deploy near the end.
      this.mode = 'march';
      this.layoutMode = 'march';
      this.phase = 'moving';
      this.path = new SmoothPath(pathPts, 6);
      this.s = 0;
      this.pose = { pos: { ...start }, heading: initialHeading };
      this.layoutAndAssign('column', this.pose);
      this.resetSlotMemory();
    } else if (formed && pathLen > 1 && Math.abs(angleDiff(this.pose.heading, initialHeading)) <= FORMATION.rigidTurn) {
      // Already in shape and roughly facing the way: translate the block along the path.
      this.mode = 'rigid';
      this.phase = 'moving';
      const corner = clamp(this.extent.halfWidth, 6, 30);
      this.path = new SmoothPath([this.pose.pos, ...waypoints], corner);
      this.s = 0;
      this.resetSlotMemory();
    } else {
      // Short move, big turn or not formed: everybody goes straight to their slot.
      this.layoutMode = 'battle';
      this.beginSync({ pos: anchor, heading });
    }
  }

  /** Re-forms in place with the given (or current) shape and heading. */
  reform(host: FormationHost, heading?: number): void {
    const body = this.members.filter((u) => u.memberFlag !== 'straggler');
    const c = this.centroid(body.length ? body : undefined);
    const pos = host.nav.nearestPassable(c, Math.max(...this.members.map((m) => m.radius)) + 1, 40) ?? c;
    for (const u of this.members) {
      if (u.memberFlag !== 'straggler') u.memberFlag = 'ok';
      u.target = null;
      u.targetOrdered = false;
    }
    this.layoutMode = 'battle';
    this.attackMove = false;
    this.beginSync({ pos, heading: heading ?? this.pose.heading });
  }

  setShape(host: FormationHost, shape: FormationShape): void {
    if (shape === this.shape && this.phase !== 'engaged') return;
    this.shape = shape;
    if (this.phase === 'moving' && this.dest) {
      this.orderMove(host, this.dest, { heading: this.finalHeading, attackMove: this.attackMove });
    } else {
      this.reform(host);
    }
  }

  /** Begin synchronized arrival at `pose` (battle layout). */
  private beginSync(pose: Pose): void {
    this.mode = 'sync';
    this.phase = 'forming';
    this.path = null;
    this.pose = { pos: { ...pose.pos }, heading: pose.heading };
    this.finalHeading = pose.heading;
    this.layoutAndAssign(this.shape, this.pose);
    this.sync.clear();
    const times: number[] = [];
    const entries: [Unit, Vec2, number][] = [];
    for (const u of this.members) {
      const target = this.slotWorld(u);
      const d = dist(u.pos, target);
      const setup = u.kind === 'catapult' && u.deployed && d > 1.5 ? (u.type.setupTime ?? 0) : 0;
      const t = d / u.speed + setup;
      entries.push([u, target, d]);
      if (u.memberFlag !== 'straggler') times.push(t);
    }
    times.sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : 0;
    const maxT = times.length ? times[times.length - 1] : 0;
    const T = Math.max(0.5, Math.min(maxT, median * 1.5 + 0.5));
    for (const [u, target, d] of entries) {
      const own = d / u.speed;
      const speed = own > T ? u.speed : Math.max(u.speed * 0.35, d / T);
      this.sync.set(u.id, { target, speed: Math.min(u.speed, speed) });
    }
    this.syncDuration = T;
    this.syncStarted = -1;
    this.resetSlotMemory();
  }

  private resetSlotMemory(): void {
    this.prevSlotWorld.clear();
    for (const u of this.members) this.prevSlotWorld.set(u.id, this.slotWorld(u));
    this.lagZeroSince = -1;
  }

  private sameLayout(slots: Slot[]): boolean {
    if (slots.length !== this.slots.length) return false;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].kind !== this.slots[i].kind) return false;
      if (Math.abs(slots[i].x - this.slots[i].x) > 0.01 || Math.abs(slots[i].y - this.slots[i].y) > 0.01) return false;
    }
    return true;
  }

  /** True if (almost) every active member stands on its slot. */
  isFormed(threshold = 2.5): boolean {
    const list = this.members.filter((u) => u.memberFlag !== 'straggler');
    if (!list.length || !this.slots.length) return false;
    let ok = 0;
    for (const u of list) if (u.slot >= 0 && dist(u.pos, this.slotWorld(u)) < threshold) ok++;
    return ok >= list.length * 0.9;
  }

  /** Largest single-link cluster (join radius) of members. */
  private mainCluster(): Set<Unit> {
    const n = this.members.length;
    const label = new Int32Array(n).fill(-1);
    let best = -1;
    let bestSize = 0;
    let next = 0;
    const r2 = FORMATION.joinRadius ** 2;
    for (let i = 0; i < n; i++) {
      if (label[i] >= 0) continue;
      const stack = [i];
      label[i] = next;
      let size = 0;
      while (stack.length) {
        const a = stack.pop()!;
        size++;
        for (let b = 0; b < n; b++) {
          if (label[b] >= 0) continue;
          const dx = this.members[a].pos.x - this.members[b].pos.x;
          const dy = this.members[a].pos.y - this.members[b].pos.y;
          if (dx * dx + dy * dy <= r2) {
            label[b] = next;
            stack.push(b);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = next;
      }
      next++;
    }
    return new Set(this.members.filter((_, i) => label[i] === best));
  }

  // ---------------------------------------------------------------------------
  // Update

  /** Called once per tick before unit behaviour; sets desired velocities of formation-controlled members. */
  update(host: FormationHost, dt: number): void {
    if (!this.members.length) return;
    if (this.relayoutAt === -2) this.relayoutAt = host.time + 0.5;
    if (this.relayoutAt > 0 && host.time >= this.relayoutAt) {
      this.relayoutAt = -1;
      this.relayout(host);
    }

    switch (this.phase) {
      case 'moving':
        this.advanceAnchor(host, dt);
        this.checkContact(host);
        break;
      case 'forming':
        if (this.syncStarted < 0) this.syncStarted = host.time;
        if (this.settledRatio() >= 0.9 || host.time - this.syncStarted > this.syncDuration + 4) {
          this.phase = 'idle';
          this.idleTimer = 0;
        }
        this.checkContact(host);
        break;
      case 'engaged': {
        const contact = this.members.some((u) => u.memberFlag !== 'straggler' && host.enemyWithin(u, host.contactRadius(u)));
        const fighting = this.members.filter((u) => u.target).length;
        if (contact || fighting > 0) this.calmSince = -1;
        else if (this.calmSince < 0) this.calmSince = host.time;
        if (this.calmSince >= 0 && host.time - this.calmSince >= FORMATION.calmTime) {
          const resumeAttackMove = this.attackMove && this.dest && dist(this.centroid(), this.dest) > 8;
          if (resumeAttackMove && this.dest) {
            this.orderMove(host, this.dest, { heading: this.finalHeading, attackMove: true });
          } else {
            this.reform(host);
          }
        }
        break;
      }
      case 'idle': {
        this.idleTimer += dt;
        if (this.idleTimer >= 2) {
          this.idleTimer = 0;
          const allIdle = this.members.every((u) => !u.target && u.memberFlag !== 'engaged');
          if (allIdle && this.members.some((u) => u.memberFlag === 'returning' || dist(u.pos, this.slotWorld(u)) > 3)) {
            const settledEnough = this.members.every((u) => u.memberFlag === 'ok' || u.memberFlag === 'straggler');
            if (settledEnough) this.reform(host);
          }
        }
        break;
      }
    }

    this.steerMembers(host, dt);
  }

  /** Re-layout after membership changes, keeping members near their current slots. */
  relayout(host: FormationHost): void {
    if (!this.members.length) return;
    if (this.phase === 'engaged') {
      // Slots are only home points while fighting; refresh silently.
      this.layoutAndAssign(this.shape, this.pose, true);
      return;
    }
    if (this.mode === 'march' && this.phase === 'moving') {
      this.layoutAndAssign('column', this.path ? this.path.poseAt(this.s) : this.pose, true);
    } else if (this.phase === 'forming' || this.phase === 'idle') {
      this.beginSync(this.pose);
    } else {
      this.layoutAndAssign(this.shape, this.pose, true);
    }
    this.resetSlotMemory();
    void host;
  }

  private settledRatio(): number {
    const list = this.members.filter((u) => u.memberFlag !== 'straggler');
    if (!list.length) return 1;
    let n = 0;
    for (const u of list) if (dist(u.pos, this.slotWorld(u)) < FORMATION.settled) n++;
    return n / list.length;
  }

  /**
   * Attack-move: members peel off individually as enemies come into their
   * acquisition range (archers at bow range, melee when the enemy is close),
   * while the rest keep marching. Once half the formation is fighting, the
   * anchor stops and the formation becomes 'engaged'.
   */
  private checkContact(host: FormationHost): void {
    if (!this.attackMove || host.time < this.contactCheckAt) return;
    this.contactCheckAt = host.time + 0.25;
    const body = this.members.filter((u) => u.memberFlag !== 'straggler');
    if (!body.length) return;
    const fighting = body.filter((u) => u.memberFlag === 'engaged' || u.target).length;
    if (fighting >= body.length * 0.5) this.engage(host);
  }

  /** Switch to combat: the anchor stops and slots become home points. */
  engage(host: FormationHost): void {
    if (this.phase === 'engaged') return;
    if (this.mode === 'march' || this.layoutMode === 'march') {
      // Deploy in place into battle formation first so home points make sense.
      const c = this.centroid(this.members.filter((u) => u.memberFlag !== 'straggler'));
      const pose = { pos: c, heading: this.path ? this.path.poseAt(this.s).heading : this.pose.heading };
      this.layoutMode = 'battle';
      this.pose = pose;
      this.layoutAndAssign(this.shape, pose);
    }
    this.phase = 'engaged';
    this.mode = 'sync';
    this.path = null;
    this.calmSince = -1;
    this.pivoting = false;
    void host;
  }

  private advanceAnchor(host: FormationHost, dt: number): void {
    const path = this.path;
    if (!path) {
      this.phase = 'idle';
      return;
    }
    const active = this.active();
    if (!active.length) {
      // Everyone is a straggler: just let them walk; jump the anchor along.
      this.s = Math.min(path.length, this.s + 8 * dt);
    }
    const vMin = active.length ? Math.min(...active.map((u) => u.speed)) : 5;
    const kMin = active.length ? Math.min(...active.map(catchUp)) : 1.4;
    const halfWidth = this.extent.halfWidth;

    let v = vMin * FORMATION.headroom;
    if (this.mode === 'rigid') {
      const R = path.minRadiusAhead(this.s, 8);
      if (Number.isFinite(R)) v = Math.min(v, (kMin * vMin * R) / (R + halfWidth));
    }
    // Throttle while members lag behind their slots (Pottinger: the group waits).
    const fwd = { x: Math.cos(this.pose.heading), y: Math.sin(this.pose.heading) };
    let lag = 0;
    let laggard: Unit | null = null;
    for (const u of active) {
      if (u.busySetup) {
        lag = Math.max(lag, FORMATION.lagStop);
        continue;
      }
      const sw = this.slotWorld(u);
      const along = (sw.x - u.pos.x) * fwd.x + (sw.y - u.pos.y) * fwd.y;
      const off = Math.hypot(sw.x - u.pos.x, sw.y - u.pos.y);
      const l = Math.max(along, off * 0.6);
      if (l > lag) {
        lag = l;
        laggard = u;
      }
    }
    const fLag = clamp(1 - (lag - FORMATION.lagStart) / (FORMATION.lagStop - FORMATION.lagStart), 0, 1);
    v *= fLag;
    if (fLag === 0) {
      if (this.lagZeroSince < 0) this.lagZeroSince = host.time;
      else if (host.time - this.lagZeroSince > 6 && laggard) {
        laggard.memberFlag = 'straggler';
        this.lagZeroSince = -1;
      }
    } else {
      this.lagZeroSince = -1;
    }

    if (!this.pivoting) {
      this.s = Math.min(path.length, this.s + v * dt);
      const p = path.poseAt(this.s);
      if (this.mode === 'rigid') {
        // Rigid block: turn towards the path tangent at a rate the outer ranks can follow.
        const omega = Math.max(0.15, (kMin * vMin - v) / Math.max(halfWidth, 1));
        const d = angleDiff(this.pose.heading, p.heading);
        this.pose.heading += clamp(d, -omega * dt, omega * dt);
      } else {
        this.pose.heading = p.heading;
      }
      this.pose.pos = p.pos;
    }

    const remaining = path.length - this.s;
    if (this.mode === 'march') {
      const battleDepth = layoutExtent(computeLayout(this.kinds, this.shape, this.width)).front * 2;
      const deployDist = (this.extent.front - this.extent.back) / 2 + battleDepth + 8;
      if (remaining <= deployDist) {
        // Deploy: battle layout at the destination with synchronized arrival.
        this.layoutMode = 'battle';
        this.beginSync({ pos: this.dest ?? path.end, heading: this.finalHeading });
        return;
      }
    } else if (remaining < 0.05) {
      const turn = angleDiff(this.pose.heading, this.finalHeading);
      if (Math.abs(turn) > FORMATION.pivotTurn) {
        this.beginSync({ pos: this.pose.pos, heading: this.finalHeading });
        return;
      }
      if (Math.abs(turn) > 0.02) {
        this.pivoting = true;
        const omega = Math.max(0.2, (kMin * vMin) / Math.max(halfWidth, 1)) * 0.8;
        this.pose.heading += clamp(turn, -omega * dt, omega * dt);
      } else if (this.settledRatio() >= 0.9 || lag < 1) {
        this.pose.heading = this.finalHeading;
        this.phase = 'idle';
        this.idleTimer = 0;
        this.pivoting = false;
      }
    }
  }

  /** Sets desired velocity for members the formation controls. */
  private steerMembers(host: FormationHost, dt: number): void {
    const moving = this.phase === 'moving' && !this.pivoting;
    const fwd = { x: Math.cos(this.pose.heading), y: Math.sin(this.pose.heading) };
    for (const u of this.members) {
      if (!u.alive) continue;
      const slotW = this.slotWorld(u);
      const prev = this.prevSlotWorld.get(u.id) ?? slotW;
      this.prevSlotWorld.set(u.id, slotW);
      if (u.memberFlag === 'engaged' || u.target) {
        u.home = slotW; // leash follows the (possibly moving) slot
        continue; // combat code steers it
      }
      if (u.busySetup) {
        u.desired = { x: 0, y: 0 };
        continue;
      }

      if (u.memberFlag === 'straggler' || u.memberFlag === 'returning') {
        // Walk individually (pathing) to the slot; rejoin when close.
        const goal = this.phase === 'forming' ? (this.sync.get(u.id)?.target ?? slotW) : slotW;
        if (dist(u.pos, goal) < (u.memberFlag === 'returning' ? 1.5 : 8)) {
          u.memberFlag = 'ok';
        } else {
          u.home = goal;
          u.speedCap = u.memberFlag === 'returning' ? u.speed * catchUp(u) : u.speed;
          setPathGoal(u, goal, host, 1.2);
          if (u.memberFlag === 'returning') scaleDesired(u, u.speedCap);
          continue;
        }
      }

      if (this.phase === 'forming') {
        const st = this.sync.get(u.id);
        const goal = st?.target ?? slotW;
        const d = dist(u.pos, goal);
        if (d < 0.15) {
          u.desired = { x: 0, y: 0 };
          u.path = [];
          continue;
        }
        const speed = Math.min(st?.speed ?? u.speed, Math.max(0.6, d * 2.2));
        u.speedCap = u.speed * catchUp(u);
        if (u.path.length || !host.nav.lineClear(u.pos, goal, u.radius * 0.8)) {
          setPathGoal(u, goal, host, 2);
          scaleDesired(u, speed);
        } else {
          u.desired = { x: ((goal.x - u.pos.x) / d) * speed, y: ((goal.y - u.pos.y) / d) * speed };
        }
        continue;
      }

      // Rigid / march / idle: feed-forward offset pursuit.
      const sv = moving ? { x: (slotW.x - prev.x) / dt, y: (slotW.y - prev.y) / dt } : { x: 0, y: 0 };
      const ex = slotW.x - u.pos.x;
      const ey = slotW.y - u.pos.y;
      const err = Math.hypot(ex, ey);
      if (!moving && err < 0.25 && this.phase !== 'engaged') {
        u.desired = { x: 0, y: 0 };
        u.path = [];
        continue;
      }
      const cap = u.speed * catchUp(u);
      if (err > 3 && !host.nav.lineClear(u.pos, slotW, u.radius * 0.8)) {
        // Slot not directly reachable (obstacle in between): path to it.
        u.speedCap = cap;
        setPathGoal(u, slotW, host, 1.0);
        continue;
      }
      u.path = [];
      let vx = sv.x + FORMATION.gain * ex;
      let vy = sv.y + FORMATION.gain * ey;
      if (moving) {
        // Never walk backwards against the march: wait for the slot instead of U-turning.
        const along = vx * fwd.x + vy * fwd.y;
        if (along < 0) {
          vx -= along * fwd.x;
          vy -= along * fwd.y;
        }
      }
      const sp = Math.hypot(vx, vy);
      if (sp > cap) {
        vx = (vx * cap) / sp;
        vy = (vy * cap) / sp;
      }
      u.desired = { x: vx, y: vy };
      u.speedCap = cap;
    }
  }

  /** Home point for a member (where it returns to after fighting). */
  homeOf(u: Unit): Vec2 {
    return this.slotWorld(u);
  }
}

/** Points a unit's path at `goal`, re-pathing at most every `every` seconds or when the goal moved. */
export function setPathGoal(u: Unit, goal: Vec2, host: FormationHost, every: number): void {
  const moved = !u.pathGoal || dist(u.pathGoal, goal) > 2;
  if (moved || host.time >= u.repathAt || !u.path.length) {
    if (host.nav.lineClear(u.pos, goal, u.radius * 0.8)) {
      u.path = [{ ...goal }];
    } else {
      u.path = host.nav.findPath(u.pos, goal, u.radius) ?? [{ ...goal }];
    }
    u.pathGoal = { ...goal };
    u.repathAt = host.time + every;
  } else if (u.path.length) {
    u.path[u.path.length - 1] = { ...goal };
  }
  followPath(u, u.speed);
}

/** Steers along u.path at the given speed (arrival slow-down on the last leg). */
export function followPath(u: Unit, speed: number): void {
  while (u.path.length > 1 && dist(u.pos, u.path[0]) < Math.max(1.2, u.radius)) u.path.shift();
  const wp = u.path[0];
  if (!wp) {
    u.desired = { x: 0, y: 0 };
    return;
  }
  const dx = wp.x - u.pos.x;
  const dy = wp.y - u.pos.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.1) {
    if (u.path.length === 1) u.path = [];
    u.desired = { x: 0, y: 0 };
    return;
  }
  const last = u.path.length === 1;
  const sp = last ? Math.min(speed, Math.max(0.5, d * 2)) : speed;
  u.desired = { x: (dx / d) * sp, y: (dy / d) * sp };
}

function scaleDesired(u: Unit, speed: number): void {
  const l = Math.hypot(u.desired.x, u.desired.y);
  if (l > speed && l > 0) u.desired = { x: (u.desired.x / l) * speed, y: (u.desired.y / l) * speed };
}
