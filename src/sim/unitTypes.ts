// Unit definitions. Damage follows Age of Empires II: every attack lists damage
// per armour class; for each class the target *has*, damage minus armour (>= 0)
// is summed, with a floor of 1. Bonus classes (cavalry, spearman, ...) only
// count against targets that carry that class.

export type ArmorClass = 'melee' | 'pierce' | 'infantry' | 'cavalry' | 'archer' | 'spearman' | 'siege';

export type UnitKind = 'footman' | 'pikeman' | 'archer' | 'knight' | 'catapult';

/** Formation sub-group, front to back as in AoE2 (cavalry, infantry, ranged, siege). */
export type Category = 'cavalry' | 'infantry' | 'ranged' | 'siege';

export interface Splash {
  /** Radius receiving full damage. */
  inner: number;
  /** Radius beyond which nothing is hit; damage falls to `edge` x at this radius. */
  outer: number;
  edge: number;
  /** Damage multiplier applied to own units (AoE2 onagers hurt friends too). */
  friendly: number;
}

export interface AttackSpec {
  kind: 'melee' | 'ranged';
  damage: Partial<Record<ArmorClass, number>>;
  /** Max range measured between the two units' edges (u). */
  range: number;
  minRange: number;
  /** Seconds between attacks. */
  reload: number;
  projectile?: 'arrow' | 'stone';
  projectileSpeed?: number;
  /** Chance that a shot is aimed perfectly (AoE2 accuracy). */
  accuracy?: number;
  /** Aim error radius for inaccurate shots, per 10 u of distance. */
  spread?: number;
  splash?: Splash;
}

export interface UnitType {
  kind: UnitKind;
  name: string;
  plural: string;
  blurb: string;
  category: Category;
  classes: ArmorClass[];
  hp: number;
  armor: Partial<Record<ArmorClass, number>>;
  speed: number;
  /** Speed while running to attack (cavalry charge); defaults to speed. */
  runSpeed?: number;
  radius: number;
  mass: number;
  /** Distance at which idle units notice enemies. */
  sight: number;
  attack: AttackSpec;
  cost: number;
  /** Cavalry charge: bonus damage on the first blow after running at least `distance` u. */
  charge?: { bonus: number; distance: number };
  /** Seconds needed to set up / pack (catapults). */
  setupTime?: number;
  /** Distance a full walk cycle covers (u), to keep feet from sliding. */
  stride: number;
  /** Lateral and longitudinal spacing in formation (centre to centre, u). */
  spacing: { side: number; depth: number };
  counters: string;
}

export const UNIT_TYPES: Record<UnitKind, UnitType> = {
  footman: {
    kind: 'footman',
    name: 'Footman',
    plural: 'Footmen',
    blurb: 'Armoured swordsmen. Solid all-rounders that beat pikemen in a straight fight.',
    category: 'infantry',
    classes: ['melee', 'pierce', 'infantry'],
    hp: 80,
    armor: { melee: 2, pierce: 1 },
    speed: 7.5,
    radius: 1.0,
    mass: 1,
    sight: 42,
    attack: { kind: 'melee', damage: { melee: 11, spearman: 3 }, range: 1.6, minRange: 0, reload: 1.8 },
    cost: 60,
    stride: 7.5,
    spacing: { side: 2.7, depth: 2.9 },
    counters: 'Strong vs pikemen. Weak vs archers and catapults.',
  },
  pikeman: {
    kind: 'pikeman',
    name: 'Pikeman',
    plural: 'Pikemen',
    blurb: 'Long spears and longer reach. Cavalry charging into a pike line dies quickly.',
    category: 'infantry',
    classes: ['melee', 'pierce', 'infantry', 'spearman'],
    hp: 60,
    armor: { melee: 1, pierce: 1 },
    speed: 7.2,
    radius: 1.0,
    mass: 1,
    sight: 42,
    attack: { kind: 'melee', damage: { melee: 7, cavalry: 10 }, range: 3.4, minRange: 0, reload: 2.0 },
    cost: 45,
    stride: 7.2,
    spacing: { side: 2.6, depth: 2.9 },
    counters: 'Strong vs knights. Weak vs archers and footmen.',
  },
  archer: {
    kind: 'archer',
    name: 'Archer',
    plural: 'Archers',
    blurb: 'Volleys of arrows from behind the line. Fragile up close.',
    category: 'ranged',
    classes: ['melee', 'pierce', 'archer'],
    hp: 45,
    armor: { melee: 0, pierce: 0 },
    speed: 7.8,
    radius: 1.0,
    mass: 0.9,
    sight: 62,
    attack: {
      kind: 'ranged',
      damage: { pierce: 6, spearman: 3, infantry: 3 },
      range: 56,
      minRange: 0,
      reload: 2.0,
      projectile: 'arrow',
      projectileSpeed: 58,
      accuracy: 0.8,
      spread: 0.9,
    },
    cost: 50,
    stride: 7.8,
    spacing: { side: 2.6, depth: 3.0 },
    counters: 'Strong vs pikemen and slow infantry. Weak vs knights.',
  },
  knight: {
    kind: 'knight',
    name: 'Knight',
    plural: 'Knights',
    blurb: 'Heavily armoured lancers. A charge into archers or siege is devastating.',
    category: 'cavalry',
    classes: ['melee', 'pierce', 'cavalry'],
    hp: 170,
    armor: { melee: 3, pierce: 3 },
    speed: 11,
    runSpeed: 14,
    radius: 1.9,
    mass: 3,
    sight: 48,
    attack: { kind: 'melee', damage: { melee: 13, archer: 4, siege: 12 }, range: 2.2, minRange: 0, reload: 1.8 },
    charge: { bonus: 14, distance: 18 },
    cost: 110,
    stride: 13,
    spacing: { side: 4.4, depth: 6.6 },
    counters: 'Strong vs archers and catapults. Weak vs pikemen.',
  },
  catapult: {
    kind: 'catapult',
    name: 'Catapult',
    plural: 'Catapults',
    blurb: 'Hurls stones that crush packed ranks. Must unpack to fire; helpless up close.',
    category: 'siege',
    classes: ['melee', 'pierce', 'siege'],
    hp: 90,
    armor: { melee: 0, pierce: 7 },
    speed: 4.6,
    radius: 3.0,
    mass: 8,
    sight: 60,
    attack: {
      kind: 'ranged',
      damage: { melee: 38, infantry: 10, archer: 6 },
      range: 88,
      minRange: 16,
      reload: 6.5,
      projectile: 'stone',
      projectileSpeed: 42,
      accuracy: 0.55,
      spread: 0.9,
      splash: { inner: 1.6, outer: 5.5, edge: 0.35, friendly: 0.6 },
    },
    cost: 190,
    setupTime: 2.4,
    stride: 10,
    spacing: { side: 9, depth: 10 },
    counters: 'Strong vs packed infantry and archers. Weak vs knights.',
  },
};

export const UNIT_KINDS: UnitKind[] = ['footman', 'pikeman', 'archer', 'knight', 'catapult'];

/** AoE2 damage formula for one hit. */
export function computeDamage(attack: AttackSpec, target: UnitType, multiplier = 1): number {
  let total = 0;
  for (const [cls, value] of Object.entries(attack.damage) as [ArmorClass, number][]) {
    if (!target.classes.includes(cls)) continue;
    total += Math.max(0, value - (target.armor[cls] ?? 0));
  }
  return Math.max(1, total * multiplier);
}

export type FactionId = 'rome' | 'hellas';

export interface Faction {
  id: FactionId;
  name: string;
  adjective: string;
  sprites: Record<UnitKind, string>;
  /** Sprite used while a catapult travels. */
  packedCatapult: string;
}

export const FACTIONS: Record<FactionId, Faction> = {
  rome: {
    id: 'rome',
    name: 'The Legion',
    adjective: 'Roman',
    sprites: {
      footman: 'rome_footman',
      pikeman: 'rome_pikeman',
      archer: 'rome_archer',
      knight: 'rome_knight',
      catapult: 'rome_catapult',
    },
    packedCatapult: 'rome_catapult_packed',
  },
  hellas: {
    id: 'hellas',
    name: 'The Phalanx',
    adjective: 'Hellenic',
    sprites: {
      footman: 'hellas_footman',
      pikeman: 'hellas_pikeman',
      archer: 'hellas_archer',
      knight: 'hellas_knight',
      catapult: 'hellas_catapult',
    },
    packedCatapult: 'hellas_catapult_packed',
  },
};
