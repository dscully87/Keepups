/**
 * Difficulty curve. Each tier is unlocked by a keep-up milestone and is
 * interpolated towards over a short ramp so the step never feels like a jolt —
 * but the deltas are large enough to be obvious within a rally or two.
 */
// `wind` is the peak sideways acceleration (m/s²) on the ball. It replaces the old random
// scatter and auto-centring: the ball is never perfectly still, but the push is
// predictable and the player can lean against it.
// `kickPower` only scales the swipe's launch speed so apex height stays comparable as gravity rises.
export const TIERS = [
  { at: 0, name: 'WARM-UP', gravity: 9.81, drag: 0.16, kickPower: 5.10, wind: 0 },
  { at: 10, name: 'MATCH PACE', gravity: 11.6, drag: 0.14, kickPower: 5.35, wind: 0.7 },
  { at: 20, name: 'PRO', gravity: 13.9, drag: 0.12, kickPower: 5.62, wind: 1.3 },
  { at: 50, name: 'WORLD CLASS', gravity: 17.2, drag: 0.10, kickPower: 5.95, wind: 2.0 },
];

export const RAMP_KICKS = 3;

/** Highest tier whose milestone has been reached. */
export function tierIndexFor(score) {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i += 1) {
    if (score >= TIERS[i].at) idx = i;
  }
  return idx;
}

const LERP_KEYS = ['gravity', 'drag', 'kickPower', 'wind'];

/**
 * Blend between the previous tier and the active one across `RAMP_KICKS`
 * keep-ups after a milestone, so the transition is smooth but quick.
 */
export function tuningFor(score, restitution = 0.55) {
  const idx = tierIndexFor(score);
  const tier = TIERS[idx];
  const prev = TIERS[Math.max(0, idx - 1)];
  const t = idx === 0 ? 1 : Math.min(1, (score - tier.at) / RAMP_KICKS);

  const out = { restitution, tier: tier.name, tierIndex: idx };
  for (const key of LERP_KEYS) out[key] = prev[key] + (tier[key] - prev[key]) * t;
  return out;
}

/** True when this keep-up is the one that crosses into a new tier. */
export function isMilestone(score) {
  return TIERS.some((t) => t.at !== 0 && t.at === score);
}
