/**
 * validator.js — Server-side action validation.
 *
 * Thin wrapper around game.js public API. All heavy logic lives in game.js;
 * this file just maps incoming WebSocket messages to legal-action checks.
 */

import { getAllLegalActions, ActionType } from '../js/game.js';

/**
 * Validate that `action` is legal for `playerNum` in the given `state`.
 *
 * @param {object} state     - Live GameState (Map-based, not serialized)
 * @param {object} action    - Action object with a `type` field
 * @param {number} playerNum - 1 or 2
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateAction(state, action, playerNum) {
  if (state.winner) {
    return { valid: false, reason: 'GAME_OVER' };
  }

  if (state.turn !== playerNum) {
    return { valid: false, reason: 'NOT_YOUR_TURN' };
  }

  const { placements, moves, throws, mustPass } = getAllLegalActions(state);

  switch (action.type) {

    case ActionType.PLACE: {
      const legal = placements.get(action.pieceType) ?? [];
      if (!legal.includes(action.to)) {
        return { valid: false, reason: 'ILLEGAL_PLACEMENT' };
      }
      return { valid: true };
    }

    case ActionType.MOVE: {
      const legal = moves.get(action.from) ?? [];
      if (!legal.includes(action.to)) {
        return { valid: false, reason: 'ILLEGAL_MOVE' };
      }
      return { valid: true };
    }

    case ActionType.THROW: {
      const match = throws.some(
        t => t.pillbugHex === action.pillbugHex &&
             t.from       === action.from       &&
             t.to         === action.to
      );
      if (!match) {
        return { valid: false, reason: 'ILLEGAL_THROW' };
      }
      return { valid: true };
    }

    case ActionType.PASS: {
      if (!mustPass) {
        return { valid: false, reason: 'CANNOT_PASS' };
      }
      return { valid: true };
    }

    default:
      return { valid: false, reason: 'UNKNOWN_ACTION_TYPE' };
  }
}
