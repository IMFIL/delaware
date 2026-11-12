import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Finish, Part } from './modspec';

/** Surface finishes a part can have: how rough and how metallic it is. */
const FINISHES: Record<Finish, { roughness: number; metalness: number }> = {
  matte: { roughness: 0.92, metalness: 0 },
  satin: { roughness: 0.55, metalness: 0 },
  gloss: { roughness: 0.14, metalness: 0 },
  metal: { roughness: 0.38, metalness: 0.9 },
  chrome: { roughness: 0.07, metalness: 1 },
};

let studio: THREE.Texture | null = null;
const waiting: THREE.MeshStandardMaterial[] = []; // made before the surround existed

/**
 * Characters and held items reflect a soft studio-style surround instead of the black night sky,
 * so metal and gloss read as metal and gloss. Call once after the renderer exists.
 */
export function initModelLighting(renderer: THREE.WebGLRenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  for (const m of waiting) {
    m.envMap = studio;
    m.needsUpdate = true;
  }
  waiting.length = 0;
}

/** A physically based material lit by the studio surround. */
export function pbr(
  color: THREE.ColorRepresentation,
  finish: Finish,
  opts: { tint?: number; selfLit?: number; reflect?: number } = {},
): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  const f = FINISHES[finish] ?? FINISHES.satin;
  const m = new THREE.MeshStandardMaterial({
    color: c.clone().multiplyScalar(opts.tint ?? 1),
    roughness: f.roughness,
    metalness: f.metalness,
    emissive: c.clone().multiplyScalar(opts.selfLit ?? 0),
    envMap: studio,
    envMapIntensity: opts.reflect ?? 0.45,
  });
  if (!studio) waiting.push(m);
  return m;
}

/** Light a loaded model's own material with the studio surround, and let its texture glow faintly. */
export function studioLit(m: THREE.MeshStandardMaterial, reflect = 0.5, selfLit = 0.08) {
  m.envMap = studio;
  m.envMapIntensity = reflect;
  if (m.map) {
    m.emissiveMap = m.map;
    m.emissive.setScalar(selfLit);
  }
  if (!studio) waiting.push(m);
  m.needsUpdate = true;
}

/** A material that gives off light and blooms. */
export function glowing(color: THREE.ColorRepresentation, strength = 1.5): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color });
  m.color.multiplyScalar(strength);
  return m;
}

export const roundedBox = (w: number, h: number, d: number, radius?: number) =>
  new RoundedBoxGeometry(w, h, d, 3, radius ?? Math.min(w, h, d) * 0.22);

function partGeometry(p: Part): THREE.BufferGeometry {
  switch (p.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(0.5, 28, 18).scale(p.sx, p.sy, p.sz);
    case 'cylinder': {
      // sz is the diameter at the top; left tiny or equal, the cylinder is straight.
      const top = p.sz < 0.011 ? p.sx : p.sz;
      return new THREE.CylinderGeometry(top / 2, p.sx / 2, p.sy, 28);
    }
    case 'cone':
      return new THREE.ConeGeometry(p.sx / 2, p.sy, 28);
    case 'torus':
      return new THREE.TorusGeometry(Math.max(0.005, (p.sx - p.sy) / 2), p.sy / 2, 12, 36);
    case 'capsule': {
      const r = p.sx / 2;
      return new THREE.CapsuleGeometry(r, Math.max(0.001, p.sy - p.sx), 8, 20);
    }
    case 'roundbox':
      return roundedBox(p.sx, p.sy, p.sz);
    default:
      return new THREE.BoxGeometry(p.sx, p.sy, p.sz);
  }
}

function partMesh(p: Part, tint: number, selfLit: number, reflect: number): THREE.Mesh {
  const mat = p.glow ? glowing(p.color) : pbr(p.color, p.finish, { tint, selfLit, reflect });
  const mesh = new THREE.Mesh(partGeometry(p), mat);
  mesh.position.set(p.x, p.y, p.z);
  const rad = Math.PI / 180;
  mesh.rotation.set(p.rx * rad, p.ry * rad, p.rz * rad);
  return mesh;
}

/**
 * Build a model from a mod's list of primitive parts.
 * `tint` scales the colours, `selfLit` is how much each part glows on its own, and
 * `reflect` is how strongly it mirrors its surroundings.
 */
export function buildModel(parts: Part[], tint = 0.8, selfLit = 0.05, reflect = 0.35): THREE.Group {
  const group = new THREE.Group();
  for (const p of parts) group.add(partMesh(p, tint, selfLit, reflect));
  return group;
}

/** Free a model built by `buildModel`. Clones made from it share its geometry, so free it once. */
export function disposeModel(group: THREE.Group) {
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}
