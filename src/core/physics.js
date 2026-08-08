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
   * @param {{gravity:number, drag:number, restitution:number}} tuning
   */
  step(dt, tuning) {
    this.vy -= tuning.gravity * dt;

    // Linear drag approximation: v *= (1 - k*dt), clamped so large dt is safe.
    const damp = Math.max(0, 1 - tuning.drag * dt);
    this.vx *= damp;
    this.vy *= damp;
    this.vz *= damp;

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    this.#clampWalls(tuning.restitution);

    this.spinRate *= Math.max(0, 1 - 0.7 * dt);
    this.rotation += this.spinRate * dt;

    this.grounded = this.y <= BALL_RADIUS + 1e-4;
  }

  #clampWalls(restitution) {
    const limitX = PLAY_HALF_WIDTH - BALL_RADIUS;
    if (this.x > limitX) {
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
   * Apply a strike. `power` is the launch speed in m/s, `recentre` pulls the
   * ball back towards the player so a clean juggle stays in front of them.
   */
  strike(power, recentre, lateral = 0, depth = 0) {
    this.vy = power;
    this.vx = -this.x * recentre + lateral;
    this.vz = -this.z * recentre + depth;
    this.spinRate = 6 + power * 1.6;
    this.spinAxis = { x: 1, y: 0.15, z: 0.05 };
  }
}
