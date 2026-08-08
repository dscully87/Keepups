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
      // performance.now() at dispatch beats reading it inside the game loop.
      at: event.timeStamp || performance.now(),
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
