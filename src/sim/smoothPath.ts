// A polyline path with rounded corners, sampled densely and parameterised by
// arc length. Used for formation anchors: rounding corners to roughly the
// formation's half-width lets the outer ranks keep up through turns.

import type { Vec2 } from './math';

export interface PathPose {
  pos: Vec2;
  heading: number;
}

export class SmoothPath {
  readonly pts: Vec2[] = [];
  readonly s: number[] = [];
  /** Turn radius at each sample (Infinity on straight parts). */
  readonly radius: number[] = [];
  readonly length: number;

  constructor(points: Vec2[], cornerRadius: number, step = 1) {
    const p = points.filter((pt, i) => i === 0 || Math.hypot(pt.x - points[i - 1].x, pt.y - points[i - 1].y) > 1e-6);
    if (p.length === 1) p.push({ x: p[0].x + 1e-3, y: p[0].y });
    const out: Vec2[] = [];
    const rad: number[] = [];
    const pushLine = (a: Vec2, b: Vec2) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = out.length ? 1 : 0; k <= n; k++) {
        out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
        rad.push(Infinity);
      }
    };
    let cursor = p[0];
    for (let i = 1; i < p.length - 1; i++) {
      const a = p[i - 1];
      const v = p[i];
      const b = p[i + 1];
      const l1 = Math.hypot(v.x - a.x, v.y - a.y);
      const l2 = Math.hypot(b.x - v.x, b.y - v.y);
      const ax = (v.x - a.x) / l1;
      const ay = (v.y - a.y) / l1;
      const bx = (b.x - v.x) / l2;
      const by = (b.y - v.y) / l2;
      const turn = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by)));
      if (turn < 1e-3) continue;
      const tanHalf = Math.tan(turn / 2);
      const tMax = 0.5 * Math.min(l1, l2) * 0.999;
      let t = cornerRadius * tanHalf;
      if (t > tMax) t = tMax;
      const R = t / tanHalf;
      const start = { x: v.x - ax * t, y: v.y - ay * t };
      const end = { x: v.x + bx * t, y: v.y + by * t };
      pushLine(cursor, start);
      // Arc centre lies on the inside of the turn.
      const side = Math.sign(ax * by - ay * bx) || 1;
      const cx = start.x - ay * side * R;
      const cy = start.y + ax * side * R;
      const a0 = Math.atan2(start.y - cy, start.x - cx);
      const sweep = turn * side;
      const n = Math.max(2, Math.ceil((Math.abs(sweep) * R) / step));
      for (let k = 1; k <= n; k++) {
        const ang = a0 + (sweep * k) / n;
        out.push({ x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R });
        rad.push(R);
      }
      cursor = end;
    }
    pushLine(cursor, p[p.length - 1]);
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      if (i > 0) acc += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
      this.pts.push(out[i]);
      this.s.push(acc);
      this.radius.push(rad[i]);
    }
    this.length = acc;
  }

  private segment(s: number): number {
    // Largest i with this.s[i] <= s.
    let lo = 0;
    let hi = this.s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, this.s.length - 2);
  }

  private headingOf(i: number): number {
    const a = this.pts[i];
    const b = this.pts[i + 1];
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  /** Position and heading at arc length s; extrapolates straight beyond both ends. */
  poseAt(s: number): PathPose {
    if (this.pts.length < 2) return { pos: { ...this.pts[0] }, heading: 0 };
    if (s <= 0) {
      const h = this.headingOf(0);
      return { pos: { x: this.pts[0].x + Math.cos(h) * s, y: this.pts[0].y + Math.sin(h) * s }, heading: h };
    }
    if (s >= this.length) {
      const last = this.pts.length - 1;
      const h = this.headingOf(last - 1);
      const extra = s - this.length;
      return { pos: { x: this.pts[last].x + Math.cos(h) * extra, y: this.pts[last].y + Math.sin(h) * extra }, heading: h };
    }
    const i = this.segment(s);
    const seg = this.s[i + 1] - this.s[i];
    const t = seg > 0 ? (s - this.s[i]) / seg : 0;
    const a = this.pts[i];
    const b = this.pts[i + 1];
    return { pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, heading: this.headingOf(i) };
  }

  /** Smallest turn radius on [s, s + ahead]. */
  minRadiusAhead(s: number, ahead: number): number {
    if (this.pts.length < 2) return Infinity;
    let i = this.segment(Math.max(0, s));
    let r = Infinity;
    const end = s + ahead;
    for (; i < this.s.length && this.s[i] <= end; i++) r = Math.min(r, this.radius[i]);
    return r;
  }

  get end(): Vec2 {
    return this.pts[this.pts.length - 1];
  }
}
