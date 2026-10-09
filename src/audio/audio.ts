// Sound: music with cross-fades, positional battle effects and unit voices.
// All sounds are from 0 A.D. (CC-BY-SA 3.0, Wildfire Games); see tools/audio/export.py.

import { settings } from '../settings';
import type { GameEvent } from '../sim/world';
import type { Unit } from '../sim/unit';
import type { Battle } from '../game/battle';

const BASE = `${import.meta.env.BASE_URL}assets/audio/`;

type MusicName = 'menu' | 'battle' | 'victory' | 'defeat' | null;

class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private music: { name: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private ambient: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wantedMusic: MusicName = null;
  private lastPlayed = new Map<string, number>();
  private lastVoice = 0;
  private battleTrack = 0;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.applyVolumes();
    return this.ctx;
  }

  /** Call from a user gesture. */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    if (this.wantedMusic && !this.music) this.playMusic(this.wantedMusic);
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    this.musicBus.gain.value = settings.musicVolume * 0.6;
    this.sfxBus.gain.value = settings.sfxVolume;
  }

  private load(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      const ctx = this.ensure();
      p = ctx
        ? fetch(BASE + path)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
            .then((b) => ctx.decodeAudioData(b))
            .catch(() => null)
        : Promise.resolve(null);
      this.buffers.set(path, p);
    }
    return p;
  }

  // ---------------------------------------------------------------------------
  // Music

  playMusic(name: MusicName): void {
    this.wantedMusic = name;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;
    const fadeOut = (m: { src: AudioBufferSourceNode; gain: GainNode } | null, secs: number) => {
      if (!m) return;
      const t = ctx.currentTime;
      m.gain.gain.cancelScheduledValues(t);
      m.gain.gain.setValueAtTime(m.gain.gain.value, t);
      m.gain.gain.linearRampToValueAtTime(0, t + secs);
      m.src.stop(t + secs + 0.05);
    };
    if (name === null) {
      fadeOut(this.music, 1.2);
      this.music = null;
      fadeOut(this.ambient, 1.2);
      this.ambient = null;
      return;
    }
    if (name === 'victory' || name === 'defeat') {
      fadeOut(this.music, 1.5);
      this.music = null;
      this.sfx(name, 1);
      return;
    }
    let track = 'menu';
    if (name === 'battle') {
      this.battleTrack = (this.battleTrack % 2) + 1;
      track = `battle_${this.battleTrack}`;
    }
    if (this.music?.name === track) return;
    fadeOut(this.music, 2);
    this.music = null;
    this.load(`music/${track}.ogg`).then((buf) => {
      if (!buf || this.wantedMusic !== name) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = name === 'menu';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 2.5);
      src.connect(gain).connect(this.musicBus);
      src.start();
      const entry = { name: track, src, gain };
      this.music = entry;
      if (name === 'battle') {
        // Alternate battle tracks.
        src.onended = () => {
          if (this.music === entry && this.wantedMusic === 'battle') {
            this.music = null;
            this.playMusic('battle');
          }
        };
      }
    });
    if (name === 'battle' && !this.ambient) {
      this.load('music/ambient_day.ogg').then((buf) => {
        if (!buf || this.wantedMusic !== 'battle' || this.ambient) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 3);
        src.connect(gain).connect(this.sfxBus);
        src.start();
        this.ambient = { src, gain };
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Effects

  /** Plays an effect; `pan` in [-1, 1]. Rate-limited per sound family. */
  sfx(name: string, volume = 1, pan = 0, minGap = 0): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || volume <= 0.01) return;
    const family = name.replace(/_\d+$/, '');
    const now = ctx.currentTime;
    if (minGap > 0) {
      const last = this.lastPlayed.get(family) ?? -1;
      if (now - last < minGap) return;
      this.lastPlayed.set(family, now);
    }
    this.load(`sfx/${name}.ogg`).then((buf) => {
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.94 + Math.random() * 0.12;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(gain).connect(panner).connect(this.sfxBus);
      src.start();
    });
  }

  private pick(prefix: string, n: number): string {
    return `${prefix}_${1 + Math.floor(Math.random() * n)}`;
  }

  horn(): void {
    this.sfx('horn', 0.8);
  }

  /** Battle events -> positional sounds. */
  onEvents(events: GameEvent[], battle: Battle): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const cam = battle.renderer.camera;
    const place = (x: number, y: number): { vol: number; pan: number } => {
      const s = cam.worldToScreen(x, y);
      const dx = (s.x - cam.viewW / 2) / (cam.viewW / 2);
      const dy = (s.y - cam.viewH / 2) / (cam.viewH / 2);
      const d = Math.hypot(dx, dy * 1.2);
      const zoomFactor = Math.min(1.2, 0.55 + cam.zoom * 0.5);
      const vol = Math.max(0, 1 - Math.max(0, d - 0.6) / 1.4) * zoomFactor;
      return { vol, pan: dx * 0.7 };
    };
    for (const e of events) {
      switch (e.type) {
        case 'hit': {
          if (!e.melee || !e.by) break;
          const p = place(e.unit.pos.x, e.unit.pos.y);
          const spear = e.by.kind === 'pikeman' || e.by.kind === 'knight';
          this.sfx(spear ? this.pick('spear', 4) : this.pick('sword', 6), 0.45 * p.vol, p.pan, 0.07);
          break;
        }
        case 'shoot': {
          const p = place(e.unit.pos.x, e.unit.pos.y);
          if (e.projectile.kind === 'stone') this.sfx('catapult_fire', 0.9 * p.vol, p.pan);
          else this.sfx(this.pick('bow', 4), 0.22 * p.vol, p.pan, 0.06);
          break;
        }
        case 'impact': {
          const p = place(e.pos.x, e.pos.y);
          if (e.kind === 'stone') this.sfx('catapult_impact', 0.8 * p.vol, p.pan);
          else if (e.hit) this.sfx(this.pick('arrow_hit', 3), 0.3 * p.vol, p.pan, 0.06);
          else this.sfx(this.pick('arrow_miss', 3), 0.18 * p.vol, p.pan, 0.09);
          break;
        }
        case 'death': {
          const p = place(e.unit.pos.x, e.unit.pos.y);
          if (e.unit.kind === 'knight') this.sfx(this.pick('horse_death', 2), 0.55 * p.vol, p.pan, 0.25);
          if (e.unit.kind !== 'catapult') this.sfx(this.pick('death', 8), 0.5 * p.vol, p.pan, 0.12);
          break;
        }
        case 'charge': {
          const p = place(e.unit.pos.x, e.unit.pos.y);
          this.sfx(this.pick('gallop', 2), 0.6 * p.vol, p.pan, 0.2);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Voices

  private voice(units: Unit[], what: 'select' | 'move' | 'attack' | 'regroup', faction: string): void {
    const ctx = this.ctx;
    if (!ctx || !units.length) return;
    if (ctx.currentTime - this.lastVoice < 0.7) return;
    this.lastVoice = ctx.currentTime;
    if (units.every((u) => u.kind === 'catapult')) {
      this.sfx('siege_select', 0.7);
      return;
    }
    const lang = faction === 'rome' ? 'latin' : 'greek';
    const counts: Record<string, Record<string, number>> = {
      latin: { select: 3, move: 2, attack: 3, regroup: 1 },
      greek: { select: 1, move: 2, attack: 1, regroup: 0 },
    };
    let kind = what;
    if (!counts[lang][kind]) kind = 'move';
    this.sfx(this.pick(`${lang}_${kind}`, counts[lang][kind]), 0.75);
  }

  select(units: Unit[], faction: string): void {
    this.voice(units, 'select', faction);
  }

  command(kind: string, units: Unit[], faction = 'rome'): void {
    if (kind === 'move') this.voice(units, 'move', faction);
    else if (kind === 'attack' || kind === 'attackMove') this.voice(units, 'attack', faction);
    else if (kind === 'shape') this.voice(units, 'regroup', faction);
  }
}

export const audio = new AudioManager();
