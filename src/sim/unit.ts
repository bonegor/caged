// Unit state. Behaviour lives in world.ts (individual AI, combat, movement)
// and formation.ts (group movement).

import type { Vec2 } from './math';
import { UNIT_TYPES, type UnitKind, type UnitType } from './unitTypes';
import type { Formation } from './formation';

export type Stance = 'aggressive' | 'defensive' | 'standGround' | 'noAttack';
export type AnimState = 'idle' | 'walk' | 'run' | 'attack' | 'death';

/** What a unit does when it is not simply following its formation slot. */
export type UnitOrder =
  | { kind: 'idle' }
  | { kind: 'move'; dest: Vec2; attackMove: boolean }
  | { kind: 'attack'; target: Unit };

/** Formation member status (see docs/FORMATIONS.md, section "Edge cases"). */
export type MemberFlag = 'ok' | 'engaged' | 'straggler' | 'returning';

export class Unit {
  readonly type: UnitType;
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2 = { x: 0, y: 0 };
  /** Desired velocity computed by behaviour this tick, before avoidance. */
  desired: Vec2 = { x: 0, y: 0 };
  /** Maximum speed allowed this tick (catch-up multiplier applied by formations). */
  speedCap: number;
  facing: number;
  prevFacing: number;
  hp: number;
  alive = true;
  deathTime = 0;
  stance: Stance = 'aggressive';

  order: UnitOrder = { kind: 'idle' };
  formation: Formation | null = null;
  slot = -1;
  memberFlag: MemberFlag = 'ok';
  /** World position the unit returns to when an engagement ends (its slot or where it stood). */
  home: Vec2 | null = null;

  // Path following
  path: Vec2[] = [];
  pathGoal: Vec2 | null = null;
  repathAt = 0;
  progressCheckAt = 0;
  progressPos: Vec2;
  stuck = 0;

  // Combat
  target: Unit | null = null;
  /** True when the player/AI explicitly ordered this target. */
  targetOrdered = false;
  cooldown = 0;
  /** Seconds into the current attack animation, or -1. */
  attackTime = -1;
  attackFired = false;
  attackDuration = 1;
  /** Fraction of the attack animation at which the blow lands / projectile is released. */
  attackEvent = 0.5;
  scanAt = 0;
  runDistance = 0;
  lastHitBy: Unit | null = null;
  lastHitAt = -100;

  // Catapults: deployed (can fire) vs packed (can move). setupLeft > 0 while switching.
  deployed = true;
  setupLeft = 0;
  setupTarget: 'deploy' | 'pack' | null = null;

  // Presentation
  anim: AnimState = 'idle';
  animTime = 0;
  walkPhase = 0;
  idleSeed: number;
  selected = false;
  hitFlash = 0;

  // Stats
  kills = 0;
  damageDealt = 0;

  constructor(
    readonly id: number,
    readonly team: number,
    readonly kind: UnitKind,
    pos: Vec2,
    facing: number,
  ) {
    this.type = UNIT_TYPES[kind];
    this.pos = { ...pos };
    this.prevPos = { ...pos };
    this.progressPos = { ...pos };
    this.facing = facing;
    this.prevFacing = facing;
    this.hp = this.type.hp;
    this.speedCap = this.type.speed;
    this.idleSeed = (id * 2654435761) % 1000 / 1000;
    if (kind === 'catapult') this.deployed = true;
  }

  get radius(): number {
    return this.type.radius;
  }

  /** Base walking speed (catapults move packed). */
  get speed(): number {
    return this.type.speed;
  }

  get isRanged(): boolean {
    return this.type.attack.kind === 'ranged';
  }

  get busySetup(): boolean {
    return this.setupLeft > 0;
  }

  /** True if the unit is in the middle of an attack swing that should not be interrupted. */
  get swinging(): boolean {
    return this.attackTime >= 0;
  }
}
