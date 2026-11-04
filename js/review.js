// review.js — Game review (move preview + replay) and the move-list sheet.
//
// One read-only mode serves both entries: tapping a move in the list mid-game (a preview, "BACK TO
// GAME") and REPLAY on the result card (✕ / Esc returns to the card). The board shows a position
// rebuilt from the move log (js/replay.js); the live game is never touched, nothing is saved or
// sent, and leaving puts the live board back (selection cleared, cached layer re-rendered).
//
// Everything live is read or changed through the injected context; this module owns only the review
// (`review`: { replay, log, returnTo: 'game'|'board'|'card', liveLastMove, playing, played, playTimer };
// `played`: autoplay has run, so a mid-game preview is now a replay and the HUD chip says so) and the
// sheet's open/closed state:
//   createReview({
//     board, winFx,                       the Board; the win-fx controller (settle / card / deferred card)
//     state(), mode(), myPlayer(),        the live game
//     moveLog(),                          the live move log
//     pieceNames,                         type → display name
//     holdLive(),                         stop live timers that must not fire inside a review (forced pass, alarms, chime)
//     resumeLive(),                       back on the live game after a preview: run a held-back forced pass
//     closeGameMenu(opts), gameMenuOpen(),
//     hidePieceTooltip(), hideBanner(), hideBoardHint(), clearSelection(),
//     updateInsets(), syncBoardRenderer(), syncUI(), renderQueenMeters(state),
//     toast(text, kind, ms), playMoveSound(kind, inFlight), copyText(text) → Promise<bool>,
//   })
// The board renderer asks `shownState` for the position to draw. Pure helpers are exported for tests.

import { ActionType, getMovePath } from './game.js';
import { describeLastMove, turnChipText } from './hints.js';
import { replayForGame, plyInfo, movesText, notationHTML, escapeHTML } from './replay.js';
import { spriteSVG } from './sprites.js';

const $ = id => document.getElementById(id);

export const AUTOPLAY_MS = 900;
export const REPLAY_HOLD_MS = 600; // a replay from the top lingers on the empty board before move 1

/** "YOU" / "OPPONENT" online, "P1" / "P2" locally. */
export const playerName = (p, mode, myPlayer) => (mode === 'ONLINE' ? (p === myPlayer ? 'YOU' : 'OPPONENT') : `P${p}`);
/** Possessive form for a piece's owner. */
export const pieceOwnerName = (p, mode, myPlayer) => (mode === 'ONLINE' ? (p === myPlayer ? 'YOUR' : 'OPPONENT\'S') : `P${p}`);

/** The exit pill's label for where the review returns to. */
export const returnLabel = returnTo => (returnTo === 'game' ? 'BACK TO GAME' : returnTo === 'card' ? 'CLOSE REPLAY' : 'BACK TO BOARD');

const VERB = { PLACE: 'PLACED', MOVE: 'MOVED' };

/**
 * HUD status line for the reviewed position: what the move that led to it did.
 * @param {object|null} entry move-log entry (null = the empty board)
 */
export function reviewStatusText(entry, { mode, myPlayer, pieceNames = {} } = {}) {
  const info = entry ? plyInfo(entry) : null;
  if (!info) return 'OPENING · EMPTY BOARD';
  const who = playerName(info.player, mode, myPlayer);
  if (info.pass) return `${who} PASSED`;
  const name = pieceNames[info.type] ?? info.type;
  if (entry.action?.type === ActionType.THROW) { // a throw moves either side's piece: say whose
    return `${who} THREW ${pieceOwnerName(info.owner, mode, myPlayer)} ${name}`;
  }
  return `${who} ${VERB[entry.action?.type] ?? 'PLAYED'} ${name}`;
}

/**
 * Group a move log into rounds for the sheet: P1's move on the left, P2's on the right.
 * @returns {Array<[number, {1?: {entry, index}, 2?: {entry, index}}]>} index = 1-based position after that move
 */
export function sheetRounds(log) {
  const rounds = new Map();
  log.forEach((entry, i) => {
    const round = Math.ceil((entry.turnNumber ?? i + 1) / 2);
    if (!rounds.has(round)) rounds.set(round, {});
    rounds.get(round)[entry.player] = { entry, index: i + 1 };
  });
  return [...rounds];
}

export function createReview(ctx) {
  const { board, winFx } = ctx;
  const movesSheet = $('moves-sheet');
  let review = null;
  let sheetInerted = [];
  let sheetReturnFocus = null;

  const nameOf = p => playerName(p, ctx.mode(), ctx.myPlayer());

  /**
   * Enter the review at position `index` (0 = empty board, i = after the i-th move).
   * @returns {boolean} false when this game's log cannot rebuild it (toast says so)
   */
  function enter(index, { returnTo } = {}) {
    const gameState = ctx.state();
    if (!gameState) return false;
    if (review) { seek(index); return true; }
    const log = ctx.moveLog().slice();
    const replay = replayForGame(log, gameState, { index });
    if (!replay) { ctx.toast('HISTORY UNAVAILABLE FOR THIS GAME', 'warn'); return false; }
    if (gameState.winner && !winFx.presented) {
      // The win is still being revealed: skip to the result; leaving the review shows the card.
      winFx.settle();
      winFx.hideDim();
      returnTo = 'card';
    }
    returnTo ??= $('win-screen').classList.contains('active') ? 'card' : gameState.winner ? 'board' : 'game';
    // A forced pass waits for the live board; live alarms and chimes belong to it too.
    ctx.holdLive();
    ctx.closeGameMenu();
    closeSheet({ restoreFocus: false });
    ctx.hidePieceTooltip();
    ctx.hideBanner();
    ctx.hideBoardHint();
    winFx.hide();
    board.finishAnimations({ clearFx: true });
    ctx.clearSelection();

    review = { replay, log, returnTo, liveLastMove: board.lastMove, playing: false, played: false, playTimer: null };
    document.body.classList.add('reviewing');
    $('replay-bar').hidden = false;
    $('review-pill').hidden = false;
    $('review-pill-label').textContent = returnLabel(returnTo);
    $('tray').inert = true;
    ctx.updateInsets();
    fitCamera();
    showPosition(replay.index);
    ctx.syncUI();
    $('rb-play').focus();
    return true;
  }

  /** Leave the review for wherever it was entered from (Esc, ✕ pill). */
  function exit() {
    if (!review) return;
    const { returnTo } = review;
    end();
    if (returnTo === 'card' && ctx.state()?.winner) {
      winFx.openCard();
      $('btn-replay').focus();
    } else {
      $('btn-menu').focus();
      if (returnTo === 'game') ctx.resumeLive(); // e.g. a forced pass held back by the preview runs now
    }
    winFx.flushDeferred();
  }

  /** Tear the review down and put the live board back. Safe to call when not reviewing. */
  function end() {
    if (!review) return;
    stopAutoplay();
    const { liveLastMove } = review;
    review = null;
    document.body.classList.remove('reviewing');
    $('replay-bar').hidden = true;
    $('review-pill').hidden = true;
    $('tray').inert = false;
    board.finishAnimations({ clearFx: true });
    ctx.clearSelection();
    board.lastMove = liveLastMove;
    ctx.syncBoardRenderer();
    board.invalidate();
    ctx.updateInsets();
    if (ctx.state()) {
      board.recenter(true);
      ctx.syncUI();
    }
  }

  /** The live game changed (an opponent's move, a reconnect, a forced pass): back to it. */
  function leaveForLive() {
    if (!review) return;
    closeSheet({ restoreFocus: false });
    end();
    $('btn-menu').focus();
    ctx.toast('BACK TO THE LIVE GAME', '', 1600);
  }

  /** Frame every hex the game ever used, so the camera holds still while the review steps. */
  function fitCamera() {
    board.pieces.clear();
    for (const state of review.replay.states) for (const key of state.board.keys()) board.pieces.set(key, []);
    board.recenter(true);
    ctx.syncBoardRenderer(); // the frame is computed; now the real position
  }

  /**
   * Show replay position `index`. One step forward flies the move along its getMovePath route (with
   * its sounds); anything else (back, jumps, scrubbing) snaps.
   */
  function showPosition(index, { animate = false } = {}) {
    const r = review.replay;
    const from = r.index;
    r.seek(index);
    const prev = r.index > 0 ? r.states[r.index - 1] : null;
    const forward = animate && prev && r.index === from + 1;
    board.finishAnimations({ clearFx: !forward });
    board.lastMove = prev ? describeLastMove(prev, r.state) : null;
    ctx.syncBoardRenderer();
    board.invalidate();
    const to = board.lastMove?.to;
    if (forward && to) {
      const move = getMovePath(prev, review.log[r.index - 1].action);
      if (move) board.animateMove({ ...move, toKey: to, player: board.lastMove.player });
      else board.markArrival(to);
      ctx.playMoveSound(move?.kind, board.hiddenTop.has(to));
      board.reveal([to, ...(move?.path ?? [])], [], { anchor: to });
    }
    syncReviewUI();
  }

  /** A step, jump or scrub by the player: autoplay stops. */
  function seek(index, { animate = false } = {}) {
    if (!review) return;
    stopAutoplay();
    showPosition(index, { animate });
  }

  /** @param {{ hold?: boolean }} opts hold: stay on the current position for a beat before stepping */
  function startAutoplay({ hold = false } = {}) {
    if (!review) return;
    review.playing = review.played = true;
    if (review.replay.atEnd) {
      showPosition(0); // from the top, like a video player
      scheduleAutoplay();
    } else if (hold) {
      scheduleAutoplay(REPLAY_HOLD_MS);
    } else {
      autoplayStep();
    }
    syncReviewUI();
  }

  function autoplayStep() {
    if (!review?.playing) return;
    showPosition(review.replay.index + 1, { animate: true });
    if (review.replay.atEnd) stopAutoplay();
    else scheduleAutoplay();
  }

  function scheduleAutoplay(ms = AUTOPLAY_MS) {
    if (review.playTimer) clearTimeout(review.playTimer);
    review.playTimer = setTimeout(autoplayStep, ms);
  }

  function stopAutoplay() {
    if (!review) return;
    if (review.playTimer) clearTimeout(review.playTimer);
    review.playTimer = null;
    review.playing = false;
    syncPlayButton();
  }

  function toggleAutoplay() {
    if (review?.playing) stopAutoplay();
    else startAutoplay();
  }

  function syncPlayButton() {
    const playing = !!review?.playing;
    const btn = $('rb-play');
    btn.classList.toggle('playing', playing);
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /** Replay bar, HUD and exit pill for the position under review (syncUI calls this last). */
  function syncReviewUI() {
    if (!review) return;
    const gameState = ctx.state();
    const mode = ctx.mode(), myPlayer = ctx.myPlayer();
    const r = review.replay;
    const i = r.index, n = r.states.length - 1;
    const entry = i ? review.log[i - 1] : null;
    const info  = entry ? plyInfo(entry) : null;

    // Replay bar
    const bar = $('replay-bar');
    bar.dataset.player = info ? String(info.player) : '';
    // Long and compact forms; CSS shows the compact one where the one-row landscape bar is tight.
    $('rb-count').innerHTML = i
      ? `<span class="rb-long">MOVE ${i} / ${n}</span><span class="rb-short">${i}/${n}</span>`
      : `<span class="rb-long">START · ${n} MOVE${n === 1 ? '' : 'S'}</span><span class="rb-short">START</span>`;
    $('rb-notation').innerHTML = info ? notationHTML(info.text) : 'EMPTY BOARD';
    $('rb-tile').innerHTML = info?.type ? spriteSVG(info.type) : '';
    $('rb-tile').classList.toggle('blank', !info?.type);
    const slider = $('rb-slider');
    slider.max = String(n);
    slider.value = String(i);
    slider.style.setProperty('--pct', `${n ? (i / n) * 100 : 0}%`);
    slider.setAttribute('aria-valuetext', i ? `Move ${i} of ${n}${info ? `, ${nameOf(info.player)} ${info.text}` : ''}` : 'Start, empty board');
    $('rb-first').disabled = $('rb-prev').disabled = i === 0;
    $('rb-next').disabled = $('rb-last').disabled = i === n;
    $('rb-play').disabled = n === 0;
    syncPlayButton();

    // HUD: what is on the board now is the position under review
    const shownPlayer = info?.player ?? 1;
    $('hud').className = `game-visible turn-p${shownPlayer} reviewing`;
    $('turn-chip').className = info ? `p${info.player}` : 'p1 waiting';
    $('chip-label').textContent = review.returnTo === 'game' && !review.played ? 'PREVIEW' : 'REPLAY';
    $('chip-sub').textContent = `MOVE ${i}/${n}`;
    const status = $('status-text');
    status.className = 'active';
    status.textContent = reviewStatusText(entry, { mode, myPlayer, pieceNames: ctx.pieceNames });
    if (i === n && gameState.winner) status.textContent += ` · ${turnChipText({ state: gameState, mode, myPlayer })}`;
    $('piece-desc').classList.remove('visible');
    ctx.renderQueenMeters(r.state);
    for (const id of ['btn-pass', 'btn-undo', 'btn-cancel']) $(id).classList.add('hidden');

    if (sheetOpen()) syncMovesHighlight();
  }

  /** Keys while reviewing; returns true when the key was handled here (always false when not reviewing). */
  function handleKey(event) {
    if (!review) return false;
    const key = event.key;
    if (key === 'Escape') {
      if (ctx.gameMenuOpen()) ctx.closeGameMenu({ restoreFocus: true });
      else exit();
      return true;
    }
    if (ctx.gameMenuOpen() || event.ctrlKey || event.metaKey || event.altKey) return false;
    // The slider and buttons keep their own keys (arrows move the slider; Space presses a button).
    const onSlider = event.target === $('rb-slider');
    const onButton = !!event.target.closest?.('button');
    const i = review.replay.index;
    if (!onSlider && (key === 'ArrowRight' || key === 'ArrowLeft')) {
      event.preventDefault();
      seek(i + (key === 'ArrowRight' ? 1 : -1), { animate: key === 'ArrowRight' });
      return true;
    }
    if (!onSlider && (key === 'Home' || key === 'End')) {
      event.preventDefault();
      seek(key === 'Home' ? 0 : review.replay.states.length - 1);
      return true;
    }
    if ((key === ' ' || key.toLowerCase() === 'k') && !onButton) {
      event.preventDefault();
      toggleAutoplay();
      return true;
    }
    return false;
  }

  $('review-pill').addEventListener('click', exit);
  $('rb-first').addEventListener('click', () => seek(0));
  $('rb-prev').addEventListener('click', () => seek(review.replay.index - 1));
  $('rb-next').addEventListener('click', () => seek(review.replay.index + 1, { animate: true }));
  $('rb-last').addEventListener('click', () => seek(review.replay.states.length - 1));
  $('rb-play').addEventListener('click', toggleAutoplay);
  $('rb-slider').addEventListener('input', event => seek(Number(event.target.value)));
  $('rb-moves').addEventListener('click', () => openSheet());
  $('rb-copy').addEventListener('click', () => copyMoves());

  // ── Move list sheet ──

  function sheetOpen() {
    return movesSheet.classList.contains('active');
  }

  function openSheet() {
    if (!ctx.state() || sheetOpen()) return;
    ctx.closeGameMenu();
    ctx.hidePieceTooltip();
    sheetReturnFocus = document.activeElement;
    renderSheet();
    movesSheet.inert = false;
    movesSheet.classList.add('active');
    movesSheet.setAttribute('aria-hidden', 'false');
    // Modal: everything else is inert while it is open (the toast stays live: an update's RELOAD).
    document.body.classList.add('sheet-open'); // toasts move up to the HUD, clear of the rows
    sheetInerted = [...document.body.children].filter(el => el !== movesSheet && el !== $('toast') && !el.inert);
    for (const el of sheetInerted) el.inert = true;
    const current = $('moves-list').querySelector('.mv-ply.current:not(:disabled)');
    current?.scrollIntoView({ block: 'center' });
    (current ?? $('btn-close-moves')).focus({ preventScroll: true });
  }

  function closeSheet({ restoreFocus = true } = {}) {
    if (!sheetOpen()) return;
    movesSheet.classList.remove('active');
    movesSheet.setAttribute('aria-hidden', 'true');
    movesSheet.inert = true; // its buttons leave the tab order while it is closed
    document.body.classList.remove('sheet-open');
    for (const el of sheetInerted) el.inert = false;
    sheetInerted = [];
    if (restoreFocus) {
      const back = sheetReturnFocus?.isConnected && sheetReturnFocus.offsetParent !== null ? sheetReturnFocus
        : review ? $('rb-moves') : $('btn-menu');
      back.focus();
    }
    sheetReturnFocus = null;
    winFx.flushDeferred();
  }

  /** The log the sheet lists, the position it marks as current, and whether rows can be previewed. */
  function sheetModel() {
    if (review) return { log: review.log, current: review.replay.index, playable: true };
    const log = ctx.moveLog();
    return { log, current: log.length, playable: !!replayForGame(log, ctx.state()) };
  }

  function renderSheet() {
    const { log, current, playable } = sheetModel();
    const focused = document.activeElement?.closest?.('#moves-list .mv-ply')?.dataset.index;
    $('moves-count').textContent = `${log.length} MOVE${log.length === 1 ? '' : 'S'}`;
    const note = $('moves-note');
    note.hidden = playable;
    note.textContent = 'HISTORY UNAVAILABLE FOR THIS GAME — it was saved by an older version, so past positions can’t be shown.';

    const cell = ply => {
      if (!ply) return '<span class="mv-ply mv-none" aria-hidden="true"></span>';
      const info = plyInfo(ply.entry);
      const label = `Move ${ply.index}: ${nameOf(info.player)} ${info.pass ? 'passed' : info.text}`;
      return `<button class="mv-ply p${info.player}${info.pass ? ' pass' : ''}${ply.index === current ? ' current' : ''}" type="button"
        data-index="${ply.index}" aria-label="${escapeHTML(label)}"${ply.index === current ? ' aria-current="step"' : ''}${playable ? '' : ' disabled'}>
        <span class="mini-tile mv-tile${info.type ? '' : ' blank'}" aria-hidden="true">${info.type ? spriteSVG(info.type) : ''}</span>
        <span class="mv-text">${notationHTML(info.text)}</span></button>`;
    };
    $('moves-list').innerHTML = log.length
      ? sheetRounds(log).map(([round, plies]) =>
        `<li class="mv-row"><span class="mv-num" aria-hidden="true">${round}</span>${cell(plies[1])}${cell(plies[2])}</li>`).join('')
      : `<li class="mv-empty">${playable ? 'NO MOVES YET' : 'NO MOVES RECORDED SINCE RESUMING'}</li>`;

    $('btn-copy-moves').disabled = !log.length;
    $('btn-moves-replay').hidden = !playable || !log.length || !!review; // the replay bar already plays it
    if (focused) $('moves-list').querySelector(`[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }

  /** Re-mark the current row without rebuilding the list (the replay stepped under the open sheet). */
  function syncMovesHighlight() {
    const { current } = sheetModel();
    for (const btn of $('moves-list').querySelectorAll('.mv-ply[data-index]')) {
      const on = Number(btn.dataset.index) === current;
      btn.classList.toggle('current', on);
      if (on) btn.setAttribute('aria-current', 'step');
      else btn.removeAttribute('aria-current');
    }
  }

  function movesTitle() {
    const gameState = ctx.state();
    const w = gameState.winner;
    const result = w === 'DRAW' ? 'DRAW' : w ? `P${w} WINS` : 'IN PROGRESS';
    const exps = Object.entries(gameState.settings.expansions ?? {}).filter(([, on]) => on).map(([name]) => name.toUpperCase());
    return `HIVE · P1 (w) vs P2 (b) · ${result}${exps.length ? ` · +${exps.join(' +')}` : ''}`;
  }

  /** @param {{ inline?: boolean }} opts inline: answer on the sheet's own button (a toast would cover its rows) */
  async function copyMoves({ inline = false } = {}) {
    const log = review ? review.log : ctx.moveLog();
    if (!ctx.state() || !log.length) { ctx.toast('NO MOVES TO COPY YET', 'warn', 1400); return; }
    const ok = await ctx.copyText(movesText(log, { title: movesTitle() }));
    if (inline) flashCopyButton(ok);
    else ctx.toast(ok ? `${log.length} MOVE${log.length === 1 ? '' : 'S'} COPIED` : 'COULD NOT COPY THE MOVES', ok ? 'good' : 'error', 1600);
  }

  const COPY_MOVES_HTML = $('btn-copy-moves').innerHTML;
  const CHECK_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let copyFlashTimer = null;
  /** "COPIED" (or "COPY FAILED") on the sheet's COPY MOVES button for a moment. */
  function flashCopyButton(ok) {
    const btn = $('btn-copy-moves');
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    btn.innerHTML = ok ? `${CHECK_ICON} COPIED` : 'COPY FAILED';
    btn.classList.toggle('copied', ok);
    btn.classList.toggle('copy-failed', !ok);
    copyFlashTimer = setTimeout(() => {
      copyFlashTimer = null;
      btn.innerHTML = COPY_MOVES_HTML;
      btn.classList.remove('copied', 'copy-failed');
    }, 1600);
  }

  $('btn-close-moves').addEventListener('click', () => closeSheet());
  $('btn-copy-moves').addEventListener('click', () => copyMoves({ inline: true }));
  $('btn-moves-replay').addEventListener('click', () => {
    closeSheet({ restoreFocus: false });
    if (enter(0)) startAutoplay({ hold: true });
  });
  movesSheet.addEventListener('click', event => {
    if (event.target === movesSheet) { closeSheet(); return; } // the scrim
    const ply = event.target.closest('.mv-ply[data-index]');
    if (!ply || ply.disabled) return;
    const index = Number(ply.dataset.index);
    closeSheet({ restoreFocus: false });
    if (review) { seek(index); $('rb-play').focus(); }
    else enter(index);
  });
  movesSheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSheet();
      return;
    }
    const plies = [...$('moves-list').querySelectorAll('.mv-ply[data-index]:not(:disabled)')];
    const at = plies.indexOf(document.activeElement);
    // Rows hold two moves: Up/Down go a round, Left/Right a move.
    const step = { ArrowDown: 2, ArrowUp: -2, ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? plies.length - 1
      : step === undefined ? null : at < 0 ? 0 : Math.max(0, Math.min(plies.length - 1, at + step));
    if (target !== null && plies.length) {
      event.preventDefault();
      plies[target].focus();
      return;
    }
    if (event.key === 'Tab') {
      // Keep focus inside the sheet.
      const focusable = [...$('moves-panel').querySelectorAll('button:not(:disabled):not([hidden])')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  return {
    enter, exit, end, leaveForLive, seek, startAutoplay, handleKey, openSheet, closeSheet, sheetOpen,
    /** syncUI's last step: the review's HUD/bar, and the open sheet. */
    sync() {
      if (review) syncReviewUI();
      if (sheetOpen()) renderSheet();
    },
    get active() { return !!review; },
    /** The position under review (null when not reviewing): what the board shows instead of the live game. */
    get shownState() { return review?.replay.state ?? null; },
  };
}
