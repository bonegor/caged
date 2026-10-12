// The drill catalogue: scripted manoeuvres that exercise formation movement,
// each with measured pass/fail checks. See drill.ts for the framework.

import { computeLayout, naturalWidth, worldToSlot } from '../sim/formationLayout';
import { compositionKinds, type Composition } from '../sim/deploy';
import { dist, type Vec2 } from '../sim/math';
import { UNIT_TYPES } from '../sim/unitTypes';
import type { Unit } from '../sim/unit';
import { A, B, EAST } from './fields';
import {
  act,
  ahead,
  at,
  atEnd,
  backwards,
  centroid,
  crowding,
  detours,
  duration,
  finalShape,
  formed,
  heading,
  insideObstacles,
  mark,
  pace,
  peak,
  ranks,
  settle,
  shapeKeeping,
  slotSwaps,
  stillness,
  stragglers,
  stuck,
  until,
  wait,
  DRILL_GROUPS,
  type Drill,
  type DrillRun,
} from './drill';

const ARMY: Composition = { knight: 6, footman: 12, pikeman: 10, archer: 12, catapult: 2 };
const FOOT: Composition = { footman: 10, pikeman: 10, archer: 10 };
const BIG: Composition = { knight: 12, footman: 24, pikeman: 20, archer: 20, catapult: 4 };
const WEST = EAST + Math.PI;
const SOUTH = EAST + Math.PI / 2; // to the right of an army facing east
const NORTH = EAST - Math.PI / 2;
/** Centre of the practice fields (the gap in the hedge, the ford, a copse in the woods). */
const MID: Vec2 = { x: 180, y: 180 };

/** Slowest walking speed in a composition. */
const slowest = (c: Composition) => Math.min(...compositionKinds(c).map((k) => UNIT_TYPES[k].speed));
/** Time an ideal anchor needs for `d` u (0.9 x slowest speed). */
const ideal = (c: Composition, d: number) => d / (0.9 * slowest(c));

/** Side of the x = y diagonal (walls and the river): negative is A's side. */
const side = (p: Vec2) => p.x - p.y;
const onFarSide = (r: DrillRun) => r.alive.filter((u) => side(u.pos) <= 4).length;

/** Waits for the freshly spawned army to stand formed, then a moment more. */
const ready = [until('Army forms up', formed, 15, 'ready'), wait(1)];

const common = () => [insideObstacles('Never inside trees, rocks or water'), stuck('Nobody stuck behind an obstacle', 'order', 'done')];

/** Mean nearest-neighbour distance among members (a spacing measure). */
function spacing(units: Unit[]): number {
  let sum = 0;
  for (const u of units) {
    let best = Infinity;
    for (const o of units) if (o !== u) best = Math.min(best, dist(u.pos, o.pos));
    sum += best;
  }
  return sum / units.length;
}

const ALL: Drill[] = [
  {
    id: 'form-up',
    group: 'Basics',
    name: 'Form up from a crowd',
    summary: 'A disorganised crowd forms a line 30 u ahead. Everyone should arrive together without paths crossing.',
    field: 'open',
    setup: (r) => r.spawnMob(ARMY, A, 26),
    steps: [
      wait(0.5),
      mark('order'),
      act('Move 30 u east', (r) => r.move(ahead(centroid(r.army), EAST, 30))),
      settle(30),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to form up', 'order', 'arrived', 26),
      crowding('Deepest overlap while forming', 'order', 'arrived', 0.75),
      finalShape('Distance from slot', 0.5, 1.5),
      ranks('Knights, infantry, archers, siege front to back'),
      stillness('Stands still once formed'),
      ...common(),
    ],
  },
  {
    id: 'advance',
    group: 'Basics',
    name: 'Advance in line',
    summary: 'A formed army marches 80 u straight ahead as one block, at the pace of its slowest unit.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 80 u ahead', (r) => r.move(ahead(A, EAST, 80))),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      at('order', 'Moves as a rigid block', 'min', 1, '', (rr) => (rr.formation?.mode === 'rigid' ? 1 : 0)),
      pace('Marching pace', 'order', 'arrived', 0.85),
      shapeKeeping('Worst drift from slot while marching', 'order', 'arrived', 2.0),
      backwards('Worst backwards walking', 'order', 'arrived', 0.3),
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, 80) * 1.15 + 4),
      heading('Final facing', () => EAST),
      finalShape('Distance from slot', 0.5, 1.5),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'veer',
    group: 'Basics',
    name: 'Veer while advancing',
    summary: 'A target 20° off the current facing: the block turns smoothly on the way instead of re-forming.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 85 u ahead, 30 u to the right', (r) => r.move(ahead(A, EAST, 85, 30))),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      at('order', 'Moves as a rigid block', 'min', 1, '', (rr) => (rr.formation?.mode === 'rigid' ? 1 : 0)),
      shapeKeeping('Worst drift from slot while turning', 'order', 'arrived', 2.5),
      backwards('Worst backwards walking', 'order', 'arrived', 0.5),
      pace('Marching pace', 'order', 'arrived', 0.75),
      heading('Final facing (direction of travel)', () => EAST + Math.atan2(30, 85)),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'wheel',
    group: 'Basics',
    name: 'Wheel right',
    summary: 'A target 60 u to the right: the line re-forms facing the new direction, everyone arriving together.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 60 u to the right', (r) => r.move(ahead(A, EAST, 0, 60))),
      settle(40),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to re-form', 'order', 'arrived', 24),
      heading('Final facing', () => SOUTH),
      ranks('Knights, infantry, archers, siege front to back'),
      detours('Walked / straight-line distance', 'order', 'done', 1.35),
      finalShape('Distance from slot', 0.5, 1.5),
      stillness('Stands still once formed'),
      ...common(),
    ],
  },
  {
    id: 'about-face',
    group: 'Basics',
    name: 'About face',
    summary: 'A target 40 u behind: the army turns around. The knights must end up in front again.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 40 u back', (r) => r.move(ahead(A, EAST, -40))),
      settle(40),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to turn and re-form', 'order', 'arrived', 26),
      heading('Final facing', () => WEST),
      ranks('Knights, infantry, archers, siege front to back'),
      detours('Walked / straight-line distance', 'order', 'done', 1.5),
      crowding('Deepest overlap while turning', 'order', 'arrived', 0.75),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'march',
    group: 'Marching',
    name: 'Long march',
    summary: 'A 200 u march: the army files into a column, keeps the slowest unit’s pace and deploys into line at the end.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('March to B', (r) => r.move(B)),
      until('Column forms', (r) => r.formation?.layoutMode === 'march', 2, 'column'),
      until('Deploys near the end', (r) => r.formation?.layoutMode === 'battle', 90, 'deploy'),
      settle(40),
      mark('done'),
      wait(4),
    ],
    probes: () => [
      pace('Marching pace', 'order', 'deploy', 0.85),
      // Ranks waiting to fall in get jostled by comrades filing past; walking
      // back on purpose would show as several units of distance.
      backwards('Worst backwards drift (jostling)', 'order', 'deploy', 1.5),
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, dist(A, B)) * 1.2 + 14),
      heading('Final facing', () => EAST),
      ranks('Knights, infantry, archers, siege front to back'),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'redirect',
    group: 'Marching',
    name: 'Change course mid-march',
    summary: 'Halfway through a march the army is sent somewhere else, 90° off. No turning back on itself, no tangle.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('first'),
      act('March to B', (r) => r.move(B)),
      wait(14),
      mark('order'),
      act('Redirect 140 u to the right', (r) => {
        const target = ahead(centroid(r.alive), EAST, 10, 140);
        // The column faces the way its head walks: from the head to the target.
        const f = r.formation!;
        const head = f.path ? f.path.poseAt(f.s + f.extent.front).pos : centroid(r.alive);
        r.memo.heading = Math.atan2(target.y - head.y, target.x - head.x);
        r.move(target);
      }),
      settle(90),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      backwards('Worst backwards walking after the new order', 'order', 'arrived', 2),
      duration('Time to arrive after the new order', 'order', 'arrived', ideal(ARMY, 141) * 1.25 + 16),
      crowding('Deepest overlap while turning', 'order', 'arrived', 0.75),
      heading('Final facing', (rr) => rr.memo.heading),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      ...common(),
    ],
  },
  {
    id: 'woods',
    group: 'Terrain',
    name: 'Through the woods',
    summary: 'March across copses and boulders. The column flows around them and re-forms beyond.',
    field: 'woods',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('March to B', (r) => r.move(B)),
      settle(110),
      mark('done'),
      wait(4),
    ],
    probes: () => [
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, dist(A, B)) * 1.45 + 14),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'pass',
    group: 'Terrain',
    name: 'Through a narrow pass',
    summary: 'March through a 16 u gap in a hedge to a point 200 u away. The column threads the gap and deploys beyond.',
    field: 'pass',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('March to B', (r) => r.move(B)),
      settle(120),
      mark('done'),
      wait(4),
    ],
    probes: () => [
      atEnd('Units left on the wrong side', 'max', 0, 'units', onFarSide),
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, dist(A, B)) * 1.35 + 16),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      ...common(),
    ],
  },
  {
    id: 'pass-short',
    group: 'Terrain',
    name: 'Squeeze through the pass',
    summary: 'A short move (90 u) through the same 16 u gap with a 29 u wide line. The block must narrow down, pass and widen again.',
    field: 'pass',
    setup: (r) => r.spawnFormed(ARMY, ahead({ x: 180, y: 180 }, EAST, -45), EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 90 u ahead through the gap', (r) => r.move(ahead({ x: 180, y: 180 }, EAST, 45))),
      settle(90),
      mark('done'),
      wait(4),
    ],
    probes: () => [
      atEnd('Units left on the wrong side', 'max', 0, 'units', onFarSide),
      duration('Time to arrive', 'order', 'arrived', 50),
      crowding('Deepest overlap in the gap', 'order', 'arrived', 0.75),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      ...common(),
    ],
  },
  {
    id: 'ford',
    group: 'Terrain',
    name: 'Cross a river ford',
    summary: 'March over a 26 u wide ford in a river. Nobody wades into deep water and the army re-forms on the far bank.',
    field: 'ford',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('March to B', (r) => r.move(B)),
      settle(120),
      mark('done'),
      wait(4),
    ],
    probes: () => [
      atEnd('Units left on the wrong bank', 'max', 0, 'units', onFarSide),
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, dist(A, B)) * 1.35 + 16),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      ...common(),
    ],
  },
  {
    id: 'shapes',
    group: 'Basics',
    name: 'Change shape in place',
    summary: 'Line, staggered, box, flank and back to line, re-forming where it stands each time.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      act('Note line spacing', (r) => (r.memo.lineSpacing = spacing(r.alive.filter((u) => u.kind === 'footman' || u.kind === 'pikeman')))),
      mark('order'),
      act('Staggered (W)', (r) => r.world.setShape(r.alive, 'staggered')),
      settle(20, 'staggered', 'Staggered formation stands'),
      act('Box (E)', (r) => r.world.setShape(r.alive, 'box')),
      settle(20, 'box', 'Box formation stands'),
      act('Flank (R)', (r) => r.world.setShape(r.alive, 'flank')),
      settle(20, 'flank', 'Flank formation stands'),
      act('Line (Q)', (r) => r.world.setShape(r.alive, 'line')),
      settle(20, 'line', 'Line formation stands'),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Line → staggered', 'order', 'staggered', 14),
      duration('Staggered → box', 'staggered', 'box', 14),
      duration('Box → flank', 'box', 'flank', 14),
      duration('Flank → line', 'flank', 'line', 14),
      at('staggered', 'Staggered infantry spacing vs line', 'min', 1.5, '×', (rr) => spacing(rr.alive.filter((u) => u.kind === 'footman' || u.kind === 'pikeman')) / rr.memo.lineSpacing),
      at('box', 'Box: archers sit inside (distance vs infantry)', 'max', 0.75, '×', (rr) => {
        const c = centroid(rr.alive);
        const mean = (us: Unit[]) => us.reduce((a, u) => a + dist(u.pos, c), 0) / us.length;
        return mean(rr.alive.filter((u) => u.kind === 'archer')) / mean(rr.alive.filter((u) => u.kind === 'footman' || u.kind === 'pikeman'));
      }),
      at('flank', 'Flank: clear gap in the middle', 'min', 5, 'u', (rr) => {
        const f = rr.formation!;
        return Math.min(...rr.alive.map((u) => Math.abs(worldToSlot(f.pose, u.pos).x)));
      }),
      finalShape('Distance from slot', 0.5, 1.5),
      ranks('Knights, infantry, archers, siege front to back'),
      ...common(),
    ],
  },
  {
    id: 'mixed-speed',
    group: 'Marching',
    name: 'Knights escorting catapults',
    summary: 'Fast knights and slow catapults in one formation: the knights hold their places at catapult pace.',
    field: 'open',
    setup: (r) => r.spawnFormed({ knight: 8, catapult: 2 }, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 90 u ahead', (r) => r.move(ahead(A, EAST, 90))),
      settle(60),
      mark('done'),
      wait(5),
    ],
    probes: () => [
      pace('Marching pace', 'order', 'arrived', 0.85),
      shapeKeeping('Worst drift from slot while marching', 'order', 'arrived', 2.5),
      duration('Time to arrive', 'order', 'arrived', ideal({ catapult: 1 }, 90) * 1.15 + 6),
      atEnd('Catapults set up again at the end', 'min', 2, '', (rr) => rr.alive.filter((u) => u.kind === 'catapult' && u.deployed).length),
      finalShape('Distance from slot', 0.6, 1.5),
      ...common(),
    ],
  },
  {
    id: 'straggler',
    group: 'Groups',
    name: 'A straggler far behind',
    summary: 'One footman 110 u behind the army gets the same order. The army doesn’t wait; he walks to his slot on his own.',
    field: 'open',
    setup: (r) => {
      r.spawnFormed(FOOT, A, EAST);
      r.army.push(r.world.spawn(0, 'footman', ahead(A, EAST, -110), EAST));
    },
    steps: [
      ...ready,
      mark('order'),
      act('Everyone: move 60 u ahead', (r) => r.move(ahead(A, EAST, 60))),
      until('The army arrives', (r) => formed(r) && r.alive.filter((u) => u.memberFlag === 'ok').length >= r.alive.length - 1, 40, 'arrived'),
      until('The straggler reaches his slot', (r) => r.alive.every((u) => u.formation === r.formation && u.memberFlag === 'ok' && dist(u.pos, u.formation!.slotWorld(u)) < 1.5), 60, 'joined'),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      at('order', 'Marked as a straggler at the order', 'min', 1, 'units', (rr) => rr.alive.filter((u) => u.memberFlag === 'straggler').length),
      duration('Army arrives without waiting for him', 'order', 'arrived', ideal(FOOT, 60) * 1.2 + 6),
      duration('He reaches his slot', 'order', 'joined', 110 / UNIT_TYPES.footman.speed + 12),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'casualties',
    group: 'Groups',
    name: 'Losses on the march',
    summary: 'A third of the army falls mid-march. The survivors close ranks without reshuffling everyone.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 95 u ahead', (r) => r.move(ahead(A, EAST, 95))),
      wait(6),
      act('A third of the army falls', (r) => {
        r.alive.forEach((u, i) => i % 3 === 1 && r.world.damage(u, 9999, null, false));
      }),
      mark('losses'),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      slotSwaps('Slot changes per survivor after the losses', 'losses', 'arrived', 1.5),
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, 95) * 1.2 + 8),
      atEnd('Closed ranks (area vs a fresh formation)', 'max', 1.15, '×', (rr) => {
        const f = rr.formation!;
        const box = (ps: { x: number; y: number }[]) =>
          (Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x))) * (Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y)));
        const fresh = computeLayout(rr.alive.map((u) => u.kind), f.shape);
        return box(rr.alive.map((u) => worldToSlot(f.pose, u.pos))) / box(fresh);
      }),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'front-line',
    group: 'Orders',
    name: 'Drag a front line',
    summary: 'A right-drag order: the front rank must stand on the dragged line, facing away from the army, as wide as the drag.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Front line 60 u ahead, turned 35°, 1.5× as wide', (r) => {
        const kinds = r.alive.map((u) => u.kind);
        r.memo.width = naturalWidth(kinds) * 1.5;
        r.memo.heading = EAST + (35 * Math.PI) / 180;
        const p = ahead(A, EAST, 60, 10);
        r.memo.px = p.x;
        r.memo.py = p.y;
        r.move(p, { heading: r.memo.heading, width: r.memo.width, frontAnchored: true });
      }),
      settle(50),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      heading('Facing', (rr) => rr.memo.heading),
      atEnd('Front rank centre off the drag point', 'max', 2.5, 'u', (rr) => {
        const f = rr.formation!;
        const ys = rr.alive.map((u) => worldToSlot(f.pose, u.pos).y);
        const front = Math.max(...ys);
        const row = rr.alive.filter((u) => worldToSlot(f.pose, u.pos).y > front - 1.5);
        return dist(centroid(row), { x: rr.memo.px, y: rr.memo.py });
      }),
      atEnd('Frontage vs dragged width', 'max', 0.12, '× off', (rr) => {
        const f = rr.formation!;
        const xs = rr.alive.map((u) => worldToSlot(f.pose, u.pos).x);
        const width = Math.max(...xs) - Math.min(...xs);
        return Math.abs(width - rr.memo.width) / rr.memo.width;
      }),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'spam-click',
    group: 'Orders',
    name: 'Impatient orders',
    summary: 'Fifteen near-identical move orders in six seconds, like a player clicking repeatedly. No shuffling, no stalling.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      ...Array.from({ length: 15 }, (_, i) => [
        act(`Order ${i + 1} of 15`, (r: DrillRun) => r.move(ahead(A, EAST, 70 + r.rng.range(-3, 3), r.rng.range(-3, 3)))),
        wait(0.4, 'Click again'),
      ]).flat(),
      mark('last'),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      slotSwaps('Slot changes per unit', 'order', 'arrived', 0.5),
      backwards('Worst backwards walking', 'order', 'arrived', 1),
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, 70) * 1.2 + 6),
      finalShape('Distance from slot', 0.5, 1.5),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'attack-move',
    group: 'Combat',
    name: 'Attack-move through the enemy',
    summary: 'Attack-move past an enemy block: members peel off to fight, then the army re-forms and finishes the march.',
    field: 'open',
    setup: (r) => {
      r.spawnFormed({ knight: 6, footman: 12, pikeman: 10, archer: 12 }, A, EAST);
      const foes = r.spawnFormed({ footman: 8, archer: 6 }, ahead(A, EAST, 85), WEST, 'line', 1);
      r.world.setStance(foes, 'standGround');
    },
    steps: [
      ...ready,
      mark('order'),
      act('Attack-move 150 u ahead', (r) => r.move(ahead(A, EAST, 150), { attackMove: true })),
      until('Contact', (r) => r.alive.some((u) => u.target), 40, 'contact'),
      until('Enemy destroyed', (r) => r.enemies.every((u) => !u.alive), 90, 'cleared'),
      until('Formation re-forms', (r) => !!r.formation && r.formation.phase !== 'engaged' && r.alive.every((u) => !u.target), 15, 'reformed'),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to contact', 'order', 'contact', 25),
      duration('Time to destroy the enemy', 'contact', 'cleared', 60),
      duration('Time to re-form after the fight', 'cleared', 'reformed', 6),
      peak('Furthest chase from the formation', 'contact', 'reformed', 55, 'u', (rr) => {
        const f = rr.formation;
        return f ? Math.max(0, ...rr.alive.map((u) => dist(u.pos, f.centroid()))) : 0;
      }),
      atEnd('Arrived at the attack-move point', 'max', 8, 'u', (rr) => dist(centroid(rr.alive), ahead(A, EAST, 150))),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      insideObstacles('Never inside obstacles'),
    ],
  },
  {
    id: 'retreat',
    group: 'Combat',
    name: 'Break off and fall back',
    summary: 'In the middle of a melee, a move order 70 u back: everyone disengages at once and re-forms away from the enemy.',
    field: 'open',
    setup: (r) => {
      // Melee only, and the enemy out of reach until we attack.
      r.spawnFormed({ footman: 10, pikeman: 10 }, A, EAST);
      const foes = r.spawnFormed({ footman: 10 }, ahead(A, EAST, 45), WEST, 'line', 1);
      r.world.setStance(foes, 'standGround');
    },
    steps: [
      ...ready,
      act('Attack-move into the enemy', (r) => r.move(ahead(A, EAST, 50), { attackMove: true })),
      until('Melee', (r) => r.alive.filter((u) => u.target && !u.isRanged).length >= 6, 20),
      wait(4, 'Fight for 4 s'),
      mark('order'),
      act('Fall back 70 u', (r) => r.move(ahead(A, EAST, -70))),
      until('Everyone out of reach of the enemy', (r) => r.alive.every((u) => r.enemies.every((e) => !e.alive || dist(u.pos, e.pos) > 8)), 12, 'clear'),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to get clear', 'order', 'clear', 7),
      duration('Time to re-form behind', 'order', 'arrived', 40),
      atEnd('Still fighting at the end', 'max', 0, 'units', (rr) => rr.alive.filter((u) => u.target).length),
      finalShape('Distance from slot', 0.6, 2),
      insideObstacles('Never inside obstacles'),
    ],
  },
  {
    id: 'turn-in-place',
    group: 'Basics',
    name: 'Turn round on the spot',
    summary: 'A right-drag on the spot, facing the other way: the army turns round where it stands, knights to the new front.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Face west where you stand', (r) => r.move(A, { heading: WEST })),
      settle(40),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to turn round', 'order', 'arrived', 20),
      heading('Final facing', () => WEST),
      ranks('Knights, infantry, archers, siege front to back'),
      atEnd('Stayed on the spot (centre moved)', 'max', 3, 'u', (rr) => dist(centroid(rr.alive), A)),
      crowding('Deepest overlap while turning', 'order', 'arrived', 0.75),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'box-march',
    group: 'Marching',
    name: 'March in a box',
    summary: 'A box on a long march files into the column like any other shape and unfolds back into the box at the end.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST, 'box'),
    steps: [
      ...ready,
      mark('order'),
      act('March to B', (r) => r.move(B)),
      until('Column forms', (r) => r.formation?.layoutMode === 'march', 2, 'column'),
      settle(110),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to arrive', 'order', 'arrived', ideal(ARMY, dist(A, B)) * 1.25 + 16),
      atEnd('Box again: archers inside (distance vs infantry)', 'max', 0.75, '×', (rr) => {
        const c = centroid(rr.alive);
        const mean = (us: Unit[]) => us.reduce((a, u) => a + dist(u.pos, c), 0) / us.length;
        return mean(rr.alive.filter((u) => u.kind === 'archer')) / mean(rr.alive.filter((u) => u.kind === 'footman' || u.kind === 'pikeman'));
      }),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'big-army',
    group: 'Marching',
    name: 'A large army',
    summary: 'Eighty soldiers on a long march: a long column that still keeps its pace and deploys cleanly.',
    field: 'open',
    setup: (r) => r.spawnFormed(BIG, ahead(A, EAST, -15), EAST),
    steps: [
      ...ready,
      mark('order'),
      act('March to B', (r) => r.move(ahead(B, EAST, 10))),
      until('Deploys near the end', (r) => r.formation?.layoutMode === 'battle', 120, 'deploy'),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      pace('Marching pace', 'order', 'deploy', 0.85),
      duration('Time to arrive', 'order', 'arrived', ideal(BIG, dist(A, B) + 25) * 1.3 + 25),
      ranks('Knights, infantry, archers, siege front to back'),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'small-group',
    group: 'Marching',
    name: 'A handful of knights',
    summary: 'Three knights: too few for a column, they ride as a small line, then wheel to the right.',
    field: 'open',
    setup: (r) => r.spawnFormed({ knight: 3 }, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Ride 150 u east', (r) => r.move(ahead(A, EAST, 150))),
      settle(40),
      mark('turn'),
      act('Then 50 u to the right', (r) => r.move(ahead(A, EAST, 150, 50))),
      settle(30, 'turned', 'They wheel and stand'),
      mark('done'),
      wait(2),
    ],
    probes: () => [
      duration('Time for the ride', 'order', 'arrived', ideal({ knight: 1 }, 150) * 1.15 + 4),
      duration('Time for the wheel', 'turn', 'turned', 12),
      heading('Final facing', () => SOUTH),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'woods-short',
    group: 'Terrain',
    name: 'Short move into the woods',
    summary: 'A 90 u move into the copses: too short for a column, so the block flows round the trees and re-forms.',
    field: 'woods',
    setup: (r) => r.spawnFormed(ARMY, ahead(MID, EAST, -60), EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Move 90 u ahead', (r) => r.move(ahead(MID, EAST, 30))),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      duration('Time to arrive', 'order', 'arrived', 45),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      stillness('Stands still once arrived'),
      ...common(),
    ],
  },
  {
    id: 'into-forest',
    group: 'Terrain',
    name: 'Ordered into a copse',
    summary: 'The destination is the middle of a copse. The formation stops where it fits, as close as it can, with nobody in the trees.',
    field: 'woods',
    setup: (r) => r.spawnFormed(ARMY, ahead({ x: 205, y: 150 }, NORTH, 70), SOUTH),
    steps: [
      ...ready,
      mark('order'),
      act('Move into the copse', (r) => r.move({ x: 205, y: 150 })),
      settle(60),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      atEnd('Ended close to the copse', 'max', 32, 'u', (rr) => dist(centroid(rr.alive), { x: 205, y: 150 })),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.6, 2),
      ...common(),
    ],
  },
  {
    id: 'merge',
    group: 'Groups',
    name: 'Two groups become one',
    summary: 'Knights and infantry formed up apart are selected together and sent off: one formation, knights in front.',
    field: 'open',
    setup: (r) => {
      r.spawnFormed({ knight: 6 }, ahead(A, EAST, 0, -28), EAST);
      r.spawnFormed({ footman: 10, pikeman: 8, archer: 10 }, ahead(A, EAST, 0, 12), EAST);
    },
    steps: [
      until('Both groups stand formed', (r) => r.alive.every((u) => u.formation?.phase === 'idle'), 15, 'ready'),
      wait(1),
      mark('order'),
      act('Everyone: move 60 u ahead', (r) => r.move(ahead(A, EAST, 60))),
      settle(40),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      atEnd('Formations at the end', 'max', 1, '', (rr) => new Set(rr.alive.map((u) => u.formation)).size),
      ranks('Knights in front of the infantry'),
      duration('Time to arrive', 'order', 'arrived', 30),
      stragglers('Stragglers at the end'),
      finalShape('Distance from slot', 0.5, 1.5),
      ...common(),
    ],
  },
  {
    id: 'split',
    group: 'Groups',
    name: 'Detach the archers',
    summary: 'Only the archers are sent away. They form a block of their own; the rest close the gap they left.',
    field: 'open',
    setup: (r) => r.spawnFormed(ARMY, A, EAST),
    steps: [
      ...ready,
      mark('order'),
      act('Archers: move 50 u to the right', (r) => r.world.commandMove(r.alive.filter((u) => u.kind === 'archer'), ahead(A, EAST, 0, 50))),
      wait(1),
      until('Both groups stand formed', (r) => r.alive.every((u) => u.formation?.phase === 'idle'), 40, 'arrived'),
      mark('done'),
      wait(3),
    ],
    probes: () => [
      atEnd('Formations at the end', 'max', 2, '', (rr) => new Set(rr.alive.map((u) => u.formation)).size),
      atEnd('Archers ended together near their target', 'max', 6, 'u', (rr) => dist(centroid(rr.alive.filter((u) => u.kind === 'archer')), ahead(A, EAST, 0, 50))),
      atEnd('The rest closed ranks (area vs a fresh formation)', 'max', 1.15, '×', (rr) => {
        const rest = rr.alive.filter((u) => u.kind !== 'archer');
        const f = rest[0].formation!;
        const box = (ps: { x: number; y: number }[]) =>
          (Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x))) * (Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y)));
        return box(rest.map((u) => worldToSlot(f.pose, u.pos))) / box(computeLayout(rest.map((u) => u.kind), f.shape));
      }),
      duration('Time until both stand formed', 'order', 'arrived', 25),
      finalShape('Distance from slot (main body)', 0.5, 1.5),
      ...common(),
    ],
  },
];

/** All drills, grouped in UI order. */
export const DRILLS: Drill[] = DRILL_GROUPS.flatMap((g) => ALL.filter((d) => d.group === g));
export const DRILL_BY_ID = new Map(DRILLS.map((d) => [d.id, d]));
