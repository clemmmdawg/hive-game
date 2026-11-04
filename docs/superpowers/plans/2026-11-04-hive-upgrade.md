# Hive Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix confirmed rule/server bugs, then ship Neon Bestiary art, gameplay juice (path animation, FX, audio, haptics, queen danger, win sequence), and PWA + move history/replay.

**Architecture:** Pure logic stays in DOM-free modules (`game.js`, new `notation.js`, `hints.js`) and is unit-tested with `node --test`. Rendering/animation lives in `board.js`; sound in new `audio.js`; app glue in `app.js`. Each phase ends at a critic gate (tests + Playwright screenshots on phone and desktop).

**Tech Stack:** Vanilla ES modules, Canvas 2D, WebAudio, Service Worker, Node 22 + `ws`, `node --test`, Playwright (dev-only, at `/opt/node-tools/node_modules/playwright`).

**Spec:** `docs/superpowers/specs/2026-11-04-hive-upgrade-design.md`

## Global Constraints

- No build step, no framework, no new runtime dependencies.
- `js/game.js` stays DOM-free and importable by the server; do not reorder `DIRS`.
- Preserve CLAUDE.md "User-applied CSS overrides" exactly.
- Honour `prefers-reduced-motion` (tweens instant, no particles/shake/shockwave; sounds kept).
- Species colours: Queen `#ffd23f`, Beetle `#b07cff`, Grasshopper `#a6ff3d`, Ant `#4d8dff`, Spider `#ff7a3d`, Mosquito `#d8dcef`, Ladybug `#ff4040`, Pillbug `#2fe0a8`. Players: `--p1 #ff2d78`, `--p2 #00f5ff`.
- Animation: ~120 ms per hex step, max 700 ms total; win reveal delay ≤ 1.6 s.
- Every phase: `npm test` and `npm run check` green; zero console errors in the browser.
- Run the server with `npm install` done; start with `npm start -- <port>`.
- Update CLAUDE.md (What Works, File Structure, APIs) in the task that changes them.
- Commit messages end with the session attribution lines.

## Review Focus

1. **Online opponent move animates from the correct previous state** — when a GAME_STATE arrives, the path is computed from the state *before* it; if the path can't be computed (e.g. after reconnect), the piece just pops in. Test in Task 8.
2. **Undo during/after animation** — undo mid-tween must not leave a ghost piece or a half-drawn stack. Test in Task 8.
3. **Old v1 local save after upgrade** — CONTINUE still works and history starts empty. Test in Task 12.
4. **Stale service worker** — after a deploy, the user gets the update toast rather than a forever-old shell; `/ws` never cached. Checked in Task 14.
5. **Tiny tiles legibility** — species identifiable at 28 px tray size and zoomed-out board. Critic check in Phase 1 gate.

---

## Phase 0 — Bugs & hardening

### Task 1: Ground slides must keep hive contact

**Files:** Modify `js/game.js` (`canSlide` + call sites: queen, beetle ground, ant, spider, pillbug, mosquito copies; ladybug if confirmed). Test `test/rules.test.js`.

**Interfaces:** Produces `canSlide(board, fromQ, fromR, toQ, toR, fromHOverride?)` unchanged signature; ground→ground (`need <= 1`, i.e. from height ≤1 incl. moving piece and `toH === 0`) additionally returns false unless `h1 > 0 || h2 > 0`, where heights are measured with the moving piece removed (callers already remove it for ant/spider DFS — verify each call site; where they don't, the moving piece can't be a gate anyway because gates are the two *common* neighbours, never `from`).

- [ ] Step 1: Failing tests in `rules.test.js`: board `0,0`=moving piece, others at `-1,1 -1,2 0,2 1,1` (mix of players, queens placed). Assert `getLegalMoves` for QUEEN, BEETLE, PILLBUG at `0,0` sorted equals `['-1,0','0,1']`; SPIDER at `0,0` equals `['-2,2','2,0']`; ANT at `0,0` still reaches `1,0` (legally, by walking around the hive edge) — assert ant moves equal the hand-computed edge set written into the test.
- [ ] Step 2: `npm test` → those fail.
- [ ] Step 3: Implement in `canSlide`; update its doc comment.
- [ ] Step 4: Investigate ladybug at height: official rule — a piece moving at upper level is blocked if both gates are at least as tall as the higher of from/to levels. Write a test constructing a ladybug crossing between two height-2 stacks; if current code allows it, apply `canSlide` with explicit heights on each ladybug step (on-top steps use `fromHOverride` = current level). Also add a test documenting that a pillbug cannot throw a piece the opponent just placed (current behaviour, kept).
- [ ] Step 5: Run a 500-game random fuzz (scratch script) asserting invariants (hive connected, only beetle/mosquito stacked, supply ≥ 0). `npm test` green.
- [ ] Step 6: Update CLAUDE.md "Beetle gate check" note; commit `fix(rules): ground slides must keep hive contact`.

### Task 2: Server hardening

**Files:** Modify `server/server.js`, `server/rooms.js`, `js/app.js` (SEAT_OCCUPIED handling, endReason). Tests `test/multiplayer.test.js` (+ new cases).

**Interfaces:** Produces: `ROOM_RESUMED { code, player, token, gameState, settings, endReason? }`, `GAME_OVER { winner, reason }` where reason ∈ `'QUEEN'|'RESIGN'|'DRAW'`; new error reason `ALREADY_IN_ROOM`; `resumeRoom` replaces an existing seat socket (calls `old.terminate?.()` and detaches its `_hiveRoom`).

- [ ] Step 1: Failing tests:
  - `handleMessage` (export it or test via a real ws server on port 0) with raw `null`, `42`, `"x"`, `{type:'CREATE_ROOM', settings:null}` → server still up, replies `ERROR` or ignores; next valid CREATE_ROOM works.
  - Resume with valid token while old socket `readyState===OPEN` → succeeds, old socket terminated.
  - Host created room: wait timer is 10 min (inject fake timers or export timeout constants and spy `setTimeout`) and not replaced by host join.
  - Close event from a superseded socket does not broadcast `OPPONENT_DISCONNECTED`.
  - Seated socket sending CREATE_ROOM/JOIN_ROOM → `ERROR ALREADY_IN_ROOM`.
  - Resign then resume → `ROOM_RESUMED.endReason === 'RESIGN'`.
- [ ] Step 2: Run → fail.
- [ ] Step 3: Implement; add ws heartbeat (`ping` every 30 s, terminate sockets with no `pong` since last ping; `clearInterval` on server close). In `app.js`, `SEAT_OCCUPIED` is no longer expected; keep handler non-fatal-safe.
- [ ] Step 4: `npm test` green; manual: two Playwright browser contexts play 3 moves online, kill one context's network (`context.setOffline(true)` 3 s then false) → it resumes.
- [ ] Step 5: Commit `fix(server): survive malformed messages, reclaim half-open seats, heartbeat`.

### Task 3: Status/win copy for stalemate and resign

**Files:** `js/hints.js`, `js/app.js` (pass `winReason`, use server `reason`/`endReason`). Test `test/ui-logic.test.js`.

**Interfaces:** `statusText({ ..., winReason })` with `winReason ∈ 'QUEEN'|'STALEMATE'|'RESIGN'|null`.

- [ ] Step 1: Failing tests: draw + `STALEMATE` → text contains `NO MOVES`; draw + `QUEEN` → `BOTH QUEENS SURROUNDED`; resign → contains `RESIGNED`.
- [ ] Step 2–4: fail → implement → pass.
- [ ] Step 5: Commit.

### Gate P0 (critic)
Critic re-runs the bug-hunt repros as tests, reviews diffs for regressions, runs fuzz, plays a local game to a win in the browser and an online game across two contexts with a forced disconnect. Sign-off required.

---

## Phase 1 — Neon Bestiary art

### Task 4: Sprite redraw + species colours

**Files:** Rewrite path data in `js/sprites.js`; modify `styles.css` (`:root` tokens `--sp-queen` … `--sp-pillbug`; `.p1`/`.p2` sprite rules), `js/app.js`/`js/menu.js` only where they set sprite colour. Test `test/sprites.test.js`.

**Interfaces:** Produces `export const SPECIES_COLOR: Record<PieceType, string>` (values from Global Constraints); `spriteSVG(type, cls?)` sets `style="color:<species>"` by default unless `cls` includes `mono`; `drawSprite(ctx, type, x, y, size, {ink, fill, glow})` unchanged — callers pass species colour as `ink`. Keep menu icons `HOUSE`, `SIGNAL`, `GAMEPAD`, `CROWN`.

- [ ] Step 1: Tests: every PieceType has a `SPECIES_COLOR` hex; every colour's RGB distance to `#ff2d78` and `#00f5ff` > 90 (Euclidean); `spriteSVG` output contains the species colour.
- [ ] Step 2: Fail → Step 3: redraw art. Recipe: filled body mass (fill = species colour at ~40% alpha, outline = species colour), interior detail lines, dot fills; stroke 2.6; silhouettes modelled on the user's neon concept sheet (`ChatGPT Image Apr 12, 2026, 08_54_42 PM.png`): queen bee with crown and striped abdomen, beetle with split elytra, grasshopper side-on with big hind leg, ant three-segment, spider round body with 8 legs, mosquito with long proboscis and wings, ladybug spotted dome, pillbug segmented. Top-down orientation may be relaxed for grasshopper/mosquito/ant (side view reads better) — keep consistent head direction.
- [ ] Step 4: Render a contact sheet (scratch Playwright page with all sprites at 28/48/96 px on `#05050f`, and inside p1/p2 tray tiles) and self-check.
- [ ] Step 5: tests green; commit.

### Task 5: Board tile rendering

**Files:** `js/board.js` (`_drawPieces`, `_drawEmojis`, `_drawPieceVisual`, stack drawing). Test `test/board.test.js` (stack offset helper).

**Interfaces:** Consumes `SPECIES_COLOR`, `drawSprite`. Produces pure helper `export function stackLayers(height, size) → [{dx, dy, scale, shade}]` (bottom first) used for stepped-3D stacks; top tile shows `×N` badge when `height>1`.

- [ ] Step 1: Test `stackLayers(1,40)` → one layer `{dx:0,dy:0,scale:1}`; `stackLayers(3,40)` → 3 layers with strictly decreasing `dy` (rising) and top `scale ≥ 0.8`.
- [ ] Step 2: Implement tile: dark bevelled face (radial gradient `#141428`→`#07070f`), inner highlight on top edge, thick rim in player colour (line width ≈ size*0.09) with outer glow, species glyph with glow; buried layers as darker slabs offset below. Ghosts/selection/throw rings/last-move marker still distinct.
- [ ] Step 3: Update tray/reserve/tooltip/inspector CSS so frames use player colour and glyphs species colour.
- [ ] Step 4: Screenshot seeded mid-game (all expansions, a 3-high beetle stack) phone + desktop; commit.

### Task 6: App icons

**Files:** Create `assets/icons/icon.svg`, `scripts/make-icons.mjs`, generated `assets/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png`, `favicon-32.png`; modify `index.html` (`<link rel=icon>`, apple-touch-icon); `server/static.js` already allows `/assets/`.

- [ ] Step 1: Icon: queen glyph (species gold) on a dark hex with magenta→cyan gradient rim; maskable variant has 20% safe padding on `#05050f`.
- [ ] Step 2: `node scripts/make-icons.mjs` renders PNGs via Playwright (`import pw from '/opt/node-tools/node_modules/playwright/index.js'` fallback to `playwright`).
- [ ] Step 3: Verify PNG dimensions; commit.

### Gate P1 (critic)
Critic screenshots menu, tray, mid-game with stacks, tooltips, How-to-Play, win screen, phone + desktop; checks legibility at 28 px and rim-vs-glyph distinguishability; blocks until "wowed".

---

## Phase 2 — Juice

### Task 7: `getMovePath`

**Files:** `js/game.js`; Test create `test/paths.test.js`.

**Interfaces:** Produces `export function getMovePath(state, action) → { path: string[], kind: 'slide'|'hop'|'climb'|'throw'|'place' } | null`. `path` includes start and end; for PLACE `[to]`; for THROW `[from, pillbugHex, to]` kind `throw`; grasshopper `kind:'hop'` with every jumped hex; beetle/ladybug/mosquito-beetle `kind:'climb'` (ladybug path length 4); ant/queen/spider/pillbug `kind:'slide'` (spider length 4, ant shortest legal slide path via BFS with the same step rule as move gen). Returns `null` if `to` is not legal.

- [ ] Step 1: Tests per species on hand-built boards: each consecutive pair adjacent (except hop), path ends equal from/to, spider exactly 4 entries with no repeats, illegal → null, mosquito copying ant yields slide path.
- [ ] Step 2–4: fail → implement (reuse existing move generators' neighbour/step predicates; refactor them to share a `slideStep(board, from, to)` helper if needed) → pass.
- [ ] Step 5: Commit.

### Task 8: Move animation + impact FX

**Files:** `js/board.js`, `js/app.js` (`onStateChanged`, `act`, undo, online GAME_STATE handler). Test `test/board.test.js`.

**Interfaces:** Consumes `getMovePath`. Produces `board.animateMove({ path, kind, piece, player, toKey }) → Promise<void>`; `board.finishAnimations()`; `board.reducedMotion` bool; pure `export function tweenPoint(points, t, kind) → {x, y, lift}` (lift 0..1 for arc height/scale).

- [ ] Step 1: Tests for `tweenPoint`: t=0 → first point, t=1 → last, slide midpoint on polyline, hop lift peaks at t=0.5, lift=0 at ends.
- [ ] Step 2: Implement tween (durations per Global Constraints; place = drop from above with squash), hide moving top piece at destination while in flight, landing ripple (player colour) + 10–16 sparks (species colour), 2–3 px nudge on climb/throw. `finishAnimations()` called at start of `act()`, `undo()`, and on new GAME_STATE.
- [ ] Step 3: Wire: local `act` computes path from prev state; online handler computes from previous `gameState` using `describeLastMove`-derived action; null path → `markArrival` pop only. Undo: no animation.
- [ ] Step 4: Review-focus tests (pure, in `ui-logic.test.js`): helper `inferAction(prev, next)` returns the action for place/move/throw and `null` for unrelated states. Browser: record a short frame series (screenshots at 0/150/300 ms) of an ant move and grasshopper hop; undo mid-flight leaves no ghost.
- [ ] Step 5: Commit.

### Task 9: Audio + haptics + mute

**Files:** Create `js/audio.js`; modify `js/app.js`, `index.html` (menu item "SOUND: ON/OFF"), `styles.css`.

**Interfaces:** `export const sfx = { unlock(), play(name), setMuted(bool), muted }`, names: `select, deselect, place, slide, hop, climb, throw, invalid, turn, danger, win, lose`. `play` also calls `navigator.vibrate` pattern for `place/slide/hop/climb/throw` (12 ms), `danger` ([30,40,30]), `win` ([40,60,80]). Persist key `hiveMuted`. `M` key toggles.

- [ ] Step 1: Unit test with a fake AudioContext injected (`sfx._setContextFactory(fn)`): `play` before unlock is a no-op; muted → no nodes created, no vibrate.
- [ ] Step 2: Implement synth voices (oscillator + gain envelopes + filtered noise; each < 400 ms, win ≈ 1.2 s arpeggio). Polished, not harsh: master gain 0.35, gentle lowpass.
- [ ] Step 3: Wire to select/deselect/act/invalid tap/turn/win; commit.

### Task 10: Queen danger meter + win sequence

**Files:** `js/game.js` (pure `queenPressure(state) → {1: n|null, 2: n|null}`), `js/board.js` (pips), `js/app.js` (HUD chip pips, status, win delay), `js/hints.js`. Tests `test/game.test.js`, `test/ui-logic.test.js`.

- [ ] Step 1: Tests: `queenPressure` counts occupied neighbours of each queen (null if unplaced); `statusText` with pressure 5 for current mover's queen → contains `QUEEN IN DANGER`.
- [ ] Step 2: Implement pips (6 small hex dots around queen, filled per occupied neighbour direction; 4 amber pulse, 5 red pulse); play `danger` once per upward transition to 5.
- [ ] Step 3: Win sequence: final move animates at 0.4× speed, shockwave ring from surrounded queen(s), board dim 30%, then existing confetti + card (total ≤ 1.6 s). Reduced motion: card after 300 ms.
- [ ] Step 4: Commit.

### Gate P2 (critic)
Critic films frame sequences (Playwright screenshots every 60 ms) of every move kind, checks timings, undo mid-tween, online opponent move animation across two contexts, danger meter states, win sequence, reduced-motion emulation, audio calls (spy on `sfx.play`). Blocks until "wowed".

---

## Phase 3 — History, replay, PWA

### Task 11: Notation

**Files:** Create `js/notation.js`; Test `test/notation.test.js`.

**Interfaces:** `export function toNotation(prevState, action) → string`; `export function pieceIds(state) → Map<hexKey, string[]>` (id per stack layer). Ids: `w`=P1, `b`=P2; letters Q A G B S M L P; numbered by placement order per type (Q, M, L, P unnumbered). Reference markers follow the BoardSpace/Mzinga convention for a pointy-top board: marker before the reference = moved piece on its left side (`-X` W, `/X` SW, `\X` NW), after = right side (`X-` E, `X/` NE, `X\` SE). Our board is flat-top, so define one documented table mapping each of our six `DIRS` indices (clockwise from E) to a marker by a fixed 30° rotation (`DIRS[0]`→`X-`, then clockwise `X\`, `\X`... in order: `X-`, `X\`, `/X`, `-X`, `\X`, `X/`). Reference piece = first occupied neighbour of the destination in `DIRS` order, using its top-of-stack id. Climb: `wB1 bQ`. First move: `wS1`. Pass: `pass`.

- [ ] Step 1: Tests: first placement `wA1`; second `bS1 wA1-` (or correct side); beetle climb `wB1 bQ`; numbering increments; pass; throw yields thrown piece id with destination.
- [ ] Step 2–4: fail → implement → pass. Step 5: commit.

### Task 12: Move log (local, save, online)

**Files:** `js/app.js`, `js/local-save.js` (VERSION 2, accepts v1 → empty log), `server/server.js` (`room.history` of notation strings; included in `GAME_STATE`/`ROOM_RESUMED` as `history`). Tests `test/ui-logic.test.js` or new `test/history.test.js`, `test/multiplayer.test.js`.

**Interfaces:** `moveLog: Array<{ notation, player, turnNumber, action }>`; `encodeLocalSave({settings, state, history, moveLog})`, `decodeLocalSave → {..., moveLog}`.

- [ ] Step 1: Tests: v1 save decodes with `moveLog: []`; v2 round-trip; server GAME_STATE carries growing `history`.
- [ ] Step 2–4: implement (undo pops last entry); pass. Step 5: commit.

### Task 13: Move list panel + replay

**Files:** `index.html` (`#moves-sheet`, `#replay-bar`), `styles.css`, `js/app.js` (or new `js/replay.js` holding replay state machine), win screen REPLAY button, ☰ "MOVES".

**Interfaces:** `js/replay.js` pure-ish: `createReplay(settings, actions) → { states: GameState[], index, step(±1), seek(i) }` built by re-applying actions from `createGame(settings)`. Test `test/history.test.js`: replay of N actions has N+1 states, final equals the game's final board.

- [ ] Step 1: Test → fail → implement `createReplay` → pass.
- [ ] Step 2: Moves sheet (slide-up, numbered rows with sprite + notation, tap row → read-only preview with "BACK TO GAME" pill). Replay bar: ⏮ ◀ ▶/❚❚ ▶ ⏭ + slider + label; step forward animates via Task 8; autoplay 900 ms; COPY MOVES (clipboard, toast). Esc/✕ exits to win card. Tray hidden during replay/preview; input to board disabled except pan/zoom.
- [ ] Step 3: Screenshots; commit.

### Task 14: PWA

**Files:** Create `manifest.json`, `sw.js`; modify `index.html` (manifest link, theme-color, apple meta), `js/app.js` (register SW on http(s), update toast with RELOAD action → `postMessage('SKIP_WAITING')` then reload on `controllerchange`), `server/static.js` (+ content-type for `.webmanifest`/json OK), `test/` static allowlist test.

**Interfaces:** Cache name `hive-v1`; `PRECACHE` lists `/`, `/index.html`, `/styles.css`, every `js/*.js`, icons, font CSS if self-hosted (Google font requests: runtime cache stale-while-revalidate). Never intercept `/ws` or non-GET.

- [ ] Step 1: Test: static allowlist serves `/manifest.json`, `/sw.js`, `/assets/icons/icon-192.png`; rejects `/server/server.js`.
- [ ] Step 2: Implement; Playwright: load, wait for `navigator.serviceWorker.controller`, `context.setOffline(true)`, reload → menu renders, local game playable; manifest parsed with icons 192/512/maskable.
- [ ] Step 3: Update CLAUDE.md (remove "PWA not functional" limitation); commit.

### Gate P3 + Final
Critic: history/replay/notation correctness on a full game, offline install check, then whole-branch review + full end-to-end local game to a win via UI clicks on phone viewport + online smoke. Sign-off required before presenting.
