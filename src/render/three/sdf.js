/**
 * Implicit-surface meshing for the parts of the footballer that are several
 * forms flowing into one another: the shirt (ribcage, shoulder yoke, deltoid,
 * sleeve), the shorts (pelvis and both leg tubes) and the hands.
 *
 * Rounds 1-3 built those from separate lathes that started inside each other.
 * That stops them punching through, but every place two lathes cross is still
 * a crease with unrelated normals either side of it, and the eye reads a
 * crease on a shoulder as armour plate. Here each lathe becomes a distance
 * field instead, the fields are joined with a *smooth* minimum — which fillets
 * every junction by a controlled radius — and one watertight surface is pulled
 * out of the result with naive surface nets. Normals come from the field's
 * gradient, so shading is continuous across what used to be a seam, and skin
 * weights are blended across the junction in the same way the surface is.
 *
 * Everything still happens at load, from numbers in source. No model files.
 */
import * as THREE from 'three';

const LUT = 96;
const FAR = 1e3;

/** Shape-preserving (Fritsch-Carlson) cubic, baked to a lookup table. */
function bakeSpline(xs, ys) {
  const n = xs.length;
  const out = new Float32Array(LUT + 1);
  if (n === 1) return out.fill(ys[0]);
  const d = [];
  for (let i = 0; i < n - 1; i += 1) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) { m.push(0); continue; }
    const h0 = xs[i] - xs[i - 1];
    const h1 = xs[i + 1] - xs[i];
    m.push((3 * (h0 + h1)) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]));
  }
  m.push(d[n - 2]);
  let seg = 0;
  for (let k = 0; k <= LUT; k += 1) {
    const x = xs[0] + ((xs[n - 1] - xs[0]) * k) / LUT;
    while (seg < n - 2 && x > xs[seg + 1]) seg += 1;
    const h = xs[seg + 1] - xs[seg];
    const s = (x - xs[seg]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    out[k] = (2 * s3 - 3 * s2 + 1) * ys[seg] + (s3 - 2 * s2 + s) * h * m[seg]
      + (-2 * s3 + 3 * s2) * ys[seg + 1] + (s3 - s2) * h * m[seg + 1];
  }
  return out;
}

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
 * A swept `[t, rx, rz, dz]` profile as a distance field. Same authoring format
 * as the lathes in player.js, so a profile can move between the two unchanged.
 *
 * `cap` picks how each end closes: `'flat'` is a hard plane (a hem), `'round'`
 * lets the profile's own taper close it.
 */
export function latheField({ origin, axis, hint, rings, unit = 1, power = 1, k = 0.02, cap = ['flat', 'flat'], weights }) {
  const ax = axis.clone().normalize();
  const f = frameFor(ax, hint || new THREE.Vector3(0, 0, 1));
  const ts = rings.map((r) => r[0]);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  const rxL = bakeSpline(ts, rings.map((r) => r[1]));
  const rzL = bakeSpline(ts, rings.map((r) => (r.length > 2 ? r[2] : r[1])));
  const dzL = bakeSpline(ts, rings.map((r) => (r.length > 3 ? r[3] : 0)));
  const e = 2 / power;
  const invE = 1 / e;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const scale = LUT / (t1 - t0);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= LUT; i += 1) {
    const t = t0 + (i / LUT) * (t1 - t0);
    const r = Math.max(rxL[i], rzL[i]) + Math.abs(dzL[i]);
    const c = [ox + ax.x * t * unit, oy + ax.y * t * unit, oz + ax.z * t * unit];
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], c[a] - r);
      max[a] = Math.max(max[a], c[a] + r);
    }
  }

  const dist = (px, py, pz) => {
    const qx = px - ox, qy = py - oy, qz = pz - oz;
    const t = (qx * ax.x + qy * ax.y + qz * ax.z) / unit;
    const tc = t < t0 ? t0 : t > t1 ? t1 : t;
    const fi = (tc - t0) * scale;
    const i = fi >= LUT ? LUT - 1 : fi | 0;
    const fr = fi - i;
    const rx = Math.max(rxL[i] + (rxL[i + 1] - rxL[i]) * fr, 0.0008);
    const rz = Math.max(rzL[i] + (rzL[i + 1] - rzL[i]) * fr, 0.0008);
    const dz = dzL[i] + (dzL[i + 1] - dzL[i]) * fr;
    const lx = qx * f.x.x + qy * f.x.y + qz * f.x.z;
    const lz = qx * f.z.x + qy * f.z.y + qz * f.z.z - dz;
    const len = Math.hypot(lx, lz);
    let dRad;
    if (len < 1e-6) dRad = -Math.min(rx, rz);
    else {
      const n = (Math.abs(lx / rx) ** e + Math.abs(lz / rz) ** e) ** invE;
      dRad = len - len / n;
    }
    const lo = (t0 - t) * unit;
    const hi = (t - t1) * unit;
    let d = dRad;
    if (cap[0] === 'flat') d = Math.max(d, lo);
    else if (lo > 0) d = Math.hypot(Math.max(dRad, 0), lo) + Math.min(dRad, 0);
    if (cap[1] === 'flat') d = Math.max(d, hi);
    else if (hi > 0) d = Math.hypot(Math.max(d, 0), hi) + Math.min(d, 0);
    return d;
  };
  return { dist, min, max, k, weights };
}

/** A tapered capsule from `a` (radius ra) to `b` (radius rb). */
export function capsuleField(a, b, ra, rb, { k = 0.004, weights } = {}) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz || 1e-9;
  const r = Math.max(ra, rb);
  const dist = (px, py, pz) => {
    const pax = px - a.x, pay = py - a.y, paz = pz - a.z;
    let h = (pax * bax + pay * bay + paz * baz) / l2;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - (ra + (rb - ra) * h);
  };
  return {
    dist,
    k,
    weights,
    min: [Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.min(a.z, b.z) - r],
    max: [Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r, Math.max(a.z, b.z) + r],
  };
}

/** A box with rounded edges, centred at `c`, in an orthonormal frame. */
export function roundBoxField(c, fx, fy, fz, half, round, { k = 0.004, weights } = {}) {
  const r = Math.hypot(half[0], half[1], half[2]) + round;
  const dist = (px, py, pz) => {
    const qx = px - c.x, qy = py - c.y, qz = pz - c.z;
    const x = Math.abs(qx * fx.x + qy * fx.y + qz * fx.z) - half[0];
    const y = Math.abs(qx * fy.x + qy * fy.y + qz * fy.z) - half[1];
    const z = Math.abs(qx * fz.x + qy * fz.y + qz * fz.z) - half[2];
    return Math.hypot(Math.max(x, 0), Math.max(y, 0), Math.max(z, 0)) + Math.min(Math.max(x, y, z), 0) - round;
  };
  return { dist, k, weights, min: [c.x - r, c.y - r, c.z - r], max: [c.x + r, c.y + r, c.z + r] };
}

function smin(a, b, k) {
  const h = k - Math.abs(a - b);
  return h <= 0 ? Math.min(a, b) : Math.min(a, b) - (h * h) / (4 * k);
}

/**
 * Meshes the smooth union of `fields` on a grid of `cell` metres.
 *
 * Returns a BufferGeometry with gradient normals and, when the fields carry a
 * `weights(p)` rule, four-bone skin attributes blended across every junction.
 */
export function meshFields(fields, { cell = 0.007, weightBlend = 0.02, skinned = true } = {}) {
  const pad = cell * 2;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const f of fields) {
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a], f.min[a]);
      hi[a] = Math.max(hi[a], f.max[a]);
    }
  }
  const n = [0, 1, 2].map((a) => Math.ceil((hi[a] - lo[a] + pad * 2) / cell) + 1);
  const org = lo.map((v) => v - pad);
  const [nx, ny, nz] = n;
  const grid = new Float32Array(nx * ny * nz).fill(FAR);

  // Each field only touches the grid points inside its own (padded) bounds.
  for (const f of fields) {
    const reach = f.k + cell;
    const i0 = [0, 1, 2].map((a) => Math.max(0, Math.floor((f.min[a] - reach - org[a]) / cell)));
    const i1 = [0, 1, 2].map((a) => Math.min(n[a] - 1, Math.ceil((f.max[a] + reach - org[a]) / cell)));
    for (let z = i0[2]; z <= i1[2]; z += 1) {
      const pz = org[2] + z * cell;
      for (let y = i0[1]; y <= i1[1]; y += 1) {
        const py = org[1] + y * cell;
        let idx = (z * ny + y) * nx + i0[0];
        for (let x = i0[0]; x <= i1[0]; x += 1, idx += 1) {
          grid[idx] = smin(grid[idx], f.dist(org[0] + x * cell, py, pz), f.k);
        }
      }
    }
  }

  const total = (px, py, pz) => {
    let d = FAR;
    for (const f of fields) {
      const r = f.k + 0.004;
      if (px < f.min[0] - r || px > f.max[0] + r || py < f.min[1] - r || py > f.max[1] + r
        || pz < f.min[2] - r || pz > f.max[2] + r) continue;
      d = smin(d, f.dist(px, py, pz), f.k);
    }
    return d;
  };

  // --- naive surface nets ------------------------------------------------
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const position = [];
  const corner = new Float32Array(8);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let z = 0; z < cz; z += 1) {
    for (let y = 0; y < cy; y += 1) {
      for (let x = 0; x < cx; x += 1) {
        const base = (z * ny + y) * nx + x;
        let mask = 0;
        for (let c = 0; c < 8; c += 1) {
          const v = grid[base + (c & 1) + ((c >> 1) & 1) * nx + ((c >> 2) & 1) * nx * ny];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, count = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          sx += (a & 1) + (((b & 1) - (a & 1)) * t);
          sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
          sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
          count += 1;
        }
        cellVert[(z * cy + y) * cx + x] = position.length / 3;
        position.push(org[0] + (x + sx / count) * cell, org[1] + (y + sy / count) * cell, org[2] + (z + sz / count) * cell);
      }
    }
  }

  const index = [];
  const cv = (x, y, z) => cellVert[(z * cy + y) * cx + x];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let z = 1; z < cz; z += 1) {
    for (let y = 1; y < cy; y += 1) {
      for (let x = 1; x < cx; x += 1) {
        const g = grid[(z * ny + y) * nx + x];
        const inside = g < 0;
        if ((grid[(z * ny + y) * nx + x + 1] < 0) !== inside) {
          quad(cv(x, y - 1, z - 1), cv(x, y, z - 1), cv(x, y, z), cv(x, y - 1, z), !inside);
        }
        if ((grid[(z * ny + y + 1) * nx + x] < 0) !== inside) {
          quad(cv(x - 1, y, z - 1), cv(x - 1, y, z), cv(x, y, z), cv(x, y, z - 1), !inside);
        }
        if ((grid[((z + 1) * ny + y) * nx + x] < 0) !== inside) {
          quad(cv(x - 1, y - 1, z), cv(x, y - 1, z), cv(x, y, z), cv(x - 1, y, z), !inside);
        }
      }
    }
  }

  // --- normals from the field itself, then pull each vertex onto it ---------
  const count = position.length / 3;
  const normal = new Float32Array(count * 3);
  const eps = 0.0015;
  for (let i = 0; i < count; i += 1) {
    let px = position[i * 3], py = position[i * 3 + 1], pz = position[i * 3 + 2];
    let gx = 0, gy = 0, gz = 0;
    // One Newton step sharpens what the cell-average smoothed away.
    for (let pass = 0; pass < 2; pass += 1) {
      gx = total(px + eps, py, pz) - total(px - eps, py, pz);
      gy = total(px, py + eps, pz) - total(px, py - eps, pz);
      gz = total(px, py, pz + eps) - total(px, py, pz - eps);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (pass === 0) {
        // Only where the field is smooth. On a hem the gradient flips between
        // the wall and the cap from one vertex to the next, and stepping along
        // it there frays a clean edge into a frill.
        const d = total(px, py, pz);
        const g2x = total(px + eps * 3, py, pz) - total(px - eps * 3, py, pz);
        const g2y = total(px, py + eps * 3, pz) - total(px, py - eps * 3, pz);
        const g2z = total(px, py, pz + eps * 3) - total(px, py, pz - eps * 3);
        const agree = (gx * g2x + gy * g2y + gz * g2z) / (Math.hypot(g2x, g2y, g2z) || 1);
        if (agree > 0.97 && Math.abs(d) < cell) { px -= gx * d; py -= gy * d; pz -= gz * d; }
      }
    }
    position[i * 3] = px; position[i * 3 + 1] = py; position[i * 3 + 2] = pz;
    normal[i * 3] = gx; normal[i * 3 + 1] = gy; normal[i * 3 + 2] = gz;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  geo.setIndex(index);

  if (skinned) {
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const acc = new Map();
    const p = new THREE.Vector3();
    const ds = new Float32Array(fields.length);
    for (let i = 0; i < count; i += 1) {
      p.set(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
      let dMin = Infinity;
      for (let fIdx = 0; fIdx < fields.length; fIdx += 1) {
        ds[fIdx] = fields[fIdx].dist(p.x, p.y, p.z);
        if (ds[fIdx] < dMin) dMin = ds[fIdx];
      }
      acc.clear();
      for (let fIdx = 0; fIdx < fields.length; fIdx += 1) {
        const s = Math.exp(-(ds[fIdx] - dMin) / weightBlend);
        if (s < 0.01 || !fields[fIdx].weights) continue;
        for (const [bone, w] of fields[fIdx].weights(p)) {
          if (w > 0) acc.set(bone, (acc.get(bone) || 0) + w * s);
        }
      }
      const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((t, [, w]) => t + w, 0) || 1;
      for (let j = 0; j < top.length; j += 1) {
        skinIndex[i * 4 + j] = top[j][0];
        skinWeight[i * 4 + j] = top[j][1] / sum;
      }
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  }
  return geo;
}
