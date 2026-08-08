/**
 * Shared world constants. Everything is in SI units (metres, seconds) so that the
 * physics core survives the migration from the 2D canvas prototype to the 3D
 * renderer without any re-tuning.
 */

// FIFA size-5 match ball.
export const BALL_RADIUS = 0.11;

// Half-width of the invisible box the ball is allowed to travel inside.
export const PLAY_HALF_WIDTH = 1.35;
export const PLAY_HALF_DEPTH = 1.05;
export const PLAY_CEILING = 3.6;

// Height the ball is served from at kick-off.
export const SERVE_HEIGHT = 1.15;

// The sweet spot: the ball height (centre) that scores a perfect strike.
export const SWEET_SPOT_Y = 0.46;

// A tap only connects while the ball is inside this window.
export const CONTACT_WINDOW_LOW = BALL_RADIUS;
export const CONTACT_WINDOW_HIGH = 1.15;

export const GRADE = {
  PERFECT: 'PERFECT',
  GOOD: 'GOOD',
  SLOPPY: 'SLOPPY',
};
