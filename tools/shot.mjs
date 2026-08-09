/**
 * Play-and-capture helper. Drives the simulation and the stage by hand rather
 * than waiting on requestAnimationFrame, because CI renders in software at a
 * few frames per second and rAF-based waits would crawl.
 *
 *   node tools/shot.mjs <name> [msAfterKick] [score] [dpr]
 */
import { openGame } from './harness.mjs';

const name = process.argv[2] || 'shot';
const afterKickMs = Number(process.argv[3] ?? 60);
const targetScore = Number(process.argv[4] ?? 14);
const dpr = Number(process.argv[5] ?? 2);
const quality = process.argv[6] || 'high';

const { page, errors, close } = await openGame({ dpr, quality });

const info = await page.evaluate(
  ({ score, afterKick }) => {
    const { game, stage } = window.__KICKUP__;
    window.__PAUSE__ = true; // main loop yields to us

    game.reset();
    game.start();
    let guard = 0;
    while (game.score < score && guard < 400000) {
      guard += 1;
      game.advance(1 / 240);
      if (game.ball.descending && Math.abs(game.ball.y - 0.46) < 0.03) game.tap();
      if (game.state !== 'PLAYING') {
        game.reset();
        game.start();
      }
    }

    // Line the ball up in the strike zone, then take a real contact.
    guard = 0;
    while (!(game.ball.descending && game.ball.y < 0.68 && game.ball.y > 0.34) && guard < 100000) {
      guard += 1;
      game.advance(1 / 240);
    }
    const contact = game.tap();

    // Consume the resulting events through the normal path, then advance the
    // stage frame by frame to the requested moment after impact.
    for (const e of game.drainEvents()) {
      if (e.type === 'kick') stage.onKick(e.data);
    }
    const dt = 1 / 60;
    const steps = Math.max(1, Math.round(afterKick / 1000 / dt));
    for (let i = 0; i < steps; i += 1) {
      game.advance(dt);
      game.drainEvents();
      stage.update(game, dt);
    }
    stage.render(dt);

    return { score: game.score, grade: contact?.grade ?? null, weights: stage.player.weights() };
  },
  { score: targetScore, afterKick: afterKickMs },
);

await page.screenshot({ path: `shots/${name}.png` });
console.log(`shots/${name}.png  score=${info.score} grade=${info.grade}`);
console.log('  weights', JSON.stringify(info.weights));
if (errors.length) console.log('  errors:', errors.slice(0, 3).join(' | '));
await close();
