import { Game } from './core/game.js';
import { createTapInput } from './core/input.js';
import { Canvas2DRenderer } from './render/canvas2d.js';

const canvas = document.getElementById('stage');
const scoreEl = document.getElementById('score');

const game = new Game();
const renderer = new Canvas2DRenderer(canvas);

createTapInput(canvas, () => {
  game.tap();
});

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 60));

let last = performance.now();
function frame(now) {
  const dt = (now - last) / 1000;
  last = now;
  game.advance(dt);
  game.drainEvents();
  renderer.draw(game);
  scoreEl.textContent = String(game.score);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Test hook for the automated quality gates.
window.__KICKUP__ = { game, renderer };
