// win-fx.js — The win sequence and the result card.
//
// The winning move flies in slow motion (app.js starts the flight); at touchdown a white shockwave
// rings out of the surrounded queen(s) and the board dims round them (#board-dim); then confetti and
// the card (#win-screen), timed by winTiming(). While something covers the board (☰ menu, move
// sheet, a review) the card waits (`deferred`) and flushDeferred() shows it once that closes.
//
// Everything live is read through the injected context, so this module owns only its own timers:
//   createWinFx({
//     board,                          the Board (shockwave, dim spotlight, reduced motion)
//     state(), mode(), myPlayer(),    the live game: GameState, 'LOCAL'|'ONLINE', 1|2 (null = spectator)
//     reason(),                       app's win reason: null|'QUEEN'|'RESIGN'|'STALEMATE'|'REPETITION'|'TIMEOUT'
//     moveLog(),                      the move log (REPLAY is offered when it rebuilds the game)
//     covered(),                      true while ☰ / move sheet / review would cover the card
//     beforeCard(),                   called just before the card opens (hides the tooltip)
//     sync(),                         re-render the HUD (syncUI)
//     confettiTypes, fallbackEmoji,   piece types for confetti; emoji per type without Path2D
//   })
// Pure helpers (winCopy, surroundedQueens) are exported for tests.

import { winTiming, queenPips } from './board.js';
import { PieceType } from './game.js';
import { replayForGame } from './replay.js';
import { spriteSVG, drawSprite, SPECIES_COLOR, bodyFill } from './sprites.js';
import { sfx } from './audio.js';

const $ = id => document.getElementById(id);
const other = player => (player === 1 ? 2 : 1);

/** Hex keys of every queen with all six sides occupied. */
export function surroundedQueens(board) {
  return queenPips(board).filter(m => m.count === 6).map(m => m.key);
}

/**
 * Headline, reason line and emblem for the result card.
 * @param {{state:object, mode:'LOCAL'|'ONLINE', myPlayer:1|2, reason:string|null}} opts
 */
export function winCopy({ state, mode, myPlayer, reason }) {
  const winner = state.winner;
  const rounds = Math.max(1, Math.ceil((state.turnNumber - 1) / 2));
  const online = mode === 'ONLINE' && myPlayer != null; // a spectator (null) reads the neutral "PLAYER N" copy
  const name   = p => (online ? (p === myPlayer ? 'YOU' : 'OPPONENT') : `PLAYER ${p}`);

  if (winner === 'DRAW') {
    return {
      headline: "IT'S A DRAW",
      reason: reason === 'STALEMATE'
        ? 'Neither player has a legal move left.'
        : reason === 'REPETITION' || state.drawReason === 'REPETITION'
          ? 'The same position occurred three times.'
          : 'Both queens were surrounded on the same move.',
      emblem: PieceType.QUEEN,
    };
  }

  const loser = other(winner);
  const headline = online ? (winner === myPlayer ? 'YOU WIN!' : 'YOU LOSE') : `PLAYER ${winner} WINS!`;
  if (reason === 'TIMEOUT') {
    return {
      headline,
      reason: online ? (loser === myPlayer ? 'You ran out of time.' : 'Your opponent ran out of time.') : `Player ${loser} ran out of time.`,
      emblem: 'STOPWATCH',
    };
  }
  if (reason === 'RESIGN') {
    return {
      headline,
      reason: online && loser === myPlayer ? 'You resigned the game.' : `${online ? 'Your opponent' : `Player ${loser}`} resigned.`,
      emblem: PieceType.QUEEN,
    };
  }
  const whose = online ? (loser === myPlayer ? 'Your' : "Your opponent's") : `${name(loser)[0]}${name(loser).slice(1).toLowerCase()}'s`;
  return { headline, reason: `${whose} queen was surrounded after ${rounds} round${rounds === 1 ? '' : 's'}.`, emblem: PieceType.QUEEN };
}

// ── Confetti ───────────────────────────────────────────

const SPRITE_SIZE   = 36;
const CONFETTI_GLOW = ['#ff2d78', '#00f5ff'];

/**
 * Pre-render each bug sprite once (species colour, with each player's glow) to a small
 * offscreen canvas. drawImage() is a fast GPU blit; re-drawing paths every frame is not.
 */
function renderBugSprites(types, fallbackEmoji) {
  return types.flatMap(type => CONFETTI_GLOW.map(glow => {
    const colors = { ink: SPECIES_COLOR[type], fill: bodyFill(SPECIES_COLOR[type]), glow };
    const px  = SPRITE_SIZE * 3; // enough backing pixels for the largest particle at dpr 2
    const oc  = document.createElement('canvas');
    oc.width  = px;
    oc.height = px;
    const octx = oc.getContext('2d');
    if (!drawSprite(octx, type, px / 2, px / 2, px, colors)) {
      octx.font         = `${px - 12}px serif`;
      octx.textAlign    = 'center';
      octx.textBaseline = 'middle';
      octx.fillText(fallbackEmoji[type] ?? '?', px / 2, px / 2);
    }
    return oc;
  }));
}

export function createWinFx(ctx) {
  const { board } = ctx;
  let presented  = false;  // the card is up (or was skipped to): nothing from the sequence fires after
  let cardTimer  = null;   // the card, on the clock
  let fxTimer    = null;   // shockwave + dim when the winning move did not fly
  let touchdown  = null;   // …or run by board.onLand when the winning piece touches down
  let deferred   = null;   // card options while the ☰ menu / sheet / review held the card back
  let holdResult = false;  // the winning piece is still in the air: the HUD keeps the result for the impact
  let bugSprites = null;   // confetti sprites, rendered on first use
  let confettiRaf = null;

  // ── Board dim ──

  /** Dim the board round the fallen queen(s): a spotlight on them, the rest 45% darker (evenly with no fallen queen). */
  function showDim(keys) {
    const el = $('board-dim');
    const spots = keys.map(k => board.hexToScreen(k));
    el.classList.toggle('plain', !spots.length);
    if (spots.length) {
      const x = spots.reduce((a, p) => a + p.x, 0) / spots.length;
      const y = spots.reduce((a, p) => a + p.y, 0) / spots.length;
      const spread = Math.max(0, ...spots.map(p => Math.hypot(p.x - x, p.y - y)));
      el.style.setProperty('--dim-x', `${x}px`);
      el.style.setProperty('--dim-y', `${y}px`);
      el.style.setProperty('--dim-r', `${Math.round(spread + board.SIZE * board.scale * 0.95)}px`);
    }
    el.classList.add('visible');
  }

  function hideDim() {
    $('board-dim').classList.remove('visible');
  }

  // ── Confetti ──

  function stopConfetti() {
    if (confettiRaf !== null) cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    $('confetti-layer').style.display = 'none';
  }

  function launchConfetti() {
    stopConfetti();
    if (board.reducedMotion) return;
    bugSprites ??= renderBugSprites(ctx.confettiTypes, ctx.fallbackEmoji);

    const cv  = $('confetti-layer');
    const g   = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight; // particles live in CSS px
    cv.width  = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width  = `${W}px`;
    cv.style.height = `${H}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv.style.display = 'block';

    // No respawn: particles start above the screen and fall through once.
    // Stagger start Y so they don't all arrive at once.
    const pts = Array.from({ length: 52 }, () => ({
      x:      Math.random() * W,
      y:      -SPRITE_SIZE - Math.random() * H * 0.9,
      vx:     (Math.random() - 0.5) * 2.2,
      vy:     1.6 + Math.random() * 3.2,
      sprite: bugSprites[Math.floor(Math.random() * bugSprites.length)],
      scale:  0.55 + Math.random() * 0.7,
      rot:    Math.random() * Math.PI * 2,
      vr:     (Math.random() - 0.5) * 0.10,
    }));

    const DUR   = 4000;
    const start = performance.now();

    function tick(now) {
      const elapsed = now - start;
      g.clearRect(0, 0, W, H);
      if (elapsed > DUR) { stopConfetti(); return; }
      g.globalAlpha = elapsed > DUR - 800 ? 1 - (elapsed - (DUR - 800)) / 800 : 1;

      for (const p of pts) {
        if (p.y > H + SPRITE_SIZE) continue; // already off screen, skip
        p.x   += p.vx;
        p.y   += p.vy;
        p.vy  += 0.06; // gentle gravity
        p.rot += p.vr;
        const sz = SPRITE_SIZE * p.scale;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.drawImage(p.sprite, -sz / 2, -sz / 2, sz, sz);
        g.restore();
      }

      g.globalAlpha = 1;
      confettiRaf = requestAnimationFrame(tick);
    }

    confettiRaf = requestAnimationFrame(tick);
  }

  // ── Sequence + card ──

  /**
   * The climax: shockwave + dim at touchdown, then confetti and the card. Reduced motion: no
   * shockwave, the card after 300 ms.
   * @param {{kind:string, path:string[]}|null} move the flown route, if any
   */
  function play(move) {
    if (cardTimer) clearTimeout(cardTimer);
    if (fxTimer) clearTimeout(fxTimer);
    const timing = winTiming(move?.kind ?? null, (move?.path.length ?? 1) - 1, { reducedMotion: board.reducedMotion });
    const queens = surroundedQueens(ctx.state().board);
    const impact = () => {
      fxTimer = touchdown = null;
      holdResult = false;
      board.shockwave(queens);
      showDim(queens);
      ctx.sync();
    };
    // Synced to the actual touchdown (frames can lag the clock); the card keeps to the clock.
    if (timing.flightMs) touchdown = impact;
    else fxTimer = setTimeout(impact, 0);
    cardTimer = setTimeout(showCard, timing.cardMs);
  }

  /** @param {{calm?: boolean}} [opts] calm: a game that was already over (resume) — no sting, no confetti */
  function showCard({ calm = false } = {}) {
    cardTimer = null;
    const state = ctx.state();
    if (presented || !state?.winner) return;
    // The player opened ☰ (or the move list) during the sequence: leave it be; the card follows when it closes.
    if (ctx.covered()) { deferred = { calm }; return; }
    settle();
    ctx.beforeCard();
    openCard();
    ($('btn-rematch').hidden ? $('btn-view-board') : $('btn-rematch')).focus();
    const winner = state.winner;
    const watching = ctx.mode() === 'ONLINE' && ctx.myPlayer() == null;
    const lost = ctx.mode() === 'ONLINE' && !watching && winner !== ctx.myPlayer() && winner !== 'DRAW';
    if (!calm) {
      // A spectator has no side: the neutral sting, never the loser's.
      sfx.play(winner === 'DRAW' || watching ? 'draw' : lost ? 'lose' : 'win');
      if (!lost) launchConfetti();
    }
    ctx.sync();
  }

  /** Show the card after `ms` (replacing any card already on the clock). */
  function scheduleCard(ms, opts) {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(() => showCard(opts), ms);
  }

  /** The result is shown (or skipped to): nothing from the win sequence may fire after this. */
  function settle() {
    presented = true;
    holdResult = false;
    // A touchdown that never came (stalled frames, a snapped flight) must not fire over the card.
    if (cardTimer) clearTimeout(cardTimer);
    if (fxTimer) clearTimeout(fxTimer);
    cardTimer = fxTimer = touchdown = deferred = null;
  }

  /** Fill in and raise the result card (no sound, no confetti). */
  function openCard() {
    const screen = $('win-screen');
    const state  = ctx.state();
    const winner = state.winner;
    const copy   = winCopy({ state, mode: ctx.mode(), myPlayer: ctx.myPlayer(), reason: ctx.reason() });
    const log    = ctx.moveLog();
    screen.className = winner === 'DRAW' ? 'draw' : `p${winner}`;
    $('win-headline').textContent = copy.headline;
    $('win-reason').textContent   = copy.reason;
    $('win-emblem').innerHTML     = spriteSVG(copy.emblem); // on a .mini-tile in the winner's rim
    $('win-emblem').classList.toggle('icon-emblem', copy.emblem === 'STOPWATCH');
    $('btn-rematch').hidden       = ctx.mode() !== 'LOCAL';
    $('btn-replay').hidden        = !log.length || !replayForGame(log, state);
    screen.setAttribute('aria-hidden', 'false');
    screen.inert = false;
    screen.classList.add('active');
  }

  function hide() {
    const screen = $('win-screen');
    screen.classList.remove('active');
    screen.setAttribute('aria-hidden', 'true');
    screen.inert = true;
    stopConfetti();
    hideDim();
  }

  /** Show a card that was held back now that nothing covers it. */
  function flushDeferred() {
    if (!deferred || ctx.covered()) return;
    // Shown a beat later, so a menu choice made in the same click (quit, rematch) cancels it first.
    const opts = deferred;
    deferred = null;
    scheduleCard(250, opts);
  }

  /** Drop everything pending (new game, undo, quit, resume): no timer, touchdown or deferred card survives. */
  function cancel() {
    if (cardTimer) clearTimeout(cardTimer);
    if (fxTimer) clearTimeout(fxTimer);
    cardTimer = fxTimer = touchdown = deferred = null;
    holdResult = false;
  }

  return {
    play, showCard, scheduleCard, settle, openCard, hide, hideDim, flushDeferred, cancel,
    /** A new game, or the win was undone: the next win is presented afresh. */
    reset() { presented = false; },
    get presented() { return presented; },
    get cardPending() { return cardTimer !== null; },
    /** The win impact waiting for the winning piece's touchdown (board.onLand runs it), or null. */
    get touchdown() { return touchdown; },
    /** True while the winning move is in the air: the HUD shows nothing until impact (syncUI). */
    get holdResult() { return holdResult; },
    set holdResult(on) { holdResult = !!on; },
  };
}
