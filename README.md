# Project Kick-Up

A mobile-web soccer keep-up game. **Swipe to kick**: the direction of your
flick steers the ball and its speed sets how high it goes. Time each touch to
the sweet spot to build a combo, and keep the ball over the pitch — it drifts
in the wind, nothing pulls it back to the middle, and the character can only
kick it if it is within reach.

Vanilla JavaScript and Three.js, no build step. Open `index.html` from any
static server and it runs.

```bash
npm install      # playwright, for the quality gates
npm start        # serve at http://127.0.0.1:8080
npm run gate     # run all seven quality gates
```

The trailer is built from the game itself — see [Trailer](#trailer).

`?q=high|medium|low` on the URL pins a rendering tier and disables the
adaptive governor — useful for testing a specific device profile.

## How it plays

| Thing | Rule |
|---|---|
| Kick | Fires on release. Direction and speed come from the last ~80 ms of the swipe, normalised by screen height. A plain tap (or Space) kicks straight up at medium power; arrow keys held add direction. |
| Sideways | `side` (-1..1) × `KICK_SIDE_MAX` 2.4 m/s. No randomness anywhere in the core: the only random source is a seeded generator on the game object. |
| Height | `power` (0..1) maps to 4.2–7.2 m/s launch speed. High balls give time to reposition but travel further sideways and fall faster. |
| Character | Shuffles at 2.6 m/s towards the predicted landing point and can kick only within 0.55 m. A hard kick out-runs them. |
| Out | A ball that leaves the pitch sides (±1.35 m) ends the rally; there are no walls. |
| Wind | Peak sideways acceleration per tier: 0 / 0.7 / 1.3 / 2.0 m/s², slowly alternating (seeded). |
| Bonuses | CONTROL (ball will land near you), RESCUE (contact near the edge of reach), HEIGHT (clean control after a high kick), each shown by name. |

Guides: a dashed aim arc while the finger is down (fades out by the top tier),
a ring where the ball will land, and a ring under the character that turns
green when the ball is kickable. A rescue earns a beat of slow motion.

**Tuning status.** The numbers above are the plan's starting values with the
wind raised from 0.3/0.6/0.9 to 0.7/1.3/2.0: at the original values a player
tapping straight survived 146 kicks because the character catches any drift
under 0.55 m. With the final values, in the headless bots (`tools/gate7.mjs`)
a steering player lasts ~110 kicks, a straight-tapper ~35 and a random swiper
~2. **Nobody has playtested this on a real handset yet**, so feel — whether a
first-timer reaches ~5, whether losing feels fair — is untested and the
constants in `src/core/constants.js` / `difficulty.js` are expected to move.

## How it is put together

```
src/
  core/          headless — no DOM, no renderer
    constants.js   world units (SI: metres, seconds)
    physics.js     ball rigid body: gravity, drag, wall restitution, spin
    combo.js       strike grading and the points multiplier
    difficulty.js  the four difficulty tiers and the ramp between them
    game.js        rules, state machine, fixed-timestep accumulator
    input.js       low-latency pointer capture
    audio.js       WebAudio synthesis + haptics
    perf.js        frame-rate governor and input-latency probe
  render/
    canvas2d.js    the phase 1-2 prototype renderer (kept for reference)
    three/
      stage.js     scene, camera, lighting rig, per-frame bridge
      player.js    procedural skinned rig, clips, two-bone IK
      sdf.js       distance fields, smooth union, surface-nets mesher
      ball.js      match ball
      stadium.js   sky, pitch, stands, hoardings, floodlights
      textures.js  every texture, generated at load
      effects.js   pooled impact particles and camera shake
      post.js      depth of field, bloom, colour grade, quality tiers
tools/            static server, Playwright harness, six gate scripts
  materials/      MaterialCraft graphs (.sbs) and the script that bakes them
assets/materials/ baked knit, rib and turf maps (680 KB)
video/            trailer: gameplay capture, HyperFrames end card, Remotion edit
vendor/three/     Three.js and the post-processing addons, vendored
```

The simulation is a fixed 120 Hz accumulator and owns no DOM and no renderer.
That separation is what let the renderer be replaced wholesale in phase 3
without touching a line of game logic, and it is what makes the gates able to
run thousands of simulated frames per second in a headless page.

## Notable decisions

**All geometry is generated procedurally at load.** There are no model files,
and nothing is fetched from a third party at runtime. Licensed photoreal player
scans are not something this project can ship, and a CDN dependency would cost
mobile load time and break offline play. So the footballer is a 21-bone
skinned mesh built in code (see below); the ball's panel
layout is a genuine truncated icosahedron, computed as a spherical Voronoi
over its 32 panel centres and baked to albedo, normal and roughness maps; the
stadium and its crowd are built and textured in code. This is a real tradeoff:
the player reads as a clean stylised figure rather than a photoreal athlete.
What it buys is a self-contained ~2.7 MB app with no third-party asset
licensing attached to it. The one exception to "generated at load" is the
surface micro-detail below, which is authored offline and baked.

**The body is one filleted surface per garment, not a stack of parts.** The
first three character rounds built the player from separate lathes that each
started inside its neighbour. That stops parts punching through one another,
but every place two lathes cross is still a crease with unrelated normals on
either side, and on a shoulder a crease reads as armour plate. `sdf.js` turns
the same authored profiles into distance fields, joins them with a smooth
minimum — which fillets each junction by a chosen radius — and extracts a
single watertight mesh with surface nets. Normals come from the field's
gradient and skin weights are blended across a junction the same way the
surface is, so the shoulder, armpit and hip deform as cloth rather than
hinging. The hands are a palm, four curled fingers and a thumb joined the same
way. The player is 50.5k triangles and builds in about 0.3 s.

**Kit artwork is painted in metres on the body.** The shirt and shorts are
projected straight through the figure, front and back, so the code that draws
the number or a cuff works in bind-pose coordinates rather than in an
unwrapped UV layout. The sides, where a planar projection smears, are exactly
where a kit has a plain panel.

**Surface detail is authored in MaterialCraft and baked.** The jersey knit,
the sock rib and the turf grain are node graphs built headlessly through
[MaterialCraft](https://github.com/storytold/materialcraft)'s CLI by
`tools/materials/build.mjs`: a Pixel Processor function for the pattern, then
its Normal, Levels and Blur nodes. The `.sbs` packages are committed next to
the script, so the materials can be opened and edited in the app, and the
bake is a build step — the game only loads six small PNGs.

**The boot tracks the ball before you tap.** The ball's descent is
deterministic, so the kicking foot shadows it on the way down, exactly as a
real juggler's does. The strike therefore begins from a pose already next to
the ball. This started as a fix — the leg was crossing 62° in a single frame
on contact — and ended up being the thing that makes the animation read as
skill rather than as a twitch. Worst-case per-frame rotation fell to 14.5°
with no added input latency.

**Feedback fires inside the tap handler, not on the next frame.** The kick
clip's frame 0 *is* the contact pose, so audio, haptics, particles, camera
shake and the animation are all triggered synchronously from the pointer
event. The handler costs a median of 0.5 ms.

**Audio is synthesised, not sampled.** Strike, chime, crowd bed, whistle and
scuff are all built from oscillators and noise buffers at runtime. Nothing to
download, nothing to fall out of sync.

## Trailer

`video/` builds a short vertical trailer ([media/trailer.mp4](media/trailer.mp4))
out of three tools, each doing the
part it is suited to:

| Step | Tool | What it does |
|---|---|---|
| `npm run capture` | Playwright + the game | Plays the real game with a scripted player and steps it exactly 1/30 s per frame, so footage is frame-perfect even on a machine that renders a frame every three seconds. Slow motion is the same thing with a smaller step. Also writes `capture.json`: the score and combo on every frame and the grade of every touch. |
| `npm run endcard` | [HyperFrames](https://github.com/heygen-com/hyperframes) | Renders the end card, an HTML + GSAP composition in `video/hyperframes/`. |
| `npm run edit` | [Remotion](https://www.remotion.dev) | Cuts the shots and the end card together and draws the overlays in React from `capture.json` — the score counter and the PERFECT/GOOD calls are the game's own values on that frame, not numbers typed into an edit. |

```bash
cd video
npm install
npm run trailer      # all three steps -> video/out/trailer.mp4
                     # (Remotion needs Chrome Headless Shell; add
                     #  -- --browser-executable=<path> to "npm run edit" to reuse one)
npm run studio       # Remotion Studio, to re-cut interactively
```

Footage is captured at 720×1280 by default because software rendering costs
seconds per frame; `CAPTURE_SCALE=2 npm run capture` gives 1080×1920 on a
machine with a GPU. The trailer has no soundtrack. Remotion is free for
individuals and small teams and needs a company licence above that; check its
terms before using the output commercially.

## Quality gates

Each phase had to pass a machine-checked gate before the next one started.
The gates drive the real page in a mobile viewport through Playwright — they
are not unit tests against mocks.

| Gate | Covers | Result |
|---|---|---|
| 1 | Physics, input, bounds, scoring | 11/11 |
| 2 | Failure state, difficulty ramp, combo system | 22/22 |
| 3 | Three.js migration, skinning, animation blending, IK | 24/24 |
| 4 | Stadium, lighting, post-processing, image dynamic range | 26/26 |
| 5 | HUD layout, audio, haptics, impact sync | 23/23 |
| 6 | Input latency (pointerdown anticipation, pointerup kick), frame pacing, allocation churn, effects | 31/31 |
| 7 | Swipe-to-aim rules: direction, power, reach, no self-rescue, seeded determinism, skill gap | 19/19 |

The gates found most of the real bugs in this project, including several that
looked fine on screen: a colour-space error that was crushing 31% of every
frame to solid black, an IK solver that was aiming the ankle rather than the
boot at the ball, animation clips with mismatched blend sets that snapped the
arms into a T-pose mid-transition, and a HUD element that silently ignored the
code trying to hide it.

### A note on measuring frame rate

CI has no GPU, so Chromium falls back to SwiftShader software rasterisation at
roughly 3–8 fps. Wall-clock frame rate measured there describes the harness,
not the game, and gating on it would be meaningless. Frame rate is therefore
gated on the things that actually predict it on device:

- CPU cost per frame — median under 0.1 ms, p95 0.1 ms, worst case 5 ms
  against a 16.67 ms budget, measured over 900 frames of real play
- frame-time consistency — σ = 0.22 ms
- allocation churn — 0 bytes/frame of heap growth over 3000 frames
- GPU workload — 66 draw calls, 71k triangles, 34 shader programs, with no
  shader compiled mid-rally
- input latency — median 0 ms, worst 0.2 ms from the browser's own event
  timestamp to the game acting on it

On top of that, a runtime governor samples real frame times in two-second
windows and steps quality down (depth of field first, then bloom, then
shadows) if the device drops frames, recovering when it copes. It ignores the
first four seconds, so startup stalls never cost you quality on hardware that
is about to be fine.

The honest limit: these are strong predictors, not a substitute for a frame
rate captured on a physical handset. That measurement has not been taken.
