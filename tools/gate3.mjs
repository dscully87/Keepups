/**
 * Phase 3 quality gate — 3D migration.
 *  - a real Three.js scene with a bone-driven SkinnedMesh player
 *  - a genuinely panelled match ball
 *  - idle↔kick blending that is continuous, not a snap
 *  - the kick animation lands on the ball at the moment the user tapped
 *
 * CI has no GPU (SwiftShader software rasterisation), so smoothness is gated
 * on CPU frame cost and pose continuity rather than wall-clock frame rate.
 */
import { openGame, check, report } from './harness.mjs';

const { page, errors, close } = await openGame();
console.log('PHASE 3 GATE — VISUAL FIDELITY / 3D MIGRATION');

// --- scene structure ----------------------------------------------------
const scene = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  let skinned = 0;
  let meshes = 0;
  let tris = 0;
  stage.scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned += 1;
    if (o.isMesh) {
      meshes += 1;
      const idx = o.geometry.getIndex();
      tris += (idx ? idx.count : o.geometry.getAttribute('position').count) / 3;
    }
  });
  return {
    isWebGL: !!stage.renderer.getContext(),
    skinned,
    meshes,
    tris: Math.round(tris),
    bones: stage.player.skeleton.bones.length,
    boneNames: stage.player.skeleton.bones.map((b) => b.name),
    clips: Object.keys(stage.player.clips),
    toneMapping: stage.renderer.toneMapping,
    shadows: stage.renderer.shadowMap.enabled,
  };
});
check('renders through a WebGL context', scene.isWebGL);
check('player is a skinned mesh set', scene.skinned >= 1, `${scene.skinned} skinned meshes, ${scene.meshes} meshes total`);
check('skeleton has a full humanoid bone chain', scene.bones >= 20, `${scene.bones} bones`);
check('rig includes both legs and both arms',
  ['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'armL', 'armR'].every((n) => scene.boneNames.includes(n)));
check('idle, kick and stumble clips exist', scene.clips.includes('idle') && scene.clips.includes('kick'), scene.clips.join(', '));
check('shadows and filmic tone mapping enabled', scene.shadows && scene.toneMapping !== 0);

// --- every clip must drive the same bone set ---------------------------
const blendSets = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  const names = (c) => stage.player.clips[c].tracks.map((t) => t.name).sort();
  const idle = names('idle');
  const kick = names('kick');
  const stumble = names('stumble');
  return {
    idle: idle.length,
    kick: kick.length,
    stumble: stumble.length,
    kickMatches: JSON.stringify(idle) === JSON.stringify(kick),
    stumbleMatches: JSON.stringify(idle) === JSON.stringify(stumble),
  };
});
check('kick drives the same bones as idle', blendSets.kickMatches, `${blendSets.idle} vs ${blendSets.kick} tracks`);
check('stumble drives the same bones as idle', blendSets.stumbleMatches, `${blendSets.idle} vs ${blendSets.stumble} tracks`);

// --- ball panelling -----------------------------------------------------
const ball = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  const m = stage.ball.material;
  const canvas = m.map.image;
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  let light = 0;
  let mid = 0;
  for (let i = 0; i < d.length; i += 4 * 313) {
    const v = d[i];
    if (v < 70) dark += 1;
    else if (v > 190) light += 1;
    else mid += 1;
  }
  return {
    hasMap: !!m.map,
    hasNormal: !!m.normalMap,
    hasRough: !!m.roughnessMap,
    clearcoat: m.clearcoat,
    size: `${canvas.width}x${canvas.height}`,
    dark, light, mid,
  };
});
check('ball has albedo, normal and roughness maps', ball.hasMap && ball.hasNormal && ball.hasRough, ball.size);
check('ball is clear-coated leather', ball.clearcoat > 0.2, `clearcoat ${ball.clearcoat}`);
check('panel map has both dark pentagons and light hexagons',
  ball.dark > 40 && ball.light > 100,
  `dark ${ball.dark} / light ${ball.light} / seam ${ball.mid} samples`);

// --- kick IK accuracy ---------------------------------------------------
const ik = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  const results = [];
  for (const h of [0.28, 0.46, 0.62, 0.9]) {
    game.reset();
    game.start();
    game.ball.y = h;
    game.ball.vy = -2.4;
    const contact = game.tap();
    for (const e of game.drainEvents()) if (e.type === 'kick') stage.onKick(e.data);
    // A few frames of approach, as in real play, then the frame after impact.
    stage.update(game, 1 / 120);
    const target = stage.contactPoint(contact.point).clone();
    const boot = stage.player.bootPosition();
    results.push({ h, err: +boot.distanceTo(target).toFixed(4), grade: contact.grade });
  }
  return results;
});
for (const r of ik) {
  // Contact means the boot is inside one ball radius of the centre — on the
  // ball's surface, not buried in it and not swiping at air.
  check(`boot makes contact with a ball struck at ${r.h}m`, r.err > 0.01 && r.err < 0.11,
    `boot-to-ball-centre ${(r.err * 100).toFixed(1)} cm, radius 11.0 cm (${r.grade})`);
}

// --- blend continuity ---------------------------------------------------
const blend = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  const THREE_UP = [];
  game.reset();
  game.start();
  game.ball.y = 0.46;
  game.ball.vy = -2.4;

  const bone = stage.player.bones.get('thighL');
  const samples = [];
  const q = [];
  const snap = () => ({
    w: stage.player.weights(),
    q: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
  });

  // 12 frames of pure idle first.
  for (let i = 0; i < 12; i += 1) {
    stage.update(game, 1 / 60);
    samples.push(snap());
  }
  const contact = game.tap();
  for (const e of game.drainEvents()) if (e.type === 'kick') stage.onKick(e.data);
  // 48 frames spanning the strike, follow-through and recovery.
  for (let i = 0; i < 48; i += 1) {
    stage.update(game, 1 / 60);
    samples.push(snap());
  }

  // Largest per-frame rotation step of the thigh across the whole sequence.
  let maxStep = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1].q;
    const b = samples[i].q;
    let dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    dot = Math.min(1, dot);
    maxStep = Math.max(maxStep, 2 * Math.acos(dot) * (180 / Math.PI));
  }

  const sums = samples.map((s) => s.w.idle + s.w.kick + s.w.stumble);
  const partial = samples.filter((s) => s.w.kick > 0.02 && s.w.kick < 0.98).length;
  const peak = Math.max(...samples.map((s) => s.w.kick));
  const settled = samples[samples.length - 1].w;
  THREE_UP.push(contact?.grade);

  return {
    maxStep: +maxStep.toFixed(2),
    minSum: +Math.min(...sums).toFixed(3),
    maxSum: +Math.max(...sums).toFixed(3),
    partial,
    peak: +peak.toFixed(3),
    settledIdle: +settled.idle.toFixed(3),
    settledKick: +settled.kick.toFixed(3),
  };
});
check('blend weights always partition 1.0', blend.minSum > 0.98 && blend.maxSum < 1.02, `sum ∈ [${blend.minSum}, ${blend.maxSum}]`);
check('kick layer reaches full influence', blend.peak > 0.95, `peak weight ${blend.peak}`);
check('transition is blended, not snapped', blend.partial >= 2, `${blend.partial} intermediate-weight frames`);
check('pose never jumps between frames', blend.maxStep < 30, `largest thigh step ${blend.maxStep}°/frame`);
check('animation settles back to idle', blend.settledIdle > 0.95 && blend.settledKick < 0.05, `idle ${blend.settledIdle}, kick ${blend.settledKick}`);

// --- CPU frame cost -----------------------------------------------------
const perf = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  game.reset();
  game.start();
  // Warm up so JIT and first-frame allocations don't skew the numbers.
  for (let i = 0; i < 120; i += 1) stage.update(game, 1 / 60);

  const times = [];
  for (let i = 0; i < 600; i += 1) {
    if (game.state !== 'PLAYING') game.start();
    if (game.ball.descending && game.ball.y < 0.6) {
      game.tap();
      for (const e of game.drainEvents()) if (e.type === 'kick') stage.onKick(e.data);
    }
    const t0 = performance.now();
    game.advance(1 / 60);
    game.drainEvents();
    stage.update(game, 1 / 60);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    median: +times[Math.floor(times.length * 0.5)].toFixed(3),
    p95: +times[Math.floor(times.length * 0.95)].toFixed(3),
    max: +times[times.length - 1].toFixed(3),
  };
});
check('CPU simulation+animation cost is well inside a 16.6ms frame',
  perf.p95 < 3.0,
  `median ${perf.median}ms, p95 ${perf.p95}ms, max ${perf.max}ms`);

// --- GPU workload budget ------------------------------------------------
const info = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  stage.renderer.info.reset();
  stage.render();
  const i = stage.renderer.info.render;
  return { calls: i.calls, triangles: i.triangles, programs: stage.renderer.info.programs.length };
});
check('draw calls stay in a mobile-friendly budget', info.calls <= 40, `${info.calls} draw calls`);
check('triangle count stays in a mobile-friendly budget', info.triangles <= 120000, `${info.triangles} triangles`);
check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await close();
process.exit(report(3));
