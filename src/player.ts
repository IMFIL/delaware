import * as THREE from 'three';
import { Body } from './body';
import type { Collider } from './city';

const EYE = 1.62;
const EYE_CROUCH = 1.32;
const WALK = 12;
const SPRINT = 16;
const SNEAK = 1.31;
const JUMP = 8.6;
const GRAVITY = 28;
const FOV = 70;
const FOV_SPRINT = 80;

export interface Input {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
}

export const NO_INPUT: Input = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  crouch: false,
  sprint: false,
};

/** Adjustments from active mods. */
export interface Tuning {
  speed: number;
  jump: number;
  gravity: number;
  /** Metres per second; 0 means not flying. */
  flySpeed: number;
  /** Degrees; 0 means the normal field of view. */
  fov: number;
}

export const NO_TUNING: Tuning = { speed: 1, jump: 1, gravity: 1, flySpeed: 0, fov: 0 };

export class Player extends Body {
  vx = 0;
  vz = 0;
  yaw = 0;
  pitch = 0;
  sprinting = false;

  private camY = 0;
  private eye = EYE;
  private fov = FOV;
  private airTime = 0;
  private jumped = false;

  constructor() {
    super(0.3, 1.8);
  }

  get speed() {
    return Math.hypot(this.vx, this.vz);
  }

  look(dx: number, dy: number) {
    const s = 0.0022;
    this.yaw -= dx * s;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.min(lim, Math.max(-lim, this.pitch - dy * s));
  }

  /** Double-tapping forward starts a sprint. */
  startSprint() {
    this.sprinting = true;
  }

  update(dt: number, input: Input, cols: Collider[], tune: Tuning = NO_TUNING) {
    const flying = tune.flySpeed > 0;
    const crouching = input.crouch && !flying; // while flying, crouch means descend
    if (input.sprint && input.forward) this.sprinting = true;
    if (!input.forward || crouching) this.sprinting = false;

    let mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let mz = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }
    const speed = flying
      ? tune.flySpeed * (this.sprinting ? 1.5 : 1)
      : (crouching ? SNEAK : this.sprinting ? SPRINT : WALK) * tune.speed;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const tx = (mx * cos - mz * sin) * speed;
    const tz = (-mx * sin - mz * cos) * speed;
    const a = 1 - Math.exp(-(flying ? 6 : this.onGround ? 14 : 3) * dt);
    this.vx += (tx - this.vx) * a;
    this.vz += (tz - this.vz) * a;

    if (flying) {
      const climb = ((input.jump ? 1 : 0) - (input.crouch ? 1 : 0)) * tune.flySpeed;
      this.vy += (climb - this.vy) * (1 - Math.exp(-8 * dt));
      if (climb > 0) this.onGround = false;
    } else if (input.jump && this.onGround) {
      this.vy = JUMP * Math.sqrt(tune.jump); // so the multiplier scales jump height
      this.onGround = false;
      this.jumped = true;
    }

    const guard = crouching && this.onGround;
    if (!this.tryMove(this.x + this.vx * dt, this.z, cols, guard)) this.vx = 0;
    if (!this.tryMove(this.x, this.z + this.vz * dt, cols, guard)) this.vz = 0;

    if (this.fall(dt, flying ? 0 : GRAVITY * tune.gravity, cols)) {
      this.airTime = 0;
      this.jumped = false;
    } else {
      this.airTime += dt;
    }

    // Camera follows smoothly over steps and kerbs, tightly while jumping or falling.
    const smooth = this.onGround || (!this.jumped && this.airTime < 0.15);
    this.camY += (this.y - this.camY) * (1 - Math.exp(-(smooth ? 18 : 60) * dt));
    if (Math.abs(this.y - this.camY) > 1.5) this.camY = this.y;
    this.eye += ((crouching ? EYE_CROUCH : EYE) - this.eye) * (1 - Math.exp(-16 * dt));
    const fov = (tune.fov || FOV) + (this.sprinting ? FOV_SPRINT - FOV : 0);
    this.fov += (fov - this.fov) * (1 - Math.exp(-10 * dt));
  }

  applyTo(camera: THREE.PerspectiveCamera) {
    camera.position.set(this.x, this.camY + this.eye, this.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}
