// In-battle interface.

import { h, clear, svg, append } from './dom';
import { ICONS, type IconName } from './icons';
import { setPortrait } from './portraits';
import type { Battle, BattleResult } from '../game/battle';
import { Minimap } from '../render/minimap';
import { UNIT_KINDS, UNIT_TYPES, type UnitKind } from '../sim/unitTypes';
import type { Unit } from '../sim/unit';
import type { FormationShape } from '../sim/formationLayout';

const hex = (c: [number, number, number]) => `rgb(${c.join(',')})`;

const SHAPES: { shape: FormationShape; icon: IconName; key: string; name: string; tip: string }[] = [
  { shape: 'line', icon: 'line', key: 'Q', name: 'Line', tip: 'Cavalry in front, then infantry, archers and siege. Wider than deep.' },
  { shape: 'staggered', icon: 'staggered', key: 'W', name: 'Staggered', tip: 'Like line with double spacing. Catapult stones hit fewer men.' },
  { shape: 'box', icon: 'box', key: 'E', name: 'Box', tip: 'Strong units form a square around archers and siege. No exposed rear.' },
  { shape: 'flank', icon: 'flank', key: 'R', name: 'Flank', tip: 'Splits the line into two wings with a gap in the middle.' },
];
const STANCES: { stance: Unit['stance']; icon: IconName; key: string; name: string; tip: string }[] = [
  { stance: 'aggressive', icon: 'aggressive', key: 'Z', name: 'Aggressive', tip: 'Attack enemies in sight and chase them.' },
  { stance: 'defensive', icon: 'defensive', key: 'X', name: 'Defensive', tip: 'Attack nearby enemies, chase only a short way, then return.' },
  { stance: 'standGround', icon: 'standGround', key: 'C', name: 'Stand Ground', tip: 'Never move; strike only what comes into reach.' },
  { stance: 'noAttack', icon: 'noAttack', key: 'V', name: 'No Attack', tip: 'Hold fire. Useful to slip past the enemy.' },
];

export interface HudCallbacks {
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onChangeArmy(): void;
  onHelp(): void;
  onSettings(): void;
}

export class Hud {
  readonly el = h('div', { class: 'hud' });
  private clock = h('span', { class: 'clock' }, '0:00');
  private bars = h('div', { class: 'bar' });
  private counts: [HTMLElement, HTMLElement] = [h('span', { class: 'count' }), h('span', { class: 'count' })];
  private selPanel = h('div', { class: 'sel-panel' });
  private cmdCard = h('div', { class: 'cmd-card' });
  private minimap: Minimap;
  private tooltip = h('div', { class: 'tooltip', style: 'display:none' });
  private boxEl = h('div', { class: 'select-box', style: 'display:none' });
  private toastEl = h('div', { class: 'toast', style: 'opacity:0' });
  private amHint = h('div', { class: 'am-hint', style: 'display:none' }, 'ATTACK-MOVE: right-click the destination');
  private pauseBtn: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private modal: HTMLElement | null = null;
  private cmdButtons = new Map<string, HTMLButtonElement>();
  private selDirty = true;
  private slowTimer = 0;
  private toastTimer = 0;
  private startHp: [number, number];

  constructor(
    private battle: Battle,
    private cb: HudCallbacks,
  ) {
    const cfg = battle.config;
    const colors = [hex(cfg.player.color), hex(cfg.enemy.color)];
    this.minimap = new Minimap(battle.map, 216, 160, colors);
    this.startHp = [0, 1].map((t) => battle.world.units.filter((u) => u.team === t).reduce((s, u) => s + u.type.hp, 0)) as [number, number];
    this.counts[0].style.color = colors[0];
    this.counts[1].style.color = colors[1];

    this.pauseBtn = h('button', { class: 'hud-btn', onclick: () => this.togglePause() }, 'Pause');
    const speeds = [1, 1.5, 2.5];
    this.speedBtns = speeds.map((s) =>
      h(
        'button',
        {
          class: `hud-btn${battle.speed === s ? ' on' : ''}`,
          onclick: () => this.setSpeed(s),
          title: 'Game speed (+ / −)',
        },
        `${s}×`,
      ),
    );
    const top = h(
      'div',
      { class: 'hud-top' },
      h('span', { class: 'title' }, cfg.scenario.name),
      this.clock,
      h('div', { class: 'strength' }, this.counts[0], this.bars, this.counts[1]),
      ...this.speedBtns,
      this.pauseBtn,
      h('button', { class: 'hud-btn', onclick: () => cb.onHelp() }, 'Help'),
      h('button', { class: 'hud-btn', onclick: () => this.showPause() }, 'Menu'),
    );

    const mmWrap = h('div', { class: 'minimap-wrap' }, this.minimap.canvas);
    let dragging = false;
    const mmMove = (e: MouseEvent) => battle.renderer.camera.centerOn(this.minimap.eventToWorld(e));
    this.minimap.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        dragging = true;
        mmMove(e);
      } else if (e.button === 2) {
        const p = this.minimap.eventToWorld(e);
        const own = battle.input.own;
        if (own.length) {
          battle.world.commandMove(own, p, { attackMove: battle.input.attackMoveArmed });
          battle.renderer.addMarker(p.x, p.y, battle.input.attackMoveArmed);
          battle.input.attackMoveArmed = false;
        }
      }
    });
    this.minimap.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => dragging && mmMove(e));
    window.addEventListener('pointerup', () => (dragging = false));

    this.buildCommandCard();
    this.el.append(top, h('div', { class: 'hud-bottom' }, mmWrap, this.selPanel, this.cmdCard), this.boxEl, this.toastEl, this.amHint, this.tooltip);
    this.refreshSelection();
  }

  // ---------------------------------------------------------------------------

  private cmd(icon: IconName, key: string, name: string, tip: string, action: () => void): HTMLButtonElement {
    const b = h('button', { class: 'cmd', onclick: action }, svg(ICONS[icon]), h('span', { class: 'key' }, key));
    b.addEventListener('pointerenter', () => this.showTip(b, name, tip, key));
    b.addEventListener('pointerleave', () => (this.tooltip.style.display = 'none'));
    this.cmdButtons.set(icon, b);
    return b;
  }

  private buildCommandCard(): void {
    const input = this.battle.input;
    this.cmdCard.append(
      h(
        'div',
        { class: 'cmd-row' },
        h('span', { class: 'label' }, 'FORMATION'),
        ...SHAPES.map((s) => this.cmd(s.icon, s.key, s.name, s.tip, () => input.setShape(s.shape))),
      ),
      h(
        'div',
        { class: 'cmd-row' },
        h('span', { class: 'label' }, 'STANCE'),
        ...STANCES.map((s) => this.cmd(s.icon, s.key, s.name, s.tip, () => input.setStance(s.stance))),
      ),
      h(
        'div',
        { class: 'cmd-row' },
        h('span', { class: 'label' }, 'ORDERS'),
        this.cmd('attackMove', 'A', 'Attack-move', 'March to a point and fight anything met on the way. Press, then right-click.', () => input.armAttackMove()),
        this.cmd('stop', 'S', 'Stop', 'Halt and re-form where you stand.', () => input.stop()),
        this.cmd('regroup', 'G', 'Regroup', 'Gather the selected units into one formation here.', () => input.regroup()),
      ),
    );
  }

  private showTip(anchor: HTMLElement, name: string, text: string, key: string): void {
    clear(this.tooltip);
    this.tooltip.append(h('b', null, name), ' ', h('kbd', null, key), h('div', null, text));
    this.tooltip.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    const tw = 260;
    this.tooltip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2))}px`;
    this.tooltip.style.width = `${tw}px`;
    this.tooltip.style.top = `${r.top - 10}px`;
    this.tooltip.style.transform = 'translateY(-100%)';
  }

  private setSpeed(s: number): void {
    this.battle.speed = s;
    const speeds = [1, 1.5, 2.5];
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', speeds[i] === s));
  }

  changeSpeed(delta: number): void {
    const speeds = [1, 1.5, 2.5];
    const i = Math.max(0, Math.min(speeds.length - 1, speeds.indexOf(this.battle.speed) + delta));
    this.setSpeed(speeds[i] ?? 1);
    this.toast(`Speed ${speeds[i]}×`);
  }

  togglePause(): void {
    this.battle.paused = !this.battle.paused;
    this.pauseBtn.classList.toggle('on', this.battle.paused);
    this.pauseBtn.textContent = this.battle.paused ? 'Resume' : 'Pause';
    if (this.battle.paused) this.toast('Paused');
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    this.toastTimer = 1.6;
  }

  markSelectionDirty(): void {
    this.selDirty = true;
  }

  // ---------------------------------------------------------------------------

  private refreshSelection(): void {
    this.selDirty = false;
    clear(this.selPanel);
    const input = this.battle.input;
    const sel = input.selection.filter((u) => u.alive);
    const cfg = this.battle.config;
    if (!sel.length) {
      this.selPanel.append(
        h('span', { class: 'sel-empty' }, 'Drag a box around your soldiers to select them. Right-click to move, right-drag to set the front line.'),
      );
    } else {
      const byKind = new Map<UnitKind, Unit[]>();
      for (const u of sel) {
        const list = byKind.get(u.kind) ?? [];
        list.push(u);
        byKind.set(u.kind, list);
      }
      for (const k of UNIT_KINDS) {
        const list = byKind.get(k);
        if (!list) continue;
        const team = list[0].team;
        const faction = team === 0 ? cfg.player.faction : cfg.enemy.faction;
        const color = team === 0 ? cfg.player.color : cfg.enemy.color;
        const img = h('img', { alt: UNIT_TYPES[k].name });
        setPortrait(img, faction, k, color);
        const hp = list.reduce((s, u) => s + u.hp, 0) / (list.length * UNIT_TYPES[k].hp);
        const bar = h('div', { style: `width:${hp * 100}%;background:${hp > 0.6 ? 'var(--good)' : hp > 0.3 ? '#e6c229' : 'var(--bad)'}` });
        this.selPanel.append(
          h(
            'div',
            {
              class: 'sel-group',
              title: 'Click: select only these. Shift-click: deselect them.',
              onclick: (e: MouseEvent) => input.setSelection(e.shiftKey ? sel.filter((u) => u.kind !== k) : list),
            },
            img,
            h('span', { class: 'n' }, list.length),
            h('span', { class: 'lbl' }, list.length === 1 ? UNIT_TYPES[k].name : UNIT_TYPES[k].plural),
            h('div', { class: 'hp' }, bar),
          ),
        );
      }
      const own = sel.filter((u) => u.team === 0);
      const f = own[0]?.formation;
      const stance = own[0]?.stance;
      const info = h('div', { class: 'sel-info' });
      if (sel.length === 1) {
        const u = sel[0];
        info.append(
          h('span', { class: 'name' }, UNIT_TYPES[u.kind].name, u.team === 1 ? ' (enemy)' : ''),
          h('span', { class: 'line' }, `HP ${Math.ceil(u.hp)} / ${u.type.hp}  ·  Kills ${u.kills}`),
          h('span', { class: 'line' }, UNIT_TYPES[u.kind].counters),
        );
      } else {
        append(info, [
          h('span', { class: 'name' }, `${sel.length} soldiers`),
          own.length && f ? h('span', { class: 'line' }, `Formation: ${SHAPES.find((s) => s.shape === f.shape)?.name ?? f.shape}`) : null,
          own.length && stance ? h('span', { class: 'line' }, `Stance: ${STANCES.find((s) => s.stance === stance)?.name}`) : null,
        ]);
      }
      this.selPanel.append(info);
    }
    this.refreshCommandStates();
  }

  private refreshCommandStates(): void {
    const own = this.battle.input.own;
    const f = own[0]?.formation;
    const sameFormation = own.length > 1 && own.every((u) => u.formation === f);
    for (const s of SHAPES) {
      const b = this.cmdButtons.get(s.icon)!;
      b.classList.toggle('on', !!f && sameFormation && f.shape === s.shape);
      b.disabled = own.length < 2;
    }
    const stances = new Set(own.map((u) => u.stance));
    for (const s of STANCES) {
      const b = this.cmdButtons.get(s.icon)!;
      b.classList.toggle('on', stances.size === 1 && stances.has(s.stance));
      b.disabled = !own.length;
    }
    for (const k of ['attackMove', 'stop'] as IconName[]) this.cmdButtons.get(k)!.disabled = !own.length;
    this.cmdButtons.get('regroup')!.disabled = own.length < 2;
  }

  update(dt: number): void {
    const b = this.battle;
    const box = b.input.box;
    if (box) {
      Object.assign(this.boxEl.style, {
        display: 'block',
        left: `${Math.min(box.x0, box.x1)}px`,
        top: `${Math.min(box.y0, box.y1)}px`,
        width: `${Math.abs(box.x1 - box.x0)}px`,
        height: `${Math.abs(box.y1 - box.y0)}px`,
      });
    } else {
      this.boxEl.style.display = 'none';
    }
    this.amHint.style.display = b.input.attackMoveArmed ? 'block' : 'none';
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.style.opacity = '0';
    }
    this.slowTimer -= dt;
    if (this.slowTimer > 0 && !this.selDirty) return;
    this.slowTimer = 0.12;

    const t = Math.floor(b.world.time);
    this.clock.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const hp = [0, 1].map((team) => b.world.units.filter((u) => u.alive && u.team === team).reduce((s, u) => s + u.hp, 0));
    const n = [0, 1].map((team) => b.world.units.filter((u) => u.alive && u.team === team).length);
    const total = hp[0] + hp[1] || 1;
    clear(this.bars);
    const cfg = b.config;
    this.bars.append(
      h('div', { style: `width:${(hp[0] / total) * 100}%;background:linear-gradient(180deg, ${hex(cfg.player.color)}, rgba(0,0,0,0.35)), ${hex(cfg.player.color)}` }),
      h('div', { style: `width:${(hp[1] / total) * 100}%;background:linear-gradient(180deg, ${hex(cfg.enemy.color)}, rgba(0,0,0,0.35)), ${hex(cfg.enemy.color)}` }),
    );
    this.bars.title = `Strength: ${Math.round((hp[0] / this.startHp[0]) * 100)}% vs ${Math.round((hp[1] / this.startHp[1]) * 100)}%`;
    this.counts[0].textContent = String(n[0]);
    this.counts[1].textContent = String(n[1]);

    this.minimap.draw(b.world, b.renderer.camera, new Set(b.input.selection.map((u) => u.id)));
    if (this.selDirty) this.refreshSelection();
    else this.refreshCommandStates();
  }

  // ---------------------------------------------------------------------------
  // Modals

  closeModal(): void {
    this.modal?.remove();
    this.modal = null;
  }

  get modalOpen(): boolean {
    return !!this.modal;
  }

  openModal(el: HTMLElement): void {
    this.closeModal();
    this.modal = el;
    this.el.append(el);
  }

  showPause(): void {
    if (!this.battle.paused) this.togglePause();
    const resume = () => {
      this.closeModal();
      if (this.battle.paused) this.togglePause();
      this.cb.onResume();
    };
    this.openModal(
      h(
        'div',
        { class: 'modal' },
        h(
          'div',
          { class: 'panel col', style: 'align-items:center;min-width:340px' },
          h('h2', null, 'Paused'),
          h('button', { class: 'btn primary', onclick: resume }, 'Resume'),
          h('button', { class: 'btn', onclick: () => this.cb.onRestart() }, 'Restart Battle'),
          h('button', { class: 'btn', onclick: () => this.cb.onHelp() }, 'How to Play'),
          h('button', { class: 'btn', onclick: () => this.cb.onSettings() }, 'Settings'),
          h('button', { class: 'btn', onclick: () => this.cb.onQuit() }, 'Quit to Menu'),
        ),
      ),
    );
  }

  showResults(r: BattleResult): void {
    const won = r.winner === 0;
    const t = Math.floor(r.time);
    const rows = UNIT_KINDS.map((k) => {
      const mine = r.stats.find((s) => s.team === 0 && s.kind === k);
      const theirs = r.stats.find((s) => s.team === 1 && s.kind === k);
      if (!mine && !theirs) return null;
      const cell = (s?: { start: number; alive: number }) => (s ? `${s.alive} / ${s.start}` : '—');
      return h('tr', null, h('td', null, UNIT_TYPES[k].plural), h('td', null, cell(mine)), h('td', null, cell(theirs)));
    });
    this.openModal(
      h(
        'div',
        { class: 'modal' },
        h(
          'div',
          { class: 'panel col', style: 'align-items:center;min-width:460px' },
          h('h1', { class: `banner ${won ? 'victory' : 'defeat'}` }, won ? 'VICTORY' : 'DEFEAT'),
          h(
            'p',
            { class: 'muted', style: 'font-size:18px;margin:6px 0 0;text-align:center' },
            won ? 'The enemy army is broken. The field is yours.' : 'Your army has been destroyed.',
            ` Battle time ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}.`,
          ),
          h(
            'table',
            { class: 'results' },
            h('tr', null, h('th', null, ''), h('th', null, 'Your survivors'), h('th', null, 'Enemy survivors')),
            ...rows,
            h('tr', null, h('td', null, 'Kills'), h('td', null, r.kills[0]), h('td', null, r.kills[1])),
          ),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn primary', onclick: () => this.cb.onRestart() }, 'Fight Again'),
            h('button', { class: 'btn', onclick: () => this.cb.onChangeArmy() }, 'Change Army'),
            h('button', { class: 'btn', onclick: () => this.cb.onQuit() }, 'Main Menu'),
          ),
        ),
      ),
    );
  }

  destroy(): void {
    this.el.remove();
  }
}
