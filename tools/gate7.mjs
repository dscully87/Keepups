/**
 * Phase 7 quality gate — swipe-to-aim rules.
 *  - the swipe's direction and power change where the ball goes
 *  - there is no self-rescue: the ball is never centred for the player
 *  - the character has to be under the ball (reach)
 *  - randomness is seeded, so the same inputs replay identically
 *  - skill matters: a good player outlasts a random one by a wide margin
 */
import { readFileSync } from 'node:fs';
import { openGame, check, report } from './harness.mjs';

const { page, errors, close } = await openGame();
console.log('PHASE 7 GATE — SWIPE-TO-AIM');

// Core files must never use Math.random: seeded randomness only.
const coreSrc = ['game.js', 'physics.js', 'combo.js', 'difficulty.js']
  .map((f) => readFileSync(new URL(`../src/core/${f}`, import.meta.url), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may mention it
check('core rules use no Math.random', !/Math\.random/.test(coreSrc));

const res = await page.evaluate(async () => {
  const { game } = window.__KICKUP__;
  window.__PAUSE__ = true;
  const { aimFromTrail } = await import('/src/core/input.js');

  const arm = (x = 0) => {
    game.reset(); game.start();
    game.ball.x = x; game.ball.y = 0.46; game.ball.vy = -2; game.ball.vx = 0;
    game.playerX = x;
  };
  const out = {};

  // Direction: side maps to horizontal launch speed with the right sign.
  arm(); game.kick({ side: 1, power: 0.5 }); out.vxRight = game.ball.vx;
  arm(); game.kick({ side: -1, power: 0.5 }); out.vxLeft = game.ball.vx;
  arm(); game.kick({ side: 0, power: 0.5 }); out.vxStraight = game.ball.vx;

  // Power: higher power gives a higher apex.
  const apex = (power) => { arm(); game.kick({ side: 0, power }); const g = game.tuning.gravity; return game.ball.y + (game.ball.vy ** 2) / (2 * g); };
  out.apexLow = apex(0); out.apexHigh = apex(1);

  // No self-centring: a kick from off-centre does not pull the ball back by itself.
  arm(0.4); game.kick({ side: 0, power: 0.5 }); out.vxOffCentre = game.ball.vx;

  // Reach: a ball outside PLAYER_REACH cannot be kicked.
  arm(); game.playerX = -0.9; game.ball.x = 0; game.lastKickAt = -Infinity;
  const far = game.kick({ side: 0, power: 0.5 }); out.farKicked = far !== null;
  game.playerX = -0.3; game.lockoutUntil = -Infinity;
  out.nearKicked = game.kick({ side: 0, power: 0.5 }) !== null;

  // With no input, the ball is lost within a bounded time.
  game.reset(); game.start(); let t = 0;
  while (game.state === 'PLAYING' && t < 30) { game.advance(1 / 60); t += 1 / 60; }
  out.lostAfter = t;

  // A ball leaving the side of the pitch ends the rally (no wall rescue).
  arm(); game.ball.vx = 6; game.ball.vy = 0; game.ball.y = 2;
  for (let i = 0; i < 240 && game.state === 'PLAYING'; i += 1) game.advance(1 / 120);
  out.sideOut = game.state;

  // Determinism: same seed + same inputs -> identical final state.
  const bot = (g, noise) => {
    const b = g.ball; const power = 0.4;
    const vy = (4.2 + 3 * power) * g.tuning.kickPower / 5.1; const tt = 2 * vy / g.tuning.gravity;
    const decay = (1 - Math.exp(-g.tuning.drag * tt)) / g.tuning.drag;
    const side = (0 - b.x - 0.5 * g.wind * tt * tt) / (2.4 * decay) + noise;
    g.kick({ side: Math.max(-1, Math.min(1, side)), power });
  };
  const play = (seed, policy, cap = 90) => {
    game.setSeed(seed); game.start();
    let n = 0;
    while (game.state === 'PLAYING' && n < cap * 120) {
      game.advance(1 / 120); n += 1;
      const b = game.ball;
      if (b.vy < 0 && b.y < 0.5 && b.y > 0.3) policy(game);
    }
    return { score: game.score, x: game.ball.x, y: game.ball.y, t: game.time };
  };
  const noisy = (g) => bot(g, (g.rng() - 0.5) * 0.5);
  const a = play(11, noisy); const b2 = play(11, noisy);
  out.deterministic = JSON.stringify(a) === JSON.stringify(b2);

  // Skill: a decent (noisy) player vs a random swiper vs a straight-tapper.
  const avg = (policy) => { let s = 0; for (let k = 1; k <= 6; k += 1) s += play(k, policy).score; return s / 6; };
  out.good = avg(noisy);
  out.random = avg((g) => g.kick({ side: g.rng() * 2 - 1, power: g.rng() }));
  out.straight = avg((g) => g.tap());

  // Rescue bonus is named, so points are never mysterious.
  arm(); game.playerX = -0.45; game.ball.x = 0; game.lastKickAt = -Infinity;
  const rescue = game.kick({ side: 0, power: 0.5 });
  out.rescueNamed = !!rescue && rescue.bonuses.some((x) => x.name === 'RESCUE');

  // Swipe maths: direction and speed come from the trail's last ~80ms only.
  const trail = (pts) => {
    const ts = new Float64Array(pts.map((p) => p[0])); const xs = new Float64Array(pts.map((p) => p[1])); const ys = new Float64Array(pts.map((p) => p[2]));
    return aimFromTrail(ts, xs, ys, pts.length, pts[pts.length - 1][0], 844);
  };
  out.swipeRight = trail([[0, 100, 600], [40, 120, 560], [80, 150, 520]]);
  out.swipeLeft = trail([[0, 300, 600], [40, 280, 560], [80, 250, 520]]);
  out.swipeSlow = trail([[0, 200, 600], [100, 200, 590], [200, 200, 560]]);
  out.swipeFast = trail([[0, 200, 700], [40, 200, 560], [80, 200, 400]]);
  out.tapOnly = trail([[0, 200, 600], [30, 201, 601]]);
  // Wind-up: a long slow drag followed by a short flick must read as the flick.
  out.windUp = trail([[0, 50, 700], [300, 80, 690], [600, 100, 680], [640, 160, 640], [680, 220, 600]]);
  return out;
});

check('swipe right launches the ball right', res.vxRight > 1, `vx ${res.vxRight.toFixed(2)} m/s`);
check('swipe left launches the ball left', res.vxLeft < -1, `vx ${res.vxLeft.toFixed(2)} m/s`);
check('a plain tap kicks straight up', Math.abs(res.vxStraight) < 1e-9, `vx ${res.vxStraight}`);
check('harder swipes send the ball higher', res.apexHigh > res.apexLow + 0.5, `apex ${res.apexLow.toFixed(2)} → ${res.apexHigh.toFixed(2)} m`);
check('nothing pulls the ball back to centre', Math.abs(res.vxOffCentre) < 1e-9, `vx ${res.vxOffCentre}`);
check('a ball outside reach cannot be kicked', res.farKicked === false && res.nearKicked === true, `far=${res.farKicked} near=${res.nearKicked}`);
check('with no input the ball is lost in bounded time', res.lostAfter < 5, `lost after ${res.lostAfter.toFixed(2)} s`);
check('a ball leaving the side ends the rally', res.sideOut === 'GAME_OVER', res.sideOut);
check('same seed and inputs give the same game', res.deterministic);
check('a good player far outlasts a random one', res.good > res.random * 5 && res.good > 25, `good ${res.good.toFixed(1)} vs random ${res.random.toFixed(1)}`);
check('steering beats tapping straight', res.good > res.straight * 1.5, `good ${res.good.toFixed(1)} vs straight ${res.straight.toFixed(1)}`);
check('rescues are named in the bonus list', res.rescueNamed);
check('swipe direction maps to side', res.swipeRight.side > 0.3 && res.swipeLeft.side < -0.3, `${res.swipeRight.side.toFixed(2)} / ${res.swipeLeft.side.toFixed(2)}`);
check('faster swipe gives more power', res.swipeFast.power > res.swipeSlow.power + 0.3, `${res.swipeSlow.power.toFixed(2)} → ${res.swipeFast.power.toFixed(2)}`);
check('a tiny movement is a plain tap', res.tapOnly.swipe === false);
check('only the final flick counts, not the wind-up', res.windUp.swipe && res.windUp.side > 0.3, `side ${res.windUp.side.toFixed(2)}`);

// A real touch swipe through the browser reaches the game with the right direction.
const real = await page.evaluate(() => {
  const { game } = window.__KICKUP__;
  game.reset(); game.start();
  game.ball.x = 0; game.ball.y = 0.5; game.ball.vy = -3; game.playerX = 0;
  return true;
});
const cdp = await page.context().newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
await touch('touchStart', 150, 600);
await touch('touchMove', 180, 560);
await touch('touchMove', 230, 500);
await touch('touchEnd');
const after = await page.evaluate(() => ({ vx: window.__KICKUP__.game.ball.vx, score: window.__KICKUP__.game.score }));
check('a real touch swipe steers the ball', real && after.score === 1 && after.vx > 0.5, `score ${after.score}, vx ${after.vx.toFixed(2)}`);

check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await close();
process.exit(report(7));
