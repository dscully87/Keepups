/**
 * Difficulty curve. Each tier is unlocked by a keep-up milestone and is
 * interpolated towards over a short ramp so the step never feels like a jolt —
 * but the deltas are large enough to be obvious within a rally or two.
 */
export const TIERS = [
  { at: 0, name: 'WARM-UP', gravity: 9.81, drag: 0.16, kickPower: 5.10, lateral: 0.28, recentre: 1.35 },
  { at: 10, name: 'MATCH PACE', gravity: 11.6, drag: 0.14, kickPower: 5.35, lateral: 0.44, recentre: 1.25 },
  { at: 20, name: 'PRO', gravity: 13.9, drag: 0.12, kickPower: 5.62, lateral: 0.62, recentre: 1.12 },
  { at: 50, name: 'WORLD CLASS', gravity: 17.2, drag: 0.10, kickPower: 5.95, lateral: 0.86, recentre: 0.98 },
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

const LERP_KEYS = ['gravity', 'drag', 'kickPower', 'lateral', 'recentre'];

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
