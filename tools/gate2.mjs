/**
 * Phase 2 quality gate.
 *  - the game ends when the ball touches the bottom edge
 *  - difficulty visibly ramps at the 10 / 20 / 50 milestones
 *  - the combo system rewards precise timing and resets on sloppy timing
 */
import { openGame, check, report, frames } from './harness.mjs';

const { page, errors, close } = await openGame();
console.log('PHASE 2 GATE — STATE MANAGEMENT & DIFFICULTY');

// --- failure state ------------------------------------------------------
const fail = await page.evaluate(async () => {
  const { game, STATE } = window.__KICKUP__;
  game.start();
  const started = game.state;
  // Let it drop without touching it.
  for (let i = 0; i < 600 && game.state === STATE.PLAYING; i += 1) game.advance(1 / 60);
  return { started, ended: game.state, ballY: game.ball.y, over: STATE.GAME_OVER };
});
check('rally starts in PLAYING', fail.started === 'PLAYING', fail.started);
check('game ends when the ball hits the turf', fail.ended === fail.over, `state=${fail.ended}, y=${fail.ballY.toFixed(3)} m`);

const frozen = await page.evaluate(() => {
  const { game } = window.__KICKUP__;
  const before = game.score;
  game.tap();
  return { before, after: game.score, state: game.state };
});
check('taps do not score after full time', frozen.after === frozen.before, `score stayed ${frozen.after}`);

// --- restart ------------------------------------------------------------
const restart = await page.evaluate(async () => {
  const { game } = window.__KICKUP__;
  for (let i = 0; i < 90; i += 1) game.advance(1 / 60); // clear the 0.6s guard
  game.tap();
  return { state: game.state, score: game.score, combo: game.combo.combo };
});
check('a later tap restarts the match', restart.state === 'PLAYING' && restart.score === 0, `state=${restart.state}, score=${restart.score}`);

// --- difficulty scaling -------------------------------------------------
const ramp = await page.evaluate(async () => {
  const { game } = window.__KICKUP__;
  const mod = await import('/src/core/difficulty.js');
  const sample = (s) => {
    const t = mod.tuningFor(s);
    return { gravity: +t.gravity.toFixed(2), kick: +t.kickPower.toFixed(2), tier: t.tier, idx: t.tierIndex };
  };
  return { s0: sample(0), s9: sample(9), s13: sample(13), s23: sample(23), s53: sample(53) };
});
check('tier 0 below 10 keep-ups', ramp.s9.idx === 0, `${ramp.s9.tier} g=${ramp.s9.gravity}`);
check('tier steps up at 10', ramp.s13.idx === 1 && ramp.s13.gravity > ramp.s9.gravity, `${ramp.s9.gravity} → ${ramp.s13.gravity} m/s²`);
check('tier steps up at 20', ramp.s23.idx === 2 && ramp.s23.gravity > ramp.s13.gravity, `${ramp.s13.gravity} → ${ramp.s23.gravity} m/s²`);
check('tier steps up at 50', ramp.s53.idx === 3 && ramp.s53.gravity > ramp.s23.gravity, `${ramp.s23.gravity} → ${ramp.s53.gravity} m/s²`);
check('world-class gravity ≥ 1.7× warm-up', ramp.s53.gravity / ramp.s0.gravity >= 1.7, `${(ramp.s53.gravity / ramp.s0.gravity).toFixed(2)}×`);

// Descent speed must actually be faster at the top tier: measure fall time
// from the same apex under each tuning.
const fallTimes = await page.evaluate(async () => {
  const mod = await import('/src/core/difficulty.js');
  const { BallBody } = await import('/src/core/physics.js');
  const measure = (score) => {
    const t = mod.tuningFor(score);
    const b = new BallBody();
    b.reset(1.4);
    b.vy = 0;
    let s = 0;
    while (b.y > 0.11 && s < 20000) {
      b.step(1 / 480, t);
      s += 1;
    }
    return +(s / 480).toFixed(3);
  };
  return { warm: measure(0), pro: measure(23), world: measure(53) };
});
check('descent is measurably faster at higher tiers',
  fallTimes.world < fallTimes.pro && fallTimes.pro < fallTimes.warm,
  `fall time ${fallTimes.warm}s → ${fallTimes.pro}s → ${fallTimes.world}s`);

// Live milestone event during real play.
const milestone = await page.evaluate(async () => {
  const { game } = window.__KICKUP__;
  game.start();
  const tiers = [];
  let guard = 0;
  while (game.score < 22 && guard < 400000) {
    guard += 1;
    game.advance(1 / 240);
    if (game.ball.descending && Math.abs(game.ball.y - 0.46) < 0.03) game.tap();
    for (const e of game.drainEvents()) if (e.type === 'milestone') tiers.push(e.data.tier);
  }
  return { tiers, score: game.score, live: game.tier };
});
check('milestone events fire during live play', milestone.tiers.length >= 2, milestone.tiers.join(' → ') || 'none');

// --- combo system -------------------------------------------------------
const combo = await page.evaluate(async () => {
  const { ComboTracker, gradeContact } = await import('/src/core/combo.js');
  const c = new ComboTracker();
  const seq = [];
  // Four dead-centre strikes.
  for (let i = 0; i < 4; i += 1) seq.push(c.register(0.46));
  const afterPerfect = { combo: c.combo, mult: c.multiplier, points: c.points };
  // One badly mistimed strike (ball far above the band).
  const sloppy = c.register(1.05);
  const afterSloppy = { combo: c.combo, mult: c.multiplier };
  // Whiff also breaks a rebuilt streak.
  c.register(0.46);
  c.register(0.46);
  const broke = c.breakStreak();
  return {
    grades: seq.map((s) => s.grade),
    afterPerfect,
    sloppyGrade: sloppy.grade,
    afterSloppy,
    broke,
    afterWhiff: c.combo,
    edge: [gradeContact(0.46).grade, gradeContact(0.54).grade, gradeContact(0.68).grade, gradeContact(0.95).grade],
  };
});
check('centred strikes grade PERFECT', combo.grades.every((g) => g === 'PERFECT'), combo.grades.join(','));
check('4-streak reaches ×2 multiplier', combo.afterPerfect.mult === 2 && combo.afterPerfect.combo === 4, `combo ${combo.afterPerfect.combo} ×${combo.afterPerfect.mult}`);
check('multiplier is applied to points', combo.afterPerfect.points === 100 * 3 + 200, `${combo.afterPerfect.points} pts`);
check('mistimed strike grades SLOPPY and resets combo', combo.sloppyGrade === 'SLOPPY' && combo.afterSloppy.combo === 0, `combo → ${combo.afterSloppy.combo} ×${combo.afterSloppy.mult}`);
check('a whiff breaks the streak', combo.broke && combo.afterWhiff === 0, `combo → ${combo.afterWhiff}`);
check('grade bands are ordered by timing error', combo.edge.join(',') === 'PERFECT,PERFECT,GOOD,SLOPPY', combo.edge.join(','));

// Mashing must be worse than timing.
const mash = await page.evaluate(() => {
  const { game } = window.__KICKUP__;
  const run = (strategy, budget = 20000) => {
    game.reset();
    game.start();
    let guard = 0;
    while (game.state === 'PLAYING' && guard < budget) {
      guard += 1;
      game.advance(1 / 240);
      strategy(game);
    }
    const perKick = game.score ? game.combo.points / game.score : 0;
    return { score: game.score, points: game.combo.points, best: game.combo.best, perKick: +perKick.toFixed(1) };
  };
  const timed = run((g) => {
    if (g.ball.descending && Math.abs(g.ball.y - 0.46) < 0.03) g.tap();
  });
  const mashed = run((g) => g.tap());
  return { timed, mashed };
});
check('mashing still keeps the ball up (not an instant loss)', mash.mashed.score > 5, `${mash.mashed.score} kicks`);
check('mashing never chains into a multiplier', mash.mashed.best < 4, `best combo ${mash.mashed.best}`);
check('timed play scores far more per kick',
  mash.timed.perKick > mash.mashed.perKick * 4,
  `timed ${mash.timed.perKick} pts/kick vs mash ${mash.mashed.perKick} pts/kick`);

// --- UI wiring ----------------------------------------------------------
await page.evaluate(() => {
  const { game } = window.__KICKUP__;
  game.start();
  for (let i = 0; i < 600 && game.state === 'PLAYING'; i += 1) game.advance(1 / 60);
});
await frames(page, 4);
const overlayVisible = await page.evaluate(() => document.getElementById('overlay').classList.contains('visible'));
check('full-time overlay appears', overlayVisible);
check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await close();
process.exit(report(2));
