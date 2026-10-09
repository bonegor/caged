// Isometric camera: a world-space focus point plus zoom, clamped to the map.

import type { Container } from 'pixi.js';
import { toScreenX, toScreenY, toWorld } from './iso';
import type { Vec2 } from '../sim/math';

export class Camera {
  /** World point at the centre of the screen. */
  focus: Vec2;
  zoom = 1;
  targetZoom = 1;
  minZoom = 0.35;
  maxZoom = 1.6;
  viewW = 1;
  viewH = 1;

  constructor(
    private mapW: number,
    private mapH: number,
  ) {
    this.focus = { x: mapW / 2, y: mapH / 2 };
  }

  resize(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  /** Applies the camera to the world container. */
  apply(root: Container): void {
    const sx = toScreenX(this.focus.x, this.focus.y);
    const sy = toScreenY(this.focus.x, this.focus.y);
    root.scale.set(this.zoom);
    root.position.set(Math.round(this.viewW / 2 - sx * this.zoom), Math.round(this.viewH / 2 - sy * this.zoom));
  }

  /** Screen pixel -> world ground point. */
  screenToWorld(px: number, py: number): Vec2 {
    const sx = (px - this.viewW / 2) / this.zoom + toScreenX(this.focus.x, this.focus.y);
    const sy = (py - this.viewH / 2) / this.zoom + toScreenY(this.focus.x, this.focus.y);
    return toWorld(sx, sy);
  }

  worldToScreen(x: number, y: number, z = 0): Vec2 {
    return {
      x: (toScreenX(x, y) - toScreenX(this.focus.x, this.focus.y)) * this.zoom + this.viewW / 2,
      y: (toScreenY(x, y, z) - toScreenY(this.focus.x, this.focus.y)) * this.zoom + this.viewH / 2,
    };
  }

  /** Pans by a screen-space delta (pixels). */
  panScreen(dx: number, dy: number): void {
    const a = toWorld(0, 0);
    const b = toWorld(dx / this.zoom, dy / this.zoom);
    this.focus.x += b.x - a.x;
    this.focus.y += b.y - a.y;
    this.clamp();
  }

  /** Zooms keeping the world point under the cursor fixed. */
  zoomAt(factor: number, px: number, py: number): void {
    const before = this.screenToWorld(px, py);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    this.targetZoom = this.zoom;
    const after = this.screenToWorld(px, py);
    this.focus.x += before.x - after.x;
    this.focus.y += before.y - after.y;
    this.clamp();
  }

  centerOn(p: Vec2): void {
    this.focus = { x: p.x, y: p.y };
    this.clamp();
  }

  clamp(): void {
    const m = 10;
    this.focus.x = Math.max(m, Math.min(this.mapW - m, this.focus.x));
    this.focus.y = Math.max(m, Math.min(this.mapH - m, this.focus.y));
  }
}
