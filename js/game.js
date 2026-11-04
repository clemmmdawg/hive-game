/**
 * game.js — Pure Hive game logic
 *
 * No DOM, no canvas, no WebSocket. Safe to import on the server.
 * All functions treat GameState as immutable; applyAction returns a new copy.
 *
 * Coordinate system: axial (q, r), flat-top hexagons.
 * Directions are ordered 0-5 clockwise starting from East.
 * This ordering is load-bearing for gate checks — do not reorder.
 */

// ── Constants ────────────────────────────────────────────────────────────────

export const PieceType = Object.freeze({
  QUEEN:       'QUEEN',
  BEETLE:      'BEETLE',
  ANT:         'ANT',
  SPIDER:      'SPIDER',
  GRASSHOPPER: 'GRASSHOPPER',
  MOSQUITO:    'MOSQUITO',
  LADYBUG:     'LADYBUG',
  PILLBUG:     'PILLBUG',
});

export const ActionType = Object.freeze({
  PLACE: 'PLACE',
  MOVE:  'MOVE',
  THROW: 'THROW', // Pillbug special ability
  PASS:  'PASS',
});

// Axial direction vectors for flat-top hex, ordered clockwise from East.
// Index i and index (i+1)%6 are the two gate neighbors for a move in direction i.
// (i+5)%6 is the other gate neighbor.
const DIRS = [
  [+1,  0],   // 0 E
  [+1, -1],   // 1 NE
  [ 0, -1],   // 2 NW
  [-1,  0],   // 3 W
  [-1, +1],   // 4 SW
  [ 0, +1],   // 5 SE
];

const BASE_SUPPLY = {
  [PieceType.QUEEN]:       1,
  [PieceType.BEETLE]:      2,
  [PieceType.ANT]:         3,
  [PieceType.SPIDER]:      2,
  [PieceType.GRASSHOPPER]: 3,
};

// ── Coordinate utilities ─────────────────────────────────────────────────────

export function hexKey(q, r) { return `${q},${r}`; }

export function parseKey(key) {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}

/** Returns the 6 neighbors of (q, r) as { q, r } objects. */
export function neighbors(q, r) {
  return DIRS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

/** Index of the direction from (q,r) to (q+dq, r+dr), or -1 if not a neighbor. */
function dirIndex(dq, dr) {
  return DIRS.findIndex(([q, r]) => q === dq && r === dr);
}

// ── Board accessors ──────────────────────────────────────────────────────────

/**
 * A "board" is a Map<string, Array<{player:1|2, type:PieceType}>>.
 * Each array is a stack; index 0 is bottom, last index is top.
 */

/** Top piece of a stack (the piece that is visually present). */
function topOf(stack) { return stack[stack.length - 1]; }

/** Height of the stack at (q, r). 0 if empty. */
function heightAt(board, q, r) {
  const s = board.get(hexKey(q, r));
  return s ? s.length : 0;
}

/** True if hex is occupied by any piece. */
function occupied(board, q, r) { return board.has(hexKey(q, r)); }

// ── Core rule primitives ─────────────────────────────────────────────────────

/**
 * Freedom to Move / Gate check.
 *
 * A piece moving from (fromQ,fromR) to an adjacent (toQ,toR) travels at the
 * higher of its current level (fromH, measured with the piece still in place)
 * and its landing level (toH + 1). It is blocked only if BOTH common-neighbor
 * stacks reach that level. Ground slides need both gates occupied; a beetle
 * climbing onto a single piece passes over single-height gates and is only
 * blocked by two stacks of height 2.
 *
 * Additionally, a ground-to-ground slide (moving piece at level 1, target
 * empty) must keep contact with the hive: at least one common neighbor must
 * be occupied, otherwise the piece would pivot around nothing. Callers never
 * count the moving piece as a gate (gates are the two neighbors common to
 * both hexes, never the origin).
 */
export function canSlide(board, fromQ, fromR, toQ, toR, fromHOverride) {
  const dq = toQ - fromQ, dr = toR - fromR;
  const di = dirIndex(dq, dr);
  if (di === -1) return false;

  // Two common neighbors: one clockwise, one counter-clockwise from the direction
  const [g1q, g1r] = [fromQ + DIRS[(di + 1) % 6][0], fromR + DIRS[(di + 1) % 6][1]];
  const [g2q, g2r] = [fromQ + DIRS[(di + 5) % 6][0], fromR + DIRS[(di + 5) % 6][1]];

  const h1 = heightAt(board, g1q, g1r);
  const h2 = heightAt(board, g2q, g2r);

  const fromH = (fromHOverride !== undefined) ? fromHOverride : heightAt(board, fromQ, fromR);
  const toH   = heightAt(board, toQ,   toR);
  const need  = Math.max(fromH, toH + 1);
  if (need === 0) return true; // zero-height piece; no gate can block it

  // Ground slide into an empty hex: must stay in contact with the hive
  if (need <= 1 && h1 === 0 && h2 === 0) return false;

  // Blocked only if BOTH gates are at least as tall as the highest endpoint
  return !(h1 >= need && h2 >= need);
}

/**
 * One-Hive Rule: is the piece at `key` an articulation point of the hive graph?
 * If true, removing it would split the hive — it cannot be moved.
 *
 * Beetle on top of a stack (stack.length > 1): removing only the beetle still
 * leaves the hex occupied, so it is never an articulation point.
 */
export function isArticulationPoint(board, key) {
  const stack = board.get(key);
  if (!stack) return false;
  if (stack.length > 1) return false; // top of stack; hex remains after removal

  // Build a virtual board without this piece
  const rest = new Map(board);
  rest.delete(key);
  if (rest.size === 0) return false; // last piece on board

  // BFS connectivity check on `rest`
  const startKey = rest.keys().next().value;
  const visited  = new Set([startKey]);
  const queue    = [startKey];

  while (queue.length) {
    const cur = queue.shift();
    const { q, r } = parseKey(cur);
    for (const n of neighbors(q, r)) {
      const nk = hexKey(n.q, n.r);
      if (rest.has(nk) && !visited.has(nk)) {
        visited.add(nk);
        queue.push(nk);
      }
    }
  }

  return visited.size < rest.size; // true → disconnected → articulation point
}

/**
 * Is the empty hex (q, r) adjacent to at least one occupied hex?
 * excludeKey is treated as absent (used when a piece is in transit).
 */
function adjacentToHive(board, q, r, excludeKey = null) {
  for (const n of neighbors(q, r)) {
    const nk = hexKey(n.q, n.r);
    if (nk !== excludeKey && board.has(nk)) return true;
  }
  return false;
}

/**
 * One ground-level slide step for a piece that has been lifted off `board`
 * (ant / spider pathfinding). Shared by the move generators and getMovePath so
 * an animated route always uses exactly the legality rules of move generation.
 */
function slideStep(tempBoard, fromQ, fromR, toQ, toR) {
  if (occupied(tempBoard, toQ, toR)) return false;
  if (!adjacentToHive(tempBoard, toQ, toR)) return false;
  return canSlide(tempBoard, fromQ, fromR, toQ, toR, 1); // piece is always height 1
}

// ── Movement generators ──────────────────────────────────────────────────────

/**
 * QUEEN BEE — slides exactly one space.
 * Target must be empty, adjacent to hive (excluding the queen's current spot),
 * and reachable by sliding (gate check).
 */
function queenMoves(board, fromKey) {
  const { q, r } = parseKey(fromKey);
  const moves = [];
  for (const n of neighbors(q, r)) {
    const nk = hexKey(n.q, n.r);
    if (occupied(board, n.q, n.r)) continue;
    if (!adjacentToHive(board, n.q, n.r, fromKey)) continue;
    if (!canSlide(board, q, r, n.q, n.r)) continue;
    moves.push(nk);
  }
  return moves;
}

/**
 * BEETLE — slides one space (like queen) OR climbs onto/off an occupied hex.
 *
 * When at ground level (stack.length === 1):
 *   - Can move to an empty neighbor (must stay adjacent to hive, gate check applies)
 *   - Can climb onto any occupied neighbor (gate check applies, hive adjacency is trivially met)
 *
 * When elevated (stack.length > 1, beetle is on top of something):
 *   - Can move to any adjacent hex — occupied (climbing laterally) or empty (descending)
 *   - Gate check applies using heights
 *   - When descending to empty: doesn't need the "must stay adjacent to hive" check
 *     because it was elevated — it's already part of the hive by virtue of being on it
 */
function beetleMoves(board, fromKey) {
  const { q, r } = parseKey(fromKey);
  const fromStack = board.get(fromKey);
  const elevated  = fromStack.length > 1;
  const moves     = [];

  for (const n of neighbors(q, r)) {
    const nk          = hexKey(n.q, n.r);
    const targetStack = board.get(nk);

    if (targetStack) {
      // Moving onto an occupied hex (climbing): gate check, always legal if passable
      if (!canSlide(board, q, r, n.q, n.r)) continue;
      moves.push(nk);
    } else {
      // Moving to empty hex
      if (!canSlide(board, q, r, n.q, n.r)) continue;
      if (!elevated && !adjacentToHive(board, n.q, n.r, fromKey)) continue;
      moves.push(nk);
    }
  }

  return moves;
}

/**
 * GRASSHOPPER — jumps in a straight line over one or more occupied hexes,
 * landing in the first empty hex beyond them.
 * Cannot jump if the immediate neighbor in that direction is empty.
 */
function grasshopperMoves(board, fromKey) {
  const { q, r } = parseKey(fromKey);
  const moves = [];

  for (const [dq, dr] of DIRS) {
    let cq = q + dq, cr = r + dr;
    if (!occupied(board, cq, cr)) continue; // must jump over at least one piece

    while (occupied(board, cq, cr)) {
      cq += dq;
      cr += dr;
    }
    moves.push(hexKey(cq, cr));
  }

  return moves;
}

/**
 * SOLDIER ANT — slides to any empty hex on the perimeter of the hive,
 * as long as a continuous sliding path exists.
 * Uses BFS along the hive perimeter; the ant is temporarily removed for pathfinding.
 */
function antMoves(board, fromKey) {
  const { q, r } = parseKey(fromKey);

  // Remove ant for pathfinding (it can't slide through its own occupied hex)
  const tempBoard = new Map(board);
  tempBoard.delete(fromKey);

  const visited  = new Set([fromKey]); // starting hex is off-limits for landing
  const reachable = new Set();
  const queue    = [{ q, r }];

  while (queue.length) {
    const { q: cq, r: cr } = queue.shift();

    for (const n of neighbors(cq, cr)) {
      const nk = hexKey(n.q, n.r);
      if (visited.has(nk)) continue;
      if (!slideStep(tempBoard, cq, cr, n.q, n.r)) continue;

      visited.add(nk);
      reachable.add(nk);
      queue.push(n);
    }
  }

  return [...reachable];
}

/**
 * SPIDER — slides exactly 3 spaces along the hive edge.
 * Rules:
 *   - Each step must be to an empty hex adjacent to the hive
 *   - Cannot revisit any hex in the same move (no backtracking)
 *   - Cannot end on the starting hex
 *   - Gate (sliding) check applies at each step
 *
 * DFS collecting positions reachable in exactly 3 steps.
 */
function spiderMoves(board, fromKey) {
  const { q, r } = parseKey(fromKey);

  const tempBoard = new Map(board);
  tempBoard.delete(fromKey);

  const results = new Set();

  function dfs(cq, cr, depth, visited) {
    if (depth === 3) {
      results.add(hexKey(cq, cr));
      return;
    }
    for (const n of neighbors(cq, cr)) {
      const nk = hexKey(n.q, n.r);
      if (visited.has(nk)) continue;
      if (!slideStep(tempBoard, cq, cr, n.q, n.r)) continue;

      visited.add(nk);
      dfs(n.q, n.r, depth + 1, visited);
      visited.delete(nk);
    }
  }

  // Starting hex is in the visited set so spider can't return to it mid-path
  dfs(q, r, 0, new Set([fromKey]));

  return [...results];
}

/**
 * LADYBUG — moves exactly 3 steps: two ON TOP of the hive, one DOWN to edge.
 * Steps 1–2: must move to an occupied hex (climbing across the hive).
 * Step 3: must move to an empty hex (landing back at ground level).
 * Cannot land on its own starting hex.
 * Freedom to Move still applies at height: each step is blocked when both
 * common-neighbor stacks reach the higher of the from/to levels. The ladybug
 * is lifted off the board while pathfinding, so its level on a hex is
 * (stack height + 1) and its origin counts as empty.
 */
function ladybugMoves(board, fromKey) {
  return [...new Set(ladybugRoutes(board, fromKey).map(route => route[3]))];
}

/** Every legal ladybug route as [fromKey, step1, step2, landing]. */
function ladybugRoutes(board, fromKey) {
  const { q, r } = parseKey(fromKey);
  const routes = [];
  const temp = new Map(board);
  temp.delete(fromKey);
  const level = (cq, cr) => heightAt(temp, cq, cr) + 1; // ladybug level while on hex

  // Step 1: climb onto any adjacent occupied hex
  for (const n1 of neighbors(q, r)) {
    const n1k = hexKey(n1.q, n1.r);
    if (!occupied(temp, n1.q, n1.r)) continue;
    if (!canSlide(temp, q, r, n1.q, n1.r, 1)) continue;

    // Step 2: move to any occupied hex adjacent to n1 (not back to fromKey)
    for (const n2 of neighbors(n1.q, n1.r)) {
      const n2k = hexKey(n2.q, n2.r);
      if (n2k === fromKey) continue; // can't step back onto starting hex
      if (!occupied(temp, n2.q, n2.r)) continue;
      if (!canSlide(temp, n1.q, n1.r, n2.q, n2.r, level(n1.q, n1.r))) continue;

      // Step 3: land on any empty hex adjacent to n2 (not the starting hex)
      for (const n3 of neighbors(n2.q, n2.r)) {
        const n3k = hexKey(n3.q, n3.r);
        if (n3k === fromKey) continue;
        if (occupied(temp, n3.q, n3.r)) continue;
        if (!canSlide(temp, n2.q, n2.r, n3.q, n3.r, level(n2.q, n2.r))) continue;
        routes.push([fromKey, n1k, n2k, n3k]);
      }
    }
  }

  return routes;
}

/**
 * MOSQUITO — copies the movement type of any adjacent non-mosquito piece.
 *
 * When elevated (on top of a stack), can only move as a beetle.
 * When at ground level, collects all moves from all unique adjacent piece types.
 * A mosquito adjacent only to other mosquitoes cannot move.
 */
function mosquitoMoves(board, fromKey) {
  const fromStack = board.get(fromKey);

  // Elevated: beetle-only
  if (fromStack && fromStack.length > 1) {
    return beetleMoves(board, fromKey);
  }

  const { q, r } = parseKey(fromKey);
  const results   = new Set();
  const usedTypes = new Set();

  for (const n of neighbors(q, r)) {
    if (!occupied(board, n.q, n.r)) continue;
    const adjTop =topOf(board.get(hexKey(n.q, n.r)));
    if (adjTop.type === PieceType.MOSQUITO) continue; // can't copy another mosquito
    if (usedTypes.has(adjTop.type)) continue;
    usedTypes.add(adjTop.type);

    const typeMoves = movesForType(board, fromKey, adjTop.type);
    for (const m of typeMoves) results.add(m);
  }

  return [...results];
}

/**
 * PILLBUG — can slide one space (identical to queen movement).
 * Its THROW ability is handled separately in pillbugThrows().
 */
function pillbugMoves(board, fromKey) {
  return queenMoves(board, fromKey);
}

/**
 * PILLBUG throw ability.
 * In lieu of moving itself, the pillbug can pick up an adjacent piece (any color)
 * and place it in a different empty hex adjacent to the pillbug.
 *
 * Returns an array of { from: hexKey, to: hexKey } throw actions.
 *
 * Restrictions:
 *   - Cannot throw a piece that is part of a stack
 *   - Cannot throw a piece that was moved by the OPPONENT on their last turn
 *     (state.lastOpponentMovedHex)
 *   - Cannot throw a piece that is an articulation point (would split hive)
 *   - The destination must be adjacent to the pillbug and empty
 *   - The destination cannot be the source hex of the piece being thrown
 *   - Freedom of movement: the piece cannot be lifted onto, or lowered off,
 *     the pillbug through a gate of stacked pieces
 *   - A piece that was just thrown cannot move (or throw) on the following turn
 */
function pillbugThrows(board, pillbugKey, lastOpponentMovedHex) {
  const { q, r } = parseKey(pillbugKey);
  const liftH = heightAt(board, q, r) + 1; // level of the piece while on top of the pillbug
  const throws = [];

  // Collect adjacent occupied hexes as throw candidates
  for (const n of neighbors(q, r)) {
    const nk = hexKey(n.q, n.r);
    const stack = board.get(nk);
    if (!stack) continue;
    if (stack.length > 1) continue;                // stacked pieces cannot be thrown
    if (nk === lastOpponentMovedHex) continue;     // opponent just moved this
    if (isArticulationPoint(board, nk)) continue;  // would disconnect hive

    // The piece climbs onto the pillbug and then down the other side, so both
    // legs are subject to the gate rule at pillbug height.
    const lifted = new Map(board);
    lifted.delete(nk);
    if (!canSlide(lifted, n.q, n.r, q, r, 1)) continue;

    // Destination: any other empty hex adjacent to pillbug
    for (const dest of neighbors(q, r)) {
      const destKey = hexKey(dest.q, dest.r);
      if (destKey === nk) continue;                           // source ≠ dest
      if (occupied(board, dest.q, dest.r)) continue;         // must be empty
      if (!canSlide(lifted, q, r, dest.q, dest.r, liftH)) continue;
      throws.push({ from: nk, to: destKey });
    }
  }

  return throws;
}

/**
 * Dispatch table: get moves for a given piece type at fromKey.
 * Does NOT include pillbug throw — that's a separate action type.
 */
function movesForType(board, fromKey, type) {
  switch (type) {
    case PieceType.QUEEN:       return queenMoves(board, fromKey);
    case PieceType.BEETLE:      return beetleMoves(board, fromKey);
    case PieceType.ANT:         return antMoves(board, fromKey);
    case PieceType.SPIDER:      return spiderMoves(board, fromKey);
    case PieceType.GRASSHOPPER: return grasshopperMoves(board, fromKey);
    case PieceType.LADYBUG:     return ladybugMoves(board, fromKey);
    case PieceType.MOSQUITO:    return mosquitoMoves(board, fromKey);
    case PieceType.PILLBUG:     return pillbugMoves(board, fromKey);
    default: return [];
  }
}

// ── Placement logic ──────────────────────────────────────────────────────────

/**
 * Count all pieces belonging to `player` currently on the board,
 * including pieces buried under beetles.
 */
function countPlacedByPlayer(board, player) {
  let n = 0;
  for (const stack of board.values()) {
    for (const piece of stack) {
      if (piece.player === player) n++;
    }
  }
  return n;
}

/**
 * Returns all hex keys where the current player may legally place a new piece.
 * Does not filter for which piece types are available — that's done by the caller.
 */
function legalPlacementHexes(state) {
  const { board, turn } = state;
  const opponent = turn === 1 ? 2 : 1;

  // Very first piece of the game
  if (board.size === 0) return ['0,0'];

  // Player's first piece: must be adjacent to an existing piece (any color),
  // and must not touch any opponent piece — but with only 1 piece on board
  // that piece belongs to the opponent, so the second placement is special:
  // the second player MUST be adjacent to that first piece and may touch it.
  const placed = countPlacedByPlayer(board, turn);
  if (placed === 0) {
    // Opponent placed one piece. Player 2's first placement must touch it.
    const result = new Set();
    for (const key of board.keys()) {
      const { q, r } = parseKey(key);
      for (const n of neighbors(q, r)) {
        const nk = hexKey(n.q, n.r);
        if (!board.has(nk)) result.add(nk);
      }
    }
    return [...result];
  }

  // General: must touch at least one own-color (top) hex, must not touch any opponent-color (top) hex
  const result = new Set();

  for (const [key, stack] of board.entries()) {
    if (topOf(stack).player !== turn) continue;
    const { q, r } = parseKey(key);

    for (const n of neighbors(q, r)) {
      const nk = hexKey(n.q, n.r);
      if (board.has(nk)) continue; // occupied

      let touchesOpponent = false;
      for (const nn of neighbors(n.q, n.r)) {
        const nnk = hexKey(nn.q, nn.r);
        if (nnk === key) continue; // the source own-piece is exempt
        const nnStack = board.get(nnk);
        if (nnStack && topOf(nnStack).player === opponent) {
          touchesOpponent = true;
          break;
        }
      }

      if (!touchesOpponent) result.add(nk);
    }
  }

  return [...result];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a fresh GameState.
 *
 * settings: {
 *   expansions: { mosquito: bool, ladybug: bool, pillbug: bool },
 *   tournamentRule: bool,   // queen banned on turn 1
 *   clock: { enabled: bool, type: 'ABSOLUTE'|'FISCHER'|'BRONSTEIN', time: number, increment: number }
 * }
 */
export function createGame(settings = {}) {
  const exps = settings.expansions || {};
  const makeSupply = () => {
    const s = { ...BASE_SUPPLY };
    if (exps.mosquito) s[PieceType.MOSQUITO] = 1;
    if (exps.ladybug)  s[PieceType.LADYBUG]  = 1;
    if (exps.pillbug)  s[PieceType.PILLBUG]  = 1;
    return s;
  };

  return {
    board:                new Map(),
    supply:               { 1: makeSupply(), 2: makeSupply() },
    turn:                 1,
    turnNumber:           1,        // increments after each player moves
    queenPlaced:          { 1: false, 2: false },
    lastMovedHex:         null,     // hex key of the piece moved last turn (either player)
    lastOpponentMovedHex: null,     // used for pillbug restriction
    pillbugThrewHex:      null,     // piece thrown by pillbug this turn; can't move next turn
    winner:               null,     // null | 1 | 2 | 'DRAW'
    settings:             {
      expansions:     { mosquito: !!exps.mosquito, ladybug: !!exps.ladybug, pillbug: !!exps.pillbug },
      tournamentRule: !!settings.tournamentRule,
      clock:          settings.clock || { enabled: false },
    },
  };
}

/**
 * Get all legal placement hex keys for the current player's current piece type.
 *
 * If pieceType is QUEEN, additional restriction: queen cannot be placed on turn 1
 * when tournamentRule is enabled.
 *
 * Returns [] if no placements are legal for this piece type, or if the player's
 * supply of that piece type is exhausted.
 */
export function getLegalPlacements(state, pieceType) {
  const { supply, turn, turnNumber, settings } = state;

  if ((supply[turn][pieceType] || 0) === 0) return [];

  // Tournament rule: neither player may open with their queen.
  if (pieceType === PieceType.QUEEN && settings.tournamentRule && countPlacedByPlayer(state.board, turn) === 0) return [];

  // Forced queen placement: if this is turn 4 for this player, only queen is legal to place
  const placed = countPlacedByPlayer(state.board, turn);
  const isTurn4 = placed === 3; // about to place 4th piece
  if (isTurn4 && !state.queenPlaced[turn] && pieceType !== PieceType.QUEEN) return [];

  return legalPlacementHexes(state);
}

/**
 * Get all legal move destinations for the piece at fromKey.
 *
 * Returns [] if the piece can't move (wrong player, articulation point,
 * queen not yet placed, just-thrown restriction, etc.)
 */
export function getLegalMoves(state, fromKey) {
  const { board, turn, queenPlaced } = state;
  const stack = board.get(fromKey);
  if (!stack) return [];

  const piece = topOf(stack);
  if (piece.player !== turn) return [];

  // Can't move anything until own queen is placed
  if (!queenPlaced[turn]) return [];

  // Pillbug throw restriction: piece was just thrown, can't move
  if (fromKey === state.pillbugThrewHex) return [];

  // One Hive Rule
  if (isArticulationPoint(board, fromKey)) return [];

  return movesForType(board, fromKey, piece.type);
}

/**
 * Explain why the piece at fromKey has no legal moves, for UI hints.
 * Returns null when the piece can move, otherwise one of:
 *   'EMPTY' | 'NOT_YOUR_PIECE' | 'QUEEN_NOT_PLACED' | 'JUST_THROWN' | 'ONE_HIVE' | 'NO_MOVES'
 * Pillbug throws are not considered; a pinned pillbug may still throw.
 */
export function getMoveBlocker(state, fromKey) {
  const stack = state.board.get(fromKey);
  if (!stack) return 'EMPTY';
  if (topOf(stack).player !== state.turn) return 'NOT_YOUR_PIECE';
  if (!state.queenPlaced[state.turn]) return 'QUEEN_NOT_PLACED';
  if (fromKey === state.pillbugThrewHex) return 'JUST_THROWN';
  if (isArticulationPoint(state.board, fromKey)) return 'ONE_HIVE';
  return getLegalMoves(state, fromKey).length ? null : 'NO_MOVES';
}

/**
 * Get all legal pillbug throws available to the current player.
 *
 * A pillbug (or mosquito adjacent to a pillbug) can throw instead of moving.
 * Returns an array of { pillbugHex, from, to } objects.
 */
export function getLegalThrows(state) {
  const { board, turn, queenPlaced } = state;
  if (!queenPlaced[turn]) return [];

  const result = [];

  for (const [key, stack] of board.entries()) {
    const piece = topOf(stack);
    if (piece.player !== turn) continue;
    if (key === state.pillbugThrewHex) continue; // a just-thrown piece can't use its ability
    // NOTE: do NOT check isArticulationPoint on the pillbug here —
    // the pillbug does not move when throwing, so it staying connected is irrelevant.
    // The AP check on the THROWN PIECE is handled inside pillbugThrows().

    let canThrow = false;

    if (piece.type === PieceType.PILLBUG) {
      canThrow = true;
    } else if (piece.type === PieceType.MOSQUITO && stack.length === 1) {
      // Mosquito can throw if adjacent to a pillbug
      const { q, r } = parseKey(key);
      for (const n of neighbors(q, r)) {
        const nStack = board.get(hexKey(n.q, n.r));
        if (nStack && topOf(nStack).type === PieceType.PILLBUG) {
          canThrow = true;
          break;
        }
      }
    }

    if (canThrow) {
      const throws = pillbugThrows(board, key, state.lastOpponentMovedHex);
      for (const t of throws) {
        result.push({ pillbugHex: key, from: t.from, to: t.to });
      }
    }
  }

  return result;
}

// ── Move paths (animation routes) ────────────────────────────────────────────

/** Route for a piece behaving as `type` from `fromKey` to `toKey`, or null if that type cannot make the move. */
function pathForType(board, fromKey, toKey, type) {
  const { q, r } = parseKey(fromKey);
  switch (type) {
    case PieceType.QUEEN:
    case PieceType.PILLBUG:
      return queenMoves(board, fromKey).includes(toKey) ? { path: [fromKey, toKey], kind: 'slide' } : null;
    case PieceType.BEETLE:
      return beetleMoves(board, fromKey).includes(toKey) ? { path: [fromKey, toKey], kind: 'climb' } : null;
    case PieceType.GRASSHOPPER: {
      for (const [dq, dr] of DIRS) {
        const path = [fromKey];
        let cq = q + dq, cr = r + dr;
        while (occupied(board, cq, cr)) { path.push(hexKey(cq, cr)); cq += dq; cr += dr; }
        if (path.length > 1 && hexKey(cq, cr) === toKey) { path.push(toKey); return { path, kind: 'hop' }; }
      }
      return null;
    }
    case PieceType.ANT: {
      const temp = new Map(board);
      temp.delete(fromKey);
      const parent = new Map([[fromKey, null]]);
      const queue = [fromKey];
      while (queue.length) {
        const cur = queue.shift();
        if (cur === toKey) break;
        const { q: cq, r: cr } = parseKey(cur);
        for (const n of neighbors(cq, cr)) {
          const nk = hexKey(n.q, n.r);
          if (parent.has(nk) || !slideStep(temp, cq, cr, n.q, n.r)) continue;
          parent.set(nk, cur);
          queue.push(nk);
        }
      }
      if (!parent.has(toKey) || toKey === fromKey) return null;
      const path = [];
      for (let k = toKey; k !== null; k = parent.get(k)) path.unshift(k);
      return { path, kind: 'slide' };
    }
    case PieceType.SPIDER: {
      const temp = new Map(board);
      temp.delete(fromKey);
      const path = [fromKey];
      const visited = new Set([fromKey]);
      const dfs = (cq, cr, depth) => {
        if (depth === 3) return hexKey(cq, cr) === toKey;
        for (const n of neighbors(cq, cr)) {
          const nk = hexKey(n.q, n.r);
          if (visited.has(nk) || !slideStep(temp, cq, cr, n.q, n.r)) continue;
          visited.add(nk); path.push(nk);
          if (dfs(n.q, n.r, depth + 1)) return true;
          visited.delete(nk); path.pop();
        }
        return false;
      };
      return dfs(q, r, 0) ? { path: [...path], kind: 'slide' } : null;
    }
    case PieceType.LADYBUG: {
      const route = ladybugRoutes(board, fromKey).find(rt => rt[3] === toKey);
      return route ? { path: route, kind: 'climb' } : null;
    }
    case PieceType.MOSQUITO: {
      const stack = board.get(fromKey);
      if (stack && stack.length > 1) return pathForType(board, fromKey, toKey, PieceType.BEETLE);
      let best = null;
      const seen = new Set();
      for (const n of neighbors(q, r)) {
        const ns = board.get(hexKey(n.q, n.r));
        if (!ns) continue;
        const t = topOf(ns).type;
        if (t === PieceType.MOSQUITO || seen.has(t)) continue;
        seen.add(t);
        const cand = pathForType(board, fromKey, toKey, t);
        if (!cand) continue;
        // Shortest route wins; on a tie a ground step reads better as a slide than a climb.
        const shorter  = !best || cand.path.length < best.path.length;
        const smoother = best && cand.path.length === best.path.length && cand.kind === 'slide' && best.kind === 'climb';
        if (shorter || smoother) best = cand;
      }
      return best;
    }
    default: return null;
  }
}

/**
 * Route a piece takes for `action`, for animation. Returns
 * { path: string[], kind: 'slide'|'hop'|'climb'|'throw'|'place' } (path includes
 * start and end; hops list every jumped hex; throws are [from, pillbugHex, to])
 * or null when the action is not legal in `state` (and always for PASS).
 */
export function getMovePath(state, action) {
  if (!action) return null;
  switch (action.type) {
    case ActionType.PLACE:
      return getLegalPlacements(state, action.pieceType).includes(action.to)
        ? { path: [action.to], kind: 'place' } : null;
    case ActionType.MOVE: {
      if (!getLegalMoves(state, action.from).includes(action.to)) return null;
      return pathForType(state.board, action.from, action.to, topOf(state.board.get(action.from)).type);
    }
    case ActionType.THROW:
      return getLegalThrows(state).some(t => t.pillbugHex === action.pillbugHex && t.from === action.from && t.to === action.to)
        ? { path: [action.from, action.pillbugHex, action.to], kind: 'throw' } : null;
    default: return null;
  }
}

/**
 * Returns a summary of all legal actions for the current player:
 * {
 *   placements: Map<PieceType, string[]>,   piece type → legal hex keys
 *   moves:      Map<string, string[]>,      fromKey   → legal destination keys
 *   throws:     Array<{pillbugHex, from, to}>,
 *   mustPass:   bool
 * }
 */
export function getAllLegalActions(state) {
  if (state.winner) {
    return { placements: new Map(), moves: new Map(), throws: [], mustPass: false };
  }

  const { board, supply, turn } = state;

  // Placements
  const placements = new Map();
  const placementHexes = legalPlacementHexes(state);
  if (placementHexes.length > 0) {
    const placed = countPlacedByPlayer(board, turn);
    const isTurn4 = placed === 3 && !state.queenPlaced[turn];

    for (const pieceType of Object.keys(supply[turn])) {
      if ((supply[turn][pieceType] || 0) === 0) continue;
      if (isTurn4 && pieceType !== PieceType.QUEEN) continue;
      if (pieceType === PieceType.QUEEN && state.settings.tournamentRule && placed === 0) continue;
      placements.set(pieceType, placementHexes);
    }
  }

  // Moves
  const moves = new Map();
  if (state.queenPlaced[turn]) {
    for (const [key, stack] of board.entries()) {
      if (topOf(stack).player !== turn) continue;
      if (key === state.pillbugThrewHex) continue;
      if (isArticulationPoint(board, key)) continue;
      const dests = movesForType(board, key, topOf(stack).type);
      if (dests.length > 0) moves.set(key, dests);
    }
  }

  // Throws
  const throws = getLegalThrows(state);

  const mustPass = placements.size === 0 && moves.size === 0 && throws.length === 0;

  return { placements, moves, throws, mustPass };
}

// ── Win detection ────────────────────────────────────────────────────────────

/**
 * Check if the queen at (q, r) is completely surrounded (all 6 neighbors occupied).
 */
function queenSurrounded(board, q, r) {
  return neighbors(q, r).every(n => occupied(board, n.q, n.r));
}

/**
 * Check the win condition after a move.
 * Returns null (game continues), 1 (P1 wins), 2 (P2 wins), or 'DRAW'.
 */
export function checkWin(state) {
  let p1QueenSurrounded = false;
  let p2QueenSurrounded = false;

  for (const [key, stack] of state.board.entries()) {
    // Find queens at the bottom of each stack
    if (stack[0].type === PieceType.QUEEN) {
      const { q, r } = parseKey(key);
      if (stack[0].player === 1) p1QueenSurrounded = queenSurrounded(state.board, q, r);
      if (stack[0].player === 2) p2QueenSurrounded = queenSurrounded(state.board, q, r);
    }
  }

  if (p1QueenSurrounded && p2QueenSurrounded) return 'DRAW';
  if (p1QueenSurrounded) return 2; // P2 wins
  if (p2QueenSurrounded) return 1; // P1 wins
  return null;
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize a GameState to a plain JSON-safe object.
 * Converts the Map-based board to an array of [key, stack] pairs.
 * Safe to pass through JSON.stringify / JSON.parse.
 */
export function serializeState(state) {
  return {
    board:                [...state.board.entries()],
    supply:               state.supply,
    turn:                 state.turn,
    turnNumber:           state.turnNumber,
    queenPlaced:          state.queenPlaced,
    lastMovedHex:         state.lastMovedHex,
    lastOpponentMovedHex: state.lastOpponentMovedHex,
    pillbugThrewHex:      state.pillbugThrewHex,
    winner:               state.winner,
    settings:             state.settings,
  };
}

/**
 * Deserialize a plain object (from JSON) back into a live GameState with Map.
 */
export function deserializeState(data) {
  return {
    board:                new Map(data.board),
    supply:               data.supply,
    turn:                 data.turn,
    turnNumber:           data.turnNumber,
    queenPlaced:          data.queenPlaced,
    lastMovedHex:         data.lastMovedHex,
    lastOpponentMovedHex: data.lastOpponentMovedHex,
    pillbugThrewHex:      data.pillbugThrewHex,
    winner:               data.winner,
    settings:             data.settings,
  };
}

// ── State mutation ───────────────────────────────────────────────────────────

/**
 * Apply an action and return a NEW GameState.
 * Does not validate legality — call getLegal* first.
 *
 * action: one of:
 *   { type: 'PLACE', pieceType: PieceType, to: hexKey }
 *   { type: 'MOVE',  from: hexKey, to: hexKey }
 *   { type: 'THROW', pillbugHex: hexKey, from: hexKey, to: hexKey }
 *   { type: 'PASS' }
 */
export function applyAction(state, action) {
  // Deep-copy mutable parts of state
  const board   = new Map([...state.board].map(([k, v]) => [k, [...v.map(p => ({ ...p }))]]));
  const supply  = { 1: { ...state.supply[1] }, 2: { ...state.supply[2] } };
  const queenPlaced = { ...state.queenPlaced };

  const turn     = state.turn;
  const opponent = turn === 1 ? 2 : 1;

  let lastMovedHex         = state.lastMovedHex;
  let lastOpponentMovedHex = state.lastOpponentMovedHex;
  let pillbugThrewHex      = null; // reset each turn

  if (action.type === ActionType.PLACE) {
    const { pieceType, to } = action;
    const { q, r } = parseKey(to);

    // Add new piece to board
    board.set(to, [{ player: turn, type: pieceType }]);
    supply[turn][pieceType]--;

    if (pieceType === PieceType.QUEEN) queenPlaced[turn] = true;

    lastOpponentMovedHex = to;  // next player cannot throw the piece we just moved
    lastMovedHex = to;

  } else if (action.type === ActionType.MOVE) {
    const { from, to } = action;
    const fromStack = board.get(from);
    const piece     = fromStack.pop();

    if (fromStack.length === 0) board.delete(from);

    // Place on destination (may stack)
    const toStack = board.get(to);
    if (toStack) {
      toStack.push(piece);
    } else {
      board.set(to, [piece]);
    }

    lastOpponentMovedHex = to;  // next player cannot throw the piece we just moved
    lastMovedHex = to;

  } else if (action.type === ActionType.THROW) {
    const { from, to } = action;
    const fromStack = board.get(from);
    const piece     = fromStack.pop();

    if (fromStack.length === 0) board.delete(from);

    const toStack = board.get(to);
    if (toStack) {
      toStack.push(piece);
    } else {
      board.set(to, [piece]);
    }

    pillbugThrewHex      = to;   // thrown piece can't move next turn
    lastOpponentMovedHex = to;  // next player cannot throw the piece we just threw
    lastMovedHex         = to;

  } else if (action.type === ActionType.PASS) {
    // No piece moved this turn — no throw restriction for next player
    lastOpponentMovedHex = null;
  }

  const nextState = {
    ...state,
    board,
    supply,
    queenPlaced,
    turn:                 opponent,
    turnNumber:           state.turnNumber + 1,
    lastMovedHex,
    lastOpponentMovedHex,
    pillbugThrewHex,
    winner:               null,
  };

  nextState.winner = checkWin(nextState);

  return nextState;
}
