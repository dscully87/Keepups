/**
 * Captures real gameplay for the trailer.
 *
 *   node video/capture.mjs
 *
 * Nothing here is staged footage: it is the shipping game, played by a script
 * that taps when the ball reaches the sweet spot. The simulation is a pure
 * fixed-step function of time, so instead of screen-recording (CI renders in
 * software at a few frames a second) each output frame is stepped by exactly
 * 1/30 s and screenshotted. The result is frame-perfect at any render speed,
 * and slow motion is free — step a quarter of the time per frame.
 *
 * Writes video/public/capture/<shot>.mp4 and capture.json, the per-frame score
 * and per-kick grade track that the Remotion edit draws its overlays from.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGame } from '../tools/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'public/capture');
const FPS = 30;
// 720x1280. Software rendering costs seconds per frame; pass CAPTURE_SCALE=2
// on a machine with a GPU for 1080x1920.
const SCALE = Number(process.env.CAPTURE_SCALE || 4 / 3);

/**
 * The shot list. `speed` scales simulated time per frame; `cam` overrides the
 * game camera (position, look-at, field of view) and may drift over the shot.
 */
const SHOTS = [
  { name: 'rally', frames: 126, speed: 1, warmup: 9, cam: null },
  {
    name: 'boot', frames: 72, speed: 0.2, cue: true,
    cam: { from: [1.05, 0.34, 1.55], to: [0.80, 0.40, 1.70], look: [-0.06, 0.52, 0.16], fov: 34 },
  },
  {
    name: 'hero', frames: 96, speed: 1,
    cam: { from: [-1.9, 1.25, 2.9], to: [-1.1, 1.05, 3.3], look: [-0.20, 1.0, 0.05], fov: 36 },
  },
];

const { page, errors, close } = await openGame({ dpr: SCALE, quality: 'high', viewport: { width: 540, height: 960 } });

await page.addStyleTag({ content: '.hud, .scrim, #sound, #overlay { display: none !important; }' });
await page.evaluate(() => {
  window.__PAUSE__ = true;
  const { game } = window.__KICKUP__;
  game.reset();
  game.start();
  window.__CAP__ = { kicks: [], t: 0 };
});

/** Advance the game by `dt`, tapping at the sweet spot, and report what happened. */
const step = (dt, cam, progress, draw = true) =>
  page.evaluate(
    ({ dt, cam, progress, draw }) => {
      const { game, stage, handleEvent } = window.__KICKUP__;
      const cap = window.__CAP__;
      const kicks = [];
      const SUB = 1 / 240;
      let left = dt;
      while (left > 1e-9) {
        const h = Math.min(SUB, left);
        left -= h;
        game.advance(h);
        cap.t += h;
        // The scripted player: mostly clean, now and then a touch late.
        const late = cap.kicks.length % 5 === 3 ? 0.14 : 0;
        if (game.state === 'PLAYING' && game.ball.descending && game.ball.y <= 0.47 - late) game.tap();
        for (const e of game.drainEvents()) {
          handleEvent(e);
          if (e.type === 'kick') {
            const k = { grade: e.data.grade, gained: e.data.gained, combo: e.data.combo, multiplier: e.data.multiplier };
            cap.kicks.push(k);
            kicks.push(k);
          }
        }
      }
      stage.update(game, dt);
      if (cam) {
        const lerp = (a, b) => a + (b - a) * progress;
        stage.camera.position.set(lerp(cam.from[0], cam.to[0]), lerp(cam.from[1], cam.to[1]), lerp(cam.from[2], cam.to[2]));
        stage.camera.fov = cam.fov;
        stage.camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);
        stage.camera.updateProjectionMatrix();
        stage.post.focusOn(stage.camera.position.distanceTo(stage.ball.mesh.position));
      }
      if (draw) stage.render(dt);
      return {
        kicks,
        score: game.score,
        points: game.combo.points,
        combo: game.combo.combo,
        multiplier: game.combo.multiplier,
        tier: game.tier,
        state: game.state,
      };
    },
    { dt, cam, progress, draw },
  );

rmSync(OUT, { recursive: true, force: true });
const canvas = page.locator('#stage');
const track = {};

for (const shot of SHOTS) {
  const dir = join(OUT, shot.name);
  mkdirSync(dir, { recursive: true });

  // Unrecorded lead-in: rallies before the first shot so it opens mid-flow,
  // and, for a cued shot, runs on until the ball is dropping into reach.
  for (let i = 0; i < (shot.warmup || 0) * FPS; i += 1) await step(1 / FPS, null, 0, false);
  if (shot.cue) {
    for (let guard = 0; guard < 600; guard += 1) {
      const ready = await page.evaluate(() => {
        const b = window.__KICKUP__.game.ball;
        return b.descending && b.y < 1.05 && b.y > 0.9;
      });
      if (ready) break;
      await step(1 / 120, null, 0, false);
    }
  }
  // Restore the game camera's own lens after an overridden shot.
  if (!shot.cam) {
    await page.evaluate(() => {
      const { stage } = window.__KICKUP__;
      stage.resize();
      stage.camera.position.copy(stage.cameraBase);
      stage.camera.lookAt(stage.cameraTarget);
    });
  }

  const frames = [];
  for (let f = 0; f < shot.frames; f += 1) {
    const state = await step(shot.speed / FPS, shot.cam, f / (shot.frames - 1));
    if (state.state !== 'PLAYING') throw new Error(`${shot.name}: rally ended at frame ${f}`);
    await canvas.screenshot({ path: join(dir, `${String(f).padStart(4, '0')}.png`) });
    frames.push(state);
    if (f % 30 === 0) console.log(`${shot.name} ${f}/${shot.frames} score=${state.score}`);
  }
  track[shot.name] = { frames: shot.frames, speed: shot.speed, perFrame: frames };

  const enc = spawnSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', join(dir, '%04d.png'),
    '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-g', '1',
    join(OUT, `${shot.name}.mp4`),
  ], { stdio: 'inherit' });
  if (enc.status !== 0) throw new Error(`ffmpeg failed for ${shot.name}`);
  rmSync(dir, { recursive: true, force: true });
}

writeFileSync(join(OUT, 'capture.json'), JSON.stringify({ fps: FPS, width: Math.round(540 * SCALE), height: Math.round(960 * SCALE), shots: track }));
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '));
await close();
console.log('capture complete');
