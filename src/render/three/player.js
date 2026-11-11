import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BALL_RADIUS } from '../../core/constants.js';
import { makeFaceTexture, makeKitTextures, loadMaterialMaps } from './textures.js';
import { latheField, capsuleField, roundBoxField, meshFields } from './sdf.js';

/**
 * Procedurally built footballer: a single SkinnedMesh over an authored
 * skeleton, driven by hand-authored AnimationClips through an AnimationMixer,
 * with analytic two-bone IK layered on top so the boot meets the ball at the
 * exact height the player struck it.
 *
 * Naming note: `L` is +x and `R` is -x — viewer-relative, not anatomical.
 * The kicking leg is `legL` so the swing reads on the right of the screen.
 */

// Bind-pose skeleton, expressed as local offsets from each parent.
const RIG = [
  ['hips', null, [0, 0.94, 0]],
  ['spine', 'hips', [0, 0.14, 0]],
  ['chest', 'spine', [0, 0.20, 0]],
  ['neck', 'chest', [0, 0.17, 0]],
  ['head', 'neck', [0, 0.11, 0]],

  // Arms bind *down*, not in a T-pose. A bind pose close to the rest pose
  // keeps every animated rotation small and predictable: elbow flexion is
  // simply a negative rotation about local X for both arms.
  // The clavicle carries the shoulder out to ±0.20 so the deltoid caps land a
  // full head-width clear of the neck — that width is most of the V-taper.
  ['clavL', 'chest', [0.058, 0.090, 0]],
  ['armL', 'clavL', [0.142, -0.016, 0]],
  ['foreL', 'armL', [0.035, -0.255, 0]],
  ['handL', 'foreL', [0.012, -0.235, 0]],

  ['clavR', 'chest', [-0.058, 0.090, 0]],
  ['armR', 'clavR', [-0.142, -0.016, 0]],
  ['foreR', 'armR', [-0.035, -0.255, 0]],
  ['handR', 'foreR', [-0.012, -0.235, 0]],

  ['thighL', 'hips', [0.11, -0.06, 0]],
  ['shinL', 'thighL', [0, -0.42, 0]],
  ['footL', 'shinL', [0, -0.40, 0]],
  ['toeL', 'footL', [0, -0.042, 0.145]],

  ['thighR', 'hips', [-0.11, -0.06, 0]],
  ['shinR', 'thighR', [0, -0.42, 0]],
  ['footR', 'shinR', [0, -0.40, 0]],
  ['toeR', 'footR', [0, -0.042, 0.145]],
];

export const THIGH_LENGTH = 0.42;
export const SHIN_LENGTH = 0.40;
/** Ankle → toe, i.e. how far the boot extends past the joint the IK solves for. */
export const FOOT_LENGTH = Math.hypot(0.042, 0.145);

/** One value for every bare-skin surface; the face map is painted to match it. */
const SKIN_COLOUR = 0xb08054;

const MATERIAL_INDEX = { skin: 0, shirt: 1, shorts: 2, socks: 3, boots: 4, hair: 5, face: 6 };

/**
 * Limbs are lathes, not cylinders.
 *
 * `rings` is an authored radius profile: `[t, rx, rz, dz]`, where `t` is a
 * fraction of the bone span (it may run negative or past 1 — that is how a
 * deltoid caps over the top of the shoulder and a sock runs on into the boot),
 * `rx`/`rz` are the half-axes of an elliptical cross-section and `dz` slides
 * the ring sideways. The profile is interpolated with a shape-preserving
 * (monotone) spline, so a control point is a *bulge*, never an overshoot: that
 * is what buys the bicep, the calf and the quad sweep. Skin weights are still
 * measured along the whole bone span, so slices of one limb deform together.
 *
 * The local frame is: +y along the bone, +z the component of `hint` (world +z
 * unless stated) perpendicular to it, +x their cross product. `rx` is applied
 * symmetrically so its sign never matters; `dz` and `rz` follow `hint`.
 *
 * Every piece starts *inside* the volume it grows out of and swells outward.
 * That is the whole trick behind losing the scalloped seams: no shape ever
 * punches through its neighbour, it emerges from it.
 */
const LIMB_RADIAL = 26;
const THIN_RADIAL = 22;

const LIMBS = [
  // --- torso.
  //
  // Two things stop this reading as a torso-shaped pipe. The section is a
  // *superellipse*, not an ellipse (`mod.power` below): a chest has a flat
  // frontal plane with the mass carried out to the lats, and a plain ellipse
  // lathed through a maximum domes that plane into two soft breasts. And the
  // ring centres carry a `dz` spine curve — lumbar hollow at the waist, the
  // thoracic mass swung back behind it — so the profile is an S from the side
  // rather than a plank. Front line (dz+rz) is held near-constant from the
  // waist to the collarbone: that is the flat sternum. Back line (dz−rz) does
  // all the moving.
  //
  // The torso is one continuous lathe over the whole spine, not a stack of
  // per-bone slices. Slices leave two problems: the flat caps where they abut
  // draw a hard line across the chest, and the skin weights restart at every
  // boundary, so the mesh creases there whenever the spine bends. Ring t is in
  // metres above the first bone in the chain.
  //
  // Round 4: this lathe is now the *ribcage*, not the whole upper body. It
  // used to run out to the full shoulder width, which buried half of each
  // upper arm inside the chest and left the deltoids as plates bolted to the
  // corners of a box. A ribcage is ~32 cm across; the shoulders are carried
  // beyond it by the yoke and the deltoid, and the smooth union in sdf.js
  // fillets the three together, armpit included.
  { chain: ['hips', 'spine', 'chest', 'neck'], mat: 'shirt', sdf: { k: 0.030, cap: ['flat', 'flat'] }, mod: { power: 0.87 }, rings: [
    [-0.058, 0.171, 0.131, 0.000], // hem, draped over the top of the hips
    [-0.028, 0.166, 0.127, 0.002],
    [-0.007, 0.156, 0.118, 0.004],
    [0.021, 0.148, 0.112, 0.006],
    [0.084, 0.141, 0.107, 0.009],
    [0.140, 0.139, 0.104, 0.010], // waist — narrowest, and the lumbar hollow
    [0.190, 0.144, 0.106, 0.009],
    [0.244, 0.153, 0.111, 0.005],
    [0.296, 0.161, 0.118, 0.000],
    [0.340, 0.166, 0.123, -0.005], // lats
    [0.374, 0.166, 0.125, -0.008], // chest at its deepest; the sternum stays put
    [0.411, 0.158, 0.121, -0.010],
    [0.445, 0.140, 0.113, -0.011],
    [0.473, 0.112, 0.100, -0.010], // trapezius sloping into the neck
    [0.493, 0.086, 0.085, -0.008],
    [0.510, 0.073, 0.073, -0.006], // collar
  ] },
  // The neck is not a dowel between two spheres. It leaves the collar wide,
  // narrows at the middle, then *flares back out* under the jaw and carries
  // backwards (dz) — because the head sits forward of the spine, and the gap
  // that opens behind the jaw is what reads as a jawline from three-quarter.
  { chain: ['chest', 'neck', 'head'], mat: 'skin', radial: THIN_RADIAL, rings: [
    [0.140, 0.064, 0.068, -0.004],
    [0.168, 0.060, 0.064, -0.005],
    [0.196, 0.058, 0.062, -0.007],
    [0.224, 0.059, 0.062, -0.009],
    [0.248, 0.064, 0.064, -0.012],
    [0.268, 0.069, 0.061, -0.012],
    // The neck has to run on *inside* the skull. Scooping the mass out from
    // under the back of the head leaves the nape open to the sky, and a lathe
    // that stops there presents its flat end cap face-up to four floodlights —
    // which renders as a bright cream band ringing the whole hairline.
    [0.290, 0.063, 0.055, -0.016],
    [0.306, 0.047, 0.043, -0.018],
  ] },
  // Crew collar: the shirt has to end *somewhere*, and a rolled band reads as
  // a neckline where a bare lathe edge reads as a hole.
  // It carries the same superellipse and the same backward set as the torso
  // collar it grows out of, so the two stay concentric instead of the shirt
  // shouldering its way through the band at the diagonals.
  { chain: ['chest', 'neck', 'head'], mat: 'shirt', radial: THIN_RADIAL, mod: { power: 0.87 }, swatch: [0.25, 0.008], rings: [
    [0.148, 0.072, 0.076, -0.007],
    [0.160, 0.081, 0.084, -0.007],
    [0.174, 0.079, 0.082, -0.006],
    [0.188, 0.065, 0.069, -0.005], // rolls back in, so the top cap is a thin lip
  ] },

  // --- shoulder yoke. Its axis runs almost straight out along x, so here the
  // local frame puts `rx` vertical and `rz` front-to-back: a shoulder is much
  // deeper than it is tall.
  { a: 'clavL', b: 'armL', mat: 'shirt', sdf: { k: 0.034, cap: ['round', 'round'] }, rings: [
    [-0.20, 0.052, 0.082, -0.008],
    [0.00, 0.054, 0.088, -0.008],
    [0.45, 0.052, 0.084, -0.007],
    [0.80, 0.047, 0.070, -0.004],
    [1.00, 0.042, 0.058, -0.002],
  ] },

  // --- deltoid cap and sleeve. The profile domes over the top of the shoulder
  // (negative t) so no separate sphere is needed to close the joint.
  { a: 'armL', b: 'foreL', mat: 'shirt', sdf: { k: 0.030, cap: ['round', 'flat'] }, rings: [
    [-0.21, 0.010],
    [-0.18, 0.030],
    [-0.13, 0.046],
    [-0.06, 0.056],
    [0.02, 0.061],
    [0.12, 0.0635], // deltoid crown
    [0.22, 0.0630],
    [0.32, 0.0615],
    [0.40, 0.0610],
    [0.46, 0.0615], // sleeve hem
  ] },
  { a: 'armL', b: 'foreL', mat: 'skin', radial: LIMB_RADIAL, rings: [
    [0.36, 0.052],
    [0.50, 0.0555],
    [0.60, 0.0550], // bicep belly
    [0.72, 0.0510],
    [0.86, 0.0470],
    [1.00, 0.0450], // elbow
  ] },
  { a: 'foreL', b: 'handL', mat: 'skin', radial: LIMB_RADIAL, rings: [
    [-0.08, 0.044],
    [0.00, 0.047],
    [0.10, 0.051], // flexor mass, high on the forearm
    [0.22, 0.049],
    [0.42, 0.042],
    [0.65, 0.035],
    [0.85, 0.030],
    [1.00, 0.029, 0.026], // wrist: flatter than it is wide
    [1.06, 0.027, 0.023],
  ] },

  // --- shorts. One wide pelvic block, widest at the greater trochanter, with
  // the leg tubes emerging out of it rather than butting into its side.
  // The whole block is set back (`dz`) below the waistband, so the seat is the
  // furthest-back point of the body and the glute reads as pelvis rather than
  // as a lobe stuck onto the back of a tube. Above the hem it comes forward
  // again to sit inside the shirt's lumbar hollow.
  { a: 'hips', b: 'spine', mat: 'shorts', sdf: { k: 0.030, cap: ['round', 'round'] }, rings: [
    [-1.30, 0.014, 0.013, 0.000],
    [-1.22, 0.062, 0.054, -0.004],
    [-1.10, 0.128, 0.104, -0.010],
    [-0.97, 0.172, 0.124, -0.014],
    [-0.83, 0.191, 0.132, -0.016],
    [-0.68, 0.196, 0.135, -0.015], // hips at their widest, seat at its fullest
    [-0.57, 0.194, 0.133, -0.012],
    [-0.45, 0.185, 0.128, -0.008],
    [-0.33, 0.167, 0.121, -0.004], // from here up it hides under the shirt hem
    [-0.20, 0.155, 0.114, 0.000],
    [-0.05, 0.145, 0.110, 0.004],
    [0.12, 0.138, 0.104, 0.008],
    [0.20, 0.104, 0.080, 0.009],
    [0.24, 0.044, 0.036, 0.010],
  ] },
  // The top of the shorts leg is held partly on the *pelvis* (`root`), not
  // wholly on the thigh. Weight it all to the thigh and a raised knee swings
  // the entire seat of the shorts up with it, which balloons into a dark lump
  // over the hip; splitting it lets the leg swing inside a waistband that
  // stays where the hips are.
  { a: 'thighL', b: 'shinL', mat: 'shorts', sdf: { k: 0.026, cap: ['round', 'flat'] },
    root: { bone: 'hips', from: 0.16, to: -0.06, max: 0.66 }, rings: [
    // The top of the leg is far deeper than it is wide and sits back, so it
    // carries the glute down into the thigh instead of leaving it as a lobe
    // hanging off the back of an otherwise round tube.
    [-0.055, 0.048, 0.052],
    [-0.020, 0.064, 0.080, -0.014],
    [0.020, 0.080, 0.104, -0.022],
    [0.070, 0.091, 0.112, -0.024],
    [0.140, 0.097, 0.110, -0.016],
    [0.240, 0.098, 0.102, -0.006],
    [0.340, 0.096, 0.096],
    [0.430, 0.0935],
    [0.470, 0.0940],
    [0.520, 0.0985], // leg opening: loose, but only just clear of the thigh
  ] },
  // Thigh, knee and upper shin as ONE lathe. Two lathes overlapping across the
  // knee cannot be kept nested once the joint bends — the thigh piece hands
  // only half its weight to the shin while the shin piece is fully on it, so
  // they slide through each other and the intersection draws a hard ring right
  // across the knee. One surface with a continuous handoff has nothing to
  // cross. The `handoff` third value is where it becomes fully the shin's.
  { a: 'thighL', b: 'shinL', mat: 'skin', radial: LIMB_RADIAL, handoff: [0.62, 1.00, 1.22], rings: [
    [0.430, 0.0905],
    [0.560, 0.0875],
    [0.700, 0.0835],
    [0.820, 0.0795, 0.0800, 0.002], // vastus medialis, low and inboard
    [0.905, 0.0745, 0.0765, 0.004], // the tuck above the knee
    [0.960, 0.0715, 0.0750, 0.006],
    [1.000, 0.0710, 0.0755, 0.008], // patella, carried forward off the joint
    [1.045, 0.0722, 0.0758, 0.007],
    [1.090, 0.0745, 0.0755, 0.002],
    [1.170, 0.0760, 0.0750, -0.001], // and on down, to finish under the sock
  ] },
  { a: 'shinL', b: 'footL', mat: 'socks', radial: LIMB_RADIAL, rings: [
    [0.11, 0.0700], // starts under the skin of the shin, then swells past it
    [0.16, 0.0790], // rolled sock top
    [0.24, 0.0830, 0.0830, -0.010],
    [0.32, 0.0845, 0.0845, -0.016], // calf, carried backwards
    [0.44, 0.0755, 0.0755, -0.013],
    [0.58, 0.0615, 0.0615, -0.006],
    [0.74, 0.0490, 0.0490, -0.001],
    [0.90, 0.0420],
    [1.00, 0.0405],
    [1.12, 0.0395], // runs on into the boot
  ] },
];

/**
 * The boot is not a limb slice: it is swept along world +z from behind the
 * heel to past the toe, rigid to the ankle, with `dz` (which is *up* here,
 * because the hint is world +y) holding the sole flat while the profile flares
 * across the toe box.
 */
const BOOT_ORIGIN = [0, -0.010, -0.082]; // relative to the ankle
const BOOT_RINGS = [
  // [u along +z, half-width, half-height, height of the ring centre above origin]
  [0.000, 0.012, 0.013, 0.000],
  [0.008, 0.032, 0.034, -0.002],
  [0.024, 0.043, 0.046, -0.002],
  [0.046, 0.049, 0.051, 0.002],
  [0.074, 0.051, 0.053, 0.007], // ankle collar
  [0.106, 0.051, 0.047, 0.001],
  [0.140, 0.055, 0.040, -0.006],
  [0.176, 0.058, 0.034, -0.012], // widest across the toe box
  [0.208, 0.057, 0.030, -0.016],
  [0.236, 0.048, 0.024, -0.021],
  [0.248, 0.031, 0.016, -0.027],
  [0.254, 0.012, 0.008, -0.031],
];

/**
 * joint: [bone, radius, materialKey]
 *
 * Only the joints the limb profiles cannot close on their own, and every
 * radius is strictly smaller than both limbs meeting there — a cap that pokes
 * through its neighbours is exactly what produced the old scalloped seams.
 * Shoulders, ankles and the waist need no cap at all now.
 */
const JOINTS = [
  ['foreL', 0.043, 'skin'],
  ['foreR', 0.043, 'skin'],
  ['shinL', 0.068, 'skin'],
  ['shinR', 0.068, 'skin'],
];

/** `L`-suffixed bone names mirrored onto the -x side. */
function mirrorBone(name) {
  return name.endsWith('L') ? `${name.slice(0, -1)}R` : name;
}

export function createPlayer() {
  const bones = new Map();
  const order = [];

  for (const [name, parent, offset] of RIG) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.fromArray(offset);
    if (parent) bones.get(parent).add(bone);
    bones.set(name, bone);
    order.push(bone);
  }

  const root = bones.get('hips');
  root.updateMatrixWorld(true);

  const boneIndex = new Map(order.map((b, i) => [b.name, i]));
  const worldOf = (name) => bones.get(name).getWorldPosition(new THREE.Vector3());

  // --- geometry, authored directly in bind-pose world space --------------
  const pieces = [];
  // Pieces flagged `sdf` are not meshed one by one: they are gathered per kit
  // material and pulled out together as one filleted surface (see sdf.js).
  const fields = { shirt: [], shorts: [] };
  for (const limb of LIMBS) {
    if (limb.sdf && limb.chain) {
      const chain = limb.chain.map(worldOf);
      const idx = limb.chain.map((n) => boneIndex.get(n));
      fields[limb.mat].push(latheField({
        origin: chain[0], axis: UP, hint: FORWARD, rings: limb.rings, unit: 1,
        power: limb.mod?.power, ...limb.sdf, weights: (p) => chainWeights(p, chain, idx),
      }));
      continue;
    }
    if (limb.sdf) {
      for (const side of [(n) => n, mirrorBone]) {
        const a = worldOf(side(limb.a));
        const b = worldOf(side(limb.b));
        if (side === mirrorBone && a.x === worldOf(limb.a).x && b.x === worldOf(limb.b).x) continue;
        const axis = new THREE.Vector3().subVectors(b, a);
        const unit = axis.length();
        axis.normalize();
        const boneA = boneIndex.get(side(limb.a));
        const boneB = boneIndex.get(side(limb.b));
        const root = limb.root && { ...limb.root, index: boneIndex.get(side(limb.root.bone)) };
        fields[limb.mat].push(latheField({
          origin: a, axis, hint: FORWARD, rings: limb.rings, unit, power: limb.mod?.power, ...limb.sdf,
          weights: (p) => limbWeights(p, a, axis, unit, boneA, boneB, limb.handoff, root),
        }));
      }
      continue;
    }
    if (limb.chain) {
      const chain = limb.chain.map(worldOf);
      pieces.push(chainGeometry(
        swatched(tubeGeometry(chain[0], UP, limb.rings, 1, FORWARD, limb.radial, limb.mod), limb.swatch),
        chain,
        limb.chain.map((n) => boneIndex.get(n)),
        MATERIAL_INDEX[limb.mat],
      ));
      continue;
    }
    const sides = limb.a.endsWith('L') || limb.b.endsWith('L')
      ? [(n) => n, mirrorBone]
      : [(n) => n];
    for (const side of sides) {
      const from = side(limb.a);
      const to = side(limb.b);
      pieces.push(
        limbGeometry(
          worldOf(from),
          worldOf(to),
          limb.rings,
          limb.radial,
          limb.hint,
          boneIndex.get(from),
          boneIndex.get(to),
          MATERIAL_INDEX[limb.mat],
          {
            mod: limb.mod,
            handoff: limb.handoff,
            root: limb.root && { ...limb.root, index: boneIndex.get(side(limb.root.bone)) },
          },
        ),
      );
    }
  }

  // Hands and boots are swept along their own axes rather than a bone span:
  // a hand runs on past the wrist, and a boot points forward, not down.
  for (const side of ['L', 'R']) {
    const wrist = worldOf(`hand${side}`);
    const down = wrist.clone().sub(worldOf(`fore${side}`)).normalize();
    const hand = boneIndex.get(`hand${side}`);
    // The swept frame comes out pointing the same way in world space on both
    // arms, so "towards the body" is +x of the frame on one side and −x on the
    // other. Everything asymmetric about a hand — the curl, the thumb — is
    // signed by this rather than mirrored, which keeps the winding intact.
    const frame = frameFor(down, FORWARD);
    const inward = side === 'L' ? 1 : -1;
    pieces.push({
      ...rigidTo(handGeometry(wrist, down, frame.z, frame.x.clone().multiplyScalar(inward)), hand, MATERIAL_INDEX.skin),
      keepNormals: true,
    });

    const ankle = worldOf(`foot${side}`);
    const origin = ankle.clone().add(new THREE.Vector3().fromArray(BOOT_ORIGIN));
    pieces.push(rigidTo(
      tubeGeometry(origin, FORWARD, BOOT_RINGS, 1, UP, LIMB_RADIAL),
      boneIndex.get(`foot${side}`),
      MATERIAL_INDEX.boots,
    ));
  }

  // The shirt and the shorts: one filleted surface each.
  {
    const shirt = meshFields(fields.shirt, { cell: 0.0115, weightBlend: 0.024 });
    projectKitUVs(shirt, SHIRT_UV);
    pieces.push({ geometry: shirt, materialIndex: MATERIAL_INDEX.shirt, keepNormals: true });
    const shorts = meshFields(fields.shorts, { cell: 0.0115, weightBlend: 0.020 });
    projectKitUVs(shorts, SHORTS_UV);
    pieces.push({ geometry: shorts, materialIndex: MATERIAL_INDEX.shorts, keepNormals: true });
  }

  // Head. The skull carries the face texture on its own material; the nose and
  // the ears are plain skin so they merge into the body mesh for free.
  {
    const head = boneIndex.get('head');
    const skull = worldOf('head').add(new THREE.Vector3(0, SKULL_RISE, SKULL_Z));
    pieces.push(headGeometry(skull, head));
    pieces.push(hairGeometry(skull, head));
    pieces.push(noseGeometry(skull, head));
    pieces.push(earGeometry(skull, 1, head));
    pieces.push(earGeometry(skull, -1, head));
  }

  // The few joints the limb profiles cannot close on their own.
  for (const [bone, radius, matKey] of JOINTS) {
    pieces.push(jointGeometry(worldOf(bone), radius, boneIndex.get(bone), MATERIAL_INDEX[matKey]));
  }

  const kit = makeKitTextures();
  const maps = loadMaterialMaps();
  const cloth = (map, extra = {}) => new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map,
    normalMap: maps.jerseyNormal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughnessMap: maps.jerseyRoughness,
    roughness: 1.0,
    metalness: 0.0,
    ...extra,
  });
  const materials = [
    new THREE.MeshStandardMaterial({ color: SKIN_COLOUR, roughness: 0.62, metalness: 0.0 }), // skin
    cloth(kit.shirt), // shirt
    cloth(kit.shorts), // shorts
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: kit.socks,
      normalMap: maps.ribNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: maps.ribRoughness,
      roughness: 1.0,
      metalness: 0.0,
    }), // socks
    // Football boots, not patent loafers: a modern synthetic upper has a
    // broad, low sheen, and at 0.42 roughness these were throwing a hard
    // specular disc that read as polished dress leather.
    new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.62, metalness: 0.0 }), // boots
    new THREE.MeshStandardMaterial({ color: 0x241a14, roughness: 0.90, metalness: 0.0 }), // hair
    // The face map already carries the skin colour, so the tint stays white —
    // otherwise the head and the neck would never match.
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeFaceTexture(1024, hairlinePhi), roughness: 0.62, metalness: 0.0 }), // face
  ];

  // One SkinnedMesh per kit material, all sharing a single skeleton. Cheaper
  // to reason about than multi-material draw groups on a merged buffer, and
  // five draw calls is not a budget concern.
  const group = new THREE.Group();
  const byMaterial = materials.map(() => []);
  for (const { geometry, materialIndex, keepNormals } of pieces) {
    // Lathes get smooth normals from their own triangles. A field-meshed piece
    // already carries the field's gradient, which is better than anything its
    // triangles could vote for.
    if (!keepNormals) geometry.computeVertexNormals();
    byMaterial[materialIndex].push(geometry);
  }

  const meshes = [];
  for (let i = 0; i < byMaterial.length; i += 1) {
    if (!byMaterial[i].length) continue;
    const geometry = mergeGeometries(byMaterial[i].map(withSecondUV), false);
    const mesh = new THREE.SkinnedMesh(geometry, materials[i]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The rig is always on screen; skinned bounds are not worth recomputing.
    mesh.frustumCulled = false;
    meshes.push(mesh);
    group.add(mesh);
  }

  // The bone tree lives under the first mesh; every mesh binds to it.
  meshes[0].add(root);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(order);
  for (const mesh of meshes) mesh.bind(skeleton, new THREE.Matrix4());

  return new PlayerRig(group, meshes, bones, skeleton);
}

/**
 * Owns the mixer, the clips and the IK layer.
 */
export class PlayerRig {
  constructor(group, meshes, bones, skeleton) {
    this.group = group;
    this.meshes = meshes;
    this.mesh = meshes[0];
    this.bones = bones;
    this.skeleton = skeleton;

    // A single mixer drives the shared skeleton; the other meshes follow.
    this.mixer = new THREE.AnimationMixer(meshes[0]);
    const idleClip = buildIdleClip();
    const rest = restPoseFrom(idleClip);
    // Every clip must drive an identical bone set. If one clip omits a bone
    // the other drives, the mixer restores that bone to bind pose as the
    // weights cross — which shows up as limbs snapping into a T-pose.
    this.clips = {
      idle: idleClip,
      kick: completeClip(buildKickClip(), rest),
      stumble: completeClip(buildStumbleClip(), rest),
    };

    this.idle = this.mixer.clipAction(this.clips.idle);
    this.idle.play();

    // The kick clamps on its final frame, which is authored to match the idle
    // rest pose — so fading the layer back out is seamless.
    this.kick = this.mixer.clipAction(this.clips.kick);
    this.kick.setLoop(THREE.LoopOnce, 1);
    this.kick.clampWhenFinished = true;
    this.kick.setEffectiveWeight(0);
    this.kick.play();

    this.stumble = this.mixer.clipAction(this.clips.stumble);
    this.stumble.setLoop(THREE.LoopOnce, 1);
    this.stumble.clampWhenFinished = true;
    this.stumble.setEffectiveWeight(0);
    this.stumble.play();

    // Explicit blend weights beat crossFadeTo here: a strike can interrupt the
    // previous strike's recovery at any point, and this stays predictable.
    this.kickBlend = 0;
    this.kickTarget = 0;
    this.stumbleBlend = 0;
    this.stumbleTarget = 0;
    this.BLEND_IN = 0.035;
    this.BLEND_OUT = 0.16;

    /** Contact point the boot should reach, in world space. */
    this.ikTarget = new THREE.Vector3(0, 0.46, 0.22);
    this.ikWeight = 0;
    this.ikDecay = 0;

    /**
     * Pre-contact tracking. The ball's descent is deterministic, so the boot
     * shadows it on the way down — which is both what a real juggler does and
     * what stops the strike from having to cross 100° of rotation in a single
     * frame the instant the player taps.
     */
    this.trackTarget = new THREE.Vector3(0, 0.46, 0.22);
    this.trackWeight = 0;
    /** How strongly the boot may shadow the ball before contact. */
    this.MAX_TRACK = 0.85;

    this._v = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3() };
    this._q = new THREE.Quaternion();
  }

  /**
   * Fire the kick. The clip's frame 0 *is* the contact pose, so the boot is on
   * the ball on the very next rendered frame — no wind-up latency.
   */
  triggerKick(contactPoint, power = 1) {
    this.ikTarget.copy(contactPoint);
    this.ikWeight = 1;
    this.ikDecay = 1;
    this.kick.reset();
    this.kick.paused = false;
    this.kick.setEffectiveTimeScale(0.85 + power * 0.3);
    this.kick.play();
    this.kickTarget = 1;
  }

  triggerStumble() {
    this.stumble.reset();
    this.stumble.paused = false;
    this.stumble.play();
    this.stumbleTarget = 1;
    this.kickTarget = 0;
  }

  reset() {
    this.stumbleTarget = 0;
    this.stumbleBlend = 0;
    this.kickTarget = 0;
    this.kickBlend = 0;
    this.stumble.reset();
    this.stumble.setEffectiveWeight(0);
    this.kick.reset();
    this.kick.setEffectiveWeight(0);
    this.idle.reset().play();
    this.ikWeight = 0;
    this.ikDecay = 0;
    this.trackWeight = 0;
  }

  update(dt) {
    // Once the kick clip has clamped on its last frame, ease the layer out.
    if (this.kickTarget === 1 && this.kick.time >= this.clips.kick.duration - 1e-4) {
      this.kickTarget = 0;
    }
    this.kickBlend = approach(this.kickBlend, this.kickTarget, dt, this.BLEND_IN, this.BLEND_OUT);
    this.stumbleBlend = approach(this.stumbleBlend, this.stumbleTarget, dt, 0.12, 0.3);

    // Weights always partition 1.0, so the skeleton is never over-driven.
    const stumbleW = this.stumbleBlend;
    const kickW = this.kickBlend * (1 - stumbleW);
    this.stumble.setEffectiveWeight(stumbleW);
    this.kick.setEffectiveWeight(kickW);
    this.idle.setEffectiveWeight(Math.max(0, 1 - kickW - stumbleW));

    this.mixer.update(dt);

    // The strike layer decays over the follow-through so the mixer's authored
    // recovery takes back over; below it, the tracking layer keeps the boot
    // near the falling ball.
    if (this.ikDecay > 0) this.ikDecay = Math.max(0, this.ikDecay - dt / 0.16);
    const strikeW = easeOutCubic(this.ikDecay);
    const trackW = this.trackWeight;

    const solveTarget = strikeW >= trackW ? this.ikTarget : this.trackTarget;
    this.ikWeight = Math.max(strikeW, trackW) * (1 - stumbleW);
    if (this.ikWeight > 0.001) this.#applyLegIK(this.ikWeight, solveTarget);
  }

  /**
   * Point the boot should shadow before any strike, and how strongly.
   * @param {THREE.Vector3} target world-space point
   * @param {number} weight 0 = pure animation, 1 = fully IK-driven
   */
  setTrack(target, weight) {
    this.trackTarget.copy(target);
    this.trackWeight = THREE.MathUtils.clamp(weight, 0, 1);
  }

  /** Current blend weights — surfaced for the animation quality gate. */
  weights() {
    return {
      idle: this.idle.getEffectiveWeight(),
      kick: this.kick.getEffectiveWeight(),
      stumble: this.stumble.getEffectiveWeight(),
      ik: this.ikWeight,
    };
  }

  /**
   * Analytic two-bone IK on the kicking leg, blended over the animated pose.
   * Solved in the hips' local frame; the knee candidate that points further
   * forward (+z) wins, which avoids any hand-tuned sign conventions.
   */
  #applyLegIK(weight, targetWorld) {
    const hips = this.bones.get('hips');
    const thigh = this.bones.get('thighL');
    const shin = this.bones.get('shinL');

    hips.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(hips.matrixWorld).invert();

    const H = this._v.a.copy(thigh.position); // thigh origin in hips space
    const ball = this._v.b.copy(targetWorld).applyMatrix4(toLocal);

    // The chain solves for the *ankle*, but it is the boot that strikes the
    // ball. Pull the ankle target back along the approach line by the length
    // of the foot plus the ball's radius, so the boot lands on the ball's
    // surface instead of burying the ankle in its centre.
    const approach = this._v.c.subVectors(ball, H);
    if (approach.lengthSq() > 1e-8) approach.normalize();
    const T = ball.clone().addScaledVector(approach, -(FOOT_LENGTH + BALL_RADIUS * 0.55));

    const toTarget = this._v.d.subVectors(T, H);
    const maxReach = (THIGH_LENGTH + SHIN_LENGTH) * 0.995;
    const minReach = Math.abs(THIGH_LENGTH - SHIN_LENGTH) + 0.02;
    let d = toTarget.length();
    if (d < 1e-5) return;
    d = Math.min(maxReach, Math.max(minReach, d));
    const u = toTarget.normalize();

    // Interior angle at the hip between the thigh and the hip→target line.
    const cosA = (THIGH_LENGTH * THIGH_LENGTH + d * d - SHIN_LENGTH * SHIN_LENGTH) / (2 * THIGH_LENGTH * d);
    const a = Math.acos(Math.min(1, Math.max(-1, cosA)));

    // Two knee solutions, mirrored about the hip→target line. Take the one
    // whose knee sits further forward — a footballer's knee leads the strike.
    const axis = new THREE.Vector3(1, 0, 0);
    const q1 = new THREE.Quaternion().setFromAxisAngle(axis, a);
    const q2 = new THREE.Quaternion().setFromAxisAngle(axis, -a);
    const k1 = u.clone().applyQuaternion(q1).multiplyScalar(THIGH_LENGTH).add(H);
    const k2 = u.clone().applyQuaternion(q2).multiplyScalar(THIGH_LENGTH).add(H);
    const knee = k1.z >= k2.z ? k1 : k2;

    const DOWN = new THREE.Vector3(0, -1, 0);

    // Thigh: bind-pose down vector rotated onto the hip→knee direction.
    const thighDir = new THREE.Vector3().subVectors(knee, H).normalize();
    const thighQ = new THREE.Quaternion().setFromUnitVectors(DOWN, thighDir);
    thigh.quaternion.slerp(thighQ, weight);

    // Shin: solved in the thigh's frame so it stacks on the thigh rotation.
    const shinDirWorldish = new THREE.Vector3().subVectors(T, knee).normalize();
    const inv = thigh.quaternion.clone().invert();
    const shinLocalDir = shinDirWorldish.applyQuaternion(inv).normalize();
    const shinQ = new THREE.Quaternion().setFromUnitVectors(DOWN, shinLocalDir);
    shin.quaternion.slerp(shinQ, weight);

    thigh.updateMatrixWorld(true);
    this.#pointBootAtBall(weight, targetWorld);
  }

  /**
   * Third link of the chain: rotate the ankle so the boot points at the ball.
   * Solved after the two-bone pass, because it depends on where that pass put
   * the ankle.
   */
  #pointBootAtBall(weight, targetWorld) {
    const shin = this.bones.get('shinL');
    const foot = this.bones.get('footL');
    const toe = this.bones.get('toeL');

    shin.updateMatrixWorld(true);
    const ankleWorld = foot.getWorldPosition(new THREE.Vector3());
    const desiredWorld = new THREE.Vector3().subVectors(targetWorld, ankleWorld);
    if (desiredWorld.lengthSq() < 1e-8) return;
    desiredWorld.normalize();

    // Express the desired toe direction in the foot's parent (shin) frame.
    const shinWorldQ = shin.getWorldQuaternion(new THREE.Quaternion());
    const desiredLocal = desiredWorld.applyQuaternion(shinWorldQ.invert()).normalize();
    const bindDir = toe.position.clone().normalize();

    const footQ = new THREE.Quaternion().setFromUnitVectors(bindDir, desiredLocal);
    foot.quaternion.slerp(footQ, weight);
    foot.updateMatrixWorld(true);
  }

  /** World-space position of the striking boot — used by VFX and the gates. */
  bootPosition(out = new THREE.Vector3()) {
    this.bones.get('toeL').getWorldPosition(out);
    return out;
  }
}

// --- geometry helpers ----------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
/** Roughly how far apart to place rings along a swept profile, in metres. */
const RING_SPACING = 0.018;

/**
 * Shape-preserving (Fritsch–Carlson) cubic through the control points.
 *
 * A plain Catmull-Rom overshoots either side of a bulge, which on a limb shows
 * up as a pinch just above and below every muscle. This flattens the tangent
 * at every local extreme instead, so an authored bulge is a bulge and nothing
 * more.
 */
function monotoneSpline(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
      continue;
    }
    const h0 = xs[i] - xs[i - 1];
    const h1 = xs[i + 1] - xs[i];
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i += 1;
    const h = xs[i + 1] - xs[i];
    const s = (x - xs[i]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i]
      + (s3 - 2 * s2 + s) * h * m[i]
      + (-2 * s3 + 3 * s2) * ys[i + 1]
      + (s3 - s2) * h * m[i + 1];
  };
}

/**
 * An orthonormal frame with +y along `axis` and +z as close to `hint` as the
 * axis allows. `x` may come out mirrored for a downward-pointing bone — which
 * is harmless, because radii are symmetric and only `dz` follows `hint`.
 */
function frameFor(axis, hint) {
  const z = hint.clone().addScaledVector(axis, -hint.dot(axis));
  if (z.lengthSq() < 1e-8) {
    z.set(0, 1, 0).addScaledVector(axis, -axis.y);
    if (z.lengthSq() < 1e-8) z.set(1, 0, 0).addScaledVector(axis, -axis.x);
  }
  z.normalize();
  return { x: new THREE.Vector3().crossVectors(axis, z).normalize(), z };
}

/**
 * Sweeps an authored `[t, rx, rz, dz]` profile along a straight axis. `unit`
 * converts t into metres — a bone span for a limb, 1 for a piece measured
 * directly in metres.
 *
 * Ends get a *flat* cap on its own vertices, never shared with the tube. That
 * keeps a sleeve hem or a shirt hem a crisp edge under smooth shading instead
 * of rolling into a bulb.
 */
function tubeGeometry(origin, axis, rings, unit, hint, radial, mod) {
  const frame = frameFor(axis, hint || FORWARD);
  const ts = rings.map((r) => r[0]);
  const fx = monotoneSpline(ts, rings.map((r) => r[1]));
  const fz = monotoneSpline(ts, rings.map((r) => (r.length > 2 ? r[2] : r[1])));
  const fd = monotoneSpline(ts, rings.map((r) => (r.length > 3 ? r[3] : 0)));
  // Columns 4 and 5 are only authored by the hand: a sideways shift of the
  // ring centre, and the depth of a crease cut into the two flat faces.
  const fdx = monotoneSpline(ts, rings.map((r) => (r.length > 4 ? r[4] : 0)));
  const fcr = monotoneSpline(ts, rings.map((r) => (r.length > 5 ? r[5] : 0)));
  // power < 1 turns the elliptical section into a superellipse: flat faces
  // front and back with the mass pushed out to the sides. That is the
  // difference between a pec and a breast, and between a palm and a spoon.
  const power = mod?.power ?? 1;
  const creaseW = mod?.creaseWidth ?? 0.30;
  const sideSign = mod?.sideSign ?? 1;

  const samples = [];
  for (let i = 0; i < ts.length - 1; i += 1) {
    const steps = Math.max(1, Math.round((Math.abs(ts[i + 1] - ts[i]) * unit) / RING_SPACING));
    for (let s = 0; s < steps; s += 1) samples.push(ts[i] + ((ts[i + 1] - ts[i]) * s) / steps);
  }
  samples.push(ts[ts.length - 1]);

  const cos = [];
  const sin = [];
  for (let j = 0; j < radial; j += 1) {
    const a = (j / radial) * Math.PI * 2;
    cos.push(Math.cos(a));
    sin.push(Math.sin(a));
  }

  const position = [];
  const uv = [];
  const index = [];
  const c = new THREE.Vector3();
  const tFirst = samples[0];
  const tSpan = samples[samples.length - 1] - tFirst || 1;

  const ringAt = (t) => {
    c.copy(origin)
      .addScaledVector(axis, t * unit)
      .addScaledVector(frame.z, fd(t))
      .addScaledVector(frame.x, fdx(t) * sideSign);
    return { rx: Math.max(fx(t), 0.0008), rz: Math.max(fz(t), 0.0008), cr: Math.max(fcr(t), 0) };
  };
  const emit = (rx, rz, cr, j) => {
    let u = cos[j];
    let v = sin[j];
    if (power !== 1) {
      u = Math.sign(u) * Math.abs(u) ** power;
      v = Math.sign(v) * Math.abs(v) ** power;
    }
    // The crease is a valley across the middle of each flat face, so it is
    // localised on sin — which is zero exactly where those faces are.
    if (cr > 0) u *= 1 - cr * Math.exp(-(sin[j] * sin[j]) / (creaseW * creaseW));
    position.push(
      c.x + frame.x.x * rx * u + frame.z.x * rz * v,
      c.y + frame.x.y * rx * u + frame.z.y * rz * v,
      c.z + frame.x.z * rx * u + frame.z.z * rz * v,
    );
  };

  for (const t of samples) {
    const { rx, rz, cr } = ringAt(t);
    for (let j = 0; j < radial; j += 1) {
      emit(rx, rz, cr, j);
      uv.push(j / radial, (t - tFirst) / tSpan);
    }
  }
  // Ring vertices wrap rather than duplicating a seam, so the shading runs
  // smoothly the whole way round.
  for (let i = 0; i < samples.length - 1; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      index.push(a, a + radial, b, b, a + radial, b + radial);
    }
  }

  for (const [t, isStart] of [[samples[0], true], [samples[samples.length - 1], false]]) {
    const { rx, rz, cr } = ringAt(t);
    const base = position.length / 3;
    position.push(c.x, c.y, c.z);
    uv.push(0.5, 0.5);
    for (let j = 0; j < radial; j += 1) {
      emit(rx, rz, cr, j);
      uv.push(0.5 + 0.5 * cos[j], 0.5 + 0.5 * sin[j]);
    }
    for (let j = 0; j < radial; j += 1) {
      const a = base + 1 + j;
      const b = base + 1 + ((j + 1) % radial);
      if (isStart) index.push(base, a, b);
      else index.push(base, b, a);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  // Normals are recomputed once per merged mesh; this only keeps the attribute
  // sets identical so the merge succeeds.
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(position.length), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

/**
 * A profile-swept limb spanning two bind-pose joints, skinned so vertices near
 * the far joint blend partly onto the child bone. That soft handover is what
 * stops the knee and elbow from creasing.
 */
function limbGeometry(a, b, rings, radial, hint, boneA, boneB, materialIndex, opts = {}) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const fullLength = dir.length();
  const axis = dir.clone().normalize();
  const geo = tubeGeometry(a, axis, rings, fullLength, hint, radial, opts.mod);

  const pos = geo.getAttribute('position');
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const p = new THREE.Vector3();
  // [start of the handover, the halfway point, where it becomes wholly the
  // child's]. A piece that runs past the far joint needs the third value, or
  // its far end stays half on the parent and slides through whatever else is
  // fully skinned to the child.
  const [h0, h1, h2] = opts.handoff || [0.62, 1.0, null];
  const root = opts.root;

  for (let i = 0; i < count; i += 1) {
    // Weights are measured along the *full* bone span, so adjacent slices of
    // one limb deform identically and never split apart. Only a piece that
    // deliberately overruns the joint is allowed past t = 1.
    p.fromBufferAttribute(pos, i).sub(a);
    const raw = p.dot(axis) / fullLength;
    const t = h2 === null ? THREE.MathUtils.clamp(raw, 0, 1) : Math.max(0, raw);
    let wChild = smootherstep(h0, h1, t) * 0.5;
    if (h2 !== null) wChild += smootherstep(h1, h2, t) * 0.5;
    const wRoot = root ? smootherstep(root.from, root.to, t) * root.max : 0;
    const rest = 1 - wRoot;
    skinIndex[i * 4] = boneA;
    skinIndex[i * 4 + 1] = boneB;
    skinWeight[i * 4] = (1 - wChild) * rest;
    skinWeight[i * 4 + 1] = wChild * rest;
    if (root) {
      skinIndex[i * 4 + 2] = root.index;
      skinWeight[i * 4 + 2] = wRoot;
    }
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return { geometry: geo, materialIndex };
}

/**
 * Skins one continuous piece across a whole bone chain by height.
 *
 * Unlike the per-limb rule, weights here run *through* each bone rather than
 * restarting at it, so a torso built as a single lathe bends smoothly along
 * the spine instead of hinging at the places its pieces used to butt together.
 */
function chainGeometry(geo, chain, boneIdxs, materialIndex) {
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const last = chain.length - 1;

  for (let i = 0; i < count; i += 1) {
    const y = pos.getY(i);
    let lo = 0;
    while (lo < last - 1 && y > chain[lo + 1].y) lo += 1;
    const span = chain[lo + 1].y - chain[lo].y;
    const t = THREE.MathUtils.clamp((y - chain[lo].y) / span, 0, 1);
    const wUpper = smootherstep(0, 1, t);
    skinIndex[i * 4] = boneIdxs[lo];
    skinIndex[i * 4 + 1] = boneIdxs[lo + 1];
    skinWeight[i * 4] = 1 - wUpper;
    skinWeight[i * 4 + 1] = wUpper;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return { geometry: geo, materialIndex };
}

/** Weight every vertex of `geo` fully to one bone. */
function rigidTo(geo, boneIdx, materialIndex) {
  const count = geo.getAttribute('position').count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    skinIndex[i * 4] = boneIdx;
    skinWeight[i * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return { geometry: geo, materialIndex };
}

/** A sphere rigidly weighted to one bone, used to cap a joint. */
function jointGeometry(centre, radius, boneIdx, materialIndex) {
  const geo = new THREE.SphereGeometry(radius, 20, 14);
  geo.translate(centre.x, centre.y, centre.z);
  return rigidTo(geo, boneIdx, materialIndex);
}

// --- head, face and hair -------------------------------------------------

/** Skull semi-axes (across / up / front-to-back) and where it sits on the bone. */
const SKULL = [0.1040, 0.1100, 0.1045];
const SKULL_RISE = 0.046;
const SKULL_Z = 0.005; // the head rides forward of the neck, not on top of it
const HEAD_SEGMENTS = [56, 38];

/** `d`-facing lobe, `k` controlling how tightly it is localised. 0 elsewhere. */
function lobe(nx, ny, nz, dx, dy, dz, k) {
  const l = Math.hypot(dx, dy, dz);
  const d = (nx * dx + ny * dy + nz * dz) / l;
  return d <= 0 ? 0 : Math.pow(d, k);
}

/**
 * The skull, as a displacement field over the unit sphere.
 *
 * Working in direction space rather than on a vertex list means the same
 * function defines the scalp for the hair shell, so the hair can be offset
 * radially off the *sculpted* head and is guaranteed never to intersect it.
 *
 * Two things do most of the work. The jaw scoop removes the mass under the
 * back of the skull, which is what turns a sphere-on-a-dowel into a jaw with a
 * neck rising behind it; and flattening the front turns the face into a plane
 * that the brow, the cheekbones and the chin project from, instead of a bulge
 * where every feature is equally proud.
 */
function skullPoint(nx, ny, nz, out) {
  let px = nx * SKULL[0];
  let py = ny * SKULL[1];
  let pz = nz * SKULL[2];

  const under = smootherstep(0.02, 0.95, -ny);
  const rear = smootherstep(-0.15, 0.80, -nz);
  const cut = under * rear;
  // The jaw holds its width down to the gonial angle and only narrows below
  // it; taper it from the equator and the head comes out as an egg.
  px *= 1 - 0.16 * smootherstep(0.08, 1.20, -ny);
  pz *= 1 - 0.52 * cut;
  py += SKULL[1] * 0.44 * cut;

  const front = smootherstep(0.20, 1.0, nz);
  pz *= 1 - 0.090 * front;

  // Everything below the eyes gets pushed forward in proportion to how far
  // down it is. This is the single most important line in the file for how the
  // head *lights*: every flood is 45° up, so a face that curves under below
  // the mouth loses all four of them at once and goes black in the shape of a
  // beard. Shearing the lower face forward keeps that plane near-vertical.
  pz += 0.022 * Math.max(0, -ny) * front;

  const chin = lobe(nx, ny, nz, 0, -0.72, 0.69, 14);
  pz += 0.020 * chin;
  py -= 0.008 * chin;

  const muzzle = lobe(nx, ny, nz, 0, -0.34, 0.94, 5);
  pz += 0.006 * muzzle;

  // The brow is a bar across the middle of the face, so it is faded out at the
  // temples rather than left as a lobe that would read as a bump.
  const brow = lobe(nx, ny, nz, 0, 0.32, 0.95, 6) * (1 - 0.55 * smootherstep(0.28, 0.92, Math.abs(nx)));
  pz += 0.011 * brow;
  py += 0.004 * brow;

  const cheek = lobe(nx, ny, nz, 0.66, -0.12, 0.74, 7) + lobe(nx, ny, nz, -0.66, -0.12, 0.74, 7);
  pz += 0.006 * cheek;
  px += (nx >= 0 ? 0.004 : -0.004) * cheek;

  // A shallow mound where each eye sits, so the painted eye has something to
  // catch the light on instead of lying on a flat wall.
  const eyes = lobe(nx, ny, nz, 0.32, 0.02, 0.95, 14) + lobe(nx, ny, nz, -0.32, 0.02, 0.95, 14);
  pz += 0.005 * eyes;

  const occiput = lobe(nx, ny, nz, 0, 0.22, -0.97, 3);
  pz -= 0.010 * occiput;

  out[0] = px;
  out[1] = py;
  out[2] = pz;
  return out;
}

function headGeometry(centre, boneIdx) {
  const geo = new THREE.SphereGeometry(1, HEAD_SEGMENTS[0], HEAD_SEGMENTS[1]);
  const pos = geo.getAttribute('position');
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i += 1) {
    skullPoint(pos.getX(i), pos.getY(i), pos.getZ(i), p);
    pos.setXYZ(i, p[0], p[1], p[2]);
  }
  geo.translate(centre.x, centre.y, centre.z);
  return rigidTo(geo, boneIdx, MATERIAL_INDEX.face);
}

/**
 * Hairline, as polar angle down from the crown against azimuth away from the
 * face. This table *is* the haircut: high corners at the temples, a drop in
 * front of the ear for the sideburn, and a long low line round the nape.
 */
const HAIRLINE = [
  [0, 71], [12, 70], [24, 66], [36, 63], [48, 67], [60, 79], [72, 89],
  [82, 94], [92, 97], [104, 99], [120, 102], [145, 105], [180, 106],
];
const HAIR_THIN = 0.0050; // margin over the scalp at the faded edges
const HAIR_THICK = 0.0215; // and over the crown

function hairlinePhi(deltaDeg) {
  const d = Math.abs(deltaDeg);
  for (let i = 0; i < HAIRLINE.length - 1; i += 1) {
    if (d <= HAIRLINE[i + 1][0]) {
      const t = (d - HAIRLINE[i][0]) / (HAIRLINE[i + 1][0] - HAIRLINE[i][0]);
      const s = t * t * (3 - 2 * t);
      return HAIRLINE[i][1] * (1 - s) + HAIRLINE[i + 1][1] * s;
    }
  }
  return HAIRLINE[HAIRLINE.length - 1][1];
}

/**
 * Hair as a shell offset radially off the scalp, cut at the hairline above.
 *
 * Two ellipsoids of nearly the same size meet at a grazing angle, and a
 * grazing intersection tessellates into a zigzag however many segments you
 * throw at it — so the shell is built to *contain* the scalp everywhere and
 * never intersects it at all. The offset is a function of polar angle, not of
 * distance from the hairline: thin low down and thick over the crown, which is
 * a faded short crop rather than a bathing cap. The lowest row drops back onto
 * the scalp, giving the edge a visible lip instead of a paper-thin boundary.
 */
function hairGeometry(centre, boneIdx) {
  const RAD = 52;
  const ROWS = 13;
  const D2Rad = Math.PI / 180;
  const position = [];
  const uv = [];
  const index = [];
  const p = [0, 0, 0];

  const rows = ROWS + 2; // row 0 is the skirt that lands back on the scalp
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < RAD; i += 1) {
      const delta = (i / RAD) * 360 - 180; // 0 = straight ahead
      const line = hairlinePhi(delta);
      let phi;
      let margin;
      if (j === 0) {
        // The skirt lands *inside* the scalp. Stopping it flush leaves a
        // millimetre-wide band of lit skin below the rim, and at a grazing
        // angle that band picks up a specular highlight and rings the whole
        // nape in bright cream. Burying it lets the two surfaces cross, and
        // because the wall is steep the crossing is a clean line.
        phi = line + 2.5;
        margin = -0.0025;
      } else {
        const t = (j - 1) / ROWS;
        phi = line * (1 - smootherstep(0, 1, t));
        margin = HAIR_THIN + (HAIR_THICK - HAIR_THIN) * smootherstep(78, 22, phi);
        // A little extra height over the front of the crown: a crop has a
        // front to it, and a perfectly even shell does not.
        margin += 0.006 * smootherstep(52, 8, phi) * smootherstep(-0.3, 0.7, Math.cos(delta * D2Rad));
      }
      const sp = Math.sin(phi * D2Rad);
      const nx = Math.sin(delta * D2Rad) * sp;
      const ny = Math.cos(phi * D2Rad);
      const nz = Math.cos(delta * D2Rad) * sp;
      skullPoint(nx, ny, nz, p);
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      position.push(
        centre.x + p[0] * (1 + margin / len),
        centre.y + p[1] * (1 + margin / len),
        centre.z + p[2] * (1 + margin / len),
      );
      uv.push(i / RAD, j / (rows - 1));
    }
  }
  for (let j = 0; j < rows - 1; j += 1) {
    for (let i = 0; i < RAD; i += 1) {
      const a = j * RAD + i;
      const b = j * RAD + ((i + 1) % RAD);
      // Rows climb *towards* the crown, so the winding is the mirror of the
      // one `tubeGeometry` uses; get it backwards and the shell is culled and
      // you see straight through the hair to the scalp.
      index.push(a, b, a + RAD, b, b + RAD, a + RAD);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(position.length), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  return rigidTo(geo, boneIdx, MATERIAL_INDEX.hair);
}

/**
 * The nose, swept downwards from the brow with the ring centres running
 * forward, so the bridge emerges from the face rather than being stuck on it.
 * `rz` is the half-depth, so the front line of the nose is `dz + rz`.
 */
const NOSE_ORIGIN = [0, 0.034, 0.092]; // relative to the skull centre
const NOSE_RINGS = [
  [0.000, 0.0075, 0.006, 0.010],
  [0.012, 0.0085, 0.008, 0.011],
  [0.024, 0.0105, 0.011, 0.012],
  [0.036, 0.0135, 0.015, 0.013],
  [0.046, 0.0170, 0.018, 0.014], // ball of the nose
  [0.053, 0.0190, 0.016, 0.014], // wings
  [0.058, 0.0160, 0.013, 0.012],
  [0.062, 0.0090, 0.008, 0.009],
];

function noseGeometry(centre, boneIdx) {
  const origin = centre.clone().add(new THREE.Vector3().fromArray(NOSE_ORIGIN));
  const geo = tubeGeometry(origin, new THREE.Vector3(0, -1, 0), NOSE_RINGS, 1, FORWARD, 18);
  return rigidTo(geo, boneIdx, MATERIAL_INDEX.skin);
}

/**
 * An ear: a plate squashed flat across the head with the middle of its outer
 * face pushed back in, which is enough for the shading to find a concha. Half
 * of it is buried in the skull, so only the rim and the bowl are ever seen.
 */
const EAR_AT = [0.0990, -0.012, -0.012];
const EAR_SEMI = [0.017, 0.036, 0.025];

function earGeometry(centre, side, boneIdx) {
  const geo = new THREE.SphereGeometry(1, 18, 14);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const nx = pos.getX(i);
    const ny = pos.getY(i);
    const nz = pos.getZ(i);
    // Narrower and shallower at the lobe than at the helix.
    const taper = 1 - 0.30 * smootherstep(0.1, 1.0, -ny);
    const bowl = Math.max(0, nx) * Math.exp(-(ny * ny * 4.6 + (nz + 0.16) * (nz + 0.16) * 5.0));
    pos.setXYZ(
      i,
      nx * EAR_SEMI[0] * (1 - 0.52 * bowl) * side,
      ny * EAR_SEMI[1] * (1 + 0.06 * nz),
      nz * EAR_SEMI[2] * taper,
    );
  }
  geo.rotateX(-0.14);
  geo.rotateZ(side * 0.10);
  geo.translate(centre.x + side * EAR_AT[0], centre.y + EAR_AT[1], centre.z + EAR_AT[2]);
  return rigidTo(geo, boneIdx, MATERIAL_INDEX.skin);
}

// --- field-meshed pieces ---------------------------------------------------

/** The limb skinning rule, as a per-point function for the field mesher. */
function limbWeights(p, a, axis, unit, boneA, boneB, handoff, root) {
  const [h0, h1, h2] = handoff || [0.62, 1.0, null];
  const raw = (p.x - a.x) * axis.x + (p.y - a.y) * axis.y + (p.z - a.z) * axis.z;
  const t = h2 === null ? THREE.MathUtils.clamp(raw / unit, 0, 1) : Math.max(0, raw / unit);
  let wChild = smootherstep(h0, h1, t) * 0.5;
  if (h2 !== null) wChild += smootherstep(h1, h2, t) * 0.5;
  const wRoot = root ? smootherstep(root.from, root.to, t) * root.max : 0;
  const rest = 1 - wRoot;
  const out = [[boneA, (1 - wChild) * rest], [boneB, wChild * rest]];
  if (root) out.push([root.index, wRoot]);
  return out;
}

/** The spine-chain skinning rule, likewise. */
function chainWeights(p, chain, idx) {
  const last = chain.length - 1;
  let lo = 0;
  while (lo < last - 1 && p.y > chain[lo + 1].y) lo += 1;
  const t = THREE.MathUtils.clamp((p.y - chain[lo].y) / (chain[lo + 1].y - chain[lo].y), 0, 1);
  const w = smootherstep(0, 1, t);
  return [[idx[lo], 1 - w], [idx[lo + 1], w]];
}

/**
 * Bind-pose extents of the two kit pieces, in metres: [xMin, xMax, yMin, yMax].
 * The kit artwork in textures.js is painted against these same numbers.
 */
export const SHIRT_UV = [-0.36, 0.36, 0.86, 1.50];
export const SHORTS_UV = [-0.26, 0.26, 0.64, 1.02];
/** Metres of cloth per repeat of the knit micro-texture. */
const KNIT_TILE = 0.11;

/**
 * Kit artwork is projected straight through the body, front and back: the left
 * half of the texture is what you see from the front, the right half from
 * behind. A shirt is printed flat and it reads that way. The sides, where a
 * planar projection smears, are exactly where a kit has a plain side panel.
 *
 * `uv1` is a second, world-scaled set for the knit, so the weave stays the
 * same size on a sleeve as on the chest.
 */
function projectKitUVs(geo, [x0, x1, y0, y1]) {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const front = nor.getZ(i) >= 0;
    const u = (x - x0) / (x1 - x0);
    uv.setXY(i, front ? u * 0.5 : 1 - u * 0.5, (y - y0) / (y1 - y0));
    const across = Math.abs(nor.getZ(i)) >= Math.abs(nor.getX(i)) ? x : pos.getZ(i);
    uv1[i * 2] = across / KNIT_TILE;
    uv1[i * 2 + 1] = y / KNIT_TILE;
  }
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
}

/**
 * Points every vertex of a trim piece at one flat-colour swatch of the kit
 * sheet, keeping its own lathe UVs as the knit set.
 */
function swatched(geo, swatch) {
  if (!swatch) return geo;
  const uv = geo.getAttribute('uv');
  const uv1 = new Float32Array(uv.count * 2);
  for (let i = 0; i < uv.count; i += 1) {
    uv1[i * 2] = uv.getX(i) * 5;
    uv1[i * 2 + 1] = uv.getY(i) * 0.5;
    uv.setXY(i, swatch[0], swatch[1]);
  }
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return geo;
}

/** Lathes have no second UV set of their own; mirror the first so merges match. */
function withSecondUV(geo) {
  if (!geo.getAttribute('uv1')) geo.setAttribute('uv1', geo.getAttribute('uv').clone());
  return geo;
}

/**
 * The hand: a palm, four fingers and a thumb, joined by the same smooth union
 * as the shirt, so the webs between the fingers and the heel of the thumb are
 * fillets rather than intersections. Rounds 1-3 used a creased mitten, which
 * was the right triangle budget and the wrong silhouette — at three-quarter it
 * read as an oven glove. Fingers are what say "hand".
 *
 * `down` runs wrist → fingertips, `fwd` is the thumb side, `palm` is the
 * direction the palm faces (towards the thigh, for a hanging arm).
 */
const FINGERS = [
  // [offset across the palm, length, radius, curl at the knuckle, curl mid-finger]
  [0.0265, 0.070, 0.0086, 0.20, 0.42], // index
  [0.0090, 0.078, 0.0090, 0.26, 0.50], // middle
  [-0.0085, 0.072, 0.0086, 0.32, 0.58], // ring
  [-0.0250, 0.056, 0.0076, 0.40, 0.66], // little
];

function handGeometry(wrist, down, fwd, palm) {
  const at = (d, f, p) => wrist.clone().addScaledVector(down, d).addScaledVector(fwd, f).addScaledVector(palm, p);
  const fields = [
    // Wrist: carries the forearm's section into the hand so there is no step.
    capsuleField(at(-0.030, 0, 0), at(0.016, 0, 0), 0.0215, 0.0225, { k: 0.012 }),
    // Palm: a slab, slightly cupped by setting it off towards the palm side.
    roundBoxField(at(0.054, 0.001, 0.002), palm, down, fwd, [0.0050, 0.036, 0.031], 0.0085, { k: 0.012 }),
    // Heel of the thumb.
    capsuleField(at(0.026, 0.020, 0.008), at(0.050, 0.030, 0.012), 0.0150, 0.0125, { k: 0.012 }),
  ];
  for (const [across, length, radius, curl1, curl2] of FINGERS) {
    const knuckle = at(0.092, across, 0.002);
    const dir1 = down.clone().multiplyScalar(Math.cos(curl1)).addScaledVector(palm, Math.sin(curl1));
    const mid = knuckle.clone().addScaledVector(dir1, length * 0.52);
    const a2 = curl1 + curl2;
    const dir2 = down.clone().multiplyScalar(Math.cos(a2)).addScaledVector(palm, Math.sin(a2));
    const tip = mid.clone().addScaledVector(dir2, length * 0.48);
    fields.push(capsuleField(knuckle, mid, radius, radius * 0.93, { k: 0.0045 }));
    fields.push(capsuleField(mid, tip, radius * 0.93, radius * 0.80, { k: 0.0045 }));
  }
  // Thumb: off the radial edge, angled forward and a little across the palm.
  const t0 = at(0.050, 0.030, 0.012);
  const t1 = at(0.082, 0.047, 0.020);
  const t2 = at(0.106, 0.050, 0.030);
  fields.push(capsuleField(t0, t1, 0.0115, 0.0100, { k: 0.006 }));
  fields.push(capsuleField(t1, t2, 0.0100, 0.0082, { k: 0.006 }));
  return meshFields(fields, { cell: 0.0052, skinned: false });
}

// --- clip authoring ------------------------------------------------------

const D2R = Math.PI / 180;

/** Euler degrees → a QuaternionKeyframeTrack for one bone. */
function track(bone, times, eulersDeg) {
  const values = [];
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  for (const [x, y, z] of eulersDeg) {
    e.set(x * D2R, y * D2R, z * D2R);
    q.setFromEuler(e);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}

/**
 * Idle / balance: a slow weight-shift with counter-rotating chest, breathing
 * and the kicking leg held loaded, ready to strike.
 */
function buildIdleClip() {
  const t = [0, 0.6, 1.2, 1.8, 2.4];
  const tracks = [
    track('hips', t, [[2, 3, 0], [1, -2, 1.5], [2, -4, 0], [1, 1, -1.5], [2, 3, 0]]),
    track('spine', t, [[-1, -2, 0], [0, 1, -1], [-1, 3, 0], [0, -1, 1], [-1, -2, 0]]),
    track('chest', t, [[-2, -3, 0], [-3, 2, 1], [-2, 4, 0], [-3, -1, -1], [-2, -3, 0]]),
    track('head', t, [[6, 2, 0], [7, -2, 0], [8, -3, 0], [7, 1, 0], [6, 2, 0]]),

    // Arms already hang in the bind pose. Positive Z flares the +x arm
    // outward, negative X bends either elbow forward.
    //
    // The bind pose alone already carries the arm ~8° out; adding another 9°
    // on top left them splayed and rod-straight, which is how a shop-window
    // dummy stands. An athlete at rest keeps the upper arm barely off the
    // ribs and carries the load in a bent elbow, so the flare comes almost
    // all the way off and the forearms angle back *inward* (negative Z on the
    // +x side) to bring the hands in beside the hips.
    track('clavL', t, [[0, 0, -3], [0, 0, -2], [0, 0, -4], [0, 0, -2], [0, 0, -3]]),
    track('armL', t, [[-4, 0, 3], [-6, 0, 5], [-2, 0, 2], [-5, 0, 4], [-4, 0, 3]]),
    track('foreL', t, [[-24, 0, -3], [-28, 0, -4], [-21, 0, -2], [-27, 0, -4], [-24, 0, -3]]),
    track('clavR', t, [[0, 0, 3], [0, 0, 2], [0, 0, 4], [0, 0, 2], [0, 0, 3]]),
    track('armR', t, [[-4, 0, -3], [-6, 0, -5], [-2, 0, -2], [-5, 0, -4], [-4, 0, -3]]),
    track('foreR', t, [[-24, 0, 3], [-28, 0, 4], [-21, 0, 2], [-27, 0, 4], [-24, 0, 3]]),

    // Kicking leg stays loaded — knee soft, foot just off the turf.
    track('thighL', t, [[-16, 0, -3], [-13, 0, -3], [-18, 0, -4], [-14, 0, -3], [-16, 0, -3]]),
    track('shinL', t, [[26, 0, 0], [22, 0, 0], [29, 0, 0], [23, 0, 0], [26, 0, 0]]),
    track('footL', t, [[-8, 0, 0], [-6, 0, 0], [-10, 0, 0], [-7, 0, 0], [-8, 0, 0]]),
    // Standing leg takes the weight.
    track('thighR', t, [[-3, 0, 2], [-5, 0, 2], [-2, 0, 3], [-5, 0, 2], [-3, 0, 2]]),
    track('shinR', t, [[6, 0, 0], [9, 0, 0], [4, 0, 0], [9, 0, 0], [6, 0, 0]]),
  ];
  return new THREE.AnimationClip('idle', 2.4, tracks);
}

/**
 * Kick. Frame 0 is the *contact* pose, not a wind-up — the ball leaves the
 * boot the instant the player taps, so the animation must already be there.
 * What follows is follow-through and recovery back to the idle stance.
 */
function buildKickClip() {
  const t = [0, 0.09, 0.20, 0.34, 0.48];
  const tracks = [
    track('hips', t, [[-4, 4, 0], [-7, 6, 0], [-4, 5, 0], [0, 3, 0], [2, 3, 0]]),
    track('spine', t, [[5, -3, 0], [8, -5, 0], [5, -4, 0], [1, -2, 0], [-1, -2, 0]]),
    track('chest', t, [[6, -5, 0], [10, -8, 0], [6, -6, 0], [0, -3, 0], [-2, -3, 0]]),
    track('head', t, [[10, 0, 0], [12, 0, 0], [10, 0, 0], [7, 1, 0], [6, 2, 0]]),

    // The arm opposite the kicking leg drives forward and up; the near arm
    // swings back and out for balance.
    track('clavL', t, [[0, 0, -8], [0, 0, -12], [0, 0, -8], [0, 0, -4], [0, 0, -3]]),
    track('armL', t, [[34, 0, 24], [46, 0, 30], [30, 0, 22], [2, 0, 9], [-4, 0, 3]]),
    track('foreL', t, [[-18, 0, 4], [-14, 0, 5], [-20, 0, 3], [-23, 0, -1], [-24, 0, -3]]),
    track('clavR', t, [[0, 0, 10], [0, 0, 14], [0, 0, 10], [0, 0, 4], [0, 0, 3]]),
    track('armR', t, [[-48, 0, -20], [-62, 0, -26], [-44, 0, -18], [-16, 0, -9], [-4, 0, -3]]),
    track('foreR', t, [[-54, 0, -6], [-64, 0, -7], [-48, 0, -5], [-30, 0, 1], [-24, 0, 3]]),

    // Striking leg: contact → follow-through → recovery.
    track('thighL', t, [[-52, 0, -4], [-72, 0, -6], [-46, 0, -5], [-22, 0, -3], [-16, 0, -3]]),
    track('shinL', t, [[8, 0, 0], [2, 0, 0], [18, 0, 0], [24, 0, 0], [26, 0, 0]]),
    track('footL', t, [[-26, 0, 0], [-34, 0, 0], [-22, 0, 0], [-12, 0, 0], [-8, 0, 0]]),
    // Plant leg braces then straightens.
    track('thighR', t, [[6, 0, 3], [10, 0, 3], [6, 0, 3], [0, 0, 2], [-3, 0, 2]]),
    track('shinR', t, [[14, 0, 0], [20, 0, 0], [14, 0, 0], [8, 0, 0], [6, 0, 0]]),
  ];
  return new THREE.AnimationClip('kick', 0.48, tracks);
}

/** Played once on a loss: the player drops their shoulders. */
function buildStumbleClip() {
  const t = [0, 0.25, 0.7, 1.1];
  return new THREE.AnimationClip('stumble', 1.1, [
    track('hips', t, [[2, 3, 0], [10, 8, 0], [14, 10, 0], [12, 9, 0]]),
    track('spine', t, [[-1, -2, 0], [8, -6, 0], [12, -8, 0], [11, -7, 0]]),
    track('chest', t, [[-2, -3, 0], [10, -4, 0], [16, -6, 0], [15, -5, 0]]),
    track('head', t, [[6, 2, 0], [18, 4, 0], [26, 6, 0], [24, 5, 0]]),
    track('armL', t, [[-4, 0, 3], [-13, 0, 13], [-19, 0, 21], [-17, 0, 19]]),
    track('armR', t, [[-4, 0, -3], [-13, 0, -13], [-19, 0, -21], [-17, 0, -19]]),
    track('thighL', t, [[-16, 0, -3], [-6, 0, -2], [-2, 0, -1], [-3, 0, -1]]),
    track('shinL', t, [[26, 0, 0], [12, 0, 0], [6, 0, 0], [7, 0, 0]]),
  ]);
}

/** The pose every clip falls back to: frame 0 of the idle. */
function restPoseFrom(clip) {
  const rest = new Map();
  for (const t of clip.tracks) {
    rest.set(t.name, [t.values[0], t.values[1], t.values[2], t.values[3]]);
  }
  return rest;
}

/**
 * Pads `clip` with constant tracks for every bone in the rest pose it does not
 * already animate, so all clips share one blend set.
 */
function completeClip(clip, rest) {
  const present = new Set(clip.tracks.map((t) => t.name));
  for (const [name, q] of rest) {
    if (present.has(name)) continue;
    clip.tracks.push(
      new THREE.QuaternionKeyframeTrack(name, [0, clip.duration], [...q, ...q]),
    );
  }
  return clip;
}

function smootherstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

/** Frame-rate independent move towards a target, with separate rise/fall times. */
function approach(current, target, dt, riseTime, fallTime) {
  const time = target > current ? riseTime : fallTime;
  if (time <= 0) return target;
  const step = dt / time;
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
}
