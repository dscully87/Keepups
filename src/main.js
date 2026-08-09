import { Game, STATE } from './core/game.js';
import { createTapInput } from './core/input.js';
import { Canvas2DRenderer } from './render/canvas2d.js';

const canvas = document.getElementById('stage');
const ui = {
  score: document.getElementById('score'),
  combo: document.getElementById('combo'),
  tier: document.getElementById('tier'),
  best: document.getElementById('best'),
  points: document.getElementById('points'),
  hint: document.getElementById('hint'),
  flash: document.getElementById('flash'),
  overlay: document.getElementById('overlay'),
  finalScore: document.getElementById('final-score'),
  finalMeta: document.getElementById('final-meta'),
};

const game = new Game();
const renderer = new Canvas2DRenderer(canvas);

createTapInput(canvas, () => game.tap());

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 60));

let flashTimer = 0;
function flash(text, tone) {
  ui.flash.textContent = text;
  ui.flash.dataset.tone = tone;
  ui.flash.style.opacity = '1';
  ui.flash.style.transform = 'translateY(0) scale(1)';
  flashTimer = 0.75;
}

function handleEvents() {
  for (const { type, data } of game.drainEvents()) {
    if (type === 'kick') {
      if (data.grade === 'PERFECT') flash(data.combo >= 4 ? `PERFECT ×${data.multiplier}` : 'PERFECT', 'perfect');
      else if (data.grade === 'GOOD') flash('GOOD', 'good');
      else flash('SCRAPPY', 'sloppy');
      renderer.pulse(data.grade);
    } else if (type === 'whiff') {
      flash('MISTIMED', 'sloppy');
    } else if (type === 'milestone') {
      flash(data.tier, 'tier');
    } else if (type === 'gameover') {
      ui.overlay.classList.add('visible');
      ui.finalScore.textContent = String(data.score);
      ui.finalMeta.textContent = data.newRecord
        ? `NEW BEST · ${data.points.toLocaleString()} pts · best combo ${data.bestCombo}`
        : `Best ${data.highScore} · ${data.points.toLocaleString()} pts · best combo ${data.bestCombo}`;
    } else if (type === 'start') {
      ui.overlay.classList.remove('visible');
    }
  }
}

function syncHud() {
  ui.score.textContent = String(game.score);
  ui.best.textContent = String(game.highScore);
  ui.points.textContent = game.combo.points.toLocaleString();
  ui.tier.textContent = game.tier;
  ui.tier.dataset.level = String(game.tierIndex);
  const showCombo = game.combo.combo >= 2;
  ui.combo.style.opacity = showCombo ? '1' : '0';
  ui.combo.textContent = `${game.combo.combo} COMBO ×${game.combo.multiplier}`;
  ui.hint.style.opacity = game.state === STATE.READY ? '1' : '0';
}

let last = performance.now();
function frame(now) {
  const dt = (now - last) / 1000;
  last = now;

  game.advance(dt);
  handleEvents();
  renderer.draw(game, dt);
  syncHud();

  if (flashTimer > 0) {
    flashTimer -= dt;
    if (flashTimer <= 0) {
      ui.flash.style.opacity = '0';
      ui.flash.style.transform = 'translateY(-10px) scale(.92)';
    }
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__KICKUP__ = { game, renderer, STATE };
