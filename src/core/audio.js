/**
 * Every sound is synthesised at runtime through WebAudio — no asset files to
 * download, so audio adds nothing to load time and is always in sync.
 *
 * Browsers refuse to start an AudioContext without a gesture, so the context
 * is created lazily on the first tap and the whole module no-ops until then.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.crowd = null;
    this.crowdGain = null;
    this.started = false;
  }

  /** Call from inside a user-gesture handler. Safe to call repeatedly. */
  unlock() {
    if (this.started || !this.enabled) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      this.enabled = false;
      return;
    }
    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.ctx.destination);
      this.#buildCrowd();
      this.started = true;
    } catch {
      this.enabled = false;
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setMuted(muted) {
    this.enabled = !muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.85;
  }

  // --- crowd bed ---------------------------------------------------------

  /**
   * A murmuring crowd: looping filtered noise. Intensity rides the rally, so
   * the stadium wakes up as the streak grows.
   */
  #buildCrowd() {
    const ctx = this.ctx;
    const seconds = 4;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Brown-ish noise: smoother and more "crowd" than white noise.
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    // Cross-fade the tail into the head so the loop has no seam.
    const fade = ctx.sampleRate * 0.25;
    for (let i = 0; i < fade; i += 1) {
      const t = i / fade;
      data[i] = data[i] * t + data[data.length - fade + i] * (1 - t);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 620;
    band.Q.value = 0.55;

    const gain = ctx.createGain();
    gain.gain.value = 0.0;

    source.connect(band).connect(gain).connect(this.master);
    source.start();

    this.crowd = source;
    this.crowdBand = band;
    this.crowdGain = gain;
  }

  /**
   * @param {number} level 0..1 excitement
   */
  setCrowdLevel(level) {
    if (!this.started) return;
    const l = Math.max(0, Math.min(1, level));
    const now = this.ctx.currentTime;
    this.crowdGain.gain.setTargetAtTime(0.045 + l * 0.28, now, 0.5);
    // Excited crowds get brighter, not just louder.
    this.crowdBand.frequency.setTargetAtTime(560 + l * 900, now, 0.7);
  }

  /** Short swell for a milestone or a big combo. */
  cheer(strength = 1) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(now);
    const base = g.value;
    g.setValueAtTime(base, now);
    g.linearRampToValueAtTime(Math.min(0.55, base + 0.3 * strength), now + 0.12);
    g.setTargetAtTime(base, now + 0.35, 0.8);
  }

  // --- one-shots ---------------------------------------------------------

  /**
   * Boot on leather. A pitched noise burst through a fast-decaying band-pass
   * plus a low thump — the classic two-part impact.
   * @param {number} power 0..1, harder strikes are brighter and louder
   */
  strike(power = 0.6) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Transient: filtered noise burst.
    const noise = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 0.09);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.2;
    }
    noise.buffer = buf;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1500 + power * 1700, t);
    band.frequency.exponentialRampToValueAtTime(420, t + 0.075);
    band.Q.value = 1.1;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.34 + power * 0.3, t + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

    noise.connect(band).connect(noiseGain).connect(this.master);
    noise.start(t);
    noise.stop(t + 0.13);

    // Body: a short low sine thump giving the hit its weight.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190 + power * 90, t);
    osc.frequency.exponentialRampToValueAtTime(72, t + 0.09);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.0001, t);
    oscGain.gain.exponentialRampToValueAtTime(0.24 + power * 0.16, t + 0.006);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    osc.connect(oscGain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  /** Rising chime layered over a clean strike, for perfect timing. */
  perfectChime(combo = 1) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Pentatonic climb so a long streak never sounds sour.
    const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
    const semitone = steps[Math.min(steps.length - 1, Math.max(0, combo - 1))];
    const freq = 523.25 * Math.pow(2, semitone / 12);

    for (const [mult, level] of [[1, 0.13], [2, 0.05]]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.4);
    }
  }

  /** A dull, mistimed scuff. */
  whiff() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.13);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.11, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.15);
  }

  /**
   * Referee's whistle: two detuned square waves with a warble, which is what
   * gives a real pea whistle its shrill beating tone.
   */
  whistle() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    out.gain.setValueAtTime(0.2, t + 0.42);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    out.connect(this.master);

    // The pea rattle.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 26;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 130;
    lfo.connect(lfoDepth);

    for (const [freq, level] of [[2350, 0.6], [2680, 0.4]]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      lfoDepth.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.64);
    }
    lfo.start(t);
    lfo.stop(t + 0.64);

    // Crowd deflates.
    this.setCrowdLevel(0.05);
  }
}

/**
 * Haptics. `navigator.vibrate` is a no-op on iOS Safari, so this is a
 * progressive enhancement, never something the feel depends on.
 */
export const haptics = {
  supported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
  enabled: true,

  fire(pattern) {
    if (!this.enabled || !this.supported) return false;
    try {
      return navigator.vibrate(pattern);
    } catch {
      return false;
    }
  },

  strike(grade) {
    // Sharper, doubled pulse for a perfect strike; a single soft tick otherwise.
    if (grade === 'PERFECT') return this.fire([11, 22, 16]);
    if (grade === 'GOOD') return this.fire(13);
    return this.fire(7);
  },

  milestone() {
    return this.fire([22, 40, 22, 40, 46]);
  },

  gameOver() {
    return this.fire([70, 60, 130]);
  },
};
