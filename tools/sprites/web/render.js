// Browser-side sprite renderer. Assembles a resolved 0 A.D. actor tree with
// three.js, poses it from COLLADA animation clips and renders three passes per
// frame from a fixed 2:1 isometric camera:
//   color  - lit model, team-colour areas rendered with a neutral (white) tint
//   mask   - grey level = how strongly the team colour applies (0 A.D. alpha mask)
//   shadow - the model's shadow on the ground plane, as alpha
//
// Driven from Node through Playwright (see ../render.mjs).

import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const _warn = console.warn;
console.warn = (...args) => {
  const msg = String(args[0] ?? '');
  if (msg.includes('Z-UP') || msg.includes('ColladaLoader')) return;
  _warn(...args);
};

const colladaLoader = new ColladaLoader();
const textureLoader = new THREE.TextureLoader();
const daeCache = new Map();
const texCache = new Map();

function loadDae(url) {
  if (!daeCache.has(url)) {
    daeCache.set(
      url,
      new Promise((resolve, reject) => colladaLoader.load(url, resolve, undefined, (e) => reject(new Error(`DAE ${url}: ${e}`)))),
    );
  }
  return daeCache.get(url);
}

function loadTexture(url, srgb) {
  const key = `${url}|${srgb}`;
  if (!texCache.has(key)) {
    texCache.set(
      key,
      new Promise((resolve, reject) =>
        textureLoader.load(
          url,
          (t) => {
            t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = 8;
            resolve(t);
          },
          undefined,
          () => reject(new Error(`texture ${url}`)),
        ),
      ),
    );
  }
  return texCache.get(key);
}

// ---------------------------------------------------------------------------
// Materials

function patchFragment(material, code, key) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = { value: material.userData.tint ?? new THREE.Color(1, 1, 1) };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uTint;\nvoid main() {')
      .replace('#include <map_fragment>', `#include <map_fragment>\n${code}\n`);
  };
  material.customProgramCacheKey = () => key;
}

async function makeMaterials(node) {
  const t = node.textures;
  const base = t.baseTex ? await loadTexture(t.baseTex, true) : null;
  const norm = t.normTex && !t.normTex.endsWith('default_norm.png') ? await loadTexture(t.normTex, false) : null;
  const spec = t.specTex && !/null_(black|white)/.test(t.specTex) ? await loadTexture(t.specTex, false) : null;
  const mat = node.material;
  const masked = mat.playerColor || mat.objectColor;

  const color = new THREE.MeshPhongMaterial({
    map: base,
    normalMap: norm,
    normalScale: new THREE.Vector2(1, 1),
    specularMap: spec,
    specular: new THREE.Color(spec ? 0.55 : 0.04, spec ? 0.55 : 0.04, spec ? 0.55 : 0.04),
    shininess: 40,
    side: mat.transparent ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: mat.transparent ? 0.5 : 0,
  });
  color.userData.tint = node.color ? new THREE.Color().setRGB(...node.color, THREE.SRGBColorSpace) : new THREE.Color(1, 1, 1);
  patchFragment(
    color,
    masked
      ? 'diffuseColor.rgb *= mix(uTint, vec3(1.0), diffuseColor.a); diffuseColor.a = 1.0;'
      : mat.transparent
        ? ''
        : 'diffuseColor.a = 1.0;',
    `color-${masked}-${mat.transparent}`,
  );

  // Team-colour mask: grey level = 1 - alpha for player-coloured materials, black otherwise.
  const mask = new THREE.MeshBasicMaterial({
    map: mat.playerColor || mat.transparent ? base : null,
    side: color.side,
    alphaTest: color.alphaTest,
  });
  patchFragment(
    mask,
    mat.playerColor
      ? 'diffuseColor = vec4(vec3(1.0 - diffuseColor.a), 1.0);'
      : mat.transparent
        ? 'diffuseColor.rgb = vec3(0.0);'
        : 'diffuseColor = vec4(0.0, 0.0, 0.0, 1.0);',
    `mask-${mat.playerColor}-${mat.transparent}`,
  );

  // Shadow pass: invisible, but still casts shadows (alpha-tested where needed).
  const shadow = new THREE.MeshBasicMaterial({
    map: mat.transparent ? base : null,
    alphaTest: color.alphaTest,
    side: color.side,
    colorWrite: false,
    depthWrite: false,
  });

  return { color, mask, shadow };
}

// ---------------------------------------------------------------------------
// Model assembly

/** Retargets a COLLADA clip (tracks keyed by uuid) to bone names. */
function namedTracks(dae) {
  const byUuid = new Map();
  dae.scene.traverse((o) => byUuid.set(o.uuid, o));
  const tracks = [];
  let duration = 0;
  for (const clip of dae.scene.animations ?? []) {
    duration = Math.max(duration, clip.duration);
    for (const track of clip.tracks) {
      const dot = track.name.indexOf('.');
      const obj = byUuid.get(track.name.slice(0, dot));
      if (!obj) continue;
      tracks.push({ bone: obj.name, prop: track.name.slice(dot + 1), interp: track.createInterpolant(), times: track.times });
    }
  }
  return { tracks, duration };
}

async function buildModel(node, stats) {
  let root;
  if (node.mesh) {
    const dae = await loadDae(node.mesh);
    root = SkeletonUtils.clone(dae.scene);
    // Work in the files' native Z-up frame; the loader rotated Z-up scenes to Y-up,
    // so undo that (or convert a Y-up file into Z-up). Like the engine, ignore the
    // declared <unit>: old converted meshes claim centimetres but store metres.
    root.rotation.set(dae.scene.rotation.x === 0 ? Math.PI / 2 : 0, 0, 0);
    root.scale.set(1, 1, 1);
    root.animations = [];
  } else {
    root = new THREE.Group();
  }
  root.name = '';

  // Bones/prop points of this model only (collected before props are attached).
  const objects = new Map();
  root.traverse((o) => {
    if (o.name && !objects.has(o.name)) objects.set(o.name, o);
  });

  const mats = await makeMaterials(node);
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh) {
      o.material = mats.color;
      o.userData.mats = mats;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      meshes.push(o);
      stats.meshes++;
    }
  });

  const anims = {};
  for (const [name, list] of Object.entries(node.anims)) {
    if (!list.length) continue;
    const pick = list[0];
    const dae = await loadDae(pick.file);
    const { tracks, duration } = namedTracks(dae);
    const usable = tracks.filter((tr) => objects.has(tr.bone));
    if (!usable.length) continue;
    anims[name] = { tracks: usable, duration, speed: pick.speed, event: pick.event, load: pick.load, file: pick.file };
  }

  const model = { root, objects, anims, meshes, children: [], sockets: [], ammo: [], actor: node.actor };

  for (const prop of node.props) {
    // 'loaded-<point>' props are ammo (e.g. the nocked arrow), shown between the
    // animation's load and event times only.
    const isAmmo = prop.attachpoint.startsWith('loaded-');
    const pointName = isAmmo ? prop.attachpoint.slice(7) : prop.attachpoint;
    const child = await buildModel(prop, stats);
    let point = root;
    if (pointName !== 'root') {
      point = objects.get(`prop-${pointName}`) ?? objects.get(`prop_${pointName}`);
      if (!point) {
        stats.missingPoints.push(`${node.actor}: ${prop.attachpoint}`);
        point = root;
      }
    }
    // Like the engine, props follow the prop point's translation and rotation only
    // (scale is discarded), so attach through a socket updated in placeSockets().
    const socket = new THREE.Group();
    root.add(socket);
    socket.add(child.root);
    model.sockets.push({ socket, point });
    model.children.push(child);
    if (isAmmo) model.ammo.push(socket);
  }
  return model;
}

function applyPose(model, state, phase) {
  const anim = model.anims[state] ?? model.anims.idle;
  const showAmmo = !!anim && anim.load != null && anim.event != null && (phase >= anim.load || phase < anim.event);
  for (const socket of model.ammo) socket.visible = showAmmo;
  if (anim) {
    const t = Math.min(anim.duration * phase, anim.duration);
    for (const tr of anim.tracks) {
      const obj = model.objects.get(tr.bone);
      const v = tr.interp.evaluate(t);
      if (tr.prop === 'position') obj.position.fromArray(v);
      else if (tr.prop === 'quaternion') obj.quaternion.fromArray(v);
      else if (tr.prop === 'scale') obj.scale.fromArray(v);
    }
  }
  for (const c of model.children) applyPose(c, state, phase);
}

function allMeshes(model, out = []) {
  out.push(...model.meshes);
  for (const c of model.children) allMeshes(c, out);
  return out;
}

// ---------------------------------------------------------------------------
// Scene

const ELEV = (30 * Math.PI) / 180;
const state = {};

function setupScene({ width, height, supersample }) {
  const canvas = document.createElement('canvas');
  document.body.innerHTML = '';
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width * supersample, height * supersample, false);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  const D = 200;
  camera.position.set((D * Math.cos(ELEV)) / Math.SQRT2, D * Math.sin(ELEV), (D * Math.cos(ELEV)) / Math.SQRT2);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // Lighting: warm sun from the upper left of the screen, cool sky fill, faint rim.
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.9);
  sun.position.set(-60, 75, -18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  const sc = sun.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 300;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xd8e6ff, 0x5a4a32, 1.35);
  scene.add(hemi);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 0.7);
  rim.position.set(-40, 30, -60);
  scene.add(rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: 0x000000, opacity: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.visible = false;
  scene.add(ground);

  Object.assign(state, { renderer, scene, camera, sun, hemi, rim, ground, width, height, supersample });
}

function resize({ width, height, measureOnly = false }) {
  state.width = width;
  state.height = height;
  // Measuring only needs the camera projection; don't allocate a huge drawing buffer.
  if (!measureOnly) state.renderer.setSize(width * state.supersample, height * state.supersample, false);
}

function frameCamera({ scale, anchorX, anchorY }) {
  const { camera, width, height } = state;
  // 'scale' = pixels per model unit at the final (non-supersampled) size.
  camera.left = -anchorX / scale;
  camera.right = (width - anchorX) / scale;
  camera.top = anchorY / scale;
  camera.bottom = -(height - anchorY) / scale;
  camera.updateProjectionMatrix();
}

async function loadUnit(spec) {
  const stats = { meshes: 0, missingPoints: [] };
  const model = await buildModel(spec.tree, stats);
  const yaw = new THREE.Group();
  const convert = new THREE.Group();
  convert.rotation.x = -Math.PI / 2; // COLLADA Z-up -> Y-up
  const s = spec.modelScale ?? 1;
  convert.scale.set(s, s, s);
  convert.add(model.root);
  yaw.add(convert);
  if (state.unit) state.scene.remove(state.unit.yaw);
  state.scene.add(yaw);
  state.unit = { model, yaw, meshes: allMeshes(model) };
  const anims = {};
  const collect = (m, depth) => {
    for (const [k, a] of Object.entries(m.anims)) {
      if (depth === 0 || !anims[k]) anims[k] = { duration: a.duration, speed: a.speed, event: a.event, load: a.load, file: a.file };
    }
    m.children.forEach((c) => collect(c, depth + 1));
  };
  collect(model, 0);
  return { stats, anims };
}

function setMaterials(kind) {
  for (const m of state.unit.meshes) m.material = m.userData.mats[kind];
}

function pose(animState, phase, angleDeg) {
  // World facing angle theta (from +x towards +y); model faces +Z (= world +y) by default.
  const theta = (angleDeg * Math.PI) / 180;
  state.unit.yaw.rotation.y = Math.PI / 2 - theta;
  applyPose(state.unit.model, animState, phase);
  state.unit.yaw.updateMatrixWorld(true);
  placeSockets(state.unit.model);
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function placeSockets(model) {
  model.root.updateMatrixWorld(true);
  _inv.copy(model.root.matrixWorld).invert();
  for (const { socket, point } of model.sockets) {
    if (point === model.root) {
      socket.position.set(0, 0, 0);
      socket.quaternion.identity();
    } else {
      _m.multiplyMatrices(_inv, point.matrixWorld).decompose(_p, _q, _s);
      socket.position.copy(_p);
      socket.quaternion.copy(_q);
    }
    socket.scale.set(1, 1, 1);
    socket.updateMatrixWorld(true);
  }
  for (const c of model.children) placeSockets(c);
}

function renderPass(kind) {
  const { renderer, scene, camera, ground } = state;
  if (kind === 'shadow') {
    setMaterials('shadow');
    ground.visible = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  } else if (kind === 'mask') {
    setMaterials('mask');
    ground.visible = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  } else {
    setMaterials('color');
    ground.visible = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

/** Projected screen-space bounds (final pixels) of the unit's meshes for the current pose. */
function measure() {
  const { camera, width, height, sun } = state;
  // The camera's view matrix is normally refreshed by render(); measuring can happen first.
  camera.updateMatrixWorld();
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const sbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const v = new THREE.Vector3();
  const g = new THREE.Vector3();
  const L = sun.position.clone().sub(sun.target.position).normalize();
  const add = (b, p) => {
    const x = ((p.x + 1) / 2) * width;
    const y = ((1 - p.y) / 2) * height;
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
  };
  for (const mesh of state.unit.meshes) {
    const pos = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      if (mesh.isSkinnedMesh) mesh.applyBoneTransform(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      // Ground point of this vertex's shadow: slide along the light direction to y = 0.
      g.copy(v).addScaledVector(L, -Math.max(0, v.y) / L.y);
      add(box, v.project(camera));
      add(sbox, g.project(camera));
    }
  }
  return { ...box, shadow: sbox };
}

window.renderer = {
  setupScene,
  resize,
  frameCamera,
  loadUnit,
  /** Render a batch of frames; returns base64 PNGs per pass. */
  renderFrames(frames, passes) {
    const out = [];
    for (const f of frames) {
      pose(f.anim, f.phase, f.angle);
      const r = {};
      for (const p of passes) r[p] = renderPass(p);
      out.push(r);
    }
    return out;
  },
  measureFrames(frames) {
    return frames.map((f) => {
      pose(f.anim, f.phase, f.angle);
      return measure();
    });
  },
  ready: true,
};
