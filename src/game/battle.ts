// A running battle: world + renderer + input + AI, driven by a fixed-step loop.

import type { Application, Ticker } from 'pixi.js';
import { World, TICK } from '../sim/world';
import { generateMap, type GameMap, type Spawn } from '../scenarios/mapgen';
import type { Army, Scenario } from '../scenarios/scenarios';
import { computeLayout, slotToWorld } from '../sim/formationLayout';
import { FACTIONS, UNIT_KINDS, type FactionId, type UnitKind } from '../sim/unitTypes';
import type { Unit } from '../sim/unit';
import { GameRenderer, type TeamStyle } from '../render/gameRenderer';
import { loadSets, ENV_SETS } from '../assets/loader';
import { loadTerrainTextures } from '../render/terrain';
import { Input, type InputCallbacks } from './input';
import { AIController, type Difficulty } from './ai';

export interface BattleConfig {
  scenario: Scenario;
  player: { faction: FactionId; army: Army; color: [number, number, number] };
  enemy: { faction: FactionId; army: Army; color: [number, number, number] };
  difficulty: Difficulty;
}

export interface BattleResult {
  winner: number;
  time: number;
  stats: { team: number; kind: UnitKind; start: number; alive: number }[];
  kills: number[];
}

export const TEAM_COLORS: Record<string, [number, number, number]> = {
  blue: [46, 98, 222],
  red: [200, 38, 32],
  gold: [214, 160, 26],
  green: [44, 150, 64],
  purple: [130, 60, 190],
  teal: [26, 150, 160],
};

/** Places an army in line formation at its spawn point. */
export function deployArmy(world: World, team: number, army: Army, spawn: Spawn, shape: import('../sim/formationLayout').FormationShape = 'line'): Unit[] {
  const kinds: UnitKind[] = [];
  for (const k of UNIT_KINDS) for (let i = 0; i < army[k]; i++) kinds.push(k);
  if (!kinds.length) return [];
  const slots = computeLayout(kinds, shape);
  const pose = { pos: spawn.pos, heading: spawn.heading };
  const units: Unit[] = [];
  for (const s of slots) {
    const p = slotToWorld(pose, s);
    units.push(world.spawn(team, s.kind, p, spawn.heading));
  }
  world.createFormation(units, shape, spawn.heading);
  return units;
}

export class Battle {
  readonly world: World;
  readonly renderer: GameRenderer;
  readonly input: Input;
  readonly ai: AIController;
  readonly spectator: boolean;
  paused = false;
  speed = 1;
  ended = false;
  private acc = 0;
  private tickerFn: (t: Ticker) => void;
  private startCounts: { team: number; kind: UnitKind; start: number }[] = [];
  onEnd: ((r: BattleResult) => void) | null = null;
  onFrame: ((dt: number) => void) | null = null;

  private constructor(
    readonly app: Application,
    readonly config: BattleConfig,
    readonly map: GameMap,
    world: World,
    renderer: GameRenderer,
    callbacks: InputCallbacks,
    spectator: boolean,
  ) {
    this.world = world;
    this.renderer = renderer;
    this.spectator = spectator;
    this.input = new Input(app.canvas, world, renderer, callbacks, 0, spectator);
    this.ai = new AIController(1, config.difficulty, config.scenario.enemyPlan ?? 'attack');
    world.controllers.push(this.ai);
    if (spectator) world.controllers.push(new AIController(0, config.difficulty, 'attack'));
    for (const team of [0, 1]) {
      const army = team === 0 ? config.player.army : config.enemy.army;
      for (const k of UNIT_KINDS) if (army[k]) this.startCounts.push({ team, kind: k, start: army[k] });
    }
    this.tickerFn = (t) => this.frame(t.deltaMS / 1000);
  }

  static async create(
    app: Application,
    config: BattleConfig,
    callbacks: InputCallbacks,
    onProgress?: (f: number, label: string) => void,
    opts: { spectator?: boolean; shape?: import('../sim/formationLayout').FormationShape } = {},
  ): Promise<Battle> {
    onProgress?.(0.02, 'Shaping the land');
    await new Promise((r) => setTimeout(r, 16));
    const map = generateMap(config.scenario.map, config.scenario.seed);
    const world = new World(map, config.scenario.seed ^ 0x5eed);
    const sets = [
      ...new Set([
        ...Object.values(FACTIONS[config.player.faction].sprites),
        FACTIONS[config.player.faction].packedCatapult,
        ...Object.values(FACTIONS[config.enemy.faction].sprites),
        FACTIONS[config.enemy.faction].packedCatapult,
        ...ENV_SETS,
      ]),
    ];
    onProgress?.(0.08, 'Mustering the armies');
    const [loaded, terrainTex] = await Promise.all([
      loadSets(sets, (f) => onProgress?.(0.08 + f * 0.8, 'Mustering the armies')),
      loadTerrainTextures(),
    ]);
    onProgress?.(0.9, 'Raising banners');
    await new Promise((r) => setTimeout(r, 16));
    const teams: TeamStyle[] = [
      { color: config.player.color, faction: config.player.faction },
      { color: config.enemy.color, faction: config.enemy.faction },
    ];
    deployArmy(world, 0, config.player.army, map.spawns[0], opts.shape ?? 'line');
    deployArmy(world, 1, config.enemy.army, map.spawns[1], 'line');
    const renderer = new GameRenderer(app, world, map, loaded, terrainTex, teams);
    // Pre-tint every team sprite set now so the first frames don't stutter.
    for (const [name, data] of loaded) {
      if (name.startsWith('env_')) data.forTeam([255, 255, 255]);
    }
    for (const t of [0, 1]) {
      const f = FACTIONS[teams[t].faction];
      for (const n of [...Object.values(f.sprites), f.packedCatapult]) loaded.get(n)?.forTeam(teams[t].color);
    }
    renderer.resize(app.screen.width, app.screen.height);
    renderer.camera.centerOn({
      x: map.spawns[0].pos.x + Math.cos(map.spawns[0].heading) * 30,
      y: map.spawns[0].pos.y + Math.sin(map.spawns[0].heading) * 30,
    });
    renderer.camera.zoom = renderer.camera.targetZoom = 0.8;
    onProgress?.(1, 'Ready');
    return new Battle(app, config, map, world, renderer, callbacks, !!opts.spectator);
  }

  start(): void {
    this.app.stage.addChildAt(this.renderer.root, 0);
    this.app.stage.addChild(this.renderer.overlay);
    this.app.ticker.add(this.tickerFn);
  }

  destroy(): void {
    this.app.ticker.remove(this.tickerFn);
    this.input.dispose();
    this.renderer.root.destroy({ children: true });
    this.renderer.overlay.destroy();
  }

  private frame(realDt: number): void {
    const dt = Math.min(realDt, 0.1);
    if (!this.paused && !this.ended) {
      this.acc += dt * this.speed;
      let steps = 0;
      while (this.acc >= TICK && steps < 8) {
        this.world.step(TICK);
        this.renderer.consumeEvents();
        this.onWorldEvents?.(this.world.events);
        this.world.events = [];
        this.acc -= TICK;
        steps++;
      }
      if (steps === 8) this.acc = 0;
      this.input.pruneSelection();
      if (this.world.winner !== null && !this.ended) this.finish();
    }
    this.input.update(dt);
    this.renderer.update(this.paused ? 1 : this.acc / TICK, this.paused ? 0 : dt * this.speed);
    this.onFrame?.(dt);
  }

  onWorldEvents: ((events: World['events']) => void) | null = null;

  private finish(): void {
    this.ended = true;
    const stats = this.startCounts.map((s) => ({
      ...s,
      alive: this.world.units.filter((u) => u.alive && u.team === s.team && u.kind === s.kind).length,
    }));
    const kills = [0, 1].map((t) => this.world.units.filter((u) => u.team === t).reduce((a, u) => a + u.kills, 0));
    const result: BattleResult = { winner: this.world.winner ?? -1, time: this.world.time, stats, kills };
    setTimeout(() => this.onEnd?.(result), 2200);
  }

  /** Units of a team still alive, by kind. */
  counts(team: number): Record<UnitKind, number> {
    const c = { footman: 0, pikeman: 0, archer: 0, knight: 0, catapult: 0 } as Record<UnitKind, number>;
    for (const u of this.world.units) if (u.alive && u.team === team) c[u.kind]++;
    return c;
  }
}
