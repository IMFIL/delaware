/** Messages between the game and the multiplayer server. Shared by both sides. */
import type { Part, StatChange, WorldSpec } from './modspec';

export const MAX_PLAYERS = 16;
export const SNAP_HZ = 15;
/** Mana for killing another player, on top of what they drop. */
export const KILL_REWARD = 10;
/** Share of a dead player's mana left on the ground. */
export const DROP_FRACTION = 0.2;
export const DROP_LIFETIME = 60; // seconds
export const PICKUP_RADIUS = 1.6;
export const RESPAWN_PROTECTION = 3; // seconds

export type Vec3 = [number, number, number];

export interface PlayerState {
  id: string;
  name: string;
  /** Visor colour, "#rrggbb". */
  color: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  health: number;
  alive: boolean;
  moving: boolean;
  /** Just respawned and cannot be hurt. */
  prot: boolean;
  kills: number;
  deaths: number;
  mana: number;
}

export interface DropState {
  id: string;
  x: number;
  y: number;
  z: number;
  amount: number;
}

/** One enemy as reported by the server: id, x, y, z, facing, hp, flags (1 moving, 2 striking, 4 dying), pace, lift. */
export type EnemyRow = [number, number, number, number, number, number, number, number, number];

/** A mod whose effects everyone in the game shares. */
export interface SharedMod {
  id: string;
  /** Id and name of the player who bought it. */
  by: string;
  byName: string;
  name: string;
  duration: number;
  /** Seconds remaining when this was sent. */
  left: number;
  world: WorldSpec;
  /** A new look for one player's body, or null. */
  look: { target: string; parts: Part[] } | null;
  /** Stat changes placed on one player, or null. */
  stats: { target: string; changes: StatChange[] } | null;
}

export type ClientMsg =
  | { t: 'join'; name: string }
  | {
      t: 'state';
      x: number;
      y: number;
      z: number;
      yaw: number;
      health: number;
      alive: boolean;
      moving: boolean;
      prot: boolean;
      mana: number;
    }
  | { t: 'shot'; from: Vec3; to: Vec3; landed: boolean; color: string }
  | { t: 'hit'; target: string; dmg: number; head: boolean }
  | { t: 'died'; by: string | null; mana: number }
  | { t: 'pickup'; id: string }
  | { t: 'ehit'; id: number; dmg: number; head: boolean }
  | { t: 'eblast'; at: Vec3; radius: number; dmg: number }
  | { t: 'mod'; name: string; duration: number; spec: unknown; lookTarget: string | null }
  | { t: 'modsclear' };

export type ServerMsg =
  | { t: 'welcome'; id: string; players: PlayerState[]; drops: DropState[] }
  | { t: 'full' }
  | { t: 'joined'; player: PlayerState }
  | { t: 'left'; id: string; name: string }
  | { t: 'snap'; players: PlayerState[] }
  | { t: 'shot'; id: string; from: Vec3; to: Vec3; landed: boolean; color: string }
  | { t: 'hit'; by: string; dmg: number; head: boolean }
  | { t: 'death'; id: string; by: string | null; drop: DropState | null }
  | { t: 'lose'; amount: number }
  | { t: 'reward'; amount: number; reason: 'kill' | 'pickup' | 'enemy' | 'headshot' | 'pacified' }
  | { t: 'esnap'; size: number; e: EnemyRow[]; b: number[][] }
  | { t: 'eboom'; at: Vec3 }
  | { t: 'mods'; list: SharedMod[] }
  | { t: 'taken'; id: string; by: string | null };
