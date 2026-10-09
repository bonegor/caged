// Isometric (2:1 dimetric) projection shared by the renderer and the sprite
// pipeline: camera 30 degrees above the ground, looking along world (-1, -1).
// World +x points to the lower right of the screen, +y to the lower left.

/** Sprite resolution: pixels per world unit in the camera plane (see tools/sprites/config.mjs). */
export const PX = 16;
/** Screen pixels per world unit along each ground axis (horizontal component). */
export const K = PX / Math.SQRT2;
/** Screen pixels per unit of height. */
export const KZ = PX * Math.cos(Math.PI / 6);

export function toScreenX(x: number, y: number): number {
  return (x - y) * K;
}

export function toScreenY(x: number, y: number, z = 0): number {
  return (x + y) * K * 0.5 - z * KZ;
}

/** Inverse projection onto the ground plane (z = 0). */
export function toWorld(sx: number, sy: number): { x: number; y: number } {
  const a = sx / K; // x - y
  const b = (sy * 2) / K; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Screen-space angle (radians) of a world-space direction. */
export function screenAngle(dx: number, dy: number): number {
  return Math.atan2((dx + dy) * 0.5, dx - dy);
}
