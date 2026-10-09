// Application flow: title screen (over a live AI-vs-AI battle), scenario and
// army selection, loading, the battle itself and the results.

import type { Application } from 'pixi.js';
import { Battle, TEAM_COLORS, type BattleConfig } from './game/battle';
import type { InputCallbacks } from './game/input';
import { SCENARIOS, type Army, type Scenario } from './scenarios/scenarios';
import { armySetup, creditsModal, helpModal, loadingScreen, mainMenu, scenarioSelect, settingsModal } from './ui/screens';
import { Hud } from './ui/hud';
import { clear, h } from './ui/dom';
import type { FormationShape } from './sim/formationLayout';
import { settings } from './settings';
import { audio } from './audio/audio';

const noopCallbacks: InputCallbacks = {
  onSelectionChanged() {},
  onCommand() {},
  onPauseToggle() {},
  onSpeedChange() {},
  onEscape() {},
  isPaused: () => false,
};

export class App {
  private battle: Battle | null = null;
  private attract: Battle | null = null;
  private hud: Hud | null = null;
  private screen: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private last: { config: BattleConfig; shape: FormationShape } | null = null;
  private attractBusy = false;

  constructor(
    readonly app: Application,
    readonly ui: HTMLElement,
  ) {
    window.addEventListener('resize', () => {
      const w = app.screen.width;
      const hgt = app.screen.height;
      this.battle?.renderer.resize(w, hgt);
      this.attract?.renderer.resize(w, hgt);
    });
    // Unlock audio on the first interaction (browser autoplay rules).
    const unlock = () => {
      audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  // ---------------------------------------------------------------------------
  // Screens

  private show(el: HTMLElement): void {
    this.screen?.remove();
    this.screen = el;
    this.ui.append(el);
  }

  private showOverlay(el: HTMLElement): void {
    this.overlay?.remove();
    this.overlay = el;
    this.ui.append(el);
  }

  private closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  async mainMenu(): Promise<void> {
    this.endBattle();
    audio.playMusic('menu');
    this.show(
      mainMenu({
        onPlay: () => this.scenarioSelect(),
        onQuick: () => this.quickBattle(),
        onHelp: () => this.showOverlay(helpModal(() => this.closeOverlay())),
        onSettings: () => this.showOverlay(settingsModal(() => this.closeOverlay(), () => audio.applyVolumes())),
        onCredits: () => this.showOverlay(creditsModal(() => this.closeOverlay())),
      }),
    );
    this.ensureAttract();
  }

  private scenarioSelect(): void {
    this.show(
      scenarioSelect({
        onBack: () => this.mainMenu(),
        onChoose: (s) => this.armySetup(s),
      }),
    );
  }

  private armySetup(s: Scenario): void {
    this.show(
      armySetup(s, {
        onBack: () => this.scenarioSelect(),
        onStart: (cfg, shape) => this.startBattle(cfg, shape),
      }),
    );
  }

  private quickBattle(): void {
    const s = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    const player = TEAM_COLORS[settings.playerColor] ?? TEAM_COLORS.blue;
    const enemy = settings.playerColor === 'red' ? TEAM_COLORS.blue : TEAM_COLORS.red;
    this.startBattle(
      {
        scenario: s,
        player: { faction: s.player.faction, army: { ...s.player.army }, color: player },
        enemy: { faction: s.enemy.faction, army: { ...s.enemy.army }, color: enemy },
        difficulty: settings.difficulty,
      },
      'line',
    );
  }

  // ---------------------------------------------------------------------------
  // Background battle behind the menus

  private async ensureAttract(): Promise<void> {
    if (this.attract || this.attractBusy || this.battle) return;
    this.attractBusy = true;
    try {
      const s = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
      const scale = (a: Army): Army => ({
        footman: Math.ceil(a.footman * 0.7),
        pikeman: Math.ceil(a.pikeman * 0.7),
        archer: Math.ceil(a.archer * 0.7),
        knight: Math.ceil(a.knight * 0.7),
        catapult: Math.min(1, a.catapult),
      });
      const cfg: BattleConfig = {
        scenario: { ...s, map: { ...s.map, spawnDistance: 120 } },
        player: { faction: s.player.faction, army: scale(s.player.army), color: TEAM_COLORS.blue },
        enemy: { faction: s.enemy.faction, army: scale(s.enemy.army), color: TEAM_COLORS.red },
        difficulty: 'normal',
      };
      const b = await Battle.create(this.app, cfg, noopCallbacks, undefined, { spectator: true });
      if (this.battle || !this.screen) {
        return;
      }
      this.attract = b;
      b.renderer.camera.zoom = 0.95;
      b.start();
      b.onFrame = (dt) => {
        // Drift the camera over the action.
        const alive = b.world.units.filter((u) => u.alive);
        if (alive.length) {
          const c = alive.reduce((a, u) => ({ x: a.x + u.pos.x / alive.length, y: a.y + u.pos.y / alive.length }), { x: 0, y: 0 });
          const cam = b.renderer.camera;
          const k = Math.min(1, dt * 0.4);
          cam.focus.x += (c.x + 10 - cam.focus.x) * k;
          cam.focus.y += (c.y - 25 - cam.focus.y) * k;
        }
      };
      b.onEnd = () => {
        if (this.attract === b) {
          this.stopAttract();
          if (!this.battle) this.ensureAttract();
        }
      };
    } finally {
      this.attractBusy = false;
    }
  }

  private stopAttract(): void {
    if (!this.attract) return;
    this.attract.destroy();
    this.attract = null;
  }

  // ---------------------------------------------------------------------------
  // Battle

  async startBattle(config: BattleConfig, shape: FormationShape): Promise<void> {
    this.last = { config, shape };
    this.stopAttract();
    this.endBattle();
    const loading = loadingScreen(config.scenario.name);
    this.show(loading.el);
    audio.playMusic(null);
    const callbacks: InputCallbacks = {
      onSelectionChanged: () => {
        this.hud?.markSelectionDirty();
        const own = this.battle?.input.own ?? [];
        if (own.length) audio.select(own, config.player.faction);
      },
      onCommand: (kind) => {
        this.hud?.markSelectionDirty();
        audio.command(kind, this.battle?.input.own ?? [], config.player.faction);
      },
      onPauseToggle: () => this.hud?.togglePause(),
      onSpeedChange: (d) => this.hud?.changeSpeed(d),
      onEscape: () => {
        if (!this.hud) return;
        if (this.overlay) this.closeOverlay();
        else if (this.hud.modalOpen) {
          this.hud.closeModal();
          if (this.battle?.paused && !this.battle.ended) this.hud.togglePause();
        } else this.hud.showPause();
      },
      isPaused: () => !!this.battle?.paused,
    };
    const battle = await Battle.create(this.app, config, callbacks, (f, label) => loading.set(f, label), { shape });
    this.battle = battle;
    this.screen?.remove();
    this.screen = null;
    const hud = new Hud(battle, {
      onResume: () => {},
      onRestart: () => this.last && this.startBattle(this.last.config, this.last.shape),
      onQuit: () => this.mainMenu(),
      onChangeArmy: () => {
        const s = config.scenario;
        this.endBattle();
        this.ensureAttract();
        this.armySetup(s);
      },
      onHelp: () => this.showOverlay(helpModal(() => this.closeOverlay())),
      onSettings: () => this.showOverlay(settingsModal(() => this.closeOverlay(), () => audio.applyVolumes())),
    });
    this.hud = hud;
    this.ui.append(hud.el);
    battle.onFrame = (dt) => hud.update(dt);
    battle.onWorldEvents = (events) => audio.onEvents(events, battle);
    battle.onEnd = (r) => {
      audio.playMusic(r.winner === 0 ? 'victory' : 'defeat');
      hud.showResults(r);
    };
    battle.start();
    audio.playMusic('battle');
    audio.horn();
    hud.toast('Drag to select your army, right-click to move. Help lists every control.');
    if (!settings.seenTutorial) {
      settings.seenTutorial = true;
    }
  }

  private endBattle(): void {
    if (this.battle) {
      this.battle.destroy();
      this.battle = null;
    }
    if (this.hud) {
      this.hud.destroy();
      this.hud = null;
    }
    this.closeOverlay();
  }

  clearUi(): void {
    clear(this.ui);
    this.ui.append(h('div'));
  }
}
