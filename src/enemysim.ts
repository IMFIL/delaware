import { Body, raycast, rayBox } from './body';
import { zoneAt, type Collider } from './city';
import type { Behavior } from './modspec';
import { TIERS, type Tier } from './zones';

/**
 * Enemy behaviour with no drawing in it, so the same code runs in the browser for a solo
 * game and on the server for a shared one.
 */

export const HALF_W = 0.35;
export const HEIGHT = 1.95;
export const HEAD = 0.45; // top slice that counts as a headshot
export const MAX_HP = 100;
const CELL = 96; // matches the city's cell size
const REACH = 1.6;
const HIT_DAMAGE = 12;
const HIT_EVERY = 0.9;
const GRAVITY = 28;
const SPAWN_EVERY = 2;
const BOLT_SPEED = 18;
const BOLT_DAMAGE = 8;
const BOLT_RANGE = 45;
const BOLT_EVERY = 2.2;
const LEAP_SPEED = 11;
export const DEATH_BLAST_RADIUS = 4;
const DEATH_BLAST_DAMAGE = 25; // to a player, at the centre
const DEATH_BLAST_CHAIN = 160; // to other enemies, at the centre: enough to set off close neighbours
const DYING_TIME = 0.25;

/** Adjustments from active mods. */
export interface EnemyTuning {
  speed: number;
  size: number;
  spawnRate: number;
  health: number;
  damage: number;
  behavior: Behavior;
  ranged: boolean;
  leap: boolean;
  explode: boolean;
}

export const DEFAULT_TUNING: EnemyTuning = {
  speed: 1,
  size: 1,
  spawnRate: 1,
  health: 1,
  damage: 1,
  behavior: 'normal',
  ranged: false,
  leap: false,
  explode: false,
};

/** Someone the enemies can hunt. */
export interface SimTarget {
  id: string;
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

/** Everything about one enemy that a display needs, whether it is simulated here or reported by a server. */
export interface EnemyState {
  id: number;
  body: { x: number; y: number; z: number };
  hp: number;
  /** Direction it faces, as a rotation about the vertical axis. */
  facing: number;
  /** Height added by a dance hop. */
  lift: number;
  moving: boolean;
  striking: boolean;
  /** 1 just after being hit, fading to 0. */
  flash: number;
  /** Seconds left of its death animation, or 0 while alive. */
  dying: number;
  /** Ground speed, for matching the run animation. */
  pace: number;
  /** Difficulty tier, from the zone it appeared in. */
  tier: Tier;
}

interface SimEnemy extends EnemyState {
  body: Body;
  speed: number;
  attackT: number;
  detourT: number;
  detourX: number;
  detourZ: number;
  shootT: number;
  leapT: number;
  spin: number;
}

export interface Bolt {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

export type Point = [number, number, number];

/** What happened during one step. */
export interface SimStep {
  /** Damage dealt to each target, by id. */
  damage: Map<string, number>;
  /** Where enemies blew up this step. */
  blasts: Point[];
}

export class EnemySim {
  list: SimEnemy[] = [];
  bolts: Bolt[] = [];
  tune = DEFAULT_TUNING;
  private spawnT = 3;
  private pendingBlasts: Point[] = [];
  private nextId = 1;

  /** `colliders` returns the solid things near a point. */
  constructor(private colliders: (x: number, z: number) => Collider[]) {}

  spawnAt(x: number, z: number): SimEnemy {
    const body = new Body(HALF_W, HEIGHT);
    body.x = x;
    body.z = z;
    const e: SimEnemy = {
      id: this.nextId++,
      body,
      hp: MAX_HP,
      tier: zoneAt(x, z),
      facing: 0,
      lift: 0,
      moving: false,
      striking: false,
      flash: 0,
      dying: 0,
      pace: 0,
      // Scaled with the player: the quickest can catch someone walking, none can catch a sprint.
      speed: 6.2 + Math.random() * 2.9,
      attackT: 0.4,
      detourT: 0,
      detourX: 0,
      detourZ: 0,
      shootT: 1 + Math.random() * BOLT_EVERY,
      leapT: Math.random() * 2,
      spin: Math.random() * 6,
    };
    this.list.push(e);
    return e;
  }

  /** Spawn on a road somewhere around one target, never right on top of anyone. */
  private spawnNear(near: SimTarget, all: SimTarget[]) {
    const ang = Math.random() * Math.PI * 2;
    const d = 45 + Math.random() * 30;
    let x = near.x + Math.cos(ang) * d;
    let z = near.z + Math.sin(ang) * d;
    if (Math.random() < 0.5) x = Math.round(x / CELL) * CELL + (Math.random() - 0.5) * 12;
    else z = Math.round(z / CELL) * CELL + (Math.random() - 0.5) * 12;
    if (all.some((t) => Math.hypot(x - t.x, z - t.z) < 30)) return;
    this.spawnAt(x, z);
  }

  /** Advance every enemy by `dt` seconds. `kills` raises how many may be alive at once. */
  update(dt: number, targets: SimTarget[], kills: number, tune: EnemyTuning): SimStep {
    this.tune = tune;
    const step: SimStep = { damage: new Map(), blasts: [] };
    const hurt = (id: string, amount: number) => step.damage.set(id, (step.damage.get(id) ?? 0) + amount);
    const living = targets.filter((t) => t.alive);

    this.spawnT -= dt * tune.spawnRate;
    if (this.spawnT <= 0 && living.length) {
      this.spawnT = SPAWN_EVERY / Math.sqrt(living.length); // more players, faster arrivals
      const alive = this.list.reduce((n, e) => n + (e.dying ? 0 : 1), 0);
      const cap = Math.min(14 + 4 * (living.length - 1), 5 + Math.floor(kills / 4) + 3 * (living.length - 1), 30);
      if (alive < cap) this.spawnNear(living[Math.floor(Math.random() * living.length)], living);
    }

    this.updateBlasts(living, hurt, step);
    this.updateBolts(dt, living, hurt);

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      const b = e.body;
      if (e.dying > 0) {
        e.dying -= dt;
        e.moving = e.striking = false;
        if (e.dying <= 0) this.list.splice(i, 1);
        continue;
      }
      // Hunt whoever is closest.
      let target: SimTarget | null = null;
      let dist = Infinity;
      for (const t of living) {
        const d = Math.hypot(t.x - b.x, t.z - b.z);
        if (d < dist) {
          dist = d;
          target = t;
        }
      }
      if (!target && targets.length) {
        // Nobody alive: stand and wait rather than wander off.
        e.moving = e.striking = false;
        b.fall(dt, GRAVITY, this.colliders(b.x, b.z));
        continue;
      }
      if (dist > 140) {
        this.list.splice(i, 1);
        continue;
      }
      const dx = target ? target.x - b.x : 0;
      const dz = target ? target.z - b.z : 0;
      const py = target ? target.y : 0;
      const hostile = tune.behavior === 'normal' && !!target;
      const cols = this.colliders(b.x, b.z);
      const speed = e.speed * tune.speed;

      // Where this enemy wants to go.
      let ux = 0;
      let uz = 0;
      e.detourT -= dt;
      if (tune.behavior === 'normal') {
        if (dist > 1.2 && target) {
          ux = e.detourT > 0 ? e.detourX : dx / dist;
          uz = e.detourT > 0 ? e.detourZ : dz / dist;
        }
      } else if (tune.behavior === 'flee') {
        if (dist > 0.01 && dist < 60) {
          ux = e.detourT > 0 ? e.detourX : -dx / dist;
          uz = e.detourT > 0 ? e.detourZ : -dz / dist;
        }
      } else if (tune.behavior === 'passive') {
        // Wander: pick a new heading every few seconds.
        if (e.detourT <= 0) {
          const a = Math.random() * Math.PI * 2;
          e.detourX = Math.cos(a);
          e.detourZ = Math.sin(a);
          e.detourT = 2 + Math.random() * 3;
        }
        ux = e.detourX * 0.5;
        uz = e.detourZ * 0.5;
      } // 'frozen' and 'dance' stay put

      let moving = false;
      if (ux || uz) {
        const mx = ux * speed * dt;
        const mz = uz * speed * dt;
        const okX = b.tryMove(b.x + mx, b.z, cols);
        const okZ = b.tryMove(b.x, b.z + mz, cols);
        moving = okX || okZ;
        const blocked = !okX || !okZ;
        // Flat against a wall with the goal straight behind it: slide along the wall for a bit.
        const small = 0.3 * speed * dt;
        if (
          tune.behavior !== 'passive' &&
          e.detourT <= 0 &&
          ((!okX && Math.abs(mz) < small) || (!okZ && Math.abs(mx) < small))
        ) {
          const side = Math.random() < 0.5 ? -1 : 1;
          e.detourT = 1.5;
          e.detourX = !okX ? Math.sign(ux) * 0.3 : side;
          e.detourZ = !okX ? side : Math.sign(uz) * 0.3;
          const n = Math.hypot(e.detourX, e.detourZ);
          e.detourX /= n;
          e.detourZ /= n;
        } else if (tune.behavior === 'passive' && blocked) {
          e.detourT = 0; // bumped into something: choose a new heading
        }
        // Leap over what is in the way, or up toward a player overhead.
        e.leapT -= dt;
        if (tune.leap && hostile && b.onGround && e.leapT <= 0 && (blocked || py > b.y + 1.5 || dist < 9)) {
          b.vy = LEAP_SPEED;
          b.onGround = false;
          e.leapT = 1.5 + Math.random() * 1.5;
        }
      }
      b.fall(dt, GRAVITY, cols);

      const inReach = dist < REACH * Math.max(1, tune.size) && Math.abs(py - b.y) < 2 * tune.size;
      if (hostile && inReach) {
        e.attackT -= dt;
        if (e.attackT <= 0) {
          e.attackT = HIT_EVERY;
          hurt(target!.id, HIT_DAMAGE * tune.damage * TIERS[e.tier].damage);
        }
      } else {
        e.attackT = Math.min(e.attackT + dt, 0.4);
      }

      if (hostile && tune.ranged) {
        e.shootT -= dt;
        if (e.shootT <= 0 && dist > 4 && dist < BOLT_RANGE) {
          e.shootT = BOLT_EVERY * (0.8 + Math.random() * 0.4);
          this.shoot(b.x, b.y + 1.5 * tune.size, b.z, target!.x, py + 1.2, target!.z, cols);
        }
      }

      e.flash = Math.max(0, e.flash - dt * 6);
      e.moving = moving;
      e.pace = speed;
      e.striking = hostile && dist < REACH * Math.max(1, tune.size) * 1.5;
      e.facing = Math.atan2(dx, dz);
      e.lift = 0;
      if (tune.behavior === 'dance') {
        e.spin += dt * 5;
        e.facing = e.spin;
        e.lift = Math.abs(Math.sin(e.spin * 1.5)) * 0.3;
      } else if (tune.behavior !== 'normal' && (ux || uz)) {
        e.facing = Math.atan2(ux, uz); // look where it is going
      }
    }

    // Keep enemies from stacking inside each other.
    for (let i = 0; i < this.list.length; i++) {
      for (let j = i + 1; j < this.list.length; j++) {
        const a = this.list[i].body;
        const c = this.list[j].body;
        const ox = c.x - a.x;
        const oz = c.z - a.z;
        const d = Math.hypot(ox, oz);
        if (d > 0.01 && d < 0.9) {
          const push = ((0.9 - d) / d) * 0.5;
          a.x -= ox * push;
          a.z -= oz * push;
          c.x += ox * push;
          c.z += oz * push;
        }
      }
    }
    return step;
  }

  /** Fire a bolt at a point, if nothing solid is in the way. */
  private shoot(x: number, y: number, z: number, tx: number, ty: number, tz: number, cols: Collider[]) {
    const dx = tx - x;
    const dy = ty - y;
    const dz = tz - z;
    const d = Math.hypot(dx, dy, dz);
    if (raycast(x, y, z, dx / d, dy / d, dz / d, d, cols) < d - 0.01) return;
    if (this.bolts.length >= 40) return;
    this.bolts.push({
      x,
      y,
      z,
      vx: (dx / d) * BOLT_SPEED,
      vy: (dy / d) * BOLT_SPEED,
      vz: (dz / d) * BOLT_SPEED,
      life: BOLT_RANGE / BOLT_SPEED + 0.5,
    });
  }

  private updateBolts(dt: number, living: SimTarget[], hurt: (id: string, amount: number) => void) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      const step = BOLT_SPEED * dt;
      const free = raycast(
        bolt.x, bolt.y, bolt.z,
        bolt.vx / BOLT_SPEED, bolt.vy / BOLT_SPEED, bolt.vz / BOLT_SPEED,
        step,
        this.colliders(bolt.x, bolt.z),
      );
      bolt.x += bolt.vx * dt;
      bolt.y += bolt.vy * dt;
      bolt.z += bolt.vz * dt;
      bolt.life -= dt;
      let struck = false;
      for (const t of living) {
        if (Math.abs(bolt.x - t.x) < 0.5 && Math.abs(bolt.z - t.z) < 0.5 && bolt.y > t.y - 0.1 && bolt.y < t.y + 1.9) {
          hurt(t.id, BOLT_DAMAGE * this.tune.damage);
          struck = true;
          break;
        }
      }
      if (struck || free < step || bolt.y <= 0 || bolt.life <= 0) this.bolts.splice(i, 1);
    }
  }

  /** Set off queued death explosions. */
  private updateBlasts(living: SimTarget[], hurt: (id: string, amount: number) => void, step: SimStep) {
    const queued = this.pendingBlasts;
    this.pendingBlasts = [];
    for (const at of queued) {
      step.blasts.push(at);
      this.damageArea(at, DEATH_BLAST_RADIUS, DEATH_BLAST_CHAIN * this.tune.health); // chain reactions
      for (const t of living) {
        const d = Math.hypot(at[0] - t.x, at[1] - (t.y + 0.9), at[2] - t.z);
        if (d < DEATH_BLAST_RADIUS) {
          hurt(t.id, DEATH_BLAST_DAMAGE * this.tune.damage * (1 - (0.6 * d) / DEATH_BLAST_RADIUS));
        }
      }
    }
  }

  byId(id: number): SimEnemy | undefined {
    return this.list.find((e) => e.id === id);
  }

  /** Returns true if this hit killed the enemy. */
  damage(e: EnemyState, amount: number): boolean {
    if (e.dying > 0) return false;
    e.hp -= amount / (this.tune.health * TIERS[e.tier].health); // tougher enemies simply take less from each hit
    e.flash = 1;
    if (e.hp > 0) return false;
    e.dying = DYING_TIME;
    if (this.tune.explode) this.pendingBlasts.push([e.body.x, e.body.y + 1, e.body.z]);
    return true;
  }

  /** Damage everything within `radius` of a point, falling off with distance. Returns the tier of each enemy killed. */
  damageArea(at: Point, radius: number, amount: number): Tier[] {
    const kills: Tier[] = [];
    for (const e of this.list) {
      const b = e.body;
      const mid = b.y + (HEIGHT * this.tune.size) / 2;
      const d = Math.hypot(b.x - at[0], mid - at[1], b.z - at[2]);
      if (d > radius) continue;
      if (this.damage(e, amount * (1 - (0.6 * d) / radius))) kills.push(e.tier);
    }
    return kills;
  }

  clear() {
    this.list = [];
    this.bolts = [];
    this.pendingBlasts = [];
  }
}

/** First living enemy along a ray, closer than `max`. Works on simulated or reported enemies alike. */
export function raycastEnemies<T extends EnemyState>(
  list: Iterable<T>,
  size: number,
  o: { x: number; y: number; z: number },
  d: { x: number; y: number; z: number },
  max: number,
): { enemy: T; t: number; head: boolean } | null {
  let hit: { enemy: T; t: number; head: boolean } | null = null;
  let best = max;
  const half = HALF_W * size;
  const tall = HEIGHT * size;
  for (const e of list) {
    if (e.dying > 0) continue;
    const b = e.body;
    const t = rayBox(
      o.x, o.y, o.z, d.x, d.y, d.z,
      { minX: b.x - half, maxX: b.x + half, minY: b.y, maxY: b.y + tall, minZ: b.z - half, maxZ: b.z + half },
      best,
    );
    if (t < 0) continue;
    best = t;
    hit = { enemy: e, t, head: o.y + d.y * t > b.y + tall - HEAD * size };
  }
  return hit;
}
