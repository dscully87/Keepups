import * as THREE from 'three';
import { createBall } from './ball.js';
import { createPlayer } from './player.js';
import { buildStadium } from './stadium.js';
import { PostChain, detectQuality } from './post.js';
import { ImpactFX, CameraShake } from './effects.js';
import { makeTurfTexture } from './textures.js';
import { SWEET_SPOT_Y } from '../../core/constants.js';

/** The ball plays in front of the player so the boot can reach it. */
export const BALL_FORWARD = 0.24;

/** Ball heights over which the boot ramps from "idle" to "shadowing the ball". */
const TRACK_START = 1.45;
const TRACK_FULL = 0.62;

/**
 * The 3D stage: scene graph, camera framing, lighting and the per-frame bridge
 * between the headless simulation and what you see. Phase 4 layers the stadium
 * and post-processing on top of this without touching the game core.
 */
export class Stage {
  constructor(canvas, { quality = detectQuality() } = {}) {
    this.canvas = canvas;
    this.elapsed = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.90;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    // The sky dome supplies the background; fog only softens the far stands.
    this.scene.fog = new THREE.Fog(0x0e1626, 18, 78);

    // Broadcast three-quarter view: off the shoulder, near head height, so the
    // player never occludes the ball and the strike reads in profile.
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.cameraTarget = new THREE.Vector3(-0.02, 0.92, 0.10);
    this.cameraBase = new THREE.Vector3(1.25, 1.34, 3.75);

    this.#buildLights();
    this.#buildGround();

    this.ball = createBall();
    this.scene.add(this.ball.mesh);

    this.player = createPlayer();
    // Stand the player back and to the side; the ball keeps the centre frame.
    this.player.group.position.set(-0.30, 0, -0.10);
    this.player.group.rotation.y = 0.34;
    this.scene.add(this.player.group);

    this.stadium = buildStadium(this.scene);
    this.fx = new ImpactFX(this.scene);
    this.shake = new CameraShake();

    this.quality = quality;
    this.post = new PostChain(this.renderer, this.scene, this.camera, quality);

    this._contact = new THREE.Vector3();
    this._ballWorld = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this.gravity = 9.81;
    this.resize();
  }

  /**
   * Broadcast rig. A real stadium is lit from four corner pylons, which is why
   * players on TV throw several soft shadows in different directions rather
   * than one hard sun shadow. One bank casts the shadow map (four shadowed
   * lights would be four extra depth passes); the rest are shadowless.
   */
  #buildLights() {
    // Sky bounce is cool, turf bounce is green — grounds the figure.
    const hemi = new THREE.HemisphereLight(0x8fb4ff, 0x24421f, 0.26);
    this.scene.add(hemi);
    this.hemi = hemi;

    const CORNERS = [
      { pos: [5.2, 8.4, 4.6], colour: 0xfff4e2, intensity: 1.90, shadow: true },
      { pos: [-5.6, 8.0, 4.2], colour: 0xf2f6ff, intensity: 0.72, shadow: false },
      { pos: [-4.8, 7.6, -5.4], colour: 0xdfe9ff, intensity: 1.05, shadow: false },
      { pos: [5.0, 7.8, -5.0], colour: 0xfff1dc, intensity: 0.62, shadow: false },
    ];

    this.floods = CORNERS.map(({ pos, colour, intensity, shadow }) => {
      const light = new THREE.DirectionalLight(colour, intensity);
      light.position.set(...pos);
      light.target.position.set(0, 0.7, 0);
      if (shadow) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.camera.near = 2;
        light.shadow.camera.far = 24;
        light.shadow.camera.left = -3;
        light.shadow.camera.right = 3;
        light.shadow.camera.top = 4;
        light.shadow.camera.bottom = -1;
        light.shadow.bias = -0.0009;
        light.shadow.normalBias = 0.022;
        this.key = light;
      }
      this.scene.add(light, light.target);
      return light;
    });

    // Low warm bounce off the turf, so shadowed sides never crush to black.
    const bounce = new THREE.DirectionalLight(0xffdcae, 0.16);
    bounce.position.set(-1.2, 0.4, 3.2);
    bounce.target.position.set(0, 0.9, 0);
    this.scene.add(bounce, bounce.target);
    this.bounce = bounce;
  }

  #buildGround() {
    const turf = makeTurfTexture(1024, 10);
    turf.repeat.set(16, 16);
    const geo = new THREE.PlaneGeometry(96, 96);
    const mat = new THREE.MeshStandardMaterial({ map: turf, roughness: 0.92, metalness: 0.0 });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;
  }

  /** Portrait phones need a wider vertical field than a desktop window. */
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const aspect = w / h;
    this.camera.aspect = aspect;
    // Frame the full action column — turf to ball apex — at any aspect ratio.
    const targetVertical = 2.95;
    const distance = this.cameraBase.distanceTo(this.cameraTarget);
    const fov = 2 * Math.atan(targetVertical / 2 / distance) * (180 / Math.PI);
    this.camera.fov = THREE.MathUtils.clamp(fov, 34, 62);
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h);
    this.width = w;
    this.height = h;
  }

  /** World-space point the boot should meet, for a given ball body. */
  contactPoint(body, out = this._contact) {
    return out.set(body.x, Math.max(0.14, body.y), body.z + BALL_FORWARD);
  }

  onKick(contact) {
    const point = this.contactPoint(contact.point);
    this.player.triggerKick(point, contact.grade === 'PERFECT' ? 1.15 : 1);

    // Crunch: the harder and cleaner the strike, the more it throws and shakes.
    const strength = contact.grade === 'PERFECT' ? 1 : contact.grade === 'GOOD' ? 0.66 : 0.4;
    this.fx.burst(point, strength);
    this.shake.add(0.20 + strength * 0.30);
  }

  onGameOver() {
    this.player.triggerStumble();
    this.shake.add(0.55);
  }

  onRestart() {
    this.player.reset();
    this.ball.reset();
    this.fx.clear();
    this.shake.reset();
  }

  update(game, dt) {
    this.ball.sync(game.ball, BALL_FORWARD, dt);

    // Shadow the ball with the boot while it falls into reach. This is what a
    // juggler actually does, and it means a tap never has to teleport the leg.
    const b = game.ball;
    const playing = game.state === 'PLAYING' || game.state === 'READY';
    let reach = 0;
    if (playing && b.vy < 0) {
      reach = THREE.MathUtils.clamp((TRACK_START - b.y) / (TRACK_START - TRACK_FULL), 0, 1);
      reach = reach * reach * (3 - 2 * reach); // smoothstep
    }
    this.player.setTrack(this.contactPoint(b), reach * this.player.MAX_TRACK);

    this.player.update(dt);

    this.elapsed += dt;
    this.stadium.update(this.elapsed);
    this.gravity = game.tuning.gravity;
    this.fx.update(dt, this.gravity);

    // Camera shake is applied as an offset from the fixed rig position, so it
    // always decays back to exactly the framing we designed.
    if (this.shake.update(dt)) {
      this._camPos.copy(this.cameraBase).add(this.shake.offset);
      this._lookAt.copy(this.cameraTarget).addScaledVector(this.shake.offset, 0.35);
      this.camera.position.copy(this._camPos);
      this.camera.lookAt(this._lookAt);
      this.camera.rotateZ(this.shake.roll);
    } else if (!this.camera.position.equals(this.cameraBase)) {
      this.camera.position.copy(this.cameraBase);
      this.camera.lookAt(this.cameraTarget);
    }

    // Rack focus onto the ball so it is never the thing that goes soft.
    this._ballWorld.set(b.x, b.y, b.z + BALL_FORWARD);
    this.post.focusOn(this.camera.position.distanceTo(this._ballWorld));
  }

  render(dt = 1 / 60) {
    this.post.render(dt);
  }

  /**
   * Runtime quality change from the frame-rate governor. Shadows are the other
   * big GPU cost, so they go with the lowest tier.
   */
  setQuality(quality) {
    if (quality === this.quality) return false;
    this.quality = quality;
    this.post.setQuality(quality);
    this.post.setSize(this.width, this.height);
    const shadows = quality !== 'low';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      this.scene.traverse((o) => {
        if (o.isMesh && o.material) o.material.needsUpdate = true;
      });
    }
    return true;
  }

  /** Debug/gate helper: where the sweet spot sits in world space. */
  get sweetSpot() {
    return new THREE.Vector3(0, SWEET_SPOT_Y, BALL_FORWARD);
  }
}
