// app.js — Game state machine + UI
import { hexKey, parseKey } from './hex.js';
import { Board } from './board.js';
import {
  PieceType, ActionType,
  createGame, applyAction,
  getLegalPlacements, getLegalMoves, getLegalThrows,
  getAllLegalActions, deserializeState,
} from './game.js';
import { initMenu, showMenu, showResignConfirm } from './menu.js';
import * as net from './net.js';

// ── Piece display definitions ──────────────────────────

const PIECE_UI = {
  [PieceType.QUEEN]:       { emoji: '🐝', label: 'QUEEN'  },
  [PieceType.BEETLE]:      { emoji: '🪲', label: 'BEETLE' },
  [PieceType.GRASSHOPPER]: { emoji: '🦗', label: 'HOP'    },
  [PieceType.ANT]:         { emoji: '🐜', label: 'ANT'    },
  [PieceType.SPIDER]:      { emoji: '🕷️', label: 'SPIDER' },
  [PieceType.MOSQUITO]:    { emoji: '🦟', label: 'MOSQ'   },
  [PieceType.LADYBUG]:     { emoji: '🐞', label: 'LADY'   },
  [PieceType.PILLBUG]:     { emoji: '🐛', label: 'PILL'   },
};

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

// ── Canvas setup ───────────────────────────────────────

const canvas      = document.getElementById('board');
const emojiCanvas = document.getElementById('emoji-layer');
const board       = new Board(canvas, emojiCanvas);

function setupCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  board.init();
}
window.addEventListener('resize', () => board.resize(window.innerWidth, window.innerHeight));
setupCanvas();

(function loop(t) { board.draw(t); requestAnimationFrame(loop); })(0);

// ── Game state ─────────────────────────────────────────

let gameState    = null;
let gameSettings = null;   // saved so "play again" can reuse them
let gameMode     = 'LOCAL'; // 'LOCAL' | 'ONLINE'
let myPlayer     = 1;       // 1 or 2 — only meaningful in ONLINE mode

const uiState = {
  phase:           'IDLE',
  trayPick:        null,
  boardPick:       null,
  throwPillbugHex: null,
};

// ── Game screen visibility ─────────────────────────────

function showGame() {
  document.getElementById('hud').classList.add('game-visible');
  document.getElementById('tray').classList.add('game-visible');
}

function hideGame() {
  document.getElementById('hud').classList.remove('game-visible');
  document.getElementById('tray').classList.remove('game-visible');
  // Hide win screen too
  const ws = document.getElementById('win-screen');
  ws.classList.remove('active');
  ws.setAttribute('aria-hidden', 'true');
}

// ── Start / restart game ───────────────────────────────

function startGame(settings) {
  gameMode     = 'LOCAL';
  gameSettings = settings;

  gameState = createGame({
    expansions:     settings.expansions,
    tournamentRule: settings.tournamentRule,
    clock:          settings.clock,
  });

  clearSelection();
  syncBoardRenderer();
  syncUI();
  showGame();
}

/**
 * Start an online game received from the server.
 * @param {object} settings        - Game settings (from GAME_START)
 * @param {number} playerNum       - 1 or 2
 * @param {object} serializedState - JSON-safe state from serializeState()
 */
export function startOnlineGame(settings, playerNum, serializedState) {
  gameMode     = 'ONLINE';
  myPlayer     = playerNum;
  gameSettings = settings;
  gameState    = deserializeState(serializedState);

  clearSelection();
  syncBoardRenderer();
  syncUI();
  showGame();
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
    })));
  }
}

// ── Ghost / highlight computation ──────────────────────

function updateGhosts() {
  board.ghosts       = new Set();
  board.throwTargets = new Set();
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
    // Keep the throw source highlighted in amber so the player sees what's being thrown
    board.throwTargets.add(boardPick);
  }
}

// ── Transitions ────────────────────────────────────────

function clearSelection() {
  uiState.phase           = 'IDLE';
  uiState.trayPick        = null;
  uiState.boardPick       = null;
  uiState.throwPillbugHex = null;
  board.selectedHex       = null;
  board.ghosts            = new Set();
  board.throwTargets      = new Set();
  if (gameState) syncUI();
}

function selectTrayPiece(type) {
  if (uiState.trayPick?.type === type) { clearSelection(); return; }
  uiState.phase     = 'TRAY';
  uiState.trayPick  = { type };
  uiState.boardPick = null;
  board.selectedHex = null;
  updateGhosts();
  syncUI();
}

function selectBoardPiece(key) {
  uiState.phase     = 'BOARD';
  uiState.boardPick = key;
  uiState.trayPick  = null;
  board.selectedHex = key;
  updateGhosts();
  syncUI();
}

// Enter throw mode: player tapped an amber-highlighted neighbor of the pillbug
function selectThrowPiece(fromKey, pillbugKey) {
  uiState.phase           = 'THROW';
  uiState.boardPick       = fromKey;
  uiState.trayPick        = null;
  uiState.throwPillbugHex = pillbugKey;
  board.selectedHex       = null;   // don't highlight the thrown piece as "selected"
  updateGhosts();
  syncUI();
}

function doPlace(toKey) {
  if (gameMode === 'ONLINE') {
    net.send('PLACE_PIECE', { pieceType: uiState.trayPick.type, to: toKey });
    clearSelection();
    return;
  }
  gameState = applyAction(gameState, {
    type:      ActionType.PLACE,
    pieceType: uiState.trayPick.type,
    to:        toKey,
  });
  clearSelection();
  syncBoardRenderer();
  afterAction();
}

function doMove(toKey) {
  if (gameMode === 'ONLINE') {
    net.send('MOVE_PIECE', { from: uiState.boardPick, to: toKey });
    clearSelection();
    return;
  }
  gameState = applyAction(gameState, {
    type: ActionType.MOVE,
    from: uiState.boardPick,
    to:   toKey,
  });
  clearSelection();
  syncBoardRenderer();
  afterAction();
}

function doThrow(toKey) {
  if (gameMode === 'ONLINE') {
    net.send('THROW_PIECE', {
      pillbugHex: uiState.throwPillbugHex,
      from: uiState.boardPick,
      to:   toKey,
    });
    clearSelection();
    return;
  }
  gameState = applyAction(gameState, {
    type:       ActionType.THROW,
    pillbugHex: uiState.throwPillbugHex,
    from:       uiState.boardPick,
    to:         toKey,
  });
  clearSelection();
  syncBoardRenderer();
  afterAction();
}

// ── Post-action ────────────────────────────────────────

function afterAction() {
  if (gameState.winner) {
    setTimeout(showWinScreen, 420);
  } else {
    setTimeout(showInterstitial, 480);
  }
}

// ── Confetti ───────────────────────────────────────────

// Pre-render each bug emoji once to a small offscreen canvas.
// drawImage() is a fast GPU blit; fillText() with emoji re-rasterizes every frame.
const BUGS         = ['🐝','🪲','🦗','🐜','🕷️','🦟','🐞','🐛'];
const SPRITE_SIZE  = 36;
const bugSprites   = BUGS.map(emoji => {
  const oc  = document.createElement('canvas');
  oc.width  = SPRITE_SIZE;
  oc.height = SPRITE_SIZE;
  const octx = oc.getContext('2d');
  octx.font         = `${SPRITE_SIZE - 4}px serif`;
  octx.textAlign    = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(emoji, SPRITE_SIZE / 2, SPRITE_SIZE / 2);
  return oc;
});

let confettiRaf = null; // handle so we can cancel a running loop

function launchConfetti() {
  // Cancel any still-running confetti loop
  if (confettiRaf !== null) {
    cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
  }

  const cv  = document.getElementById('confetti-layer');
  const ctx = cv.getContext('2d');
  cv.width  = window.innerWidth;
  cv.height = window.innerHeight;
  cv.style.display = 'block';

  // No respawn: particles start above the screen and fall through once.
  // Stagger start Y so they don't all arrive at once.
  const pts = Array.from({ length: 52 }, (_, i) => ({
    x:      Math.random() * cv.width,
    y:      -SPRITE_SIZE - Math.random() * cv.height * 0.9,
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
      cv.style.display = 'none';
      ctx.clearRect(0, 0, cv.width, cv.height);
      confettiRaf = null;
      return;
    }

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = elapsed > DUR - 800
      ? 1 - (elapsed - (DUR - 800)) / 800
      : 1;

    for (const p of pts) {
      if (p.y > cv.height + SPRITE_SIZE) continue; // already off screen, skip

      p.x   += p.vx;
      p.y   += p.vy;
      p.vy  += 0.06; // gentle gravity
      p.rot += p.vr;

      const sz = SPRITE_SIZE * p.scale;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // drawImage is a single GPU blit — no glyph rasterization
      ctx.drawImage(p.sprite, -sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    confettiRaf = requestAnimationFrame(tick);
  }

  confettiRaf = requestAnimationFrame(tick);
}

// ── Win screen ─────────────────────────────────────────

function showWinScreen() {
  const screen   = document.getElementById('win-screen');
  const headline = document.getElementById('win-headline');
  const winner   = gameState.winner;

  if (winner === 'DRAW') {
    headline.textContent = "IT'S A DRAW!";
    headline.className   = 'draw';
  } else {
    headline.textContent = `PLAYER ${winner} WINS!`;
    headline.className   = `p${winner}`;
  }

  screen.setAttribute('aria-hidden', 'false');
  screen.classList.add('active');
  launchConfetti();
}

document.getElementById('btn-play-again').addEventListener('click', () => {
  const screen = document.getElementById('win-screen');
  screen.classList.remove('active');
  screen.setAttribute('aria-hidden', 'true');
  startGame(gameSettings);
});

document.getElementById('btn-to-menu').addEventListener('click', () => {
  const screen = document.getElementById('win-screen');
  screen.classList.remove('active');
  screen.setAttribute('aria-hidden', 'true');
  hideGame();
  board.pieces.clear();
  board.ghosts = new Set();
  board.selectedHex = null;
  showMenu();
});

// ── Tap handler ────────────────────────────────────────

board.onTap = (q, r) => {
  if (!gameState) return;
  if (gameMode === 'ONLINE' && gameState.turn !== myPlayer) return;
  const key      = hexKey(q, r);
  const stack    = gameState.board.get(key);
  const topPiece = stack ? stack[stack.length - 1] : null;
  const turn     = gameState.turn;

  if (uiState.phase === 'TRAY') {
    if (board.ghosts.has(key))          doPlace(key);
    else if (topPiece?.player === turn) selectBoardPiece(key);
    else                                clearSelection();
    return;
  }

  if (uiState.phase === 'BOARD') {
    if (board.ghosts.has(key))          doMove(key);
    else if (board.throwTargets.has(key)) selectThrowPiece(key, uiState.boardPick);
    else if (key === uiState.boardPick) clearSelection();
    else if (topPiece?.player === turn) selectBoardPiece(key);
    else                                clearSelection();
    return;
  }

  if (uiState.phase === 'THROW') {
    if (board.ghosts.has(key)) doThrow(key);
    else                       clearSelection();
    return;
  }

  if (topPiece?.player === turn) selectBoardPiece(key);
};

// ── Tray rendering ─────────────────────────────────────

function renderTray() {
  const container = document.getElementById('tray-pieces');
  if (!gameState) { container.innerHTML = ''; return; }
  const supply    = gameState.supply[gameState.turn];
  const actions   = getAllLegalActions(gameState);
  const playerCls = `p${gameState.turn}-piece`;

  container.innerHTML = TRAY_ORDER
    .filter(type => type in supply)
    .map(type => {
      const count    = supply[type] ?? 0;
      const ui       = PIECE_UI[type];
      const selected = uiState.trayPick?.type === type;
      const hasSpots = (actions.placements.get(type) || []).length > 0;
      const myTurn   = gameMode !== 'ONLINE' || gameState.turn === myPlayer;
      const disabled = count === 0 || !hasSpots || !myTurn;
      return `<div class="piece-slot ${playerCls}${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}"
           data-type="${type}" role="button"
           aria-label="${ui.label} x${count}" tabindex="${disabled ? -1 : 0}">
        <div class="piece-hex">${ui.emoji}</div>
        <span class="piece-count">x${count}</span>
      </div>`;
    }).join('');

  container.querySelectorAll('.piece-slot:not(.disabled)').forEach(el => {
    el.addEventListener('click',   ()  => selectTrayPiece(el.dataset.type));
    el.addEventListener('keydown', e  => {
      if (e.key === 'Enter' || e.key === ' ') selectTrayPiece(el.dataset.type);
    });
  });
}

// ── HUD sync ───────────────────────────────────────────

const STATUS = {
  IDLE:  'SELECT A PIECE',
  TRAY:  'TAP GREEN HEX TO PLACE',
  BOARD: 'TAP GREEN HEX TO MOVE',
  THROW: 'TAP DESTINATION TO THROW',
};

function syncUI() {
  if (!gameState) return;
  const turn    = gameState.turn;
  const actions = getAllLegalActions(gameState);

  const tag = document.getElementById('player-tag');
  tag.textContent = `P${turn}`;
  tag.className   = `p${turn}`;

  const status = document.getElementById('status-text');
  const desc   = document.getElementById('piece-desc');

  if (actions.mustPass) {
    status.textContent = 'NO MOVES — TURN PASSES';
    status.classList.add('active');
    desc.textContent = '';
    desc.classList.remove('visible');
  } else {
    status.textContent = STATUS[uiState.phase];
    status.classList.toggle('active', uiState.phase !== 'IDLE');

    const selectedType = uiState.trayPick?.type
      || (uiState.boardPick
          ? gameState.board.get(uiState.boardPick)?.[gameState.board.get(uiState.boardPick)?.length - 1]?.type
          : null);
    if (selectedType && PIECE_DESC[selectedType]) {
      desc.textContent = PIECE_DESC[selectedType];
      desc.classList.add('visible');
    } else {
      desc.textContent = '';
      desc.classList.remove('visible');
    }
  }

  document.getElementById('btn-cancel')
    .classList.toggle('hidden', uiState.phase === 'IDLE');

  renderTray();
}

// ── Buttons ────────────────────────────────────────────

document.getElementById('btn-cancel').addEventListener('click', clearSelection);

document.getElementById('btn-resign').addEventListener('click', () => {
  showResignConfirm(() => {
    if (gameMode === 'ONLINE') {
      net.send('RESIGN');
      net.disconnect();
    }
    hideGame();
    board.pieces.clear();
    board.ghosts      = new Set();
    board.selectedHex = null;
    gameState         = null;
    showMenu();
  });
});

// ── Interstitial ───────────────────────────────────────

function showInterstitial() {
  const turn     = gameState.turn;
  const actions  = getAllLegalActions(gameState);
  const overlay  = document.getElementById('interstitial');
  const ring     = document.getElementById('inter-ring');
  const headline = document.getElementById('inter-headline');
  const sub      = document.getElementById('inter-sub');
  const supply   = gameState.supply[turn];
  const available = TRAY_ORDER.filter(t => (supply[t] ?? 0) > 0);
  const decoration = available.length
    ? PIECE_UI[available[Math.floor(Math.random() * available.length)]].emoji
    : '🐝';

  ring.textContent = decoration;
  ring.className   = `inter-hex-ring p${turn}`;

  if (actions.mustPass) {
    headline.textContent = `P${turn} — NO MOVES`;
    sub.textContent      = 'TAP TO PASS';
  } else {
    headline.textContent = `PLAYER ${turn}'S TURN`;
    sub.textContent      = 'TAP TO CONTINUE';
  }
  headline.className = `p${turn}`;

  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('active');

  setTimeout(() => {
    overlay.addEventListener('click', () => {
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      if (actions.mustPass) {
        if (gameMode === 'ONLINE') {
          net.send('PASS_TURN');
        } else {
          gameState = applyAction(gameState, { type: ActionType.PASS });
          setTimeout(showInterstitial, 120);
        }
      } else {
        syncUI();
      }
    }, { once: true });
  }, 350);
}

// ── Net event handlers (ONLINE mode) ──────────────────────

/**
 * Called once by menu.js after a connection is established and the
 * PLAYER_ASSIGNMENT + GAME_START sequence completes. Wires up all
 * server-push events that affect the game UI.
 */
export function initNetHandlers() {
  // Authoritative game state after any action
  net.on('GAME_STATE', ({ gameState: snap }) => {
    gameState = deserializeState(snap);
    syncBoardRenderer();
    if (gameState.winner) {
      setTimeout(showWinScreen, 420);
    } else if (gameMode === 'ONLINE' && gameState.turn === myPlayer) {
      // It's now my turn — no interstitial needed in online mode
      syncUI();
    } else {
      syncUI();
    }
  });

  // Server confirmed game over (e.g. resign)
  net.on('GAME_OVER', ({ winner }) => {
    if (gameState) gameState = { ...gameState, winner };
    setTimeout(showWinScreen, 420);
  });

  // Server rejected a move (shouldn't happen with correct client logic)
  net.on('INVALID_MOVE', ({ reason }) => {
    console.warn('[app] Server rejected move:', reason);
    syncBoardRenderer();
    syncUI();
  });

  // Opponent left
  net.on('OPPONENT_DISCONNECTED', () => {
    const statusEl = document.getElementById('status-text');
    if (statusEl) {
      statusEl.textContent = 'OPPONENT DISCONNECTED';
      statusEl.classList.add('active');
    }
  });

  // Server closed the room (timeout, etc.)
  net.on('ROOM_CLOSED', () => {
    net.disconnect();
    hideGame();
    board.pieces.clear();
    board.ghosts      = new Set();
    board.selectedHex = null;
    gameState         = null;
    showMenu();
  });
}

// ── Boot ───────────────────────────────────────────────

// HUD and tray start hidden; game-visible class reveals them
document.getElementById('hud').style.display  = 'flex';
document.getElementById('tray').style.display = 'flex';
hideGame();

initMenu({ onLocalStart: startGame, onOnlineStart: startOnlineGame, onNetReady: initNetHandlers });
