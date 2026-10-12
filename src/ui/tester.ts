// The formation tester: a sandbox battlefield with no opponent AI, scripted
// drills you can watch (or run all at once), spawning tools, debug overlays
// and a live readout of the selected formation.

import type { Application } from 'pixi.js';
import { Battle, TEAM_COLORS, type BattleConfig } from '../game/battle';
import type { InputCallbacks } from '../game/input';
import type { Scenario } from '../scenarios/scenarios';
import { Hud } from './hud';
import { h, clear, append } from './dom';
import { setPortrait } from './portraits';
import { DEFAULT_DEBUG, describe, type DebugOptions } from '../render/debugOverlay';
import { DRILLS } from '../tester/drills';
import { DrillRun, DRILL_GROUPS, runDrill, centroid, type Drill, type DrillResult } from '../tester/drill';
import { FIELDS, EAST, fieldMap, type FieldId } from '../tester/fields';
import { deployFormed, deployMob, type Composition } from '../sim/deploy';
import { Rng, dist } from '../sim/math';
import { UNIT_KINDS, UNIT_TYPES, type UnitKind } from '../sim/unitTypes';
import type { FormationShape } from '../sim/formationLayout';
import type { Formation } from '../sim/formation';
import { audio } from '../audio/audio';

export interface TesterCallbacks {
  onQuit(): void;
  onHelp(): void;
}

type Tab = 'drills' | 'sandbox' | 'view';

const fmt = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(2)).toString() : '—');

export class FormationTester {
  private battle: Battle | null = null;
  private hud: Hud | null = null;
  private field: FieldId = 'open';
  private run: DrillRun | null = null;
  private results = new Map<string, DrillResult>();
  private expanded: string | null = null;
  private tab: Tab = 'drills';
  private overlay: DebugOptions = { ...DEFAULT_DEBUG };
  private follow = true;
  private lastFocus = { x: 0, y: 0 };
  private comp: Composition = { knight: 6, footman: 12, pikeman: 10, archer: 12, catapult: 2 };
  private arrangement: 'formed' | 'crowd' = 'formed';
  private shape: FormationShape = 'line';
  private busy = false;
  private batch: { done: number; passed: number } | null = null;
  private rng = new Rng(4242);
  private inspectTimer = 0;
  private loading = 0;

  readonly el = h('div', { class: 'tester-panel' });
  private body = h('div', { class: 'tester-body' });
  private inspector = h('div', { class: 'tester-inspector' });
  private fieldChips = h('div', { class: 'tester-fields' });
  private status = h('span', { class: 'tester-status' });
  private onKey = (e: KeyboardEvent) => {
    if (e.key === '.' && this.battle?.paused) this.step();
  };

  constructor(
    readonly app: Application,
    readonly ui: HTMLElement,
    readonly cb: TesterCallbacks,
  ) {
    this.el.append(
      h('div', { class: 'tester-head' }, h('h3', null, 'Formation Tester'), h('span', { class: 'spacer' }), this.tabButtons()),
      this.body,
      this.inspector,
    );
    window.addEventListener('keydown', this.onKey);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  async open(opts: { drill?: string; field?: FieldId; runAll?: boolean } = {}): Promise<void> {
    audio.playMusic(null);
    this.ui.append(this.el);
    const drill = DRILLS.find((d) => d.id === opts.drill);
    if (drill) await this.watch(drill);
    else await this.loadField(opts.field && FIELDS[opts.field] ? opts.field : 'open');
    this.render();
    if (opts.runAll) void this.runAll();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.teardown();
    this.el.remove();
  }

  private teardown(): void {
    this.run?.detach();
    this.run = null;
    this.hud?.destroy();
    this.hud = null;
    this.battle?.destroy();
    this.battle = null;
  }

  private scenario(id: FieldId): Scenario {
    const f = FIELDS[id];
    const none = { footman: 0, pikeman: 0, archer: 0, knight: 0, catapult: 0 };
    return {
      id: `tester-${id}`,
      name: 'Formation Tester',
      tagline: f.blurb,
      description: f.blurb,
      map: f.spec,
      seed: f.seed,
      budget: 0,
      player: { faction: 'rome', army: none },
      enemy: { faction: 'hellas', army: none },
    };
  }

  /** Fresh, empty battlefield (`worldSeed` matches the headless drill runner). */
  private async loadField(id: FieldId, worldSeed = 7): Promise<void> {
    const token = ++this.loading;
    const keep = this.battle ? { focus: { ...this.battle.renderer.camera.focus }, zoom: this.battle.renderer.camera.zoom, speed: this.battle.speed } : null;
    this.teardown();
    this.field = id;
    const sc = this.scenario(id);
    const config: BattleConfig = {
      scenario: sc,
      player: { faction: 'rome', army: sc.player.army, color: TEAM_COLORS.blue },
      enemy: { faction: 'hellas', army: sc.enemy.army, color: TEAM_COLORS.red },
      difficulty: 'normal',
    };
    const callbacks: InputCallbacks = {
      onSelectionChanged: () => this.hud?.markSelectionDirty(),
      onCommand: () => this.hud?.markSelectionDirty(),
      onPauseToggle: () => this.hud?.togglePause(),
      onSpeedChange: (d) => this.hud?.changeSpeed(d),
      onEscape: () => {},
      isPaused: () => !!this.battle?.paused,
    };
    const battle = await Battle.create(this.app, config, callbacks, undefined, { sandbox: { worldSeed } });
    if (token !== this.loading) {
      battle.destroy();
      return;
    }
    this.battle = battle;
    (window as unknown as { __battle: Battle }).__battle = battle;
    const cam = battle.renderer.camera;
    cam.centerOn(keep?.focus ?? { x: 180, y: 180 });
    cam.zoom = cam.targetZoom = keep?.zoom ?? 0.75;
    battle.speed = keep?.speed ?? 1;
    battle.renderer.debug.options = this.overlay;
    this.hud = new Hud(
      battle,
      { onResume() {}, onRestart: () => void this.loadField(this.field), onQuit: () => this.cb.onQuit(), onChangeArmy() {}, onHelp: () => this.cb.onHelp(), onSettings() {} },
      { title: 'Formation Tester', middle: h('div', { class: 'row', style: 'gap:10px' }, this.fieldChips, this.status), onStep: () => this.step() },
    );
    this.hud.setSpeed(battle.speed);
    this.ui.insertBefore(this.hud.el, this.el);
    battle.onWorldEvents = (events) => audio.onEvents(events, battle);
    battle.onFrame = (dt) => this.frame(dt);
    battle.start();
    this.lastFocus = { ...cam.focus };
    this.renderFields();
  }

  // ---------------------------------------------------------------------------
  // Drills

  /** Plays a drill in the live battle. */
  private async watch(d: Drill): Promise<void> {
    this.expanded = d.id;
    this.results.delete(d.id);
    await this.loadField(d.field, d.seed ?? 7);
    const battle = this.battle;
    if (!battle) return;
    this.run = new DrillRun(d, battle.map, battle.world);
    this.follow = true;
    this.lookAt(centroid(this.run.alive), 1);
    this.lastFocus = { ...battle.renderer.camera.focus };
    this.tab = 'drills';
    this.render();
  }

  /** Runs every drill headless (same code, no rendering) and lists the results. */
  private async runAll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.results.clear();
    this.batch = { done: 0, passed: 0 };
    this.render();
    for (const d of DRILLS) {
      await new Promise((r) => setTimeout(r, 0));
      const r = runDrill(d, fieldMap(d.field));
      this.results.set(d.id, r);
      this.batch.done++;
      if (r.pass) this.batch.passed++;
      this.render();
    }
    this.busy = false;
    this.render();
  }

  private frame(dt: number): void {
    const b = this.battle;
    if (!b) return;
    this.hud?.update(dt);
    // Camera follows the drill's army until the player moves the camera.
    const cam = b.renderer.camera;
    if (dist(cam.focus, this.lastFocus) > 0.01) this.follow = false;
    if (this.run && this.follow && !this.run.done && this.run.alive.length) this.lookAt(centroid(this.run.alive), Math.min(1, dt * 1.5));
    this.lastFocus = { ...cam.focus };
    if (this.run?.done && !this.results.has(this.run.drill.id)) {
      this.results.set(this.run.drill.id, this.run.result());
      this.render();
    }
    this.inspectTimer -= dt;
    if (this.inspectTimer <= 0) {
      this.inspectTimer = 0.2;
      this.renderInspector();
      this.renderStatus();
    }
  }

  /** Screen point in the middle of the battlefield area the panel and HUD leave free. */
  private freeCentre(): { x: number; y: number } {
    const cam = this.battle!.renderer.camera;
    const panel = this.el.getBoundingClientRect();
    return { x: panel.width ? (panel.left - 10) / 2 : cam.viewW / 2, y: (cam.viewH - 176 + 42) / 2 };
  }

  /** Moves the camera (by fraction k) so `p` sits in the middle of the free area. */
  private lookAt(p: { x: number; y: number }, k: number): void {
    const cam = this.battle?.renderer.camera;
    if (!cam) return;
    const free = this.freeCentre();
    // Screen offset of the wanted spot from the screen centre, as a world vector.
    const a = cam.screenToWorld(free.x, free.y);
    const b = cam.screenToWorld(cam.viewW / 2, cam.viewH / 2);
    const target = { x: p.x + (b.x - a.x), y: p.y + (b.y - a.y) };
    cam.centerOn({ x: cam.focus.x + (target.x - cam.focus.x) * k, y: cam.focus.y + (target.y - cam.focus.y) * k });
  }

  private step(): void {
    const b = this.battle;
    if (!b) return;
    if (!b.paused) this.hud?.togglePause();
    b.step(1);
  }

  // ---------------------------------------------------------------------------
  // Sandbox

  private spawn(team: 0 | 1): void {
    const b = this.battle;
    if (!b) return;
    const free = this.freeCentre();
    const centre = b.renderer.camera.screenToWorld(free.x, free.y);
    const heading = team === 0 ? EAST : EAST + Math.PI;
    const units =
      this.arrangement === 'formed'
        ? deployFormed(b.world, team, this.comp, { pos: centre, heading }, this.shape)
        : deployMob(b.world, team, this.comp, centre, 18, this.rng);
    if (team === 1) b.world.setStance(units, 'standGround');
    else b.input.setSelection(units);
    this.run?.detach();
    this.run = null;
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Rendering

  private tabButtons(): HTMLElement {
    const tabs: [Tab, string][] = [
      ['drills', 'Drills'],
      ['sandbox', 'Sandbox'],
      ['view', 'View'],
    ];
    return h(
      'div',
      { class: 'tester-tabs' },
      ...tabs.map(([t, label]) =>
        h(
          'button',
          {
            class: `chip${this.tab === t ? ' on' : ''}`,
            dataset: { tab: t },
            onclick: () => {
              this.tab = t;
              this.render();
            },
          },
          label,
        ),
      ),
    );
  }

  private render(): void {
    const tabs = this.el.querySelector('.tester-tabs');
    tabs?.replaceWith(this.tabButtons());
    clear(this.body);
    if (this.tab === 'drills') this.renderDrills();
    else if (this.tab === 'sandbox') this.renderSandbox();
    else this.renderView();
    this.renderFields();
    this.renderStatus();
  }

  private renderFields(): void {
    clear(this.fieldChips);
    this.fieldChips.append(
      ...(Object.keys(FIELDS) as FieldId[]).map((id) =>
        h(
          'button',
          {
            class: `hud-btn${this.field === id ? ' on' : ''}`,
            title: FIELDS[id].blurb,
            onclick: () => {
              this.run?.detach();
              this.run = null;
              void this.loadField(id).then(() => this.render());
            },
          },
          FIELDS[id].name,
        ),
      ),
    );
  }

  private renderStatus(): void {
    const r = this.run;
    if (!r) {
      this.status.textContent = '';
      return;
    }
    this.status.textContent = r.done ? `${r.drill.name}: ${r.error ? 'failed' : 'finished'}` : `${r.drill.name} · ${r.status}`;
  }

  private renderDrills(): void {
    const summary = this.batch
      ? this.busy
        ? `Running ${this.batch.done + 1} of ${DRILLS.length}…`
        : `${this.batch.passed} of ${DRILLS.length} drills passed`
      : `${DRILLS.length} drills. Watch one, or run them all at full speed.`;
    this.body.append(
      h(
        'div',
        { class: 'row', style: 'gap:10px' },
        h('button', { class: 'btn small', disabled: this.busy, onclick: () => void this.runAll() }, 'Run all'),
        h('span', { class: 'small muted' }, summary),
      ),
    );
    for (const g of DRILL_GROUPS) {
      const list = DRILLS.filter((d) => d.group === g);
      if (!list.length) continue;
      this.body.append(h('div', { class: 'tester-group' }, g));
      for (const d of list) this.body.append(this.drillRow(d));
    }
  }

  private drillRow(d: Drill): HTMLElement {
    const r = this.results.get(d.id);
    const watching = this.run?.drill.id === d.id && !this.run.done;
    const state = watching ? 'running' : r ? (r.pass ? 'pass' : 'fail') : 'idle';
    const open = this.expanded === d.id;
    const row = h(
      'div',
      { class: `drill ${state}${open ? ' open' : ''}` },
      h(
        'div',
        {
          class: 'drill-line',
          onclick: () => {
            this.expanded = open ? null : d.id;
            this.render();
          },
        },
        h('span', { class: 'dot', title: state }),
        h('span', { class: 'drill-name' }, d.name),
        h('span', { class: 'spacer' }),
        r ? h('span', { class: 'small muted' }, `${fmt(r.time)} s`) : null,
        h(
          'button',
          {
            class: 'btn small ghost',
            title: 'Play this drill on the battlefield',
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              void this.watch(d);
            },
          },
          watching ? 'Restart' : 'Watch',
        ),
      ),
    );
    if (open) {
      const details = h('div', { class: 'drill-details' }, h('p', null, d.summary), h('p', { class: 'small muted' }, `Field: ${FIELDS[d.field].name}`));
      if (r?.error) details.append(h('p', { class: 'bad' }, r.error));
      if (r) {
        details.append(
          h(
            'table',
            { class: 'checks' },
            ...r.checks.map((c) =>
              h(
                'tr',
                { class: c.pass ? 'ok' : 'bad' },
                h('td', null, c.pass ? '✓' : '✗'),
                h('td', null, c.label),
                h('td', { class: 'num' }, `${fmt(c.value)} ${c.unit}`),
                h('td', { class: 'num muted' }, `${c.kind === 'max' ? '≤' : '≥'} ${fmt(c.limit)}`),
              ),
            ),
          ),
        );
      } else if (watching) {
        details.append(h('p', { class: 'small muted' }, 'Running… results appear when the drill ends.'));
      }
      row.append(details);
    }
    return row;
  }

  private renderSandbox(): void {
    const b = this.battle;
    const rows = UNIT_KINDS.map((k: UnitKind) => {
      const img = h('img', { class: 'portrait mini', alt: UNIT_TYPES[k].name });
      setPortrait(img, 'rome', k, TEAM_COLORS.blue);
      const change = (d: number) => {
        this.comp[k] = Math.max(0, Math.min(60, (this.comp[k] ?? 0) + d));
        this.render();
      };
      return h(
        'div',
        { class: 'mini-row' },
        img,
        h('span', { class: 'grow' }, UNIT_TYPES[k].plural),
        h('button', { class: 'tiny', onclick: (e: MouseEvent) => change(e.shiftKey ? -5 : -1) }, '−'),
        h('span', { class: 'n' }, this.comp[k] ?? 0),
        h('button', { class: 'tiny', onclick: (e: MouseEvent) => change(e.shiftKey ? 5 : 1) }, '+'),
      );
    });
    const chips = <T extends string>(values: [T, string][], current: T, set: (v: T) => void) =>
      h(
        'div',
        { class: 'faction-pick' },
        ...values.map(([v, label]) => h('span', { class: `chip${current === v ? ' on' : ''}`, onclick: () => (set(v), this.render()) }, label)),
      );
    append(this.body, [
      h('p', { class: 'small muted' }, 'Units appear in the middle of the view, facing right. Enemies hold their ground and fight back.'),
      ...rows,
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'As'), chips([['formed', 'Formation'], ['crowd', 'Crowd']], this.arrangement, (v) => (this.arrangement = v))),
      this.arrangement === 'formed'
        ? h(
            'div',
            { class: 'row' },
            h('span', { class: 'small muted' }, 'Shape'),
            chips(
              [
                ['line', 'Line'],
                ['staggered', 'Staggered'],
                ['box', 'Box'],
                ['flank', 'Flank'],
              ],
              this.shape,
              (v) => (this.shape = v),
            ),
          )
        : null,
      h(
        'div',
        { class: 'row', style: 'flex-wrap:wrap;gap:8px' },
        h('button', { class: 'btn small', disabled: !b, onclick: () => this.spawn(0) }, 'Spawn mine'),
        h('button', { class: 'btn small ghost', disabled: !b, onclick: () => this.spawn(1) }, 'Spawn enemy'),
        h(
          'button',
          {
            class: 'btn small ghost',
            onclick: () => {
              this.run?.detach();
              this.run = null;
              void this.loadField(this.field).then(() => this.render());
            },
          },
          'Clear field',
        ),
      ),
      h(
        'p',
        { class: 'small muted' },
        'Drag to select, right-click to move, right-drag to set a front line, A then right-click to attack-move. Q W E R change shape. P pauses, “.” steps one tick.',
      ),
    ]);
  }

  private renderView(): void {
    const toggles: [keyof DebugOptions, string, string][] = [
      ['slots', 'Slots', 'Where each member should stand, coloured by sub-formation'],
      ['links', 'Unit → slot', 'Green: in place; yellow: within 3 u; red: further'],
      ['path', 'Anchor & path', 'The invisible leader, its route and the destination'],
      ['trails', 'Trails', 'Where each unit walked in the last 14 s'],
      ['velocity', 'Velocities', 'Yellow: actual; green: what the unit wants'],
      ['labels', 'Labels', 'State of each formation'],
    ];
    this.body.append(
      h('div', { class: 'tester-group' }, 'Overlays'),
      ...toggles.map(([key, label, tip]) =>
        h(
          'label',
          { class: 'toggle', title: tip },
          h('input', {
            type: 'checkbox',
            checked: this.overlay[key],
            onchange: (e: Event) => {
              this.overlay[key] = (e.target as HTMLInputElement).checked;
              if (this.battle) this.battle.renderer.debug.options = this.overlay;
            },
          }),
          h('span', null, label),
          h('span', { class: 'small muted' }, tip),
        ),
      ),
      h('div', { class: 'tester-group' }, 'Camera'),
      h(
        'label',
        { class: 'toggle' },
        h('input', { type: 'checkbox', checked: this.follow, onchange: (e: Event) => (this.follow = (e.target as HTMLInputElement).checked) }),
        h('span', null, 'Follow the drill'),
        h('span', { class: 'small muted' }, 'Stops as soon as you move the camera'),
      ),
    );
  }

  private renderInspector(): void {
    const b = this.battle;
    clear(this.inspector);
    if (!b) return;
    const sel = b.input.selection.filter((u) => u.alive);
    const forms = new Set<Formation>();
    for (const u of sel) if (u.formation) forms.add(u.formation);
    // Nothing selected: show the drill's army.
    const drillFormation = !sel.length ? this.run?.formation : null;
    if (drillFormation) forms.add(drillFormation);
    if (!forms.size) {
      this.inspector.append(h('div', { class: 'small muted' }, sel.length ? 'Selected units are not in a formation.' : 'Select units to inspect their formation.'));
      return;
    }
    const f = [...forms][0];
    const vmin = Math.min(...f.members.map((u) => u.speed));
    const lines = describe(f).split('\n');
    this.inspector.append(
      h('div', { class: 'inspector-title' }, lines[0], forms.size > 1 ? ` (+${forms.size - 1} more)` : ''),
      ...lines.slice(1).map((l) => h('div', { class: 'small' }, l)),
      h('div', { class: 'small muted' }, `Slowest member ${vmin} u/s · anchor ${f.pose.pos.x.toFixed(0)}, ${f.pose.pos.y.toFixed(0)}${f.path ? ` · ${Math.max(0, f.path.length - f.s).toFixed(0)} u to go` : ''}`),
    );
  }
}
