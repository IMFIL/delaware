import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Part } from './modspec';
import { buildModel, disposeModel, glowing, pbr, roundedBox, studioLit } from './parts';

/** Drawn only by the player's own camera, so the held item never shows up in reflections. */
export const HAND_LAYER = 1;
export const MAG_SIZE = 30;
const FIRE_EVERY = 0.16;
const RELOAD_TIME = 1.5;
const POOL = 12;
const DEFAULT_TRACER = 0xffb060;
const SPARK_RADIUS = 0.09;
const ARMS_URL = '/models/arms/arms_rig.glb';
const GLOVES_URL = '/models/arms/arms_gloves_01.png';
/** Where the held item sits in front of the camera; recoil and reload motions turn about this point. */
const PIVOT = new THREE.Vector3(0.14, -0.105, -0.36);
/** The fist pose the pistol is fitted into. */
const GRIP_CLIP = 'knife_idle';
/** How much larger than life the pistol is drawn, to suit the arms model's hands. */
const GUN_SCALE = 1.2;
/** Top of the pistol's grip, just under the slide, in the pistol's own coordinates: where the index finger and the web of the hand sit in a proper high hold. */
const GRIP_TOP = new THREE.Vector3(0, -0.026, 0.02);

interface Arms {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  action: THREE.AnimationAction | null;
  bones: Map<string, THREE.Object3D>;
}

interface Fx {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
  max: number;
}

/** Moments in a reload that make a sound. */
export type ReloadCue = 'magOut' | 'magIn' | 'rack';
const CUES: [number, ReloadCue][] = [
  [0.12, 'magOut'],
  [0.62, 'magIn'],
  [0.86, 'rack'],
];

const smooth = (t: number) => t * t * (3 - 2 * t);
/** 0 before `a`, 1 after `b`, eased in between. */
const ramp = (t: number, a: number, b: number) => smooth(Math.min(1, Math.max(0, (t - a) / (b - a))));

/** First-person sidearm: the model in the player's hand, its magazine, tracers and sparks. */
export class Weapon {
  /** Shots per second multiplier, set by mods. */
  rate = 1;
  /** Reload speed multiplier, set by mods. */
  reloadRate = 1;
  /** Rounds a full magazine holds; mods can change it. */
  magSize = MAG_SIZE;
  ammo = MAG_SIZE;

  private view = new THREE.Group(); // everything in front of the camera; moves with recoil and reloads
  private group = new THREE.Group(); // the item held rigidly, with the built-in glove
  private held = new THREE.Group(); // the item itself: sidearm or a mod's model, muzzle, flash
  private glove = new THREE.Group(); // built-in hand, used until the arms model loads
  private arms: Arms | null = null;
  private scene: THREE.Scene;
  private stock = new THREE.Group(); // the default sidearm
  private slide = new THREE.Group();
  private mag = new THREE.Group();
  private custom: THREE.Group | null = null; // a mod's replacement look
  private muzzle = new THREE.Object3D();
  private flash = new THREE.PointLight(0xffb060, 0, 14, 2);
  private cooldown = 0;
  private kick = 0;
  private bob = 0;
  private raise = 0; // 0 = lowered out of view, 1 = up
  private reloadT = -1; // seconds into a reload, or -1
  private cue = 0;
  private tracers: Fx[] = [];
  private sparks: Fx[] = [];
  private next = 0;
  private from = new THREE.Vector3();

  constructor(
    camera: THREE.Camera,
    scene: THREE.Scene,
    private onCue: (cue: ReloadCue) => void = () => {},
  ) {
    this.scene = scene;
    this.buildSidearm();
    this.buildHand();
    // A small light of its own, so the item never disappears in a dark alley.
    const fill = new THREE.PointLight(0xcfe0ff, 0.35, 1.2, 1.5);
    fill.position.set(-0.15, 0.2, 0.15);
    this.muzzle.position.set(0, 0.012, -0.2);
    this.flash.position.set(0, 0.03, -0.26);
    this.held.add(this.stock, this.muzzle, this.flash);
    this.group.add(this.held, this.glove);
    this.group.scale.setScalar(1.45);
    this.group.rotation.y = 0.07; // angled slightly inward so more of it shows
    this.view.add(this.group, fill);
    this.view.traverse((o) => o.layers.set(HAND_LAYER));
    camera.add(this.view);
    this.loadArms();

    const tracerGeo = new THREE.BoxGeometry(0.02, 0.02, 1).translate(0, 0, 0.5);
    const sparkGeo = new THREE.SphereGeometry(SPARK_RADIUS, 10, 8);
    for (let i = 0; i < POOL; i++) {
      for (const [pool, geo, max] of [
        [this.tracers, tracerGeo, 0.07],
        [this.sparks, sparkGeo, 0.14],
      ] as const) {
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
        );
        mesh.visible = false;
        mesh.frustumCulled = false;
        scene.add(mesh);
        pool.push({ mesh, life: 0, max });
      }
    }
  }

  /** A compact service pistol. -z is forward; the origin is where the slide meets the grip. */
  private buildSidearm() {
    const steel = pbr(0x8a939c, 'metal', { selfLit: 0.04, reflect: 0.7 });
    const dark = pbr(0x30353a, 'metal', { selfLit: 0.03, reflect: 0.5 });
    const polymer = pbr(0x24282c, 'satin', { selfLit: 0.05, reflect: 0.3 });
    const rubber = pbr(0x16191c, 'matte', { selfLit: 0.04, reflect: 0.2 });
    const dot = glowing(0x7dffa0, 1.6);
    const strip = glowing(0x29e7ff, 1.1);
    const add = (
      to: THREE.Object3D,
      geo: THREE.BufferGeometry,
      m: THREE.Material,
      x: number,
      y: number,
      z: number,
    ) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      to.add(mesh);
      return mesh;
    };
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    // Slide: the part that recoils. Bevelled top, grip serrations, ejection port, sights.
    const s = this.slide;
    add(s, roundedBox(0.03, 0.03, 0.2, 0.006), steel, 0, 0.016, -0.085);
    for (let i = 0; i < 7; i++) {
      for (const side of [-1, 1]) {
        add(s, box(0.0012, 0.02, 0.0028), dark, side * 0.0152, 0.016, -0.004 - i * 0.0062);
      }
    }
    add(s, box(0.013, 0.003, 0.034), rubber, 0.005, 0.0305, -0.085); // ejection port
    add(s, box(0.004, 0.006, 0.004), dark, 0, 0.034, -0.178); // front sight
    add(s, new THREE.SphereGeometry(0.0018, 8, 6), dot, 0, 0.0355, -0.1755);
    for (const side of [-1, 1]) {
      add(s, box(0.006, 0.006, 0.007), dark, side * 0.008, 0.034, 0.006); // rear sight posts
      add(s, new THREE.SphereGeometry(0.0016, 8, 6), dot, side * 0.008, 0.0355, 0.0098);
    }
    const barrel = add(s, new THREE.CylinderGeometry(0.0062, 0.0062, 0.016, 16), dark, 0, 0.014, -0.188);
    barrel.rotation.x = Math.PI / 2;
    const bore = add(s, new THREE.CylinderGeometry(0.004, 0.004, 0.017, 12), rubber, 0, 0.014, -0.1885);
    bore.rotation.x = Math.PI / 2;
    this.stock.add(s);

    // Frame, accessory rail, trigger guard and trigger.
    add(this.stock, roundedBox(0.027, 0.02, 0.165, 0.004), polymer, 0, -0.008, -0.075);
    for (let i = 0; i < 3; i++) {
      add(this.stock, box(0.029, 0.004, 0.006), polymer, 0, -0.02, -0.105 - i * 0.014);
    }
    add(this.stock, box(0.0285, 0.0016, 0.1), strip, 0, -0.001, -0.095); // light line under the slide
    const guard = new THREE.TorusGeometry(0.019, 0.003, 8, 20, Math.PI)
      .rotateZ(Math.PI)
      .rotateY(Math.PI / 2);
    add(this.stock, guard, polymer, 0, -0.018, -0.022);
    add(this.stock, box(0.005, 0.02, 0.005), dark, 0, -0.027, -0.018).rotation.x = 0.35;
    add(this.stock, box(0.012, 0.01, 0.016), polymer, 0, 0.006, 0.02); // beavertail

    // Grip, raked back, with textured side panels; the magazine sits inside it.
    const grip = new THREE.Group();
    grip.position.set(0, -0.016, 0.014);
    grip.rotation.x = 0.27;
    add(grip, roundedBox(0.029, 0.1, 0.046, 0.007), polymer, 0, -0.05, 0);
    for (const side of [-1, 1]) {
      add(grip, roundedBox(0.003, 0.07, 0.032, 0.001), rubber, side * 0.0145, -0.052, 0);
    }
    add(this.mag, roundedBox(0.02, 0.105, 0.032, 0.003), dark, 0, -0.05, 0);
    add(this.mag, roundedBox(0.03, 0.009, 0.05, 0.003), rubber, 0, -0.106, 0.001); // base plate
    grip.add(this.mag);
    this.stock.add(grip);
  }

  /**
   * Armoured right gauntlet holding the grip, seen from behind: the back of the hand lies along
   * the right side under a plate and knuckle guard, three jointed fingers wrap round the front,
   * a short thumb rests on the left, and a bracer runs back toward the bottom-right of the screen.
   */
  private buildHand() {
    const fabric = pbr(0x1d2126, 'matte', { selfLit: 0.07, reflect: 0.1 });
    const armour = pbr(0x56616c, 'metal', { selfLit: 0.04, reflect: 0.55 });
    const trim = pbr(0x2c333a, 'metal', { selfLit: 0.04, reflect: 0.4 });
    const light = glowing(0x29e7ff, 0.9);

    // Everything that touches the grip shares the grip's rake.
    const hand = new THREE.Group();
    hand.position.set(0, -0.016, 0.014);
    hand.rotation.x = 0.27;
    const block = (
      m: THREE.Material,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      ry = 0,
    ) => {
      const mesh = new THREE.Mesh(roundedBox(w, h, d, Math.min(w, h, d) * 0.3), m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      hand.add(mesh);
    };
    block(fabric, 0.022, 0.082, 0.062, 0.0262, -0.047, 0.006); // back of the hand, right side of the grip
    block(armour, 0.007, 0.06, 0.046, 0.0398, -0.045, 0.01); // plate over it
    block(light, 0.0015, 0.034, 0.003, 0.0437, -0.045, 0.01); // status light set into the plate
    block(armour, 0.013, 0.07, 0.014, 0.0362, -0.047, -0.021); // knuckle guard
    block(fabric, 0.046, 0.072, 0.022, 0.006, -0.05, 0.034); // heel, behind the backstrap
    for (let i = 0; i < 3; i++) {
      const y = -0.0255 - i * 0.0225;
      block(fabric, 0.017, 0.0195, 0.03, 0.0232, y, -0.014); // first joint, along the right side
      block(trim, 0.004, 0.015, 0.018, 0.0328, y, -0.036); // plate on the finger
      block(fabric, 0.036, 0.0195, 0.016, 0.003, y, -0.0312); // second joint, across the front
      block(fabric, 0.013, 0.018, 0.02, -0.0212, y, -0.019); // fingertip, on the left
    }
    block(fabric, 0.016, 0.018, 0.034, 0.0232, -0.002, -0.016); // trigger finger, laid along the frame
    block(fabric, 0.014, 0.016, 0.03, 0.021, 0.001, -0.046, 0.08);
    block(fabric, 0.02, 0.022, 0.03, -0.013, -0.008, 0.022, -0.5); // thumb: base, then one short joint
    block(fabric, 0.014, 0.016, 0.032, -0.0222, -0.002, -0.002);
    block(trim, 0.004, 0.012, 0.02, -0.0295, -0.002, -0.002);
    this.glove.add(hand);

    // Wrist, cuff and an armoured bracer, straight out of the heel of the hand.
    const up = new THREE.Vector3(0, 1, 0);
    const along = (
      geo: THREE.BufferGeometry,
      m: THREE.Material,
      a: [number, number, number],
      b: [number, number, number],
      at = 0.5,
    ) => {
      const from = new THREE.Vector3(...a);
      const dir = new THREE.Vector3(...b).sub(from);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.copy(from).addScaledVector(dir, at);
      mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      this.glove.add(mesh);
      return mesh;
    };
    const wrist: [number, number, number] = [0.014, -0.082, 0.056];
    const elbow: [number, number, number] = [0.085, -0.31, 0.44];
    along(new THREE.CylinderGeometry(0.026, 0.03, 0.06, 18), fabric, wrist, elbow, 0.05);
    along(new THREE.CylinderGeometry(0.038, 0.036, 0.022, 20), trim, wrist, elbow, 0.13);
    along(new THREE.CylinderGeometry(0.035, 0.047, 0.3, 20), armour, wrist, elbow, 0.52);
    along(new THREE.CylinderGeometry(0.0365, 0.04, 0.012, 20), trim, wrist, elbow, 0.3);
    // A light strip along the top of the bracer.
    const strip = along(new THREE.BoxGeometry(0.004, 0.16, 0.003), light, wrist, elbow, 0.5);
    strip.translateZ(-0.0415);
  }

  /** Fetch the sculpted, animated arms. Until they arrive, or if they fail, the built-in glove is used. */
  private loadArms() {
    new GLTFLoader().load(
      ARMS_URL,
      (gltf) => {
        const root = gltf.scene;
        const gloves = new THREE.TextureLoader().load(GLOVES_URL);
        gloves.flipY = false; // glTF convention
        gloves.colorSpace = THREE.SRGBColorSpace;
        const bones = new Map<string, THREE.Object3D>();
        root.traverse((o) => {
          o.layers.set(HAND_LAYER);
          bones.set(o.name, o);
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.frustumCulled = false; // its bounds do not follow the animation
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.map = gloves;
          studioLit(mat, 0.2, 0.12);
        });
        this.view.add(root);
        this.arms = { root, mixer: new THREE.AnimationMixer(root), clips: gltf.animations, action: null, bones };
        this.pose(GRIP_CLIP);
        this.arms.mixer.update(0);
        this.fitToHand(root, bones);
        this.glove.visible = false;
      },
      undefined,
      () => {},
    );
  }

  /**
   * Put the pistol in the right fist, then turn the whole arm so the pistol sits at the
   * pivot pointing forward. The clip is a closed fist, not a pistol hold, so the grip is
   * placed from where the knuckles and curled fingers are.
   */
  private fitToHand(root: THREE.Object3D, bones: Map<string, THREE.Object3D>) {
    this.view.updateWorldMatrix(true, true);
    const at = (name: string) => bones.get(name)!.getWorldPosition(new THREE.Vector3());
    const mean = (...names: string[]) =>
      names.reduce((sum, n) => sum.add(at(n)), new THREE.Vector3()).divideScalar(names.length);
    const wrist = at('handR');
    const knuckles = mean('f_index01R', 'f_middle01R', 'f_ring01R', 'f_pinky01R');
    const curled = mean('f_index02R', 'f_middle02R', 'f_ring02R', 'f_pinky02R');
    // Barrel runs from wrist to knuckles; the grip runs from the index knuckle down to the little finger.
    const forward = knuckles.clone().sub(wrist).normalize();
    const up = at('f_index01R').sub(at('f_pinky01R')).normalize();
    const z = forward.clone().negate();
    const x = up.clone().cross(z).normalize();
    const y = z.clone().cross(x);
    const holder = new THREE.Group();
    holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    holder.scale.setScalar(GUN_SCALE);
    // The grip runs through the fist, between the palm and the curled fingers, and the hand
    // rides high on it: the top of the grip lines up with the top of the fist.
    const palm = wrist.clone().add(knuckles).multiplyScalar(0.5);
    const fistHeight = at('f_index01R').distanceTo(at('f_pinky01R'));
    const top = palm.lerp(curled, 0.5).addScaledVector(y, fistHeight * 0.5 + 0.004);
    holder.position.copy(top).sub(GRIP_TOP.clone().multiplyScalar(GUN_SCALE).applyQuaternion(holder.quaternion));
    this.scene.add(holder);
    holder.updateMatrixWorld();
    bones.get('handR')!.attach(holder);

    // Now move the arm so the pistol lands on the pivot, pointing ahead and angled slightly inward.
    this.view.updateWorldMatrix(true, true);
    const one = new THREE.Vector3(1, 1, 1);
    const hp = new THREE.Vector3();
    const hq = new THREE.Quaternion();
    holder.matrixWorld.decompose(hp, hq, new THREE.Vector3());
    const have = new THREE.Matrix4().compose(hp, hq, one).premultiply(this.view.matrixWorld.clone().invert());
    const want = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.07, 0)),
      one,
    );
    want.multiply(have.invert()).decompose(root.position, root.quaternion, new THREE.Vector3());

    this.group.remove(this.held);
    holder.add(this.held);
    holder.traverse((o) => o.layers.set(HAND_LAYER));
  }

  /** Hold one of the arms model's animation clips. */
  pose(name: string) {
    const arms = this.arms;
    const clip = arms?.clips.find((c) => c.name === name);
    if (!arms || !clip) return;
    arms.action?.stop();
    arms.action = arms.mixer.clipAction(clip);
    arms.action.play();
  }

  /** Swap the held item's look for one built from parts, or pass null for the default sidearm. */
  setModel(parts: Part[] | null) {
    if (this.custom) {
      this.held.remove(this.custom);
      disposeModel(this.custom);
      this.custom = null;
    }
    if (parts?.length) {
      // Darkened and barely reflective: the hand's own light sits close, so pale glossy
      // parts would otherwise blow out to white.
      this.custom = buildModel(parts, 0.5, 0.03, 0.18);
      // Mod models are authored at real-world size; the hand is drawn enlarged, so undo that.
      this.custom.scale.setScalar(0.9 / 1.45);
      this.custom.traverse((o) => o.layers.set(HAND_LAYER));
      this.held.add(this.custom);
    }
    this.stock.visible = !this.custom;
  }

  /** Change how many rounds a magazine holds. Rounds beyond a smaller magazine are lost. */
  setMagSize(rounds: number) {
    this.magSize = Math.max(1, Math.round(rounds));
    if (this.ammo > this.magSize) this.ammo = this.magSize;
  }

  get reloading() {
    return this.reloadT >= 0;
  }

  ready() {
    return this.cooldown <= 0 && this.raise > 0.9 && !this.reloading && this.ammo > 0;
  }

  /** True when the trigger is pulled on an empty magazine and nothing else is going on. */
  dry() {
    return this.cooldown <= 0 && this.raise > 0.9 && !this.reloading && this.ammo <= 0;
  }

  /** Start swapping the magazine. Does nothing if it is already full or a reload is under way. */
  reload() {
    if (this.reloading || this.ammo >= this.magSize || this.raise < 0.5) return;
    this.reloadT = 0;
    this.cue = 0;
  }

  /** Use one round and start the recoil. Call `trace` for each pellet the shot produces. */
  spend() {
    this.ammo--;
    this.cooldown = FIRE_EVERY / this.rate;
    this.kick = 1;
    this.flash.intensity = 30;
  }

  /**
   * Show a shot from the muzzle to `to`. `hit` is false when the shot went off into the distance.
   * `blast` is an explosion radius in metres, or 0. `from` is where a bounced shot sets off again.
   */
  trace(
    to: THREE.Vector3,
    hit: boolean,
    color: string | number = DEFAULT_TRACER,
    blast = 0,
    from?: THREE.Vector3,
  ) {
    if (from) this.from.copy(from);
    else this.muzzle.getWorldPosition(this.from);
    const i = this.next++ % POOL;
    const tr = this.tracers[i];
    tr.mesh.material.color.set(color).multiplyScalar(3);
    tr.mesh.position.copy(this.from);
    tr.mesh.lookAt(to);
    tr.mesh.scale.z = this.from.distanceTo(to);
    tr.life = tr.max;
    tr.mesh.visible = true;
    if (hit) {
      const sp = this.sparks[i];
      sp.mesh.material.color.set(color).multiplyScalar(3);
      sp.mesh.position.copy(to);
      sp.mesh.scale.setScalar(blast > 0 ? (blast * 0.7) / SPARK_RADIUS : 1);
      sp.max = sp.life = blast > 0 ? 0.28 : 0.14;
      sp.mesh.visible = true;
    }
  }

  update(dt: number, equipped: boolean, speed: number) {
    this.cooldown -= dt;
    this.kick = Math.max(0, this.kick - dt * 9);
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 500);
    this.raise += ((equipped ? 1 : 0) - this.raise) * (1 - Math.exp(-14 * dt));
    this.bob += dt * Math.min(speed, 8) * 1.8;
    const sway = Math.min(speed / 5, 1);
    this.view.visible = this.raise > 0.02;
    if (this.arms) {
      this.arms.mixer.update(dt);
      this.arms.bones.get('upper_armL')?.scale.setScalar(0.0001); // only the gun hand is shown
    }

    // Reload: tilt the gun, drop the magazine, seat a fresh one, rack the slide.
    let tilt = 0;
    let drop = 0;
    let rack = 0;
    if (this.reloading) {
      if (!equipped) {
        this.reloadT = -1; // putting the gun away cancels the reload
      } else {
        this.reloadT += dt * this.reloadRate;
        const t = this.reloadT / RELOAD_TIME;
        while (this.cue < CUES.length && t >= CUES[this.cue][0]) this.onCue(CUES[this.cue++][1]);
        tilt = ramp(t, 0, 0.14) * (1 - ramp(t, 0.72, 0.95));
        drop = ramp(t, 0.1, 0.3) * (1 - ramp(t, 0.46, 0.64));
        rack = ramp(t, 0.82, 0.88) * (1 - ramp(t, 0.88, 0.97));
        if (t >= 1) {
          this.reloadT = -1;
          this.ammo = this.magSize;
        }
      }
    }
    this.mag.position.y = -drop * 0.2;
    this.mag.visible = drop < 0.98;
    // The slide snaps back with each shot, and locks back on an empty magazine.
    const empty = this.ammo <= 0 && !this.reloading ? 1 : 0;
    this.slide.position.z = Math.max(this.kick * 0.03, rack * 0.035, empty * 0.03);

    this.view.position.set(
      PIVOT.x + Math.sin(this.bob) * 0.006 * sway - tilt * 0.04,
      PIVOT.y - (1 - this.raise) * 0.4 + Math.abs(Math.cos(this.bob)) * 0.006 * sway + tilt * 0.03,
      PIVOT.z + this.kick * 0.035,
    );
    this.view.rotation.set(
      this.kick * 0.16 - (1 - this.raise) * 0.9 + tilt * 0.45,
      tilt * 0.25,
      -tilt * 0.75,
    );

    for (const pool of [this.tracers, this.sparks]) {
      for (const fx of pool) {
        if (fx.life <= 0) continue;
        fx.life -= dt;
        fx.mesh.material.opacity = Math.max(0, fx.life / fx.max);
        if (fx.life <= 0) fx.mesh.visible = false;
      }
    }
  }
}
