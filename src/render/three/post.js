import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Broadcast grade: a filmic contrast curve, a warm/cool split between
 * highlights and shadows, saturation, vignette and a very light grain.
 *
 * This pass MUST run after OutputPass. Its contrast pivots around 0.5, which
 * is mid grey only in display-referred (tone-mapped, sRGB-encoded) colour. Run
 * on linear HDR instead and every shadow value pivots below zero and clamps to
 * solid black — which is exactly what happened when it sat before OutputPass.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    exposure: { value: 1.0 },
    contrast: { value: 1.17 },
    saturation: { value: 1.02 },
    warmHighlights: { value: new THREE.Vector3(1.035, 1.005, 0.955) },
    coolShadows: { value: new THREE.Vector3(0.955, 0.985, 1.06) },
    vignette: { value: 0.52 },
    grain: { value: 0.022 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float exposure;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 warmHighlights;
    uniform vec3 coolShadows;
    uniform float vignette;
    uniform float grain;
    uniform float time;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb * exposure;

      // Contrast about mid grey.
      c = (c - 0.5) * contrast + 0.5;

      // Split tone: warm the highlights, cool the shadows.
      float l = clamp(luma(c), 0.0, 1.0);
      c *= mix(coolShadows, warmHighlights, smoothstep(0.25, 0.8, l));

      // Saturation.
      c = mix(vec3(luma(c)), c, saturation);

      // Vignette — subtle, centred on the action.
      vec2 d = vUv - 0.5;
      float v = 1.0 - vignette * dot(d, d) * 2.2;
      c *= clamp(v, 0.0, 1.0);

      // Fine grain keeps flat gradients from banding on cheap panels.
      float n = hash(vUv * 1024.0 + fract(time) * 91.7) - 0.5;
      c += n * grain;

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
    }
  `,
};

/**
 * Quality tiers. Depth of field costs a full extra scene pass, so it is the
 * first thing dropped; the grade is cheap enough to always keep.
 */
export const QUALITY = {
  high: { bloom: true, dof: true, grade: true, bloomStrength: 0.42, resolutionScale: 1.0 },
  medium: { bloom: true, dof: false, grade: true, bloomStrength: 0.36, resolutionScale: 1.0 },
  low: { bloom: false, dof: false, grade: true, bloomStrength: 0, resolutionScale: 0.85 },
};

/**
 * Picks a tier from what the device tells us about itself. Phase 6 replaces
 * this opening guess with a measured, adaptive one.
 */
export function detectQuality() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const dpr = window.devicePixelRatio || 1;
  const pixels = window.innerWidth * window.innerHeight * Math.min(dpr, 2) ** 2;

  if (cores <= 4 || mem <= 3 || pixels > 3.2e6) return 'medium';
  if (cores <= 2 || mem <= 2) return 'low';
  return 'high';
}

export class PostChain {
  constructor(renderer, scene, camera, quality = 'high') {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.settings = QUALITY[quality] || QUALITY.medium;
    this.elapsed = 0;
    this.#build();
  }

  #build() {
    const size = this.renderer.getSize(new THREE.Vector2());
    const s = this.settings;

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio() * s.resolutionScale);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    if (s.dof) {
      // Shallow-ish: the ball and player stay sharp, the stands melt.
      this.bokeh = new BokehPass(this.scene, this.camera, {
        focus: 3.6,
        aperture: 0.00058,
        maxblur: 0.011,
      });
      this.composer.addPass(this.bokeh);
    }

    if (s.bloom) {
      this.bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        s.bloomStrength,
        0.62, // radius
        0.86, // threshold — only floodlights and specular hits bloom
      );
      this.composer.addPass(this.bloom);
    }

    // Tone map and encode to sRGB *before* grading — see the note on
    // GradeShader. Bloom, by contrast, belongs above on linear HDR.
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    if (s.grade) {
      this.grade = new ShaderPass(GradeShader);
      this.composer.addPass(this.grade);
    }
  }

  /** Keep the focal plane on the ball so it never drifts out of focus. */
  focusOn(distance) {
    if (this.bokeh) this.bokeh.uniforms.focus.value = distance;
  }

  setSize(width, height) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio() * this.settings.resolutionScale);
    this.composer.setSize(width, height);
    if (this.bloom) this.bloom.setSize(width, height);
  }

  render(dt) {
    this.elapsed += dt;
    if (this.grade) this.grade.uniforms.time.value = this.elapsed;
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose?.();
  }
}
