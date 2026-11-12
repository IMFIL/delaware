import '@fontsource/syncopate/400.css';
import '@fontsource/syncopate/700.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Sfx } from './audio';
import { raycastHit, surfaceNormal } from './body';
import { CELL, City } from './city';
import { createGround } from './ground';
import { createFilmPass } from './post';
import { Enemies, setEnemyHighlight } from './enemies';
import { Hud, type LogLine } from './hud';
import { Mods, summarize } from './mods';
import { WORLD_TARGETS, type Mod, type ModReply } from './modspec';
import { Net } from './net';
import { RESPAWN_PROTECTION } from './netproto';
import { NO_INPUT, Player } from './player';
import { createRain } from './rain';
import { createSky, HAZE } from './sky';
import { initModelLighting } from './parts';
import { HAND_LAYER, MAG_SIZE, Weapon } from './weapon';

const MAX_HEALTH = 100;
const REGEN_DELAY = 5; // seconds without damage before health comes back
const REGEN_RATE = 8;
const RESPAWN_TIME = 3;
const GUN_RANGE = 120;
const BODY_DAMAGE = 25;
const HEAD_DAMAGE = 50;
const KILL_MANA = 10;
const HEADSHOT_BONUS = 5;
const FOG_DENSITY = 0.0065;
const EXPOSURE = 1.15;
const OFFER_TIME = 20; // seconds the player has to accept a priced mod
const RICOCHET_DAMAGE = 0.85; // a shot keeps this much of its damage after each bounce
const MULTI_PELLET_DAMAGE = 0.6; // each pellet of a multi-shot does a little less

// The neon signs are drawn with the display font, so it has to be ready first.
await Promise.all([
  document.fonts.load('700 64px Syncopate'),
  document.fonts.load('500 16px Rajdhani'),
]).catch(() => {});

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
initModelLighting(renderer);

const scene = new THREE.Scene();
const fog = new THREE.FogExp2(HAZE, FOG_DENSITY);
scene.fog = fog;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.15, 2600);
scene.add(camera); // so the weapon in the player's hand is drawn
camera.layers.enable(HAND_LAYER);

const sky = createSky(scene, renderer);
const rain = createRain(scene);
const REFLECTION_SCALE = 0.5; // the road's mirror image is drawn at half resolution
const ground = createGround(
  scene,
  window.innerWidth * pixelRatio * REFLECTION_SCALE,
  window.innerHeight * pixelRatio * REFLECTION_SCALE,
);
// Night: cool light from the sky, warm bounce from the streets, and a faint moonlit key.
scene.add(new THREE.HemisphereLight(0x7f9fb8, 0x5a3a22, 2.4));
const key = new THREE.DirectionalLight(0x9fc0ff, 0.7);
key.position.set(0.45, 0.72, 0.35);
scene.add(key);

const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
);
composer.setPixelRatio(pixelRatio);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.7, 0.6),
);
const film = createFilmPass();
composer.addPass(film.pass);
composer.addPass(new OutputPass());

const sfx = new Sfx();
const city = new City(scene);
const player = new Player();
const hud = new Hud(onChat);
const mods = new Mods();
const weapon = new Weapon(camera, scene, (cue) => sfx[cue]());
const enemies = new Enemies(scene, city);

// Start on a road, a little way back from an intersection.
player.z = 30;
city.update(player.x, player.z, 30);

// 'resume' is a light pause after the chat box closes, when the browser has not yet
// let us recapture the mouse: the next click or key press carries on, with no menu.
type State = 'menu' | 'playing' | 'inventory' | 'chat' | 'resume';
let state: State = 'menu';
let started = false;
const keys = new Set<string>();
let lastForwardTap = -1e9;
let firing = false;
let leftChatAt = -1e9; // when the chat box was last closed with Escape

const stats = { health: MAX_HEALTH, mana: 0, kills: 0 };
let sinceHurt = 99;
let deadFor = 0; // > 0 while waiting to respawn
let protectedFor = 0; // seconds of respawn protection left, in multiplayer
const pvp = { kills: 0, deaths: 0 };
const debug = { play: false };

/** The shared game. Until we join (or if the server is unreachable) the game simply plays solo. */
const net = new Net(scene, {
  onHit(by, dmg) {
    if (deadFor > 0 || protectedFor > 0) return;
    hurt(dmg * mods.fx.mult.damage_taken, by === 'enemy' ? null : by);
  },
  onLose(amount) {
    stats.mana = Math.max(0, stats.mana - amount);
    hud.toast(`Dropped ${amount} mana`);
  },
  onReward(amount, reason) {
    stats.mana += amount;
    if (reason === 'kill') {
      pvp.kills++;
      hud.toast(`Player down  +${amount} mana`);
      hud.hitmarker(true);
      sfx.kill();
    } else if (reason !== 'pickup') {
      // An enemy we shot died; the server keeps the shared enemies' health.
      stats.kills++;
      hud.toast(
        reason === 'pacified' ? 'No mana: enemies pacified' : reason === 'headshot' ? `Headshot  +${amount} mana` : `+${amount} mana`,
      );
      hud.hitmarker(true);
      sfx.kill();
    } else {
      hud.toast(`Picked up ${amount} mana`);
      sfx.mod();
    }
  },
  onFeed(text) {
    hud.log(text, 'warn');
  },
  onShot(from, to, landed, color) {
    weapon.trace(to, landed, color || undefined, 0, from);
  },
  onJoined(others) {
    hud.log(
      others ? `Joined the game. ${others} other player${others > 1 ? 's' : ''} here.` : 'Joined the game. Nobody else is here yet.',
      'ai',
    );
    if (others) {
      placeAtSpawn();
      protectedFor = RESPAWN_PROTECTION;
    }
    // From here on the server runs the enemies and holds the world-changing mods.
    enemies.setRemote({
      hit: (id, amount, head) => net.enemyHit(id, amount, head),
      blast: (at, radius, amount) => net.enemyBlast(at, radius, amount),
    });
    mods.setOnline(true);
  },
  onOffline() {
    enemies.setRemote(null);
    mods.setOnline(false);
  },
  onEnemies(size, rows, bolts) {
    enemies.applySnapshot(size, rows, bolts);
  },
  onBoom(at) {
    enemies.showBlast(at);
  },
  onMods(list) {
    mods.setShared(list, net.id);
  },
});

function placeAtSpawn() {
  const [x, z] = net.spawnPoint();
  player.x = x;
  player.z = z;
  player.y = 0;
  player.vx = player.vy = player.vz = 0;
}

/** Take damage from an enemy or, when `by` is set, from another player. */
function hurt(amount: number, by: string | null = null) {
  stats.health -= amount;
  sinceHurt = 0;
  hud.hurt();
  sfx.hurt();
  if (stats.health <= 0) die(by);
} // lets tests run the simulation without mouse capture

function lock(onFail?: () => void) {
  sfx.resume();
  const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
  p?.catch?.(
    onFail ??
      (() => {
        state = 'menu';
        hud.showMenu(true, started);
      }),
  );
}

/** Go back to the game after the chat box, without ever showing the menu. */
function resume() {
  state = 'resume';
  // Browsers refuse to recapture the mouse from an Esc press, so wait for the next input.
  lock(() => hud.showResume(true));
}
document.addEventListener('mousedown', () => {
  if (state === 'resume') resume();
});

document.getElementById('menu')!.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('input')) return; // typing a name is not "start"
  lock();
});
hud.onNameEnter(() => lock());
const SOLO = new URLSearchParams(location.search).has('solo');
let joined = false;
canvas.addEventListener('click', () => {
  if (state === 'menu' && document.pointerLockElement !== canvas) lock();
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    state = 'playing';
    started = true;
    if (!joined && !SOLO) {
      joined = true;
      net.connect(hud.playerName());
    }
    hud.showMenu(false);
    hud.showInventory(false);
    hud.showResume(false);
  } else {
    keys.clear();
    firing = false;
    if (state === 'playing' && (offer || performance.now() - leftChatAt < 1500)) {
      // Escape while the Architect's offer is up means "no thanks", and Escape just after
      // closing the chat box is the same key press: neither should open the menu.
      declineOffer();
      state = 'resume';
      hud.showResume(true);
    } else if (state === 'playing' || state === 'menu') {
      state = 'menu';
      hud.showMenu(true, started);
    }
  }
});

document.addEventListener('mousemove', (e) => {
  if (state === 'playing' && deadFor <= 0) player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (state === 'playing' && e.button === 0) firing = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    hud.toggleDebug();
    return;
  }
  if (state === 'resume') {
    if (e.code !== 'Escape') resume(); // any other key is allowed to recapture the mouse
    return;
  }
  if (state === 'inventory') {
    if (e.code === 'KeyE' || e.code === 'Escape') {
      e.preventDefault();
      hud.showInventory(false);
      state = 'menu';
      lock();
    }
    return;
  }
  if (state !== 'playing') return;
  if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  if (e.code === 'Tab') {
    hud.showScores([
      { name: `${hud.playerName()} (you)`, color: '#e9e3d8', kills: pvp.kills, deaths: pvp.deaths, mana: stats.mana },
      ...net.scores(),
    ]);
  }
  if (offer && (e.code === 'KeyY' || e.code === 'KeyN')) {
    if (e.code === 'KeyY') acceptOffer();
    else declineOffer();
    return;
  }
  if (e.code === 'KeyR') weapon.reload();
  if (e.code === 'KeyT') {
    e.preventDefault();
    state = 'chat';
    hud.openChat();
    document.exitPointerLock();
    return;
  }
  if (e.code === 'KeyE') {
    state = 'inventory';
    hud.showInventory(true);
    document.exitPointerLock();
    return;
  }
  if (e.code === 'KeyW' && !e.repeat) {
    const now = performance.now();
    if (now - lastForwardTap < 300) player.startSprint();
    lastForwardTap = now;
  }
  if (/^Digit[1-9]$/.test(e.code)) hud.select(Number(e.code[5]) - 1);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') hud.showScores(null);
});
window.addEventListener('blur', () => keys.clear());
window.addEventListener(
  'wheel',
  (e) => {
    if (state === 'playing') hud.select(hud.selected + Math.sign(e.deltaY));
  },
  { passive: true },
);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  ground.setSize(
    window.innerWidth * pixelRatio * REFLECTION_SCALE,
    window.innerHeight * pixelRatio * REFLECTION_SCALE,
  );
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const aim = new THREE.Vector3();
const shotEnd = new THREE.Vector3();

const legStart = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();

function reward(head: boolean) {
  stats.kills++;
  if (mods.fx.enemyBehavior !== 'normal') {
    hud.toast('No mana: enemies pacified'); // harmless enemies are not worth anything
    return;
  }
  const gain = KILL_MANA + (head ? HEADSHOT_BONUS : 0);
  stats.mana += gain;
  hud.toast(head ? `Headshot  +${gain} mana` : `+${gain} mana`);
}

/** One trigger pull: one or more hitscan pellets along the crosshair. */
function shoot() {
  const fx = mods.fx;
  const o = camera.position;
  camera.getWorldDirection(aim);
  right.setFromMatrixColumn(camera.matrixWorld, 0);
  up.setFromMatrixColumn(camera.matrixWorld, 1);
  const base = aim.clone();
  const spread = fx.pellets > 1 ? Math.max(fx.spread, 0.03) : fx.spread;
  const scale = fx.mult.damage * (fx.pellets > 1 ? MULTI_PELLET_DAMAGE : 1);
  const cols = city.collidersNear(o.x, o.z).slice(); // copy: enemies reuse the same list
  const color = fx.tracerColor || undefined;
  weapon.spend();
  let anyHit = false;
  let anyKill = false;

  for (let i = 0; i < fx.pellets; i++) {
    aim.copy(base);
    if (spread > 0) {
      const ang = Math.random() * Math.PI * 2;
      const r = spread * Math.sqrt(Math.random());
      aim.addScaledVector(right, Math.cos(ang) * r).addScaledVector(up, Math.sin(ang) * r).normalize();
    }
    // Follow the shot from surface to surface until it hits an enemy or runs out of bounces.
    legStart.copy(o);
    let power = scale;
    for (let bounce = 0; ; bounce++) {
      const world = raycastHit(legStart.x, legStart.y, legStart.z, aim.x, aim.y, aim.z, GUN_RANGE, cols);
      let t = world.t;
      let street = false;
      if (aim.y < 0 && -legStart.y / aim.y < t) {
        t = -legStart.y / aim.y;
        street = true;
      }
      let hit = enemies.raycast(legStart, aim, t);
      if (hit) t = hit.t;
      const rival = net.raycast(legStart, aim, t); // another player in the way
      if (rival) {
        t = rival.t;
        hit = null;
      }
      shotEnd.copy(legStart).addScaledVector(aim, t);
      const landed = t < GUN_RANGE;
      const bounces = !hit && !rival && landed && bounce < fx.ricochets;
      weapon.trace(
        shotEnd,
        landed,
        color,
        landed && !bounces ? fx.explosionRadius : 0,
        bounce ? legStart : undefined,
      );
      if (net.online) {
        // Others see the shot leave from about where the gun is held.
        if (!bounce) legStart.y -= 0.2;
        net.shot(legStart, shotEnd, landed, fx.tracerColor);
        if (!bounce) legStart.y += 0.2;
      }
      if (rival) {
        anyHit = true;
        net.hit(rival.player.state.id, (rival.head ? HEAD_DAMAGE : BODY_DAMAGE) * power, rival.head);
      }
      if (hit) {
        anyHit = true;
        if (enemies.damage(hit.enemy, (hit.head ? HEAD_DAMAGE : BODY_DAMAGE) * power, hit.head)) {
          anyKill = true;
          reward(hit.head);
        }
      }
      if (!bounces) {
        if (landed && fx.explosionRadius > 0) {
          const kills = enemies.damageArea(shotEnd, fx.explosionRadius, BODY_DAMAGE * power);
          for (let k = 0; k < kills; k++) reward(false);
          if (kills) anyHit = anyKill = true;
        }
        break;
      }
      // Bounce: mirror the direction in the surface and set off again just clear of it.
      const n: [number, number, number] =
        street || !world.col ? [0, 1, 0] : surfaceNormal(world.col, shotEnd.x, shotEnd.y, shotEnd.z);
      const into = aim.x * n[0] + aim.y * n[1] + aim.z * n[2];
      aim.set(aim.x - 2 * into * n[0], aim.y - 2 * into * n[1], aim.z - 2 * into * n[2]).normalize();
      legStart.copy(shotEnd).addScaledVector(aim, 0.02);
      power *= RICOCHET_DAMAGE;
    }
  }
  sfx.shot();
  if (anyHit) {
    hud.hitmarker(anyKill);
    sfx.hit();
  }
  if (anyKill) sfx.kill();
}

/** Called when the chat box closes, with the request or null if the player backed out. */
function onChat(text: string | null) {
  if (text) {
    resume();
  } else {
    // Closed with Escape. Browsers treat Escape as "release the mouse", so trying to recapture
    // it here gets undone straight away and would bring up the menu. Wait for the next input.
    state = 'resume';
    leftChatAt = performance.now();
    hud.showResume(true);
  }
  if (text) void ask(text);
}

/** Send a request to the Architect and apply whatever mod comes back. */
async function ask(text: string) {
  hud.log(`> ${text}`, 'you');
  const line = hud.log('The Architect is working…', 'wait');
  try {
    const res = await fetch('/api/mod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        mana: stats.mana,
        you: hud.playerName(),
        players: net.online ? net.names() : [],
        active: mods.active.map((m) => ({
          name: m.name,
          secondsLeft: Math.ceil(m.left),
          summary: summarize(m.spec),
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      line.set(data.message ?? 'The Architect could not be reached.', 'warn');
      return;
    }
    applyReply(data as ModReply, line);
  } catch {
    line.set('The Architect could not be reached.', 'warn');
  }
}

/** A priced mod waiting for the player to say yes or no. */
let offer: { mod: Mod; say: string; line: LogLine; left: number; lookTarget: string | null } | null = null;

/** Show the player what a mod would cost and wait for their answer. Nothing is charged yet. */
function applyReply(reply: ModReply, line: LogLine = hud.log('', 'wait')) {
  if (!reply.ok) {
    line.set(reply.say, 'ai');
    return;
  }
  const { mod } = reply;
  if (deadFor > 0) {
    line.set('Too late. You flatlined before it took hold.', 'warn');
    return;
  }
  if (mod.cost > stats.mana) {
    line.set(`${mod.name} costs ${mod.cost} mana. You have ${stats.mana}.`, 'warn');
    return;
  }
  // A mod aimed at a player (their look or their stats) has to land on someone who is actually here.
  let lookTarget: string | null = null;
  if (mod.spec.targetPlayer || mod.spec.playerModel?.length) {
    if (!net.online) {
      line.set('Changing a player only works in a shared game.', 'warn');
      return;
    }
    lookTarget = net.findPlayer(mod.spec.targetPlayer);
    if (!lookTarget) {
      line.set(`Nobody here is called "${mod.spec.targetPlayer}".`, 'warn');
      return;
    }
  }
  if (offer) declineOffer('Replaced by a newer offer.');
  offer = { mod, say: reply.say, line, left: OFFER_TIME, lookTarget };
  line.set(`${mod.name}: ${mod.cost} mana for ${mod.duration}s. Press Y to accept, N to decline.`, 'ai');
  hud.showOffer(mod, stats.mana);
}

/** The player said yes: charge for the mod and switch it on. */
function acceptOffer() {
  if (!offer) return;
  const { mod, say, line, lookTarget } = offer;
  offer = null;
  hud.hideOffer();
  if (mod.cost > stats.mana) {
    // They spent mana on something else while this was waiting.
    line.set(`${mod.name} costs ${mod.cost} mana. You have ${stats.mana}.`, 'warn');
    return;
  }
  stats.mana -= mod.cost;
  // Anything that changes the world or another player goes to the server, so everyone gets it.
  if (net.online) net.shareMod(mod.name, mod.duration, mod.spec, lookTarget);
  if (lookTarget && lookTarget !== 'me') {
    // Aimed at someone else: their stats change, not ours. Keep it in our list so we can see it running.
    const world = new Set<string>(WORLD_TARGETS);
    mods.add({
      ...mod,
      name: `${mod.name} → ${net.players.get(lookTarget)?.state.name ?? mod.spec.targetPlayer}`,
      spec: { ...mod.spec, multipliers: mod.spec.multipliers.filter((m) => world.has(m.target)) },
    });
  } else {
    mods.add(mod);
  }
  if (mod.spec.heal) {
    stats.health = Math.min(MAX_HEALTH * mods.fx.mult.max_health, stats.health + mod.spec.heal);
  }
  line.set(`${say}  −${mod.cost} mana · ${mod.duration}s`, 'ai');
  sfx.mod();
}

function declineOffer(why = 'Declined.') {
  if (!offer) return;
  offer.line.set(`${offer.mod.name}: ${why} Nothing was charged.`, 'warn');
  offer = null;
  hud.hideOffer();
}

let appliedMods = -1;
/** Push the combined effect of the active mods into the parts of the game that hold state. */
function syncMods() {
  if (appliedMods === mods.version) return;
  appliedMods = mods.version;
  const fx = mods.fx;
  weapon.rate = fx.mult.fire_rate;
  weapon.reloadRate = fx.mult.reload_speed;
  weapon.setMagSize(MAG_SIZE * fx.mult.mag_size);
  weapon.setModel(fx.heldModel);
  enemies.setModel(fx.enemyModel);
  sfx.setCustom(fx.sounds);
  sfx.setVolume(fx.soundVolume);
  fog.density = FOG_DENSITY * fx.mult.fog;
  rain.setIntensity(fx.mult.rain);
  renderer.toneMappingExposure = EXPOSURE * fx.brightness;
  setEnemyHighlight(fx.enemyHighlight);
}

function die(by: string | null = null) {
  stats.health = 0;
  if (net.online) {
    pvp.deaths++;
    net.died(by, stats.mana); // the server leaves a share of our mana where we fell
    net.clearMods();
  }
  deadFor = RESPAWN_TIME;
  firing = false;
  mods.clear(); // death ends every mod
  declineOffer('You flatlined.');
  hud.showDead(true);
}

function respawn() {
  if (net.online) {
    // Multiplayer: come back somewhere away from the others, briefly unhurtable.
    // The mana cost of dying is the share the server already dropped.
    placeAtSpawn();
    protectedFor = RESPAWN_PROTECTION;
  } else {
    // Solo: back to the nearest intersection, with half the mana gone.
    player.x = Math.round(player.x / CELL) * CELL;
    player.z = Math.round(player.z / CELL) * CELL;
    player.y = 0;
    player.vx = player.vy = player.vz = 0;
    stats.mana = Math.floor(stats.mana / 2);
  }
  enemies.clear();
  stats.health = MAX_HEALTH;
  sinceHurt = 99;
  hud.showDead(false);
}

let last = performance.now();
let fps = 60;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;

  syncMods();
  const maxHealth = MAX_HEALTH * mods.fx.mult.max_health;
  const playing = state === 'playing';
  // The world pauses in the menu and inventory, but not while talking to the Architect:
  // enemies keep coming while you type.
  const running = playing || state === 'chat' || state === 'resume' || debug.play;
  const alive = deadFor <= 0;
  player.update(
    dt,
    playing && alive
      ? {
          forward: keys.has('KeyW') || keys.has('ArrowUp'),
          back: keys.has('KeyS') || keys.has('ArrowDown'),
          left: keys.has('KeyA') || keys.has('ArrowLeft'),
          right: keys.has('KeyD') || keys.has('ArrowRight'),
          jump: keys.has('Space'),
          crouch: keys.has('ShiftLeft') || keys.has('ShiftRight'),
          sprint: keys.has('KeyQ'),
        }
      : NO_INPUT,
    city.collidersNear(player.x, player.z),
    {
      speed: mods.fx.mult.speed,
      jump: mods.fx.mult.jump,
      gravity: mods.fx.mult.gravity,
      flySpeed: mods.fx.flySpeed,
      fov: mods.fx.fov,
    },
  );
  player.applyTo(camera);
  camera.updateMatrixWorld();
  city.update(player.x, player.z);
  sky.update(camera.position);
  rain.update(camera.position, dt);
  ground.update(camera.position, dt, fog, mods.fx.mult.rain);
  film.update(dt);

  const armed = alive && hud.selected === 0;
  weapon.update(dt, armed, player.speed);
  if (playing && armed && firing) {
    if (weapon.ready()) shoot();
    else if (weapon.dry()) {
      sfx.dry();
      weapon.reload(); // pulling the trigger on an empty magazine reloads
    }
  }
  hud.setAmmo(weapon.ammo, weapon.reloading, armed);

  if (running) {
    mods.update(dt);
    if (offer) {
      offer.left -= dt;
      if (offer.left <= 0) declineOffer('Offer expired.');
      else hud.setOfferTime(offer.left / OFFER_TIME);
    }
    const damage =
      enemies.update(dt, player.x, player.y, player.z, alive, stats.kills, {
        speed: mods.fx.mult.enemy_speed,
        size: mods.fx.mult.enemy_size,
        spawnRate: mods.fx.mult.enemy_spawn_rate,
        health: mods.fx.mult.enemy_health,
        damage: mods.fx.mult.enemy_damage,
        behavior: mods.fx.enemyBehavior,
        ranged: mods.fx.enemyRanged,
        leap: mods.fx.enemyLeap,
        explode: mods.fx.enemyExplode,
      }) * mods.fx.mult.damage_taken;
    sinceHurt += dt;
    if (alive && damage > 0) {
      hurt(damage);
    } else if (alive && sinceHurt > REGEN_DELAY) {
      stats.health = Math.min(maxHealth, stats.health + REGEN_RATE * mods.fx.mult.regen * dt);
    }
    if (stats.health > maxHealth) stats.health = maxHealth; // a max-health mod ran out
    if (!alive) {
      deadFor -= dt;
      if (deadFor <= 0) respawn();
    }
  }

  hud.setVitals(stats.health, maxHealth, stats.mana);
  hud.setMods(
    mods.rows((id) => net.players.get(id)?.state.name ?? 'someone'),
    mods.version,
  );
  protectedFor = Math.max(0, protectedFor - dt);
  net.update(dt, {
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    health: stats.health,
    alive,
    moving: player.speed > 0.6,
    prot: protectedFor > 0,
    mana: stats.mana,
  });
  hud.drawRadar(player.x, player.z, player.yaw, enemies.list, net.players.values());
  hud.setDebug(
    `XYZ   ${player.x.toFixed(1)} / ${player.y.toFixed(2)} / ${player.z.toFixed(1)}\n` +
      `FPS   ${fps.toFixed(0)}\n` +
      `CELLS ${city.chunkCount}   HOSTILES ${enemies.list.length}   KILLS ${stats.kills}`,
  );
  composer.render(dt);
});

// Handy for poking at the game from the browser console.
Object.assign(window, {
  game: { player, city, camera, scene, renderer, enemies, stats, shoot, debug, mods, applyReply, acceptOffer, declineOffer, sfx, weapon, net, pvp },
});
