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
  preset('Leap', 30, { multipliers: [{ target: 'jump', mult: 3 }, { target: 'gravity', mult: 0.6 }] }),
  preset('Heal', 10, { heal: 50 }, true),
  preset('Haste', 30, { multipliers: [{ target: 'speed', mult: 2 }] }),
];
