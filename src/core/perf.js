/**
 * Frame-rate governor. A fixed quality tier picked from device hints is a
 * guess; this measures what the device actually delivers and steps quality
 * down (or back up) to hold the target frame rate.
 *
 * It is deliberately sluggish: quality that flickers is worse than quality
 * that is merely low, so a downgrade needs a sustained bad patch and an
 * upgrade needs a long clean one.
 */

export const TARGET_FPS = 60;
const ORDER = ['low', 'medium', 'high'];

export class PerfGovernor {
  constructor({ quality = 'medium', onChange = () => {} } = {}) {
    this.level = ORDER.indexOf(quality) === -1 ? 1 : ORDER.indexOf(quality);
    this.onChange = onChange;

    this.frames = 0;
    this.slowFrames = 0;
    this.windowStart = 0;
    this.elapsed = 0;
    this.lastChangeAt = -Infinity;
    /**
     * Startup is the worst-paced part of a session: shader compilation,
     * texture upload and first-frame layout all land here. Judging the device
     * on those frames would downgrade quality on hardware that is about to be
     * perfectly fine, so the first few seconds are not evidence.
     */
    this.warmupSeconds = 4;
    /** Rolling frame-time stats for the HUD / diagnostics. */
    this.fps = TARGET_FPS;
    this.worstMs = 0;
    this.enabled = true;
  }

  get quality() {
    return ORDER[this.level];
  }

  /**
   * @param {number} dt seconds since the previous frame
   */
  sample(dt) {
    const ms = dt * 1000;
    this.elapsed += dt;
    this.frames += 1;
    // 20ms ≈ missing a 60Hz frame.
    if (ms > 20) this.slowFrames += 1;
    this.worstMs = Math.max(this.worstMs, ms);

    const window = this.elapsed - this.windowStart;
    if (window < 2.0) return null;

    this.fps = this.frames / window;
    const slowRatio = this.slowFrames / this.frames;
    const decision = this.#decide(slowRatio);

    this.frames = 0;
    this.slowFrames = 0;
    this.worstMs = 0;
    this.windowStart = this.elapsed;
    return decision;
  }

  #decide(slowRatio) {
    if (!this.enabled) return null;
    if (this.elapsed < this.warmupSeconds) return null;
    const sinceChange = this.elapsed - this.lastChangeAt;

    // Struggling: drop a tier, but never more than once every 3s.
    if (slowRatio > 0.25 && this.level > 0 && sinceChange > 3) {
      this.level -= 1;
      this.lastChangeAt = this.elapsed;
      this.onChange(this.quality, 'down');
      return { quality: this.quality, direction: 'down', fps: this.fps };
    }

    // Comfortable for a long stretch: try one tier back up.
    if (slowRatio < 0.02 && this.fps > TARGET_FPS * 0.95 && this.level < ORDER.length - 1 && sinceChange > 12) {
      this.level += 1;
      this.lastChangeAt = this.elapsed;
      this.onChange(this.quality, 'up');
      return { quality: this.quality, direction: 'up', fps: this.fps };
    }

    return null;
  }
}

/**
 * Input latency probe. Records the gap between the pointer event's own
 * timestamp and the moment the game acted on it — the part of end-to-end
 * latency this code is responsible for.
 */
export class LatencyProbe {
  constructor(capacity = 120) {
    this.samples = new Float32Array(capacity);
    this.count = 0;
    this.index = 0;
  }

  record(eventTimeStamp, handledAt = performance.now()) {
    const ms = handledAt - eventTimeStamp;
    // The only thing being guarded against is a browser whose event
    // timeStamp is not on the performance.now() timeline. A real stall
    // must still be recorded — those are the samples worth seeing.
    if (!Number.isFinite(ms) || ms < 0 || ms > 5000) return;
    this.samples[this.index] = ms;
    this.index = (this.index + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
  }

  stats() {
    if (!this.count) return { count: 0, median: 0, p95: 0, max: 0 };
    const arr = Array.from(this.samples.slice(0, this.count)).sort((a, b) => a - b);
    return {
      count: this.count,
      median: +arr[Math.floor(arr.length * 0.5)].toFixed(2),
      p95: +arr[Math.floor(arr.length * 0.95)].toFixed(2),
      max: +arr[arr.length - 1].toFixed(2),
    };
  }
}
