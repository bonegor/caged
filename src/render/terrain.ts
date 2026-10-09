// Terrain: one mesh covering the map diamond, shaded with a splat shader that
// blends 0 A.D. ground textures (CC-BY-SA, Wildfire Games) by layer weights,
// hides texture tiling with two rotated samples, and animates water.

import { CanvasSource, Geometry, GlProgram, ImageSource, Mesh, Shader, type TextureSource } from 'pixi.js';
import type { GameMap } from '../scenarios/mapgen';
import { toScreenX, toScreenY } from './iso';

const vertex = /* glsl */ `
in vec2 aPosition;
in vec2 aWorld;
out vec2 vWorld;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorld = aWorld;
}
`;

const fragment = /* glsl */ `
in vec2 vWorld;
out vec4 finalColor;
uniform sampler2D uGrass;
uniform sampler2D uDry;
uniform sampler2D uMud;
uniform sampler2D uForest;
uniform sampler2D uRocky;
uniform sampler2D uSand;
uniform sampler2D uPaving;
uniform sampler2D uSplatA; // r dry, g mud, b forest
uniform sampler2D uSplatB; // r rocky, g sand, b water
uniform sampler2D uSplatC; // r paving
uniform vec2 uMapSize;
uniform float uTile;
uniform float uTime;
uniform float uBrightness;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { return noise(p) * 0.55 + noise(p * 2.07 + 13.1) * 0.3 + noise(p * 4.13 + 7.7) * 0.15; }

vec3 tex(sampler2D t, vec2 w, float scale) {
  vec2 uv1 = w / (uTile * scale);
  vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * w / (uTile * scale * 1.37) + vec2(0.37, 0.71);
  float n = noise(w * 0.03);
  return mix(texture(t, uv1).rgb, texture(t, uv2).rgb, smoothstep(0.3, 0.7, n));
}

void main() {
  vec2 w = vWorld;
  vec2 jitter = vec2(fbm(w * 0.12), fbm(w * 0.12 + 17.0)) - 0.5;
  vec2 suv = (w + jitter * 4.0) / uMapSize;
  vec3 a = texture(uSplatA, suv).rgb;
  vec3 b = texture(uSplatB, suv).rgb;
  float paving = texture(uSplatC, suv).r;

  vec3 col = tex(uGrass, w, 1.0);
  col = mix(col, tex(uDry, w, 1.0), a.r);
  col = mix(col, tex(uMud, w, 0.8), a.g);
  col = mix(col, tex(uForest, w, 0.6), a.b);
  col = mix(col, tex(uRocky, w, 0.7), b.r);
  col = mix(col, tex(uSand, w, 0.9), b.g);
  col = mix(col, texture(uPaving, w / 9.0).rgb, smoothstep(0.2, 0.7, paving));

  // Large-scale light/dark variation and darker forest floor.
  float m = fbm(w * 0.011) * 0.65 + fbm(w * 0.045) * 0.35;
  col *= 0.86 + 0.26 * m;
  col *= 1.0 - a.b * 0.18;

  // Water: deep colour, animated ripples, bright foam line on the shore.
  float water = b.b;
  if (water > 0.01) {
    float r1 = noise(w * 0.35 + vec2(uTime * 0.6, uTime * 0.25));
    float r2 = noise(w * 0.7 - vec2(uTime * 0.3, uTime * 0.5));
    float ripple = (r1 * 0.6 + r2 * 0.4);
    vec3 deep = vec3(0.10, 0.26, 0.32);
    vec3 shallow = vec3(0.24, 0.42, 0.40);
    vec3 wc = mix(shallow, deep, smoothstep(0.4, 1.0, water));
    wc += vec3(0.10, 0.12, 0.12) * smoothstep(0.62, 0.9, ripple);
    float alpha = smoothstep(0.02, 0.35, water) * 0.92;
    col = mix(col, wc, alpha);
    float foam = smoothstep(0.08, 0.2, water) * (1.0 - smoothstep(0.2, 0.42, water));
    col += vec3(0.28) * foam * (0.5 + 0.5 * sin(uTime * 1.5 + w.x * 0.3 + w.y * 0.2));
  }

  // Darken beyond the map edge.
  vec2 e = min(w, uMapSize - w);
  float edge = smoothstep(-2.0, 10.0, min(e.x, e.y));
  col *= mix(0.25, 1.0, edge);

  finalColor = vec4(col * uBrightness, 1.0);
}
`;

const BASE = `${import.meta.env.BASE_URL}assets/terrain/`;
const NAMES = ['grass', 'grass_dry', 'grass_mud', 'forest_floor', 'rocky', 'sand', 'paving'] as const;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

let texCache: Promise<Record<(typeof NAMES)[number], TextureSource>> | null = null;

export function loadTerrainTextures(): Promise<Record<(typeof NAMES)[number], TextureSource>> {
  if (!texCache) {
    texCache = Promise.all(NAMES.map((n) => loadImage(`${BASE}${n}.webp`))).then((imgs) => {
      const out = {} as Record<(typeof NAMES)[number], TextureSource>;
      imgs.forEach((img, i) => {
        out[NAMES[i]] = new ImageSource({
          resource: img,
          addressMode: 'repeat',
          autoGenerateMipmaps: true,
          scaleMode: 'linear',
          mipmapFilter: 'linear',
          maxAnisotropy: 8,
        });
      });
      return out;
    });
  }
  return texCache;
}

function splatSource(cols: number, rows: number, r: Float32Array, g: Float32Array, b: Float32Array): CanvasSource {
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    img.data[i * 4] = Math.round(Math.min(1, r[i]) * 255);
    img.data[i * 4 + 1] = Math.round(Math.min(1, g[i]) * 255);
    img.data[i * 4 + 2] = Math.round(Math.min(1, b[i]) * 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new CanvasSource({ resource: c, scaleMode: 'linear', addressMode: 'clamp-to-edge' });
}

export class Terrain {
  readonly mesh: Mesh<Geometry, Shader>;
  private uniforms: { uniforms: { uTime: number; uBrightness: number } };

  constructor(map: GameMap, textures: Record<(typeof NAMES)[number], TextureSource>) {
    const W = map.width;
    const H = map.height;
    const m = 80; // draw a margin beyond the map edge
    const corners = [
      { x: -m, y: -m },
      { x: W + m, y: -m },
      { x: W + m, y: H + m },
      { x: -m, y: H + m },
    ];
    const geometry = new Geometry({
      attributes: {
        aPosition: corners.flatMap((c) => [toScreenX(c.x, c.y), toScreenY(c.x, c.y)]),
        aWorld: corners.flatMap((c) => [c.x, c.y]),
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    const t = map.terrain;
    const zero = new Float32Array(t.cols * t.rows);
    const uniforms = {
      uMapSize: { value: new Float32Array([W, H]), type: 'vec2<f32>' },
      uTile: { value: 26, type: 'f32' },
      uTime: { value: 0, type: 'f32' },
      uBrightness: { value: 1.0, type: 'f32' },
    };
    const shader = new Shader({
      glProgram: new GlProgram({ vertex, fragment, name: 'terrain-splat' }),
      resources: {
        terrainUniforms: uniforms,
        uGrass: textures.grass,
        uDry: textures.grass_dry,
        uMud: textures.grass_mud,
        uForest: textures.forest_floor,
        uRocky: textures.rocky,
        uSand: textures.sand,
        uPaving: textures.paving,
        uSplatA: splatSource(t.cols, t.rows, t.dry, t.mud, t.forest),
        uSplatB: splatSource(t.cols, t.rows, t.rocky, t.sand, t.water),
        uSplatC: splatSource(t.cols, t.rows, t.paving, zero, zero),
      },
    });
    this.mesh = new Mesh({ geometry, shader });
    this.uniforms = shader.resources.terrainUniforms as unknown as { uniforms: { uTime: number; uBrightness: number } };
  }

  update(time: number): void {
    this.uniforms.uniforms.uTime = time;
  }
}
