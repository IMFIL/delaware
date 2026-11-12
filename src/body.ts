import type { Collider } from './city';

const STEP = 0.6;

/** An upright box that walks on, and is blocked by, the city's colliders. */
export class Body {
  x = 0;
  y = 0;
  z = 0;
  vy = 0;
  onGround = true;

  constructor(
    readonly halfW: number,
    readonly height: number,
  ) {}

  overlaps(c: Collider, x: number, y: number, z: number): boolean {
    const minX = x - this.halfW;
    const maxX = x + this.halfW;
    const minZ = z - this.halfW;
    const maxZ = z + this.halfW;
    if (
      maxX <= c.minX ||
      minX >= c.maxX ||
      y + this.height <= c.minY ||
      y >= c.maxY ||
      maxZ <= c.minZ ||
      minZ >= c.maxZ
    ) {
      return false;
    }
    if (c.r !== undefined) {
      const dx = Math.min(Math.max(c.cx!, minX), maxX) - c.cx!;
      const dz = Math.min(Math.max(c.cz!, minZ), maxZ) - c.cz!;
      return dx * dx + dz * dz < c.r * c.r;
    }
    return true;
  }

  private supported(x: number, z: number, cols: Collider[]): boolean {
    const y = this.y - STEP - 0.05;
    if (y <= 0) return true;
    for (const c of cols) if (this.overlaps(c, x, y, z)) return true;
    return false;
  }

  /**
   * Move horizontally if nothing is in the way, stepping up onto low obstacles.
   * With `guard`, refuses to walk off an edge.
   */
  tryMove(nx: number, nz: number, cols: Collider[], guard = false): boolean {
    let hit = false;
    let top = -Infinity;
    for (const c of cols) {
      if (this.overlaps(c, nx, this.y, nz)) {
        hit = true;
        if (c.maxY > top) top = c.maxY;
      }
    }
    let ny = this.y;
    if (hit) {
      if (!this.onGround || top - this.y > STEP + 1e-3) return false;
      for (const c of cols) if (this.overlaps(c, nx, top, nz)) return false;
      ny = top;
    } else if (guard && !this.supported(nx, nz, cols)) {
      return false;
    }
    this.x = nx;
    this.z = nz;
    this.y = ny;
    return true;
  }

  /** Apply gravity and vertical collisions. Returns true when standing on something. */
  fall(dt: number, gravity: number, cols: Collider[]): boolean {
    this.vy = Math.max(-60, this.vy - gravity * dt);
    const drop = -this.vy * dt;
    let ny = this.y + this.vy * dt;
    let landed = false;
    if (ny <= 0) {
      ny = 0;
      landed = true;
    }
    for (const c of cols) {
      if (!this.overlaps(c, this.x, ny, this.z)) continue;
      if (this.vy <= 0) {
        if (c.maxY - ny <= drop + 0.05) {
          ny = c.maxY;
          landed = true;
        }
      } else {
        ny = Math.min(ny, c.minY - this.height);
        this.vy = 0;
      }
    }
    this.y = ny;
    if (landed) this.vy = 0;
    this.onGround = landed;
    return landed;
  }
}

/** Distance along a ray to where it enters a box, or -1 if it misses within `limit`. */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  c: Collider,
  limit: number,
): number {
  let t0 = 0;
  let t1 = limit;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [c.minX, c.minY, c.minZ];
  const hi = [c.maxX, c.maxY, c.maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return -1;
      continue;
    }
    let ta = (lo[a] - o[a]) / d[a];
    let tb = (hi[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}

/** Distance to the first collider a ray hits, or `max` if it hits nothing. */
export function raycast(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  max: number,
  cols: Collider[],
): number {
  return raycastHit(ox, oy, oz, dx, dy, dz, max, cols).t;
}

/** Which way a collider's surface faces at a point on it, as a unit vector [x, y, z]. */
export function surfaceNormal(c: Collider, px: number, py: number, pz: number): [number, number, number] {
  const top = Math.abs(py - c.maxY);
  const bottom = Math.abs(py - c.minY);
  if (c.r !== undefined) {
    const rx = px - c.cx!;
    const rz = pz - c.cz!;
    const side = Math.abs(Math.hypot(rx, rz) - c.r);
    if (side <= top && side <= bottom) {
      const len = Math.hypot(rx, rz) || 1;
      return [rx / len, 0, rz / len];
    }
    return top < bottom ? [0, 1, 0] : [0, -1, 0];
  }
  const faces: [number, [number, number, number]][] = [
    [Math.abs(px - c.minX), [-1, 0, 0]],
    [Math.abs(px - c.maxX), [1, 0, 0]],
    [bottom, [0, -1, 0]],
    [top, [0, 1, 0]],
    [Math.abs(pz - c.minZ), [0, 0, -1]],
    [Math.abs(pz - c.maxZ), [0, 0, 1]],
  ];
  return faces.reduce((a, b) => (b[0] < a[0] ? b : a))[1];
}

/** Like `raycast`, but also says which collider was hit (null if none). */
export function raycastHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  max: number,
  cols: Collider[],
): { t: number; col: Collider | null } {
  let best = max;
  let hit: Collider | null = null;
  for (const c of cols) {
    const t0 = rayBox(ox, oy, oz, dx, dy, dz, c, best);
    if (t0 < 0) continue;
    if (c.r === undefined) {
      best = t0;
      hit = c;
      continue;
    }
    // Cylinder: the box test only says the ray is nearby.
    const a = dx * dx + dz * dz;
    const fx = ox - c.cx!;
    const fz = oz - c.cz!;
    let t = t0;
    if (a > 1e-9) {
      const b = fx * dx + fz * dz;
      const disc = b * b - a * (fx * fx + fz * fz - c.r * c.r);
      if (disc < 0) continue;
      t = Math.max(0, (-b - Math.sqrt(disc)) / a);
      const y = oy + dy * t;
      if (y < c.minY || y > c.maxY) {
        // Through the top or bottom cap instead of the side.
        const px = fx + dx * t0;
        const pz = fz + dz * t0;
        if (px * px + pz * pz > c.r * c.r) continue;
        t = t0;
      }
    }
    if (t < best) {
      best = t;
      hit = c;
    }
  }
  return { t: best, col: hit };
}
