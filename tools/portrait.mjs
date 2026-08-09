/**
 * Character inspection rig. Renders the player alone, large in frame, from
 * several angles and poses, so the model can be judged on its own merits
 * rather than squinting at it across a pitch.
 *
 *   node tools/portrait.mjs [name] [dpr]
 *
 * Writes shots/<name>-{front,three-quarter,side,kick,closeup}.png
 */
import { openGame } from './harness.mjs';

const name = process.argv[2] || 'portrait';
const dpr = Number(process.argv[3] ?? 2);

const { page, errors, close } = await openGame({ dpr, quality: 'high', viewport: { width: 520, height: 900 } });

const VIEWS = [
  { key: 'front', pos: [0.0, 1.05, 3.0], target: [0, 0.95, 0], pose: 'idle' },
  { key: 'three-quarter', pos: [1.9, 1.15, 2.4], target: [0, 0.95, 0], pose: 'idle' },
  { key: 'side', pos: [3.0, 1.05, 0.2], target: [0, 0.95, 0], pose: 'idle' },
  { key: 'kick', pos: [1.7, 1.05, 2.5], target: [0, 0.80, 0.1], pose: 'kick' },
  { key: 'closeup', pos: [0.55, 1.60, 1.15], target: [0, 1.52, 0], pose: 'idle' },
];

await page.evaluate(() => {
  window.__PAUSE__ = true;
  const { stage } = window.__KICKUP__;
  // Hide the HUD so nothing overlaps the model.
  for (const el of document.querySelectorAll('.hud, .scrim, #sound, #overlay')) {
    el.style.display = 'none';
  }
  // Stand the player at the origin, facing camera, for consistent framing.
  stage.player.group.position.set(0, 0, 0);
  stage.player.group.rotation.y = 0;
});

for (const view of VIEWS) {
  await page.evaluate((v) => {
    const { game, stage } = window.__KICKUP__;
    game.reset();
    game.start();

    stage.player.reset();
    stage.fx.clear();
    stage.shake.reset();

    if (v.pose === 'kick') {
      // Park the ball at the sweet spot and take a real strike, then advance
      // to the most expressive frame of the follow-through.
      game.ball.x = 0;
      game.ball.z = 0;
      game.ball.y = 0.46;
      game.ball.vy = -2.4;
      for (let i = 0; i < 20; i += 1) stage.update(game, 1 / 60);
      game.tap();
      for (const e of game.drainEvents()) if (e.type === 'kick') stage.onKick(e.data);
      for (let i = 0; i < 5; i += 1) stage.update(game, 1 / 60);
    } else {
      // Settle the idle cycle at a readable point in its sway.
      game.ball.y = 2.6;
      game.ball.vy = 0.2;
      for (let i = 0; i < 42; i += 1) stage.update(game, 1 / 60);
    }

    stage.camera.position.set(...v.pos);
    stage.camera.lookAt(...v.target);
    stage.camera.fov = 42;
    stage.camera.updateProjectionMatrix();
    stage.post.focusOn(stage.camera.position.distanceTo({ x: v.target[0], y: v.target[1], z: v.target[2] }));
    stage.render(1 / 60);
  }, view);
  await page.screenshot({ path: `shots/${name}-${view.key}.png` });
  console.log(`shots/${name}-${view.key}.png`);
}

if (errors.length) console.log('errors:', errors.slice(0, 3).join(' | '));
await close();
