import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { studioLit } from './parts';

const SOLDIER_URL = '/models/soldier/Soldier.glb';
const RUN_CLIP_SPEED = 4.2; // ground speed, in m/s, at which the run animation's feet stop sliding

/** Animation state of one soldier. */
export interface SoldierAnim {
  mixer: THREE.AnimationMixer;
  idle: THREE.AnimationAction;
  run: THREE.AnimationAction;
  /** 0 standing, 1 running; eased between the two. */
  moving: number;
}

let loaded: { scene: THREE.Object3D; idle: THREE.AnimationClip; run: THREE.AnimationClip } | null = null;
let started = false;
const waiting: (() => void)[] = [];

/**
 * Fetch the animated soldier model once, shared by enemies and other players.
 * `onReady` runs when it arrives; it never runs if the model fails to load.
 */
export function loadSoldier(onReady: () => void) {
  if (loaded) return onReady();
  waiting.push(onReady);
  if (started) return;
  started = true;
  new GLTFLoader().load(
    SOLDIER_URL,
    (gltf) => {
      const idle = gltf.animations.find((c) => c.name === 'Idle');
      const run = gltf.animations.find((c) => c.name === 'Run');
      if (!idle || !run) return;
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false; // its bounds do not follow the animation
        if (!mesh.name.includes('visor')) studioLit(mesh.material as THREE.MeshStandardMaterial);
      });
      loaded = { scene: gltf.scene, idle, run };
      for (const fn of waiting.splice(0)) fn();
    },
    undefined,
    () => {},
  );
}

export const soldierReady = () => loaded !== null;

/** A soldier facing +z with the given visor material. Call only once `soldierReady()` is true. */
export function makeSoldier(visor: THREE.Material): { model: THREE.Group; anim: SoldierAnim } {
  const body = cloneSkinned(loaded!.scene);
  body.rotation.y = Math.PI; // the model is authored facing the other way
  body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.name.includes('visor')) mesh.material = visor;
  });
  const mixer = new THREE.AnimationMixer(body);
  const idle = mixer.clipAction(loaded!.idle);
  const run = mixer.clipAction(loaded!.run);
  idle.play();
  run.play();
  run.setEffectiveWeight(0);
  mixer.setTime(Math.random() * 2); // so a group does not move in step
  const model = new THREE.Group();
  model.add(body);
  return { model, anim: { mixer, idle, run, moving: 0 } };
}

/** Blend between standing and running, with the run cycle matched to ground speed. */
export function animateSoldier(a: SoldierAnim, moving: boolean, speed: number, dt: number) {
  a.moving += ((moving ? 1 : 0) - a.moving) * (1 - Math.exp(-10 * dt));
  a.run.setEffectiveWeight(a.moving);
  a.idle.setEffectiveWeight(1 - a.moving);
  a.run.setEffectiveTimeScale(Math.max(0.4, speed / RUN_CLIP_SPEED));
  a.mixer.update(dt);
}
