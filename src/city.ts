import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Size of one city cell: a block plus half a road on every side. */
export const CELL = 96;
const HALF_ROAD = 9;
const CURB = 0.15;
const INSET = 8; // pavement between the block edge and any building
const WIN_W = 3;
const FLOOR_H = 3.5;
const TILE = 16; // the window texture holds TILE x TILE windows
const VIEW_RADIUS = 6; // in cells
const SIGN_COLS = 4;
const SIGN_ROWS = 8;

const TINTS = [0xffffff, 0xcfd8e0, 0xe2d4c2, 0xb4c0c8, 0x9aa6ae];
const GLOWS = [0xff2d95, 0x29e7ff, 0xff9a2e, 0xff4040, 0x9d6bff, 0x29e7ff, 0xff9a2e];
const DARK = 0x1b2025;
const ROOF = 0x20262b;
const PAVEMENT = 0x353c42;
const ROAD = 0x1c2227;
const POOL = 0x0b1216;

const SIGN_WORDS = [
  'NOVA', 'KIRO', 'ATLAS-9', 'ORBITAL', 'SYNTH', 'HALO', 'ZENITH', 'MIRA',
  'EON', 'LUMEN', 'VANTA', 'ONYX BAR', 'NOODLES', 'HOTEL', '24H', 'ARCADE',
  'DRIFT', 'KYTE', 'ラーメン', 'ホテル', 'ネオン', 'バー', '薬局', '酒場',
  'CINEMA', 'TRANSIT', 'SECTOR 7', 'AURA', 'OPEN', 'HYDRO', 'ИЗОТОП', '서울식당',
];
const SIGN_COLORS = ['#ff2d95', '#29e7ff', '#ff9a2e', '#ff4040', '#b48bff', '#f4f7ff'];

/** Axis-aligned box, or a vertical cylinder when `r` is set. */
export interface Collider {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  r?: number;
  cx?: number;
  cz?: number;
}

type Rand = () => number;

interface Parts {
  facade: THREE.BufferGeometry[];
  solid: THREE.BufferGeometry[];
  glow: THREE.BufferGeometry[];
  signs: THREE.BufferGeometry[];
  pools: THREE.BufferGeometry[];
  colliders: Collider[];
}

interface Chunk {
  group: THREE.Group;
  colliders: Collider[];
  cx: number;
  cz: number;
}

function hash2(x: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const v = (i: number, j: number) => hash2(i, j) / 4294967296;
  const a = v(ix, iz) + (v(ix + 1, iz) - v(ix, iz)) * sx;
  const b = v(ix, iz + 1) + (v(ix + 1, iz + 1) - v(ix, iz + 1)) * sx;
  return a + (b - a) * sz;
}

const pick = <T>(r: Rand, list: T[]): T => list[Math.floor(r() * list.length)];
const quant = (v: number, step: number) => Math.max(step, Math.floor(v / step) * step);

const tmpColor = new THREE.Color();

function finish(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  const n = out.attributes.position.count;
  const arr = new Float32Array(n * 3);
  tmpColor.set(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = tmpColor.r;
    arr[i * 3 + 1] = tmpColor.g;
    arr[i * 3 + 2] = tmpColor.b;
  }
  out.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return out;
}

function addBox(
  list: THREE.BufferGeometry[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  color: number,
  windows = false,
  uOff = 0,
  vOff = 0,
) {
  const w = x1 - x0;
  const h = y1 - y0;
  const d = z1 - z0;
  const g = new THREE.BoxGeometry(w, h, d);
  if (windows) {
    // Scale the side-face UVs so one window is WIN_W wide and one floor is FLOOR_H tall.
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const face = i >> 2; // +x, -x, +y, -y, +z, -z
      if (face === 2 || face === 3) {
        uv.setXY(i, 0, 0);
        continue;
      }
      const run = face < 2 ? d : w;
      uv.setXY(
        i,
        (uv.getX(i) * run) / (WIN_W * TILE) + uOff,
        (uv.getY(i) * h) / (FLOOR_H * TILE) + vOff,
      );
    }
  }
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  list.push(finish(g, color));
}

function addCyl(
  list: THREE.BufferGeometry[],
  x: number,
  y0: number,
  z: number,
  r: number,
  h: number,
  color: number,
  windows = false,
  segments = 32,
  vOff = 0,
) {
  const g = new THREE.CylinderGeometry(r, r, h, segments);
  if (windows) {
    const around = Math.round((2 * Math.PI * r) / WIN_W) / TILE;
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * around, (uv.getY(i) * h) / (FLOOR_H * TILE) + vOff);
    }
  }
  g.translate(x, y0 + h / 2, z);
  list.push(finish(g, color));
}

function boxCollider(
  p: Parts,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
) {
  p.colliders.push({ minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: z0, maxZ: z1 });
}

function cylCollider(p: Parts, x: number, y0: number, z: number, r: number, y1: number) {
  p.colliders.push({
    minX: x - r,
    maxX: x + r,
    minY: y0,
    maxY: y1,
    minZ: z - r,
    maxZ: z + r,
    r,
    cx: x,
    cz: z,
  });
}

/** A glowing sign panel on one face of a box (0:+z, 1:-z, 2:+x, 3:-x). */
function addSign(
  p: Parts,
  r: Rand,
  cx: number,
  cz: number,
  hw: number,
  hd: number,
  face: number,
  along: number,
  y: number,
  w: number,
  h: number,
) {
  const g = new THREE.PlaneGeometry(w, h);
  const cell = Math.floor(r() * SIGN_COLS * SIGN_ROWS);
  const col = cell % SIGN_COLS;
  const row = Math.floor(cell / SIGN_COLS);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (col + uv.getX(i)) / SIGN_COLS, (SIGN_ROWS - 1 - row + uv.getY(i)) / SIGN_ROWS);
  }
  const off = 0.3;
  if (face === 0) g.translate(cx + along, y, cz + hd + off);
  else if (face === 1) g.rotateY(Math.PI).translate(cx + along, y, cz - hd - off);
  else if (face === 2) g.rotateY(Math.PI / 2).translate(cx + hw + off, y, cz + along);
  else g.rotateY(-Math.PI / 2).translate(cx - hw - off, y, cz + along);
  p.signs.push(g);
}

/** A soft patch of coloured light on the ground, standing in for a real light source. */
function addPool(p: Parts, x: number, z: number, size: number, color: number) {
  const g = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2).translate(x, CURB + 0.03, z);
  p.pools.push(finish(g, color));
}

/** Street lamp with an arm reaching `dirZ` toward the road. */
function lamp(p: Parts, x: number, y0: number, z: number, dirZ: number, color: number) {
  const top = y0 + 6;
  addBox(p.solid, x - 0.1, y0, z - 0.1, x + 0.1, top, z + 0.1, DARK);
  const tip = z + dirZ * 1.8;
  addBox(p.solid, x - 0.08, top - 0.12, Math.min(z, tip), x + 0.08, top, Math.max(z, tip), DARK);
  addBox(p.glow, x - 0.22, top - 0.22, tip - 0.5, x + 0.22, top - 0.12, tip + 0.5, color);
  cylCollider(p, x, y0, z, 0.15, top);
  addPool(p, x, tip, 15, color);
}

function tower(
  p: Parts,
  r: Rand,
  lx0: number,
  lz0: number,
  lx1: number,
  lz1: number,
  rawHeight: number,
) {
  const tint = pick(r, TINTS);
  const glow = pick(r, GLOWS);
  const cx = (lx0 + lx1) / 2;
  const cz = (lz0 + lz1) / 2;
  let w = quant(lx1 - lx0, WIN_W);
  let d = quant(lz1 - lz0, WIN_W);
  let rad = Math.floor(Math.min(w, d) / 2);
  const height = Math.max(4, Math.round(rawHeight / FLOOR_H)) * FLOOR_H;
  const round = Math.abs(w - d) < 7 && r() < 0.25;
  const tiers = height > 70 ? 1 + Math.floor(r() * 3) : r() < 0.35 ? 2 : 1;

  let y = CURB;
  let rem = height;
  for (let t = 0; t < tiers && rem >= FLOOR_H; t++) {
    let th = t === tiers - 1 ? rem : quant(rem * (0.4 + 0.25 * r()), FLOOR_H);
    if (rem - th < FLOOR_H) th = rem;
    rem -= th;
    const top = y + th;
    const vOff = Math.floor(r() * TILE) / TILE;
    if (round) {
      addCyl(p.facade, cx, y, cz, rad, th, tint, true, 32, vOff);
      addCyl(p.solid, cx, top, cz, rad + 0.3, 0.6, ROOF);
      if (r() < 0.6) addCyl(p.glow, cx, top - 0.8, cz, rad + 0.15, 0.25, glow);
      cylCollider(p, cx, y, cz, rad, top + 0.6);
      rad = Math.max(4, Math.floor(rad * (0.65 + 0.2 * r())));
    } else {
      const ax0 = cx - w / 2;
      const ax1 = cx + w / 2;
      const az0 = cz - d / 2;
      const az1 = cz + d / 2;
      addBox(p.facade, ax0, y, az0, ax1, top, az1, tint, true, Math.floor(r() * TILE) / TILE, vOff);
      addBox(p.solid, ax0 - 0.3, top, az0 - 0.3, ax1 + 0.3, top + 0.6, az1 + 0.3, ROOF);
      if (r() < 0.6) {
        addBox(p.glow, ax0 - 0.15, top - 0.8, az0 - 0.15, ax1 + 0.15, top - 0.55, az1 + 0.15, glow);
      }
      boxCollider(p, ax0, y, az0, ax1, top + 0.6, az1);
      if (t === 0) {
        // Entrance canopies on the two street-facing sides.
        for (const side of [-1, 1]) {
          const face = side < 0 ? az0 : az1;
          const out = face + side * 2.5;
          addBox(p.solid, cx - 4, 3.6, Math.min(face, out), cx + 4, 3.85, Math.max(face, out), ROOF);
          addBox(p.glow, cx - 4, 3.5, out - 0.12, cx + 4, 3.6, out + 0.12, glow);
          addPool(p, cx, out, 11, glow);
        }
        // Neon signs and billboards.
        const count = th > 40 ? 1 + Math.floor(r() * 3) : r() < 0.6 ? 1 : 0;
        for (let s = 0; s < count; s++) {
          const face = Math.floor(r() * 4);
          const run = face < 2 ? w : d;
          const big = th > 90 && r() < 0.35;
          const sw = Math.min(run - 3, big ? 26 + r() * 14 : 8 + r() * 10);
          const sh = sw / 2;
          const yMax = Math.min(top - 3 - sh / 2, big ? 110 : 45);
          const yMin = CURB + 5.5 + sh / 2;
          if (sw < 5 || yMax < yMin) continue;
          const along = (r() - 0.5) * (run - sw - 1);
          addSign(p, r, cx, cz, w / 2, d / 2, face, along, yMin + r() * (yMax - yMin), sw, sh);
        }
      }
      w = Math.max(9, quant(w * (0.6 + 0.25 * r()), WIN_W));
      d = Math.max(9, quant(d * (0.6 + 0.25 * r()), WIN_W));
    }
    y = top;
  }

  if (height > 100 && r() < 0.6) {
    const sh = 18 + r() * 30;
    addBox(p.solid, cx - 0.5, y, cz - 0.5, cx + 0.5, y + sh, cz + 0.5, ROOF);
    addBox(p.glow, cx - 0.6, y + sh, cz - 0.6, cx + 0.6, y + sh + 1.2, cz + 0.6, 0xff4040);
  }
}

function plaza(p: Parts, r: Rand, bx0: number, bz0: number, bx1: number, bz1: number) {
  const mx = (bx0 + bx1) / 2;
  const mz = (bz0 + bz1) / 2;
  const gap = 8;
  const glow = pick(r, GLOWS);
  const pads: [number, number, number, number][] = [
    [bx0, bz0, mx - gap, mz - gap],
    [mx + gap, bz0, bx1, mz - gap],
    [bx0, mz + gap, mx - gap, bz1],
    [mx + gap, mz + gap, bx1, bz1],
  ];
  for (const [x0, z0, x1, z1] of pads) {
    addBox(p.solid, x0, CURB, z0, x1, CURB + 0.2, z1, POOL);
    boxCollider(p, x0, CURB, z0, x1, CURB + 0.2, z1);
    for (let i = 0; i < 2; i++) {
      const px = x0 + 3 + r() * (x1 - x0 - 6);
      const pz = z0 + 3 + r() * (z1 - z0 - 6);
      const ph = 5 + r() * 4;
      addBox(p.solid, px - 0.3, CURB + 0.2, pz - 0.3, px + 0.3, ph, pz + 0.3, DARK);
      addBox(p.glow, px - 0.34, ph, pz - 0.34, px + 0.34, ph + 0.5, pz + 0.34, glow);
      boxCollider(p, px - 0.3, CURB + 0.2, pz - 0.3, px + 0.3, ph + 0.5, pz + 0.3);
    }
  }

  const h = 30 + r() * 30;
  addCyl(p.solid, mx, CURB, mz, 5, 0.45, ROOF);
  cylCollider(p, mx, CURB, mz, 5, CURB + 0.45);
  addBox(p.solid, mx - 0.8, CURB, mz - 0.8, mx + 0.8, h, mz + 0.8, DARK);
  boxCollider(p, mx - 0.8, CURB, mz - 0.8, mx + 0.8, h, mz + 0.8);
  addBox(p.glow, mx - 1, h, mz - 1, mx + 1, h + 1.6, mz + 1, glow);
  for (const [ry, rr] of [
    [h * 0.3, 7],
    [h * 0.5, 5],
    [h * 0.7, 3.5],
  ]) {
    const ring = new THREE.TorusGeometry(rr, 0.2, 8, 48);
    ring.rotateX(Math.PI / 2);
    ring.translate(mx, ry, mz);
    p.glow.push(finish(ring, glow));
  }
}

/** A footbridge over the road on the west edge of the cell, with stairs at both ends. */
function footbridge(p: Parts, x0: number, z0: number) {
  const zc = z0 + CELL / 2;
  const steps = 20;
  const rise = 0.25;
  const run = 0.75;
  const top = CURB + steps * rise;
  const xa = x0 - HALF_ROAD - 4.5;
  const xb = x0 + HALF_ROAD + 4.5;
  const metal = 0x2b3238;

  addBox(p.solid, xa, top - 0.4, zc - 2, xb, top, zc + 2, metal);
  boxCollider(p, xa, top - 0.4, zc - 2, xb, top, zc + 2);
  addBox(p.glow, xa, top - 0.5, zc - 2.06, xb, top - 0.4, zc + 2.06, 0x29e7ff);

  for (let i = 1; i <= steps; i++) {
    const sy = CURB + i * rise;
    // East stairs run toward +z, west stairs toward -z.
    const ez0 = zc + 2 + (steps - i) * run;
    addBox(p.solid, x0 + HALF_ROAD + 0.5, CURB, ez0, xb, sy, ez0 + run, metal);
    boxCollider(p, x0 + HALF_ROAD + 0.5, CURB, ez0, xb, sy, ez0 + run);
    const wz1 = zc - 2 - (steps - i) * run;
    addBox(p.solid, xa, CURB, wz1 - run, x0 - HALF_ROAD - 0.5, sy, wz1, metal);
    boxCollider(p, xa, CURB, wz1 - run, x0 - HALF_ROAD - 0.5, sy, wz1);
  }

  // Rails, left open where the stairs meet the deck.
  const rails: [number, number, number, number][] = [
    [xa, zc + 1.9, x0 + HALF_ROAD + 0.5, zc + 2],
    [x0 - HALF_ROAD - 0.5, zc - 2, xb, zc - 1.9],
    [xa, zc - 2, xa + 0.1, zc + 2],
    [xb - 0.1, zc - 2, xb, zc + 2],
  ];
  for (const [rx0, rz0, rx1, rz1] of rails) {
    addBox(p.solid, rx0, top, rz0, rx1, top + 1.1, rz1, 0x39424a);
    boxCollider(p, rx0, top, rz0, rx1, top + 1.1, rz1);
  }
}

function buildParts(cx: number, cz: number): Parts {
  const p: Parts = { facade: [], solid: [], glow: [], signs: [], pools: [], colliders: [] };
  const r = mulberry32(hash2(cx, cz));
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const ex0 = x0 + HALF_ROAD;
  const ez0 = z0 + HALF_ROAD;
  const ex1 = x0 + CELL - HALF_ROAD;
  const ez1 = z0 + CELL - HALF_ROAD;

  // Road surface, raised pavement, and centre lines.
  addBox(p.solid, x0, -1, z0, x0 + CELL, 0, z0 + CELL, ROAD);
  addBox(p.solid, ex0, 0, ez0, ex1, CURB, ez1, PAVEMENT);
  boxCollider(p, ex0, 0, ez0, ex1, CURB, ez1);
  addBox(p.glow, x0 - 0.1, 0, ez0, x0 + 0.1, 0.03, ez1, 0x8a5a22);
  addBox(p.glow, ex0, 0, z0 - 0.1, ex1, 0.03, z0 + 0.1, 0x8a5a22);

  // Street lamps along the two z-facing edges (the x-facing edges are kept clear for stairs).
  const lampColor = r() < 0.7 ? 0xff9a2e : 0x29e7ff;
  for (const off of [15, 39, 63]) {
    lamp(p, ex0 + off, CURB, ez0 + 1, -1, lampColor);
    lamp(p, ex0 + off, CURB, ez1 - 1, 1, lampColor);
  }

  const bx0 = ex0 + INSET;
  const bz0 = ez0 + INSET;
  const bx1 = ex1 - INSET;
  const bz1 = ez1 - INSET;
  const district = valueNoise(cx / 5 + 100, cz / 5 + 100);
  const hs = 0.4 + 1.5 * district * district;
  const kind = r();
  const gap = 6;

  if (kind < 0.1) {
    plaza(p, r, bx0, bz0, bx1, bz1);
  } else if (kind < 0.38) {
    tower(p, r, bx0 + 3, bz0 + 3, bx1 - 3, bz1 - 3, (110 + r() * 170) * hs);
  } else if (kind < 0.7) {
    const alongX = r() < 0.5;
    for (let i = 0; i < 2; i++) {
      const h = Math.max(14, (40 + r() * 130) * hs);
      if (alongX) {
        const m = (bx0 + bx1) / 2;
        tower(p, r, i ? m + gap / 2 : bx0, bz0, i ? bx1 : m - gap / 2, bz1, h);
      } else {
        const m = (bz0 + bz1) / 2;
        tower(p, r, bx0, i ? m + gap / 2 : bz0, bx1, i ? bz1 : m - gap / 2, h);
      }
    }
  } else {
    const mx = (bx0 + bx1) / 2;
    const mz = (bz0 + bz1) / 2;
    for (let i = 0; i < 4; i++) {
      const h = Math.max(14, (25 + r() * 100) * hs);
      tower(
        p,
        r,
        i & 1 ? mx + gap / 2 : bx0,
        i & 2 ? mz + gap / 2 : bz0,
        i & 1 ? bx1 : mx - gap / 2,
        i & 2 ? bz1 : mz - gap / 2,
        h,
      );
    }
  }

  if (hash2(cx + 7919, cz - 104729) % 100 < 35) footbridge(p, x0, z0);
  return p;
}

/** The solid things in one city cell. Needs no browser, so the server can call it too. */
export function cellColliders(cx: number, cz: number): Collider[] {
  return buildParts(cx, cz).colliders;
}

function canvasTexture(canvas: HTMLCanvasElement, repeat: boolean, color = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const LIT_COLORS: [string, number][] = [
  ['#ffb469', 0.58], // warm tungsten
  ['#ffdcae', 0.74], // soft white
  ['#bfe6ff', 0.87], // cool office tubes
  ['#6fa8ff', 0.95], // a screen in a dark room
  ['#ff6fb0', 1], // neon spill
];

/**
 * Three matching textures for building faces: colour, the light coming out of lit windows,
 * and surface finish (green = roughness, blue = metalness), so glass shines and concrete does not.
 */
function makeFacadeTextures() {
  const size = 2048;
  const cell = size / TILE;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  };
  const colorC = make();
  const lightC = make();
  const finishC = make();
  const a = colorC.getContext('2d')!;
  const e = lightC.getContext('2d')!;
  const o = finishC.getContext('2d')!;
  const r = mulberry32(1234);

  // Weathered concrete: speckle, then long rain streaks.
  a.fillStyle = '#575c62';
  a.fillRect(0, 0, size, size);
  o.fillStyle = 'rgb(0, 228, 0)';
  o.fillRect(0, 0, size, size);
  e.fillStyle = '#000';
  e.fillRect(0, 0, size, size);
  for (let i = 0; i < 26000; i++) {
    a.fillStyle = r() < 0.6 ? `rgba(0,0,0,${0.03 + r() * 0.06})` : `rgba(255,255,255,${0.02 + r() * 0.03})`;
    a.fillRect(r() * size, r() * size, 1 + r() * 4, 1 + r() * 4);
  }
  for (let i = 0; i < 700; i++) {
    a.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.05})`;
    a.fillRect(r() * size, r() * size, 2 + r() * 9, 40 + r() * 320);
  }

  for (let j = 0; j < TILE; j++) {
    const busy = r() < 0.22 ? 0.42 : 0.11; // some floors are mostly lit, most are mostly dark
    for (let i = 0; i < TILE; i++) {
      const x0 = i * cell;
      const y0 = j * cell;
      // Spandrel band between floors, with a thin lip catching the light.
      a.fillStyle = 'rgba(0,0,0,0.2)';
      a.fillRect(x0, y0 + cell - 26, cell, 26);
      a.fillStyle = 'rgba(255,255,255,0.06)';
      a.fillRect(x0, y0 + cell - 27, cell, 1);

      const wx = x0 + 13;
      const wy = y0 + 14;
      const ww = cell - 26;
      const wh = cell - 46;
      // Aluminium frame, then the glass.
      a.fillStyle = '#1b1f23';
      a.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
      o.fillStyle = 'rgb(0, 120, 200)';
      o.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
      a.fillStyle = `hsl(210, 30%, ${4 + r() * 4}%)`;
      a.fillRect(wx, wy, ww, wh);
      o.fillStyle = `rgb(0, ${18 + Math.floor(r() * 22)}, 235)`;
      o.fillRect(wx, wy, ww, wh);
      a.fillStyle = 'rgba(255,255,255,0.09)';
      a.fillRect(wx - 5, wy + wh + 3, ww + 10, 2); // sill

      if (r() < busy) {
        // A lit room: brightest near the ceiling, with furniture and blinds breaking it up.
        const c = r();
        const color = LIT_COLORS.find(([, upTo]) => c <= upTo)![0];
        const bright = 0.35 + r() * 0.65;
        const grad = e.createLinearGradient(0, wy, 0, wy + wh);
        grad.addColorStop(0, color);
        grad.addColorStop(1, '#000');
        e.globalAlpha = bright;
        e.fillStyle = color;
        e.fillRect(wx, wy, ww, wh);
        e.globalAlpha = 1;
        const shade = e.createLinearGradient(0, wy, 0, wy + wh);
        shade.addColorStop(0, 'rgba(0,0,0,0)');
        shade.addColorStop(1, 'rgba(0,0,0,0.6)');
        e.fillStyle = shade;
        e.fillRect(wx, wy, ww, wh);
        void grad;
        const things = 1 + Math.floor(r() * 3);
        for (let k = 0; k < things; k++) {
          const fw = ww * (0.12 + r() * 0.3);
          const fh = wh * (0.2 + r() * 0.35);
          e.fillStyle = `rgba(0,0,0,${0.45 + r() * 0.4})`;
          e.fillRect(wx + r() * (ww - fw), wy + wh - fh, fw, fh);
        }
        if (r() < 0.4) {
          const drop = wh * (0.3 + r() * 0.7);
          e.fillStyle = 'rgba(0,0,0,0.4)';
          for (let y = 0; y < drop; y += 4) e.fillRect(wx, wy + y, ww, 2);
        } else if (r() < 0.3) {
          const cw = ww * (0.2 + r() * 0.3);
          e.fillStyle = 'rgba(0,0,0,0.55)';
          e.fillRect(r() < 0.5 ? wx : wx + ww - cw, wy, cw, wh);
        }
      }
      // Mullions: every window gets a centre bar, every other one a transom too.
      for (const ctx of [a, e]) {
        ctx.fillStyle = ctx === a ? '#1b1f23' : '#000';
        ctx.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
        if (i % 2 === 0) ctx.fillRect(wx, wy + wh * 0.3, ww, 3);
      }
    }
  }
  return {
    map: canvasTexture(colorC, true),
    emissive: canvasTexture(lightC, true),
    finish: canvasTexture(finishC, true, false),
  };
}

function makePoolTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.14)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return canvasTexture(c, false);
}

const SHADER_NOISE = /* glsl */ `
  float cityHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float cityNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cityHash(i), cityHash(i + vec2(1.0, 0.0)), f.x),
               mix(cityHash(i + vec2(0.0, 1.0)), cityHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

/** Pass each fragment's world position to a built-in material's shader. */
function withWorldPosition(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCityPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCityPos = (modelMatrix * vec4(position, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\nvarying vec3 vCityPos;\n${SHADER_NOISE}`,
  );
}

function makeSignAtlas(): THREE.CanvasTexture {
  const cw = 256;
  const ch = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cw * SIGN_COLS;
  canvas.height = ch * SIGN_ROWS;
  const ctx = canvas.getContext('2d')!;
  const r = mulberry32(99);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIGN_COLS * SIGN_ROWS; i++) {
    const x = (i % SIGN_COLS) * cw;
    const y = Math.floor(i / SIGN_COLS) * ch;
    const color = pick(r, SIGN_COLORS);
    const word = SIGN_WORDS[i % SIGN_WORDS.length];
    ctx.fillStyle = '#05070a';
    ctx.fillRect(x, y, cw, ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cw, ch);
    ctx.clip();
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    if (r() < 0.6) ctx.strokeRect(x + 10, y + 10, cw - 20, ch - 20);
    let px = 64;
    ctx.font = `700 ${px}px Syncopate, sans-serif`;
    const tw = ctx.measureText(word).width;
    px = Math.min(72, (px * (cw - 48)) / tw);
    ctx.font = `700 ${px}px Syncopate, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(word, x + cw / 2, y + ch / 2 + 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(word, x + cw / 2, y + ch / 2 + 2);
    ctx.restore();
  }
  return canvasTexture(canvas, false);
}

export class City {
  private chunks = new Map<string, Chunk>();
  private queue: [number, number][] = [];
  private centerKey = '';
  private near: Collider[] = [];
  private facadeMat: THREE.MeshStandardMaterial;
  private solidMat: THREE.MeshStandardMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private signMat: THREE.MeshBasicMaterial;
  private poolMat: THREE.MeshBasicMaterial;

  constructor(private scene: THREE.Scene) {
    const tex = makeFacadeTextures();
    this.facadeMat = new THREE.MeshStandardMaterial({
      map: tex.map,
      emissiveMap: tex.emissive,
      emissive: 0xffffff,
      emissiveIntensity: 1.5,
      roughnessMap: tex.finish,
      metalnessMap: tex.finish,
      roughness: 1,
      metalness: 1,
      vertexColors: true,
    });
    // The lower floors pick up the orange glow of the street.
    this.facadeMat.onBeforeCompile = (shader) => {
      withWorldPosition(shader);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.52, 0.24) * 0.9 * exp(-max(vCityPos.y, 0.0) / 9.0) * diffuseColor.rgb;`,
      );
    };
    // Pavement and trim: grimy, with paving joints, and wet in patches.
    this.solidMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.2,
      roughness: 0.5,
    });
    this.solidMat.onBeforeCompile = (shader) => {
      withWorldPosition(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float cityGrime = cityNoise(vCityPos.xz * 0.9) * 0.6 + cityNoise(vCityPos.xz * 6.0 + vCityPos.y * 3.0) * 0.4;
          diffuseColor.rgb *= 0.7 + 0.55 * cityGrime;
          float cityFlat = step(0.9, normalize(vNormal).y) * step(vCityPos.y, 0.5) * step(0.05, vCityPos.y);
          vec2 cityTile = abs(fract(vCityPos.xz / 1.6) - 0.5);
          diffuseColor.rgb *= 1.0 - 0.4 * cityFlat * smoothstep(0.485, 0.5, max(cityTile.x, cityTile.y));`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(0.18, 0.75, smoothstep(0.3, 0.7, cityGrime));`,
        );
    };
    this.poolMat = new THREE.MeshBasicMaterial({
      map: makePoolTexture(),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.poolMat.color.setScalar(2.2);
    // Light added to the scene should fade out in fog, not turn into fog-coloured squares.
    this.poolMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          gl_FragColor.rgb *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #endif`,
      );
    };
    const offset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    this.glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, ...offset });
    this.glowMat.color.setScalar(2.2);
    this.signMat = new THREE.MeshBasicMaterial({ map: makeSignAtlas(), ...offset });
    this.signMat.color.setScalar(1.8);
  }

  get chunkCount() {
    return this.chunks.size;
  }

  /** Load cells around the player, at most `budget` new ones per call. */
  update(px: number, pz: number, budget = 2) {
    const ccx = Math.floor(px / CELL);
    const ccz = Math.floor(pz / CELL);
    const key = `${ccx},${ccz}`;
    if (key !== this.centerKey) {
      this.centerKey = key;
      const R = VIEW_RADIUS;
      this.queue = [];
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dz * dz > R * R + 1) continue;
          if (!this.chunks.has(`${ccx + dx},${ccz + dz}`)) this.queue.push([ccx + dx, ccz + dz]);
        }
      }
      const dist = (c: [number, number]) => (c[0] - ccx) ** 2 + (c[1] - ccz) ** 2;
      this.queue.sort((a, b) => dist(b) - dist(a)); // nearest last, so pop() takes it
      const limit = (R + 1.5) ** 2;
      for (const [k, chunk] of this.chunks) {
        if ((chunk.cx - ccx) ** 2 + (chunk.cz - ccz) ** 2 > limit) {
          this.scene.remove(chunk.group);
          for (const m of chunk.group.children) (m as THREE.Mesh).geometry.dispose();
          this.chunks.delete(k);
        }
      }
    }
    while (budget-- > 0 && this.queue.length) {
      const [cx, cz] = this.queue.pop()!;
      this.build(cx, cz);
    }
  }

  private build(cx: number, cz: number) {
    const parts = buildParts(cx, cz);
    const group = new THREE.Group();
    const add = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
      if (!list.length) return;
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    };
    add(parts.facade, this.facadeMat);
    add(parts.solid, this.solidMat);
    add(parts.glow, this.glowMat);
    add(parts.signs, this.signMat);
    add(parts.pools, this.poolMat);
    this.scene.add(group);
    this.chunks.set(`${cx},${cz}`, { group, colliders: parts.colliders, cx, cz });
  }

  /** Colliders in the 3x3 cells around a position. The returned array is reused. */
  collidersNear(px: number, pz: number): Collider[] {
    const ccx = Math.floor(px / CELL);
    const ccz = Math.floor(pz / CELL);
    const out = this.near;
    out.length = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(`${ccx + dx},${ccz + dz}`);
        if (chunk) for (const c of chunk.colliders) out.push(c);
      }
    }
    return out;
  }
}
