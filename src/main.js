import { Game, STATE } from './core/game.js';
import { createSwipeInput } from './core/input.js';
import { AudioEngine, haptics } from './core/audio.js';
import { multiplierFor } from './core/combo.js';
import { Stage } from './render/three/stage.js';
import { PerfGovernor, LatencyProbe } from './core/perf.js';

const canvas = document.getElementById('stage');
const ui = {
  score: document.getElementById('score'),
  combo: document.getElementById('combo'),
  comboWrap: document.getElementById('combo-wrap'),
  comboFill: document.getElementById('combo-fill'),
  tier: document.getElementById('tier'),
  best: document.getElementById('best'),
  points: document.getElementById('points'),
  hint: document.getElementById('hint'),
  hintText: document.getElementById('hint-text'),
  flash: document.getElementById('flash'),
  overlay: document.getElementById('overlay'),
  finalScore: document.getElementById('final-score'),
  finalPoints: document.getElementById('final-points'),
  finalCombo: document.getElementById('final-combo'),
  finalBest: document.getElementById('final-best'),
  record: document.getElementById('record'),
  finalReason: document.getElementById('final-reason'),
  sound: document.getElementById('sound'),
};

const game = new Game();
// `?q=high|medium|low` forces a quality tier — used by the gates and handy for
// anyone debugging on a specific device.
const forced = new URLSearchParams(location.search).get('q');
const stage = new Stage(canvas, forced ? { quality: forced } : {});
const audio = new AudioEngine();
const latency = new LatencyProbe();
const governor = new PerfGovernor({
  quality: stage.quality,
  onChange: (quality) => stage.setQuality(quality),
});
// An explicit ?q= is a deliberate override; don't let the governor fight it.
if (forced) governor.enabled = false;

// --- feedback ------------------------------------------------------------

let flashTimer = 0;
function flash(text, tone) {
  ui.flash.textContent = text;
  ui.flash.dataset.tone = tone;
  ui.flash.style.opacity = '1';
  ui.flash.style.transform = 'translateY(0) scale(1)';
  flashTimer = 0.7;
}

let scoreHitTimer = 0;
function punchScore() {
  ui.score.classList.add('hit');
  scoreHitTimer = 0.09;
}

/**
 * One handler for every simulation event. Kick and whiff events are drained
 * synchronously inside the tap handler, so their audio, haptics and animation
 * all land on the impact frame with no added latency; everything else is
 * drained from the render loop.
 */
function handleEvent({ type, data }) {
  switch (type) {
    case 'kick': {
      stage.onKick(data);

      // Pitch and weight follow how hard it was swiped, tempered by how clean the timing was.
      const power = (data.grade === 'PERFECT' ? 1 : data.grade === 'GOOD' ? 0.7 : 0.45) * 0.5 + (data.power ?? 0.5) * 0.5;
      audio.strike(power);
      if (data.grade === 'PERFECT') audio.perfectChime(data.combo);
      haptics.strike(data.grade);

      if (data.grade === 'PERFECT') {
        flash(data.combo >= 4 ? `PERFECT ×${data.multiplier}` : 'PERFECT', 'perfect');
      } else if (data.grade === 'GOOD') {
        flash('GOOD', 'good');
      } else {
        flash('SCRAPPY', 'sloppy');
      }
      // Name the reason for any bonus so points never feel arbitrary.
      if (data.bonuses?.length) {
        const top = data.bonuses.reduce((a, b) => (b.points > a.points ? b : a));
        flash(`${top.name} +${top.points}`, 'perfect');
      }
      if (data.bonuses?.some((b) => b.name === 'RESCUE')) slowMo = 0.22;
      if (data.swipe !== false && Math.abs(data.side) > 0.05) learnedSwipe();
      punchScore();
      // The crowd warms up as a rally builds.
      audio.setCrowdLevel(Math.min(1, data.score / 45 + data.combo / 25));
      break;
    }

    case 'whiff':
      audio.whiff();
      haptics.fire(5);
      flash(data.outOfReach ? 'TOO FAR' : 'MISTIMED', 'sloppy');
      break;

    case 'milestone':
      flash(data.tier, 'tier');
      audio.cheer(1);
      haptics.milestone();
      break;

    case 'gameover':
      stage.onGameOver();
      audio.whistle();
      haptics.gameOver();
      ui.finalScore.textContent = String(data.score);
      ui.finalPoints.textContent = data.points.toLocaleString();
      ui.finalCombo.textContent = String(data.bestCombo);
      ui.finalBest.textContent = String(data.highScore);
      ui.finalReason.textContent = data.reason === 'out' ? 'Ball went out' : '';
      ui.record.classList.toggle('on', data.newRecord);
      ui.overlay.classList.add('visible');
      break;

    case 'start':
      stage.onRestart();
      audio.setCrowdLevel(0.12);
      ui.overlay.classList.remove('visible');
      break;

    default:
      break;
  }
}

function drainEvents() {
  for (const event of game.drainEvents()) handleEvent(event);
}

// --- input ---------------------------------------------------------------

// How many swipes the player has made, remembered so the hint stops nagging once learned.
const SWIPES_KEY = 'kickup.swipes.v1';
let swipesLearned = 0;
try { swipesLearned = Number(localStorage.getItem(SWIPES_KEY)) || 0; } catch { /* private mode */ }
function learnedSwipe() {
  swipesLearned += 1;
  try { localStorage.setItem(SWIPES_KEY, String(swipesLearned)); } catch { /* ignore */ }
}

// Aim preview fades as the tiers climb so experts are not handed the answer.
const aimAlpha = () => Math.max(0, 1 - game.tierIndex * 0.34);
let slowMo = 0; // seconds of slow motion left after a rescue

// The kick itself fires on release (direction does not exist before that), so
// pointerdown starts the anticipation: instant feedback with no ball contact yet.
createSwipeInput(canvas, {
  onStart() {
    audio.unlock();
    stage.setAim({ side: 0, power: 0.5 }, aimAlpha());
  },
  onMove(aim) {
    stage.setAim(aim, aimAlpha());
  },
  onCancel() {
    stage.setAim(null);
  },
  onRelease(input) {
    stage.setAim(null);
    audio.unlock();
    game.kick({ side: input.side, power: input.power });
    // Drain here, not next frame: this is the impact instant.
    drainEvents();
    latency.record(input.at, input.handledAt);
  },
});

ui.sound.addEventListener('click', (e) => {
  e.stopPropagation();
  audio.unlock();
  const muted = audio.enabled;
  audio.setMuted(muted);
  haptics.enabled = !muted;
  ui.sound.innerHTML = muted ? '&#9834;&#8416;' : '&#9835;';
  ui.sound.setAttribute('aria-pressed', String(muted));
});

window.addEventListener('resize', () => stage.resize());
window.addEventListener('orientationchange', () => setTimeout(() => stage.resize(), 60));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.setCrowdLevel(0);
});

// --- HUD -----------------------------------------------------------------

function syncHud() {
  ui.score.textContent = String(game.score);
  ui.best.textContent = String(game.highScore);
  ui.points.textContent = game.combo.points.toLocaleString();
  ui.tier.textContent = game.tier;
  ui.tier.dataset.level = String(game.tierIndex);

  const combo = game.combo.combo;
  ui.comboWrap.classList.toggle('on', combo >= 2);
  if (combo >= 2) {
    ui.combo.textContent = `${combo} COMBO ×${game.combo.multiplier}`;
    // Fill shows progress towards the next multiplier tier.
    const tiers = [4, 8, 12, 16];
    const next = tiers.find((t) => t > combo);
    const prev = [0, ...tiers].filter((t) => t <= combo).pop() ?? 0;
    const pct = next ? ((combo - prev) / (next - prev)) * 100 : 100;
    ui.comboFill.style.width = `${pct.toFixed(0)}%`;
  }

  ui.hint.style.opacity = game.state === STATE.READY ? '1' : '0';
  // Once a few swipes have landed the hint drops the animation and just says how to start.
  ui.hintText.textContent = swipesLearned >= 3 ? 'Tap to start' : 'Swipe to kick';
  ui.hint.classList.toggle('learned', swipesLearned >= 3);
}

// --- loop ----------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = (now - last) / 1000;
  last = now;

  // Capture/diagnostic tooling drives the stage by hand.
  if (window.__PAUSE__) {
    requestAnimationFrame(frame);
    return;
  }

  governor.sample(dt);
  // A rescue earns a beat of slow motion so the save registers.
  let simDt = dt;
  if (slowMo > 0) {
    slowMo -= dt;
    simDt = dt * 0.4;
  }
  game.advance(simDt);
  drainEvents();
  stage.update(game, simDt);
  stage.render(dt);
  syncHud();

  if (flashTimer > 0) {
    flashTimer -= dt;
    if (flashTimer <= 0) {
      ui.flash.style.opacity = '0';
      ui.flash.style.transform = 'translateY(-8px) scale(.9)';
    }
  }
  if (scoreHitTimer > 0) {
    scoreHitTimer -= dt;
    if (scoreHitTimer <= 0) ui.score.classList.remove('hit');
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__KICKUP__ = {
  game, stage, audio, haptics, STATE,
  handleEvent, drainEvents, syncHud, multiplierFor,
  governor, latency,
};
