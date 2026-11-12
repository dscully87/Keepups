import {
  SWIPE_MIN_DISTANCE,
  SWIPE_MAX_TIME,
  SWIPE_WINDOW,
  SWIPE_SPEED_MIN,
  SWIPE_SPEED_MAX,
  TAP_POWER,
} from './constants.js';

/**
 * Lowest-latency tap source available on mobile browsers: `pointerdown` on the
 * capture phase, with `touch-action: none` handled in CSS so the browser never
 * waits ~300ms to decide whether the gesture was a scroll or a double-tap zoom.
 */
export function createTapInput(target, onTap) {
  const handler = (event) => {
    // Ignore secondary mouse buttons; every touch/pen contact counts.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    onTap({
      x: event.clientX,
      y: event.clientY,
      // The event's own timestamp is when the browser saw the touch; reading
      // performance.now() here would already include our handler's cost.
      at: event.timeStamp || performance.now(),
      handledAt: performance.now(),
      pointerType: event.pointerType || 'touch',
    });
  };

  const keyHandler = (event) => {
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    if (event.repeat) return;
    event.preventDefault();
    onTap({ x: null, y: null, at: performance.now(), pointerType: 'key' });
  };

  target.addEventListener('pointerdown', handler, { capture: true });
  window.addEventListener('keydown', keyHandler);
  // Belt and braces on iOS Safari, where a stray gesture can still scroll.
  target.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  target.addEventListener('contextmenu', (e) => e.preventDefault());

  return () => {
    target.removeEventListener('pointerdown', handler, { capture: true });
    window.removeEventListener('keydown', keyHandler);
  };
}

// --- swipe input -------------------------------------------------------------

const MAX_SAMPLES = 24;

/**
 * Pure maths: turn the tail of a pointer trail into a normalised aim. Kept separate
 * from the DOM so a gate can feed it synthetic trails.
 *
 * Only the last SWIPE_WINDOW seconds count — people wind up before they flick, and
 * using the whole path makes kicks feel mushy and late. Speed is divided by the
 * viewport height so every screen size feels the same.
 *
 * @param {Float64Array} ts @param {Float64Array} xs @param {Float64Array} ys
 * @param {number} count samples stored (oldest first)
 * @param {number} releaseAt ms timestamp of release
 * @param {number} viewportHeight CSS px
 * @returns {{side:number, power:number, swipe:boolean}}
 */
export function aimFromTrail(ts, xs, ys, count, releaseAt, viewportHeight, out = { side: 0, power: TAP_POWER, swipe: false }) {
  out.side = 0;
  out.power = TAP_POWER;
  out.swipe = false;
  if (count < 2) return out;

  const last = count - 1;
  const windowMs = SWIPE_WINDOW * 1000;
  let first = last;
  while (first > 0 && ts[last] - ts[first - 1] <= windowMs) first -= 1;
  if (first === last) first = last - 1;

  const dx = xs[last] - xs[first];
  const dy = ys[last] - ys[first];
  const dist = Math.hypot(dx, dy);
  const dtSec = Math.max(0.016, (ts[last] - ts[first]) / 1000);
  const rested = releaseAt - ts[last] > windowMs && ts[last] - ts[0] > SWIPE_MAX_TIME * 1000;
  if (dist < SWIPE_MIN_DISTANCE || rested) return out;

  const speed = dist / dtSec / Math.max(1, viewportHeight);
  out.side = Math.max(-1, Math.min(1, dx / dist));
  out.power = Math.max(0, Math.min(1, (speed - SWIPE_SPEED_MIN) / (SWIPE_SPEED_MAX - SWIPE_SPEED_MIN)));
  out.swipe = true;
  return out;
}

/**
 * Swipe-to-kick input. The kick fires on `pointerup` because direction does not exist
 * until the finger moves; so that the game still feels instant, `onStart` fires on
 * `pointerdown` and the caller starts the anticipation (aim preview, wind-up) there.
 * `onMove` receives the live aim for the preview. Keyboard: Space/Enter kicks straight,
 * arrow keys held at that moment add direction.
 */
export function createSwipeInput(target, { onStart, onMove, onRelease, onCancel }) {
  const ts = new Float64Array(MAX_SAMPLES);
  const xs = new Float64Array(MAX_SAMPLES);
  const ys = new Float64Array(MAX_SAMPLES);
  const aim = { side: 0, power: TAP_POWER, swipe: false };
  let count = 0;
  let activeId = null;
  const held = { left: false, right: false };

  const push = (t, x, y) => {
    if (count === MAX_SAMPLES) {
      ts.copyWithin(0, 1);
      xs.copyWithin(0, 1);
      ys.copyWithin(0, 1);
      count -= 1;
    }
    ts[count] = t;
    xs[count] = x;
    ys[count] = y;
    count += 1;
  };

  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activeId !== null) return;
    e.preventDefault();
    activeId = e.pointerId;
    count = 0;
    push(e.timeStamp || performance.now(), e.clientX, e.clientY);
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
    onStart?.({ x: e.clientX, y: e.clientY, at: e.timeStamp || performance.now(), handledAt: performance.now() });
  };

  const move = (e) => {
    if (e.pointerId !== activeId) return;
    push(e.timeStamp || performance.now(), e.clientX, e.clientY);
    if (onMove) {
      aimFromTrail(ts, xs, ys, count, ts[count - 1], target.clientHeight || innerHeight, aim);
      onMove(aim);
    }
  };

  const up = (e) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    const at = e.timeStamp || performance.now();
    push(at, e.clientX, e.clientY);
    const result = aimFromTrail(ts, xs, ys, count, at, target.clientHeight || innerHeight, { side: 0, power: TAP_POWER, swipe: false });
    onRelease({ ...result, at, handledAt: performance.now(), pointerType: e.pointerType || 'touch' });
  };

  const cancel = (e) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    onCancel?.();
  };

  const keyDown = (e) => {
    if (e.code === 'ArrowLeft') held.left = true;
    if (e.code === 'ArrowRight') held.right = true;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if (e.repeat) return;
    e.preventDefault();
    const at = performance.now();
    onRelease({
      side: (held.right ? 1 : 0) - (held.left ? 1 : 0),
      power: TAP_POWER,
      swipe: held.left || held.right,
      at,
      handledAt: at,
      pointerType: 'key',
    });
  };
  const keyUp = (e) => {
    if (e.code === 'ArrowLeft') held.left = false;
    if (e.code === 'ArrowRight') held.right = false;
  };

  target.addEventListener('pointerdown', down, { capture: true });
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  target.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  target.addEventListener('contextmenu', (e) => e.preventDefault());

  return () => {
    target.removeEventListener('pointerdown', down, { capture: true });
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
  };
}
