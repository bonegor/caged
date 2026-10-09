// Mouse and keyboard controls.
//
// Left click/drag: select (shift adds, double-click selects that type on screen).
// Right click: move / attack. Right drag: move with a chosen facing and
// frontage (the drag is the front line). A: attack-move. S: stop.
// Q W E R: line, staggered, box, flank. Z X C V: aggressive, defensive,
// stand ground, no attack. Ctrl+1..9 assign group, 1..9 select it.
// Arrows / screen edge / middle drag pan, wheel zooms.

import type { Unit } from '../sim/unit';
import type { World } from '../sim/world';
import type { GameRenderer } from '../render/gameRenderer';
import { computeLayout, layoutExtent, slotToWorld, type FormationShape } from '../sim/formationLayout';
import { UNIT_TYPES } from '../sim/unitTypes';
import type { Vec2 } from '../sim/math';
import { settings } from '../settings';

export interface InputCallbacks {
  onSelectionChanged(): void;
  onCommand(kind: 'move' | 'attack' | 'attackMove' | 'stop' | 'shape' | 'stance'): void;
  onPauseToggle(): void;
  onSpeedChange(delta: number): void;
  /** Escape with nothing to cancel (opens the menu). */
  onEscape(): void;
  isPaused(): boolean;
}

const DRAG_PX = 6;
const FACE_DRAG_PX = 14;

export class Input {
  selection: Unit[] = [];
  groups = new Map<number, Unit[]>();
  attackMoveArmed = false;
  private keys = new Set<string>();
  private leftDown: { x: number; y: number } | null = null;
  private rightDown: { x: number; y: number; world: Vec2 } | null = null;
  private middleDown: { x: number; y: number } | null = null;
  private mouse = { x: 0, y: 0, inside: false };
  private lastClick = { t: 0, unit: null as Unit | null };
  private lastGroupKey = { key: 0, t: 0 };
  readonly selectBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private disposers: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private renderer: GameRenderer,
    private cb: InputCallbacks,
    private team = 0,
    spectator = false,
  ) {
    if (spectator) return;
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(canvas, 'pointerdown', (e: PointerEvent) => this.down(e));
    on(window, 'pointermove', (e: PointerEvent) => this.move(e));
    on(window, 'pointerup', (e: PointerEvent) => this.up(e));
    on(canvas, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(canvas, 'pointerenter', () => (this.mouse.inside = true));
    on(canvas, 'pointerleave', () => (this.mouse.inside = false));
    on(window, 'keydown', (e: KeyboardEvent) => this.keyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  get own(): Unit[] {
    return this.selection.filter((u) => u.alive && u.team === this.team);
  }

  setSelection(units: Unit[]): void {
    for (const u of this.selection) u.selected = false;
    this.selection = units.filter((u) => u.alive);
    for (const u of this.selection) u.selected = true;
    this.cb.onSelectionChanged();
  }

  pruneSelection(): void {
    if (this.selection.some((u) => !u.alive)) this.setSelection(this.selection.filter((u) => u.alive));
  }

  // ---------------------------------------------------------------------------

  private down(e: PointerEvent): void {
    const p = this.local(e);
    this.canvas.setPointerCapture?.(e.pointerId);
    if (e.button === 0) {
      if (this.attackMoveArmed) {
        this.issueMove(p, null, true);
        this.attackMoveArmed = false;
        return;
      }
      this.leftDown = p;
    } else if (e.button === 2) {
      this.rightDown = { ...p, world: this.renderer.camera.screenToWorld(p.x, p.y) };
    } else if (e.button === 1) {
      e.preventDefault();
      this.middleDown = p;
    }
  }

  private move(e: PointerEvent): void {
    const p = this.local(e);
    this.mouse.x = p.x;
    this.mouse.y = p.y;
    if (this.leftDown) {
      if (Math.hypot(p.x - this.leftDown.x, p.y - this.leftDown.y) > DRAG_PX) {
        this.box = { x0: this.leftDown.x, y0: this.leftDown.y, x1: p.x, y1: p.y };
      }
    }
    if (this.middleDown) {
      this.renderer.camera.panScreen(this.middleDown.x - p.x, this.middleDown.y - p.y);
      this.middleDown = p;
    }
    if (this.rightDown) {
      const d = Math.hypot(p.x - this.rightDown.x, p.y - this.rightDown.y);
      this.renderer.preview = d > FACE_DRAG_PX ? this.facingPreview(this.rightDown.world, this.renderer.camera.screenToWorld(p.x, p.y)) : null;
    } else {
      this.renderer.hovered = this.renderer.pickUnit(p.x, p.y, this.team);
    }
  }

  private up(e: PointerEvent): void {
    const p = this.local(e);
    if (e.button === 0 && this.leftDown) {
      if (this.box) this.boxSelect(this.box, e.shiftKey);
      else this.clickSelect(p, e.shiftKey || e.ctrlKey);
      this.leftDown = null;
      this.box = null;
    } else if (e.button === 2 && this.rightDown) {
      const start = this.rightDown;
      this.rightDown = null;
      this.renderer.preview = null;
      const d = Math.hypot(p.x - start.x, p.y - start.y);
      if (d > FACE_DRAG_PX) {
        this.issueMove(start, this.renderer.camera.screenToWorld(p.x, p.y), this.attackMoveArmed);
      } else {
        const target = this.renderer.pickUnit(p.x, p.y, 1 - this.team);
        if (target && target.team !== this.team && this.own.length) {
          this.world.commandAttack(this.own, target);
          this.renderer.addMarker(target.pos.x, target.pos.y, true);
          this.cb.onCommand('attack');
        } else {
          this.issueMove(p, null, this.attackMoveArmed);
        }
      }
      this.attackMoveArmed = false;
    } else if (e.button === 1) {
      this.middleDown = null;
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.renderer.camera.zoomAt(factor, p.x, p.y);
  }

  private keyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (/^[1-9]$/.test(k)) {
      const n = Number(k);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.groups.set(n, [...this.own]);
      } else {
        const g = (this.groups.get(n) ?? []).filter((u) => u.alive);
        if (g.length) {
          this.setSelection(g);
          const now = performance.now();
          if (this.lastGroupKey.key === n && now - this.lastGroupKey.t < 400) this.centerOnSelection();
          this.lastGroupKey = { key: n, t: now };
        }
      }
      return;
    }
    const shapes: Record<string, FormationShape> = { q: 'line', w: 'staggered', e: 'box', r: 'flank' };
    const stances: Record<string, Unit['stance']> = { z: 'aggressive', x: 'defensive', c: 'standGround', v: 'noAttack' };
    if (shapes[k]) {
      this.setShape(shapes[k]);
    } else if (stances[k]) {
      this.setStance(stances[k]);
    } else if (k === 'a') {
      if (this.own.length) this.attackMoveArmed = true;
    } else if (k === 's') {
      this.stop();
    } else if (k === 'g') {
      this.regroup();
    } else if (k === ' ') {
      e.preventDefault();
      this.centerOnSelection();
    } else if (k === 'escape') {
      if (this.attackMoveArmed) this.attackMoveArmed = false;
      else if (this.selection.length) this.setSelection([]);
      else this.cb.onEscape();
    } else if (k === 'p' || k === 'pause') {
      this.cb.onPauseToggle();
    } else if (k === '+' || k === '=') {
      this.cb.onSpeedChange(1);
    } else if (k === '-') {
      this.cb.onSpeedChange(-1);
    }
  }

  // ---------------------------------------------------------------------------
  // Actions (also used by HUD buttons)

  setShape(shape: FormationShape): void {
    if (this.own.length < 2) return;
    this.world.setShape(this.own, shape);
    this.cb.onCommand('shape');
  }

  setStance(stance: Unit['stance']): void {
    if (!this.own.length) return;
    this.world.setStance(this.own, stance);
    this.cb.onCommand('stance');
  }

  stop(): void {
    if (!this.own.length) return;
    this.world.commandStop(this.own);
    this.cb.onCommand('stop');
  }

  /** Gathers the selected units into one formation where they stand. */
  regroup(): void {
    const own = this.own;
    if (own.length < 2) return;
    const c = own.reduce((a, u) => ({ x: a.x + u.pos.x / own.length, y: a.y + u.pos.y / own.length }), { x: 0, y: 0 });
    const f = own[0].formation;
    this.world.commandMove(own, c, { heading: f?.pose.heading ?? own[0].facing, shape: f?.shape });
    this.cb.onCommand('shape');
  }

  armAttackMove(): void {
    if (this.own.length) this.attackMoveArmed = true;
  }

  centerOnSelection(): void {
    const own = this.selection.filter((u) => u.alive);
    if (!own.length) return;
    const c = own.reduce((a, u) => ({ x: a.x + u.pos.x / own.length, y: a.y + u.pos.y / own.length }), { x: 0, y: 0 });
    this.renderer.camera.centerOn(c);
  }

  private clickSelect(p: { x: number; y: number }, additive: boolean): void {
    const u = this.renderer.pickUnit(p.x, p.y, this.team);
    const now = performance.now();
    if (u && this.lastClick.unit === u && now - this.lastClick.t < 350 && u.team === this.team) {
      // Double click: all of that kind on screen.
      const same = this.world.units.filter((o) => o.alive && o.team === this.team && o.kind === u.kind && this.onScreen(o));
      this.setSelection(same);
    } else if (!u) {
      if (!additive) this.setSelection([]);
    } else if (additive && u.team === this.team) {
      if (this.selection.includes(u)) this.setSelection(this.selection.filter((s) => s !== u));
      else this.setSelection([...this.own, u]);
    } else {
      this.setSelection([u]);
    }
    this.lastClick = { t: now, unit: u };
  }

  private onScreen(u: Unit): boolean {
    const s = this.renderer.unitScreen(u);
    return s.x >= 0 && s.y >= 0 && s.x <= this.renderer.camera.viewW && s.y <= this.renderer.camera.viewH;
  }

  private boxSelect(b: { x0: number; y0: number; x1: number; y1: number }, additive: boolean): void {
    const x0 = Math.min(b.x0, b.x1);
    const x1 = Math.max(b.x0, b.x1);
    const y0 = Math.min(b.y0, b.y1);
    const y1 = Math.max(b.y0, b.y1);
    const inside = this.world.units.filter((u) => {
      if (!u.alive || u.team !== this.team) return false;
      const s = this.renderer.unitScreen(u);
      const top = s.y - 40 * this.renderer.camera.zoom;
      return s.x >= x0 - 6 && s.x <= x1 + 6 && s.y >= y0 && top <= y1;
    });
    this.setSelection(additive ? [...new Set([...this.own, ...inside])] : inside);
  }

  /**
   * Right-drag: the drag segment is the formation's front line. Facing is the
   * perpendicular pointing away from the army, frontage is the drag length.
   */
  private dragPlan(from: Vec2, to: Vec2): { centre: Vec2; heading: number; width: number } | null {
    const units = this.own;
    if (!units.length) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const c = units.reduce((a, u) => ({ x: a.x + u.pos.x / units.length, y: a.y + u.pos.y / units.length }), { x: 0, y: 0 });
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    // Two perpendiculars; choose the one pointing away from the army's centroid.
    let nx = -dy / len;
    let ny = dx / len;
    if ((mid.x - c.x) * nx + (mid.y - c.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { centre: mid, heading: Math.atan2(ny, nx), width: len };
  }

  private facingPreview(from: Vec2, to: Vec2): { x: number; y: number; r: number }[] | null {
    const plan = this.dragPlan(from, to);
    if (!plan) return null;
    const units = this.own;
    if (units.length === 1) return [{ x: plan.centre.x, y: plan.centre.y, r: units[0].radius }];
    const shape = units[0].formation?.shape ?? 'line';
    const slots = computeLayout(units.map((u) => u.kind), shape, plan.width);
    const front = layoutExtent(slots).front;
    const anchor = { x: plan.centre.x - Math.cos(plan.heading) * front, y: plan.centre.y - Math.sin(plan.heading) * front };
    return slots.map((s) => ({ ...slotToWorld({ pos: anchor, heading: plan.heading }, s), r: UNIT_TYPES[s.kind].radius }));
  }

  private issueMove(screen: { x: number; y: number }, dragTo: Vec2 | null, attackMove: boolean): void {
    const units = this.own;
    if (!units.length) return;
    const dest = this.renderer.camera.screenToWorld(screen.x, screen.y);
    if (dragTo) {
      const plan = this.dragPlan(dest, dragTo);
      if (plan) {
        this.world.commandMove(units, plan.centre, { heading: plan.heading, width: plan.width, attackMove, frontAnchored: true });
        this.renderer.addMarker(plan.centre.x, plan.centre.y, attackMove);
      }
    } else {
      this.world.commandMove(units, dest, { attackMove });
      this.renderer.addMarker(dest.x, dest.y, attackMove);
    }
    this.cb.onCommand(attackMove ? 'attackMove' : 'move');
  }

  /** Keyboard / edge scrolling, called every frame. */
  update(dt: number): void {
    const cam = this.renderer.camera;
    const speed = 900 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('arrowleft')) dx -= speed;
    if (this.keys.has('arrowright')) dx += speed;
    if (this.keys.has('arrowup')) dy -= speed;
    if (this.keys.has('arrowdown')) dy += speed;
    const edge = 6;
    if (settings.edgeScroll && this.mouse.inside && !this.leftDown && !this.middleDown && document.hasFocus()) {
      if (this.mouse.x <= edge) dx -= speed;
      if (this.mouse.x >= cam.viewW - edge) dx += speed;
      if (this.mouse.y <= edge) dy -= speed;
      if (this.mouse.y >= cam.viewH - edge) dy += speed;
    }
    if (dx || dy) cam.panScreen(dx, dy);
  }
}
