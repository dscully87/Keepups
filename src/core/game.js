import { BallBody } from './physics.js';
import { ComboTracker } from './combo.js';
import { tuningFor, isMilestone, TIERS } from './difficulty.js';
import {
  BALL_RADIUS,
  CONTACT_WINDOW_HIGH,
  CONTACT_WINDOW_LOW,
  SERVE_HEIGHT,
  SWEET_SPOT_Y,
  PLAY_HALF_WIDTH,
  KICK_POWER_MIN,
  KICK_POWER_MAX,
  KICK_SIDE_MAX,
  TAP_POWER,
  PLAYER_SPEED,
  PLAYER_REACH,
} from './constants.js';

export const FIXED_DT = 1 / 120;

export const STATE = {
  READY: 'READY',
  PLAYING: 'PLAYING',
  GAME_OVER: 'GAME_OVER',
};

/** Mistimed taps lock the foot out briefly, so mashing is worse than timing. */
export const WHIFF_LOCKOUT = 0.18;

/**
 * Follow-through. A boot cannot strike the same ball twice in a few
 * milliseconds, and without this a mashed tap chain re-strikes the ball on
 * every frame it spends inside the contact window.
 */
export const KICK_RECOVERY = 0.22;

/** Kicks at or above this power count as "high" for the height bonus. */
const HIGH_POWER = 0.75;
/** Contact further than this fraction of PLAYER_REACH from the player is a rescue. */
const RESCUE_FRACTION = 0.7;
/** A touch is "controlled" if the ball will come down within this many metres of the player. */
const CONTROL_RADIUS = 0.3;

/**
 * Seeded generator (mulberry32). Everything random in the core comes from here, never
 * Math.random(), so the same seed + same inputs reproduce the same game — the gates and
 * the trailer capture both depend on that.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIGH_SCORE_KEY = 'kickup.highscore.v1';

/**
 * Headless rules + simulation. Owns no DOM and no renderer, which is what lets
 * the same instance drive the 2D prototype and the 3D build.
 */
export class Game {
  constructor(storage = safeStorage(), seed = 1) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.ball = new BallBody();
    this.combo = new ComboTracker();
    this.storage = storage;
    this.state = STATE.READY;
    this.tuning = tuningFor(0);
    this.score = 0;
    this.highScore = this.#loadHighScore();
    this.time = 0;
    this.accumulator = 0;
    this.events = [];
    this.lockoutUntil = -Infinity;
    this.lastKickAt = -Infinity;
    this.gameOverAt = 0;
    this.newRecord = false;
    this.playerX = 0;
    this.windPhase = 0;
    this.lastKickPower = 0;
    this.lastKickAim = { side: 0, power: TAP_POWER };
  }

  /** Reseed so a given seed always replays identically (used by gates and capture). */
  setSeed(seed) {
    this.seed = seed;
    this.reset();
  }

  /** Sideways wind acceleration (m/s²) right now: slow, seeded, never random per frame. */
  get wind() {
    return this.tuning.wind * Math.sin(this.time * 0.6 + this.windPhase);
  }

  reset() {
    this.ball.reset(SERVE_HEIGHT);
    this.combo.reset();
    this.score = 0;
    this.time = 0;
    this.accumulator = 0;
    this.events.length = 0;
    this.tuning = tuningFor(0);
    this.lockoutUntil = -Infinity;
    this.lastKickAt = -Infinity;
    this.newRecord = false;
    this.rng = makeRng(this.seed);
    this.windPhase = this.rng() * Math.PI * 2;
    this.playerX = 0;
    this.lastKickPower = 0;
    this.state = STATE.READY;
  }

  start() {
    if (this.state === STATE.PLAYING) return;
    this.reset();
    this.state = STATE.PLAYING;
    this.emit('start', {});
  }

  get tier() {
    return this.tuning.tier;
  }

  get tierIndex() {
    return this.tuning.tierIndex;
  }

  /** Variable-rate frame time in, fixed-rate simulation out. */
  advance(frameSeconds) {
    this.accumulator += Math.min(frameSeconds, 0.25);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 40) {
      this.#stepFixed(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    return this.accumulator / FIXED_DT;
  }

  #stepFixed(dt) {
    this.time += dt;
    if (this.state === STATE.GAME_OVER) return;

    // Sides are open during a live rally: a ball that leaves the pitch is lost.
    this.tuning.openSides = this.state === STATE.PLAYING;
    this.ball.step(dt, this.tuning, this.state === STATE.PLAYING ? this.wind : 0);
    this.#movePlayer(dt);

    if (this.state === STATE.PLAYING && Math.abs(this.ball.x) > PLAY_HALF_WIDTH) {
      this.#fail('out');
      return;
    }

    if (this.ball.y <= BALL_RADIUS) {
      if (this.state === STATE.PLAYING) {
        this.#fail();
      } else {
        // Idle attract mode: the ball simply bounces until play starts.
        this.ball.y = BALL_RADIUS;
        this.ball.vy = Math.abs(this.ball.vy) * this.tuning.restitution;
      }
    }
  }

  /**
   * Where (x) the ball will be when it next passes the sweet spot on its way down.
   * Closed-form (gravity, damped horizontal drift and wind) rather than a simulation, so
   * it costs nothing per step. Used by the player's AI, the landing marker and the leg.
   */
  predictContactX(y = SWEET_SPOT_Y) {
    const b = this.ball;
    const g = this.tuning.gravity;
    const k = this.tuning.drag;
    // y(t) = b.y + vy t - g t²/2 = y  →  take the later (descending) root.
    const disc = b.vy * b.vy + 2 * g * (b.y - y);
    const t = disc < 0 ? 0 : Math.max(0, (b.vy + Math.sqrt(disc)) / g);
    const decay = k > 1e-6 ? (1 - Math.exp(-k * t)) / k : t;
    const wind = this.state === STATE.PLAYING ? this.wind : 0;
    return b.x + b.vx * decay + 0.5 * wind * t * t;
  }

  /** The character shuffles towards the landing point at a limited speed. */
  #movePlayer(dt) {
    const target = Math.max(-PLAY_HALF_WIDTH, Math.min(PLAY_HALF_WIDTH, this.predictContactX()));
    const step = PLAYER_SPEED * dt;
    const d = target - this.playerX;
    this.playerX += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  /**
   * Trajectory preview for the aim arc: where a kick with this aim would put the ball,
   * sampled every `dt` seconds into `out` as x,y,z triplets. Allocation-free.
   * @returns {number} sample count written
   */
  previewPath(aim, out, count, dt = 0.07) {
    const b = this.ball;
    const { vx, vy } = this.#launchVelocity(aim);
    const g = this.tuning.gravity;
    let n = 0;
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) * dt;
      const y = b.y + vy * t - 0.5 * g * t * t;
      if (y < BALL_RADIUS) break;
      out[n * 3] = b.x + vx * t;
      out[n * 3 + 1] = y;
      out[n * 3 + 2] = b.z;
      n += 1;
    }
    return n;
  }

  #launchVelocity(aim) {
    const side = Math.max(-1, Math.min(1, aim.side));
    const power = Math.max(0, Math.min(1, aim.power));
    // Tiers scale launch speed so apex height stays comparable as gravity rises.
    const scale = this.tuning.kickPower / 5.1;
    return {
      vx: side * KICK_SIDE_MAX,
      vy: (KICK_POWER_MIN + (KICK_POWER_MAX - KICK_POWER_MIN) * power) * scale,
    };
  }

  #fail(reason = 'floor') {
    this.ball.y = BALL_RADIUS;
    this.ball.vy = Math.abs(this.ball.vy) * 0.35;
    this.state = STATE.GAME_OVER;
    this.gameOverAt = this.time;
    this.newRecord = this.score > this.highScore;
    if (this.newRecord) {
      this.highScore = this.score;
      this.#saveHighScore();
    }
    this.emit('gameover', {
      reason,
      score: this.score,
      points: this.combo.points,
      bestCombo: this.combo.best,
      highScore: this.highScore,
      newRecord: this.newRecord,
    });
  }

  /** A plain tap: straight up at medium power. Also the keyboard fallback. */
  tap() {
    return this.kick({ side: 0, power: TAP_POWER });
  }

  /**
   * A kick. Starts the rally when idle, restarts after a loss, otherwise attempts a
   * strike. `aim` is already normalised by the input layer: `side` in -1..1 (negative is
   * screen-left) and `power` in 0..1. The core never sees pixels.
   * @returns {object|null} contact descriptor, or null when no contact was made
   */
  kick(aim) {
    if (this.state === STATE.READY) {
      this.state = STATE.PLAYING;
      this.emit('start', {});
      // Fall through: the opening kick should also connect if it can.
    } else if (this.state === STATE.GAME_OVER) {
      // Small guard so the losing touch doesn't instantly restart.
      if (this.time - this.gameOverAt < 0.6) return null;
      this.start();
      return null;
    }

    const b = this.ball;
    const recovering = this.time - this.lastKickAt < KICK_RECOVERY;
    const locked = this.time < this.lockoutUntil || recovering;
    const inWindow = b.y >= CONTACT_WINDOW_LOW && b.y <= CONTACT_WINDOW_HIGH;
    const offset = Math.abs(b.x - this.playerX);
    const inReach = offset <= PLAYER_REACH;

    if (locked || !inWindow || !inReach) {
      // A fresh mistime costs a fixed lockout. Touches *during* a lockout are
      // swallowed without extending it — mashing should be bad, not fatal.
      if (!locked) this.lockoutUntil = this.time + WHIFF_LOCKOUT;
      const broke = this.combo.breakStreak();
      this.emit('whiff', { y: b.y, broke, locked, outOfReach: inWindow && !inReach });
      return null;
    }

    // Capture where contact happened *before* the strike; the renderer drains
    // events after the next simulation step has already moved the ball.
    const point = { x: b.x, y: b.y, z: b.z };
    const side = Math.max(-1, Math.min(1, aim.side));
    const power = Math.max(0, Math.min(1, aim.power));
    const { vx, vy } = this.#launchVelocity({ side, power });

    // Control bonuses are judged from where the ball will come down, not from the
    // swipe, so a deliberate steer against the wind counts as much as a straight kick.
    b.strike(vx, vy, 0);
    const landing = this.predictContactX();
    const result = this.combo.register(point.y, {
      rescue: offset >= PLAYER_REACH * RESCUE_FRACTION,
      controlled: Math.abs(landing - this.playerX) <= CONTROL_RADIUS,
      highControlled: this.lastKickPower >= HIGH_POWER && Math.abs(landing - this.playerX) <= CONTROL_RADIUS * 2,
    });
    this.score += 1;
    this.lastKickPower = power;
    this.lastKickAim.side = side;
    this.lastKickAim.power = power;

    this.lastKickAt = this.time;
    const milestone = isMilestone(this.score);
    this.tuning = tuningFor(this.score, this.tuning.restitution);

    const contact = {
      ...result, score: this.score, height: point.y, point, milestone, tier: this.tuning.tier,
      side, power, offset, playerX: this.playerX,
    };
    this.emit('kick', contact);
    if (milestone) this.emit('milestone', { tier: this.tuning.tier, score: this.score });
    return contact;
  }

  emit(type, data) {
    this.events.push({ type, data, at: this.time });
  }

  drainEvents() {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  #loadHighScore() {
    const raw = this.storage?.getItem(HIGH_SCORE_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  #saveHighScore() {
    try {
      this.storage?.setItem(HIGH_SCORE_KEY, String(this.highScore));
    } catch {
      /* private browsing — high score is session-only */
    }
  }
}

export { TIERS };

function safeStorage() {
  try {
    const probe = '__kickup__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
