import * as THREE from 'three';

/**
 * Procedural texture bakery. Everything the game renders is generated here at
 * load time — no network round-trips, no licensing, and the maps are authored
 * against the exact geometry they wrap.
 */

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The 32 panel centres of a truncated icosahedron: 12 pentagons sitting on the
 * icosahedron's vertices, 20 hexagons on its face centroids. A spherical
 * Voronoi over these points *is* the classic football panel layout.
 */
function panelCentres() {
  const verts = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      verts.push([0, s1 * 1, s2 * PHI], [s1 * 1, s2 * PHI, 0], [s1 * PHI, 0, s2 * 1]);
    }
  }
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const pentagons = verts.map(norm);

  // Face centroids: every triple of vertices mutually at the icosahedron's
  // edge length forms a face.
  const edge2 = 4 / (PHI * PHI + 1) + 1e-6; // squared edge length on unit sphere
  const hexagons = [];
  for (let i = 0; i < pentagons.length; i += 1) {
    for (let j = i + 1; j < pentagons.length; j += 1) {
      for (let k = j + 1; k < pentagons.length; k += 1) {
        const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        const [A, B, C] = [pentagons[i], pentagons[j], pentagons[k]];
        if (d(A, B) < edge2 && d(B, C) < edge2 && d(A, C) < edge2) {
          hexagons.push(norm([A[0] + B[0] + C[0], A[1] + B[1] + C[1], A[2] + B[2] + C[2]]));
        }
      }
    }
  }
  return { pentagons, hexagons };
}

/**
 * Bakes albedo + normal + roughness for a match ball into equirectangular
 * canvases matching THREE.SphereGeometry's default UV layout.
 */
export function makeBallTextures(size = 1024) {
  const w = size;
  const h = size / 2;
  const { pentagons, hexagons } = panelCentres();
  const centres = pentagons.concat(hexagons);
  const isPentagon = centres.map((_, i) => i < pentagons.length);
  const n = centres.length;

  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const cz = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    cx[i] = centres[i][0];
    cy[i] = centres[i][1];
    cz[i] = centres[i][2];
  }

  // seamField[i] = 0 deep in a groove, 1 in the middle of a panel.
  const seamField = new Float32Array(w * h);
  const owner = new Int32Array(w * h);

  for (let y = 0; y < h; y += 1) {
    // Match SphereGeometry: v=0 at +Y pole, u wraps around Y.
    const phi = (y / (h - 1)) * Math.PI;
    const sp = Math.sin(phi);
    const py = Math.cos(phi);
    for (let x = 0; x < w; x += 1) {
      const theta = (x / w) * Math.PI * 2;
      const px = sp * Math.cos(theta);
      const pz = sp * Math.sin(theta);

      let best = -2;
      let second = -2;
      let bestI = 0;
      for (let i = 0; i < n; i += 1) {
        const d = px * cx[i] + py * cy[i] + pz * cz[i];
        if (d > best) {
          second = best;
          best = d;
          bestI = i;
        } else if (d > second) {
          second = d;
        }
      }
      const idx = y * w + x;
      owner[idx] = bestI;
      // Distance to the Voronoi boundary, smoothed into a groove profile.
      const gap = best - second;
      seamField[idx] = Math.min(1, gap / 0.055);
    }
  }

  // --- albedo -----------------------------------------------------------
  const albedo = document.createElement('canvas');
  albedo.width = w;
  albedo.height = h;
  const aImg = albedo.getContext('2d').createImageData(w, h);
  // --- roughness --------------------------------------------------------
  const rough = document.createElement('canvas');
  rough.width = w;
  rough.height = h;
  const rImg = rough.getContext('2d').createImageData(w, h);

  for (let i = 0; i < w * h; i += 1) {
    const s = seamField[i];
    const groove = smoothstep(0, 0.75, s);
    const pent = isPentagon[owner[i]];
    // Subtle leather grain.
    const grain = (hash2(i % w, (i / w) | 0) - 0.5) * 12;

    const base = pent ? 26 : 244;
    const shade = base * (0.35 + 0.65 * groove) + grain;
    const o = i * 4;
    aImg.data[o] = clamp255(shade + (pent ? 4 : 2));
    aImg.data[o + 1] = clamp255(shade + (pent ? 5 : 3));
    aImg.data[o + 2] = clamp255(shade * (pent ? 1.15 : 1.0));
    aImg.data[o + 3] = 255;

    // Grooves are matte, panels are polished leather.
    const r = 255 * (0.92 - 0.62 * groove) + grain * 0.4;
    rImg.data[o] = rImg.data[o + 1] = rImg.data[o + 2] = clamp255(r);
    rImg.data[o + 3] = 255;
  }
  albedo.getContext('2d').putImageData(aImg, 0, 0);
  rough.getContext('2d').putImageData(rImg, 0, 0);

  // --- normal map from the groove height field --------------------------
  const normal = document.createElement('canvas');
  normal.width = w;
  normal.height = h;
  const nImg = normal.getContext('2d').createImageData(w, h);
  const heightAt = (x, y) => {
    const xx = ((x % w) + w) % w;
    const yy = Math.max(0, Math.min(h - 1, y));
    return smoothstep(0, 0.75, seamField[yy * w + xx]);
  };
  const strength = 2.6;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
      const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      nImg.data[o] = clamp255(((-dx / len) * 0.5 + 0.5) * 255);
      nImg.data[o + 1] = clamp255(((-dy / len) * 0.5 + 0.5) * 255);
      nImg.data[o + 2] = clamp255((1 / len) * 0.5 * 255 + 127);
      nImg.data[o + 3] = 255;
    }
  }
  normal.getContext('2d').putImageData(nImg, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const normalMap = new THREE.CanvasTexture(normal);
  const roughnessMap = new THREE.CanvasTexture(rough);
  for (const t of [map, normalMap, roughnessMap]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
  }
  return { map, normalMap, roughnessMap };
}

/** Mown turf with mower stripes, blade noise and a touchline. */
export function makeTurfTexture(size = 1024, stripes = 10) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const bandHeight = size / stripes;

  for (let y = 0; y < size; y += 1) {
    const band = Math.floor(y / bandHeight) % 2;
    for (let x = 0; x < size; x += 1) {
      // Two-octave blade noise.
      const n =
        hash2(x * 3.1, y * 3.1) * 0.55 +
        hash2(Math.floor(x / 4), Math.floor(y / 4)) * 0.45;
      const lift = band ? 1.13 : 0.9;
      const o = (y * size + x) * 4;
      img.data[o] = clamp255((34 + n * 26) * lift);
      img.data[o + 1] = clamp255((104 + n * 44) * lift);
      img.data[o + 2] = clamp255((44 + n * 24) * lift);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

/** Packed-crowd texture for the stands: coloured speckle with dark aisles. */
export function makeCrowdTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, size, size);
  const palette = ['#e8e8ef', '#c33a3a', '#2b4d8f', '#e2b93b', '#3c8d5a', '#8a4bbf', '#1c1f27', '#d9762f'];
  const rows = 46;
  const cols = 76;
  for (let r = 0; r < rows; r += 1) {
    for (let cIdx = 0; cIdx < cols; cIdx += 1) {
      if (hash2(r * 7 + 1, cIdx * 3 + 5) < 0.06) continue; // empty seats
      const x = (cIdx / cols) * size + (hash2(cIdx, r) - 0.5) * 3;
      const y = (r / rows) * size + (hash2(r, cIdx) - 0.5) * 3;
      ctx.fillStyle = palette[Math.floor(hash2(cIdx * 13, r * 17) * palette.length) % palette.length];
      const w = size / cols;
      ctx.globalAlpha = 0.55 + hash2(r, cIdx * 2) * 0.45;
      ctx.fillRect(x, y, w * 0.78, (size / rows) * 0.62);
    }
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Soft radial sprite used for dust, grass motes and light bloom points. */
export function makeSpriteTexture(size = 64, hardness = 0.35) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * hardness * 0.2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(hardness, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// --- small helpers -------------------------------------------------------

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Cheap deterministic 2D hash in [0,1). */
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
