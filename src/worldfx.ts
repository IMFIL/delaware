import { DEFAULT_TUNING, type EnemyTuning } from './enemysim';
import { capTotal, WORLD_TARGETS, type Behavior, type Part, type WorldSpec, type WorldTarget } from './modspec';

/** The combined effect of every world-changing mod in force. */
export interface WorldFx {
  mult: Record<WorldTarget, number>;
  enemyModel: Part[] | null;
  enemyBehavior: Behavior;
  enemyRanged: boolean;
  enemyLeap: boolean;
  enemyExplode: boolean;
}

export function neutralWorld(): WorldFx {
  const mult = {} as Record<WorldTarget, number>;
  for (const t of WORLD_TARGETS) mult[t] = 1;
  return { mult, enemyModel: null, enemyBehavior: 'normal', enemyRanged: false, enemyLeap: false, enemyExplode: false };
}

/** Fold one mod's world part into the running total. Multipliers stack; the newest look and behaviour win. */
export function addWorld(fx: WorldFx, w: WorldSpec) {
  for (const { target, mult } of w.multipliers) fx.mult[target] *= mult;
  if (w.enemyModel.length) fx.enemyModel = w.enemyModel;
  if (w.enemyBehavior !== 'normal') fx.enemyBehavior = w.enemyBehavior;
  fx.enemyRanged ||= w.enemyRanged;
  fx.enemyLeap ||= w.enemyLeap;
  fx.enemyExplode ||= w.enemyExplode;
}

/** What the enemies should do under these world effects. */
export function tuningOf(fx: WorldFx): EnemyTuning {
  return {
    ...DEFAULT_TUNING,
    // Capped on the combined total, so several players' mods cannot stack past the limits.
    speed: capTotal('enemy_speed', fx.mult.enemy_speed),
    size: capTotal('enemy_size', fx.mult.enemy_size),
    spawnRate: capTotal('enemy_spawn_rate', fx.mult.enemy_spawn_rate),
    health: capTotal('enemy_health', fx.mult.enemy_health),
    damage: capTotal('enemy_damage', fx.mult.enemy_damage),
    behavior: fx.enemyBehavior,
    ranged: fx.enemyRanged,
    leap: fx.enemyLeap,
    explode: fx.enemyExplode,
  };
}
