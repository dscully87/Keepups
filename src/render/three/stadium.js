import * as THREE from 'three';
import { makeCrowdTexture, makeAdBoardTexture, makeSpriteTexture } from './textures.js';

/**
 * The arena: sky dome, marked pitch, two raked tiers of crowd, perimeter
 * advertising and four floodlight pylons. All of it is low-poly and static —
 * the fidelity comes from the lighting rig and the post chain, not from
 * geometry density, which is what keeps this affordable on a phone.
 */

const PITCH_RADIUS = 24;
// The lower tier has to reach above the top of a portrait frame (~15° of
// elevation from the camera), otherwise the gap between tiers shows through as
// a black bar across the top of the screen.
const LOWER = { r0: PITCH_RADIUS + 1.5, r1: PITCH_RADIUS + 11, y0: 1.4, y1: 12.5 };
const UPPER = { r0: PITCH_RADIUS + 12.5, r1: PITCH_RADIUS + 23, y0: 13.0, y1: 27 };
const PYLON_RADIUS = PITCH_RADIUS + 26;
const PYLON_HEIGHT = 34;

export function buildStadium(scene) {
  const group = new THREE.Group();
  const disposables = [];

  const sky = buildSky();
  group.add(sky);

  const markings = buildPitchMarkings();
  group.add(markings);

  const crowd = makeCrowdTexture(512);
  const lower = buildTier(LOWER, crowd, 26, 5);
  const upper = buildTier(UPPER, crowd, 34, 7);
  group.add(lower, upper);

  const roof = buildRoof();
  group.add(roof);

  const boards = buildAdBoards();
  group.add(boards.mesh);
  disposables.push(boards.texture);

  const { pylons, lamps } = buildFloodlights();
  group.add(pylons);

  scene.add(group);

  return {
    group,
    lamps,
    crowdTexture: crowd,
    /** Slow crowd shimmer, so the stands are never a dead still image. */
    update(elapsed) {
      crowd.offset.y = Math.sin(elapsed * 0.35) * 0.0016;
      crowd.offset.x = Math.sin(elapsed * 0.21 + 1.7) * 0.0022;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Night sky: a vertical gradient with a warm sodium glow at the horizon. */
function buildSky() {
  const geo = new THREE.SphereGeometry(160, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x0a1122) },
      midColor: { value: new THREE.Color(0x18263f) },
      horizonColor: { value: new THREE.Color(0x3a4a63) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 horizonColor;
      varying vec3 vWorld;
      void main() {
        float h = clamp(normalize(vWorld).y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(horizonColor, midColor, smoothstep(0.45, 0.62, h));
        c = mix(c, topColor, smoothstep(0.6, 0.95, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** Centre circle, halfway line and a penalty arc, sitting just above the turf. */
function buildPitchMarkings() {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });

  const circle = new THREE.Mesh(new THREE.RingGeometry(9.06, 9.18, 96), paint);
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(0, 0.012, -11);
  group.add(circle);

  const line = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), paint);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.011, z);
    return m;
  };
  group.add(line(46, 0.12, 0, -11)); // halfway line
  group.add(line(0.12, 26, -16, 2)); // touchline off to the side
  group.add(line(30, 0.12, 0, 9)); // edge of the box, in front of camera

  // Penalty spot near where the player is standing.
  const spot = new THREE.Mesh(new THREE.CircleGeometry(0.11, 20), paint);
  spot.rotation.x = -Math.PI / 2;
  spot.position.set(-2.4, 0.012, 1.1);
  group.add(spot);

  for (const m of group.children) m.receiveShadow = false;
  return group;
}

/** One raked tier of seating, textured with packed crowd. */
function buildTier({ r0, r1, y0, y1 }, crowdTexture, repeatX, repeatY) {
  const tex = crowdTexture.clone();
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);

  const geo = new THREE.CylinderGeometry(r1, r0, y1 - y0, 72, 1, true);
  // The stands sit 25m+ away, far outside any light this rig aims at the
  // pitch. Real stadium seating is lit by its own concourse lighting, so the
  // crowd carries its own emission rather than depending on the pitch floods —
  // otherwise the whole bowl renders as a black void behind the player.
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 0.62,
    side: THREE.BackSide, // we are inside the bowl
    roughness: 0.95,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = (y0 + y1) / 2;
  return mesh;
}

function buildRoof() {
  const geo = new THREE.CylinderGeometry(UPPER.r1 + 6, UPPER.r1, 2.5, 72, 1, true);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x222c3d,
    emissive: 0x0e141f,
    emissiveIntensity: 1.0,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = UPPER.y1 + 3.4;
  return mesh;
}

/** Perimeter LED boards — the strongest single "this is a broadcast" cue. */
function buildAdBoards() {
  const texture = makeAdBoardTexture(1024);
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.set(6, 1);
  const geo = new THREE.CylinderGeometry(PITCH_RADIUS, PITCH_RADIUS, 1.05, 72, 1, true);
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0.85,
    side: THREE.BackSide,
    roughness: 0.5,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.53;
  return { mesh, texture };
}

/**
 * Four corner pylons. The emissive lamp heads are what the bloom pass picks
 * up, so the floodlights read as light sources rather than white rectangles.
 */
function buildFloodlights() {
  const group = new THREE.Group();
  const lamps = [];

  const mastMat = new THREE.MeshStandardMaterial({ color: 0x121721, roughness: 0.75, metalness: 0.5 });
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xfff6e2,
    emissive: 0xfff2d8,
    emissiveIntensity: 6.0,
    roughness: 0.3,
  });
  const glowTex = makeSpriteTexture(128, 0.22);

  for (let i = 0; i < 4; i += 1) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    const x = Math.cos(angle) * PYLON_RADIUS;
    const z = Math.sin(angle) * PYLON_RADIUS;

    const mast = new THREE.Mesh(new THREE.BoxGeometry(1.1, PYLON_HEIGHT, 1.1), mastMat);
    mast.position.set(x, PYLON_HEIGHT / 2, z);
    group.add(mast);

    const head = new THREE.Mesh(new THREE.BoxGeometry(7.5, 4.2, 0.7), lampMat);
    head.position.set(x, PYLON_HEIGHT + 1.6, z);
    head.lookAt(0, 0, 0);
    group.add(head);
    lamps.push(head);

    // Soft halo so the bloom has something to bleed from.
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xfff0d0,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    glow.position.copy(head.position);
    glow.scale.set(18, 12, 1);
    group.add(glow);
  }

  return { pylons: group, lamps };
}

export { PITCH_RADIUS };
