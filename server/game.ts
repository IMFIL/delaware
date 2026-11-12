import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { cellColliders, CELL, type Collider } from '../src/city';
import { EnemySim } from '../src/enemysim';
import { cleanParts, playerPart, worldIsEmpty, worldPart } from '../src/modspec';
import { addWorld, neutralWorld, tuningOf } from '../src/worldfx';
import {
  DROP_FRACTION,
  DROP_LIFETIME,
  KILL_REWARD,
  MAX_PLAYERS,
  SNAP_HZ,
  type ClientMsg,
  type DropState,
  type EnemyRow,
  type PlayerState,
  type ServerMsg,
  type SharedMod,
  type Vec3,
} from '../src/netproto';

const COLORS = ['#29e7ff', '#ff9a2e', '#7dffa0', '#ff5fb0', '#b48bff', '#ffe14d', '#ff5a4d', '#5d8bff'];
const WORLD = 1e6; // positions further out than this are rejected
const MAX_HIT = 2000;
const HITS_PER_SECOND = 40;
const TICK = 0.05; // seconds per step of the enemies
const MODS_PER_PLAYER = 6;
const ENEMY_KILL = 10;
const ENEMY_HEADSHOT = 15;

interface Player extends PlayerState {
  ws: WebSocket;
  /** A death has been counted and the client has not yet reported being alive again. */
  down: boolean;
  hitsThisSecond: number;
}

interface Drop extends DropState {
  expires: number;
}

interface ActiveShared extends Omit<SharedMod, 'left'> {
  expires: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

const num = (v: unknown, min: number, max: number, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

const vec = (v: unknown): Vec3 | null =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [num(v[0], -WORLD, WORLD), num(v[1], -WORLD, WORLD), num(v[2], -WORLD, WORLD)]
    : null;

function cleanName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 16);
  return name || 'Runner';
}

/**
 * One shared game that anyone can join. The server runs the enemies, relays positions and
 * shots, referees kills and mana drops, holds the mods everyone shares, and keeps the
 * scoreboard. Each player's own game still decides how much health it has left.
 */
export class GameServer {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private players = new Map<WebSocket, Player>();
  private drops = new Map<string, Drop>();
  private nextId = 1;
  private timers: NodeJS.Timeout[] = [];
  private cells = new Map<string, Collider[]>();
  private sim = new EnemySim((x, z) => this.collidersNear(x, z));
  private shared: ActiveShared[] = [];
  private tuning = tuningOf(neutralWorld());
  private enemyKills = 0;
  private ticks = 0;

  constructor() {
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.timers.push(setInterval(() => this.snapshot(), 1000 / SNAP_HZ));
    this.timers.push(setInterval(() => this.everySecond(), 1000));
    this.timers.push(setInterval(() => this.tick(), TICK * 1000));
  }

  /** Hand a WebSocket upgrade request for the game path to this server. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  get playerCount() {
    return this.players.size;
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.wss.close();
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.players.keys()) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private pub(p: Player): PlayerState {
    const { ws: _ws, down: _down, hitsThisSecond: _h, ...state } = p;
    return state;
  }

  private byId(id: string): Player | undefined {
    for (const p of this.players.values()) if (p.id === id) return p;
    return undefined;
  }

  private onConnection(ws: WebSocket) {
    ws.on('message', (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const me = this.players.get(ws);
      if (msg.t === 'join') {
        if (!me) this.join(ws, msg.name);
      } else if (me) {
        this.onMessage(me, msg);
      }
    });
    ws.on('close', () => this.leave(ws));
    ws.on('error', () => ws.terminate());
  }

  private join(ws: WebSocket, rawName: unknown) {
    if (this.players.size >= MAX_PLAYERS) {
      this.send(ws, { t: 'full' });
      ws.close();
      return;
    }
    const taken = new Set([...this.players.values()].map((p) => p.color));
    const id = `p${this.nextId++}`;
    const me: Player = {
      ws,
      id,
      name: cleanName(rawName),
      color: COLORS.find((c) => !taken.has(c)) ?? COLORS[this.nextId % COLORS.length],
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      health: 100,
      alive: true,
      moving: false,
      prot: true,
      kills: 0,
      deaths: 0,
      mana: 0,
      down: false,
      hitsThisSecond: 0,
    };
    this.send(ws, {
      t: 'welcome',
      id,
      players: [...this.players.values()].map((p) => this.pub(p)),
      drops: [...this.drops.values()].map(({ expires: _e, ...d }) => d),
    });
    this.players.set(ws, me);
    this.broadcast({ t: 'joined', player: this.pub(me) }, ws);
    this.send(ws, { t: 'mods', list: this.modList() });
  }

  private leave(ws: WebSocket) {
    const me = this.players.get(ws);
    if (!me) return;
    this.players.delete(ws);
    this.broadcast({ t: 'left', id: me.id, name: me.name });
  }

  private onMessage(me: Player, msg: ClientMsg) {
    switch (msg.t) {
      case 'state':
        me.x = num(msg.x, -WORLD, WORLD);
        me.y = num(msg.y, -10, 5000);
        me.z = num(msg.z, -WORLD, WORLD);
        me.yaw = num(msg.yaw, -1e4, 1e4);
        me.health = num(msg.health, 0, 1e5);
        me.alive = msg.alive === true;
        me.moving = msg.moving === true;
        me.prot = msg.prot === true;
        me.mana = Math.floor(num(msg.mana, 0, 1e7));
        if (me.alive) me.down = false;
        break;

      case 'shot': {
        const from = vec(msg.from);
        const to = vec(msg.to);
        if (!from || !to) return;
        const color = /^#[0-9a-fA-F]{6}$/.test(String(msg.color)) ? msg.color : '';
        this.broadcast({ t: 'shot', id: me.id, from, to, landed: msg.landed === true, color }, me.ws);
        break;
      }

      case 'hit': {
        if (!me.alive || ++me.hitsThisSecond > HITS_PER_SECOND) return;
        const target = this.byId(String(msg.target));
        if (!target || target === me || !target.alive || target.prot) return;
        this.send(target.ws, {
          t: 'hit',
          by: me.id,
          dmg: num(msg.dmg, 0, MAX_HIT),
          head: msg.head === true,
        });
        break;
      }

      case 'died': {
        if (me.down) return; // one death per life
        me.down = true;
        me.alive = false;
        me.deaths++;
        const killer = msg.by ? this.byId(String(msg.by)) : undefined;
        const amount = Math.floor(num(msg.mana, 0, 1e7) * DROP_FRACTION);
        let drop: Drop | null = null;
        if (amount >= 1) {
          drop = {
            id: `d${this.nextId++}`,
            x: me.x,
            y: me.y,
            z: me.z,
            amount,
            expires: Date.now() + DROP_LIFETIME * 1000,
          };
          this.drops.set(drop.id, drop);
          this.send(me.ws, { t: 'lose', amount });
        }
        if (killer && killer !== me) {
          killer.kills++;
          this.send(killer.ws, { t: 'reward', amount: KILL_REWARD, reason: 'kill' });
        }
        this.broadcast({
          t: 'death',
          id: me.id,
          by: killer && killer !== me ? killer.id : null,
          drop: drop && { id: drop.id, x: drop.x, y: drop.y, z: drop.z, amount: drop.amount },
        });
        break;
      }

      case 'ehit': {
        if (!me.alive || ++me.hitsThisSecond > HITS_PER_SECOND) return;
        const enemy = this.sim.byId(Math.floor(num(msg.id, 0, 1e9)));
        if (enemy && this.sim.damage(enemy, num(msg.dmg, 0, MAX_HIT))) this.payForKill(me, msg.head === true);
        break;
      }

      case 'eblast': {
        const at = vec(msg.at);
        if (!at || !me.alive || ++me.hitsThisSecond > HITS_PER_SECOND) return;
        const kills = this.sim.damageArea(at, num(msg.radius, 0, 8), num(msg.dmg, 0, MAX_HIT));
        for (let i = 0; i < kills; i++) this.payForKill(me, false);
        break;
      }

      case 'mod': {
        const world = worldPart(msg.spec);
        const target = msg.lookTarget ? this.byId(String(msg.lookTarget)) : undefined;
        const parts = target ? cleanParts((msg.spec as { playerModel?: unknown } | null)?.playerModel) : [];
        const look = target && parts.length ? { target: target.id, parts } : null;
        // Stat changes are only held here when aimed at someone else; your own stay in your own game.
        const changes = target && target !== me ? playerPart(msg.spec) : [];
        const stats = target && changes.length ? { target: target.id, changes } : null;
        if (worldIsEmpty(world) && !look && !stats) return;
        const duration = Math.round(num(msg.duration, 10, 300, 60));
        const mine = this.shared.filter((m) => m.by === me.id);
        if (mine.length >= MODS_PER_PLAYER) this.shared.splice(this.shared.indexOf(mine[0]), 1);
        this.shared.push({
          id: `m${this.nextId++}`,
          by: me.id,
          byName: me.name,
          name: String(msg.name ?? 'Mod').slice(0, 32),
          duration,
          world,
          look,
          stats,
          expires: Date.now() + duration * 1000,
        });
        this.modsChanged();
        break;
      }

      case 'modsclear':
        if (this.shared.some((m) => m.by === me.id)) {
          this.shared = this.shared.filter((m) => m.by !== me.id);
          this.modsChanged();
        }
        break;

      case 'pickup': {
        const drop = this.drops.get(String(msg.id));
        if (!drop || !me.alive) return;
        // Generous radius: the server's idea of where a player is lags a little.
        if (Math.hypot(me.x - drop.x, me.z - drop.z) > 5 || Math.abs(me.y - drop.y) > 4) return;
        this.drops.delete(drop.id);
        this.send(me.ws, { t: 'reward', amount: drop.amount, reason: 'pickup' });
        this.broadcast({ t: 'taken', id: drop.id, by: me.id });
        break;
      }
    }
  }

  private snapshot() {
    if (this.players.size < 2) return; // nobody to tell
    this.broadcast({ t: 'snap', players: [...this.players.values()].map((p) => this.pub(p)) });
  }

  /** The solid things near a point, building and remembering each city cell the first time it is needed. */
  private collidersNear(x: number, z: number): Collider[] {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const out: Collider[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${cx + dx},${cz + dz}`;
        let cell = this.cells.get(key);
        if (!cell) {
          if (this.cells.size > 600) this.cells.clear(); // players have roamed far; start over
          cell = cellColliders(cx + dx, cz + dz);
          this.cells.set(key, cell);
        }
        for (const c of cell) out.push(c);
      }
    }
    return out;
  }

  private payForKill(killer: Player, head: boolean) {
    this.enemyKills++;
    // Enemies made harmless by a mod are not worth anything.
    if (this.tuning.behavior !== 'normal') {
      this.send(killer.ws, { t: 'reward', amount: 0, reason: 'pacified' });
    } else {
      this.send(killer.ws, {
        t: 'reward',
        amount: head ? ENEMY_HEADSHOT : ENEMY_KILL,
        reason: head ? 'headshot' : 'enemy',
      });
    }
  }

  private modList(): SharedMod[] {
    const now = Date.now();
    return this.shared.map(({ expires, ...m }) => ({ ...m, left: Math.max(0, (expires - now) / 1000) }));
  }

  /** Recompute what the shared mods add up to, and tell everyone. */
  private modsChanged() {
    const fx = neutralWorld();
    for (const m of this.shared) addWorld(fx, m.world);
    this.tuning = tuningOf(fx);
    this.broadcast({ t: 'mods', list: this.modList() });
  }

  /** One step of the enemies everyone shares. */
  private tick() {
    if (!this.players.size) {
      if (this.sim.list.length) this.sim.clear();
      return;
    }
    // Enemies leave the dead and the freshly respawned alone.
    const targets = [...this.players.values()].map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      alive: p.alive && !p.prot,
    }));
    const step = this.sim.update(TICK, targets, this.enemyKills, this.tuning);
    for (const [id, dmg] of step.damage) {
      const p = this.byId(id);
      if (p) this.send(p.ws, { t: 'hit', by: 'enemy', dmg, head: false });
    }
    for (const at of step.blasts) this.broadcast({ t: 'eboom', at });
    if (++this.ticks % 2) return; // report at half the step rate
    const e = this.sim.list.map(
      (s): EnemyRow => [
        s.id,
        round(s.body.x),
        round(s.body.y),
        round(s.body.z),
        round(s.facing),
        round(s.hp),
        (s.moving ? 1 : 0) | (s.striking ? 2 : 0) | (s.dying > 0 ? 4 : 0),
        round(s.pace),
        round(s.lift),
      ],
    );
    const b = this.sim.bolts.map((bolt) => [round(bolt.x), round(bolt.y), round(bolt.z)]);
    this.broadcast({ t: 'esnap', size: this.tuning.size, e, b });
  }

  private everySecond() {
    for (const p of this.players.values()) p.hitsThisSecond = 0;
    const now = Date.now();
    if (this.shared.some((m) => m.expires <= now)) {
      this.shared = this.shared.filter((m) => m.expires > now);
      this.modsChanged();
    }
    for (const d of this.drops.values()) {
      if (d.expires <= now) {
        this.drops.delete(d.id);
        this.broadcast({ t: 'taken', id: d.id, by: null });
      }
    }
  }
}
