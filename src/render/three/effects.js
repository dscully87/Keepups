import * as THREE from 'three';
import { makeSpriteTexture } from './textures.js';

/**
 * Impact effects. Everything here is pooled and pre-allocated: a burst that
 * allocates is a burst that causes a GC hitch, and a hitch on the frame of
 * contact is exactly the frame the player is judging you on.
 */

const MAX_PARTICLES = 220;

export class ImpactFX {
  constructor(scene) {
    this.scene = scene;
    this.count = MAX_PARTICLES;
    this.alive = 0;

    // Flat arrays rather than objects: no per-particle allocation, and the
    // update loop stays cache-friendly.
    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.pz = new Float32Array(this.count);
    this.vx = new Float32Array(this.count);
    this.vy = new Float32Array(this.count);
    this.vz = new Float32Array(this.count);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);
    this.size0 = new Float32Array(this.count);

    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.count * 3);
    this.sizes = new Float32Array(this.count);
    this.alphas = new Float32Array(this.count);
    this.colors = new Float32Array(this.count * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geometry.setDrawRange(0, 0);
    // Particles live near the ball; skip the per-frame bounds recompute.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 6);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uMap: { value: makeSpriteTexture(64, 0.45) },
        uScale: { value: 520 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          if (t.a * vAlpha < 0.01) discard;
          gl_FragColor = vec4(vColor, t.a * vAlpha);
        }
      `,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    this.geometry = geometry;
    this.material = material;
    this._colour = new THREE.Color();
  }

  /**
   * Grass and dust kicked up by the strike. Stronger contact throws more.
   * @param {{x:number,y:number,z:number}} at world-space contact point
   * @param {number} strength 0..1
   */
  burst(at, strength = 1) {
    const n = Math.round(14 + strength * 22);
    for (let i = 0; i < n && this.alive < this.count; i += 1) {
      const idx = this.alive;
      this.alive += 1;

      // Cone of debris thrown up and away from the boot.
      const angle = Math.random() * Math.PI * 2;
      const spread = 0.35 + Math.random() * 0.9;
      const up = 1.2 + Math.random() * 2.6 * strength;

      this.px[idx] = at.x + (Math.random() - 0.5) * 0.09;
      this.py[idx] = at.y + (Math.random() - 0.5) * 0.09;
      this.pz[idx] = at.z + (Math.random() - 0.5) * 0.09;
      this.vx[idx] = Math.cos(angle) * spread * (0.6 + strength);
      this.vy[idx] = up;
      this.vz[idx] = Math.sin(angle) * spread * (0.6 + strength);

      this.maxLife[idx] = 0.34 + Math.random() * 0.42;
      this.life[idx] = this.maxLife[idx];
      this.size0[idx] = 0.012 + Math.random() * 0.026;

      // Mostly torn grass, some pale dust.
      const grass = Math.random() > 0.28;
      const c = idx * 3;
      if (grass) {
        this.colors[c] = 0.20 + Math.random() * 0.16;
        this.colors[c + 1] = 0.44 + Math.random() * 0.26;
        this.colors[c + 2] = 0.16 + Math.random() * 0.12;
      } else {
        const g = 0.62 + Math.random() * 0.24;
        this.colors[c] = g;
        this.colors[c + 1] = g * 0.96;
        this.colors[c + 2] = g * 0.86;
      }
    }
  }

  update(dt, gravity = 9.81) {
    let i = 0;
    while (i < this.alive) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove keeps the live range contiguous, so the draw call only
        // ever covers particles that are actually alive.
        this.#swap(i, this.alive - 1);
        this.alive -= 1;
        continue;
      }

      this.vy[i] -= gravity * 0.55 * dt;
      const drag = Math.max(0, 1 - 2.1 * dt);
      this.vx[i] *= drag;
      this.vz[i] *= drag;

      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      if (this.py[i] < 0.004) {
        this.py[i] = 0.004;
        this.vy[i] = 0;
        this.vx[i] *= 0.55;
        this.vz[i] *= 0.55;
      }

      const t = this.life[i] / this.maxLife[i];
      const p = i * 3;
      this.positions[p] = this.px[i];
      this.positions[p + 1] = this.py[i];
      this.positions[p + 2] = this.pz[i];
      this.sizes[i] = this.size0[i] * (0.55 + t * 0.65);
      this.alphas[i] = t < 0.35 ? t / 0.35 : 1;
      i += 1;
    }

    this.geometry.setDrawRange(0, this.alive);
    if (this.alive > 0) {
      const pos = this.geometry.getAttribute('position');
      pos.updateRanges = [{ start: 0, count: this.alive * 3 }];
      pos.needsUpdate = true;
      for (const name of ['aSize', 'aAlpha', 'aColor']) {
        const attr = this.geometry.getAttribute(name);
        attr.needsUpdate = true;
      }
    }
  }

  #swap(a, b) {
    if (a === b) return;
    for (const arr of [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.life, this.maxLife, this.size0, this.sizes, this.alphas]) {
      const t = arr[a];
      arr[a] = arr[b];
      arr[b] = t;
    }
    for (let k = 0; k < 3; k += 1) {
      const t = this.colors[a * 3 + k];
      this.colors[a * 3 + k] = this.colors[b * 3 + k];
      this.colors[b * 3 + k] = t;
    }
  }

  clear() {
    this.alive = 0;
    this.geometry.setDrawRange(0, 0);
  }
}

/**
 * Camera shake. A decaying sum of two out-of-phase sine pairs, which reads as
 * a physical knock rather than random jitter — random shake looks like noise,
 * a damped oscillation looks like an impact.
 */
export class CameraShake {
  constructor() {
    this.trauma = 0;
    this.time = 0;
    this.offset = new THREE.Vector3();
    this.roll = 0;
  }

  /** @param {number} amount 0..1 */
  add(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.time += dt;
    if (this.trauma <= 0) {
      this.offset.set(0, 0, 0);
      this.roll = 0;
      return false;
    }
    // Trauma decays fast; shake amplitude is trauma squared so small knocks
    // stay subtle and big ones still land.
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const s = this.trauma * this.trauma;
    const t = this.time;
    this.offset.set(
      (Math.sin(t * 63.0) * 0.6 + Math.sin(t * 41.3) * 0.4) * 0.030 * s,
      (Math.sin(t * 71.7) * 0.6 + Math.sin(t * 49.1) * 0.4) * 0.026 * s,
      Math.sin(t * 55.9) * 0.013 * s,
    );
    this.roll = Math.sin(t * 38.0) * 0.012 * s;
    return true;
  }

  reset() {
    this.trauma = 0;
    this.offset.set(0, 0, 0);
    this.roll = 0;
  }
}
