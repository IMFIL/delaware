import type { SoundEvent, SoundLayer } from './modspec';

const MASTER = 0.7;

/** Tiny synthesised sound effects, so the game needs no audio files. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private custom: Partial<Record<SoundEvent, SoundLayer[]>> = {};
  private volume = 1;

  /** Browsers only allow audio after a click or key press, so call this from one. */
  resume() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.out = this.ctx.createGain();
      this.out.gain.value = MASTER * this.volume;
      // A limiter, so no combination of layers a mod comes up with can be painfully loud.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.1;
      this.out.connect(limiter).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 1.6;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  /** Sounds redesigned by mods; events not listed play their default. */
  setCustom(sounds: Partial<Record<SoundEvent, SoundLayer[]>>) {
    this.custom = sounds;
  }

  /** Overall loudness multiplier from mods; 0 is silence. */
  setVolume(mult: number) {
    this.volume = mult;
    if (this.out) this.out.gain.value = MASTER * mult;
  }

  private tone(type: OscillatorType, from: number, to: number, dur: number, gain: number, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** A burst of filtered noise that dies away over `dur` seconds, its filter gliding to `to`. */
  private burst(
    type: BiquadFilterType,
    freq: number,
    q: number,
    dur: number,
    gain: number,
    delay = 0,
    to = freq,
  ) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.out) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (to !== freq) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.1);
    src.stop(t + dur);
  }

  /** Play a mod's replacement for an event, if there is one. */
  private playCustom(event: SoundEvent): boolean {
    const layers = this.custom[event];
    if (!layers) return false;
    for (const l of layers) {
      if (l.gain <= 0) continue;
      if (l.kind.startsWith('noise_')) {
        const filter = l.kind.slice(6) as BiquadFilterType;
        this.burst(filter, l.from, l.q, l.dur, l.gain, l.delay, l.to);
      } else {
        this.tone(l.kind as OscillatorType, l.from, l.to, l.dur, l.gain, l.delay);
      }
    }
    return true;
  }

  /** Soft, low, suppressed shot: a round thump with a little air on top. */
  shot() {
    if (this.playCustom('shot')) return;
    const pitch = 0.94 + Math.random() * 0.12; // slight variation so rapid fire isn't monotonous
    this.tone('sine', 190 * pitch, 55, 0.13, 0.5);
    this.burst('lowpass', 1100, 0.7, 0.09, 0.16);
    this.burst('bandpass', 2400 * pitch, 1.2, 0.035, 0.07);
  }

  /** Dry, short tick in the style of an arcade-shooter hitmarker. */
  hit() {
    if (this.playCustom('hit')) return;
    this.burst('bandpass', 3400, 2.5, 0.04, 0.9);
    this.burst('highpass', 6000, 0.7, 0.015, 0.25);
    this.tone('triangle', 1900, 1300, 0.018, 0.12);
  }

  /** A soft thud confirming the kill. */
  kill() {
    if (this.playCustom('kill')) return;
    // Kept short, low and quiet: one muffled thud right after the hit tick.
    this.tone('sine', 140, 45, 0.14, 0.3, 0.04);
    this.burst('lowpass', 260, 0.7, 0.1, 0.18, 0.04);
  }

  /** Magazine released. */
  magOut() {
    this.burst('bandpass', 2600, 3, 0.03, 0.5);
    this.tone('triangle', 320, 180, 0.06, 0.12, 0.01);
  }

  /** Fresh magazine seated. */
  magIn() {
    this.burst('bandpass', 1700, 2.5, 0.04, 0.6);
    this.tone('triangle', 240, 150, 0.07, 0.18);
  }

  /** Slide pulled back and released. */
  rack() {
    this.burst('bandpass', 3200, 2, 0.035, 0.45);
    this.burst('bandpass', 2200, 2.5, 0.05, 0.6, 0.09);
    this.tone('triangle', 420, 200, 0.05, 0.1, 0.09);
  }

  /** Trigger pulled on an empty magazine. */
  dry() {
    this.burst('bandpass', 4200, 4, 0.02, 0.4);
  }

  /** Two soft rising notes when a mod takes hold. */
  mod() {
    this.tone('sine', 520, 540, 0.16, 0.14);
    this.tone('sine', 780, 800, 0.24, 0.12, 0.09);
  }

  hurt() {
    if (this.playCustom('hurt')) return;
    this.burst('lowpass', 500, 0.7, 0.18, 0.5);
    this.tone('sine', 110, 50, 0.2, 0.35);
  }
}
