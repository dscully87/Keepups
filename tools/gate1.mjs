/**
 * Phase 1 quality gate.
 *  - the ball responds to gravity
 *  - taps apply upward velocity
 *  - the ball stays inside the play bounds
 *  - the score increments on each successful interaction
 */
import { openGame, check, report, frames } from './harness.mjs';

const { page, errors, close } = await openGame();
console.log('PHASE 1 GATE — MVP');

// --- gravity -----------------------------------------------------------
const gravity = await page.evaluate(async () => {
  const { game } = window.__KICKUP__;
  game.reset();
  game.ball.vy = 0;
  const y0 = game.ball.y;
  const v0 = game.ball.vy;
  for (let i = 0; i < 24; i += 1) game.advance(1 / 60);
  return { y0, y1: game.ball.y, v0, v1: game.ball.vy, dt: 24 / 60 };
});
check('ball falls under gravity', gravity.y1 < gravity.y0, `y ${gravity.y0.toFixed(2)} → ${gravity.y1.toFixed(2)} m`);
const measuredG = -(gravity.v1 - gravity.v0) / gravity.dt;
check('acceleration ≈ 9.81 m/s²', Math.abs(measuredG - 9.81) < 1.2, `measured ${measuredG.toFixed(2)} m/s²`);

// --- tap applies upward velocity ---------------------------------------
const tap = await page.evaluate(async () => {
  const { game } = window.__KICKUP__;
  game.reset();
  // Fall into the contact window first.
  while (game.ball.y > 0.5) game.advance(1 / 120);
  const before = { y: game.ball.y, vy: game.ball.vy, score: game.score };
  const contact = game.tap();
  return { before, after: { vy: game.ball.vy, score: game.score }, contact };
});
check('tap applies upward velocity', tap.before.vy < 0 && tap.after.vy > 0, `vy ${tap.before.vy.toFixed(2)} → ${tap.after.vy.toFixed(2)} m/s`);
check('score increments on contact', tap.after.score === tap.before.score + 1, `score ${tap.before.score} → ${tap.after.score}`);

// --- real DOM tap path --------------------------------------------------
const domTap = await page.evaluate(() => {
  const { game } = window.__KICKUP__;
  game.reset();
  while (game.ball.y > 0.5) game.advance(1 / 120);
  return game.score;
});
await page.touchscreen.tap(195, 500);
await frames(page, 3);
const afterDom = await page.evaluate(() => window.__KICKUP__.game.score);
check('screen tap reaches the game', afterDom > domTap, `score ${domTap} → ${afterDom}`);

// --- bounds -------------------------------------------------------------
const bounds = await page.evaluate(() => {
  const { game } = window.__KICKUP__;
  game.reset();
  game.start();
  let maxAbsX = 0;
  let maxY = 0;
  let minY = Infinity;
  let totalKicks = 0;
  let prevScore = 0;
  for (let i = 0; i < 60 * 60; i += 1) {
    game.advance(1 / 60);
    // Tap aggressively and at random to try to punt the ball out of the arena.
    if (Math.random() < 0.25) game.tap();
    if (game.score > prevScore) totalKicks += game.score - prevScore;
    prevScore = game.score;
    maxAbsX = Math.max(maxAbsX, Math.abs(game.ball.x));
    maxY = Math.max(maxY, game.ball.y);
    minY = Math.min(minY, game.ball.y);
    if (game.state === 'GAME_OVER') {
      game.reset();
      game.start();
      prevScore = 0;
    }
  }
  return { maxAbsX, maxY, minY, score: totalKicks };
});
check('ball stays within horizontal bounds', bounds.maxAbsX <= 1.35, `max |x| = ${bounds.maxAbsX.toFixed(2)} m`);
check('ball stays below ceiling', bounds.maxY <= 3.6, `max y = ${bounds.maxY.toFixed(2)} m`);
check('ball never sinks through the turf', bounds.minY >= 0.109, `min y = ${bounds.minY.toFixed(3)} m`);
check('score accumulated over the run', bounds.score > 50, `${bounds.score} keep-ups`);

// --- rendering ----------------------------------------------------------
// Read straight out of the GL back buffer immediately after a draw, which
// works without preserveDrawingBuffer.
const pixels = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  stage.render();
  const gl = stage.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const seen = new Set();
  for (let i = 0; i < buf.length; i += 4 * 997) seen.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
  return { colours: seen.size, w, h };
});
check('renders a non-trivial image', pixels.colours > 8, `${pixels.colours} distinct sampled colours at ${pixels.w}x${pixels.h}`);
check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await close();
process.exit(report(1));
