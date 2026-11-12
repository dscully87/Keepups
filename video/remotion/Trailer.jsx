/**
 * The trailer's master edit.
 *
 * Three things are cut together here:
 *  - gameplay captured from the real game by ../capture.mjs,
 *  - the end card, a HyperFrames composition rendered from ../hyperframes,
 *  - overlays drawn by this file from capture.json — the score, the grade of
 *    every touch and the combo are the values the game itself produced on
 *    that frame, not numbers typed into an edit.
 */
import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, spring, staticFile,
  useCurrentFrame, useVideoConfig,
} from 'remotion';

const INK = '#eef0f4';
const NAVY = '#17275c';
const CORAL = '#ff5a4f';
const GOLD = '#ffd34d';
const ENDCARD_FRAMES = 108; // 3.6 s, the HyperFrames root duration
const FILL = { width: '100%', height: '100%', objectFit: 'cover' };
const SHOT_ORDER = ['rally', 'boot', 'hero'];

export function timeline(capture) {
  let at = 0;
  const shots = SHOT_ORDER.map((name) => {
    const shot = { name, from: at, frames: capture.shots[name].frames, data: capture.shots[name] };
    at += shot.frames;
    return shot;
  });
  return { shots, endcard: at, total: at + ENDCARD_FRAMES };
}

/** Fonts are local files, so a render never depends on a font CDN. */
function useFonts() {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    const faces = [
      new FontFace('Archivo Black', `url(${staticFile('fonts/archivo-black.woff2')})`),
      new FontFace('Inter', `url(${staticFile('fonts/inter-800.woff2')})`, { weight: '800' }),
    ];
    Promise.all(faces.map((f) => f.load())).then((loaded) => {
      loaded.forEach((f) => document.fonts.add(f));
      continueRender(handle);
    });
  }, [handle]);
}

/** The most recent kick at or before `frame`, and how many frames ago it landed. */
function lastKick(perFrame, frame) {
  for (let f = Math.min(frame, perFrame.length - 1); f >= 0; f -= 1) {
    if (perFrame[f].kicks.length) return { kick: perFrame[f].kicks[perFrame[f].kicks.length - 1], age: frame - f };
  }
  return null;
}

const Score = ({ data, from = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const now = data.perFrame[Math.min(frame, data.perFrame.length - 1)];
  const hit = lastKick(data.perFrame, frame);
  // The numeral takes the impact: it punches up on the frame the boot lands.
  const punch = hit ? spring({ frame: hit.age, fps, config: { damping: 9, stiffness: 220, mass: 0.5 } }) : 1;
  const scale = hit ? interpolate(punch, [0, 1], [1.28, 1]) : 1;
  if (frame < from) return null;
  const fadeIn = interpolate(frame, [from, from + 5], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', top: 196, width: '100%', textAlign: 'center', color: INK, opacity: fadeIn }}>
      <div style={{
        fontFamily: 'Archivo Black', fontSize: 250, lineHeight: 1, transform: `scale(${scale})`,
        textShadow: '0 8px 40px rgba(0,0,0,0.55)',
      }}>
        {now.score}
      </div>
      <div style={{ fontFamily: 'Inter', fontWeight: 800, fontSize: 34, letterSpacing: 12, marginTop: 6, opacity: 0.85 }}>
        KEEP-UPS
      </div>
      {now.combo >= 2 ? (
        <div style={{
          display: 'inline-block', marginTop: 26, padding: '10px 26px', borderRadius: 40,
          background: now.multiplier > 1 ? CORAL : 'rgba(10,18,48,0.72)',
          fontFamily: 'Inter', fontWeight: 800, fontSize: 36, letterSpacing: 3,
        }}>
          {now.combo} COMBO{now.multiplier > 1 ? `  ×${now.multiplier}` : ''}
        </div>
      ) : null}
    </div>
  );
};

/** PERFECT / GOOD, thrown up from the ball on the frame of contact. */
const GradePop = ({ data, hold = 20, top = 1090 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hit = lastKick(data.perFrame, frame);
  if (!hit || hit.age > hold) return null;
  const { kick, age } = hit;
  const inn = spring({ frame: age, fps, config: { damping: 12, stiffness: 260, mass: 0.6 } });
  const out = interpolate(age, [hold - 6, hold], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const perfect = kick.grade === 'PERFECT';
  return (
    <div style={{
      position: 'absolute', top, width: '100%', textAlign: 'center', opacity: out,
      transform: `translateY(${interpolate(inn, [0, 1], [60, 0])}px) scale(${interpolate(inn, [0, 1], [0.7, 1])})`,
    }}>
      <span style={{
        fontFamily: 'Archivo Black', fontSize: perfect ? 92 : 76, color: perfect ? GOLD : INK,
        textShadow: '0 6px 30px rgba(0,0,0,0.6)',
      }}>
        {kick.grade}
      </span>
      <span style={{ fontFamily: 'Inter', fontWeight: 800, fontSize: 46, color: INK, marginLeft: 22, opacity: 0.92 }}>
        +{kick.gained}
      </span>
    </div>
  );
};

/** A line that arrives word by word and leaves in one move. */
const Line = ({ words, top, size = 84, from = 0, hold = 60, accent = -1 }) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0 || frame > hold + 8) return null;
  const out = interpolate(frame, [hold, hold + 6], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{
      position: 'absolute', top, left: 70, right: 70, textAlign: 'center', opacity: out,
      fontFamily: 'Archivo Black', fontSize: size, lineHeight: 1.04, color: INK, whiteSpace: 'nowrap',
      textShadow: '0 6px 34px rgba(0,0,0,0.7)',
    }}>
      {words.map((w, i) => {
        const p = interpolate(frame, [i * 3, i * 3 + 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <span key={w + i} style={{
            display: 'inline-block', margin: '0 10px', opacity: p, filter: `blur(${(1 - p) * 8}px)`,
            color: i === accent ? CORAL : INK,
          }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** Top and bottom scrims so type stays legible over a bright pitch. */
const Scrim = () => (
  <AbsoluteFill style={{
    background: 'linear-gradient(180deg, rgba(6,10,28,0.62) 0%, rgba(6,10,28,0) 30%, rgba(6,10,28,0) 62%, rgba(6,10,28,0.5) 100%)',
  }} />
);

/** Three-frame dip so each cut reads as meant rather than as a dropped frame. */
const CutDip = ({ at }) => {
  const frame = useCurrentFrame();
  const d = Math.abs(frame - at);
  if (d > 2) return null;
  return <AbsoluteFill style={{ background: '#060a1c', opacity: interpolate(d, [0, 2], [0.5, 0]) }} />;
};

const Shot = ({ name, children }) => (
  <AbsoluteFill>
    <OffthreadVideo src={staticFile(`capture/${name}.mp4`)} muted style={FILL} />
    <Scrim />
    {children}
  </AbsoluteFill>
);

export const Trailer = ({ capture }) => {
  useFonts();
  const { shots, endcard } = timeline(capture);
  const [rally, boot, hero] = shots;
  return (
    <AbsoluteFill style={{ background: '#060a1c' }}>
      <Sequence from={rally.from} durationInFrames={rally.frames}>
        <Shot name="rally">
          {/* The hook owns the top of the frame first; the score takes it over. */}
          <Line words={['HOW', 'MANY', 'CAN']} top={214} size={96} from={0} hold={52} />
          <Line words={['YOU', 'KEEP', 'UP?']} top={322} size={96} from={5} hold={47} accent={2} />
          <Score data={rally.data} from={58} />
          <GradePop data={rally.data} />
        </Shot>
      </Sequence>

      <Sequence from={boot.from} durationInFrames={boot.frames}>
        <Shot name="boot">
          <Line words={['EVERY', 'TOUCH']} top={1100} size={104} from={6} hold={58} />
          <Line words={['IS', 'TIMING.']} top={1214} size={104} from={12} hold={52} accent={1} />
          <GradePop data={boot.data} hold={40} top={900} />
        </Shot>
      </Sequence>

      <Sequence from={hero.from} durationInFrames={hero.frames}>
        <Shot name="hero">
          <Score data={hero.data} />
          <GradePop data={hero.data} />
        </Shot>
      </Sequence>

      <Sequence from={endcard} durationInFrames={ENDCARD_FRAMES}>
        <OffthreadVideo src={staticFile('endcard.mp4')} muted style={FILL} />
      </Sequence>

      <CutDip at={boot.from} />
      <CutDip at={hero.from} />
      <CutDip at={endcard} />
    </AbsoluteFill>
  );
};
