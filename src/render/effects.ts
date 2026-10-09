// Lightweight particle effects and ground decals drawn with pooled sprites.

import { Container, Sprite, Texture } from 'pixi.js';
import { toScreenX, toScreenY } from './iso';

interface Particle {
  sprite: Sprite;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  alpha0: number;
  gravity: number;
}

interface Decal {
  sprite: Sprite;
  life: number;
  maxLife: number;
  alpha0: number;
}

function softDot(size = 32): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(c);
}

function hardDot(size = 16): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(c);
}

export class Effects {
  readonly particles: Particle[] = [];
  readonly decals: Decal[] = [];
  private pool: Sprite[] = [];
  private soft = softDot();
  private hard = hardDot();

  constructor(
    readonly layer: Container,
    readonly decalLayer: Container,
  ) {}

  private take(soft: boolean): Sprite {
    const s = this.pool.pop() ?? new Sprite();
    s.texture = soft ? this.soft : this.hard;
    s.anchor.set(0.5);
    s.visible = true;
    s.alpha = 1;
    return s;
  }

  private emit(p: Omit<Particle, 'sprite'>, color: number, soft = true): void {
    const sprite = this.take(soft);
    sprite.tint = color;
    this.layer.addChild(sprite);
    this.particles.push({ sprite, ...p });
  }

  /** Dust kicked up by hooves, wheels or landing stones. */
  dust(x: number, y: number, amount = 1, color = 0xa08c6a): void {
    for (let i = 0; i < 3 * amount; i++) {
      const life = 0.6 + Math.random() * 0.6;
      this.emit(
        {
          x: x + (Math.random() - 0.5) * 1.5,
          y: y + (Math.random() - 0.5) * 1.5,
          z: 0.2,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          vz: 0.6 + Math.random() * 0.8,
          life,
          maxLife: life,
          size0: 10 + Math.random() * 6,
          size1: 26 + Math.random() * 12,
          alpha0: 0.35,
          gravity: 0,
        },
        color,
      );
    }
  }

  /** Blood spray on a melee hit (kept small). */
  blood(x: number, y: number, z: number): void {
    for (let i = 0; i < 4; i++) {
      const life = 0.35 + Math.random() * 0.25;
      this.emit(
        {
          x,
          y,
          z,
          vx: (Math.random() - 0.5) * 5,
          vy: (Math.random() - 0.5) * 5,
          vz: 2 + Math.random() * 3,
          life,
          maxLife: life,
          size0: 3.5,
          size1: 2.5,
          alpha0: 0.9,
          gravity: 14,
        },
        0x8a1010,
        false,
      );
    }
  }

  /** Earth and stone fragments thrown up by a catapult impact. */
  impact(x: number, y: number): void {
    this.dust(x, y, 4, 0x8c7656);
    for (let i = 0; i < 14; i++) {
      const life = 0.5 + Math.random() * 0.5;
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 7;
      this.emit(
        {
          x,
          y,
          z: 0.3,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          vz: 6 + Math.random() * 8,
          life,
          maxLife: life,
          size0: 4 + Math.random() * 3,
          size1: 3,
          alpha0: 1,
          gravity: 30,
        },
        0x5a4a36,
        false,
      );
    }
    this.decal(x, y, 0x2a2016, 4.5, 30, 0.55);
  }

  /** A flat mark on the ground (blood pool, scorch) that fades. */
  decal(x: number, y: number, color: number, radius: number, life: number, alpha = 0.5): void {
    const s = this.take(true);
    s.tint = color;
    s.position.set(toScreenX(x, y), toScreenY(x, y));
    s.width = radius * 2 * 16 * (0.8 + Math.random() * 0.4);
    s.height = radius * 16 * (0.8 + Math.random() * 0.4);
    s.alpha = alpha;
    this.decalLayer.addChild(s);
    this.decals.push({ sprite: s, life, maxLife: life, alpha0: alpha });
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.removeFromParent();
        this.pool.push(p.sprite);
        this.particles.splice(i, 1);
        continue;
      }
      p.vz -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z = Math.max(0, p.z + p.vz * dt);
      const t = 1 - p.life / p.maxLife;
      const size = p.size0 + (p.size1 - p.size0) * t;
      p.sprite.position.set(toScreenX(p.x, p.y), toScreenY(p.x, p.y, p.z));
      p.sprite.width = size;
      p.sprite.height = size * (p.gravity === 0 ? 0.7 : 1);
      p.sprite.alpha = p.alpha0 * (1 - t);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.sprite.removeFromParent();
        this.pool.push(d.sprite);
        this.decals.splice(i, 1);
        continue;
      }
      d.sprite.alpha = d.alpha0 * Math.min(1, d.life / (d.maxLife * 0.3));
    }
  }
}
