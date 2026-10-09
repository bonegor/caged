// Menu screens: title, scenario selection, army setup, loading, help,
// settings and credits.

import { h, clear } from './dom';
import { SCENARIOS, armyCost, type Army, type Scenario } from '../scenarios/scenarios';
import { generateMap } from '../scenarios/mapgen';
import { drawPreview } from '../render/minimap';
import { FACTIONS, UNIT_KINDS, UNIT_TYPES, type FactionId, type UnitKind, type ArmorClass } from '../sim/unitTypes';
import { setPortrait } from './portraits';
import { settings, saveSettings } from '../settings';
import { TEAM_COLORS, type BattleConfig } from '../game/battle';
import type { Difficulty } from '../game/ai';
import type { FormationShape } from '../sim/formationLayout';

const COSTS = Object.fromEntries(UNIT_KINDS.map((k) => [k, UNIT_TYPES[k].cost])) as Record<UnitKind, number>;
const hex = (c: [number, number, number]) => `rgb(${c.join(',')})`;

export function mainMenu(cb: { onPlay(): void; onQuick(): void; onHelp(): void; onSettings(): void; onCredits(): void }): HTMLElement {
  return h(
    'div',
    { class: 'screen shade main-menu' },
    h('h1', { class: 'game-title' }, 'CAGED'),
    h('p', { class: 'game-subtitle' }, 'Battles of Formation'),
    h('div', { class: 'ornament' }),
    h(
      'div',
      { class: 'menu-buttons' },
      h('button', { class: 'btn primary', onclick: cb.onPlay }, 'Choose a Battle'),
      h('button', { class: 'btn', onclick: cb.onQuick }, 'Quick Battle'),
      h('button', { class: 'btn', onclick: cb.onHelp }, 'How to Play'),
      h('button', { class: 'btn', onclick: cb.onSettings }, 'Settings'),
      h('button', { class: 'btn', onclick: cb.onCredits }, 'Credits'),
    ),
    h(
      'div',
      { class: 'menu-footer' },
      'Unit and terrain art from 0 A.D. by Wildfire Games (CC-BY-SA 3.0). Behind this menu: the computer fighting itself.',
    ),
  );
}

// ---------------------------------------------------------------------------

export function scenarioSelect(cb: { onBack(): void; onChoose(s: Scenario): void }): HTMLElement {
  let chosen = SCENARIOS[0];
  const detail = h('div', { class: 'panel detail' });
  const cards = SCENARIOS.map((s) => {
    const canvas = h('canvas', { width: 520, height: 260 });
    // Generate the preview after the screen is shown.
    setTimeout(() => drawPreview(canvas, generateMap(s.map, s.seed), [hex(TEAM_COLORS.blue), hex(TEAM_COLORS.red)]), 30);
    const card = h(
      'div',
      { class: 'card', onclick: () => select(s), ondblclick: () => cb.onChoose(s) },
      canvas,
      h('div', { class: 'card-body' }, h('h3', null, s.name), h('p', null, s.tagline)),
    );
    return { s, card };
  });
  const armyLine = (a: Army) =>
    UNIT_KINDS.filter((k) => a[k])
      .map((k) => `${a[k]} ${a[k] === 1 ? UNIT_TYPES[k].name.toLowerCase() : UNIT_TYPES[k].plural.toLowerCase()}`)
      .join(', ');
  function select(s: Scenario): void {
    chosen = s;
    for (const c of cards) c.card.classList.toggle('selected', c.s === s);
    clear(detail);
    detail.append(
      h('div', null, h('h3', null, s.name), h('p', null, s.description)),
      h(
        'div',
        { class: 'col' },
        h('div', null, h('h3', null, 'Your army'), h('p', { class: 'small muted' }, `${FACTIONS[s.player.faction].name}: ${armyLine(s.player.army)}`)),
        h('div', null, h('h3', null, 'The enemy'), h('p', { class: 'small muted' }, `${FACTIONS[s.enemy.faction].name}: ${armyLine(s.enemy.army)}`)),
        h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => cb.onChoose(chosen) }, 'Prepare Army')),
      ),
    );
  }
  select(chosen);
  return h(
    'div',
    { class: 'screen shade' },
    h(
      'div',
      { class: 'panel page' },
      h('div', { class: 'page-head' }, h('h2', null, 'Choose a Battle'), h('span', { class: 'spacer' }), h('button', { class: 'btn small ghost', onclick: cb.onBack }, 'Back')),
      h('div', { class: 'scenarios' }, ...cards.map((c) => c.card)),
      detail,
    ),
  );
}

// ---------------------------------------------------------------------------

function bonusText(kind: UnitKind): string {
  const a = UNIT_TYPES[kind].attack;
  const parts: string[] = [];
  const names: Partial<Record<ArmorClass, string>> = {
    cavalry: 'cavalry',
    spearman: 'pikemen',
    archer: 'archers',
    infantry: 'infantry',
    siege: 'siege',
  };
  for (const [cls, v] of Object.entries(a.damage) as [ArmorClass, number][]) {
    if (cls === 'melee' || cls === 'pierce') continue;
    parts.push(`+${v} vs ${names[cls] ?? cls}`);
  }
  return parts.join(', ');
}

function statsLine(kind: UnitKind): HTMLElement {
  const t = UNIT_TYPES[kind];
  const a = t.attack;
  const base = a.damage.melee ?? a.damage.pierce ?? 0;
  const type = a.damage.melee !== undefined ? 'melee' : 'pierce';
  const bonus = bonusText(kind);
  return h(
    'div',
    { class: 'stats' },
    h('span', null, h('b', null, 'HP '), t.hp),
    h('span', null, h('b', null, 'Attack '), `${base} ${type}`, bonus ? ` (${bonus})` : ''),
    h('span', null, h('b', null, 'Armour '), `${t.armor.melee ?? 0}/${t.armor.pierce ?? 0}`),
    a.kind === 'ranged' ? h('span', null, h('b', null, 'Range '), a.range) : null,
    a.splash ? h('span', null, h('b', null, 'Splash')) : null,
    h('span', null, h('b', null, 'Speed '), t.speed),
  );
}

const PRESETS: { name: string; mix: Partial<Record<UnitKind, number>> }[] = [
  { name: 'Balanced', mix: { footman: 3, pikeman: 3, archer: 3, knight: 1.2, catapult: 0.3 } },
  { name: 'Pike Wall', mix: { pikeman: 6, archer: 3, footman: 1, catapult: 0.3 } },
  { name: 'Cavalry Charge', mix: { knight: 3, footman: 1.5, archer: 1.5 } },
  { name: 'Archer Screen', mix: { archer: 6, pikeman: 3, footman: 1.5 } },
  { name: 'Siege Train', mix: { catapult: 1, footman: 3, pikeman: 3, archer: 2 } },
];

function presetArmy(mix: Partial<Record<UnitKind, number>>, budget: number): Army {
  const unit = UNIT_KINDS.reduce((s, k) => s + (mix[k] ?? 0) * COSTS[k], 0);
  const scale = budget / unit;
  const a = Object.fromEntries(UNIT_KINDS.map((k) => [k, Math.floor((mix[k] ?? 0) * scale)])) as Army;
  // Spend leftovers on the cheapest unit in the mix.
  const cheap = [...UNIT_KINDS].filter((k) => mix[k]).sort((x, y) => COSTS[x] - COSTS[y])[0];
  while (cheap && armyCost(a, COSTS) + COSTS[cheap] <= budget) a[cheap]++;
  return a;
}

export function armySetup(scenario: Scenario, cb: { onBack(): void; onStart(cfg: BattleConfig, shape: FormationShape): void }): HTMLElement {
  const state = {
    faction: scenario.player.faction as FactionId,
    enemyFaction: scenario.enemy.faction as FactionId,
    army: { ...scenario.player.army } as Army,
    color: settings.playerColor in TEAM_COLORS ? settings.playerColor : 'blue',
    difficulty: settings.difficulty as Difficulty,
    shape: 'line' as FormationShape,
  };
  const budget = scenario.budget;
  const root = h('div', { class: 'screen shade' });
  const page = h('div', { class: 'panel page' });
  root.append(page);

  const enemyColorName = () => (state.color === 'red' ? 'blue' : settings.enemyColor in TEAM_COLORS && settings.enemyColor !== state.color ? settings.enemyColor : 'red');

  function render(): void {
    clear(page);
    const color = TEAM_COLORS[state.color];
    const cost = armyCost(state.army, COSTS);
    const over = cost > budget;
    const total = UNIT_KINDS.reduce((s, k) => s + state.army[k], 0);

    const unitRows = UNIT_KINDS.map((k) => {
      const t = UNIT_TYPES[k];
      const img = h('img', { class: 'portrait', alt: t.name });
      setPortrait(img, state.faction, k, color);
      const change = (d: number) => {
        state.army[k] = Math.max(0, Math.min(60, state.army[k] + d));
        render();
      };
      return h(
        'div',
        { class: 'unit-row' },
        img,
        h('div', null, h('div', { class: 'unit-name' }, t.name), h('div', { class: 'unit-desc' }, t.blurb), statsLine(k)),
        h(
          'div',
          { class: 'counter' },
          h('button', { title: 'Remove (shift: 5)', onclick: (e: MouseEvent) => change(e.shiftKey ? -5 : -1) }, '−'),
          h('span', { class: 'n' }, state.army[k]),
          h('button', { title: 'Add (shift: 5)', onclick: (e: MouseEvent) => change(e.shiftKey ? 5 : 1) }, '+'),
          h('span', { class: 'cost' }, `${t.cost} pts`),
        ),
      );
    });

    const factionChips = (current: FactionId, set: (f: FactionId) => void) =>
      h(
        'div',
        { class: 'faction-pick' },
        ...(Object.keys(FACTIONS) as FactionId[]).map((f) =>
          h('span', { class: `chip${current === f ? ' on' : ''}`, onclick: () => (set(f), render()) }, FACTIONS[f].name),
        ),
      );

    const swatches = h(
      'div',
      { class: 'row' },
      h('span', { class: 'small muted' }, 'Colour'),
      ...Object.entries(TEAM_COLORS).map(([name, c]) =>
        h('span', {
          class: `swatch${state.color === name ? ' on' : ''}`,
          style: `background:${hex(c)}`,
          title: name,
          onclick: () => {
            state.color = name;
            settings.playerColor = name;
            saveSettings();
            render();
          },
        }),
      ),
    );

    const enemyColor = TEAM_COLORS[enemyColorName()];
    const enemyUnits = h(
      'div',
      { class: 'enemy-list' },
      ...UNIT_KINDS.map((k) => {
        const img = h('img', { class: 'portrait', alt: UNIT_TYPES[k].name });
        setPortrait(img, state.enemyFaction, k, enemyColor);
        return h('div', { class: 'enemy-unit' }, img, h('b', null, scenario.enemy.army[k]), UNIT_TYPES[k].plural);
      }),
    );

    const left = h(
      'div',
      { class: 'panel side' },
      h('div', { class: 'row' }, h('h3', null, 'Your Army'), h('span', { class: 'spacer' }), factionChips(state.faction, (f) => (state.faction = f))),
      swatches,
      h('div', { class: 'units' }, ...unitRows),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'small muted' }, 'Presets'),
        h('button', { class: 'btn small ghost', onclick: () => ((state.army = { ...scenario.player.army }), render()) }, 'Scenario'),
        ...PRESETS.map((p) => h('button', { class: 'btn small ghost', onclick: () => ((state.army = presetArmy(p.mix, budget)), render()) }, p.name)),
      ),
      h(
        'div',
        { class: 'col', style: 'gap:6px' },
        h(
          'div',
          { class: 'row' },
          h('span', null, `${total} soldiers`),
          h('span', { class: 'spacer' }),
          h('span', { style: over ? 'color:var(--bad)' : '' }, `${cost} / ${budget} points`),
        ),
        h('div', { class: `budget${over ? ' over' : ''}` }, h('div', { style: `width:${Math.min(100, (cost / budget) * 100)}%` })),
      ),
    );

    const shapeChips = h(
      'div',
      { class: 'faction-pick' },
      ...(['line', 'staggered', 'box', 'flank'] as FormationShape[]).map((s) =>
        h('span', { class: `chip${state.shape === s ? ' on' : ''}`, onclick: () => ((state.shape = s), render()) }, s[0].toUpperCase() + s.slice(1)),
      ),
    );

    const right = h(
      'div',
      { class: 'col' },
      h(
        'div',
        { class: 'panel side' },
        h('div', { class: 'row' }, h('h3', null, 'The Enemy'), h('span', { class: 'spacer' }), factionChips(state.enemyFaction, (f) => (state.enemyFaction = f))),
        enemyUnits,
        h('div', { class: 'row small muted' }, `Enemy strength: ${armyCost(scenario.enemy.army, COSTS)} points`),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'small muted' }, 'Difficulty'),
          ...(['easy', 'normal', 'hard'] as Difficulty[]).map((d) =>
            h(
              'span',
              {
                class: `chip${state.difficulty === d ? ' on' : ''}`,
                onclick: () => {
                  state.difficulty = d;
                  settings.difficulty = d;
                  saveSettings();
                  render();
                },
              },
              d[0].toUpperCase() + d.slice(1),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'panel side' },
        h('h3', null, 'Who beats whom'),
        h(
          'table',
          { class: 'counter-table' },
          ...UNIT_KINDS.map((k) => h('tr', null, h('td', null, UNIT_TYPES[k].plural), h('td', null, UNIT_TYPES[k].counters))),
        ),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Starting formation'), shapeChips),
      ),
    );

    page.append(
      h('div', { class: 'page-head' }, h('h2', null, scenario.name), h('p', { class: 'muted' }, scenario.tagline), h('span', { class: 'spacer' }), h('button', { class: 'btn small ghost', onclick: cb.onBack }, 'Back')),
      h('div', { class: 'setup' }, left, right),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'spacer' }),
        over ? h('span', { style: 'color:var(--bad)' }, 'Your army is over budget.') : null,
        total === 0 ? h('span', { style: 'color:var(--bad)' }, 'Recruit at least one soldier.') : null,
        h(
          'button',
          {
            class: 'btn primary',
            disabled: over || total === 0,
            onclick: () =>
              cb.onStart(
                {
                  scenario,
                  player: { faction: state.faction, army: { ...state.army }, color },
                  enemy: { faction: state.enemyFaction, army: { ...scenario.enemy.army }, color: enemyColor },
                  difficulty: state.difficulty,
                },
                state.shape,
              ),
          },
          'Begin Battle',
        ),
      ),
    );
  }
  render();
  return root;
}

// ---------------------------------------------------------------------------

const TIPS = [
  'Pikemen deal enormous damage to cavalry. Keep them in front of your archers.',
  'Right-drag on the ground to choose where your front line stands and which way it faces.',
  'A formation marches at the pace of its slowest soldier. Catapults slow everybody down.',
  'Staggered formation spreads your men out, so a catapult stone hits fewer of them.',
  'Knights charging from a distance strike their first blow with great force.',
  'Attack-move (A, then right-click) lets your army fight whatever it meets on the way.',
  'Units hit from the flank or rear take extra damage. Box formation has no exposed rear.',
  'Catapults must unpack before they can fire, and cannot hit enemies standing close.',
  'Footmen cut through pikemen. Archers shred slow infantry. Knights ride down archers.',
];

export function loadingScreen(title: string): { el: HTMLElement; set(f: number, label: string): void } {
  const bar = h('div');
  const label = h('div', { class: 'muted' }, 'Preparing');
  const el = h(
    'div',
    { class: 'screen shade loading' },
    h('h2', null, title),
    h('div', { class: 'bar' }, bar),
    label,
    h('div', { class: 'tip' }, TIPS[Math.floor(Math.random() * TIPS.length)]),
  );
  return {
    el,
    set(f, text) {
      bar.style.width = `${Math.round(f * 100)}%`;
      label.textContent = text;
    },
  };
}

export function helpModal(onClose: () => void): HTMLElement {
  const k = (keys: string, what: string) => [h('div', null, ...keys.split(' ').map((x) => h('kbd', null, x))), h('div', null, what)];
  return h(
    'div',
    { class: 'modal', onclick: (e: MouseEvent) => e.target === e.currentTarget && onClose() },
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'row' }, h('h2', null, 'How to Play'), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: onClose }, 'Close')),
      h(
        'div',
        { class: 'help-grid', style: 'margin-top:14px' },
        h(
          'div',
          null,
          h('h3', null, 'Commanding'),
          h(
            'div',
            { class: 'keys' },
            ...k('Left-click', 'Select a unit; drag a box to select many'),
            ...k('Shift', 'Add to or remove from the selection'),
            ...k('Double-click', 'Select all units of that type on screen'),
            ...k('Right-click', 'Move there, or attack the enemy under the cursor'),
            ...k('Right-drag', 'Move and set the front line: drag along where the front rank should stand'),
            ...k('A', 'Attack-move: then right-click the destination'),
            ...k('S', 'Stop and re-form'),
            ...k('Ctrl+1–9', 'Assign a control group; 1–9 selects it, twice centres on it'),
            ...k('Space', 'Centre on the selection'),
          ),
        ),
        h(
          'div',
          null,
          h('h3', null, 'Formations and stances'),
          h(
            'div',
            { class: 'keys' },
            ...k('Q', 'Line: cavalry in front, then infantry, archers, siege'),
            ...k('W', 'Staggered: double spacing, safer against catapults'),
            ...k('E', 'Box: strong units around weak ones, no exposed rear'),
            ...k('R', 'Flank: two wings with a gap in the middle'),
            ...k('Z', 'Aggressive: chase enemies'),
            ...k('X', 'Defensive: chase a little, then return'),
            ...k('C', 'Stand ground: never leave position'),
            ...k('V', 'No attack: hold fire'),
          ),
        ),
        h(
          'div',
          null,
          h('h3', null, 'Camera'),
          h('div', { class: 'keys' }, ...k('Arrows', 'Scroll (or push the mouse to the screen edge)'), ...k('Middle-drag', 'Pan'), ...k('Wheel', 'Zoom'), ...k('P', 'Pause'), ...k('+ −', 'Game speed'), ...k('Esc', 'Menu')),
        ),
        h(
          'div',
          null,
          h('h3', null, 'Counters'),
          h('table', { class: 'counter-table' }, ...UNIT_KINDS.map((u) => h('tr', null, h('td', null, UNIT_TYPES[u].plural), h('td', null, UNIT_TYPES[u].counters)))),
          h(
            'p',
            { class: 'small muted' },
            'Damage works like Age of Empires II: each attack minus the matching armour, plus bonuses against specific unit classes. ' +
              'Blows to the flank deal 10% more, to the rear 25% more. A knight charging from distance adds a heavy first strike.',
          ),
        ),
      ),
    ),
  );
}

export function settingsModal(onClose: () => void, onChange: () => void): HTMLElement {
  const slider = (label: string, get: () => number, set: (v: number) => void) => {
    const out = h('span', null, `${Math.round(get() * 100)}`);
    const input = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(get() * 100)) });
    input.addEventListener('input', () => {
      set(Number(input.value) / 100);
      out.textContent = input.value;
      saveSettings();
      onChange();
    });
    return h('div', { class: 'slider-row' }, h('span', null, label), input, out);
  };
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = get();
    box.addEventListener('change', () => {
      set(box.checked);
      saveSettings();
      onChange();
    });
    return h('label', { class: 'row', style: 'font-size:17px' }, box, label);
  };
  return h(
    'div',
    { class: 'modal', onclick: (e: MouseEvent) => e.target === e.currentTarget && onClose() },
    h(
      'div',
      { class: 'panel col', style: 'min-width:440px' },
      h('h2', null, 'Settings'),
      slider('Music', () => settings.musicVolume, (v) => (settings.musicVolume = v)),
      slider('Sound effects', () => settings.sfxVolume, (v) => (settings.sfxVolume = v)),
      toggle('Scroll when the mouse touches the screen edge', () => settings.edgeScroll, (v) => (settings.edgeScroll = v)),
      h(
        'div',
        { class: 'row' },
        h('span', { style: 'font-size:17px' }, 'Health bars'),
        ...(['always', 'damaged', 'selected'] as const).map((m) =>
          h(
            'span',
            {
              class: `chip${settings.healthBars === m ? ' on' : ''}`,
              onclick: (e: MouseEvent) => {
                settings.healthBars = m;
                saveSettings();
                onChange();
                const row = (e.currentTarget as HTMLElement).parentElement!;
                row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
              },
            },
            m[0].toUpperCase() + m.slice(1),
          ),
        ),
      ),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: onClose }, 'Done')),
    ),
  );
}

export function creditsModal(onClose: () => void): HTMLElement {
  return h(
    'div',
    { class: 'modal', onclick: (e: MouseEvent) => e.target === e.currentTarget && onClose() },
    h(
      'div',
      { class: 'panel col', style: 'max-width:640px' },
      h('h2', null, 'Credits'),
      h(
        'p',
        { style: 'font-size:17px;line-height:1.4' },
        'Units, scenery, terrain textures and sounds come from ',
        h('b', null, '0 A.D.'),
        ' by Wildfire Games, licensed CC-BY-SA 3.0. The sprites were rendered from its 3D models and animations for this game; ' +
          'the derived art keeps the same license. See ',
        h('code', null, 'public/assets/CREDITS.md'),
        '.',
      ),
      h(
        'p',
        { style: 'font-size:17px;line-height:1.4' },
        'Formation behaviour follows Age of Empires II as reverse-engineered by the openage project, Dave Pottinger’s ' +
          '“Coordinated Unit Movement” articles, and 0 A.D.’s formation code. Details in docs/FORMATIONS.md.',
      ),
      h('p', { style: 'font-size:17px' }, 'Fonts: Cinzel and EB Garamond (SIL Open Font License).'),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: onClose }, 'Close')),
    ),
  );
}
