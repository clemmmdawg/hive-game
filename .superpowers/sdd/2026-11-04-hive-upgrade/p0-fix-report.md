# P0 critic fix report

Status: DONE. Full suite 61/61, `npm run check` clean.

## Changes
1. Resign reason after reload: menu.js ROOM_RESUMED passes `endReason` to `onOnlineStart` -> `startOnlineGame(..., endReason)` sets `winReason = resumedWinReason(state, endReason)` (new pure helper in hints.js) after beginGameSession. Browser-verified (fix-resign.mjs): before reload and after reloading the resigner both read "You resigned the game." with status "YOU RESIGNED".
2. Seat steal loop: rooms.js `evictSocket` sends `ERROR SEAT_TAKEN` then closes with code 4001 (terminate fallback after 2 s for half-open sockets). net.js treats the SEAT_TAKEN frame or close code 4001 as intentional (no reconnect). app.js FATAL_ERRORS shows "GAME OPENED IN ANOTHER TAB" via exitToMenu({keepSaved:true}); menu.js pre-game handler also keeps the stored token (`leaveOnlineSession({keepSaved})`). Re-ran tabs script: tab1 gets SEAT_TAKEN + CLOSE once, tab2 ROOM_RESUMED, then silence (previously a swap every 2 s); the menu shows the notice and localStorage `hiveSession` is kept.
3. HUD chip: `turnChipText` ("P1 WINS" / "YOU WIN" / "YOU LOSE" / "DRAW"); chip colour follows the winner.
4. Online game-over toast: "GAME OVER · ☰ FOR MENU".
5. Server replies ERROR INVALID_MESSAGE for non-JSON frames; `maxPayload` 64 KB; malformed-message test asserts the replies; oversize-frame test (close 1009).
6. Wait deadline absolute from `createdAt` (touchActivity delay = remaining).

## TDD
RED: tests written first; `node --test test/net.test.js` failed (not ok 3 SEAT_TAKEN), ui-logic failed to import `resumedWinReason`, multiplayer suite hung/failed on the new server tests. GREEN: multiplayer 14/14, net 3/3, ui-logic 15/15; `npm test` pass 61 fail 0.

## Tests added
- server: two sockets resuming one token settle (older gets SEAT_TAKEN + close 4001, opponent sees no OPPONENT_DISCONNECTED); malformed incl. non-JSON; maxPayload; absolute wait deadline.
- net: SEAT_TAKEN frame / close code 4001 no reconnect.
- ui-logic: resumedWinReason, turnChipText.

## Notes
- The app.js wiring itself (startOnlineGame, exitToMenu) has no unit tests; it is covered by the Playwright runs above.
- A tab that was evicted and left on the menu keeps the token; reloading it will auto-resume and take the seat back (user-initiated reclaim).
- Files: js/app.js, js/menu.js, js/net.js, js/hints.js, server/rooms.js, server/server.js, tests, CLAUDE.md.
