import * as THREE from 'three';
import { createBall } from './ball.js';
import { createPlayer } from './player.js';
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
  constructor(canvas) {
    this.canvas = canvas;

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
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1524);
    this.scene.fog = new THREE.Fog(0x0a1524, 12, 46);

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

    this._contact = new THREE.Vector3();
    this.resize();
  }

  #buildLights() {
    // Cool ambient bounce off the sky, warm bounce off the turf.
    const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x2a4a2c, 0.55);
    this.scene.add(hemi);
    this.hemi = hemi;

    // Key: the near-side floodlight bank, casting the shadow you actually read.
    const key = new THREE.DirectionalLight(0xfff3e0, 3.1);
    key.position.set(3.4, 6.2, 3.0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -1;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.scene.add(key.target);
    key.target.position.set(0, 0.7, 0);
    this.key = key;

    // Rim: the far bank, separating the player from the dark stands.
    const rim = new THREE.DirectionalLight(0xbcd8ff, 1.7);
    rim.position.set(-4.2, 3.6, -4.0);
    this.scene.add(rim);
    this.rim = rim;

    // Fill: soft, low, keeps the shadowed side from going black on a phone.
    const fill = new THREE.DirectionalLight(0xffd9b0, 0.5);
    fill.position.set(-2.0, 1.4, 3.6);
    this.scene.add(fill);
    this.fill = fill;
  }

  #buildGround() {
    const turf = makeTurfTexture(1024, 10);
    turf.repeat.set(14, 14);
    const geo = new THREE.PlaneGeometry(90, 90);
    const mat = new THREE.MeshStandardMaterial({ map: turf, roughness: 0.94, metalness: 0.0 });
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
    this.width = w;
    this.height = h;
  }

  /** World-space point the boot should meet, for a given ball body. */
  contactPoint(body, out = this._contact) {
    return out.set(body.x, Math.max(0.14, body.y), body.z + BALL_FORWARD);
  }

  onKick(contact) {
    this.player.triggerKick(
      this.contactPoint(contact.point),
      contact.grade === 'PERFECT' ? 1.15 : 1,
    );
  }

  onGameOver() {
    this.player.triggerStumble();
  }

  onRestart() {
    this.player.reset();
    this.ball.reset();
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
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Debug/gate helper: where the sweet spot sits in world space. */
  get sweetSpot() {
    return new THREE.Vector3(0, SWEET_SPOT_Y, BALL_FORWARD);
  }
}
