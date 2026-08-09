import * as THREE from 'three';
import { BALL_RADIUS } from '../../core/constants.js';
import { makeBallTextures } from './textures.js';

/**
 * Match ball. The panel layout is a true spherical Voronoi over the 32 centres
 * of a truncated icosahedron, baked into albedo/normal/roughness at load, and
 * lit as clear-coated leather so the stadium rig throws a real specular hit.
 */
export function createBall() {
  const { map, normalMap, roughnessMap } = makeBallTextures(1024);

  const geometry = new THREE.SphereGeometry(BALL_RADIUS, 64, 48);
  const material = new THREE.MeshPhysicalMaterial({
    map,
    normalMap,
    roughnessMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    metalness: 0.0,
    roughness: 1.0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1.15,
    sheen: 0.15,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  return new BallView(mesh, material);
}

export class BallView {
  constructor(mesh, material) {
    this.mesh = mesh;
    this.material = material;
    this._axis = new THREE.Vector3(1, 0, 0);
    this._q = new THREE.Quaternion();
    this._vel = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * Roll the ball about the axis perpendicular to its travel, at the rate the
   * simulation is carrying — so spin always reads as a consequence of motion.
   */
  sync(body, forwardOffset, dt) {
    this.mesh.position.set(body.x, body.y, body.z + forwardOffset);

    this._vel.set(body.vx, body.vy, body.vz);
    const speed = this._vel.length();
    if (speed > 0.02) {
      this._axis.crossVectors(this._up, this._vel).normalize();
      if (this._axis.lengthSq() < 1e-6) this._axis.set(1, 0, 0);
    }
    const rate = body.spinRate + speed * 1.4;
    this._q.setFromAxisAngle(this._axis, rate * dt);
    this.mesh.quaternion.premultiply(this._q);
  }

  reset() {
    this.mesh.quaternion.identity();
  }

  dispose() {
    this.mesh.geometry.dispose();
    for (const key of ['map', 'normalMap', 'roughnessMap']) this.material[key]?.dispose();
    this.material.dispose();
  }
}
