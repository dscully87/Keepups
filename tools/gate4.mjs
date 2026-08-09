/**
 * Phase 4 quality gate — environment and lighting.
 *  - a built stadium, not an isolated figure on a void
 *  - a multi-source broadcast rig with specular response on the ball
 *  - post chain: depth of field, bloom, colour grade
 *  - the delivered image has broadcast dynamic range: no crushed blacks
 *    filling the frame, no blown highlights
 */
import { openGame, check, report } from './harness.mjs';

const { page, errors, close } = await openGame({ quality: 'high' });
console.log('PHASE 4 GATE — ENVIRONMENT & LIGHTING');

// --- the arena exists ---------------------------------------------------
const env = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  let emissiveMeshes = 0;
  let sprites = 0;
  let meshes = 0;
  const shaderMats = [];
  stage.scene.traverse((o) => {
    if (o.isSprite) sprites += 1;
    if (o.isMesh) {
      meshes += 1;
      const m = o.material;
      if (m?.isShaderMaterial) shaderMats.push(o.name || 'shader');
      if (m && m.emissive && m.emissiveIntensity > 0 && (m.emissive.r + m.emissive.g + m.emissive.b) > 0) {
        emissiveMeshes += 1;
      }
    }
  });
  return {
    meshes,
    emissiveMeshes,
    sprites,
    hasSky: shaderMats.length > 0,
    stadiumChildren: stage.stadium.group.children.length,
    lamps: stage.stadium.lamps.length,
    fog: !!stage.scene.fog,
    fogFar: stage.scene.fog?.far,
  };
});
check('a stadium is built around the pitch', env.stadiumChildren >= 6, `${env.stadiumChildren} stadium groups, ${env.meshes} meshes in scene`);
check('sky dome present', env.hasSky);
check('four floodlight banks present', env.lamps === 4, `${env.lamps} lamp heads`);
check('emissive surfaces exist for bloom to catch', env.emissiveMeshes >= 4, `${env.emissiveMeshes} emissive meshes, ${env.sprites} glow sprites`);
check('atmospheric fog enabled', env.fog, `far plane ${env.fogFar}m`);

// --- lighting rig -------------------------------------------------------
const lights = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  const dir = [];
  let hemi = 0;
  let shadowCasters = 0;
  stage.scene.traverse((o) => {
    if (o.isDirectionalLight) {
      dir.push(+o.intensity.toFixed(2));
      if (o.castShadow) shadowCasters += 1;
    }
    if (o.isHemisphereLight) hemi += o.intensity;
  });
  const m = stage.ball.material;
  return {
    dir,
    hemi: +hemi.toFixed(2),
    shadowCasters,
    total: +dir.reduce((a, b) => a + b, 0).toFixed(2),
    clearcoat: m.clearcoat,
    roughnessMap: !!m.roughnessMap,
    exposure: stage.renderer.toneMappingExposure,
  };
});
check('multi-source rig, not a single sun', lights.dir.length >= 4, `${lights.dir.length} directional lights: ${lights.dir.join(', ')}`);
check('exactly one shadow-casting bank', lights.shadowCasters === 1, `${lights.shadowCasters} casters (extra casters cost a depth pass each)`);
check('ambient bounce present', lights.hemi > 0.1, `hemisphere ${lights.hemi}`);
check('ball has a specular clear coat over a roughness map', lights.clearcoat > 0.2 && lights.roughnessMap, `clearcoat ${lights.clearcoat}`);

// --- post chain ---------------------------------------------------------
const post = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  const p = stage.post;
  return {
    quality: stage.quality,
    passes: p.composer.passes.map((x) => x.constructor.name),
    hasBokeh: !!p.bokeh,
    hasBloom: !!p.bloom,
    hasGrade: !!p.grade,
    bloomThreshold: p.bloom?.threshold,
    grade: p.grade
      ? {
          contrast: p.grade.uniforms.contrast.value,
          saturation: p.grade.uniforms.saturation.value,
          vignette: p.grade.uniforms.vignette.value,
        }
      : null,
  };
});
check('depth of field enabled at high quality', post.hasBokeh, post.passes.join(' → '));
check('grade runs after tone mapping, not on linear HDR',
  post.passes.indexOf('OutputPass') < post.passes.lastIndexOf('ShaderPass'),
  post.passes.join(' → '));
check('bloom enabled and thresholded to light sources', post.hasBloom && post.bloomThreshold > 0.5, `threshold ${post.bloomThreshold}`);
check('colour grade applied', post.hasGrade, post.grade ? `contrast ${post.grade.contrast}, sat ${post.grade.saturation}, vignette ${post.grade.vignette}` : '');

// --- focus tracks the ball ----------------------------------------------
const focus = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  game.reset();
  game.start();
  const samples = [];
  for (const y of [0.2, 0.9, 1.6]) {
    game.ball.y = y;
    stage.update(game, 1 / 60);
    const d = stage.camera.position.distanceTo(
      new (stage.camera.position.constructor)(game.ball.x, game.ball.y, game.ball.z + 0.24),
    );
    samples.push({ y, focus: +stage.post.bokeh.uniforms.focus.value.toFixed(3), actual: +d.toFixed(3) });
  }
  return samples;
});
const focusOk = focus.every((s) => Math.abs(s.focus - s.actual) < 0.01);
check('focal plane is racked onto the ball every frame', focusOk,
  focus.map((s) => `y=${s.y}→${s.focus}m`).join(', '));

// --- the delivered image ------------------------------------------------
const image = await page.evaluate(() => {
  const { game, stage } = window.__KICKUP__;
  game.reset();
  game.start();
  game.ball.y = 0.6;
  for (let i = 0; i < 3; i += 1) {
    stage.update(game, 1 / 60);
    stage.render(1 / 60);
  }
  const gl = stage.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  const lum = [];
  for (let i = 0; i < buf.length; i += 4) {
    lum.push(0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]);
  }
  lum.sort((a, b) => a - b);
  const pct = (p) => Math.round(lum[Math.floor(lum.length * p)]);

  // readPixels is bottom-up: rows near the end of the buffer are the top of
  // the screen. Sample that strip to catch a black bar across the top.
  const stripRows = Math.floor(h * 0.12);
  let stripSum = 0;
  let stripCount = 0;
  for (let y = h - stripRows; y < h; y += 2) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      stripSum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      stripCount += 1;
    }
  }

  const clipped = lum.filter((v) => v >= 254).length / lum.length;
  const crushed = lum.filter((v) => v <= 2).length / lum.length;
  const unique = new Set();
  for (let i = 0; i < buf.length; i += 4 * 419) unique.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);

  return {
    p01: pct(0.01),
    p50: pct(0.5),
    p99: pct(0.99),
    clipped: +(clipped * 100).toFixed(2),
    crushed: +(crushed * 100).toFixed(2),
    topStrip: Math.round(stripSum / stripCount),
    unique: unique.size,
  };
});
check('image has broadcast dynamic range', image.p99 - image.p01 > 110, `luma p1=${image.p01} p50=${image.p50} p99=${image.p99}`);
check('midtones are exposed, not blown', image.p50 > 18 && image.p50 < 165, `median luma ${image.p50}`);
check('highlights are not clipped across the frame', image.clipped < 6, `${image.clipped}% of pixels at 255`);
check('shadows are not crushed across the frame', image.crushed < 12, `${image.crushed}% of pixels at 0`);
check('top of frame is filled stadium, not a black bar', image.topStrip > 10, `mean luma ${image.topStrip} in the top 12%`);
check('scene is richly detailed', image.unique > 200, `${image.unique} distinct sampled colours`);

// --- quality tiers degrade sensibly -------------------------------------
const tiers = await page.evaluate(async () => {
  const { QUALITY } = await import('/src/render/three/post.js');
  return QUALITY;
});
check('low tier drops both dof and bloom', !tiers.low.dof && !tiers.low.bloom);
check('medium tier keeps bloom but drops dof', tiers.medium.bloom && !tiers.medium.dof);
check('every tier keeps the colour grade', tiers.low.grade && tiers.medium.grade && tiers.high.grade);

// --- budget -------------------------------------------------------------
const info = await page.evaluate(() => {
  const { stage } = window.__KICKUP__;
  // The composer issues several renderer.render() calls per frame and
  // three resets info on each one, so autoReset has to be off or we would
  // only ever measure the final fullscreen-quad pass.
  stage.renderer.info.autoReset = false;
  stage.renderer.info.reset();
  stage.render(1 / 60);
  const i = stage.renderer.info.render;
  stage.renderer.info.autoReset = true;
  return { calls: i.calls, triangles: i.triangles };
});
check('draw calls still in a mobile budget with the stadium', info.calls <= 90, `${info.calls} draw calls`);
check('triangles still in a mobile budget with the stadium', info.triangles <= 260000, `${info.triangles} triangles`);
check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await close();
process.exit(report(4));
