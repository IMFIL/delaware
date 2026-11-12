import type { ModRow } from './mods';
import type { Mod } from './modspec';
import { summarize } from './mods';

const SLOTS = 9;
const RADAR_RANGE = 70; // metres from centre to rim

const el = (id: string) => document.getElementById(id)!;

export type LogKind = 'you' | 'ai' | 'warn' | 'wait';

/** A line in the chat log that can be rewritten once an answer arrives. */
export interface LogLine {
  set(text: string, kind: LogKind): void;
}

export class Hud {
  selected = 0;
  private hotbar = el('hotbar');
  private invHotbar = el('inv-hotbar');
  private inventory = el('inventory');
  private menu = el('menu');
  private menuAction = el('menu-action');
  private debug = el('debug');
  private hpFill = el('hp-fill');
  private hpText = el('hp-text');
  private manaText = el('mana-text');
  private hurtEl = el('hurt');
  private marker = el('hitmarker');
  private toasts = el('toasts');
  private dead = el('dead');
  private resumeEl = el('resume');
  private offerEl = el('offer');
  private scoresEl = el('scores');
  private nameInput = el('callsign') as HTMLInputElement;
  private chat = el('chat') as HTMLFormElement;
  private chatInput = el('chat-input') as HTMLInputElement;
  private chatLog = el('chatlog');
  private modsEl = el('mods');
  private radar = (el('radar') as HTMLCanvasElement).getContext('2d')!;
  private shownHp = '';
  private shownMana = -1;
  private shownAmmo = '';
  private ammoEl = el('ammo');
  private ammoN = el('ammo-n');
  private shownMods = -1;
  private modRows: { fill: HTMLElement; time: HTMLElement }[] = [];

  /** `onChat` gets the typed text, or null if the player backed out. */
  constructor(onChat: (text: string | null) => void) {
    const slot = (n?: number) => {
      const s = document.createElement('div');
      s.className = 'slot';
      if (n !== undefined) s.dataset.n = String(n);
      return s;
    };
    for (let i = 0; i < SLOTS; i++) {
      this.hotbar.append(slot(i + 1));
      this.invHotbar.append(slot());
    }
    const grid = el('inv-grid');
    for (let i = 0; i < SLOTS * 3; i++) grid.append(slot());
    for (const bar of [this.hotbar, this.invHotbar]) {
      const item = document.createElement('b');
      item.textContent = 'Sidearm';
      bar.children[0].append(item);
    }
    this.select(0);

    // Remember the player's name between visits; invent one the first time.
    let saved = '';
    try {
      saved = localStorage.getItem('delaware-name') ?? '';
    } catch {
      // private windows may refuse storage; the name just will not be remembered
    }
    this.nameInput.value = saved || `Runner-${Math.floor(100 + Math.random() * 900)}`;
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());

    this.chat.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      this.closeChat();
      onChat(text || null);
    });
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not move the player
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeChat();
        onChat(null);
      }
    });
    this.chatInput.addEventListener('keyup', (e) => e.stopPropagation());
  }

  select(i: number) {
    this.selected = ((i % SLOTS) + SLOTS) % SLOTS;
    for (const bar of [this.hotbar, this.invHotbar]) {
      [...bar.children].forEach((s, n) => s.classList.toggle('selected', n === this.selected));
    }
  }

  showMenu(show: boolean, resumed = false) {
    this.menu.hidden = !show;
    this.menuAction.textContent = resumed ? 'Click to resume' : 'Click to start';
  }

  showInventory(show: boolean) {
    this.inventory.hidden = !show;
  }

  /** The name the player has chosen for multiplayer. */
  playerName(): string {
    const name = this.nameInput.value.trim().slice(0, 16) || 'Runner';
    try {
      localStorage.setItem('delaware-name', name);
    } catch {
      // see above
    }
    return name;
  }

  /** Pressing Enter in the name box starts the game. */
  onNameEnter(start: () => void) {
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') start();
    });
  }

  /** Scoreboard of everyone in the game, or null to hide it. */
  showScores(rows: { name: string; color: string; kills: number; deaths: number; mana: number }[] | null) {
    this.scoresEl.hidden = !rows;
    if (!rows) return;
    const body = this.scoresEl.querySelector('tbody')!;
    body.replaceChildren();
    for (const r of [...rows].sort((a, b) => b.kills - a.kills)) {
      const tr = document.createElement('tr');
      for (const [i, text] of [r.name, r.kills, r.deaths, r.mana].entries()) {
        const td = document.createElement('td');
        td.textContent = String(text);
        if (i === 0) td.style.color = r.color;
        tr.append(td);
      }
      body.append(tr);
    }
  }

  /** Card asking the player to confirm a mod's price before it is charged. */
  showOffer(mod: Mod, mana: number) {
    el('offer-name').textContent = mod.name;
    el('offer-what').textContent = summarize(mod.spec);
    el('offer-cost').textContent = String(mod.cost);
    el('offer-time').textContent = `${mod.duration}s`;
    el('offer-left').textContent = String(mana - mod.cost);
    el('offer-bar').style.width = '100%';
    this.offerEl.hidden = false;
  }

  /** `fraction` of the time to answer that is left, 0 to 1. */
  setOfferTime(fraction: number) {
    el('offer-bar').style.width = `${Math.max(0, fraction * 100)}%`;
  }

  hideOffer() {
    this.offerEl.hidden = true;
  }

  /** Small prompt shown when the game is waiting for a click or key to carry on. */
  showResume(show: boolean) {
    this.resumeEl.hidden = !show;
  }

  showDead(show: boolean) {
    this.dead.hidden = !show;
  }

  openChat() {
    this.chat.hidden = false;
    this.chatInput.value = '';
    this.chatLog.classList.add('open');
    // Focus on the next tick so the key that opened the box is not typed into it.
    setTimeout(() => this.chatInput.focus(), 0);
  }

  private closeChat() {
    this.chat.hidden = true;
    this.chatLog.classList.remove('open');
    this.chatInput.blur();
  }

  /** Add a line to the chat log. It fades after a while unless the chat box is open. */
  log(text: string, kind: LogKind): LogLine {
    const line = document.createElement('div');
    this.chatLog.append(line);
    while (this.chatLog.children.length > 8) this.chatLog.firstElementChild!.remove();
    let timer = 0;
    const set = (t: string, k: LogKind) => {
      line.textContent = t;
      line.className = k;
      clearTimeout(timer);
      line.classList.remove('old');
      if (k !== 'wait') timer = window.setTimeout(() => line.classList.add('old'), 9000);
    };
    set(text, kind);
    return { set };
  }

  toggleDebug() {
    this.debug.hidden = !this.debug.hidden;
  }

  setDebug(text: string) {
    if (!this.debug.hidden) this.debug.textContent = text;
  }

  setVitals(health: number, maxHealth: number, mana: number) {
    const hp = Math.max(0, Math.ceil(health));
    const key = `${hp}/${Math.round(maxHealth)}`;
    if (key !== this.shownHp) {
      this.shownHp = key;
      this.hpFill.style.width = `${Math.min(100, (hp / maxHealth) * 100)}%`;
      this.hpText.textContent = String(hp);
      this.hpFill.classList.toggle('low', hp <= maxHealth * 0.3);
    }
    if (mana !== this.shownMana) {
      this.shownMana = mana;
      this.manaText.textContent = String(mana);
    }
  }

  /** Rounds left in the magazine. `armed` is false when the gun is not in hand. */
  setAmmo(rounds: number, reloading: boolean, armed: boolean) {
    const key = `${rounds}|${reloading}|${armed}`;
    if (key === this.shownAmmo) return;
    this.shownAmmo = key;
    this.ammoEl.hidden = !armed;
    this.ammoN.textContent = reloading ? '··' : String(Math.max(0, rounds));
    this.ammoEl.classList.toggle('low', !reloading && rounds <= 6);
    this.ammoEl.classList.toggle('reloading', reloading);
  }

  /** List of mods in force with a draining bar each. `version` changes when the list does. */
  setMods(rows: ModRow[], version: number) {
    if (version !== this.shownMods || rows.length !== this.modRows.length) {
      this.shownMods = version;
      this.modsEl.replaceChildren();
      this.modRows = rows.map((m) => {
        const row = document.createElement('div');
        row.className = 'mod';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = m.name;
        const time = document.createElement('span');
        time.className = 'time';
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = m.what;
        const track = document.createElement('div');
        track.className = 'track';
        const fill = document.createElement('i');
        track.append(fill);
        row.append(name, time, what, track);
        this.modsEl.append(row);
        return { fill, time };
      });
    }
    rows.forEach((m, i) => {
      const row = this.modRows[i];
      if (!row) return;
      row.fill.style.width = `${Math.max(0, (m.left / m.duration) * 100)}%`;
      const secs = `${Math.ceil(m.left)}s`;
      if (row.time.textContent !== secs) row.time.textContent = secs;
    });
  }

  private replay(node: HTMLElement, cls: string) {
    node.classList.remove(cls);
    void node.offsetWidth; // restart the CSS animation
    node.classList.add(cls);
  }

  hurt() {
    this.replay(this.hurtEl, 'on');
  }

  hitmarker(kill: boolean) {
    this.marker.classList.toggle('kill', kill);
    this.replay(this.marker, 'on');
  }

  toast(text: string) {
    const t = document.createElement('div');
    t.textContent = text;
    this.toasts.append(t);
    setTimeout(() => t.remove(), 1600);
  }

  /** Top-down radar: the player faces up, enemies are red dots, other players are dots in their own colour. */
  drawRadar(
    px: number,
    pz: number,
    yaw: number,
    enemies: { body: { x: number; z: number } }[],
    others: Iterable<{ x: number; z: number; state: { alive: boolean; color: string } }> = [],
  ) {
    const g = this.radar;
    const size = g.canvas.width;
    const c = size / 2;
    const rim = c - 6;
    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(8, 11, 14, 0.7)';
    g.beginPath();
    g.arc(c, c, rim, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255, 154, 46, 0.45)';
    g.lineWidth = 1;
    g.stroke();
    g.beginPath();
    g.arc(c, c, rim / 2, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255, 154, 46, 0.15)';
    g.stroke();

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    g.fillStyle = '#ff3b3b';
    g.shadowColor = '#ff3b3b';
    g.shadowBlur = 6;
    for (const e of enemies) {
      const dx = e.body.x - px;
      const dz = e.body.z - pz;
      let rx = (dx * cos - dz * sin) / RADAR_RANGE;
      let rf = (-dx * sin - dz * cos) / RADAR_RANGE;
      const len = Math.hypot(rx, rf);
      if (len > 1) {
        rx /= len;
        rf /= len;
      }
      g.beginPath();
      g.arc(c + rx * rim, c - rf * rim, len > 1 ? 2 : 3, 0, Math.PI * 2);
      g.fill();
    }
    for (const o of others) {
      if (!o.state.alive) continue;
      const dx = o.x - px;
      const dz = o.z - pz;
      let rx = (dx * cos - dz * sin) / RADAR_RANGE;
      let rf = (-dx * sin - dz * cos) / RADAR_RANGE;
      const len = Math.hypot(rx, rf);
      if (len > 1) {
        rx /= len;
        rf /= len;
      }
      g.fillStyle = g.shadowColor = o.state.color;
      g.fillRect(c + rx * rim - 3, c - rf * rim - 3, 6, 6); // squares, so they are not mistaken for enemies
    }
    g.shadowBlur = 0;
    g.fillStyle = '#e9e3d8';
    g.beginPath();
    g.moveTo(c, c - 6);
    g.lineTo(c + 4.5, c + 5);
    g.lineTo(c - 4.5, c + 5);
    g.fill();
  }
}
