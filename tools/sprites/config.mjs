// Which 0 A.D. actors become which game sprites, and how they are sampled.
//
// Directions: index i faces world angle i * 360 / dirs degrees, measured from
// the world +x axis towards +y (screen right-down is +x, left-down is +y).

/** Final sprite resolution in pixels per model unit (a soldier is ~4.1 units tall). */
export const SCALE = 16;
/** Render at this multiple of the final size, then downsample (anti-aliasing). */
export const SUPERSAMPLE = 3;
/** Shadow atlases are stored at this fraction of SCALE. */
export const SHADOW_SCALE = 0.5;

const infantry = (attack) => ({
  idle: { anim: 'idle', dirs: 16, frames: 4, span: [0, 0.6], loop: 'pingpong' },
  walk: { anim: 'walk', dirs: 16, frames: 10, loop: 'loop' },
  attack: { anim: attack, dirs: 8, frames: 10, loop: 'once' },
  death: { anim: 'death', dirs: 8, frames: 10, loop: 'once' },
});

const cavalry = {
  idle: { anim: 'idle', dirs: 16, frames: 3, span: [0, 0.5], loop: 'pingpong' },
  walk: { anim: 'walk', dirs: 16, frames: 10, loop: 'loop' },
  run: { anim: 'run', dirs: 16, frames: 8, loop: 'loop' },
  attack: { anim: 'attack_melee', dirs: 8, frames: 10, loop: 'once' },
  death: { anim: 'death', dirs: 8, frames: 10, loop: 'once' },
};

const catapult = {
  idle: { anim: 'idle', dirs: 16, frames: 1, span: [0, 0], loop: 'once' },
  attack: { anim: 'attack_ranged', dirs: 8, frames: 12, loop: 'once' },
};

const packed = {
  walk: { anim: 'walk', dirs: 16, frames: 6, loop: 'loop' },
  idle: { anim: 'idle', dirs: 16, frames: 1, span: [0, 0], loop: 'once' },
};

export const SETS = {
  // --- Roman legion -------------------------------------------------------
  'rome/footman': { actor: 'units/romans/infantry_swordsman_b.xml', seed: 'r-foot-2', states: infantry('attack_melee') },
  'rome/pikeman': { actor: 'units/romans/infantry_spearman_e.xml', seed: 'r-pike-1', states: infantry('attack_melee') },
  'rome/archer': { actor: 'units/macedonians/infantry_archer_e.xml', seed: 'r-arch-1', states: infantry('attack_ranged') },
  'rome/knight': { actor: 'units/romans/cavalry_spearman_e_m.xml', seed: 'r-knight-1', states: cavalry },
  'rome/catapult': { actor: 'units/romans/siege_onager_pivot.xml', seed: 'r-cat-1', states: catapult },
  'rome/catapult_packed': { actor: 'units/romans/siege_onager_packed.xml', seed: 'r-cat-1', states: packed },

  // --- Hellenistic phalanx ------------------------------------------------
  'hellas/footman': { actor: 'units/seleucids/infantry_swordsman_e.xml', seed: 'h-foot-1', states: infantry('attack_melee') },
  'hellas/pikeman': { actor: 'units/macedonians/infantry_pikeman_e.xml', seed: 'h-pike-1', states: infantry('attack_melee') },
  'hellas/archer': { actor: 'units/persians/infantry_archer_e.xml', seed: 'h-arch-1', states: infantry('attack_ranged') },
  'hellas/knight': { actor: 'units/seleucids/cavalry_spearman_c_m.xml', seed: 'h-knight-1', states: cavalry },
  'hellas/catapult': { actor: 'units/hellenes/siege_lithobolos_med.xml', seed: 'h-cat-1', states: catapult },
  'hellas/catapult_packed': { actor: 'units/athenians/siege_rock_packed.xml', seed: 'h-cat-1', states: packed },
};

// --- Environment (static; each frame is a different actor / viewing angle) ---
const views = (actor, angles, seed = 'env') => ({ actor, angles, seed });
const A3 = [25, 145, 265];
const A2 = [25, 205];

SETS['env/trees'] = {
  noMask: true,
  states: {
    idle: {
      variants: [
        views('flora/trees/oak.xml', A3),
        views('flora/trees/oak_hungarian.xml', A3),
        views('flora/trees/elm.xml', A2),
        views('flora/trees/euro_birch_tree.xml', A2),
        views('flora/trees/maple_autumn.xml', A2),
        views('flora/trees/poplar.xml', A2),
      ],
    },
  },
};
SETS['env/rocks'] = {
  noMask: true,
  states: {
    idle: {
      variants: [
        views('geology/highland1.xml', A3),
        views('geology/highland2.xml', A3),
        views('geology/highland3.xml', A3),
        views('geology/gray_rock1.xml', A2),
        views('geology/stone_granite_med.xml', A2),
        views('geology/stone_granite_boulder.xml', A2),
      ],
    },
  },
};
SETS['env/bushes'] = {
  noMask: true,
  states: {
    idle: {
      variants: [
        views('props/flora/bush_tempe_la.xml', A2),
        views('props/flora/bush_tempe_me.xml', A2),
        views('props/flora/bush_tempe_sm.xml', A2),
        views('props/flora/bush_tempe_la_lush.xml', A2),
        views('props/flora/bush_medit_me.xml', A2),
        views('props/flora/ferns.xml', A2),
      ],
    },
  },
};
SETS['env/grass'] = {
  noMask: true,
  states: {
    idle: {
      variants: [
        views('props/flora/grass_field_lush_short.xml', A2),
        views('props/flora/grass_soft_dry_small.xml', A2),
        views('props/flora/grass_field_flowering_tall.xml', A2),
        views('props/flora/grass_medit_field.xml', A2),
        views('props/flora/grass_field_parched_short.xml', A2),
      ],
    },
  },
};

/** Props we never want in sprites (ground decals such as blood pools). */
export function propFilter(attachpoint, actor) {
  return !/blood/.test(actor);
}
