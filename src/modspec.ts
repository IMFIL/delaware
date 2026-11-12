/**
 * What a mod can change, the limits on each change, and what it costs.
 * Shared by the game (which applies mods) and the server (which prices them),
 * so the price always comes from what a mod does, never from what anyone says it is worth.
 */

/**
 * Multipliers a mod can apply. `min` and `max` are hard caps, and they hold for the combined
 * total of every mod in force, not just for one mod: nothing stacks past them.
 * `per` is mana per doubling or halving, per minute of duration.
 */
export const TARGETS = {
  speed: { min: 0.5, max: 2.5, per: 40 },
  jump: { min: 0.5, max: 3, per: 25 },
  gravity: { min: 0.4, max: 2, per: 30 },
  damage: { min: 0.5, max: 3, per: 75 },
  fire_rate: { min: 0.5, max: 2.5, per: 60 },
  mag_size: { min: 0.5, max: 3, per: 30 },
  reload_speed: { min: 0.5, max: 3, per: 30 },
  max_health: { min: 0.5, max: 3, per: 50 },
  regen: { min: 0, max: 4, per: 25 },
  damage_taken: { min: 0.4, max: 2, per: 100 },
  fog: { min: 0.3, max: 3, per: 15 },
  rain: { min: 0, max: 3, per: 5 },
  enemy_speed: { min: 0.5, max: 2, per: 50 },
  enemy_size: { min: 0.1, max: 100, per: 30 }, // deliberately left wide open: size is the one thing without a practical cap
  enemy_spawn_rate: { min: 0.25, max: 3, per: 40 },
  enemy_health: { min: 0.5, max: 4, per: 75 },
  enemy_damage: { min: 0.5, max: 3, per: 75 },
} as const;

export type Target = keyof typeof TARGETS;
export const TARGET_NAMES = Object.keys(TARGETS) as [Target, ...Target[]];

export const SHAPES = ['box', 'roundbox', 'sphere', 'capsule', 'cylinder', 'cone', 'torus'] as const;
export type Shape = (typeof SHAPES)[number];

/** The game sounds a mod can redesign. */
export const SOUND_EVENTS = ['shot', 'hit', 'kill', 'hurt'] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

/** A pitched wave, or noise passed through a filter. */
export const LAYER_KINDS = [
  'sine',
  'square',
  'sawtooth',
  'triangle',
  'noise_lowpass',
  'noise_bandpass',
  'noise_highpass',
] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/** One layer of a synthesised sound. A sound is a handful of these played together. */
export interface SoundLayer {
  kind: LayerKind;
  /** Hz at the start: the pitch of a wave, or the filter frequency of noise. */
  from: number;
  /** Hz at the end; the layer glides from one to the other. */
  to: number;
  /** Seconds. */
  dur: number;
  /** Loudness, 0 to 1. */
  gain: number;
  /** Seconds before the layer starts. */
  delay: number;
  /** Filter sharpness, for noise only. */
  q: number;
}

/** How enemies act. Anything but 'normal' leaves them harmless, so kills pay no mana meanwhile. */
export const BEHAVIORS = ['normal', 'passive', 'flee', 'frozen', 'dance'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

/** How a part's surface catches the light. */
export const FINISHES = ['matte', 'satin', 'gloss', 'metal', 'chrome'] as const;
export type Finish = (typeof FINISHES)[number];

/** One primitive in a model. Sizes and positions in metres, rotations in degrees. */
export interface Part {
  shape: Shape;
  sx: number;
  sy: number;
  sz: number;
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  color: string;
  finish: Finish;
  glow: boolean;
}

export interface ModSpec {
  multipliers: { target: Target; mult: number }[];
  /** Flying speed in m/s; 0 means no flight. */
  flySpeed: number;
  pellets: number;
  spread: number;
  explosionRadius: number;
  /** How many times each shot bounces off walls and the street. */
  ricochets: number;
  /** Hex colour, or '' to leave the tracer alone. */
  tracerColor: string;
  /** Field of view in degrees; 0 leaves it alone. */
  fov: number;
  brightness: number;
  enemyHighlight: boolean;
  /** Health restored once, when the mod starts. */
  heal: number;
  /** Replaces the held item's look; empty leaves it alone. */
  heldModel: Part[];
  /** Replaces every enemy's look; empty leaves it alone. */
  enemyModel: Part[];
  enemyBehavior: Behavior;
  /** Enemies fire slow bolts from a distance. */
  enemyRanged: boolean;
  /** Enemies leap, so they can reach high places. */
  enemyLeap: boolean;
  /** Enemies blow up when killed, hurting anything nearby. */
  enemyExplode: boolean;
  /** Replaces how a player's body looks to everyone; empty leaves it alone. */
  playerModel: Part[];
  /** Name of the player whose look and stats this mod changes; '' means whoever asked. */
  targetPlayer: string;
  /** Replacement sounds; events not listed keep their current sound. */
  sounds: { event: SoundEvent; layers: SoundLayer[] }[];
  /** Overall loudness multiplier; 1 leaves it alone, 0 is silence. */
  soundVolume: number;
}

export interface Mod {
  name: string;
  /** Seconds. */
  duration: number;
  cost: number;
  spec: ModSpec;
}

/** What the server sends back for a chat request. */
export type ModReply =
  | { ok: true; say: string; mod: Mod }
  | { ok: false; say: string };

export const LIMITS = {
  duration: { min: 10, max: 300 },
  flySpeed: { min: 3, max: 15 },
  pellets: { min: 1, max: 5 },
  spread: { min: 0, max: 0.3 },
  explosionRadius: { min: 0, max: 4 },
  ricochets: { min: 0, max: 3 },
  fov: { min: 40, max: 120 },
  brightness: { min: 0.3, max: 3 },
  heal: { min: 0, max: 100 },
  parts: 24,
  partSize: { min: 0.005, max: 1.5 },
  partOffset: 1.2,
  enemyPartSize: { min: 0.02, max: 4 },
  enemyPartOffset: 4,
  soundLayers: 8,
  soundHz: { min: 20, max: 12000 },
  soundDur: { min: 0.01, max: 1.5 },
  soundDelay: { min: 0, max: 1 },
  soundQ: { min: 0.1, max: 20 },
  soundVolume: { min: 0, max: 2 },
} as const;

/** Mana prices for everything that is not a multiplier. Per minute unless marked flat. */
export const PRICES = {
  flyBase: 360, // flight is the most powerful thing on offer, and priced like it
  flyPerMps: 9,
  perExtraPellet: 30,
  perExplosionMetre: 40,
  perRicochet: 40,
  fov: 10,
  brightness: 20,
  enemyHighlight: 100,
  healPerPoint: 1, // flat
  heldModel: 15, // flat
  enemyModel: 200, // flat
  playerModelSelf: 75, // flat
  playerModelOther: 150, // flat: changing someone else costs double
  otherPlayerFactor: 2, // stat changes aimed at another player cost this many times as much
  enemyBehavior: 200,
  enemyRanged: 125,
  enemyLeap: 75,
  enemyExplode: 100,
  sound: 15, // flat, per sound replaced
} as const;

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Force a list of model parts inside the limits. Safe to call on anything a client sends. */
export function cleanParts(
  parts: unknown,
  sizes: { min: number; max: number } = LIMITS.enemyPartSize,
  reach: number = LIMITS.enemyPartOffset,
): Part[] {
  return (Array.isArray(parts) ? (parts as Partial<Part>[]) : []).slice(0, LIMITS.parts).map((raw): Part => {
    const p = raw && typeof raw === 'object' ? raw : {};
    const size = (v: unknown) => clamp(v, sizes.min, sizes.max, sizes.min * 10);
    const off = (v: unknown) => clamp(v, -reach, reach, 0);
    const rot = (v: unknown) => clamp(v, -360, 360, 0);
    return {
      shape: SHAPES.includes(p.shape as Shape) ? (p.shape as Shape) : 'box',
      sx: size(p.sx),
      sy: size(p.sy),
      sz: size(p.sz),
      x: off(p.x),
      y: off(p.y),
      z: off(p.z),
      rx: rot(p.rx),
      ry: rot(p.ry),
      rz: rot(p.rz),
      color: typeof p.color === 'string' && HEX.test(p.color) ? p.color : '#9aa6b0',
      finish: FINISHES.includes(p.finish as Finish) ? (p.finish as Finish) : 'satin',
      glow: p.glow === true,
    };
  });
}

/** Multipliers that change the world everyone shares, not just the player who bought them. */
export const WORLD_TARGETS = [
  'fog',
  'rain',
  'enemy_speed',
  'enemy_size',
  'enemy_spawn_rate',
  'enemy_health',
  'enemy_damage',
] as const satisfies readonly Target[];
export type WorldTarget = (typeof WORLD_TARGETS)[number];

/** The part of a mod that everyone in a shared game experiences. */
export interface WorldSpec {
  multipliers: { target: WorldTarget; mult: number }[];
  enemyModel: Part[];
  enemyBehavior: Behavior;
  enemyRanged: boolean;
  enemyLeap: boolean;
  enemyExplode: boolean;
}

/** Pull the shared part out of a mod, re-checking every value. Safe to call on anything a client sends. */
export function worldPart(spec: unknown): WorldSpec {
  const s = (spec && typeof spec === 'object' ? spec : {}) as Partial<ModSpec>;
  const multipliers: WorldSpec['multipliers'] = [];
  for (const m of Array.isArray(s.multipliers) ? s.multipliers : []) {
    const target = m?.target as WorldTarget;
    if (!WORLD_TARGETS.includes(target) || multipliers.some((x) => x.target === target)) continue;
    multipliers.push({ target, mult: clamp(m.mult, TARGETS[target].min, TARGETS[target].max, 1) });
  }
  return {
    multipliers,
    enemyModel: cleanParts(s.enemyModel),
    enemyBehavior: BEHAVIORS.includes(s.enemyBehavior as Behavior) ? (s.enemyBehavior as Behavior) : 'normal',
    enemyRanged: s.enemyRanged === true,
    enemyLeap: s.enemyLeap === true,
    enemyExplode: s.enemyExplode === true,
  };
}

/** Hold a combined multiplier inside its hard caps, however many mods contributed to it. */
export const capTotal = (target: Target, value: number) =>
  Math.min(TARGETS[target].max, Math.max(TARGETS[target].min, value));

/** One stat multiplier on a player. */
export interface StatChange {
  target: Target;
  mult: number;
}

/** Pull out the multipliers that act on a player (not the world), re-checking every value. Safe on anything a client sends. */
export function playerPart(spec: unknown): StatChange[] {
  const s = (spec && typeof spec === 'object' ? spec : {}) as Partial<ModSpec>;
  const out: StatChange[] = [];
  for (const m of Array.isArray(s.multipliers) ? s.multipliers : []) {
    const target = m?.target as Target;
    if (!(target in TARGETS) || (WORLD_TARGETS as readonly string[]).includes(target)) continue;
    if (out.some((x) => x.target === target)) continue;
    const mult = clamp(m.mult, TARGETS[target].min, TARGETS[target].max, 1);
    if (Math.abs(mult - 1) > 0.01) out.push({ target, mult });
  }
  return out;
}

/** True if a world part changes nothing. */
export function worldIsEmpty(w: WorldSpec): boolean {
  return (
    !w.multipliers.length &&
    !w.enemyModel.length &&
    w.enemyBehavior === 'normal' &&
    !w.enemyRanged &&
    !w.enemyLeap &&
    !w.enemyExplode
  );
}

/** Force anything the AI produced back inside the limits. */
export function sanitize(raw: {
  multipliers?: { target?: string; mult?: number }[];
  fly_speed?: number;
  pellets?: number;
  spread?: number;
  explosion_radius?: number;
  ricochets?: number;
  tracer_color?: string;
  fov?: number;
  brightness?: number;
  enemy_highlight?: boolean;
  heal?: number;
  held_model?: Partial<Part>[];
  enemy_model?: Partial<Part>[];
  enemy_behavior?: string;
  enemy_ranged?: boolean;
  enemy_leap?: boolean;
  enemy_explode?: boolean;
  player_model?: Partial<Part>[];
  target_player?: string;
  sounds?: { event?: string; layers?: Partial<SoundLayer>[] }[];
  sound_volume?: number;
}): ModSpec {
  const seen = new Set<string>();
  const multipliers: ModSpec['multipliers'] = [];
  for (const m of raw.multipliers ?? []) {
    const target = m.target as Target;
    if (!(target in TARGETS) || seen.has(target)) continue;
    seen.add(target);
    const t = TARGETS[target];
    const mult = clamp(m.mult, t.min, t.max, 1);
    if (Math.abs(mult - 1) > 0.01) multipliers.push({ target, mult });
  }
  const fly = raw.fly_speed ?? 0;
  const fov = raw.fov ?? 0;
  const heard = new Set<string>();
  const sounds: ModSpec['sounds'] = [];
  for (const snd of raw.sounds ?? []) {
    const event = snd.event as SoundEvent;
    if (!SOUND_EVENTS.includes(event) || heard.has(event)) continue;
    const layers = (snd.layers ?? []).slice(0, LIMITS.soundLayers).map((l): SoundLayer => {
      const hz = (v: unknown) => clamp(v, LIMITS.soundHz.min, LIMITS.soundHz.max, 440);
      return {
        kind: LAYER_KINDS.includes(l.kind as LayerKind) ? (l.kind as LayerKind) : 'sine',
        from: hz(l.from),
        to: hz(l.to),
        dur: clamp(l.dur, LIMITS.soundDur.min, LIMITS.soundDur.max, 0.1),
        gain: clamp(l.gain, 0, 1, 0.2),
        delay: clamp(l.delay, LIMITS.soundDelay.min, LIMITS.soundDelay.max, 0),
        q: clamp(l.q, LIMITS.soundQ.min, LIMITS.soundQ.max, 1),
      };
    });
    if (!layers.length) continue;
    heard.add(event);
    sounds.push({ event, layers });
  }
  const model = cleanParts;
  const heldModel = model(raw.held_model, LIMITS.partSize, LIMITS.partOffset);
  const enemyModel = model(raw.enemy_model, LIMITS.enemyPartSize, LIMITS.enemyPartOffset);
  return {
    multipliers,
    flySpeed: fly > 0 ? clamp(fly, LIMITS.flySpeed.min, LIMITS.flySpeed.max, 0) : 0,
    pellets: Math.round(clamp(raw.pellets, LIMITS.pellets.min, LIMITS.pellets.max, 1)),
    spread: clamp(raw.spread, LIMITS.spread.min, LIMITS.spread.max, 0),
    explosionRadius: clamp(raw.explosion_radius, 0, LIMITS.explosionRadius.max, 0),
    ricochets: Math.round(clamp(raw.ricochets, 0, LIMITS.ricochets.max, 0)),
    tracerColor: HEX.test(raw.tracer_color ?? '') ? raw.tracer_color! : '',
    fov: fov > 0 ? clamp(fov, LIMITS.fov.min, LIMITS.fov.max, 0) : 0,
    brightness: clamp(raw.brightness, LIMITS.brightness.min, LIMITS.brightness.max, 1),
    enemyHighlight: raw.enemy_highlight === true,
    heal: clamp(raw.heal, 0, LIMITS.heal.max, 0),
    heldModel,
    enemyModel,
    enemyBehavior: BEHAVIORS.includes(raw.enemy_behavior as Behavior)
      ? (raw.enemy_behavior as Behavior)
      : 'normal',
    enemyRanged: raw.enemy_ranged === true,
    enemyLeap: raw.enemy_leap === true,
    enemyExplode: raw.enemy_explode === true,
    playerModel: model(raw.player_model, LIMITS.enemyPartSize, LIMITS.enemyPartOffset),
    targetPlayer: String(raw.target_player ?? '').trim().slice(0, 16),
    sounds,
    soundVolume:
      raw.sound_volume === undefined
        ? 1
        : clamp(raw.sound_volume, LIMITS.soundVolume.min, LIMITS.soundVolume.max, 1),
  };
}

/** True if the mod would not change anything. */
export function isEmpty(s: ModSpec): boolean {
  return (
    !s.multipliers.length &&
    !s.flySpeed &&
    s.pellets <= 1 &&
    !s.explosionRadius &&
    !s.ricochets &&
    !s.tracerColor &&
    !s.fov &&
    Math.abs(s.brightness - 1) < 0.01 &&
    !s.enemyHighlight &&
    !s.heal &&
    !s.heldModel.length &&
    !s.enemyModel.length &&
    s.enemyBehavior === 'normal' &&
    !s.enemyRanged &&
    !s.enemyLeap &&
    !s.enemyExplode &&
    !(s.playerModel?.length) &&
    !s.sounds.length &&
    Math.abs(s.soundVolume - 1) < 0.01
  );
}

/** Mana price of a mod. Ongoing effects scale with duration; one-off effects are flat. */
export function cost(s: ModSpec, duration: number): number {
  let perMinute = 0;
  for (const { target, mult } of s.multipliers) {
    // Each doubling or halving costs the same; zero counts as four halvings.
    // Stats aimed at another player cost more than the same change to yourself.
    const onOther = !!s.targetPlayer && !(WORLD_TARGETS as readonly string[]).includes(target);
    const price = TARGETS[target].per * Math.abs(Math.log2(Math.max(mult, 1 / 16)));
    perMinute += price * (onOther ? PRICES.otherPlayerFactor : 1);
  }
  if (s.flySpeed) perMinute += PRICES.flyBase + PRICES.flyPerMps * s.flySpeed;
  perMinute += PRICES.perExtraPellet * (s.pellets - 1);
  perMinute += PRICES.perExplosionMetre * s.explosionRadius;
  perMinute += PRICES.perRicochet * (s.ricochets || 0);
  if (s.fov) perMinute += PRICES.fov;
  if (Math.abs(s.brightness - 1) > 0.01) perMinute += PRICES.brightness;
  if (s.enemyHighlight) perMinute += PRICES.enemyHighlight;
  if (s.enemyBehavior !== 'normal') perMinute += PRICES.enemyBehavior;
  if (s.enemyRanged) perMinute += PRICES.enemyRanged;
  if (s.enemyLeap) perMinute += PRICES.enemyLeap;
  if (s.enemyExplode) perMinute += PRICES.enemyExplode;
  let flat = s.heal * PRICES.healPerPoint;
  if (s.heldModel.length) flat += PRICES.heldModel;
  if (s.enemyModel.length) flat += PRICES.enemyModel;
  if (s.playerModel?.length) flat += s.targetPlayer ? PRICES.playerModelOther : PRICES.playerModelSelf;
  flat += PRICES.sound * s.sounds.length;
  return Math.max(1, Math.ceil((perMinute * duration) / 60 + flat));
}
