import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BALL_RADIUS } from '../../core/constants.js';

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
  ['clavL', 'chest', [0.055, 0.125, 0]],
  ['armL', 'clavL', [0.125, -0.03, 0]],
  ['foreL', 'armL', [0.035, -0.255, 0]],
  ['handL', 'foreL', [0.012, -0.235, 0]],

  ['clavR', 'chest', [-0.055, 0.125, 0]],
  ['armR', 'clavR', [-0.125, -0.03, 0]],
  ['foreR', 'armR', [-0.035, -0.255, 0]],
  ['handR', 'foreR', [-0.012, -0.235, 0]],

  ['thighL', 'hips', [0.11, -0.06, 0]],
  ['shinL', 'thighL', [0, -0.42, 0]],
  ['footL', 'shinL', [0, -0.40, 0]],
  ['toeL', 'footL', [0, -0.04, 0.13]],

  ['thighR', 'hips', [-0.11, -0.06, 0]],
  ['shinR', 'thighR', [0, -0.42, 0]],
  ['footR', 'shinR', [0, -0.40, 0]],
  ['toeR', 'footR', [0, -0.04, 0.13]],
];

export const THIGH_LENGTH = 0.42;
export const SHIN_LENGTH = 0.40;
/** Ankle → toe, i.e. how far the boot extends past the joint the IK solves for. */
export const FOOT_LENGTH = Math.hypot(0.04, 0.13);

const MATERIAL_INDEX = { skin: 0, shirt: 1, shorts: 2, socks: 3, boots: 4, hair: 5 };

/**
 * segment: [fromBone, toBone, t0, t1, radiusAtT0, radiusAtT1, materialKey]
 *
 * t0/t1 slice a fraction of the bone span, which is what lets a sleeve stop
 * mid-bicep and shorts stop mid-thigh without inventing extra bones. Skin
 * weights are still computed against the *whole* span, so a sliced piece
 * deforms exactly as the full limb would.
 */
const SEGMENTS = [
  // Starts below the hips so the cylinder's flat hem hides inside the shorts.
  ['hips', 'spine', -0.22, 1.00, 0.126, 0.138, 'shirt'],
  ['spine', 'chest', 0.00, 1.00, 0.138, 0.166, 'shirt'],
  ['chest', 'neck', 0.00, 0.72, 0.166, 0.088, 'shirt'],
  ['chest', 'neck', 0.72, 1.00, 0.058, 0.052, 'skin'],
  ['neck', 'head', 0.00, 1.00, 0.052, 0.062, 'skin'],

  ['clavL', 'armL', 0.00, 1.00, 0.080, 0.062, 'shirt'],
  ['armL', 'foreL', 0.00, 0.52, 0.058, 0.048, 'shirt'], // sleeve
  ['armL', 'foreL', 0.52, 1.00, 0.045, 0.038, 'skin'],
  ['foreL', 'handL', 0.00, 1.00, 0.038, 0.030, 'skin'],
  ['clavR', 'armR', 0.00, 1.00, 0.080, 0.062, 'shirt'],
  ['armR', 'foreR', 0.00, 0.52, 0.058, 0.048, 'shirt'],
  ['armR', 'foreR', 0.52, 1.00, 0.045, 0.038, 'skin'],
  ['foreR', 'handR', 0.00, 1.00, 0.038, 0.030, 'skin'],

  ['thighL', 'shinL', 0.00, 0.46, 0.100, 0.082, 'shorts'],
  ['thighL', 'shinL', 0.46, 1.00, 0.078, 0.060, 'skin'],
  ['shinL', 'footL', 0.00, 0.14, 0.060, 0.058, 'skin'],
  ['shinL', 'footL', 0.14, 1.00, 0.061, 0.042, 'socks'], // sock top
  ['footL', 'toeL', 0.00, 1.00, 0.048, 0.038, 'boots'],
  ['thighR', 'shinR', 0.00, 0.46, 0.100, 0.082, 'shorts'],
  ['thighR', 'shinR', 0.46, 1.00, 0.078, 0.060, 'skin'],
  ['shinR', 'footR', 0.00, 0.14, 0.060, 0.058, 'skin'],
  ['shinR', 'footR', 0.14, 1.00, 0.061, 0.042, 'socks'],
  ['footR', 'toeR', 0.00, 1.00, 0.048, 0.038, 'boots'],
];

/**
 * joint: [bone, radius, materialKey]
 * No cap on `chest` — a sphere there scallops through the torso cone. The
 * torso taper already closes that joint on its own.
 */
const JOINTS = [
  ['hips', 0.148, 'shorts'],
  ['clavL', 0.074, 'shirt'],
  ['clavR', 0.074, 'shirt'],
  ['armL', 0.058, 'shirt'],
  ['armR', 0.058, 'shirt'],
  ['foreL', 0.044, 'skin'],
  ['foreR', 0.044, 'skin'],
  ['handL', 0.036, 'skin'],
  ['handR', 0.036, 'skin'],
  ['thighL', 0.100, 'shorts'],
  ['thighR', 0.100, 'shorts'],
  ['shinL', 0.062, 'skin'],
  ['shinR', 0.062, 'skin'],
  ['footL', 0.048, 'boots'],
  ['footR', 0.048, 'boots'],
];

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
  for (const [from, to, t0, t1, r0, r1, matKey] of SEGMENTS) {
    pieces.push(
      limbGeometry(
        worldOf(from),
        worldOf(to),
        t0,
        t1,
        r0,
        r1,
        boneIndex.get(from),
        boneIndex.get(to),
        MATERIAL_INDEX[matKey],
      ),
    );
  }
  // Head is a squashed sphere rather than a capsule.
  pieces.push(headGeometry(worldOf('head'), boneIndex.get('head')));
  pieces.push(hairGeometry(worldOf('head'), boneIndex.get('head')));

  // Joint caps. Tapered cylinders leave a visible notch wherever a limb
  // pivots; a sphere rigid to the joint's own bone closes it at every angle.
  for (const [bone, radius, matKey] of JOINTS) {
    pieces.push(jointGeometry(worldOf(bone), radius, boneIndex.get(bone), MATERIAL_INDEX[matKey]));
  }

  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xb08054, roughness: 0.72, metalness: 0.0 }), // skin
    new THREE.MeshStandardMaterial({ color: 0xe8e9ee, roughness: 0.60, metalness: 0.02 }), // shirt
    new THREE.MeshStandardMaterial({ color: 0x1b2f6b, roughness: 0.66, metalness: 0.02 }), // shorts
    new THREE.MeshStandardMaterial({ color: 0xe8e9ee, roughness: 0.70, metalness: 0.0 }), // socks
    new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.42, metalness: 0.12 }), // boots
    new THREE.MeshStandardMaterial({ color: 0x241a15, roughness: 0.85, metalness: 0.0 }), // hair
  ];

  // One SkinnedMesh per kit material, all sharing a single skeleton. Cheaper
  // to reason about than multi-material draw groups on a merged buffer, and
  // five draw calls is not a budget concern.
  const group = new THREE.Group();
  const byMaterial = [[], [], [], [], [], []];
  for (const { geometry, materialIndex } of pieces) byMaterial[materialIndex].push(geometry);

  const meshes = [];
  for (let i = 0; i < byMaterial.length; i += 1) {
    if (!byMaterial[i].length) continue;
    const geometry = mergeGeometries(byMaterial[i], false);
    geometry.computeVertexNormals();
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

/**
 * A tapered capsule spanning two bind-pose joints, skinned so vertices near
 * the far joint blend partly onto the child bone. That soft handover is what
 * stops the knee and elbow from creasing.
 */
function limbGeometry(a, b, t0, t1, r0, r1, boneA, boneB, materialIndex) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const fullLength = dir.length();
  const axis = dir.clone().normalize();
  const start = a.clone().addScaledVector(axis, t0 * fullLength);
  const length = (t1 - t0) * fullLength;
  const radial = 14;
  const rings = 8;

  const geo = new THREE.CylinderGeometry(r1, r0, length, radial, rings, false);
  // CylinderGeometry runs along +y centred at the origin: shift so y=0 is the
  // slice's start point.
  geo.translate(0, length / 2, 0);

  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  geo.applyQuaternion(q);
  geo.translate(start.x, start.y, start.z);

  const pos = geo.getAttribute('position');
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const p = new THREE.Vector3();

  for (let i = 0; i < count; i += 1) {
    // Weights are always measured along the *full* bone span, so adjacent
    // slices of one limb deform identically and never split apart.
    p.fromBufferAttribute(pos, i).sub(a);
    const t = THREE.MathUtils.clamp(p.dot(axis) / fullLength, 0, 1);
    // Hand over to the child bone only across the last quarter of the limb.
    const wChild = smootherstep(0.62, 1.0, t) * 0.5;
    skinIndex[i * 4] = boneA;
    skinIndex[i * 4 + 1] = boneB;
    skinWeight[i * 4] = 1 - wChild;
    skinWeight[i * 4 + 1] = wChild;
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
  const geo = new THREE.SphereGeometry(radius, 14, 10);
  geo.translate(centre.x, centre.y, centre.z);
  return rigidTo(geo, boneIdx, materialIndex);
}

/**
 * Hair: a second head sphere nudged up and back. It surfaces across the crown
 * and the back of the skull and stays buried inside the face, which is what
 * makes the player's facing direction readable without modelling features.
 */
function hairGeometry(centre, boneIdx) {
  const geo = new THREE.SphereGeometry(0.105, 20, 16);
  geo.scale(0.95, 1.14, 1.02);
  geo.translate(centre.x, centre.y + 0.052, centre.z - 0.016);
  return rigidTo(geo, boneIdx, MATERIAL_INDEX.hair);
}

function headGeometry(centre, boneIdx) {
  const geo = new THREE.SphereGeometry(0.105, 20, 16);
  geo.scale(0.92, 1.12, 1.0);
  geo.translate(centre.x, centre.y + 0.04, centre.z);
  return rigidTo(geo, boneIdx, MATERIAL_INDEX.skin);
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
    track('clavL', t, [[0, 0, -3], [0, 0, -2], [0, 0, -4], [0, 0, -2], [0, 0, -3]]),
    track('armL', t, [[-8, 0, 9], [-11, 0, 12], [-6, 0, 7], [-10, 0, 11], [-8, 0, 9]]),
    track('foreL', t, [[-26, 0, 5], [-31, 0, 6], [-22, 0, 4], [-30, 0, 6], [-26, 0, 5]]),
    track('clavR', t, [[0, 0, 3], [0, 0, 2], [0, 0, 4], [0, 0, 2], [0, 0, 3]]),
    track('armR', t, [[-8, 0, -9], [-10, 0, -11], [-6, 0, -7], [-11, 0, -12], [-8, 0, -9]]),
    track('foreR', t, [[-26, 0, -5], [-30, 0, -6], [-22, 0, -4], [-31, 0, -6], [-26, 0, -5]]),

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
    track('armL', t, [[34, 0, 24], [46, 0, 30], [30, 0, 22], [2, 0, 12], [-8, 0, 9]]),
    track('foreL', t, [[-18, 0, 6], [-14, 0, 7], [-20, 0, 6], [-25, 0, 5], [-26, 0, 5]]),
    track('clavR', t, [[0, 0, 10], [0, 0, 14], [0, 0, 10], [0, 0, 4], [0, 0, 3]]),
    track('armR', t, [[-48, 0, -20], [-62, 0, -26], [-44, 0, -18], [-16, 0, -11], [-8, 0, -9]]),
    track('foreR', t, [[-54, 0, -8], [-64, 0, -9], [-48, 0, -7], [-30, 0, -6], [-26, 0, -5]]),

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
    track('armL', t, [[-8, 0, 9], [-16, 0, 18], [-22, 0, 26], [-20, 0, 24]]),
    track('armR', t, [[-8, 0, -9], [-16, 0, -18], [-22, 0, -26], [-20, 0, -24]]),
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
