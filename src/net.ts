import * as THREE from 'three';
import { rayBox } from './body';
import { CELL } from './city';
import { makeBar, setBar } from './enemies';
import type { Part } from './modspec';
import { buildModel, disposeModel } from './parts';
import {
  PICKUP_RADIUS,
  SNAP_HZ,
  type ClientMsg,
  type DropState,
  type EnemyRow,
  type PlayerState,
  type ServerMsg,
  type SharedMod,
  type Vec3,
} from './netproto';
import { animateSoldier, loadSoldier, makeSoldier, soldierReady, type SoldierAnim } from './soldier';
import { HAND_LAYER } from './weapon';

const HALF_W = 0.35;
const HEIGHT = 1.9;
const HEAD = 0.45;
const RETRY_MS = 2500;

/** Another player, as drawn in this player's game. */
export interface RemotePlayer {
  state: PlayerState;
  group: THREE.Group;
  anim: SoldierAnim | null;
  /** The soldier body, hidden while a mod has given this player another look. */
  soldier: THREE.Group | null;
  /** A mod's replacement body, and which mod it came from. */
  look: THREE.Group | null;
  lookId: string;
  bar: ReturnType<typeof makeBar>;
  /** Where they are drawn, easing toward the latest reported position. */
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Drop {
  state: DropState;
  mesh: THREE.Group;
  askedAt: number;
}

/** What this player's own game tells the server about itself. */
export interface LocalState {
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

export interface NetHandlers {
  /** Another player's shot landed on us. */
  onHit(by: string, dmg: number, head: boolean): void;
  /** The server took mana from us (dropped on death). */
  onLose(amount: number): void;
  onReward(amount: number, reason: 'kill' | 'pickup' | 'enemy' | 'headshot' | 'pacified'): void;
  /** A line for the feed: joins, leaves, kills. */
  onFeed(text: string): void;
  /** Someone else fired; draw their tracer. */
  onShot(from: THREE.Vector3, to: THREE.Vector3, landed: boolean, color: string): void;
  /** We are in; `others` is how many players were already there. */
  onJoined(others: number): void;
  /** The connection dropped; the game is solo again until it comes back. */
  onOffline(): void;
  /** The server's report of the enemies everyone shares. */
  onEnemies(size: number, rows: EnemyRow[], bolts: number[][]): void;
  /** An enemy blew up. */
  onBoom(at: Vec3): void;
  /** The mods everyone shares changed. */
  onMods(list: SharedMod[]): void;
}

function nameTag(name: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = '600 34px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }),
  );
  sprite.scale.set(1.5, 0.375, 1);
  sprite.position.y = HEIGHT + 0.62;
  sprite.layers.set(HAND_LAYER); // not drawn in reflections
  sprite.renderOrder = 12;
  return sprite;
}

function dropMesh(): THREE.Group {
  const g = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({ color: 0x29e7ff });
  glow.color.multiplyScalar(2.4);
  g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.26), glow));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.025, 8, 32), glow);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  return g;
}

/** Connection to the shared game: other players, their shots, and mana left by the dead. */
export class Net {
  id = '';
  /** Our own colour, as every other player sees it. */
  color = '#e9e3d8';
  online = false;
  players = new Map<string, RemotePlayer>();
  private drops = new Map<string, Drop>();
  private ws: WebSocket | null = null;
  private name = '';
  private sendT = 0;
  private time = 0;
  private wantOpen = false;
  private looks = new Map<string, { id: string; parts: Part[] }>();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private handlers: NetHandlers,
  ) {
    // Players who arrived before the soldier model did get their bodies now.
    loadSoldier(() => {
      for (const p of this.players.values()) this.embody(p);
    });
  }

  /** Join the shared game under this name. Reconnects by itself if the connection drops. */
  connect(name: string) {
    this.name = name;
    this.wantOpen = true;
    this.open();
  }

  private open() {
    if (this.ws || !this.wantOpen) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/game`);
    this.ws = ws;
    ws.onopen = () => this.send({ t: 'join', name: this.name });
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMsg);
      } catch {
        // a malformed message is not worth dropping the connection for
      }
    };
    ws.onclose = () => {
      const was = this.online;
      this.ws = null;
      this.online = false;
      for (const id of [...this.players.keys()]) this.removePlayer(id);
      for (const id of [...this.drops.keys()]) this.removeDrop(id);
      if (was) {
        this.handlers.onOffline();
        this.handlers.onFeed('Connection lost. Reconnecting…');
      }
      if (this.wantOpen) setTimeout(() => this.open(), RETRY_MS);
    };
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private nameOf(id: string | null): string {
    if (!id) return 'the city';
    if (id === this.id) return 'You';
    return this.players.get(id)?.state.name ?? 'Someone';
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.color = msg.color;
        this.online = true;
        for (const p of msg.players) this.addPlayer(p);
        for (const d of msg.drops) this.addDrop(d);
        this.handlers.onJoined(msg.players.length);
        break;
      case 'full':
        this.wantOpen = false;
        this.handlers.onFeed('The game is full. Playing solo.');
        break;
      case 'joined':
        this.addPlayer(msg.player);
        this.handlers.onFeed(`${msg.player.name} joined`);
        break;
      case 'left':
        this.removePlayer(msg.id);
        this.handlers.onFeed(`${msg.name} left`);
        break;
      case 'snap':
        for (const s of msg.players) {
          if (s.id === this.id) continue;
          const p = this.players.get(s.id) ?? this.addPlayer(s);
          p.state = s;
        }
        break;
      case 'shot':
        this.handlers.onShot(this.a.fromArray(msg.from), this.b.fromArray(msg.to), msg.landed, msg.color);
        break;
      case 'hit':
        this.handlers.onHit(msg.by, msg.dmg, msg.head);
        break;
      case 'death': {
        const victim = this.nameOf(msg.id);
        const killer = this.nameOf(msg.by);
        this.handlers.onFeed(
          msg.by ? `${killer} flatlined ${victim === 'You' ? 'you' : victim}` : `${victim} flatlined`,
        );
        const p = this.players.get(msg.id);
        if (p) p.state.alive = false;
        if (msg.drop) this.addDrop(msg.drop);
        break;
      }
      case 'lose':
        this.handlers.onLose(msg.amount);
        break;
      case 'reward':
        this.handlers.onReward(msg.amount, msg.reason);
        break;
      case 'taken':
        this.removeDrop(msg.id);
        break;
      case 'esnap':
        this.handlers.onEnemies(msg.size, msg.e, msg.b);
        break;
      case 'eboom':
        this.handlers.onBoom(msg.at);
        break;
      case 'mods':
        this.looks = new Map();
        // Later mods override earlier ones aimed at the same player.
        for (const m of msg.list) if (m.look) this.looks.set(m.look.target, { id: m.id, parts: m.look.parts });
        for (const p of this.players.values()) this.dress(p);
        this.handlers.onMods(msg.list);
        break;
    }
  }

  private addPlayer(state: PlayerState): RemotePlayer {
    const group = new THREE.Group();
    const bar = makeBar();
    group.add(bar.back, bar.fill, nameTag(state.name, state.color));
    const p: RemotePlayer = {
      state,
      group,
      anim: null,
      soldier: null,
      look: null,
      lookId: '',
      bar,
      x: state.x,
      y: state.y,
      z: state.z,
      yaw: state.yaw,
    };
    this.embody(p);
    this.dress(p);
    this.scene.add(group);
    this.players.set(state.id, p);
    return p;
  }

  /** Give a player their body: the soldier with a visor in their colour, once it has loaded. */
  private embody(p: RemotePlayer) {
    if (p.anim || !soldierReady()) return;
    const visor = new THREE.MeshBasicMaterial({ color: p.state.color });
    visor.color.multiplyScalar(2.4);
    const { model, anim } = makeSoldier(visor);
    p.group.add(model);
    p.anim = anim;
    p.soldier = model;
    model.visible = !p.look;
  }

  /** Show a player in the look a mod has given them, or back in their own body. */
  private dress(p: RemotePlayer) {
    const want = this.looks.get(p.state.id);
    if ((want?.id ?? '') === p.lookId) return;
    if (p.look) {
      p.group.remove(p.look);
      disposeModel(p.look);
      p.look = null;
    }
    p.lookId = want?.id ?? '';
    if (want) {
      p.look = buildModel(want.parts);
      p.group.add(p.look);
    }
    if (p.soldier) p.soldier.visible = !p.look;
  }

  /** The look a mod has put on us, if any. We cannot see ourselves, so this is only for telling the player. */
  myLook(): string | null {
    return this.looks.get(this.id)?.id ?? null;
  }

  /** Find a player by the name someone typed. Returns their id, 'me', or null. */
  findPlayer(name: string): string | null {
    const want = name.trim().toLowerCase();
    if (!want || want === this.name.trim().toLowerCase()) return 'me';
    for (const p of this.players.values()) if (p.state.name.toLowerCase() === want) return p.state.id;
    for (const p of this.players.values()) if (p.state.name.toLowerCase().startsWith(want)) return p.state.id;
    return null;
  }

  /** Names of everyone else here, for telling the Architect who can be targeted. */
  names(): string[] {
    return [...this.players.values()].map((p) => p.state.name);
  }

  private removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    this.players.delete(id);
  }

  private addDrop(state: DropState) {
    if (this.drops.has(state.id)) return;
    const mesh = dropMesh();
    mesh.position.set(state.x, state.y + 0.9, state.z);
    this.scene.add(mesh);
    this.drops.set(state.id, { state, mesh, askedAt: -1e9 });
  }

  private removeDrop(id: string) {
    const d = this.drops.get(id);
    if (!d) return;
    this.scene.remove(d.mesh);
    this.drops.delete(id);
  }

  /** Send our state at the server's rate, move the other players, and collect nearby mana. */
  update(dt: number, me: LocalState) {
    this.time += dt;
    this.sendT -= dt;
    if (this.online && this.sendT <= 0) {
      this.sendT = 1 / SNAP_HZ;
      this.send({ t: 'state', ...me });
    }

    const ease = 1 - Math.exp(-14 * dt);
    for (const p of this.players.values()) {
      const s = p.state;
      // Far jumps (respawns) snap; everything else glides.
      if (Math.hypot(s.x - p.x, s.z - p.z) > 12) {
        p.x = s.x;
        p.y = s.y;
        p.z = s.z;
      } else {
        p.x += (s.x - p.x) * ease;
        p.y += (s.y - p.y) * ease;
        p.z += (s.z - p.z) * ease;
      }
      let turn = s.yaw - p.yaw;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // shortest way round
      p.yaw += turn * ease;
      p.group.visible = s.alive;
      p.group.position.set(p.x, p.y, p.z);
      // Our look direction is (-sin yaw, -cos yaw); the soldier faces +z.
      p.group.rotation.y = p.yaw + Math.PI;
      setBar(p.bar, s.health / 100);
      if (p.anim && s.alive) animateSoldier(p.anim, s.moving, 8.4, dt);
    }

    for (const d of this.drops.values()) {
      d.mesh.rotation.y += dt * 1.8;
      d.mesh.position.y = d.state.y + 0.9 + Math.sin(this.time * 2.5 + d.state.x) * 0.12;
      const near = Math.hypot(me.x - d.state.x, me.z - d.state.z) < PICKUP_RADIUS && Math.abs(me.y - d.state.y) < 2.5;
      if (me.alive && near && this.time - d.askedAt > 1) {
        d.askedAt = this.time;
        this.send({ t: 'pickup', id: d.state.id });
      }
    }
  }

  /** First living, unprotected player along a ray, closer than `max`. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number) {
    let hit: { player: RemotePlayer; t: number; head: boolean } | null = null;
    let best = max;
    for (const p of this.players.values()) {
      if (!p.state.alive || p.state.prot) continue;
      const t = rayBox(
        o.x, o.y, o.z, d.x, d.y, d.z,
        {
          minX: p.x - HALF_W,
          maxX: p.x + HALF_W,
          minY: p.y,
          maxY: p.y + HEIGHT,
          minZ: p.z - HALF_W,
          maxZ: p.z + HALF_W,
        },
        best,
      );
      if (t < 0) continue;
      best = t;
      hit = { player: p, t, head: o.y + d.y * t > p.y + HEIGHT - HEAD };
    }
    return hit;
  }

  hit(target: string, dmg: number, head: boolean) {
    this.send({ t: 'hit', target, dmg, head });
  }

  shot(from: THREE.Vector3, to: THREE.Vector3, landed: boolean, color: string) {
    this.send({ t: 'shot', from: from.toArray() as Vec3, to: to.toArray() as Vec3, landed, color });
  }

  enemyHit(id: number, dmg: number, head: boolean) {
    this.send({ t: 'ehit', id, dmg, head });
  }

  enemyBlast(at: Vec3, radius: number, dmg: number) {
    this.send({ t: 'eblast', at, radius, dmg });
  }

  /** Register a mod's shared effects with the server. `lookTarget` is the player whose body it restyles, or null. */
  shareMod(name: string, duration: number, spec: unknown, lookTarget: string | null) {
    this.send({ t: 'mod', name, duration, spec, lookTarget: lookTarget === 'me' ? this.id : lookTarget });
  }

  /** End every shared mod we bought (we died). */
  clearMods() {
    this.send({ t: 'modsclear' });
  }

  died(by: string | null, mana: number) {
    this.send({ t: 'died', by, mana });
  }

  /** A road intersection near the action but away from every other player. */
  spawnPoint(): [number, number] {
    const others = [...this.players.values()].filter((p) => p.state.alive);
    let cx = 0;
    let cz = 0;
    for (const p of others) {
      cx += p.x / others.length;
      cz += p.z / others.length;
    }
    let best: [number, number] = [Math.round(cx / CELL) * CELL, Math.round(cz / CELL) * CELL];
    let bestGap = -1;
    for (let i = 0; i < 24; i++) {
      const x = (Math.round(cx / CELL) + Math.floor(Math.random() * 5) - 2) * CELL;
      const z = (Math.round(cz / CELL) + Math.floor(Math.random() * 5) - 2) * CELL;
      const gap = others.reduce((m, p) => Math.min(m, Math.hypot(p.x - x, p.z - z)), Infinity);
      if (gap > bestGap) {
        bestGap = gap;
        best = [x, z];
      }
      if (gap > 70 && gap < 220) break; // far enough to be safe, close enough to find each other
    }
    return best;
  }

  /** Everyone in the game except us, for the scoreboard. */
  scores(): PlayerState[] {
    return [...this.players.values()].map((p) => p.state);
  }
}
