import { BallBody } from './physics.js';
import { ComboTracker } from './combo.js';
import { tuningFor, isMilestone, TIERS } from './difficulty.js';
import {
  BALL_RADIUS,
  CONTACT_WINDOW_HIGH,
  CONTACT_WINDOW_LOW,
  SERVE_HEIGHT,
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

const HIGH_SCORE_KEY = 'kickup.highscore.v1';

/**
 * Headless rules + simulation. Owns no DOM and no renderer, which is what lets
 * the same instance drive the 2D prototype and the 3D build.
 */
export class Game {
  constructor(storage = safeStorage()) {
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

    this.ball.step(dt, this.tuning);

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

  #fail() {
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
      score: this.score,
      points: this.combo.points,
      bestCombo: this.combo.best,
      highScore: this.highScore,
      newRecord: this.newRecord,
    });
  }

  /**
   * A screen tap. Starts the rally when idle, restarts after a loss, otherwise
   * attempts a strike.
   * @returns {object|null} contact descriptor, or null when no contact was made
   */
  tap() {
    if (this.state === STATE.READY) {
      this.state = STATE.PLAYING;
      this.emit('start', {});
      // Fall through: the opening tap should also connect if it can.
    } else if (this.state === STATE.GAME_OVER) {
      // Small guard so the losing tap doesn't instantly restart.
      if (this.time - this.gameOverAt < 0.6) return null;
      this.start();
      return null;
    }

    const b = this.ball;
    const recovering = this.time - this.lastKickAt < KICK_RECOVERY;
    const locked = this.time < this.lockoutUntil || recovering;
    const inWindow = b.y >= CONTACT_WINDOW_LOW && b.y <= CONTACT_WINDOW_HIGH;

    if (locked || !inWindow) {
      // A fresh mistime costs a fixed lockout. Taps *during* a lockout are
      // swallowed without extending it — mashing should be bad, not fatal.
      if (!locked) this.lockoutUntil = this.time + WHIFF_LOCKOUT;
      const broke = this.combo.breakStreak();
      this.emit('whiff', { y: b.y, broke, locked });
      return null;
    }

    const result = this.combo.register(b.y);
    this.score += 1;

    const t = this.tuning;
    const lateral = (Math.random() - 0.5) * 2 * t.lateral;
    const depth = (Math.random() - 0.5) * 2 * t.lateral * 0.5;
    // A clean strike is more controlled: less scatter, more height.
    const control = result.grade === 'PERFECT' ? 0.25 : result.grade === 'GOOD' ? 0.6 : 1;
    b.strike(t.kickPower, t.recentre, lateral * control, depth * control);

    this.lastKickAt = this.time;
    const milestone = isMilestone(this.score);
    this.tuning = tuningFor(this.score, this.tuning.restitution);

    const contact = { ...result, score: this.score, height: b.y, milestone, tier: this.tuning.tier };
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
