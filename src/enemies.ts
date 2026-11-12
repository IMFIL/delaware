import * as THREE from 'three';
import type { City } from './city';
import {
  DEATH_BLAST_RADIUS,
  EnemySim,
  HEIGHT,
  MAX_HP,
  raycastEnemies,
  type EnemyState,
  type EnemyTuning,
  type Point,
} from './enemysim';
import type { Part } from './modspec';
import type { Tier } from './zones';
import { buildModel, disposeModel, pbr, roundedBox } from './parts';
import { animateSoldier, loadSoldier, makeSoldier, soldierReady, type SoldierAnim } from './soldier';
import { HAND_LAYER } from './weapon';

export type { EnemyTuning } from './enemysim';

const BAR_WIDTH = 0.9;
const BAR_HEIGHT = 0.085;
const DYING_TIME = 0.25;

/** How the game reaches enemies that a server is running. */
export interface RemoteEnemies {
  hit(id: number, amount: number, head: boolean): void;
  blast(at: Point, radius: number, amount: number): void;
}

/** One enemy as reported by the server: id, x, y, z, facing, hp, flags, pace, lift, tier. */
export type EnemyRow = [number, number, number, number, number, number, number, number, number, number];

const armor = pbr(0x6b7680, 'metal', { selfLit: 0.03, reflect: 0.6 });
const plate = pbr(0x39414a, 'metal', { selfLit: 0.03, reflect: 0.5 });
const suit = pbr(0x14171a, 'matte', { selfLit: 0.06, reflect: 0.15 });
const eye = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
eye.color.multiplyScalar(2.6);

/** Visor colour by difficulty tier: red, amber, then violet-white for the dangerous ones. */
const tierEyes = [0xff2a2a, 0xffa01e, 0xd58bff].map((color, i) => {
  const m = new THREE.MeshBasicMaterial({ color });
  m.color.multiplyScalar(i === 2 ? 3.2 : 2.6);
  return m;
});

const barOpts = { transparent: true, depthWrite: false, fog: false } as const;
const barBack = new THREE.SpriteMaterial({ color: 0x05070a, opacity: 0.75, ...barOpts });
/** Fill colours from healthy to nearly dead. */
const barFills = [0x5dff8a, 0xffb02e, 0xff3b3b].map((color) => new THREE.SpriteMaterial({ color, ...barOpts }));

/** A health bar that always faces the player. Drawn only for the player, not in reflections. */
export function makeBar() {
  const back = new THREE.Sprite(barBack);
  back.scale.set(BAR_WIDTH + 0.04, BAR_HEIGHT + 0.04, 1);
  const fill = new THREE.Sprite(barFills[0]);
  for (const sprite of [back, fill]) {
    sprite.position.y = HEIGHT + 0.24;
    sprite.layers.set(HAND_LAYER);
  }
  back.renderOrder = 10;
  fill.renderOrder = 11;
  return { back, fill };
}

/** Show how much health is left, draining from the right. */
export function setBar(bar: { back: THREE.Sprite; fill: THREE.Sprite }, fraction: number) {
  const f = Math.min(1, Math.max(0, fraction));
  bar.fill.visible = f > 0.001;
  if (!bar.fill.visible) return;
  bar.fill.material = barFills[f > 0.6 ? 0 : f > 0.3 ? 1 : 2];
  bar.fill.scale.set(BAR_WIDTH * f, BAR_HEIGHT, 1);
  // A sprite always faces the camera, so it cannot simply be slid sideways: shifting its
  // anchor keeps the left end fixed while the bar shortens.
  bar.fill.center.set(0.5 / f, 0.5);
}

/** Make the enemies' glowing parts show through walls. */
export function setEnemyHighlight(on: boolean) {
  for (const m of [eye, ...tierEyes]) {
    m.depthTest = !on;
    m.transparent = on; // drawn after the buildings, so they cannot cover it
  }
}

const ball = (r: number, sx = 1, sy = 1, sz = 1) => new THREE.SphereGeometry(r, 24, 16).scale(sx, sy, sz);
const GEO = {
  pelvis: roundedBox(0.34, 0.16, 0.2),
  belt: new THREE.CylinderGeometry(0.176, 0.182, 0.05, 20).scale(1, 1, 0.7),
  abdomen: new THREE.CylinderGeometry(0.17, 0.15, 0.24, 20).scale(1, 1, 0.72),
  chest: ball(0.5, 0.54, 0.46, 0.34),
  chestPlate: roundedBox(0.36, 0.24, 0.1, 0.04),
  core: new THREE.CylinderGeometry(0.035, 0.035, 0.02, 16).rotateX(Math.PI / 2),
  pack: roundedBox(0.26, 0.3, 0.1),
  spine: new THREE.BoxGeometry(0.04, 0.22, 0.02),
  neck: new THREE.CylinderGeometry(0.055, 0.065, 0.1, 12),
  head: ball(0.5, 0.25, 0.3, 0.27),
  jaw: roundedBox(0.16, 0.1, 0.16),
  // A glowing band wrapped round the front of the head.
  visor: new THREE.TorusGeometry(0.118, 0.02, 8, 24, Math.PI * 0.9)
    .rotateZ(Math.PI * 0.05)
    .rotateX(Math.PI / 2),
  pauldron: ball(0.105, 1, 0.85, 1),
  upperArm: new THREE.CapsuleGeometry(0.055, 0.2, 6, 12),
  forearm: new THREE.CapsuleGeometry(0.05, 0.2, 6, 12),
  hand: roundedBox(0.07, 0.1, 0.05),
  thigh: new THREE.CapsuleGeometry(0.082, 0.26, 6, 14),
  kneeCap: ball(0.065),
  shin: new THREE.CapsuleGeometry(0.068, 0.26, 6, 14),
  foot: roundedBox(0.11, 0.08, 0.27, 0.03),
  bolt: new THREE.SphereGeometry(0.14, 10, 8),
  blast: new THREE.SphereGeometry(1, 16, 12),
};

/** The joints that move when an enemy walks or strikes. Index 0 is its right side. */
interface Rig {
  body: THREE.Group;
  hips: THREE.Group[];
  knees: THREE.Group[];
  shoulders: THREE.Group[];
  elbows: THREE.Group[];
}

/** A humanoid combat android about 1.95 m tall, facing +z. Used until the soldier model loads. */
function makeStock() {
  const stock = new THREE.Group();
  const mesh = (to: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    to.add(m);
  };
  const joint = (to: THREE.Object3D, x: number, y: number, z: number) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    to.add(g);
    return g;
  };
  const body = joint(stock, 0, 0, 0);
  mesh(body, GEO.pelvis, suit, 0, 0.98, 0);
  mesh(body, GEO.belt, plate, 0, 1.05, 0);
  mesh(body, GEO.abdomen, suit, 0, 1.17, 0);
  mesh(body, GEO.chest, armor, 0, 1.4, 0);
  mesh(body, GEO.chestPlate, plate, 0, 1.43, 0.105);
  mesh(body, GEO.core, eye, 0, 1.43, 0.16);
  mesh(body, GEO.pack, plate, 0, 1.4, -0.15);
  mesh(body, GEO.spine, eye, 0, 1.4, -0.205);
  mesh(body, GEO.neck, suit, 0, 1.63, 0);
  mesh(body, GEO.head, armor, 0, 1.79, 0);
  mesh(body, GEO.jaw, plate, 0, 1.72, 0.05);
  mesh(body, GEO.visor, eye, 0, 1.81, 0);

  const rig: Rig = { body, hips: [], knees: [], shoulders: [], elbows: [] };
  for (const side of [-1, 1]) {
    const shoulder = joint(body, side * 0.3, 1.53, 0);
    mesh(shoulder, GEO.pauldron, armor, 0, 0.01, 0);
    mesh(shoulder, GEO.upperArm, suit, 0, -0.17, 0);
    const elbow = joint(shoulder, 0, -0.33, 0);
    mesh(elbow, GEO.forearm, armor, 0, -0.15, 0);
    mesh(elbow, GEO.hand, suit, 0, -0.33, 0);
    rig.shoulders.push(shoulder);
    rig.elbows.push(elbow);

    const hip = joint(stock, side * 0.11, 0.96, 0);
    mesh(hip, GEO.thigh, armor, 0, -0.21, 0);
    const knee = joint(hip, 0, -0.44, 0);
    mesh(knee, GEO.kneeCap, plate, 0, 0, 0.035);
    mesh(knee, GEO.shin, armor, 0, -0.2, 0);
    mesh(knee, GEO.foot, plate, 0, -0.45, 0.05);
    rig.hips.push(hip);
    rig.knees.push(knee);
  }
  return { stock, rig };
}

/** Pose the joints for this instant of a walk cycle, a strike, or standing still. */
function pose(rig: Rig, stride: number, moving: boolean, striking: boolean) {
  const s = moving ? Math.sin(stride) : 0;
  const c = moving ? Math.cos(stride) : 0;
  for (let i = 0; i < 2; i++) {
    const side = i ? -1 : 1; // the two legs are half a cycle apart
    rig.hips[i].rotation.x = -s * side * 0.65;
    rig.knees[i].rotation.x = moving ? 0.12 + Math.max(0, c * side) * 0.95 : 0.04;
    // Arms swing against the legs, or reach forward to strike.
    rig.shoulders[i].rotation.x = striking ? -1.35 + s * 0.15 : s * side * 0.5;
    rig.elbows[i].rotation.x = striking ? -0.2 : -0.25 - Math.max(0, -s * side) * 0.4;
  }
  rig.body.position.y = moving ? Math.abs(c) * 0.025 : 0;
}

/** One enemy on screen: its state, wherever that comes from, plus everything drawn for it. */
export class EnemyView {
  group = new THREE.Group();
  stock = new THREE.Group();
  custom: THREE.Object3D | null = null;
  bar = makeBar();
  /** Joints of the built-in android, or null when the soldier model is used instead. */
  rig: Rig | null = null;
  anim: SoldierAnim | null = null;
  stride = Math.random() * 6;
  /** Where the server last said it was; a reported enemy glides toward this. */
  goal: { x: number; y: number; z: number; facing: number } | null = null;

  constructor(public state: EnemyState) {
    this.group.add(this.bar.back, this.bar.fill);
  }

  get body() {
    return this.state.body;
  }
  get hp() {
    return this.state.hp;
  }
  set hp(v: number) {
    this.state.hp = v;
  }
}

interface Blast {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

/**
 * Draws the enemies and lets the player shoot them. Solo, it also runs them; in a shared
 * game the server runs them and this only shows what the server reports.
 */
export class Enemies {
  private views = new Map<number, EnemyView>();
  private sim: EnemySim;
  private remote: RemoteEnemies | null = null;
  private size = 1;
  private template: THREE.Group | null = null; // a mod's replacement look, cloned per enemy
  private boltMeshes: THREE.Mesh[] = [];
  private blasts: Blast[] = [];
  private reportedBolts: number[][] = [];
  private nextLocalId = -1;

  constructor(
    private scene: THREE.Scene,
    city: City,
  ) {
    this.sim = new EnemySim((x, z) => city.collidersNear(x, z));
    const boltMat = new THREE.MeshBasicMaterial({ color: 0xff5a2a });
    boltMat.color.multiplyScalar(3);
    for (let i = 0; i < 40; i++) {
      const mesh = new THREE.Mesh(GEO.bolt, boltMat);
      mesh.visible = false;
      scene.add(mesh);
      this.boltMeshes.push(mesh);
    }
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, depthWrite: false });
      mat.color.multiplyScalar(2.5);
      const mesh = new THREE.Mesh(GEO.blast, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.blasts.push({ mesh, life: 0 });
    }
    // Until the soldier model arrives, or if it fails, enemies are the built-in android.
    loadSoldier(() => {
      for (const v of this.views.values()) this.embody(v);
    });
  }

  /** Every enemy currently shown. */
  get list(): EnemyView[] {
    return [...this.views.values()];
  }

  /** Hand the enemies over to a server (pass the link), or take them back for solo play (pass null). */
  setRemote(link: RemoteEnemies | null) {
    if (link === this.remote) return;
    this.remote = link;
    this.sim.clear();
    this.reportedBolts = [];
    for (const id of [...this.views.keys()]) this.removeView(id);
  }

  /** Take in the server's latest report of every enemy and bolt. */
  applySnapshot(size: number, rows: EnemyRow[], bolts: number[][]) {
    if (!this.remote) return;
    this.size = size;
    this.reportedBolts = bolts;
    const seen = new Set<number>();
    for (const [id, x, y, z, facing, hp, flags, pace, lift, tier] of rows) {
      seen.add(id);
      let v = this.views.get(id);
      if (!v) {
        v = this.addView({
          id,
          body: { x, y, z },
          hp,
          facing,
          lift,
          moving: false,
          striking: false,
          flash: 0,
          dying: 0,
          pace,
          tier: (tier === 1 || tier === 2 ? tier : 0) as Tier,
        });
      }
      const s = v.state;
      if (hp < s.hp) s.flash = 1; // someone hurt it
      s.hp = hp;
      s.moving = (flags & 1) !== 0;
      s.striking = (flags & 2) !== 0;
      if (flags & 4 && s.dying <= 0) s.dying = DYING_TIME;
      s.pace = pace;
      s.lift = lift;
      v.goal = { x, y, z, facing };
    }
    for (const [id, v] of this.views) {
      // The server stops reporting an enemy once it is gone; let a dying one finish shrinking.
      if (!seen.has(id) && v.state.dying <= 0) this.removeView(id);
    }
  }

  /** Swap every enemy's look for one built from parts, or pass null for the default soldier. */
  setModel(parts: Part[] | null) {
    if (this.template) disposeModel(this.template);
    this.template = parts?.length ? buildModel(parts) : null;
    for (const v of this.views.values()) this.dress(v);
  }

  private dress(v: EnemyView) {
    if (v.custom) v.group.remove(v.custom);
    v.custom = this.template ? this.template.clone() : null;
    if (v.custom) v.group.add(v.custom);
    v.stock.visible = !v.custom;
  }

  /** Give an enemy its default body: the soldier if it has loaded, otherwise the android. */
  private embody(v: EnemyView) {
    v.group.remove(v.stock);
    if (soldierReady()) {
      const { model, anim } = makeSoldier(tierEyes[v.state.tier] ?? eye);
      v.stock = model;
      v.rig = null;
      v.anim = anim;
    } else {
      const { stock, rig } = makeStock();
      v.stock = stock;
      v.rig = rig;
      v.anim = null;
    }
    v.group.add(v.stock);
    v.stock.visible = !v.custom;
  }

  private addView(state: EnemyState): EnemyView {
    const v = new EnemyView(state);
    this.embody(v);
    this.dress(v);
    v.group.position.set(state.body.x, state.body.y, state.body.z);
    this.scene.add(v.group);
    this.views.set(state.id, v);
    return v;
  }

  private removeView(id: number) {
    const v = this.views.get(id);
    if (!v) return;
    this.scene.remove(v.group);
    this.views.delete(id);
  }

  /** Put an enemy at a spot. In a shared game the server decides where enemies are, so this does nothing lasting. */
  spawnAt(x: number, z: number): EnemyView {
    if (this.remote) {
      return new EnemyView({
        id: this.nextLocalId--,
        body: { x, y: 0, z },
        hp: MAX_HP,
        facing: 0,
        lift: 0,
        moving: false,
        striking: false,
        flash: 0,
        dying: 0,
        pace: 0,
        tier: 0,
      });
    }
    return this.addView(this.sim.spawnAt(x, z));
  }

  /**
   * Advance and draw every enemy. Solo, returns the damage they dealt to the player this
   * frame; in a shared game that arrives from the server instead, so this returns 0.
   */
  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    targetAlive: boolean,
    kills: number,
    tune: EnemyTuning,
  ): number {
    let damage = 0;
    if (this.remote) {
      const ease = 1 - Math.exp(-12 * dt);
      for (const [id, v] of this.views) {
        const s = v.state;
        if (v.goal) {
          const b = s.body;
          b.x += (v.goal.x - b.x) * ease;
          b.y += (v.goal.y - b.y) * ease;
          b.z += (v.goal.z - b.z) * ease;
          let turn = v.goal.facing - s.facing;
          turn = Math.atan2(Math.sin(turn), Math.cos(turn));
          s.facing += turn * ease;
        }
        s.flash = Math.max(0, s.flash - dt * 6);
        if (s.dying > 0) {
          s.dying -= dt;
          if (s.dying <= 0) {
            this.removeView(id);
            continue;
          }
        }
      }
    } else {
      this.size = tune.size;
      const step = this.sim.update(dt, [{ id: 'me', x: px, y: py, z: pz, alive: targetAlive }], kills, tune);
      damage = step.damage.get('me') ?? 0;
      for (const at of step.blasts) this.showBlast(at);
      const alive = new Set<number>();
      for (const e of this.sim.list) {
        alive.add(e.id);
        if (!this.views.has(e.id)) this.addView(e);
      }
      for (const id of [...this.views.keys()]) if (!alive.has(id)) this.removeView(id);
    }

    for (const v of this.views.values()) this.draw(v, dt);
    this.drawBolts();
    for (const blast of this.blasts) {
      if (blast.life <= 0) continue;
      blast.life -= dt;
      const k = Math.max(0, blast.life / 0.3);
      blast.mesh.scale.setScalar(DEATH_BLAST_RADIUS * (1 - k * 0.7));
      blast.mesh.material.opacity = k * 0.8;
      if (blast.life <= 0) blast.mesh.visible = false;
    }
    return damage;
  }

  private draw(v: EnemyView, dt: number) {
    const s = v.state;
    const shrink = s.dying > 0 ? Math.max(0, s.dying / DYING_TIME) : 1;
    setBar(v.bar, s.dying > 0 ? 0 : s.hp / MAX_HP);
    v.group.scale.setScalar(this.size * shrink);
    v.group.position.set(s.body.x, s.body.y + s.lift, s.body.z);
    v.group.rotation.set(-s.flash * 0.2, s.facing, 0, 'YXZ'); // flinch back when hit
    if (s.moving) v.stride += dt * s.pace * 2.4;
    if (v.rig) pose(v.rig, v.stride, s.moving, s.striking);
    else if (v.anim && v.stock.visible) animateSoldier(v.anim, s.moving, s.pace, dt);
  }

  private drawBolts() {
    const bolts = this.remote ? this.reportedBolts : this.sim.bolts.map((b) => [b.x, b.y, b.z]);
    this.boltMeshes.forEach((mesh, i) => {
      const b = bolts[i];
      mesh.visible = !!b;
      if (b) mesh.position.set(b[0], b[1], b[2]);
    });
  }

  /** Show an enemy's death explosion. */
  showBlast(at: Point) {
    const blast = this.blasts.find((b) => b.life <= 0) ?? this.blasts[0];
    blast.mesh.position.set(at[0], at[1], at[2]);
    blast.mesh.visible = true;
    blast.life = 0.3;
  }

  /** First living enemy along a ray, closer than `max`. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number) {
    const states = [...this.views.values()].map((v) => v.state);
    const hit = raycastEnemies(states, this.size, o, d, max);
    return hit && { enemy: this.views.get(hit.enemy.id)!, t: hit.t, head: hit.head };
  }

  /**
   * Hurt an enemy. Solo, returns true if this killed it. In a shared game the server decides,
   * and any kill comes back later as a reward, so this returns false.
   */
  damage(v: EnemyView, amount: number, head = false): boolean {
    if (this.remote) {
      v.state.flash = 1;
      this.remote.hit(v.state.id, amount, head);
      return false;
    }
    return this.sim.damage(v.state, amount);
  }

  /** Damage everything within `radius` of a point. Solo, returns the tier of each kill; shared, none (see `damage`). */
  damageArea(at: THREE.Vector3, radius: number, amount: number): Tier[] {
    const point: Point = [at.x, at.y, at.z];
    if (this.remote) {
      this.remote.blast(point, radius, amount);
      return [];
    }
    return this.sim.damageArea(point, radius, amount);
  }

  /** Clear the streets. In a shared game the enemies are everyone's, so this does nothing. */
  clear() {
    if (this.remote) return;
    this.sim.clear();
    for (const id of [...this.views.keys()]) this.removeView(id);
  }
}
