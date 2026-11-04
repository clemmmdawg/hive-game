// app.js — Game state machine + UI
import { hexKey, hexToPixel } from './hex.js';
import { Board, moveDuration, winTiming, queenPips } from './board.js';
import {
  PieceType, ActionType,
  createGame, applyAction,
  getLegalPlacements, getLegalMoves, getLegalThrows, getMoveBlocker,
  getAllLegalActions, deserializeState, getMovePath, queenPressure, neighbors,
} from './game.js';
import { initMenu, showMenu, showConfirm, showRules, leaveOnlineSession, isOverlayOpen } from './menu.js';
import {
  statusText, describeLastMove, inferAction, winReasonFromServer, resumedWinReason, turnChipText,
  dangerText, newDangers,
} from './hints.js';
import { encodeLocalSave, decodeLocalSave, MAX_UNDO } from './local-save.js';
import { spriteSVG, drawSprite, SPECIES_COLOR, bodyFill } from './sprites.js';
import * as net from './net.js';
import { sfx } from './audio.js';

// ── Piece display definitions ──────────────────────────

const PIECE_UI = {
  [PieceType.QUEEN]:       { emoji: '🐝', label: 'QUEEN',  image: 'assets/pieces/queen.png'       },
  [PieceType.BEETLE]:      { emoji: '🪲', label: 'BEETLE', image: 'assets/pieces/beetle.png'      },
  [PieceType.GRASSHOPPER]: { emoji: '🦗', label: 'HOP',    image: 'assets/pieces/grasshopper.png' },
  [PieceType.ANT]:         { emoji: '🐜', label: 'ANT',    image: 'assets/pieces/ant.png'         },
  [PieceType.SPIDER]:      { emoji: '🕷️', label: 'SPIDER', image: 'assets/pieces/spider.png'      },
  [PieceType.MOSQUITO]:    { emoji: '🦟', label: 'MOSQ',   image: 'assets/pieces/mosquito.png'    },
  [PieceType.LADYBUG]:     { emoji: '🐞', label: 'LADY',   image: 'assets/pieces/ladybug.png'     },
  [PieceType.PILLBUG]:     { emoji: '🐛', label: 'PILL',   image: 'assets/pieces/pillbug.png'     },
};

const startupFlags = new URLSearchParams(window.location.search);
const USE_PIECE_ART = ['png', '1', 'true'].includes(
  (startupFlags.get('pieceArt') ?? startupFlags.get('piece-art') ?? '').toLowerCase()
);
// PNGs are opt-in progressive enhancement; SVG sprites (js/sprites.js) are the default.
const PIECE_IMAGES = new Map();
if (USE_PIECE_ART) {
  for (const [type, ui] of Object.entries(PIECE_UI)) {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (gameState) syncBoardRenderer();
    };
    image.onerror = () => PIECE_IMAGES.delete(type);
    image.src = ui.image;
    PIECE_IMAGES.set(type, image);
  }
}

const TRAY_ORDER = [
  PieceType.QUEEN,
  PieceType.BEETLE,
  PieceType.GRASSHOPPER,
  PieceType.ANT,
  PieceType.SPIDER,
  PieceType.MOSQUITO,
  PieceType.LADYBUG,
  PieceType.PILLBUG,
];

// ── Piece descriptions ─────────────────────────────────

const PIECE_DESC = {
  QUEEN:       'Slides 1 space. Surround the enemy queen to win.',
  BEETLE:      'Slides 1 space, or climbs on top of any tile.',
  GRASSHOPPER: 'Jumps in a straight line over 1 or more tiles.',
  ANT:         'Slides to any empty space around the hive.',
  SPIDER:      'Slides exactly 3 spaces along the hive edge.',
  MOSQUITO:    'Copies the movement of any adjacent tile.',
  LADYBUG:     'Moves 2 steps on top of the hive, then 1 step down.',
  PILLBUG:     'Slides 1 space, or tosses an adjacent tile over itself.',
};

const PIECE_NAMES = {
  QUEEN: 'QUEEN BEE', BEETLE: 'BEETLE', GRASSHOPPER: 'GRASSHOPPER', ANT: 'SOLDIER ANT',
  SPIDER: 'SPIDER', MOSQUITO: 'MOSQUITO', LADYBUG: 'LADYBUG', PILLBUG: 'PILLBUG',
};

const $ = id => document.getElementById(id);
const other = player => (player === 1 ? 2 : 1);
const LOCAL_SAVE_KEY = 'hiveLocalGame';
const HINT_SEEN_KEY  = 'hiveBoardHintSeen';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: autosave is best-effort */ }
}

// ── Canvas setup ───────────────────────────────────────

const canvas      = $('board');
const emojiCanvas = $('emoji-layer');
const board       = new Board(canvas, emojiCanvas);

function updateInsets() {
  board.insets = gameState
    ? { top: $('hud').offsetHeight, bottom: $('tray').offsetHeight }
    : { top: 0, bottom: 0 };
}

board.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', () => {
  board.resize(window.innerWidth, window.innerHeight);
  updateInsets();
});

(function loop(t) { board.draw(t); requestAnimationFrame(loop); })(0);

// The ×N stack badges use the pixel font: re-render the cached layer once it has
// loaded, or a cold start keeps the fallback face in the cache.
document.fonts?.ready.then(() => board.invalidate());

// ── Game state ─────────────────────────────────────────

let gameState    = null;
let gameSettings = null;   // saved so "rematch" can reuse them
let gameMode     = 'LOCAL'; // 'LOCAL' | 'ONLINE'
let myPlayer     = 1;       // 1 or 2 — only meaningful in ONLINE mode
let history      = [];      // LOCAL only: states before each action, for undo
let winPresented = false;
let winReason    = null;    // null | 'QUEEN' | 'RESIGN' | 'STALEMATE'
let passTimer    = null;    // pending automatic pass in LOCAL mode
let winTimer     = null;
let winFxTimer   = null;   // shockwave + dim when the winning move did not fly
let winTouchdown = null;   // …or run by board.onLand when the winning piece touches down
let holdResult   = false;  // the winning piece is still in the air: the HUD keeps the result for the impact
let dangerTimer  = null;   // queen-in-danger alarm for a move that did not fly
let landingAlarm = null;   // …or raised by board.onLand when the piece that caused it touches down
let turnSoundTimer = null; // "your turn" chime, held back until the opponent's piece lands
let connectionNotice = null; // shown in place of the status line while offline
let opponentAway = false;

const uiState = {
  phase:           'IDLE',
  trayPick:        null,
  boardPick:       null,
  throwPillbugHex: null,
};

// ── Tooltip / stack inspector ──────────────────────────

const pieceTooltip = $('piece-tooltip');
let pieceTooltipTimer = null;

/**
 * @param {{type:string, owner?:1|2, stack?:Array<{player,type}>}} info
 */
function showPieceTooltip({ type, owner, stack }, x, y, preferAbove = false) {
  if (!PIECE_DESC[type]) return;
  if (pieceTooltipTimer) { clearTimeout(pieceTooltipTimer); pieceTooltipTimer = null; }
  $('piece-tooltip-name').innerHTML = `${spriteSVG(type)}<span>${PIECE_NAMES[type] ?? type}</span>`;
  $('piece-tooltip-copy').textContent = PIECE_DESC[type];
  pieceTooltip.classList.toggle('owner-p1', owner === 1);
  pieceTooltip.classList.toggle('owner-p2', owner === 2);

  const list = $('piece-tooltip-stack');
  list.replaceChildren();
  list.hidden = !stack || stack.length < 2;
  if (!list.hidden) {
    for (const piece of [...stack].reverse()) {
      const li = document.createElement('li');
      li.className = `p${piece.player}`;
      li.innerHTML = `<span class="stack-chip mini-tile">${spriteSVG(piece.type)}</span><span></span>`;
      li.lastElementChild.textContent = `P${piece.player} ${PIECE_NAMES[piece.type] ?? piece.type}`;
      list.append(li);
    }
  }

  pieceTooltip.setAttribute('aria-hidden', 'false');
  pieceTooltip.classList.add('visible');
  pieceTooltip.style.left = '0px';
  pieceTooltip.style.top = '0px';

  const rect = pieceTooltip.getBoundingClientRect();
  const margin = 12;
  const left = Math.min(window.innerWidth - rect.width - margin, Math.max(margin, x + 14));
  let top = preferAbove ? y - rect.height - 12 : y + 14;
  if (top + rect.height > window.innerHeight - margin) top = y - rect.height - 14;
  top = Math.max(margin, top);
  pieceTooltip.style.left = `${left}px`;
  pieceTooltip.style.top = `${top}px`;
}

function hidePieceTooltip() {
  if (pieceTooltipTimer) { clearTimeout(pieceTooltipTimer); pieceTooltipTimer = null; }
  pieceTooltip.classList.remove('visible');
  pieceTooltip.setAttribute('aria-hidden', 'true');
}

function showStackTooltip(key, x, y, brief = false) {
  const stack = gameState?.board.get(key);
  if (!stack) { hidePieceTooltip(); return; }
  const top = stack[stack.length - 1];
  showPieceTooltip({ type: top.type, owner: top.player, stack }, x, y);
  if (brief) pieceTooltipTimer = setTimeout(hidePieceTooltip, stack.length > 1 ? 3600 : 2400);
}

// ── Toast + turn banner ────────────────────────────────

let toastTimer = null;
/** @param {number} ms 0 keeps the toast up until replaced or cleared */
function toast(text, kind = '', ms = 2200) {
  const el = $('toast');
  if (toastTimer) clearTimeout(toastTimer);
  el.textContent = text;
  el.className = `visible ${kind}`;
  toastTimer = ms ? setTimeout(clearToast, ms) : null;
}
function clearToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  $('toast').className = '';
}

let bannerTimer = null;
function showBanner(text, color, sprite = PieceType.QUEEN, ms = 1400) {
  const el = $('turn-banner');
  if (bannerTimer) clearTimeout(bannerTimer);
  $('banner-text').textContent = text;
  $('banner-emoji').innerHTML  = spriteSVG(sprite);
  el.className = `${color} visible`;
  bannerTimer = setTimeout(() => el.classList.remove('visible'), ms);
}
function hideBanner() {
  if (bannerTimer) clearTimeout(bannerTimer);
  $('turn-banner').classList.remove('visible');
}

// ── Game screen visibility ─────────────────────────────

function showGame() {
  for (const id of ['hud', 'tray', 'btn-recenter']) $(id).classList.add('game-visible');
  updateInsets();
  board.recenter(false);
  showBoardHintOnce();
}

function hideGame() {
  hidePieceTooltip();
  closeGameMenu();
  hideBanner();
  clearToast();
  for (const id of ['hud', 'tray', 'btn-recenter']) $(id).classList.remove('game-visible');
  $('board-hint').classList.remove('visible');
  hideWinScreen();
}

function cancelTimers() {
  if (passTimer) clearTimeout(passTimer);
  if (winTimer) clearTimeout(winTimer);
  if (turnSoundTimer) clearTimeout(turnSoundTimer);
  if (winFxTimer) clearTimeout(winFxTimer);
  if (dangerTimer) clearTimeout(dangerTimer);
  passTimer = winTimer = turnSoundTimer = winFxTimer = dangerTimer = winTouchdown = landingAlarm = null;
  holdResult = false;
}

function resetBoardView() {
  board.finishAnimations({ clearFx: true });
  board.pieces.clear();
  board.ghosts       = new Set();
  board.throwTargets = new Set();
  board.throwPick    = null;
  board.selectedHex  = null;
  board.lastMove     = null;
}

/** Tear down the current game and return to the main menu. */
function exitToMenu({ notice, keepSaved = false } = {}) {
  cancelTimers();
  hideGame();
  resetBoardView();
  if (gameMode === 'ONLINE') leaveOnlineSession({ keepSaved });
  gameState = null;
  history = [];
  connectionNotice = null;
  opponentAway = false;
  updateInsets();
  board.recenter(false);
  showMenu({ notice });
}

// ── Start / restart game ───────────────────────────────

/**
 * Start (or resume) a pass-and-play game.
 * @param {object} settings
 * @param {{state?: object, history?: object[]}} [restore] saved game to continue
 */
function startGame(settings, restore = null) {
  cancelTimers();
  gameMode     = 'LOCAL';
  gameSettings = settings;
  history      = restore?.history ?? [];
  gameState    = restore?.state ?? createGame({
    expansions:     settings.expansions,
    tournamentRule: settings.tournamentRule,
    clock:          settings.clock,
  });
  beginGameSession(restore ? describeLastMove(history.at(-1) ?? null, gameState) : null);
  saveLocal();
  announceTurn();
}

/**
 * Start an online game received from the server.
 * @param {object} settings        - Game settings (from GAME_START)
 * @param {number} playerNum       - 1 or 2
 * @param {object} serializedState - JSON-safe state from serializeState()
 * @param {string|null} [endReason] - server end reason when resuming a finished game
 */
export function startOnlineGame(settings, playerNum, serializedState, endReason = null) {
  cancelTimers();
  gameMode     = 'ONLINE';
  myPlayer     = playerNum;
  gameSettings = settings;
  history      = [];
  gameState    = deserializeState(serializedState);
  connectionNotice = null;
  opponentAway = false;
  beginGameSession(describeLastMove(null, gameState));
  winReason = resumedWinReason(gameState, endReason);
  if (gameState.winner) {
    syncUI();
    // Reloaded into a finished game: the result, without replaying the fanfare.
    winTimer = setTimeout(() => showWinScreen({ calm: true }), 300);
  } else {
    showBanner(`YOU ARE PLAYER ${myPlayer}`, `p${myPlayer}`, PieceType.QUEEN, 1800);
  }
}

function beginGameSession(lastMove) {
  board.finishAnimations({ clearFx: true });
  winPresented = false;
  winReason    = null;
  hideWinScreen();
  clearSelection(false);
  board.lastMove = lastMove;
  syncBoardRenderer();
  showGame();
  syncUI();
}

// ── Local persistence ──────────────────────────────────

function saveLocal() {
  if (gameMode !== 'LOCAL' || !gameState) return;
  if (gameState.winner) { storageSet(LOCAL_SAVE_KEY, null); return; }
  storageSet(LOCAL_SAVE_KEY, encodeLocalSave({ settings: gameSettings, state: gameState, history }));
}

function loadLocalSave() {
  return decodeLocalSave(storageGet(LOCAL_SAVE_KEY));
}

function localSaveSummary() {
  const saved = loadLocalSave();
  if (!saved) return null;
  const round = Math.ceil(saved.state.turnNumber / 2);
  const exps  = Object.entries(saved.state.settings.expansions ?? {}).filter(([, on]) => on)
    .map(([name]) => name.toUpperCase());
  return `ROUND ${round} · PLAYER ${saved.state.turn} TO MOVE${exps.length ? ` · +${exps.join(' +')}` : ''}`;
}

function continueLocal() {
  const saved = loadLocalSave();
  if (!saved) { showMenu({ notice: 'That saved game could not be loaded.' }); return; }
  startGame(saved.settings, saved);
}

// ── Sync renderer from game state ──────────────────────

function syncBoardRenderer() {
  board.pieces.clear();
  if (!gameState) return;
  for (const [key, stack] of gameState.board.entries()) {
    board.pieces.set(key, stack.map(p => ({
      player: p.player,
      type:   p.type,
      emoji:  PIECE_UI[p.type]?.emoji ?? '?',
      image:  PIECE_IMAGES.get(p.type)?.complete && PIECE_IMAGES.get(p.type)?.naturalWidth
        ? PIECE_IMAGES.get(p.type)
        : null,
    })));
  }
}

// ── Ghost / highlight computation ──────────────────────

function updateGhosts() {
  board.ghosts       = new Set();
  board.throwTargets = new Set();
  board.throwPick    = null;
  const { phase, trayPick, boardPick, throwPillbugHex } = uiState;

  if (phase === 'TRAY' && trayPick) {
    board.ghosts = new Set(getLegalPlacements(gameState, trayPick.type));

  } else if (phase === 'BOARD' && boardPick) {
    board.ghosts = new Set(getLegalMoves(gameState, boardPick));

    // If the selected piece is a pillbug (or mosquito-as-pillbug), also show
    // throwable neighbor pieces in amber so the player knows to tap them.
    const allThrows = getLegalThrows(gameState).filter(t => t.pillbugHex === boardPick);
    for (const t of allThrows) board.throwTargets.add(t.from);

  } else if (phase === 'THROW' && boardPick && throwPillbugHex) {
    // Show valid landing hexes for the piece being thrown
    const dests = getLegalThrows(gameState)
      .filter(t => t.pillbugHex === throwPillbugHex && t.from === boardPick)
      .map(t => t.to);
    board.ghosts = new Set(dests);
    // The picked piece is lifted with a bright ring so it stands out from the thrower
    board.throwPick = boardPick;
  }
}

// ── Transitions ────────────────────────────────────────

function clearSelection(sync = true) {
  uiState.phase           = 'IDLE';
  uiState.trayPick        = null;
  uiState.boardPick       = null;
  uiState.throwPillbugHex = null;
  board.selectedHex       = null;
  board.ghosts            = new Set();
  board.throwTargets      = new Set();
  board.throwPick         = null;
  if (sync && gameState) syncUI();
}

/** The player backed out of a selection (tap away, Esc, ✕). */
function cancelSelection() {
  if (uiState.phase !== 'IDLE') sfx.play('deselect');
  clearSelection();
}

function selectTrayPiece(type) {
  if (!gameState || gameState.winner) return;
  hidePieceTooltip();
  if (uiState.trayPick?.type === type) { cancelSelection(); return; }
  sfx.play('select');
  uiState.phase     = 'TRAY';
  uiState.trayPick  = { type };
  uiState.boardPick = null;
  board.selectedHex = null;
  updateGhosts();
  board.reveal(board.ghosts, board.pieces.keys());
  syncUI();
}

function selectBoardPiece(key) {
  hidePieceTooltip();
  uiState.phase     = 'BOARD';
  uiState.boardPick = key;
  uiState.trayPick  = null;
  uiState.throwPillbugHex = null;
  board.selectedHex = key;
  updateGhosts();
  // A piece that cannot go anywhere gets a soft "no"; the status line says why.
  sfx.play(board.ghosts.size || board.throwTargets.size ? 'select' : 'invalid');
  board.reveal([key, ...board.ghosts], board.pieces.keys(), { anchor: key });
  syncUI();
}

// Enter throw mode: player tapped an amber-highlighted neighbor of the pillbug
function selectThrowPiece(fromKey, pillbugKey) {
  uiState.phase           = 'THROW';
  uiState.boardPick       = fromKey;
  uiState.trayPick        = null;
  uiState.throwPillbugHex = pillbugKey;
  board.selectedHex       = pillbugKey;   // keep the thrower highlighted
  updateGhosts();
  sfx.play('select');
  board.reveal([fromKey, ...board.ghosts], board.pieces.keys(), { anchor: fromKey });
  syncUI();
}

/** Route an action to the server (ONLINE) or apply it locally. */
function act(action) {
  board.finishAnimations(); // a new action completes any running tween
  if (gameMode === 'ONLINE') {
    if (!net.isConnected()) {
      toast('NOT CONNECTED — RECONNECTING…', 'warn');
      return;
    }
    const messages = {
      [ActionType.PLACE]: ['PLACE_PIECE', { pieceType: action.pieceType, to: action.to }],
      [ActionType.MOVE]:  ['MOVE_PIECE',  { from: action.from, to: action.to }],
      [ActionType.THROW]: ['THROW_PIECE', { pillbugHex: action.pillbugHex, from: action.from, to: action.to }],
      [ActionType.PASS]:  ['PASS_TURN',   {}],
    };
    net.send(...messages[action.type]);
    clearSelection();
    return;
  }

  const prev = gameState;
  const move = getMovePath(prev, action);
  history.push(prev);
  if (history.length > MAX_UNDO) history.shift();
  gameState = applyAction(prev, action);
  onStateChanged(prev, { move });
}

function doPlace(toKey) {
  act({ type: ActionType.PLACE, pieceType: uiState.trayPick.type, to: toKey });
}

function doMove(toKey) {
  act({ type: ActionType.MOVE, from: uiState.boardPick, to: toKey });
}

function doThrow(toKey) {
  act({ type: ActionType.THROW, pillbugHex: uiState.throwPillbugHex, from: uiState.boardPick, to: toKey });
}

// ── Post-action ────────────────────────────────────────

/**
 * Common path after gameState changes (local action or server snapshot).
 * `move` is the getMovePath() route of the action, flown by the board; without
 * one the arriving piece just pops in.
 */
function onStateChanged(prev, { animate = true, move = null } = {}) {
  clearSelection(false);
  const lastMove = describeLastMove(prev, gameState);
  if (lastMove) board.lastMove = lastMove;
  syncBoardRenderer();
  const won = !!gameState.winner;
  const flying = !!(lastMove && animate && move && !board.reducedMotion);
  const dangers = animate && !won ? newDangers(prev ? queenPressure(prev) : null, queenPressure(gameState)) : [];
  // The winning move plays in slow motion (see winTiming).
  const landed = flying ? board.animateMove({ ...move, toKey: lastMove.to, player: lastMove.player, speed: won ? 0.4 : 1 }) : null;
  if (!flying && lastMove && animate) board.markArrival(lastMove.to);
  if (lastMove && animate) playMoveSound(move?.kind, board.hiddenTop.has(lastMove.to), { alarm: dangers.length > 0 });
  board.reveal(board.pieces.keys(), [], { anchor: lastMove?.to });
  holdResult = won && flying;
  syncUI();
  saveLocal();

  if (won) {
    hideBanner();
    playWinSequence(flying ? move : null);
    return;
  }
  const landingMs = flying ? moveDuration(move.kind, move.path.length - 1) : 0;
  announceTurn(landingMs, dangers, landed);
}

/**
 * The climax: the winning move flies in slow motion; at touchdown a white
 * shockwave rings out of the surrounded queen(s) and the board dims round
 * them; then confetti and the result card. Reduced motion: no slow-mo, no
 * shockwave, the card after 300 ms.
 * @param {{kind:string, path:string[]}|null} move the flown route, if any
 */
function playWinSequence(move) {
  if (winTimer) clearTimeout(winTimer);
  if (winFxTimer) clearTimeout(winFxTimer);
  const timing = winTiming(move?.kind ?? null, (move?.path.length ?? 1) - 1, { reducedMotion: board.reducedMotion });
  const queens = surroundedQueens(gameState);
  const impact = () => {
    winFxTimer = winTouchdown = null;
    holdResult = false;
    board.shockwave(queens);
    showBoardDim(queens);
    syncUI();
  };
  // Synced to the actual touchdown (frames can lag the clock); the card keeps to the clock.
  if (timing.flightMs) winTouchdown = impact;
  else winFxTimer = setTimeout(impact, 0);
  winTimer = setTimeout(showWinScreen, timing.cardMs);
}

/** Hex keys of every queen with all six sides occupied. */
function surroundedQueens(state) {
  return queenPips(state.board).filter(m => m.count === 6).map(m => m.key);
}

/** Dim the board round the fallen queen(s): a spotlight on them, the rest 30% darker. */
function showBoardDim(keys) {
  const el = $('board-dim');
  const spots = keys.map(k => board.hexToScreen(k));
  if (spots.length) {
    const x = spots.reduce((a, p) => a + p.x, 0) / spots.length;
    const y = spots.reduce((a, p) => a + p.y, 0) / spots.length;
    const spread = Math.max(0, ...spots.map(p => Math.hypot(p.x - x, p.y - y)));
    el.style.setProperty('--dim-x', `${x}px`);
    el.style.setProperty('--dim-y', `${y}px`);
    el.style.setProperty('--dim-r', `${Math.round(spread + board.SIZE * board.scale * 1.05)}px`);
  }
  el.classList.add('visible');
}

function hideBoardDim() {
  $('board-dim').classList.remove('visible');
}

/**
 * Departure whoosh for a flying move; the landing thump (`place`, with the haptic)
 * comes from board.onLand at touchdown. A piece that does not fly (reduced motion,
 * no route) just lands at once — without its buzz when an alarm follows, so the
 * alarm's own pattern is what the player feels.
 */
function playMoveSound(kind, inFlight, { alarm = false } = {}) {
  if (!inFlight) { sfx.play('place', { haptic: !alarm }); return; }
  if (kind && kind !== 'place') sfx.play(kind, { haptic: false, duration: board.flightMs() });
}

/**
 * Touchdown of a flown move: the thump, then whatever was waiting for it (the win
 * impact, a queen-danger alarm). An alarm brings its own haptic, so the 12 ms
 * landing buzz steps aside rather than cutting the alarm's pattern short.
 */
board.onLand = () => {
  const alarms = [winTouchdown, landingAlarm].filter(Boolean);
  landingAlarm = null;
  sfx.play('place', { haptic: !alarms.length });
  for (const fire of alarms) fire();
};

/**
 * Tell players whose turn it is; in LOCAL mode, auto-pass a stuck player.
 * `landingMs`: how long the move that ended the turn takes to land (the chime waits for it).
 * `dangers`: players whose queen this move put one side from surrounded (newDangers);
 * their alarm replaces the turn banner and chime.
 */
function announceTurn(landingMs = 0, dangers = [], landed = null) {
  if (!gameState || gameState.winner) return;
  const turn = gameState.turn;

  if (gameMode === 'ONLINE') {
    const mustPass = turn === myPlayer && getAllLegalActions(gameState).mustPass;
    if (dangers.length) raiseDangerAlarm(dangers, landed, { banner: !mustPass });
    if (turn === myPlayer) {
      if (mustPass || !dangers.length) showBanner(mustPass ? 'NO MOVES — TAP PASS' : 'YOUR TURN', mustPass ? 'gold' : `p${turn}`);
      if (!dangers.length) playTurnChime(landingMs);
    }
    return;
  }

  if (getAllLegalActions(gameState).mustPass) {
    showBanner(`P${turn} HAS NO MOVES — PASSING`, 'gold', PieceType.QUEEN, 1600);
    if (dangers.length) raiseDangerAlarm(dangers, landed, { banner: false });
    else playTurnChime(landingMs);
    const stuck = gameState;
    passTimer = setTimeout(() => {
      passTimer = null;
      if (gameState !== stuck) return; // undone or quit meanwhile
      gameState = applyAction(stuck, { type: ActionType.PASS });
      if (getAllLegalActions(gameState).mustPass) {
        // Neither side can act: the game can never progress.
        gameState = { ...gameState, winner: 'DRAW' };
        winReason = 'STALEMATE';
      }
      onStateChanged(stuck, { animate: false });
    }, 1700);
    return;
  }

  if (dangers.length) raiseDangerAlarm(dangers, landed);
  else showBanner(`PLAYER ${turn}'S TURN`, `p${turn}`, PieceType.QUEEN, 1100);
}

/**
 * A queen just reached five occupied sides: the `danger` sting, a red banner, and
 * a jolt of the HUD meter. Fires once per transition (the caller passes only
 * newDangers()). `landed` is the flight of the move that caused it: the alarm
 * goes off at its touchdown (board.onLand), or when it is snapped home without
 * one; a move that did not fly raises it at once.
 */
function raiseDangerAlarm(players, landed, { banner = true } = {}) {
  if (dangerTimer) clearTimeout(dangerTimer);
  const fire = () => {
    if (dangerTimer) clearTimeout(dangerTimer);
    dangerTimer = null;
    if (landingAlarm === fire) landingAlarm = null;
    if (!gameState || gameState.winner) return;
    sfx.play('danger');
    if (banner) {
      const text = players.length > 1 ? 'BOTH QUEENS IN DANGER' : dangerText(players[0], { mode: gameMode, myPlayer });
      showBanner(text, 'danger', PieceType.QUEEN, 1800);
    }
    for (const p of players) {
      const meter = $(`qm-${p}`);
      meter.classList.remove('alarm');
      void meter.offsetWidth; // restart the one-shot animation
      meter.classList.add('alarm');
    }
  };
  if (!landed) { dangerTimer = setTimeout(fire, 0); return; }
  landingAlarm = fire;
  landed.then(() => { if (landingAlarm === fire) fire(); }); // snapped home: no touchdown came
}

/**
 * The turn chime marks a turn that needs your attention (online: yours; local: a
 * forced pass). Ordinary pass-and-play turns already have the move's own sounds.
 */
function playTurnChime(landingMs) {
  if (turnSoundTimer) clearTimeout(turnSoundTimer);
  turnSoundTimer = setTimeout(() => { turnSoundTimer = null; sfx.play('turn'); }, landingMs ? landingMs + 120 : 0);
}

function undo() {
  if (gameMode !== 'LOCAL' || !history.length || !gameState) return;
  board.finishAnimations({ clearFx: true }); // no animation, and nothing left mid-air
  cancelTimers();
  const restored = history.pop();
  gameState    = restored;
  winPresented = false;
  winReason    = null;
  hideWinScreen();
  hideBanner();
  clearSelection(false);
  board.lastMove = describeLastMove(history.at(-1) ?? null, restored);
  if (!history.length && !restored.lastMovedHex) board.lastMove = null;
  syncBoardRenderer();
  syncUI();
  saveLocal();
  sfx.play('deselect');
  toast(`UNDONE · PLAYER ${restored.turn} TO MOVE`, '', 1400);
}

// ── Confetti ───────────────────────────────────────────

// Pre-render each bug sprite once (species colour, with each player's glow) to a small
// offscreen canvas. drawImage() is a fast GPU blit; re-drawing paths every frame is not.
const SPRITE_SIZE  = 36;
const CONFETTI_GLOW = ['#ff2d78', '#00f5ff'];
const bugSprites   = TRAY_ORDER.flatMap(type => CONFETTI_GLOW.map(glow => {
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
    octx.fillText(PIECE_UI[type].emoji, px / 2, px / 2);
  }
  return oc;
}));

let confettiRaf = null; // handle so we can cancel a running loop

function stopConfetti() {
  if (confettiRaf !== null) cancelAnimationFrame(confettiRaf);
  confettiRaf = null;
  const cv = $('confetti-layer');
  cv.style.display = 'none';
}

function launchConfetti() {
  stopConfetti();
  if (board.reducedMotion) return;

  const cv  = $('confetti-layer');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight; // particles live in CSS px
  cv.width  = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width  = `${W}px`;
  cv.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    if (elapsed > DUR) {
      ctx.clearRect(0, 0, W, H);
      stopConfetti();
      return;
    }

    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = elapsed > DUR - 800
      ? 1 - (elapsed - (DUR - 800)) / 800
      : 1;

    for (const p of pts) {
      if (p.y > H + SPRITE_SIZE) continue; // already off screen, skip

      p.x   += p.vx;
      p.y   += p.vy;
      p.vy  += 0.06; // gentle gravity
      p.rot += p.vr;

      const sz = SPRITE_SIZE * p.scale;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.drawImage(p.sprite, -sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    confettiRaf = requestAnimationFrame(tick);
  }

  confettiRaf = requestAnimationFrame(tick);
}

// ── Win screen ─────────────────────────────────────────

function winCopy() {
  const winner = gameState.winner;
  const rounds = Math.max(1, Math.ceil((gameState.turnNumber - 1) / 2));
  const online = gameMode === 'ONLINE';
  const name   = p => (online ? (p === myPlayer ? 'YOU' : 'OPPONENT') : `PLAYER ${p}`);

  if (winner === 'DRAW') {
    return {
      headline: "IT'S A DRAW",
      reason: winReason === 'STALEMATE'
        ? 'Neither player has a legal move left.'
        : 'Both queens were surrounded on the same move.',
      emblem: PieceType.QUEEN,
    };
  }

  const loser = other(winner);
  const headline = online ? (winner === myPlayer ? 'YOU WIN!' : 'YOU LOSE') : `PLAYER ${winner} WINS!`;
  if (winReason === 'RESIGN') {
    return {
      headline,
      reason: online && loser === myPlayer ? 'You resigned the game.' : `${online ? 'Your opponent' : `Player ${loser}`} resigned.`,
      emblem: PieceType.QUEEN,
    };
  }
  const whose = online ? (loser === myPlayer ? 'Your' : "Your opponent's") : `${name(loser)[0]}${name(loser).slice(1).toLowerCase()}'s`;
  return { headline, reason: `${whose} queen was surrounded after ${rounds} round${rounds === 1 ? '' : 's'}.`, emblem: PieceType.QUEEN };
}

/** @param {{calm?: boolean}} [opts] calm: a game that was already over (resume) — no sting, no confetti */
function showWinScreen({ calm = false } = {}) {
  winTimer = null;
  if (winPresented || !gameState?.winner) return;
  winPresented = true;
  holdResult = false;
  closeGameMenu();
  hidePieceTooltip();
  const screen = $('win-screen');
  const winner = gameState.winner;
  const copy   = winCopy();

  screen.className = winner === 'DRAW' ? 'draw' : `p${winner}`;
  $('win-headline').textContent = copy.headline;
  $('win-reason').textContent   = copy.reason;
  $('win-emblem').innerHTML     = spriteSVG(copy.emblem); // on a .mini-tile in the winner's rim
  $('btn-rematch').hidden       = gameMode !== 'LOCAL';

  screen.setAttribute('aria-hidden', 'false');
  screen.classList.add('active');
  ($('btn-rematch').hidden ? $('btn-view-board') : $('btn-rematch')).focus();
  const lost = gameMode === 'ONLINE' && winner !== myPlayer && winner !== 'DRAW';
  if (!calm) {
    sfx.play(winner === 'DRAW' ? 'draw' : lost ? 'lose' : 'win');
    if (!lost) launchConfetti();
  }
  syncUI();
}

function hideWinScreen() {
  const screen = $('win-screen');
  screen.classList.remove('active');
  screen.setAttribute('aria-hidden', 'true');
  stopConfetti();
  hideBoardDim();
}

function rematch() {
  if (gameMode !== 'LOCAL' || !gameSettings) return;
  hideWinScreen();
  startGame(gameSettings);
}

$('btn-rematch').addEventListener('click', rematch);
$('btn-to-menu').addEventListener('click', () => exitToMenu());
$('btn-view-board').addEventListener('click', () => {
  hideWinScreen();
  board.recenter(true);
  toast(gameMode === 'ONLINE' ? 'GAME OVER · ☰ FOR MENU' : 'GAME OVER · ☰ FOR REMATCH OR MENU', '', 2600);
  $('btn-menu').focus();
});

// ── Tap handler ────────────────────────────────────────

board.onTap = (q, r, clientX, clientY) => {
  if (!gameState) return;
  closeGameMenu();
  const key      = hexKey(q, r);
  const stack    = gameState.board.get(key);
  const topPiece = stack ? stack[stack.length - 1] : null;
  const turn     = gameState.turn;
  const inspect  = () => (topPiece ? showStackTooltip(key, clientX, clientY, true) : hidePieceTooltip());

  if (gameState.winner || (gameMode === 'ONLINE' && turn !== myPlayer)) {
    inspect();
    return;
  }

  if (uiState.phase === 'TRAY') {
    if (board.ghosts.has(key))          doPlace(key);
    else if (topPiece?.player === turn) selectBoardPiece(key);
    else if (topPiece)                  inspect();
    else                                cancelSelection();
    return;
  }

  if (uiState.phase === 'BOARD') {
    if (board.ghosts.has(key))            doMove(key);
    else if (board.throwTargets.has(key)) selectThrowPiece(key, uiState.boardPick);
    else if (key === uiState.boardPick)   cancelSelection();
    else if (topPiece?.player === turn)   selectBoardPiece(key);
    else if (topPiece)                    inspect();
    else                                  cancelSelection();
    return;
  }

  if (uiState.phase === 'THROW') {
    if (board.ghosts.has(key))                  doThrow(key);
    else if (key === uiState.throwPillbugHex)   selectBoardPiece(key); // back out of the throw
    else if (topPiece?.player === turn)         selectBoardPiece(key);
    else if (topPiece)                          inspect();
    else                                        cancelSelection();
    return;
  }

  if (topPiece?.player === turn) selectBoardPiece(key);
  else inspect();
};

board.onHover = (q, r, clientX, clientY) => {
  if (q == null || !gameState) { hidePieceTooltip(); return; }
  const key = hexKey(q, r);
  if (gameState.board.has(key)) showStackTooltip(key, clientX, clientY);
  else hidePieceTooltip();
};

board.onViewChange = () => hideBoardHint();

// ── Tray rendering ─────────────────────────────────────

/** Whose pieces the tray shows: your own online, the player to move locally. */
function trayPlayer() {
  return gameMode === 'ONLINE' ? myPlayer : gameState.turn;
}

function renderTray(actions) {
  const container = $('tray-pieces');
  if (!gameState) { container.replaceChildren(); return; }
  const owner     = trayPlayer();
  const supply    = gameState.supply[owner];
  const myTurn    = owner === gameState.turn && !gameState.winner;
  const forced    = myTurn && actions.placements.size === 1 && actions.placements.has(PieceType.QUEEN)
    && !gameState.queenPlaced[owner] && supply[PieceType.QUEEN] > 0 && [...gameState.board.values()]
      .flat().filter(p => p.player === owner).length === 3;

  container.innerHTML = TRAY_ORDER
    .filter(type => type in supply)
    .map(type => {
      const count    = supply[type] ?? 0;
      const ui       = PIECE_UI[type];
      const selected = uiState.trayPick?.type === type;
      const hasSpots = myTurn && (actions.placements.get(type) || []).length > 0;
      const disabled = count === 0 || !hasSpots;
      const classes  = [
        'piece-slot', `p${owner}-piece`,
        selected && 'selected', disabled && 'disabled', count === 0 && 'exhausted',
        forced && type === PieceType.QUEEN && 'must',
      ].filter(Boolean).join(' ');
      const imageMarkup = USE_PIECE_ART
        ? `<img class="piece-art" src="${ui.image}" alt="" aria-hidden="true">`
        : '';
      return `<div class="${classes}" data-type="${type}" role="button"
           aria-label="${PIECE_NAMES[type] ?? ui.label}, ${count} left. ${PIECE_DESC[type]}"
           aria-pressed="${selected}" aria-disabled="${disabled}" tabindex="${disabled ? -1 : 0}">
        <div class="piece-hex">
          ${imageMarkup}
          ${spriteSVG(type)}
        </div>
        <span class="piece-count" aria-hidden="true">×${count}</span>
      </div>`;
    }).join('');

  container.querySelectorAll('.piece-art').forEach(image => {
    const showImage = () => image.classList.add('loaded');
    if (image.complete && image.naturalWidth) showImage();
    else {
      image.addEventListener('load', showImage, { once: true });
      image.addEventListener('error', () => image.classList.add('failed'), { once: true });
    }
  });

  renderReserve(other(owner));
}

function renderReserve(player) {
  const label = $('reserve-label');
  label.textContent = gameMode === 'ONLINE' ? 'OPPONENT HAS' : `P${player} HAS`;
  label.className = `p${player}`;
  const supply = gameState.supply[player];
  $('reserve-pieces').className = `p${player}`;
  $('reserve-pieces').innerHTML = TRAY_ORDER
    .filter(type => type in supply)
    .map(type => `<span class="reserve-item${supply[type] ? '' : ' empty'}" title="${PIECE_NAMES[type]}">`
      + `${spriteSVG(type)}${supply[type]}</span>`)
    .join('');
  $('reserve-row').setAttribute('aria-label',
    `${gameMode === 'ONLINE' ? 'Opponent' : `Player ${player}`} still holds: ` +
    TRAY_ORDER.filter(type => supply[type]).map(type => `${supply[type]} ${PIECE_NAMES[type]}`).join(', '));
}

// Delegated tray input: survives re-renders without rebinding.
const trayEl = $('tray-pieces');
trayEl.addEventListener('click', event => {
  const slot = event.target.closest('.piece-slot');
  if (!slot) return;
  if (slot.classList.contains('disabled')) sfx.play('invalid');
  else selectTrayPiece(slot.dataset.type);
});
trayEl.addEventListener('keydown', event => {
  const slot = event.target.closest('.piece-slot');
  if (!slot) return;
  if ((event.key === 'Enter' || event.key === ' ') && !slot.classList.contains('disabled')) {
    event.preventDefault();
    selectTrayPiece(slot.dataset.type);
    requestAnimationFrame(() => trayEl.querySelector(`[data-type="${slot.dataset.type}"]`)?.focus());
  }
});
const showSlotTooltip = slot => {
  // The selected piece's text is already in the description bar under the HUD.
  if (uiState.trayPick?.type === slot.dataset.type) return;
  const rect = slot.getBoundingClientRect();
  showPieceTooltip({ type: slot.dataset.type, owner: gameState ? trayPlayer() : undefined },
    rect.left + rect.width / 2, rect.top, true);
};
trayEl.addEventListener('pointerover', event => {
  const slot = event.target.closest('.piece-slot');
  if (slot && event.pointerType === 'mouse') showSlotTooltip(slot);
});
trayEl.addEventListener('pointerout', event => {
  if (!event.relatedTarget?.closest?.('.piece-slot')) hidePieceTooltip();
});
// A touch tap also focuses the slot. Selecting it opens the description bar, so the
// tooltip would only repeat it (and cover the reserve strip); keep it for keyboard
// focus, and for touch taps on slots that can't be selected.
let trayTouchAt = -Infinity;
trayEl.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse') trayTouchAt = performance.now();
});
trayEl.addEventListener('focusin', event => {
  const slot = event.target.closest('.piece-slot');
  if (!slot) return;
  const touched = performance.now() - trayTouchAt < 1000;
  if (!touched || slot.classList.contains('disabled')) showSlotTooltip(slot);
});
trayEl.addEventListener('focusout', hidePieceTooltip);

// ── HUD sync ───────────────────────────────────────────

function selectedPieceType() {
  if (uiState.trayPick) return uiState.trayPick.type;
  const key = uiState.phase === 'THROW' ? uiState.throwPillbugHex : uiState.boardPick;
  const stack = key ? gameState.board.get(key) : null;
  return stack?.[stack.length - 1]?.type ?? null;
}

/** Owner of the piece described in the desc bar (tray piece → the mover). */
function descOwner() {
  const key = uiState.phase === 'THROW' ? uiState.throwPillbugHex : uiState.boardPick;
  const stack = key ? gameState.board.get(key) : null;
  return stack?.[stack.length - 1]?.player ?? gameState.turn;
}

function syncUI() {
  if (!gameState) return;
  if (holdResult) {
    // Slow-motion winning move: no spoilers until it lands (playWinSequence).
    $('status-text').textContent = '';
    $('piece-desc').classList.remove('visible');
    $('btn-cancel').classList.add('hidden');
    return;
  }
  const turn    = gameState.turn;
  const actions = getAllLegalActions(gameState);
  const online  = gameMode === 'ONLINE';
  const myTurn  = !online || turn === myPlayer;
  const over    = !!gameState.winner;

  // Turn chip + HUD accent
  $('hud').className = `game-visible turn-p${over && gameState.winner !== 'DRAW' ? gameState.winner : turn}`;
  const chip = $('turn-chip');
  const chipPlayer = over && gameState.winner !== 'DRAW' ? gameState.winner : turn;
  chip.className = `p${chipPlayer}${myTurn || over ? '' : ' waiting'}`;
  $('chip-label').textContent = turnChipText({ state: gameState, mode: gameMode, myPlayer });
  $('chip-sub').textContent   = over ? 'FINAL' : `ROUND ${Math.ceil(gameState.turnNumber / 2)}`;

  renderQueenMeters();

  // Status line
  const blocker = uiState.phase === 'BOARD' ? getMoveBlocker(gameState, uiState.boardPick) : null;
  const throwCount = board.throwTargets.size;
  const type = selectedPieceType();
  const status = $('status-text');
  if (connectionNotice) {
    status.textContent = connectionNotice;
    status.className = 'alert';
  } else {
    status.textContent = statusText({
      state: gameState, phase: uiState.phase, mode: gameMode, myPlayer,
      blocker, throwCount, pieceName: PIECE_NAMES[type] ?? 'PIECE', winReason,
    });
    const warn = (blocker && !throwCount) || (myTurn && actions.mustPass)
      || (myTurn && !over && uiState.phase === 'IDLE' && /QUEEN NOW/.test(status.textContent));
    const danger = /IN DANGER/.test(status.textContent);
    status.className = danger ? 'alert' : warn ? 'warn' : (uiState.phase !== 'IDLE' || over) ? 'active' : '';
  }

  // Description bar for the selected piece, with anything buried underneath it
  const desc = $('piece-desc');
  if (type && PIECE_DESC[type] && !over) {
    desc.replaceChildren();
    const name = document.createElement('span');
    name.className = `desc-name p${descOwner()}`;
    name.innerHTML = `${spriteSVG(type)}<span>${PIECE_NAMES[type]}</span>`;
    desc.append(name, PIECE_DESC[type]);
    const stack = uiState.boardPick && uiState.phase === 'BOARD' ? gameState.board.get(uiState.boardPick) : null;
    if (stack?.length > 1) {
      const buried = document.createElement('span');
      buried.className = 'desc-stack';
      buried.innerHTML = `· ON TOP OF ${stack.slice(0, -1).reverse()
        .map(p => `<span class="p${p.player}">${spriteSVG(p.type)}</span>`).join('')}`;
      desc.append(buried);
    }
    desc.classList.add('visible');
  } else {
    desc.textContent = '';
    desc.classList.remove('visible');
  }

  // Contextual buttons
  $('btn-pass').classList.toggle('hidden', !(online && myTurn && actions.mustPass && !over));
  $('btn-undo').classList.toggle('hidden', !(gameMode === 'LOCAL' && history.length));
  $('btn-cancel').classList.toggle('hidden', uiState.phase === 'IDLE');

  // Game menu entries
  document.querySelectorAll('#game-menu [data-local-only]').forEach(el => { el.hidden = online || over; });
  document.querySelector('#game-menu [data-finished-only]').hidden = online || !over;
  $('menu-quit-label').textContent = over ? 'MAIN MENU' : online ? 'RESIGN GAME' : 'QUIT TO MENU';

  renderTray(actions);
}

// ── HUD queen meters ───────────────────────────────────

// A tiny queen hex ringed by six pips, laid out like the board's neighbours
// (same order as queenPips), so the HUD reads exactly like the pips on the tile.
const METER_PIPS = neighbors(0, 0).map(({ q, r }) => {
  const p = hexToPixel(q, r, 1);
  const len = Math.hypot(p.x, p.y);
  return { x: (p.x / len) * 8.6, y: (p.y / len) * 8.6 };
});
const hexPoints = (cx, cy, R) => Array.from({ length: 6 }, (_, i) =>
  `${(cx + R * Math.cos((Math.PI / 3) * i)).toFixed(2)},${(cy + R * Math.sin((Math.PI / 3) * i)).toFixed(2)}`).join(' ');

for (const p of [1, 2]) {
  $(`qm-${p}`).innerHTML = `<svg viewBox="-12 -12 24 24" aria-hidden="true" focusable="false">
    <polygon class="qm-core" points="${hexPoints(0, 0, 4.6)}"/>
    ${METER_PIPS.map(pt => `<polygon class="qm-pip" points="${hexPoints(pt.x, pt.y, 2.3)}"/>`).join('')}
  </svg>`;
}

function renderQueenMeters() {
  const meters = new Map(queenPips(gameState.board).map(m => [m.player, m]));
  for (const player of [1, 2]) {
    const el = $(`qm-${player}`);
    const m  = meters.get(player);
    const level = m ? m.count : null;
    el.classList.toggle('unplaced', !m);
    for (const n of [4, 5, 6]) el.classList.toggle(`lvl-${n}`, level === n);
    el.querySelectorAll('.qm-pip').forEach((pip, i) => pip.classList.toggle('lit', !!m?.lit[i]));
    const who = gameMode === 'ONLINE' ? (player === myPlayer ? 'Your' : "Opponent's") : `Player ${player}`;
    el.setAttribute('aria-label', m ? `${who} queen: ${level} of 6 sides covered` : `${who} queen not placed`);
    el.title = el.getAttribute('aria-label');
  }
}

// ── Game menu ──────────────────────────────────────────

const gameMenu = $('game-menu');
const menuItems = () => [...gameMenu.querySelectorAll('button:not([hidden])')];

function openGameMenu() {
  gameMenu.hidden = false;
  $('btn-menu').setAttribute('aria-expanded', 'true');
  hidePieceTooltip();
  menuItems()[0]?.focus();
}

function closeGameMenu({ restoreFocus = false } = {}) {
  if (gameMenu.hidden) return;
  gameMenu.hidden = true;
  $('btn-menu').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('btn-menu').focus();
}

$('btn-menu').addEventListener('click', () => (gameMenu.hidden ? openGameMenu() : closeGameMenu()));

gameMenu.addEventListener('keydown', event => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') { event.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (event.key === 'ArrowUp')   { event.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (event.key === 'Tab') closeGameMenu();
});

document.addEventListener('pointerdown', event => {
  if (!gameMenu.hidden && !gameMenu.contains(event.target) && event.target !== $('btn-menu')) closeGameMenu();
});

gameMenu.addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.action;
  if (!action) return;
  if (action === 'sound') { toggleSound(); return; } // stays open so the new state is visible
  closeGameMenu();
  if (action === 'rules')    showRules();
  if (action === 'recenter') board.recenter(true);
  if (action === 'rematch')  rematch();
  if (action === 'restart') {
    showConfirm({
      title: 'RESTART GAME?',
      body: 'The current board will be cleared and a new game started with the same settings.',
      confirmLabel: 'RESTART',
    }, () => startGame(gameSettings));
  }
  if (action === 'quit') requestQuit();
});

function requestQuit() {
  if (!gameState) return;
  if (gameState.winner) { exitToMenu(); return; }

  if (gameMode === 'LOCAL') {
    showConfirm({
      title: 'QUIT TO MENU?',
      body: 'Your game is saved — pick it up any time with CONTINUE GAME.',
      confirmLabel: 'QUIT',
    }, () => exitToMenu());
    return;
  }

  showConfirm({
    title: 'RESIGN THIS GAME?',
    body: 'Your opponent will be awarded the win.',
    confirmLabel: 'RESIGN',
  }, () => {
    if (net.isConnected()) net.send('RESIGN'); // GAME_OVER comes back and shows the result
    else exitToMenu();
  });
}

// ── Buttons ────────────────────────────────────────────

$('btn-cancel').addEventListener('click', () => cancelSelection());
$('btn-undo').addEventListener('click', undo);
$('btn-recenter').addEventListener('click', () => { board.recenter(true); hideBoardHint(); });
$('btn-pass').addEventListener('click', () => {
  if (gameMode !== 'ONLINE' || !gameState || gameState.turn !== myPlayer) return;
  if (!getAllLegalActions(gameState).mustPass) return;
  act({ type: ActionType.PASS });
});

// ── Keyboard shortcuts ─────────────────────────────────

document.addEventListener('keydown', event => {
  // Autofill and IME keydowns can carry no key at all.
  if (!event.key || event.target.closest?.('input, textarea')) return;
  if (!gameState || isOverlayOpen() || $('win-screen').classList.contains('active')) return;
  const key = event.key;

  if (key === 'Escape') {
    if (!gameMenu.hidden) closeGameMenu({ restoreFocus: true });
    else if (uiState.phase !== 'IDLE') cancelSelection();
    else hidePieceTooltip();
    return;
  }
  if (event.altKey || (event.metaKey && key.toLowerCase() !== 'z')) return;
  if (key.toLowerCase() === 'z' && gameMode === 'LOCAL') { event.preventDefault(); undo(); }
  else if (key.toLowerCase() === 'c' && !event.ctrlKey) board.recenter(true);
  else if (key === '+' || key === '=') board.zoomBy(1.2);
  else if (key === '-' || key === '_') board.zoomBy(1 / 1.2);
  else if (key === '?') showRules();
});

// ── Sound ──────────────────────────────────────────────

// The AudioContext may only start inside a user gesture; every gesture also
// resumes a context the browser suspended (backgrounded tab, iOS interruption).
for (const type of ['pointerdown', 'keydown', 'touchend']) {
  document.addEventListener(type, () => sfx.unlock(), { capture: true, passive: true });
}
// Coming back to the tab: wake the context the browser suspended (no gesture needed to resume).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sfx.resume();
});

function syncSoundUI() {
  const on = !sfx.muted;
  $('menu-sound-label').textContent = `SOUND: ${on ? 'ON' : 'OFF'}`;
  for (const el of [$('btn-sound-menu'), document.querySelector('#game-menu [data-action="sound"]')]) {
    el.classList.toggle('muted', !on);
    el.setAttribute(el.getAttribute('role') === 'menuitemcheckbox' ? 'aria-checked' : 'aria-pressed', String(on));
  }
  $('btn-sound-menu').setAttribute('aria-label', on ? 'Sound on — mute' : 'Sound off — unmute');
  $('btn-sound-menu').title = `${on ? 'Mute' : 'Unmute'} (M)`;
}

function toggleSound() {
  sfx.unlock();
  sfx.toggle();
  syncSoundUI();
  if (!sfx.muted) sfx.play('select'); // audible confirmation
  if (gameState) toast(sfx.muted ? 'SOUND OFF' : 'SOUND ON', '', 1000);
}

$('btn-sound-menu').addEventListener('click', toggleSound);

// M works everywhere (menu, game, dialogs) except while typing.
document.addEventListener('keydown', event => {
  if (event.key?.toLowerCase() !== 'm' || event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.('input, textarea, select')) return;
  toggleSound();
});

// ── Board hint ─────────────────────────────────────────

let hintTimer = null;
function showBoardHintOnce() {
  if (storageGet(HINT_SEEN_KEY)) return;
  $('board-hint').classList.add('visible');
  hintTimer = setTimeout(hideBoardHint, 7000);
}
function hideBoardHint() {
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
  if (!$('board-hint').classList.contains('visible')) return;
  $('board-hint').classList.remove('visible');
  storageSet(HINT_SEEN_KEY, '1');
}

// ── Net event handlers (ONLINE mode) ──────────────────────

const FATAL_ERRORS = {
  ROOM_NOT_FOUND:       'That room no longer exists.',
  INVALID_RESUME_TOKEN: 'Your seat in that game is no longer valid.',
  // The stored session is kept (see exitToMenu) so the player can reclaim the seat later.
  SEAT_TAKEN:           'GAME OPENED IN ANOTHER TAB',
  NO_ACTIVE_GAME:       'That game is no longer active.',
};

/**
 * Called once by menu.js after a connection is established and the
 * PLAYER_ASSIGNMENT + GAME_START sequence completes. Wires up all
 * server-push events that affect the game UI.
 */
export function initNetHandlers() {
  net.on('_disconnected', () => {
    connectionNotice = 'CONNECTION LOST — RECONNECTING…';
    syncUI();
  });

  // Authoritative game state after any action
  net.on('GAME_STATE', ({ gameState: snap }) => {
    board.finishAnimations();
    const prev = gameState;
    gameState = deserializeState(snap);
    // Snapshots carry no action: recover it, and its route, from the previous state.
    const move = prev ? getMovePath(prev, inferAction(prev, gameState)) : null;
    onStateChanged(prev, { move });
  });

  net.on('ROOM_RESUMED', ({ player, gameState: snap, endReason }) => {
    myPlayer = player;
    connectionNotice = null;
    if (snap) {
      board.finishAnimations({ clearFx: true });
      const prev = gameState;
      gameState = deserializeState(snap);
      clearSelection(false);
      const lastMove = describeLastMove(prev, gameState);
      if (lastMove) board.lastMove = lastMove;
      syncBoardRenderer();
      if (gameState.winner) {
        winReason = winReasonFromServer(endReason);
        // Already over before the drop: show the result calmly. Ended while we were away: it is news.
        const calm = !prev || !!prev.winner;
        if (winTimer) clearTimeout(winTimer);
        winTimer = setTimeout(() => showWinScreen({ calm }), 300);
      }
    }
    syncUI();
    toast('RECONNECTED', 'good', 1400);
  });

  // Server confirmed game over (win, or resign)
  net.on('GAME_OVER', ({ winner, reason }) => {
    if (!gameState) return;
    gameState = { ...gameState, winner };
    winReason = winReasonFromServer(reason);
    clearSelection(false);
    syncUI();
    if (!winTimer && !winPresented) winTimer = setTimeout(showWinScreen, reason ? 200 : 700);
  });

  // Server rejected a move (shouldn't happen with correct client logic)
  net.on('INVALID_MOVE', ({ reason }) => {
    console.warn('[app] Server rejected move:', reason);
    sfx.play('invalid');
    toast('THE SERVER REJECTED THAT MOVE', 'error');
    syncBoardRenderer();
    syncUI();
  });

  net.on('OPPONENT_DISCONNECTED', () => {
    opponentAway = true;
    if (!gameState?.winner) toast('OPPONENT DISCONNECTED — WAITING FOR THEM…', 'warn', 0);
  });

  net.on('OPPONENT_RECONNECTED', () => {
    if (opponentAway) toast('OPPONENT RECONNECTED', 'good', 1600);
    opponentAway = false;
  });

  // Server closed the room (timeout, etc.)
  net.on('ROOM_CLOSED', () => exitToMenu({ notice: 'The room was closed after a period of inactivity.' }));

  net.on('ERROR', ({ reason }) => {
    if (FATAL_ERRORS[reason]) exitToMenu({ notice: FATAL_ERRORS[reason], keepSaved: reason === 'SEAT_TAKEN' });
    else if (reason === 'ALREADY_IN_ROOM') toast('ALREADY IN A ROOM', 'warn');
    else toast(`SERVER ERROR: ${reason}`, 'error');
  });
}

// ── Boot ───────────────────────────────────────────────

for (const slot of document.querySelectorAll('[data-sprite]')) slot.innerHTML = spriteSVG(slot.dataset.sprite);
syncSoundUI();
hideGame();

initMenu({
  onLocalStart:        startGame,
  onOnlineStart:       startOnlineGame,
  onNetReady:          initNetHandlers,
  onContinueLocal:     continueLocal,
  getLocalSaveSummary: localSaveSummary,
});
