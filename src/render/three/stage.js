import * as THREE from 'three';
import { createBall } from './ball.js';
import { createPlayer } from './player.js';
import { buildStadium } from './stadium.js';
import { PostChain, detectQuality } from './post.js';
import { ImpactFX, CameraShake } from './effects.js';
import { makeTurfTexture, loadMaterialMaps } from './textures.js';
import { SWEET_SPOT_Y, PLAYER_REACH } from '../../core/constants.js';

/** The ball plays in front of the player so the boot can reach it. */
export const BALL_FORWARD = 0.24;

/** Group x of the character when playerX is 0 (the ball keeps the centre of frame). */
const PLAYER_BASE_X = -0.30;
const AIM_POINTS = 14;

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
    this.#buildEnvironment();
    this.#buildGround();

    this.ball = createBall();
    this.scene.add(this.ball.mesh);

    this.player = createPlayer();
    // Stand the player back and to the side; the ball keeps the centre frame.
    this.player.group.position.set(PLAYER_BASE_X, 0, -0.10);
    this._lean = 0;
    this._follow = 0;
    this._prevPlayerX = 0;
    this._aimBuf = new Float32Array(AIM_POINTS * 3);
    this.#buildGuides();
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
    // A floodlit pitch is a huge lit green reflector, so the fill from below is
    // strong; at the old 0.26 anything facing down (the underside of the jaw)
    // went to black and read as a chinstrap beard.
    const hemi = new THREE.HemisphereLight(0x9bb8ff, 0x56704a, 0.34);
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
        light.shadow.radius = 3.5;
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

  /**
   * Image-based lighting, built from a stand-in for the stadium itself: a dark
   * sky, four bright floodlight banks, lit stands and a green floor. Direct
   * lights alone leave anything turned away from all four of them at the
   * mercy of one flat hemisphere term, which is why shadowed skin went to a
   * dead black. A prefiltered environment gives every surface a plausible
   * answer for "what is over there", and gives skin and boots something to
   * reflect. Rendered once at load into a small cube map.
   */
  #buildEnvironment() {
    const env = new THREE.Scene();
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(40, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x0b1226, side: THREE.BackSide }),
    );
    env.add(sky);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 24), new THREE.MeshBasicMaterial({ color: 0x2f6a34 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.2;
    env.add(floor);
    // Stands: a lit band right round the horizon.
    const stands = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 30, 9, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x3a4258, side: THREE.BackSide }),
    );
    stands.position.y = 4;
    env.add(stands);
    for (const light of this.floods) {
      const bank = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 5),
        new THREE.MeshBasicMaterial({ color: light.color.clone().multiplyScalar(5.5 * light.intensity), side: THREE.DoubleSide }),
      );
      bank.position.copy(light.position).multiplyScalar(2.6);
      bank.lookAt(0, 1, 0);
      env.add(bank);
    }
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(env, 0.04, 0.1, 100).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    env.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }

  #buildGround() {
    const turf = makeTurfTexture(1024, 10);
    turf.repeat.set(16, 16);
    const geo = new THREE.PlaneGeometry(96, 96);
    // Blade grain authored in MaterialCraft, tiled far finer than the stripes.
    const maps = loadMaterialMaps();
    for (const t of [maps.turfNormal, maps.turfRoughness]) t.repeat.set(220, 220);
    const mat = new THREE.MeshStandardMaterial({
      map: turf,
      normalMap: maps.turfNormal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughnessMap: maps.turfRoughness,
      roughness: 1.0,
      metalness: 0.0,
    });
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

  /**
   * Aim preview, landing marker and reach ring. Pure presentation: they read the game and
   * never feed anything back. Pre-allocated so nothing is created per frame.
   */
  #buildGuides() {
    const aimGeo = new THREE.BufferGeometry();
    aimGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AIM_POINTS * 3), 3));
    aimGeo.setDrawRange(0, 0);
    this.aimLine = new THREE.Line(aimGeo, new THREE.LineDashedMaterial({
      color: 0xffffff, transparent: true, opacity: 0, dashSize: 0.07, gapSize: 0.05, depthWrite: false,
    }));
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);

    const ringMat = (color) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
    });
    this.landingRing = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.17, 32), ringMat(0xffe27a));
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.position.y = 0.025;
    this.scene.add(this.landingRing);

    this.reachRing = new THREE.Mesh(new THREE.RingGeometry(PLAYER_REACH - 0.025, PLAYER_REACH, 48), ringMat(0x7cf0ff));
    this.reachRing.rotation.x = -Math.PI / 2;
    this.reachRing.position.y = 0.02;
    this.scene.add(this.reachRing);
    this._aim = null;
    this._aimAlpha = 1;
  }

  /** Show (or with null hide) the aim preview. `alpha` fades it out as difficulty rises. */
  setAim(aim, alpha = 1) {
    this._aim = aim;
    this._aimAlpha = alpha;
  }

  #updateGuides(game, dt) {
    const b = game.ball;
    const live = game.state === 'PLAYING';
    const kickable = live && b.y <= 1.15 && Math.abs(b.x - game.playerX) <= PLAYER_REACH;

    this.reachRing.visible = game.state !== 'GAME_OVER';
    this.reachRing.position.x = game.playerX;
    this.reachRing.position.z = BALL_FORWARD;
    this.reachRing.material.opacity = kickable ? 0.85 : 0.22;
    this.reachRing.material.color.setHex(kickable ? 0x7cffb0 : 0x7cf0ff);

    this.landingRing.visible = live && b.vy !== 0;
    if (this.landingRing.visible) {
      this.landingRing.position.x = game.predictContactX(0.11);
      this.landingRing.position.z = b.z + BALL_FORWARD;
      // Shrinks as the ball gets low, so it reads as "arriving".
      const k = THREE.MathUtils.clamp(b.y / 2.4, 0.5, 1.4);
      this.landingRing.scale.setScalar(k);
    }

    const showAim = this._aim && live && this._aimAlpha > 0.02;
    if (showAim) {
      const n = game.previewPath(this._aim, this._aimBuf, AIM_POINTS);
      const attr = this.aimLine.geometry.getAttribute('position');
      attr.array.set(this._aimBuf.subarray(0, n * 3));
      for (let i = 0; i < n; i += 1) attr.array[i * 3 + 2] += BALL_FORWARD;
      attr.needsUpdate = true;
      this.aimLine.geometry.setDrawRange(0, n);
      this.aimLine.computeLineDistances();
      this.aimLine.material.opacity = 0.75 * this._aimAlpha;
    } else {
      this.aimLine.material.opacity = 0;
      this.aimLine.geometry.setDrawRange(0, 0);
    }

    // The character shuffles under the ball and leans into the run.
    this.player.group.position.x = PLAYER_BASE_X + game.playerX;
    const vel = dt > 0 ? (game.playerX - this._prevPlayerX) / dt : 0;
    this._prevPlayerX = game.playerX;
    this._lean += (THREE.MathUtils.clamp(-vel * 0.05, -0.16, 0.16) - this._lean) * Math.min(1, dt * 10);
    this.player.group.rotation.z = this._lean;
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
    // A juggler never takes their eyes off the ball.
    this._ballWorld.set(b.x, b.y, b.z + BALL_FORWARD);
    this.player.lookAt(this._ballWorld, playing ? 1 : 0.25);

    this.#updateGuides(game, dt);
    this.player.update(dt);

    this.elapsed += dt;
    this.stadium.update(this.elapsed);
    this.gravity = game.tuning.gravity;
    this.fx.update(dt, this.gravity);

    // The camera slides after the character (about half as far, so the pitch still reads as
    // a place) — the play area is wider than a portrait phone can show at this zoom.
    // Shake is layered on top as an offset, so it always decays back to the framing.
    const followTarget = game.playerX * 0.65;
    this._follow += (followTarget - this._follow) * Math.min(1, dt * 6);
    this._camPos.copy(this.cameraBase);
    this._camPos.x += this._follow;
    this._lookAt.copy(this.cameraTarget);
    this._lookAt.x += this._follow;
    if (this.shake.update(dt)) {
      this._camPos.add(this.shake.offset);
      this._lookAt.addScaledVector(this.shake.offset, 0.35);
      this.camera.position.copy(this._camPos);
      this.camera.lookAt(this._lookAt);
      this.camera.rotateZ(this.shake.roll);
    } else {
      this.camera.position.copy(this._camPos);
      this.camera.lookAt(this._lookAt);
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
