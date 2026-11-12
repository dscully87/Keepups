# PLAN: Kick-Up v2 — a stylised character and swipe-to-aim keep-ups

**Audience:** an agent or developer picking this up cold.
**Status:** nothing in this plan has been started. It is a plan only.
**Branch to work on:** `ccr-063f997b-kfxcsj` (or a fresh branch off it; ask the owner).

Read the whole document once before writing any code. It is long on purpose:
it explains *why* each step exists, not only what to type, because most of
the mistakes available here come from not knowing why the code is shaped the
way it is.

---

## 1. Why this plan exists

The owner's verdict on the current build, in their words:

> "it looks like a stick figure on steroids not an engaging game to play"

That is two separate problems. Do not treat them as one.

| Problem | What is actually wrong | What we tried that did not fix it |
|---|---|---|
| **Look** | The player is a human built entirely from code, aiming at realism. Five rounds of work made it cleaner but it still sits in the "almost a person" zone, which reads as wrong rather than as stylised. | Smoother meshes, a kit, fabric textures, better lighting, head tracking. Each helped a little. None changed the verdict. |
| **Play** | The whole game is one input: tap when the ball is low. The ball's sideways movement is *random* and is *automatically corrected*. The player never makes a decision. | Nothing. Gameplay has not been touched since phase 2. |

The owner asked how Miniclip's basketball game does it, and then approved
this direction:

1. **Stop chasing a real human.** Build a deliberately stylised character.
2. **Make the touch a swipe.** Where and how hard you swipe decides where
   the ball goes, so the player is steering and rescuing the ball.

The lesson to take from the reference game is not "copy it". It is that
arcade sports games win on **exaggerated, readable characters** and **an
input with skill in it**. Do not copy any specific game's characters, names,
art or layouts. Build our own.

### The single most important instruction

**Do Part A (gameplay) before Part B (character).** A fun game with an ugly
character is a fun game. A beautiful character in a boring game is still
boring. The owner has now said "meh" to three rounds of visual work, so the
next thing they see should *play* differently.

---

## 2. What "done" looks like

You are finished when all of these are true:

- [ ] A swipe on the screen kicks the ball, and the swipe's direction and
      speed visibly change where the ball goes.
- [ ] The ball no longer drifts randomly and no longer returns to the centre
      by itself. If the player does nothing clever, it wanders off and is lost.
- [ ] The player character moves under the ball. You cannot kick a ball that
      is out of reach.
- [ ] A new player can understand the control within about ten seconds,
      without reading anything (an on-screen hint and an aim preview teach it).
- [ ] The character is clearly, intentionally stylised. Nobody could mistake
      it for a failed attempt at realism.
- [ ] `npm run gate` passes, with the gates updated to test the new rules
      (see section 9). You may change what a gate checks when the rules
      change. You may **not** delete, skip or weaken a check to get a pass.
- [ ] The README describes the game as it now is.
- [ ] Screenshots, and ideally a short screen recording, are shown to the
      owner at the checkpoints in section 11.

---

## 3. Get oriented first (about 30 minutes, no code changes)

### 3.1 Run it

```bash
npm install          # only installs Playwright, used by the test gates
npm start            # serves the game at http://127.0.0.1:8080
npm run gate         # runs all six quality gates; all should pass before you start
```

If `npm install` cannot download a browser, a Chromium may already be on the
machine; the previous session linked a globally installed Playwright into
`node_modules/`. Do not run `playwright install` blindly — check first.

Useful URL switch: `?q=high`, `?q=medium` or `?q=low` pins the graphics
quality.

### 3.2 How the code is laid out

There is **no build step**. It is plain JavaScript modules loaded straight
by the browser, with Three.js vendored in `vendor/three/`. Keep it that way.

```
index.html              the page, the HUD markup and all the CSS
src/main.js             wires everything together; owns the frame loop and the HUD
src/core/               THE GAME. No DOM, no Three.js, no rendering.
  constants.js            world sizes, in metres
  physics.js              BallBody: position, velocity, gravity, drag, walls
  game.js                 rules and state machine (READY / PLAYING / GAME_OVER)
  combo.js                grades a touch PERFECT / GOOD / SLOPPY and scores it
  difficulty.js           four difficulty tiers
  input.js                turns pointer events into "a tap happened"
  audio.js                all sound, synthesised at runtime
  perf.js                 frame-rate governor
src/render/three/       THE PICTURE. Reads game state, never changes it.
  stage.js                scene, camera, lights; calls everything below each frame
  player.js               the character: skeleton, mesh, animation, leg IK
  sdf.js                  turns shapes into one smooth mesh (see 3.4)
  textures.js             every texture, painted in code
  ball.js, stadium.js, effects.js, post.js
tools/                  test server, Playwright harness, the six gate scripts
video/                  trailer pipeline (leave alone until Part D)
```

### 3.3 The rule you must not break

**`src/core/` knows nothing about rendering, and the renderer never changes
game state.**

Why this matters to you personally: the gates work by loading the page in a
headless browser and running *thousands of simulated frames per second*
without drawing them. That only works because the simulation is a pure
function of time. The moment game logic depends on a mesh, a camera or a
`requestAnimationFrame` callback, the gates stop being able to test it and
you lose your safety net.

In practice:

- New rules (ball flight, reach, scoring) go in `src/core/`.
- New visuals (aim arrow, character) go in `src/render/three/` or the HUD.
- The renderer may *read* `game.ball.x`. It must never *write* it.
- The simulation runs on a fixed 120 Hz step inside `game.advance(dt)`.
  Do not add physics anywhere else.

### 3.4 Three things that will confuse you if nobody tells you

1. **Left and right are viewer-relative.** In `player.js`, bones ending in
   `L` are on **+x**, which is the *right* side of the screen. The kicking
   leg is `legL`/`thighL`. This is noted at the top of the file. It is not
   anatomical left.
2. **The animation mixer skips writes.** Three.js's `AnimationMixer` only
   writes a bone when its blended value *changed*. If you rotate a bone in
   code after the mixer runs, and that bone's track is constant, your
   rotation is still there next frame and you will add to it again. The
   symptom is a body part that slowly, then quickly, spins off. See
   `#applyGaze` in `player.js` for how this was handled (it restores the
   bones before the mixer runs).
3. **`sdf.js` is a mesher, not a renderer.** You give it simple shapes
   (capsules, rounded boxes, swept profiles), it blends them like clay and
   returns one mesh with smooth joins. It runs once at load. `cell` is the
   grid size in metres: smaller means smoother and slower. You will use this
   heavily in Part B.

---

## 4. Part A — the swipe-to-aim game (do this first)

### 4.1 What the rules are today

Open `src/core/game.js` and find `tap()`. Read it line by line. Today:

- A tap connects if the ball's height is inside a window
  (`CONTACT_WINDOW_LOW`..`CONTACT_WINDOW_HIGH` in `constants.js`).
- The ball's height at that moment sets the grade (`combo.js`).
- The ball is then launched by `ball.strike(power, recentre, lateral, depth)`
  in `physics.js`, where:
  - `lateral` and `depth` are **`Math.random()`**. The sideways push is luck.
  - `recentre` pulls the ball back towards x = 0. The game rescues the
    player on every touch.

Those two bullets are the reason it is boring. Random input the player
cannot influence, plus automatic correction, means there is nothing to be
good at.

### 4.2 What the rules become

Hold this model in your head while you build:

> The ball is a real object that goes where you send it. The player is a
> body that has to be under it. A swipe is a kick.

| Thing | New behaviour |
|---|---|
| **Sideways launch** | Comes from the swipe's horizontal direction. No randomness. |
| **Height of launch** | Comes from the swipe's speed. A slow swipe is a soft touch, a fast swipe sends it high. |
| **Self-centring** | Removed. `recentre` goes to 0. |
| **Player position** | The character shuffles sideways to follow the ball, at a limited speed. |
| **Reach** | A kick only connects if the ball is within reach of the character's foot. |
| **Timing** | Still matters. Height at contact still sets the grade. |
| **Drift** | Each tier adds a little "wind" and spin so the ball is never perfectly still. |

Why a high kick should be a real choice: a high ball gives the player more
time to get under it, but it also travels further sideways and falls
faster, so it is harder to judge. A low ball is safe but leaves no time to
move. That trade-off is the game. Protect it while you tune.

### 4.3 Starting numbers

These are sensible first guesses, **not requirements**. Put every one of
them in `src/core/constants.js` (or as new fields on the tiers in
`difficulty.js`) with a comment saying what it does. You will tune them by
playing, so they must be easy to find.

| Constant | Start at | Meaning |
|---|---|---|
| `SWIPE_MIN_DISTANCE` | 24 px | Shorter than this is a plain tap |
| `SWIPE_MAX_TIME` | 0.35 s | Longer than this is not a flick |
| `KICK_POWER_MIN` / `MAX` | 4.2 / 7.2 m/s | Launch speed for the slowest / fastest swipe |
| `KICK_SIDE_MAX` | 2.4 m/s | Sideways speed for a fully horizontal swipe |
| `PLAYER_SPEED` | 2.6 m/s | How fast the character shuffles |
| `PLAYER_REACH` | 0.55 m | Horizontal distance from character to ball that can still be kicked |
| `PLAY_HALF_WIDTH` | 1.35 m (existing) | Where the ball is lost at the sides |
| `WIND_MAX` | 0 → 0.9 m/s² across the four tiers | Sideways acceleration on the ball |

A plain tap (no swipe) should still work as "kick straight up at medium
power". That keeps the game playable for someone who has not discovered the
swipe yet, and keeps the Space/Enter keyboard fallback meaningful.

### 4.4 Work order

Do these in order. Each step ends in something you can run and check. Do
not move on while a step is broken.

#### Step A1 — Ball flight from a vector (core only)

- In `physics.js`, change `strike()` to take an explicit launch velocity
  `(vx, vy, vz)` instead of `power, recentre, lateral, depth`.
- Keep the spin lines, but make the spin axis follow the direction of
  travel so the ball visibly rolls the way it is going.
- Add an optional sideways acceleration to `step()` for wind.
- In `game.js`, add `kick(aim)` where `aim` is `{ side, power }`, both
  already normalised: `side` in −1..1 and `power` in 0..1. Convert them to
  metres per second there, using the constants above.
- Keep `tap()` working by having it call `kick({ side: 0, power: 0.5 })`.

**Check:** temporarily call `window.__KICKUP__.game.kick({ side: 1, power: 1 })`
from the browser console and watch the ball fly up and to the right.

*Why normalised inputs:* the core must not know about pixels or screen
sizes. Converting a finger movement into −1..1 is the input layer's job;
turning −1..1 into physics is the core's job. This is also what makes it
testable: a gate can call `game.kick({ side: 0.5, power: 0.8 })` directly.

#### Step A2 — Swipe input

- In `input.js`, add `createSwipeInput(target, { onStart, onMove, onRelease })`
  next to the existing `createTapInput`. Use pointer events
  (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) and
  `setPointerCapture` so a finger that leaves the canvas still ends the
  gesture.
- On release, compute direction and speed from the **last ~80 ms** of
  movement, not from the whole gesture. People wind up before they flick;
  using the whole path makes kicks feel mushy and late.
- Normalise by screen size so a small phone and a large one feel the same.
- **Latency matters more than anything else here.** The existing code fires
  the kick inside the `pointerdown` handler, and gate 6 measures that. A
  swipe cannot fire on `pointerdown` because there is no direction yet. So:
  - Fire the kick on `pointerup`.
  - On `pointerdown`, immediately start the *anticipation*: the aim preview
    appears and the character begins its wind-up. The player gets instant
    feedback even though the ball has not been struck yet.
- Keep keyboard support: Space/Enter is a straight kick; arrow keys held at
  the moment of pressing add direction.

**Check:** log `side` and `power` to the console and flick in different
directions and at different speeds. The numbers should match what your
finger felt like.

#### Step A3 — The player has to be there

- Add `playerX` to the game state in `game.js`.
- Each fixed step, move `playerX` towards where the ball will land, at no
  more than `PLAYER_SPEED`. The landing point can be predicted exactly: the
  ball's flight is deterministic (see `contactPoint` in `stage.js`, which
  already predicts ahead for the leg).
- A kick only connects if `|ball.x − playerX| <= PLAYER_REACH` **and** the
  existing height window is satisfied. Otherwise it is a whiff, exactly as
  a mistimed tap is today.
- In `stage.js`, position the character from `game.playerX` instead of the
  fixed position it uses now. Lean the body slightly into the direction of
  travel and play a small sidestep.

**Decide and write down:** should the character chase the ball
automatically (as above), or should the player drag to move them? The plan
assumes **automatic**, because one input is easier on a phone and keeps the
skill in the kick. If you find the game plays itself, lower `PLAYER_SPEED`
before you add a second control.

**Check:** kick hard to one side. The character should scramble after it
and sometimes not make it. That "sometimes" is the difficulty.

#### Step A4 — Remove the safety net

- Delete the `Math.random()` lateral and depth from `game.js`.
- Set `recentre` to 0 in every tier in `difficulty.js`, then remove the
  field if nothing reads it.
- Replace it with wind (per-tier, slowly changing direction, seeded so runs
  are repeatable) and a little spin drift.

**Important:** any randomness you add must come from a **seeded** generator
stored on the game object, never `Math.random()`. The gates and the trailer
capture both rely on the same inputs producing the same game.

**Check:** the game is now properly hard. If you cannot get past five,
that is expected at this point. Tuning comes in A7.

#### Step A5 — Scoring that rewards control

Extend `combo.js`. Keep the existing grades and add:

- **Control bonus:** a touch that leaves the ball close to straight above
  the player scores more than one that sends it across the pitch.
- **Rescue bonus:** connecting when the ball was near the edge of reach.
- **Height bonus:** a high ball that is then cleanly controlled.

Show the reason in the existing flash text ("RESCUE +200"). Points nobody
understands do not feel like rewards.

#### Step A6 — Teach it and make it feel good

This step is where "works" becomes "fun". Do not skip it.

- **Aim preview:** while a finger is down, draw a short arc from the ball
  showing where it would go. Fade it out as the difficulty rises so
  experts are not handed the answer.
- **Landing marker:** a soft ring on the turf where the ball will come down.
- **Reach indicator:** a subtle ring under the character that brightens
  when the ball is kickable.
- **First-run hint:** replace "Tap anywhere to kick" in `index.html` with an
  animated "Swipe to kick" hint that disappears after the first few
  successful swipes.
- **Feel:** a few frames of slow motion on a rescue, a camera nudge in the
  kick direction, a pitch change in the kick sound with power (`audio.js`),
  a stronger haptic on a perfect.

#### Step A7 — Tune by playing

Play 30 or more rounds yourself. Then adjust until these are roughly true:

- A first-time player reaches about 5 within three attempts.
- A practised player can reach 30 but still loses to their own mistakes.
- Losing always feels like your fault ("I hit it too hard"), never the
  game's ("it just went sideways").

Write the final numbers and one line on why into the README.

#### Step A8 — Update the gates

See section 9. Do this as part of Part A, not at the end of the project.

---

## 5. Part B — the stylised character

### 5.1 The idea

Stop asking "does this look like a person?" and ask "is this fun to look
at, and can I read what it is doing at a glance on a phone?"

Stylised characters are forgiving in exactly the places a realistic one is
not. Nobody inspects the anatomy of a character with a head a third of its
height.

### 5.2 Style rules — treat this as the art bible

Follow these unless the owner says otherwise. Write any change down.

1. **Proportions:** about 3 to 3.5 heads tall. Big head, short torso,
   short thick limbs, oversized boots and hands. (The current figure is
   about 7.5 heads tall. That is the main reason it reads as a mannequin.)
2. **Shapes:** every body part is a simple, chunky, rounded shape. No
   muscle definition, no fingers (mitten hands with a thumb), no modelled
   knees or elbows.
3. **Face:** large, simple and expressive. Big eyes, simple brows, a mouth
   that can change shape. Painted, not modelled.
4. **Colour:** flat and saturated. Three or four colours per character.
   No fabric micro-texture.
5. **Shading:** two or three distinct tones (toon shading) instead of a
   smooth photographic falloff, plus a dark outline.
6. **Silhouette test:** fill the character solid black. You must still be
   able to tell which way they are facing and that they are kicking.
7. **Motion:** exaggerate. Squash on landing, stretch on the kick, big
   anticipation, big follow-through. Stiffness is the enemy.

Before modelling, collect five or six reference images of stylised sports
characters you like from different games and note what they have in common.
Use them for principles only. Do not reproduce any existing character.

### 5.3 What to reuse and what to replace

Do **not** start from an empty file. `player.js` has a lot that still works.

| Keep | Why |
|---|---|
| The skeleton (`RIG`), bone names and hierarchy | The leg IK, the animation clips and the gates all refer to bones by name. |
| Two-bone leg IK (`#applyLegIK`, `#pointBootAtBall`) | It is what makes the boot actually meet the ball. It needs `THIGH_LENGTH`, `SHIN_LENGTH` and `FOOT_LENGTH` to match the skeleton, so update those constants when you change bone lengths. |
| Head tracking (`#applyGaze`) | A character that watches the ball looks alive. On a big cartoon head it will read even better. |
| The clip system and blend weights | Works; just needs new poses. |
| `sdf.js` | Ideal for chunky rounded shapes that merge smoothly. |

| Replace | With |
|---|---|
| The realistic `LIMBS` profiles, hands, skull sculpting, hair shell | Chunky shapes built with `capsuleField`, `roundBoxField` and `latheField`, meshed by `meshFields`. Far fewer, far simpler shapes. |
| `MeshStandardMaterial` on the character | `MeshToonMaterial` with a small 3-step gradient texture (create a 3×1 pixel texture and set its filtering to nearest, or the steps will blur away). |
| The kit knit normal maps on the player | Nothing. Flat colour. The MaterialCraft turf maps can stay on the pitch. |
| The painted realistic face in `textures.js` | A simple painted face with a few expression variants. |

### 5.4 Work order

#### Step B1 — Proportions first, with no detail

Change the bone offsets in `RIG` to the new proportions and build the body
from the fewest shapes that work: one for the head, one for the torso, one
per limb segment, boots, mitten hands. Aim for under 15 shapes in total.

Use the existing inspection tool to look at it from five angles:

```bash
node tools/portrait.mjs check 1     # writes shots/check-*.png
```

**Check:** does the black-silhouette test pass? If the proportions are
wrong, no amount of detail later will fix it. Show the owner at this point
(checkpoint 2).

*Performance note:* the current player is about 50k triangles and takes
0.3 s to build. A stylised character should be well under half of that.
Use a coarser `cell` (start at 0.02 m) and only go finer where you can see
facets.

#### Step B2 — Toon shading and outline

- Switch the character's materials to `MeshToonMaterial`.
- Add an outline with the "inverted hull" method: a second copy of each
  mesh, slightly inflated along its normals, drawn in a dark colour with
  `side: THREE.BackSide`. For a skinned mesh the copy must share the same
  skeleton. This costs one extra draw call per mesh, which is fine.
- Check how it sits in the scene. A cartoon character in front of a
  semi-realistic stadium may look pasted on. If so, push the *stadium*
  towards the same style (flatter colours, simpler crowd) rather than
  pulling the character back towards realism.

#### Step B3 — Face and expressions

Paint the face onto a canvas texture in `textures.js`, as the current code
does, but simple: two big eyes, brows, a mouth. Make four versions:
neutral, focused, happy (perfect touch), and "oh no" (ball lost). Swap
between them from game events. This is cheap and adds a lot of personality.

#### Step B4 — Animation

Re-author the three clips (`idle`, `kick`, `stumble`) for the new body, and
add what the new gameplay needs:

- a sidestep left and right,
- a stretch or lunge for a ball at the edge of reach,
- a short celebration on reaching a new tier,
- a proper reaction to losing the ball.

Remember from section 3.4: every clip must animate the **same set of
bones**. `completeClip()` pads missing tracks for you; keep using it, or
limbs will snap to the bind pose mid-blend.

#### Step B5 — Customisation hooks (small, but do it now)

Put the character's colours, kit number and a couple of head options in one
plain config object. Do not build an unlock shop yet. The point is that
adding one later is a data change, not a rewrite.

---

## 6. Part C — reasons to come back (only after the owner approves A and B)

Do not start this without a go-ahead. In rough priority order:

1. **Short challenges:** "keep it up for 20", "five rescues in a row",
   "30 with strong wind". Three difficulty stars each.
2. **Unlocks:** balls, boots, kits and pitches earned from challenges, using
   the config object from B5.
3. **Daily challenge:** one seeded setup per day, the same for everyone,
   with a personal best. The seeded randomness from A4 makes this cheap.
4. **Versus:** two players alternating touches on one ball, first locally,
   then against a recorded "ghost". Real online play is a much larger job
   and needs its own plan.

---

## 7. Part D — refresh the trailer (last)

`video/` builds the trailer by playing the real game with a script. After
Part A the script's player must **swipe** instead of tap. Update
`video/capture.mjs` so its scripted player calls `game.kick({ side, power })`
with believable aim, then run `npm run trailer` inside `video/`. Details are
in the README's Trailer section. Budget ten to fifteen minutes of render
time on a machine without a GPU.

---

## 8. Rules of the road

- **No build step, no framework.** Plain ES modules.
- **No third-party art or model files** without asking the owner first.
  Licensing is the reason this project generates its own.
- **Nothing fetched from the network at runtime.**
- **Comments explain why.** Match the existing style: the files are heavily
  commented with the reasoning behind decisions, including what was tried
  and failed. Keep doing that. It is the most valuable thing in the repo.
- **Small commits, one idea each.** Run `npm run gate` before every commit.
- **Seeded randomness only** in `src/core/`.
- **Allocate nothing per frame** in the hot path. Gate 6 measures heap
  growth. Reuse vectors (see the `_v` scratch objects in `player.js`).

---

## 9. Testing — the gates

`npm run gate` runs `tools/gate1.mjs` to `gate6.mjs`. Each drives the real
page in a headless mobile browser. Current counts: 11, 22, 24, 26, 23, 29.

Several checks will fail the moment you start, **because the rules they
test are changing**. That is expected. The right response is to rewrite the
check for the new rule, in the same commit as the rule change.

Likely to need rewriting:

- **Gate 1** (physics, input, scoring): assumes a tap launches the ball and
  that it stays near the centre.
- **Gate 2** (difficulty, combo): reads `lateral` and `recentre` from the
  tiers.
- **Gate 3** (animation, IK): the IK tests should still pass if you kept
  the skeleton contract; the triangle and mesh counts will change.
- **Gate 6** (latency): measures tap-to-action time. Re-point it at
  `pointerdown`-to-anticipation and `pointerup`-to-kick.

New checks to add:

- A kick with `side: +1` gives the ball positive x velocity, and `−1`
  negative.
- Higher `power` gives a higher apex.
- A ball outside `PLAYER_REACH` cannot be kicked.
- With no input, the ball is lost within a bounded time (no self-rescue).
- The same seed and the same inputs produce the same final state.
- A scripted "good" player survives much longer than a scripted "random"
  one. This is the best single proof that skill now matters.

### A warning about testing on this kind of machine

A server with no GPU renders with software at a few frames per second.
**Never measure frame rate there and never wait on real time.** Step the
simulation by hand, the way `tools/shot.mjs` and `video/capture.mjs` do
(`window.__PAUSE__ = true`, then call `game.advance(dt)` and
`stage.update(...)` yourself).

### What the gates cannot tell you

They cannot tell you whether it is fun, or whether it runs smoothly on a
real phone. **Nobody has run this on a physical handset yet.** If you can,
do. If you cannot, say so in your report rather than implying it was
checked.

---

## 10. Risks, and what to do about each

| Risk | What to do |
|---|---|
| The swipe feels laggy because the kick fires on release | Start anticipation on touch-down (Step A2). If it still feels late, shorten the wind-up animation. |
| Different phones produce different swipe speeds | Normalise by screen size and clamp. Test at two viewport sizes in the harness. |
| The game is too hard once self-centring is gone | That is the first thing you will see. Tune `PLAYER_SPEED`, `PLAYER_REACH` and wind before adding any assistance back. |
| The automatic sidestep plays the game for you | Lower `PLAYER_SPEED` so hard kicks out-run the character. |
| The stylised character clashes with the stadium | Restyle the stadium to match (Step B2). |
| The character ends up "chibi but creepy" | Simplify further. Fewer features, bigger shapes. Show the owner early. |
| You are tempted to rewrite `player.js` from scratch | Don't. Replace the geometry and materials; keep the skeleton, IK, gaze and clip system. |
| A gate fails and you cannot see why | Read the gate script; each check has a plain-English name and prints its measured value. |

---

## 11. Checkpoints with the owner

Stop and show your work at each of these. Send screenshots, or a short
recording where motion matters. Do not continue past a checkpoint on your
own assumption that it is fine.

1. **After A4:** the swipe works and the ball goes where it is sent. Ugly
   is fine. Question for the owner: "does this feel like the right kind of
   game?"
2. **After B1:** grey, untextured character in the new proportions.
   Question: "is this the right shape and size of character?"
3. **After A7 and B4:** the tuned game with the finished character.
   Question: "is this fun, and what is missing?"
4. **Before starting Part C.**

---

## 12. Out of scope

Do not do these as part of this plan:

- Online multiplayer, accounts or leaderboards.
- In-app purchases or adverts.
- Importing a third-party character model or motion-capture data.
- Changing the trailer before Parts A and B are approved.
- Making the character "more realistic". That road has been walked five
  times.

---

## 13. Glossary

- **Bind pose:** the pose the skeleton is in when the mesh is attached to
  it. All geometry in `player.js` is authored in this pose.
- **Skinning / skin weights:** how much each bone pulls on each vertex.
  Bad weights make joints crease or collapse.
- **IK (inverse kinematics):** working out joint angles from where you want
  the foot to end up, instead of animating each joint by hand.
- **SDF (signed distance field):** a way of describing a shape as "how far
  is this point from the surface". Fields are easy to blend together
  smoothly, which is why the character uses them.
- **Surface nets:** the algorithm in `sdf.js` that turns a field into
  triangles.
- **Fixed timestep:** advancing the physics in equal slices (here 1/120 s)
  regardless of frame rate, so the game behaves identically everywhere.
- **Gate:** one of the six automated test scripts that must pass.
- **Juice / game feel:** the small responses (shake, squash, sound, flash)
  that make an action satisfying.
- **Toon shading:** lighting snapped to a few flat tones, as in a cartoon.
- **Inverted hull:** an outline made by drawing a slightly larger,
  inside-out, dark copy of a mesh behind it.
