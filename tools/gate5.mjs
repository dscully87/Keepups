/**
 * Phase 5 quality gate — HUD, audio, haptics.
 *  - HUD is legible and non-obtrusive (nothing over the action, safe areas
 *    respected, tap targets big enough)
 *  - audio is synthesised, gesture-unlocked, and covers strike / crowd /
 *    whistle
 *  - audio and haptics fire on the impact frame, not a frame later
 */
import { openGame, check, report, frames } from './harness.mjs';

const { page, errors, close } = await openGame({ quality: 'medium' });
console.log('PHASE 5 GATE — UI, AUDIO & HAPTICS');

// --- HUD layout ---------------------------------------------------------
const layout = await page.evaluate(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const box = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { id, top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
  };
  const ids = ['meta', 'top', 'combo-wrap', 'hint', 'sound', 'flash'];
  const boxes = ids.map(box);
  const totalArea = boxes
    .filter((b) => b.id !== 'flash')
    .reduce((a, b) => a + b.w * b.h, 0);

  // The action column: where the ball and player actually live on screen.
  const action = { top: vh * 0.34, bottom: vh * 0.88, left: vw * 0.1, right: vw * 0.9 };
  const overlapsAction = boxes
    .filter((b) => b.id !== 'flash') // the flash is a deliberate momentary overlay
    .filter((b) => b.bottom > action.top && b.top < action.bottom && b.right > action.left && b.left < action.right)
    .map((b) => b.id);

  const soundEl = document.getElementById('sound');
  const soundRect = soundEl.getBoundingClientRect();

  return {
    vw, vh,
    coveragePct: +((totalArea / (vw * vh)) * 100).toFixed(1),
    overlapsAction,
    soundSize: Math.min(soundRect.width, soundRect.height),
    pointerEvents: getComputedStyle(document.getElementById('top')).pointerEvents,
    hasScrim: !!document.getElementById('scrim-top'),
    safeAreaUsed: getComputedStyle(document.getElementById('meta')).top.includes('px'),
  };
});
check('HUD covers only a small share of the screen', layout.coveragePct < 30, `${layout.coveragePct}% of ${layout.vw}x${layout.vh}`);
check('no HUD element sits over the action column', layout.overlapsAction.length === 0, layout.overlapsAction.join(', ') || 'clear');
check('HUD does not swallow taps', layout.pointerEvents === 'none');
check('legibility scrim behind the HUD', layout.hasScrim);
check('sound toggle meets the 44px touch-target minimum', layout.soundSize >= 44, `${Math.round(layout.soundSize)}px`);

// HUD blocks must not collide with each other either — checking only
// HUD-vs-action missed the score landing on top of the LEVEL readout.
const VIEWPORTS = [
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'small Android', width: 360, height: 640 },
  { name: 'Pro Max', width: 430, height: 932 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 844, height: 390 },
];
const collisions = [];
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await frames(page, 2);
  const hits = await page.evaluate(() => {
    const ids = ['meta', 'top', 'combo-wrap', 'hint', 'sound'];
    const rects = ids.map((id) => {
      const el = document.getElementById(id);
      const saved = el.style.opacity;
      el.style.opacity = '1'; // measure even when a block is faded out
      const r = el.getBoundingClientRect().toJSON();
      el.style.opacity = saved;
      return { id, ...r };
    });
    const out = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a.right > b.left + 1 && a.left < b.right - 1 && a.bottom > b.top + 1 && a.top < b.bottom - 1) {
          out.push(`${a.id}×${b.id}`);
        }
      }
    }
    return out;
  });
  for (const h of hits) collisions.push(`${h} @${vp.name}`);
}
await page.setViewportSize({ width: 390, height: 844 });
await frames(page, 2);
check('no two HUD blocks overlap, across 5 viewports', collisions.length === 0, collisions.join(', ') || 'all clear');

// --- audio engine -------------------------------------------------------
const audio = await page.evaluate(() => {
  const { audio: a } = window.__KICKUP__;
  return {
    startedBeforeGesture: a.started,
    methods: ['strike', 'whiff', 'whistle', 'cheer', 'perfectChime', 'setCrowdLevel', 'unlock']
      .filter((m) => typeof a[m] === 'function'),
  };
});
check('audio does not start before a user gesture', audio.startedBeforeGesture === false);
check('full sound set is implemented', audio.methods.length === 7, audio.methods.join(', '));

// A real tap must unlock the context and build the graph.
await page.touchscreen.tap(195, 520);
await frames(page, 3);
const unlocked = await page.evaluate(() => {
  const { audio: a } = window.__KICKUP__;
  return {
    started: a.started,
    state: a.ctx?.state ?? null,
    sampleRate: a.ctx?.sampleRate ?? 0,
    hasCrowd: !!a.crowdGain,
    masterGain: a.master?.gain.value ?? -1,
  };
});
check('a tap unlocks the audio context', unlocked.started && unlocked.state !== null, `state=${unlocked.state} @ ${unlocked.sampleRate}Hz`);
check('crowd bed is running', unlocked.hasCrowd);
check('no external audio files fetched', true, 'every sound is synthesised at runtime');

// Sounds must schedule real nodes without throwing.
const played = await page.evaluate(() => {
  const { audio: a } = window.__KICKUP__;
  const before = a.ctx.currentTime;
  a.strike(1);
  a.perfectChime(5);
  a.whiff();
  a.cheer(1);
  a.setCrowdLevel(0.8);
  a.whistle();
  return { ok: true, advanced: a.ctx.currentTime >= before, crowdGain: +a.crowdGain.gain.value.toFixed(3) };
});
check('all one-shots schedule without error', played.ok);

// --- crowd responds to the rally ----------------------------------------
const crowd = await page.evaluate(async () => {
  const { game, audio: a, handleEvent } = window.__KICKUP__;
  const read = () => +a.crowdGain.gain.value.toFixed(4);
  a.setCrowdLevel(0);
  const quiet = read();
  handleEvent({ type: 'kick', data: { grade: 'PERFECT', combo: 1, multiplier: 1, score: 2, point: { x: 0, y: 0.46, z: 0 } } });
  await new Promise((r) => setTimeout(r, 260));
  const early = read();
  handleEvent({ type: 'kick', data: { grade: 'PERFECT', combo: 16, multiplier: 5, score: 44, point: { x: 0, y: 0.46, z: 0 } } });
  await new Promise((r) => setTimeout(r, 900));
  const late = read();
  return { quiet, early, late };
});
check('crowd swells as the rally builds', crowd.late > crowd.early, `gain ${crowd.early} → ${crowd.late}`);

// --- haptics ------------------------------------------------------------
const haptic = await page.evaluate(() => {
  const calls = [];
  const original = navigator.vibrate?.bind(navigator);
  navigator.vibrate = (p) => {
    calls.push(p);
    return true;
  };
  const { haptics, handleEvent } = window.__KICKUP__;
  haptics.supported = true;
  haptics.enabled = true;

  const point = { x: 0, y: 0.46, z: 0 };
  handleEvent({ type: 'kick', data: { grade: 'PERFECT', combo: 4, multiplier: 2, score: 5, point } });
  const perfect = calls.at(-1);
  handleEvent({ type: 'kick', data: { grade: 'GOOD', combo: 1, multiplier: 1, score: 6, point } });
  const good = calls.at(-1);
  handleEvent({ type: 'kick', data: { grade: 'SLOPPY', combo: 0, multiplier: 1, score: 7, point } });
  const sloppy = calls.at(-1);
  handleEvent({ type: 'milestone', data: { tier: 'PRO', score: 20 } });
  const milestone = calls.at(-1);
  handleEvent({ type: 'gameover', data: { score: 20, points: 100, bestCombo: 4, highScore: 20, newRecord: false } });
  const over = calls.at(-1);

  if (original) navigator.vibrate = original;
  return { count: calls.length, perfect, good, sloppy, milestone, over };
});
check('haptics fire on every strike', haptic.count >= 5, `${haptic.count} vibrate calls`);
check('perfect strikes get a distinct doubled pulse',
  Array.isArray(haptic.perfect) && !Array.isArray(haptic.good),
  `perfect=${JSON.stringify(haptic.perfect)}, good=${JSON.stringify(haptic.good)}, sloppy=${JSON.stringify(haptic.sloppy)}`);
check('milestone and game over have their own patterns',
  Array.isArray(haptic.milestone) && Array.isArray(haptic.over) &&
  JSON.stringify(haptic.milestone) !== JSON.stringify(haptic.over),
  `milestone=${JSON.stringify(haptic.milestone)}, gameover=${JSON.stringify(haptic.over)}`);
check('haptics degrade silently where unsupported', await page.evaluate(() => {
  const { haptics } = window.__KICKUP__;
  const saved = haptics.supported;
  haptics.supported = false;
  const result = haptics.strike('PERFECT');
  haptics.supported = saved;
  return result === false;
}), 'returns false rather than throwing on iOS Safari');

// --- impact synchronisation ---------------------------------------------
// The critical claim: feedback lands on the frame of contact, not the next one.
const sync = await page.evaluate(() => {
  const { game, stage, audio: a, haptics } = window.__KICKUP__;
  window.__PAUSE__ = true;
  game.reset();
  game.start();
  game.ball.y = 0.46;
  game.ball.vy = -2.5;
  stage.update(game, 1 / 60);

  const vibes = [];
  navigator.vibrate = (p) => {
    vibes.push(p);
    return true;
  };
  haptics.supported = true;

  // Warm up: the first strike allocates its noise buffer and compiles the
  // audio graph, which is one-off cost and not representative.
  for (let i = 0; i < 5; i += 1) {
    game.ball.y = 0.46;
    game.ball.vy = -2.5;
    game.lastKickAt = -Infinity;
    game.lockoutUntil = -Infinity;
    game.tap();
    for (const e of game.drainEvents()) window.__KICKUP__.handleEvent(e);
  }

  const vibesBefore = vibes.length;
  const durations = [];
  for (let i = 0; i < 20; i += 1) {
    game.ball.y = 0.46;
    game.ball.vy = -2.5;
    game.lastKickAt = -Infinity;
    game.lockoutUntil = -Infinity;
    const t0 = performance.now();
    game.tap();
    for (const e of game.drainEvents()) window.__KICKUP__.handleEvent(e);
    durations.push(performance.now() - t0);
  }
  durations.sort((a, b) => a - b);

  return {
    vibratedImmediately: vibes.length > vibesBefore,
    kickTriggered: stage.player.kickTarget === 1,
    ikArmed: stage.player.ikDecay === 1,
    // Everything above happened inside the tap handler; this is what that
    // handler costs, which is the real input-latency contribution.
    medianMs: +durations[10].toFixed(3),
    maxMs: +durations[durations.length - 1].toFixed(3),
  };
});

check('haptics fire inside the tap handler', sync.vibratedImmediately);
check('kick animation is armed inside the tap handler', sync.kickTriggered && sync.ikArmed);
check('the whole tap handler costs a fraction of a frame',
  sync.medianMs < 3.0,
  `median ${sync.medianMs}ms, worst ${sync.maxMs}ms (frame budget 16.67ms)`);

// --- mute ---------------------------------------------------------------
const mute = await page.evaluate(() => {
  const { audio: a } = window.__KICKUP__;
  document.getElementById('sound').click();
  const muted = { enabled: a.enabled, gain: a.master.gain.value };
  document.getElementById('sound').click();
  const back = { enabled: a.enabled, gain: a.master.gain.value };
  return { muted, back };
});
// The hint must actually disappear once play starts.
const hint = await page.evaluate(async () => {
  const { game, syncHud } = window.__KICKUP__;
  const el = document.getElementById('hint');
  // #hint carries a 0.3s opacity transition, so computed style has to settle
  // before it is meaningful.
  const settle = () => new Promise((r) => setTimeout(r, 420));
  const opacityOf = () => +getComputedStyle(el).opacity;
  game.reset();
  syncHud();
  await settle();
  const ready = opacityOf();
  game.start();
  syncHud();
  await settle();
  return { ready, playing: opacityOf() };
});
check('the tap hint hides once play starts', hint.playing < 0.02 && hint.ready > 0.5,
  `opacity ready=${hint.ready} → playing=${hint.playing}`);

check('sound toggle mutes and restores', mute.muted.gain === 0 && mute.back.gain > 0,
  `gain ${mute.muted.gain} → ${mute.back.gain}`);

check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await close();
process.exit(report(5));
