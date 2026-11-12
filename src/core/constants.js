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

// --- swipe-to-aim tuning (all in one place so playtesting is a one-line edit) ---

/** Finger travel (CSS px) in the final window below which a touch is a plain tap. */
export const SWIPE_MIN_DISTANCE = 24;
/** A gesture longer than this that has stopped moving at release is a rest, not a flick. */
export const SWIPE_MAX_TIME = 0.35;
/** Only the last stretch of the gesture counts: people wind up before they flick. */
export const SWIPE_WINDOW = 0.08;
/** Swipe speed, in screen-heights per second, mapped to power 0 and power 1. Normalised by
 *  viewport height so a small phone and a large one feel the same. */
export const SWIPE_SPEED_MIN = 0.9;
export const SWIPE_SPEED_MAX = 4.2;

/** Launch speed (m/s) for the softest and hardest swipe. A plain tap uses TAP_POWER. */
export const KICK_POWER_MIN = 4.2;
export const KICK_POWER_MAX = 7.2;
export const TAP_POWER = 0.5;
/** Sideways launch speed (m/s) for a fully horizontal swipe. */
export const KICK_SIDE_MAX = 2.4;

/** How fast the character shuffles to get under the ball (m/s). Hard kicks out-run this. */
export const PLAYER_SPEED = 2.6;
/** Horizontal distance (m) between character and ball that can still be kicked. */
export const PLAYER_REACH = 0.55;

export const GRADE = {
  PERFECT: 'PERFECT',
  GOOD: 'GOOD',
  SLOPPY: 'SLOPPY',
};
