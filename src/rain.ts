import * as THREE from 'three';

const COUNT = 3500;
const SPAN = 44; // horizontal size of the box of rain that follows the camera
const TALL = 36;
const STREAK = 0.75;

const wrap = (v: number, size: number) => ((v % size) + size) % size;

export function createRain(scene: THREE.Scene) {
  const seed = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    seed[i * 3] = Math.random() * SPAN;
    seed[i * 3 + 1] = Math.random() * TALL;
    seed[i * 3 + 2] = Math.random() * SPAN;
  }
  const pos = new Float32Array(COUNT * 6);
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0xa9c4d4,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      fog: false,
    }),
  );
  lines.frustumCulled = false;
  scene.add(lines);

  let t = 0;
  const base = lines.material.opacity;
  return {
    /** 0 stops the rain, 1 is normal, higher is a downpour. */
    setIntensity(mult: number) {
      lines.visible = mult > 0.01;
      lines.material.opacity = Math.min(0.7, base * mult);
    },
    update(cam: THREE.Vector3, dt: number) {
      t += dt;
      for (let i = 0; i < COUNT; i++) {
        const speed = 20 + (i % 7);
        const x = cam.x + wrap(seed[i * 3] - cam.x, SPAN) - SPAN / 2;
        const y = cam.y + wrap(seed[i * 3 + 1] - t * speed - cam.y, TALL) - TALL / 2;
        const z = cam.z + wrap(seed[i * 3 + 2] - cam.z, SPAN) - SPAN / 2;
        const o = i * 6;
        pos[o] = x;
        pos[o + 1] = y;
        pos[o + 2] = z;
        pos[o + 3] = x + 0.05;
        pos[o + 4] = y + STREAK;
        pos[o + 5] = z;
      }
      attr.needsUpdate = true;
    },
  };
}
