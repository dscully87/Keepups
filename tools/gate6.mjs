/**
 * Phase 6 quality gate — responsiveness and the "crunchy" feel.
 *
 *  - zero perceptible input lag: the game acts on a tap in the same task the
 *    browser dispatched it in
 *  - stable frame pacing: no allocation churn, no per-frame garbage, bounded
 *    worst-case CPU frame cost
 *  - impact reads as impact: particles and camera shake on contact, scaled by
 *    how clean the strike was
 *  - the frame-rate governor actually protects the frame rate
 *
 * CI renders in software (SwiftShader, ~3-8fps), so wall-clock fps here would
 * measure the harness, not the game. Frame rate is therefore gated on the two
 * things that actually predict it on device: bounded CPU cost per frame with a
 * tight worst case, and a GPU workload budget.
 */
import { openGame, check, report, frames } from './harness.mjs';

const { page, errors, close } = await openGame({ quality: 'high' });
console.log('PHASE 6 GATE — OPTIMISATION & FEEL');

// --- input latency ------------------------------------------------------
// Two separate things get measured here, because in CI they are very
// different numbers:
//   1. what THIS CODE adds between the browser dispatching a pointer event
//      and the game acting on it, and
//   2. total queue delay, which under SwiftShader is dominated by the
//      software rasteriser blocking the main thread and says nothing about
//      the game on real hardware.
// The gate asserts on (1) and only reports (2).
const ownLatency = await page.evaluate(async () => {
  const { game, latency } = window.__KICKUP__;
  window.__PAUSE__ = true; // take the software renderer out of the picture
  game.reset();
  game.start();
  const canvas = document.getElementById('stage');

  const before = latency.stats().count;
  // The swipe kick fires on pointerup (direction does not exist before that); the
  // pointerdown only starts the anticipation. Measure both separately.
  let anticipated = 0;
  let kicked = 0;
  const ev = (type, x, y) => new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, button: 0, clientX: x, clientY: y,
  });
  for (let i = 0; i < 40; i += 1) {
    game.ball.y = 0.5;
    game.ball.vy = -3;
    game.ball.x = 0;
    game.playerX = 0;
    game.lastKickAt = -Infinity;
    game.lockoutUntil = -Infinity;
    const score = game.score;
    canvas.dispatchEvent(ev('pointerdown', 195, 560));
    if (window.__KICKUP__.stage._aim) anticipated += 1; // aim preview armed inside the handler
    canvas.dispatchEvent(ev('pointermove', 215, 520));
    canvas.dispatchEvent(ev('pointerup', 235, 480));
    if (game.score > score) kicked += 1;
    await new Promise((r) => setTimeout(r, 0));
  }
  const stats = latency.stats();
  return { recorded: stats.count - before, anticipated, kicked, ...stats };
});
check('pointerdown starts the anticipation inside the handler', ownLatency.anticipated === 40, `${ownLatency.anticipated} of 40`);
check('pointerup kicks the ball inside the handler', ownLatency.kicked === 40, `${ownLatency.kicked} of 40 swipes connected`);
check('releases are recorded by the latency probe', ownLatency.recorded >= 30, `${ownLatency.recorded} of 40 dispatched events recorded`);
check('the game adds no perceptible input lag',
  ownLatency.median < 3,
  `median ${ownLatency.median}ms, p95 ${ownLatency.p95}ms from the browser's own event timestamp`);
check('no tap is ever left waiting for a frame', ownLatency.max < 16.7,
  `worst ${ownLatency.max}ms, inside one 60Hz frame`);

// Informational only: real touches while the software renderer is blocking.
await page.evaluate(() => {
  window.__PAUSE__ = false;
  window.__KICKUP__.latency.count = 0;
  window.__KICKUP__.latency.index = 0;
});
for (let i = 0; i < 6; i += 1) {
  await page.touchscreen.tap(195, 560);
  await frames(page, 1);
}
const queued = await page.evaluate(() => window.__KICKUP__.latency.stats());
console.log(`  · real-touch queue delay under software rendering: median ${queued.median}ms ` +
  `(harness artefact — CI has no GPU, so the main thread is blocked rasterising)`);

// The strike must be applied to physics before the next simulation step —
// i.e. the ball's velocity changes inside the tap call, not afterwards.
const immediacy = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  window.__PAUSE__ = true;
  game.reset();
  game.start();
  game.ball.y = 0.5;
  game.ball.vy = -3;
  const before = game.ball.vy;
  game.tap();
  const afterTap = game.ball.vy;
  for (const e of game.drainEvents()) window.__KICKUP__.handleEvent(e);
  return { before, afterTap, kickArmed: stage.player.kickTarget === 1, fx: stage.fx.alive > 0 };
});
check('ball reverses inside the tap call, before any frame boundary',
  immediacy.before < 0 && immediacy.afterTap > 0,
  `vy ${immediacy.before.toFixed(2)} → ${immediacy.afterTap.toFixed(2)} m/s`);
check('animation and particles are armed in the same call', immediacy.kickArmed && immediacy.fx);

// --- frame pacing -------------------------------------------------------
const pacing = await page.evaluate(() => {
  const { game, stage, handleEvent } = window.__KICKUP__;
  game.reset();
  game.start();
  // Warm up JIT and first-use allocations.
  for (let i = 0; i < 180; i += 1) stage.update(game, 1 / 60);

  const times = [];
  for (let i = 0; i < 900; i += 1) {
    if (game.state !== 'PLAYING') game.start();
    const t0 = performance.now();
    game.advance(1 / 60);
    if (game.ball.descending && game.ball.y < 0.6) {
      game.tap();
      for (const e of game.drainEvents()) handleEvent(e);
    } else {
      game.drainEvents();
    }
    stage.update(game, 1 / 60);
    times.push(performance.now() - t0);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
  return {
    median: +sorted[Math.floor(sorted.length * 0.5)].toFixed(3),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3),
    p99: +sorted[Math.floor(sorted.length * 0.99)].toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
    stddev: +Math.sqrt(variance).toFixed(3),
    kicks: game.score,
  };
});
check('CPU frame cost leaves the frame budget almost untouched',
  pacing.p95 < 2.5,
  `median ${pacing.median}ms, p95 ${pacing.p95}ms of a 16.67ms budget`);
check('worst-case frame does not blow the budget',
  pacing.max < 8,
  `worst ${pacing.max}ms over 900 frames with ${pacing.kicks} strikes`);
check('frame cost is consistent, not spiky',
  pacing.stddev < 1.0,
  `σ = ${pacing.stddev}ms, p99 ${pacing.p99}ms`);

// --- allocation churn ---------------------------------------------------
// Steady-state frames must not allocate: garbage is what turns a smooth 60
// into a stutter every few seconds.
const churn = await page.evaluate(() => {
  const { game, stage, handleEvent } = window.__KICKUP__;
  if (!performance.memory) return { supported: false };
  game.reset();
  game.start();
  for (let i = 0; i < 300; i += 1) stage.update(game, 1 / 60);

  const before = performance.memory.usedJSHeapSize;
  for (let i = 0; i < 3000; i += 1) {
    if (game.state !== 'PLAYING') game.start();
    game.advance(1 / 60);
    if (game.ball.descending && game.ball.y < 0.6) {
      game.tap();
      for (const e of game.drainEvents()) handleEvent(e);
    } else {
      game.drainEvents();
    }
    stage.update(game, 1 / 60);
  }
  const after = performance.memory.usedJSHeapSize;
  return { supported: true, bytesPerFrame: Math.round((after - before) / 3000) };
});
if (churn.supported) {
  check('steady-state frames allocate almost nothing',
    churn.bytesPerFrame < 2048,
    `${churn.bytesPerFrame} bytes/frame of heap growth over 3000 frames`);
} else {
  check('allocation churn measurable', false, 'performance.memory unavailable');
}

// --- particle system ----------------------------------------------------
const fx = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  game.reset();
  game.start();
  stage.fx.clear();

  const point = { x: 0, y: 0.46, z: 0 };
  stage.onKick({ grade: 'SLOPPY', point, combo: 0, multiplier: 1, score: 1 });
  const sloppy = stage.fx.alive;
  stage.fx.clear();
  stage.onKick({ grade: 'PERFECT', point, combo: 1, multiplier: 1, score: 2 });
  const perfect = stage.fx.alive;

  // Overflow safety: hammer it far past capacity.
  for (let i = 0; i < 60; i += 1) stage.onKick({ grade: 'PERFECT', point, combo: 1, multiplier: 1, score: 3 });
  const capped = stage.fx.alive;
  const capacity = stage.fx.count;

  // Particles must die and free their slots.
  for (let i = 0; i < 140; i += 1) stage.update(game, 1 / 60);
  const settled = stage.fx.alive;

  return { sloppy, perfect, capped, capacity, settled, drawRange: stage.fx.geometry.drawRange.count };
});
check('impact throws grass and dust', fx.perfect > 0, `${fx.perfect} particles on a perfect strike`);
check('a cleaner strike throws more debris', fx.perfect > fx.sloppy, `perfect ${fx.perfect} vs scrappy ${fx.sloppy}`);
check('particle pool is bounded', fx.capped <= fx.capacity, `${fx.capped} alive, capacity ${fx.capacity}`);
check('particles expire and free their slots', fx.settled === 0, `${fx.settled} still alive after 2.3s`);
check('draw range tracks live particles only', fx.drawRange === fx.settled, `drawRange ${fx.drawRange}`);

// --- camera shake -------------------------------------------------------
const shake = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  game.reset();
  game.start();
  stage.shake.reset();
  const base = stage.cameraBase.clone();

  const point = { x: 0, y: 0.46, z: 0 };
  stage.onKick({ grade: 'SLOPPY', point, combo: 0, multiplier: 1, score: 1 });
  const softTrauma = stage.shake.trauma;
  stage.shake.reset();
  stage.onKick({ grade: 'PERFECT', point, combo: 1, multiplier: 1, score: 2 });
  const hardTrauma = stage.shake.trauma;

  let peak = 0;
  const signed = [];
  for (let i = 0; i < 90; i += 1) {
    stage.update(game, 1 / 60);
    peak = Math.max(peak, stage.camera.position.distanceTo(base));
    // A signed axis, not the distance: the magnitude of a decaying
    // oscillation is nearly monotonic and would hide the oscillation.
    signed.push(stage.camera.position.x - base.x);
  }
  let reversals = 0;
  for (let i = 1; i < signed.length; i += 1) {
    if (signed[i - 1] !== 0 && signed[i] !== 0 && signed[i - 1] * signed[i] < 0) reversals += 1;
  }
  return {
    softTrauma: +softTrauma.toFixed(3),
    hardTrauma: +hardTrauma.toFixed(3),
    peak: +peak.toFixed(4),
    settled: +stage.camera.position.distanceTo(base).toFixed(5),
    reversals,
  };
});
check('impact shakes the camera', shake.peak > 0.002, `peak offset ${(shake.peak * 100).toFixed(2)} cm`);
check('shake stays subtle, never nauseating', shake.peak < 0.06, `peak ${(shake.peak * 100).toFixed(2)} cm`);
check('a cleaner strike shakes harder', shake.hardTrauma > shake.softTrauma, `trauma ${shake.softTrauma} vs ${shake.hardTrauma}`);
// Two full cycles is the line between an oscillation and a single lurch;
// far more than that would read as a buzz rather than a knock.
check('shake oscillates like an impact, not a single lurch',
  shake.reversals >= 4,
  `${shake.reversals} zero crossings ≈ ${(shake.reversals / 2).toFixed(1)} cycles`);
check('camera returns exactly to its framing', shake.settled < 1e-4, `residual ${shake.settled}m`);

// --- frame-rate governor ------------------------------------------------
const gov = await page.evaluate(async () => {
  const { PerfGovernor } = await import('/src/core/perf.js');
  const changes = [];
  const g = new PerfGovernor({ quality: 'high', onChange: (q, d) => changes.push(`${d}:${q}`) });

  // Simulate 16s of a device that cannot hold 60 (the first 4s are the
  // governor's warm-up grace and must not count against the device).
  for (let i = 0; i < 16 * 30; i += 1) g.sample(1 / 30);
  const afterStruggle = g.quality;

  // Then 30s of comfortable 60fps.
  for (let i = 0; i < 30 * 60; i += 1) g.sample(1 / 60);
  const afterRecovery = g.quality;

  // A steady 60 from the start must never downgrade.
  const stable = new PerfGovernor({ quality: 'medium' });
  for (let i = 0; i < 20 * 60; i += 1) stable.sample(1 / 60);

  // A device that stutters only during startup must NOT be downgraded.
  const warmup = new PerfGovernor({ quality: 'high' });
  for (let i = 0; i < 3 * 10; i += 1) warmup.sample(1 / 10); // 3s of 10fps
  for (let i = 0; i < 10 * 60; i += 1) warmup.sample(1 / 60); // then smooth

  return {
    changes, afterStruggle, afterRecovery,
    stableStayedOrRose: stable.quality !== 'low',
    afterWarmupStutter: warmup.quality,
  };
});
check('governor drops quality on a device that cannot keep up',
  gov.afterStruggle === 'low', `high → ${gov.afterStruggle} (${gov.changes.join(', ')})`);
check('governor recovers quality when the device copes',
  gov.afterRecovery !== 'low', `recovered to ${gov.afterRecovery}`);
check('governor never downgrades a device holding 60fps', gov.stableStayedOrRose);
check('startup stutter alone never downgrades quality',
  gov.afterWarmupStutter === 'high',
  `still ${gov.afterWarmupStutter} after 3s of 10fps during warm-up`);

// --- runtime quality switching is safe ----------------------------------
const swap = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  const seen = [];
  for (const q of ['low', 'medium', 'high', 'low']) {
    stage.setQuality(q);
    stage.update(game, 1 / 60);
    stage.render(1 / 60);
    seen.push(`${stage.quality}:${stage.post.composer.passes.length}`);
  }
  stage.setQuality('high');
  return seen;
});
check('quality can be swapped at runtime without breaking rendering', swap.length === 4, swap.join(' → '));

// --- GPU budget ---------------------------------------------------------
const info = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  const point = { x: 0, y: 0.46, z: 0 };
  stage.onKick({ grade: 'PERFECT', point, combo: 1, multiplier: 1, score: 1 });
  stage.update(game, 1 / 60);
  stage.renderer.info.autoReset = false;
  stage.renderer.info.reset();
  stage.render(1 / 60);
  const i = stage.renderer.info.render;
  const out = { calls: i.calls, triangles: i.triangles, programs: stage.renderer.info.programs.length };
  stage.renderer.info.autoReset = true;
  return out;
});
check('draw calls stay within a mobile budget mid-impact', info.calls <= 90, `${info.calls} draw calls`);
check('triangles stay within a mobile budget mid-impact', info.triangles <= 260000, `${info.triangles} triangles`);
check('shader program count is modest', info.programs <= 45, `${info.programs} programs`);

// A program compiled mid-rally is a visible stall on mobile. After warm-up,
// the count must be frozen.
const compiles = await page.evaluate(() => {
  const { game, stage, handleEvent } = window.__KICKUP__;
  game.reset();
  game.start();
  for (let i = 0; i < 60; i += 1) {
    stage.update(game, 1 / 60);
    stage.render(1 / 60);
  }
  const warm = stage.renderer.info.programs.length;
  for (let i = 0; i < 240; i += 1) {
    if (game.state !== 'PLAYING') game.start();
    game.advance(1 / 60);
    if (game.ball.descending && game.ball.y < 0.6) {
      game.tap();
      for (const e of game.drainEvents()) handleEvent(e);
    } else {
      game.drainEvents();
    }
    stage.update(game, 1 / 60);
    stage.render(1 / 60);
  }
  return { warm, after: stage.renderer.info.programs.length };
});
check('no shader is compiled mid-rally', compiles.after === compiles.warm,
  `${compiles.warm} programs after warm-up, ${compiles.after} after 240 frames of play`);

check('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await close();
process.exit(report(6));
