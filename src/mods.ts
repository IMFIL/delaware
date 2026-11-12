import type { SharedMod } from './netproto';
import { addWorld, neutralWorld } from './worldfx';
import {
  TARGET_NAMES,
  WORLD_TARGETS,
  worldPart,
  type WorldSpec,
  type Behavior,
  type Mod,
  type ModSpec,
  type Part,
  type SoundEvent,
  type SoundLayer,
  type Target,
} from './modspec';

export interface ActiveMod extends Mod {
  id: number;
  /** Seconds remaining. */
  left: number;
}

/** The combined effect of every active mod, in the form the game reads each frame. */
export interface Effects {
  mult: Record<Target, number>;
  flySpeed: number;
  pellets: number;
  spread: number;
  explosionRadius: number;
  ricochets: number;
  tracerColor: string;
  fov: number;
  brightness: number;
  enemyHighlight: boolean;
  heldModel: Part[] | null;
  enemyModel: Part[] | null;
  enemyBehavior: Behavior;
  enemyRanged: boolean;
  enemyLeap: boolean;
  enemyExplode: boolean;
  sounds: Partial<Record<SoundEvent, SoundLayer[]>>;
  soundVolume: number;
}

function neutral(): Effects {
  const mult = {} as Record<Target, number>;
  for (const t of TARGET_NAMES) mult[t] = 1;
  return {
    mult,
    flySpeed: 0,
    pellets: 1,
    spread: 0,
    explosionRadius: 0,
    ricochets: 0,
    tracerColor: '',
    fov: 0,
    brightness: 1,
    enemyHighlight: false,
    heldModel: null,
    enemyModel: null,
    enemyBehavior: 'normal',
    enemyRanged: false,
    enemyLeap: false,
    enemyExplode: false,
    sounds: {},
    soundVolume: 1,
  };
}

/** One-line description of a mod, for the HUD and for telling the AI what is already active. */
export function summarize(s: ModSpec): string {
  const bits = s.multipliers.map((m) => `${m.target.replace(/_/g, ' ')} ×${+m.mult.toFixed(2)}`);
  if (s.flySpeed) bits.push(`fly ${Math.round(s.flySpeed)} m/s`);
  if (s.pellets > 1) bits.push(`${s.pellets} pellets`);
  if (s.explosionRadius) bits.push(`explosive ${+s.explosionRadius.toFixed(1)} m`);
  if (s.ricochets) bits.push(`${s.ricochets} ricochet${s.ricochets > 1 ? 's' : ''}`);
  if (s.tracerColor) bits.push('tracer colour');
  if (s.fov) bits.push(`fov ${Math.round(s.fov)}`);
  if (Math.abs(s.brightness - 1) > 0.01) bits.push(`brightness ×${+s.brightness.toFixed(2)}`);
  if (s.enemyHighlight) bits.push('enemy highlight');
  if (s.heal) bits.push(`heal ${Math.round(s.heal)}`);
  if (s.heldModel.length) bits.push('held item look');
  if (s.enemyModel.length) bits.push('enemy look');
  if (s.enemyBehavior !== 'normal') bits.push(`enemies ${s.enemyBehavior}`);
  if (s.enemyRanged) bits.push('enemies shoot');
  if (s.enemyLeap) bits.push('enemies leap');
  if (s.enemyExplode) bits.push('enemies explode');
  if (s.playerModel?.length) bits.push(s.targetPlayer ? `${s.targetPlayer}'s look` : 'your look');
  if (s.sounds.length) bits.push(`${s.sounds.map((x) => x.event).join(', ')} sound`);
  if (Math.abs(s.soundVolume - 1) > 0.01) bits.push(`volume ×${+s.soundVolume.toFixed(2)}`);
  return bits.join(', ');
}

/** One line in the on-screen list of mods in force. */
export interface ModRow {
  name: string;
  what: string;
  left: number;
  duration: number;
}

function summarizeWorld(w: WorldSpec): string {
  const bits = w.multipliers.map((m) => `${m.target.replace(/_/g, ' ')} ×${+m.mult.toFixed(2)}`);
  if (w.enemyModel.length) bits.push('enemy look');
  if (w.enemyBehavior !== 'normal') bits.push(`enemies ${w.enemyBehavior}`);
  if (w.enemyRanged) bits.push('enemies shoot');
  if (w.enemyLeap) bits.push('enemies leap');
  if (w.enemyExplode) bits.push('enemies explode');
  return bits.join(', ');
}

/** Holds the active mods, expires them, and keeps their combined effect up to date. */
export class Mods {
  active: ActiveMod[] = [];
  fx = neutral();
  /** Bumped whenever the set of active mods changes, so the HUD and weapon know to refresh. */
  version = 0;
  private nextId = 1;
  /** In a shared game, world-changing effects come from the server's list, not from our own mods. */
  private online = false;
  private shared: SharedMod[] = [];
  private myId = '';

  /** Tell the mods whether we are in a shared game. */
  setOnline(on: boolean) {
    this.online = on;
    if (!on) this.shared = [];
    this.recompute();
  }

  /** Take in the server's list of mods everyone shares. */
  setShared(list: SharedMod[], myId: string) {
    this.shared = list.map((m) => ({ ...m }));
    this.myId = myId;
    this.recompute();
  }

  /** What to list on screen: our own mods, then other players' shared ones. `nameOf` turns a player id into a name. */
  rows(nameOf: (id: string) => string): ModRow[] {
    const rows: ModRow[] = this.active.map((m) => ({
      name: m.name,
      what: summarize(m.spec),
      left: m.left,
      duration: m.duration,
    }));
    for (const m of this.shared) {
      if (m.by === this.myId) continue; // our own are already listed above
      const bits = [summarizeWorld(m.world)];
      if (m.look) bits.push(`${m.look.target === this.myId ? 'your' : `${nameOf(m.look.target)}'s`} look`);
      if (m.stats?.target === this.myId) {
        bits.push(m.stats.changes.map((c) => `your ${c.target.replace(/_/g, ' ')} ×${+c.mult.toFixed(2)}`).join(', '));
      }
      const what = bits.filter(Boolean).join(', ');
      if (!what) continue; // something done to a third player is none of our business
      rows.push({ name: `${m.name} · ${m.byName}`, what, left: m.left, duration: m.duration });
    }
    return rows;
  }

  add(mod: Mod): ActiveMod {
    const m: ActiveMod = { ...mod, id: this.nextId++, left: mod.duration };
    this.active.push(m);
    this.recompute();
    return m;
  }

  remove(id: number) {
    const n = this.active.length;
    this.active = this.active.filter((m) => m.id !== id);
    if (this.active.length !== n) this.recompute();
  }

  clear() {
    if (!this.active.length) return;
    this.active = [];
    this.recompute();
  }

  update(dt: number) {
    for (const m of this.shared) m.left = Math.max(0, m.left - dt);
    let expired = false;
    for (const m of this.active) {
      m.left -= dt;
      if (m.left <= 0) expired = true;
    }
    if (expired) {
      this.active = this.active.filter((m) => m.left > 0);
      this.recompute();
    }
  }

  private recompute() {
    const fx = neutral();
    const world = neutralWorld();
    const isWorld = (t: string) => (WORLD_TARGETS as readonly string[]).includes(t);
    for (const m of this.shared) {
      addWorld(world, m.world);
      // Stat changes another player has put on us.
      if (m.stats?.target === this.myId) for (const c of m.stats.changes) fx.mult[c.target] *= c.mult;
    }
    for (const { spec } of this.active) {
      // Solo, our own mods change the world directly; shared, the server's list above already includes them.
      if (!this.online) addWorld(world, worldPart(spec));
      for (const { target, mult } of spec.multipliers) if (!isWorld(target)) fx.mult[target] *= mult;
      fx.flySpeed = Math.max(fx.flySpeed, spec.flySpeed);
      fx.pellets = Math.max(fx.pellets, spec.pellets);
      fx.spread = Math.max(fx.spread, spec.spread);
      fx.explosionRadius = Math.max(fx.explosionRadius, spec.explosionRadius);
      fx.ricochets = Math.max(fx.ricochets, spec.ricochets || 0);
      if (spec.tracerColor) fx.tracerColor = spec.tracerColor;
      if (spec.fov) fx.fov = spec.fov;
      fx.brightness *= spec.brightness;
      fx.enemyHighlight ||= spec.enemyHighlight;
      if (spec.heldModel.length) fx.heldModel = spec.heldModel;
      for (const { event, layers } of spec.sounds) fx.sounds[event] = layers;
      fx.soundVolume *= spec.soundVolume;
    }
    for (const t of WORLD_TARGETS) fx.mult[t] = world.mult[t];
    fx.enemyModel = world.enemyModel;
    fx.enemyBehavior = world.enemyBehavior;
    fx.enemyRanged = world.enemyRanged;
    fx.enemyLeap = world.enemyLeap;
    fx.enemyExplode = world.enemyExplode;
    this.fx = fx;
    this.version++;
  }
}
