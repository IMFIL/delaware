/**
 * Difficulty zones. Every city block is easy, medium or hard. Enemies take their tier
 * from the zone they appear in: tougher and more dangerous in harder zones, and worth more mana.
 */
export type Tier = 0 | 1 | 2;

export const TIERS = [
  { name: 'Easy', health: 1, damage: 1, mana: 1, color: '#7dffa0' },
  { name: 'Medium', health: 2, damage: 1.5, mana: 2.5, color: '#ffb02e' },
  { name: 'Hard', health: 4, damage: 2, mana: 5, color: '#ff4d6d' },
] as const;

/** Mana for a kill in a tier, given the easy-zone amount. */
export const tierMana = (base: number, tier: number) => Math.round(base * (TIERS[tier] ?? TIERS[0]).mana);
