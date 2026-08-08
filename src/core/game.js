import { BallBody } from './physics.js';
import {
  BALL_RADIUS,
  CONTACT_WINDOW_HIGH,
  CONTACT_WINDOW_LOW,
  SERVE_HEIGHT,
} from './constants.js';

export const FIXED_DT = 1 / 120;

/** Phase 1 tuning — a single, static difficulty. */
const BASE_TUNING = {
  gravity: 9.81,
  drag: 0.16,
  restitution: 0.55,
  kickPower: 5.1,
  recentre: 1.35,
};

/**
 * Headless rules + simulation. Owns no DOM and no renderer, which is what lets
 * the same instance drive the 2D prototype and the 3D build.
 */
export class Game {
  constructor() {
    this.ball = new BallBody();
    this.tuning = { ...BASE_TUNING };
    this.score = 0;
    this.time = 0;
    this.accumulator = 0;
    /** Consumed by the renderer each frame for one-shot effects. */
    this.events = [];
    this.lastKickAt = -Infinity;
  }

  reset() {
    this.ball.reset(SERVE_HEIGHT);
    this.score = 0;
    this.time = 0;
    this.accumulator = 0;
    this.events.length = 0;
    this.tuning = { ...BASE_TUNING };
  }

  /** Variable-rate frame time in, fixed-rate simulation out. */
  advance(frameSeconds) {
    // Never let a stalled tab produce a spiral of death.
    this.accumulator += Math.min(frameSeconds, 0.25);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 40) {
      this.#stepFixed(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    return this.accumulator / FIXED_DT; // interpolation alpha
  }

  #stepFixed(dt) {
    this.time += dt;
    this.ball.step(dt, this.tuning);

    // Phase 1 has no failure state yet: the floor simply bounces the ball back.
    if (this.ball.y <= BALL_RADIUS) {
      this.ball.y = BALL_RADIUS;
      this.ball.vy = Math.abs(this.ball.vy) * this.tuning.restitution;
      this.emit('bounce', { speed: this.ball.speed });
    }
  }

  /** A screen tap. Returns the resulting contact descriptor, or null on a whiff. */
  tap() {
    const b = this.ball;
    const inWindow = b.y >= CONTACT_WINDOW_LOW && b.y <= CONTACT_WINDOW_HIGH;
    if (!inWindow) {
      this.emit('whiff', { y: b.y });
      return null;
    }

    b.strike(this.tuning.kickPower, this.tuning.recentre, (Math.random() - 0.5) * 0.5);
    this.score += 1;
    this.lastKickAt = this.time;
    const contact = { score: this.score, height: b.y };
    this.emit('kick', contact);
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
}
