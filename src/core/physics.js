import {
  BALL_RADIUS,
  PLAY_HALF_WIDTH,
  PLAY_HALF_DEPTH,
  PLAY_CEILING,
  SERVE_HEIGHT,
} from './constants.js';

/**
 * Rigid-ish body for the ball. Semi-implicit Euler, fixed timestep, with a
 * quadratic-ish drag term and wall restitution. `z` is unused by the 2D
 * prototype but carried from the start so the 3D renderer inherits depth for
 * free.
 */
export class BallBody {
  constructor() {
    this.x = 0;
    this.y = SERVE_HEIGHT;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    // Angular state, used for rolling/spin rendering.
    this.spinAxis = { x: 0, y: 0, z: 1 };
    this.spinRate = 0;
    this.rotation = 0;
    this.grounded = false;
  }

  reset(serveHeight = SERVE_HEIGHT) {
    this.x = 0;
    this.y = serveHeight;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.spinRate = 0;
    this.rotation = 0;
    this.grounded = false;
  }

  get speed() {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  /** True while the ball is falling — the only time a kick may connect. */
  get descending() {
    return this.vy < 0;
  }

  /**
   * @param {number} dt fixed step in seconds
   * @param {{gravity:number, drag:number, restitution:number, openSides?:boolean}} tuning
   * @param {number} windAx sideways acceleration (m/s²) from wind
   */
  step(dt, tuning, windAx = 0) {
    this.vx += windAx * dt;
    this.vy -= tuning.gravity * dt;

    // Linear drag approximation: v *= (1 - k*dt), clamped so large dt is safe.
    const damp = Math.max(0, 1 - tuning.drag * dt);
    this.vx *= damp;
    this.vy *= damp;
    this.vz *= damp;

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    this.#clampWalls(tuning.restitution, tuning.openSides);

    this.spinRate *= Math.max(0, 1 - 0.7 * dt);
    this.rotation += this.spinRate * dt;

    this.grounded = this.y <= BALL_RADIUS + 1e-4;
  }

  #clampWalls(restitution, openSides = false) {
    const limitX = PLAY_HALF_WIDTH - BALL_RADIUS;
    // While a rally is live the sides are open: a ball that leaves is lost (game.js
    // ends the rally). Walls only exist for the idle attract-mode bounce.
    if (openSides) {
      /* no side clamp */
    } else if (this.x > limitX) {
      this.x = limitX;
      this.vx = -Math.abs(this.vx) * restitution;
    } else if (this.x < -limitX) {
      this.x = -limitX;
      this.vx = Math.abs(this.vx) * restitution;
    }

    const limitZ = PLAY_HALF_DEPTH - BALL_RADIUS;
    if (this.z > limitZ) {
      this.z = limitZ;
      this.vz = -Math.abs(this.vz) * restitution;
    } else if (this.z < -limitZ) {
      this.z = -limitZ;
      this.vz = Math.abs(this.vz) * restitution;
    }

    const limitY = PLAY_CEILING - BALL_RADIUS;
    if (this.y > limitY) {
      this.y = limitY;
      this.vy = -Math.abs(this.vy) * restitution;
    }
  }

  /**
   * Launch the ball with an explicit velocity. The spin axis follows the
   * direction of travel so the ball visibly rolls the way it is going.
   */
  strike(vx, vy, vz = 0) {
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.spinRate = 6 + vy * 1.6;
    // Axis is perpendicular to the horizontal travel direction (rolling forwards).
    const h = Math.hypot(vx, vz);
    if (h > 1e-3) {
      this.spinAxis.x = vz / h;
      this.spinAxis.y = 0.15;
      this.spinAxis.z = -vx / h;
    } else {
      this.spinAxis.x = 1;
      this.spinAxis.y = 0.15;
      this.spinAxis.z = 0.05;
    }
  }
}
