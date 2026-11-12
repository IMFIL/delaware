import { cost, sanitize, type Mod } from './modspec';

/**
 * The quick mana commands on the bar at the bottom of the screen, one per number key.
 * They are ordinary mods with fixed settings, priced by the same rules as anything the
 * Architect builds, but cast instantly and without calling the AI.
 */
export interface Preset extends Mod {
  /** Takes effect once and is gone, so it is not listed among the active mods. */
  instant: boolean;
}

function preset(name: string, duration: number, raw: Parameters<typeof sanitize>[0], instant = false): Preset {
  const spec = sanitize(raw);
  return { name, duration, spec, cost: cost(spec, duration), instant };
}

export const PRESETS: Preset[] = [
  preset('Haste', 30, { multipliers: [{ target: 'speed', mult: 2 }] }),
  preset('Leap', 30, { multipliers: [{ target: 'jump', mult: 3 }, { target: 'gravity', mult: 0.6 }] }),
  preset('Armour', 30, { multipliers: [{ target: 'damage_taken', mult: 0.5 }] }),
  preset('Heal', 10, { heal: 50 }, true),
  preset('Power', 30, { multipliers: [{ target: 'damage', mult: 2 }] }),
  preset('Rapid', 30, { multipliers: [{ target: 'fire_rate', mult: 2 }] }),
  preset('Big mag', 60, { multipliers: [{ target: 'mag_size', mult: 2 }, { target: 'reload_speed', mult: 2 }] }),
  preset('Bounce', 30, { ricochets: 2 }),
  preset('Flight', 20, { fly_speed: 10 }),
];
