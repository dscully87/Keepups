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
      const lift = band ? 1.11 : 0.92;
      const o = (y * size + x) * 4;
      img.data[o] = clamp255((30 + n * 20) * lift);
      img.data[o + 1] = clamp255((76 + n * 32) * lift);
      img.data[o + 2] = clamp255((38 + n * 18) * lift);
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
  ctx.fillStyle = '#070911';
  ctx.fillRect(0, 0, size, size);
  // Muted and mostly dark: a real crowd at night is a texture, not confetti.
  const palette = ['#b9bdcc', '#a44a4c', '#4a5f8f', '#b39a55', '#4f7860', '#5d4d74', '#20232c', '#9c6c50'];
  const rows = 46;
  const cols = 76;
  for (let r = 0; r < rows; r += 1) {
    for (let cIdx = 0; cIdx < cols; cIdx += 1) {
      if (hash2(r * 7 + 1, cIdx * 3 + 5) < 0.06) continue; // empty seats
      const x = (cIdx / cols) * size + (hash2(cIdx, r) - 0.5) * 3;
      const y = (r / rows) * size + (hash2(r, cIdx) - 0.5) * 3;
      ctx.fillStyle = palette[Math.floor(hash2(cIdx * 13, r * 17) * palette.length) % palette.length];
      const w = size / cols;
      ctx.globalAlpha = 0.45 + hash2(r, cIdx * 2) * 0.45;
      ctx.fillRect(x, y, w * 0.78, (size / rows) * 0.62);
    }
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Perimeter LED hoardings: bright colour blocks with abstract lettering. */
export function makeAdBoardTexture(width = 1024) {
  const h = Math.round(width / 12);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h;
  const ctx = c.getContext('2d');
  const panels = ['#0e2f6b', '#c0272d', '#12805a', '#e0a80f', '#1b1d24', '#7a2f8f'];
  const panelWidth = width / panels.length;

  panels.forEach((colour, i) => {
    const x = i * panelWidth;
    ctx.fillStyle = colour;
    ctx.fillRect(x, 0, panelWidth, h);
    // Abstract "sponsor" marks — legible as lettering at broadcast distance
    // without inventing a real brand.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    const glyphs = 3 + Math.floor(hash2(i * 5, 11) * 4);
    const gw = panelWidth / (glyphs * 2.4);
    for (let g = 0; g < glyphs; g += 1) {
      const gx = x + panelWidth * 0.18 + g * gw * 1.7;
      const gh = h * (0.3 + hash2(i, g) * 0.16);
      ctx.fillRect(gx, (h - gh) / 2, gw, gh);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, h * 0.86, panelWidth, h * 0.14);
  });

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The face.
 *
 * Painted rather than modelled. Eyes, brows and a mouth built out of geometry
 * cost thousands of triangles and still shade badly at the size a phone
 * actually draws this head; painted onto the skull's own equirectangular UVs
 * they stay crisp at the closeup and collapse into readable dark marks — which
 * is exactly what you want — once the head is thirty pixels tall.
 *
 * The whole map is authored in *degrees off the front of the head*, because
 * that is the only coordinate the geometry and the paint can agree on:
 *  - yaw  0° is dead ahead (+z), positive towards +x,
 *  - pitch 0° is the equator of the skull, positive up.
 * THREE.SphereGeometry puts +z at u = 0.25 and the equator at v = 0.5, and one
 * degree is W/360 pixels in *both* axes, so the mapping below is exact.
 */
export function makeFaceTexture(size = 1024, hairlinePhi = null) {
  const W = size;
  const H = size >> 1;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  const PPD = W / 360;
  const X = (yaw) => W * 0.25 + yaw * PPD;
  const Y = (pitch) => H * 0.5 - pitch * PPD;
  const D = (deg) => deg * PPD;

  // The skin material is untextured and flat-coloured; the head has to land on
  // the same value or the neck seam shows, so the base fill *is* that colour.
  const SKIN = '#b08054';
  ctx.fillStyle = SKIN;
  ctx.fillRect(0, 0, W, H);

  /** Soft elliptical wash — the only shading tool, so nothing has a hard edge. */
  const wash = (yaw, pitch, rw, rh, colour, alpha) => {
    ctx.save();
    ctx.translate(X(yaw), Y(pitch));
    ctx.scale(1, rh / rw);
    const r = D(rw);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(${colour},${alpha})`);
    g.addColorStop(0.55, `rgba(${colour},${alpha * 0.62})`);
    g.addColorStop(1, `rgba(${colour},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const SHADOW = '74,44,26';
  const WARM = '176,96,60';

  // --- the fade ------------------------------------------------------------
  // The scalp is darkened to a shaved fade under the authored hairline. The
  // hair shell is only five millimetres proud at its rim, so without this the
  // strip of lit scalp peeping out below it reads as a bright seam right round
  // the nape; with it, the geometry rim and the paint agree and the edge of
  // the crop reads even where the shell is too thin to cast anything.
  if (hairlinePhi) {
    const lineAt = new Float32Array(W);
    for (let x = 0; x < W; x += 1) {
      let delta = (x / W) * 360 - 90; // canvas x = W/4 is dead ahead
      delta = ((delta + 540) % 360) - 180;
      lineAt[x] = hairlinePhi(delta);
    }
    const img = ctx.getImageData(0, 0, W, H);
    for (let y = 0; y < H; y += 1) {
      const phi = (y / H) * 180;
      for (let x = 0; x < W; x += 1) {
        const t = smoothstep(lineAt[x] + 7.5, lineAt[x] - 2.5, phi);
        if (t <= 0) continue;
        const k = 1 - 0.72 * t;
        const o = (y * W + x) * 4;
        img.data[o] *= k;
        img.data[o + 1] *= k;
        img.data[o + 2] *= k;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // --- modelling passes, painted before any feature -----------------------
  wash(0, 26, 32, 14, SHADOW, 0.08);        // under the hairline
  // Counter-shading under the jaw. Every light in this scene is 45° up, so the
  // underside of a jaw loses all of them at once; lifting the albedo there by
  // a sixth is what keeps a modelled jaw from reading as a painted-on beard.
  wash(0, -35, 24, 14, '236,196,158', 0.17);
  for (const s of [-1, 1]) {
    wash(s * 27, -6, 14, 18, SHADOW, 0.12); // the plane turning away at the side
    wash(s * 15, -14, 11, 9, WARM, 0.15);   // cheek
    wash(s * 5.5, -9, 5, 9, SHADOW, 0.13);  // side of the nose
    wash(s * 16, -6.0, 8, 4, SHADOW, 0.10); // under the eye
    wash(s * 17, 2.5, 10, 6, SHADOW, 0.19); // eye socket, under the brow ridge
    // A day's stubble along the jaw. It has to stay under about 6% or the
    // lit half of the face reads as clean and the shaded half as a beard.
    wash(s * 20, -30, 13, 11, '58,42,30', 0.038);
  }
  wash(0, -16, 9, 5, SHADOW, 0.12);         // under the nose
  wash(0, -32, 12, 9, '58,42,30', 0.038);   // chin, same stubble
  wash(0, -31, 8, 4, SHADOW, 0.10);         // under the lower lip
  wash(0, -21, 10, 5, '182,136,102', 0.20); // and a clear upper lip above it

  // --- eyes ---------------------------------------------------------------
  const EYE_YAW = 17.2;
  const EYE_PITCH = -2.0;
  const EYE_HW = 8.8;   // half width
  const EYE_UP = 4.7;   // lid arch above centre
  const EYE_DN = 3.3;

  const eyePath = (s) => {
    const cx = X(s * EYE_YAW);
    const cy = Y(EYE_PITCH);
    const hw = D(EYE_HW);
    const inner = { x: cx - s * hw, y: cy + D(0.9) };
    const outer = { x: cx + s * hw, y: cy - D(0.7) };
    ctx.beginPath();
    ctx.moveTo(inner.x, inner.y);
    ctx.bezierCurveTo(
      cx - s * hw * 0.45, cy - D(EYE_UP),
      cx + s * hw * 0.30, cy - D(EYE_UP * 1.02),
      outer.x, outer.y,
    );
    ctx.bezierCurveTo(
      cx + s * hw * 0.45, cy + D(EYE_DN * 0.92),
      cx - s * hw * 0.50, cy + D(EYE_DN),
      inner.x, inner.y,
    );
    ctx.closePath();
    return { cx, cy, hw, inner, outer };
  };

  for (const s of [-1, 1]) {
    const e = eyePath(s);
    ctx.fillStyle = '#efe9df';
    ctx.fill();

    // Iris and pupil, clipped to the eye opening so the lid cuts them off at
    // the top the way a real lid does — a full circle floating in the white is
    // the single most doll-like thing you can paint.
    ctx.save();
    eyePath(s);
    ctx.clip();
    const ix = e.cx + s * D(0.5);
    const iy = e.cy - D(0.3);
    const ir = D(4.0);
    const g = ctx.createRadialGradient(ix, iy - ir * 0.3, ir * 0.15, ix, iy, ir);
    g.addColorStop(0, '#6b4526');
    g.addColorStop(0.62, '#3f2714');
    g.addColorStop(1, '#1d1209');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0704';
    ctx.beginPath();
    ctx.arc(ix, iy, ir * 0.44, 0, Math.PI * 2);
    ctx.fill();
    // Upper lid casts onto the eyeball.
    ctx.fillStyle = 'rgba(24,14,8,0.34)';
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy - D(EYE_UP), D(EYE_HW), D(EYE_UP * 0.62), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(ix - s * ir * 0.34, iy - ir * 0.42, ir * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Lash line. Thick, dark, and carried past the outer corner: at distance
    // this is the mark that still says "eye" after everything else has blurred.
    ctx.save();
    ctx.strokeStyle = '#160d07';
    ctx.lineWidth = D(1.9);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e.inner.x + s * D(0.4), e.inner.y - D(0.6));
    ctx.bezierCurveTo(
      e.cx - s * e.hw * 0.45, e.cy - D(EYE_UP * 1.05),
      e.cx + s * e.hw * 0.30, e.cy - D(EYE_UP * 1.08),
      e.outer.x + s * D(0.9), e.outer.y + D(0.2),
    );
    ctx.stroke();
    // Lower lid: a light edge, not a line.
    ctx.strokeStyle = 'rgba(206,150,106,0.55)';
    ctx.lineWidth = D(0.8);
    ctx.beginPath();
    ctx.moveTo(e.inner.x, e.inner.y + D(0.5));
    ctx.bezierCurveTo(
      e.cx - s * e.hw * 0.5, e.cy + D(EYE_DN * 1.15),
      e.cx + s * e.hw * 0.45, e.cy + D(EYE_DN * 1.05),
      e.outer.x, e.outer.y + D(0.9),
    );
    ctx.stroke();
    ctx.restore();

    // --- brow -------------------------------------------------------------
    const b0 = { x: X(s * 7.0), y: Y(5.6) };   // inner head, low
    const b1 = { x: X(s * 17.5), y: Y(9.2) };  // arch
    const b2 = { x: X(s * 27.5), y: Y(6.6) };  // tail, dropping away
    ctx.fillStyle = '#241710';
    ctx.beginPath();
    ctx.moveTo(b0.x, b0.y + D(2.1));
    ctx.quadraticCurveTo(b1.x, b1.y + D(2.4), b2.x, b2.y + D(0.8));
    ctx.quadraticCurveTo(b1.x, b1.y - D(1.5), b0.x, b0.y - D(1.2));
    ctx.closePath();
    ctx.fill();
  }

  // --- mouth --------------------------------------------------------------
  const MP = -28.5;
  const MW = 11.0;
  ctx.save();
  ctx.strokeStyle = '#472418';
  ctx.lineWidth = D(1.8);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(X(-MW), Y(MP + 0.5));
  ctx.bezierCurveTo(X(-MW * 0.35), Y(MP - 1.1), X(MW * 0.35), Y(MP - 1.1), X(MW), Y(MP + 0.5));
  ctx.stroke();
  ctx.restore();
  wash(0, MP - 2.8, 8.5, 3.2, '198,132,102', 0.34);  // lower lip catching light
  wash(0, MP + 2.4, 8.0, 2.4, '150,92,62', 0.26);    // upper lip, in shadow

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
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
