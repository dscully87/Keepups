import { BALL_RADIUS, PLAY_HALF_WIDTH, SWEET_SPOT_Y } from '../core/constants.js';
import { GOOD_BAND } from '../core/combo.js';

const TIER_SKY = [
  ['#0b1d33', '#16405e'],
  ['#0d2436', '#1b5060'],
  ['#152036', '#3a4a72'],
  ['#22142c', '#63305a'],
];

/**
 * Phase 1/2 renderer: a flat 2D projection of the world. Deliberately thin —
 * it reads the simulation and draws, it never mutates game state.
 */
export class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.groundY = 0;
    this.pxPerMetre = 100;
    this.pulseAmount = 0;
    this.pulseTone = 'GOOD';
    this.resize();
  }

  /** One-shot visual kick from the game layer. */
  pulse(grade) {
    this.pulseTone = grade;
    this.pulseAmount = grade === 'PERFECT' ? 1 : grade === 'GOOD' ? 0.6 : 0.3;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    // Reserve the bottom 12% for the touchline, fit ~3.4m of air above it.
    this.groundY = h * 0.88;
    this.pxPerMetre = this.groundY / 3.4;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toScreen(x, y) {
    return {
      sx: this.width / 2 + x * this.pxPerMetre,
      sy: this.groundY - y * this.pxPerMetre,
    };
  }

  draw(game, dt = 1 / 60) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.pulseAmount = Math.max(0, this.pulseAmount - dt * 3.4);
    this.#drawBackground(ctx, game.tierIndex);
    this.#drawSweetSpot(ctx, game);
    this.#drawPlayer(ctx, game);
    this.#drawBall(ctx, game.ball);
  }

  #drawBackground(ctx, tierIndex = 0) {
    const [top, bottom] = TIER_SKY[Math.min(tierIndex, TIER_SKY.length - 1)];
    const sky = ctx.createLinearGradient(0, 0, 0, this.groundY);
    sky.addColorStop(0, top);
    sky.addColorStop(1, bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.width, this.groundY);

    const turf = ctx.createLinearGradient(0, this.groundY, 0, this.height);
    turf.addColorStop(0, '#2f7a3e');
    turf.addColorStop(1, '#1c4f28');
    ctx.fillStyle = turf;
    ctx.fillRect(0, this.groundY, this.width, this.height - this.groundY);

    // Play-area guides.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      const { sx } = this.toScreen(side * PLAY_HALF_WIDTH, 0);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.groundY);
      ctx.stroke();
    }
  }

  /** The timing band — the visual contract behind the combo system. */
  #drawSweetSpot(ctx, game) {
    const m = this.pxPerMetre;
    const top = this.groundY - (SWEET_SPOT_Y + GOOD_BAND) * m;
    const height = GOOD_BAND * 2 * m;
    const hot = 0.06 + this.pulseAmount * 0.18;
    ctx.fillStyle = `rgba(120, 240, 180, ${hot.toFixed(3)})`;
    ctx.fillRect(0, top, this.width, height);
    ctx.strokeStyle = `rgba(140, 250, 195, ${(0.18 + this.pulseAmount * 0.5).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, this.groundY - SWEET_SPOT_Y * m);
    ctx.lineTo(this.width, this.groundY - SWEET_SPOT_Y * m);
    ctx.stroke();
  }

  #drawPlayer(ctx, game) {
    const px = this.width / 2;
    const m = this.pxPerMetre;
    // Kick follow-through: the leg swings for ~220ms after contact.
    const since = game ? game.time - game.lastKickAt : 99;
    const swing = since >= 0 && since < 0.22 ? Math.sin((since / 0.22) * Math.PI) : 0;
    ctx.strokeStyle = '#eef4ff';
    ctx.lineWidth = Math.max(3, m * 0.045);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const y = (metres) => this.groundY - metres * m;

    // Head
    ctx.beginPath();
    ctx.arc(px, y(1.66), m * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    // Spine
    ctx.beginPath();
    ctx.moveTo(px, y(1.54));
    ctx.lineTo(px, y(0.95));
    ctx.stroke();
    // Arms
    ctx.beginPath();
    ctx.moveTo(px - m * 0.34, y(1.1));
    ctx.lineTo(px, y(1.42));
    ctx.lineTo(px + m * 0.34, y(1.14));
    ctx.stroke();
    // Legs — the right leg lifts towards the sweet spot as the kick fires.
    const kneeLift = swing * 0.34;
    const footLift = swing * SWEET_SPOT_Y;
    ctx.beginPath();
    ctx.moveTo(px - m * 0.2, y(0));
    ctx.lineTo(px, y(0.95));
    ctx.lineTo(px + m * (0.22 + swing * 0.18), y(footLift + kneeLift * 0.1));
    ctx.stroke();
  }

  #drawBall(ctx, ball) {
    const { sx, sy } = this.toScreen(ball.x, ball.y);
    const r = BALL_RADIUS * this.pxPerMetre;

    // Contact shadow, tightening as the ball approaches the turf.
    const drop = Math.max(0.05, Math.min(1, ball.y / 2.2));
    ctx.save();
    ctx.globalAlpha = 0.35 * (1 - drop) + 0.08;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(sx, this.groundY + r * 0.15, r * (1.5 - drop * 0.7), r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ball.rotation);
    ctx.fillStyle = '#f8f8f4';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // Panel hint so rotation reads at a glance.
    ctx.fillStyle = '#1b1b20';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.66, Math.sin(a) * r * 0.66, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
