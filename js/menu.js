// menu.js — Main menu, settings panel, rules dialog, confirm dialog
// Exports: initMenu(callbacks), showMenu(opts), hideMenu(), leaveOnlineSession(),
//          showConfirm(opts, onConfirm), showRules(), isOverlayOpen(), copyText(text)

import * as net from './net.js';
import { spriteSVG } from './sprites.js';
import { CLOCK_PRESETS, presetSettings, presetIdOf, normalizeClockSettings } from './clock.js';

// ── Default settings ────────────────────────────────────

const DEFAULT_SETTINGS = {
  mode:           'LOCAL',
  expansions:     { mosquito: false, ladybug: false, pillbug: false },
  tournamentRule: false,
  clock:          { enabled: false },
};

const SETTINGS_KEY = 'hiveSettings';
const SESSION_KEY  = 'hiveSession';
const CODE_CHARS   = /[^BCDFGHJKLMNPQRSTVWXYZ2-9]/g;

let _settings      = deepClone(DEFAULT_SETTINGS);
let _callbacks     = {};
let _joinCode      = '';

// Room state (for HOST/JOIN flow)
let _roomCode      = null; // code we're hosting/joining
let _myPlayer      = null; // 1 or 2
let _playerToken   = null;
let _onlinePending = false; // true from CREATE/JOIN until the game starts or is cancelled
let _rulesPreviousFocus = null;
let _inertedForRules = [];

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
const $ = id => document.getElementById(id);

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode / blocked storage: settings just won't persist */ }
}

// ── Public API ──────────────────────────────────────────

/**
 * Wire up the menu and render it.
 * @param {{
 *   onLocalStart: Function, onOnlineStart: Function, onNetReady: Function,
 *   onContinueLocal?: Function, getLocalSaveSummary?: () => (string|null)
 * }} callbacks
 */
export function initMenu(callbacks) {
  _callbacks = callbacks;
  _bindMenu();
  _applyRoomLink();
  showMenu();
  _tryResumeSavedSession();
}

/** Fade the menu in and reset online state. `notice` shows an inline message. */
export function showMenu({ notice } = {}) {
  _settings    = { ...deepClone(DEFAULT_SETTINGS), ..._loadSavedSettings(), mode: _settings.mode };
  _roomCode    = null;
  _myPlayer    = null;
  _playerToken = null;
  _onlinePending = false;
  _resetOnlinePanel();
  if (notice) _showError(notice);

  const el = $('menu-screen');
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('active');
  el.inert = false;
  el.scrollTop = 0;
  _renderSettings();
  _syncModeButtons();
  _renderContinue();
}

/**
 * Leave any online session and clear reconnect credentials, unless
 * `keepSaved` (the seat was taken by another tab; the token stays so the
 * player can reclaim it later).
 */
export function leaveOnlineSession({ keepSaved = false } = {}) {
  net.disconnect();
  _roomCode = null;
  _myPlayer = null;
  _playerToken = null;
  _onlinePending = false;
  if (!keepSaved) storageSet(SESSION_KEY, null);
}

/** Fade the menu out. */
export function hideMenu() {
  const el = $('menu-screen');
  el.classList.remove('active');
  el.setAttribute('aria-hidden', 'true');
  el.inert = true;
}

/** True while the rules or confirm dialog is open (app uses this to route keys). */
export function isOverlayOpen() {
  return $('rules-overlay').classList.contains('active') || $('resign-confirm').classList.contains('active');
}

/**
 * Show the confirmation dialog.
 * @param {{ title: string, body: string, confirmLabel: string, cancelLabel?: string }} opts
 * @param {() => void} onConfirm  called if the player confirms
 */
export function showConfirm({ title, body, confirmLabel, cancelLabel = 'KEEP PLAYING' }, onConfirm) {
  const el  = $('resign-confirm');
  const yes = $('btn-resign-yes');
  const no  = $('btn-resign-no');
  const previousFocus = document.activeElement;

  $('resign-question').textContent = title;
  $('resign-sub').textContent      = body;
  yes.textContent = confirmLabel;
  no.textContent  = cancelLabel;
  el.inert = false;
  el.classList.add('active');
  el.setAttribute('aria-hidden', 'false');

  function cleanup() {
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    yes.removeEventListener('click', handleYes);
    no.removeEventListener('click',  handleNo);
    el.removeEventListener('keydown', handleKeydown);
    el.removeEventListener('click', handleBackdrop);
    previousFocus?.focus?.();
  }

  function handleYes() { cleanup(); onConfirm(); }
  function handleNo()  { cleanup(); }
  function handleBackdrop(event) { if (event.target === el) handleNo(); }
  function handleKeydown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); handleNo(); }
    if (event.key === 'Tab') {
      const target = document.activeElement === yes && !event.shiftKey ? no
        : document.activeElement === no && event.shiftKey ? yes
        : null;
      if (target) { event.preventDefault(); target.focus(); }
    }
  }

  yes.addEventListener('click', handleYes, { once: true });
  no.addEventListener('click',  handleNo,  { once: true });
  el.addEventListener('keydown', handleKeydown);
  el.addEventListener('click', handleBackdrop);
  no.focus();
}

/** Open the How to Play dialog (from the menu or in-game). */
export function showRules() {
  const overlay = $('rules-overlay');
  if (overlay.classList.contains('active')) return;
  _rulesPreviousFocus = document.activeElement;
  overlay.inert = false;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  // Modal: everything else is inert while it is open, except the toast (an update's RELOAD stays live).
  _inertedForRules = [...document.body.children].filter(el => el !== overlay && el.id !== 'toast' && !el.inert);
  for (const el of _inertedForRules) el.inert = true;
  document.addEventListener('keydown', _handleRulesKeydown, true);
  $('btn-close-rules').focus();
}

// ── Internal ────────────────────────────────────────────

function _bindMenu() {
  document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_onlinePending) leaveOnlineSession(); // switching mode abandons any open room
      _clearError();
      _settings.mode = btn.dataset.mode;
      _resetOnlinePanel();
      _syncModeButtons();
      _renderSettings();
      if (_settings.mode === 'JOIN') $('join-code-input')?.focus();
    });
  });

  $('btn-start').addEventListener('click', _handleStart);
  $('btn-continue').addEventListener('click', () => {
    hideMenu();
    _callbacks.onContinueLocal?.();
  });
  $('btn-rules').addEventListener('click', showRules);
  $('btn-close-rules').addEventListener('click', _hideRules);
  $('rules-overlay').addEventListener('click', event => {
    if (event.target.id === 'rules-overlay') _hideRules();
  });
  $('btn-cancel-online').addEventListener('click', () => {
    leaveOnlineSession();
    _resetOnlinePanel();
    _syncModeButtons();
  });
  $('btn-copy-code').addEventListener('click', () => _copy(_roomCode, $('btn-copy-code'), 'COPY CODE'));
  $('btn-share-link').addEventListener('click', _shareLink);
}

function _hideRules() {
  const overlay = $('rules-overlay');
  if (!overlay.classList.contains('active')) return;
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true; // its close button and scroll area leave the tab order while it is closed
  for (const el of _inertedForRules) el.inert = false;
  _inertedForRules = [];
  document.removeEventListener('keydown', _handleRulesKeydown, true);
  _rulesPreviousFocus?.focus?.();
  _rulesPreviousFocus = null;
}

function _handleRulesKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    _hideRules();
  } else if (event.key === 'Tab') {
    // Cycle between the close button and the scrollable content.
    event.preventDefault();
    const close = $('btn-close-rules'), content = $('rules-content');
    (document.activeElement === close ? content : close).focus();
  }
}

function _handleStart() {
  _clearError();
  const mode = _settings.mode;
  if (mode === 'LOCAL') {
    hideMenu();
    _callbacks.onLocalStart(deepClone(_settings));
  } else if (mode === 'HOST') {
    _startHostFlow();
  } else if (mode === 'JOIN') {
    _startJoinFlow();
  }
}

/** Online modes need the network: say so instead of hanging on a socket that cannot open. */
function _offline() {
  if (navigator.onLine !== false) return false;
  _showError('OFFLINE — LOCAL PLAY ONLY');
  return true;
}

// ── HOST flow ───────────────────────────────────────────

function _startHostFlow() {
  if (_offline()) return;
  _beginOnline('CONNECTING…');

  net.on('_connected', () => {
    if (_roomCode && _playerToken) {
      net.send('RESUME_ROOM', { code: _roomCode, token: _playerToken });
    } else {
      net.send('CREATE_ROOM', { settings: _buildGameSettings() });
    }
  });

  net.on('ROOM_CREATED', ({ code, player, token }) => {
    _roomCode = code;
    _myPlayer = player;
    _playerToken = token;
    _saveSession();
    _showRoom(code);
  });

  _attachOnlineGameHandlers();
  net.connect();
}

// ── JOIN flow ───────────────────────────────────────────

function _startJoinFlow() {
  if (_offline()) return;
  const code = _joinCode.toUpperCase().trim();
  if (code.length !== 4) {
    _showError('Enter the 4-character room code from your host.');
    $('join-code-input')?.focus();
    return;
  }

  _roomCode = code;
  _beginOnline(`JOINING ROOM ${code}…`);

  net.on('_connected', () => {
    if (_playerToken) net.send('RESUME_ROOM', { code: _roomCode, token: _playerToken });
    else net.send('JOIN_ROOM', { code: _roomCode });
  });

  _attachOnlineGameHandlers();
  net.connect();
}

// ── Shared online game event handling ──────────────────

function _attachOnlineGameHandlers() {
  net.on('PLAYER_ASSIGNMENT', ({ player, token }) => {
    _myPlayer = player;
    if (token) _playerToken = token;
    _saveSession();
  });

  net.on('GAME_START', ({ gameState, settings, history, clock, serverNow }) => {
    _onlinePending = false;
    // Wire up in-game net handlers before handing off
    _callbacks.onNetReady();
    hideMenu();
    _callbacks.onOnlineStart(settings, _myPlayer, gameState, null, history ?? [], { clock, serverNow });
  });

  net.on('_disconnected', () => {
    if (!_onlinePending) return;
    _setOnlineStatus(_roomCode
      ? 'CONNECTION LOST — RECONNECTING…'
      : "CAN'T REACH THE SERVER — RETRYING…");
  });

  net.on('WAITING_FOR_OPPONENT', ({ code }) => _showRoom(code));

  net.on('ROOM_RESUMED', ({ player, token, gameState, settings, endReason, history, clock, serverNow }) => {
    _myPlayer = player;
    _playerToken = token;
    _saveSession();
    if (gameState) {
      _onlinePending = false;
      _callbacks.onNetReady();
      hideMenu();
      _callbacks.onOnlineStart(settings, player, gameState, endReason ?? null, history ?? [], { clock, serverNow });
    } else {
      _showRoom(_roomCode);
    }
  });

  net.on('ERROR', ({ reason }) => {
    leaveOnlineSession({ keepSaved: reason === 'SEAT_TAKEN' });
    _resetOnlinePanel();
    _syncModeButtons();
    _showError(_friendlyError(reason));
  });
}

// ── Online panel helpers ────────────────────────────────

function _beginOnline(status) {
  _onlinePending = true;
  _clearError();
  $('online-panel').hidden = false;
  $('room-share').hidden   = true;
  $('btn-start').hidden    = true;
  $('settings-panel').classList.add('locked');
  $('settings-panel').inert = true;
  _setOnlineStatus(status);
}

function _resetOnlinePanel() {
  $('online-panel').hidden = true;
  $('room-share').hidden   = true;
  $('btn-start').hidden    = false;
  $('settings-panel').classList.remove('locked');
  $('settings-panel').inert = false;
  _setOnlineStatus('');
}

function _showRoom(code) {
  if (!code) return;
  _roomCode = code;
  _setOnlineStatus('');
  $('room-code').textContent = code;
  $('room-share').hidden = false;
  $('btn-share-link').textContent = navigator.share ? 'SHARE LINK' : 'COPY LINK';
  $('room-share').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function _setOnlineStatus(text) {
  $('online-status').textContent = text;
}

function _showError(text) {
  const el = $('menu-error');
  el.textContent = text;
  el.hidden = false;
}

function _clearError() {
  $('menu-error').hidden = true;
  $('menu-error').textContent = '';
}

function _roomLink() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', _roomCode);
  return url.toString();
}

async function _shareLink() {
  const link = _roomLink();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Play Hive with me', text: `Join my Hive game — room ${_roomCode}`, url: link });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // user dismissed the share sheet
    }
  }
  _copy(link, $('btn-share-link'), 'COPY LINK');
}

/**
 * Put `text` on the clipboard: the async Clipboard API, or a hidden textarea + execCommand where it is
 * missing (insecure origins such as plain http on a LAN IP). Resolves true when the copy worked.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    let ok;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

async function _copy(text, button, label) {
  const ok = await copyText(text);
  button.textContent = ok ? 'COPIED ✓' : 'COPY FAILED';
  setTimeout(() => { button.textContent = label; }, 1600);
}

// ── Settings sync ───────────────────────────────────────

function _syncModeButtons() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    const selected = btn.dataset.mode === _settings.mode;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });

  const labels = { LOCAL: 'START GAME', HOST: 'CREATE ROOM', JOIN: 'JOIN ROOM' };
  $('btn-start').textContent = labels[_settings.mode];
}

function _renderSettings() {
  $('settings-panel').innerHTML = _buildSettingsHTML();
  _bindSettingsEvents();
}

function _renderContinue() {
  const summary = _callbacks.getLocalSaveSummary?.();
  $('btn-continue').hidden = !summary;
  $('continue-sub').textContent = summary ?? '';
}

function _loadSavedSettings() {
  try {
    const saved = JSON.parse(storageGet(SETTINGS_KEY));
    if (!saved) return {};
    return {
      expansions: {
        mosquito: !!saved.expansions?.mosquito,
        ladybug:  !!saved.expansions?.ladybug,
        pillbug:  !!saved.expansions?.pillbug,
      },
      tournamentRule: !!saved.tournamentRule,
      clock: normalizeClockSettings(saved.clock),
    };
  } catch {
    return {};
  }
}

function _persistSettings() {
  storageSet(SETTINGS_KEY, JSON.stringify({
    expansions: _settings.expansions,
    tournamentRule: _settings.tournamentRule,
    clock: _settings.clock,
  }));
}

function _saveSession() {
  if (!_roomCode || !_playerToken) return;
  storageSet(SESSION_KEY, JSON.stringify({ code: _roomCode, token: _playerToken, player: _myPlayer }));
}

function _tryResumeSavedSession() {
  let saved;
  try { saved = JSON.parse(storageGet(SESSION_KEY)); } catch { return; }
  if (!saved?.code || !saved?.token) return;
  if (_offline()) return; // keep the saved seat for when the network is back

  _roomCode = String(saved.code).toUpperCase().replace(CODE_CHARS, '').slice(0, 4);
  _playerToken = String(saved.token);
  _myPlayer = Number(saved.player) || null;
  _beginOnline('RECONNECTING TO YOUR GAME…');
  _attachOnlineGameHandlers();
  net.on('_connected', () => {
    net.send('RESUME_ROOM', { code: _roomCode, token: _playerToken });
  });
  net.connect();
}

/** A ?room=CODE invite link opens straight into JOIN with the code filled in. */
function _applyRoomLink() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') ?? '').toUpperCase().replace(CODE_CHARS, '').slice(0, 4);
  if (!code) return;
  _settings.mode = 'JOIN';
  _joinCode = code;
  params.delete('room');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function _friendlyError(reason) {
  const messages = {
    ROOM_NOT_FOUND:       'Room not found. Check the code and try again.',
    ROOM_FULL:            'That room already has two players.',
    INVALID_RESUME_TOKEN: 'Your saved seat is no longer valid.',
    ALREADY_IN_ROOM:      'You are already in a room — leave it first.',
    NO_ACTIVE_GAME:       'That game is no longer active.',
    SEAT_TAKEN:           'GAME OPENED IN ANOTHER TAB',
  };
  return messages[reason] ?? 'Unable to connect. Please try again.';
}

function _buildSettingsHTML() {
  const s    = _settings;
  const mode = s.mode;

  if (mode === 'JOIN') {
    return `
      <div class="settings-group">
        <label class="settings-label" for="join-code-input">ROOM CODE</label>
        <input id="join-code-input" class="room-code-input"
               type="text" maxlength="4" placeholder="ABCD" inputmode="text"
               autocomplete="off" autocapitalize="characters" spellcheck="false"
               enterkeyhint="go" value="${_joinCode}">
        <p class="settings-hint">Ask the host for their 4-character code. The host picks the rules.</p>
      </div>`;
  }

  return `
    <div class="settings-group">
      <div class="settings-label">EXPANSIONS</div>
      <div class="settings-row stacked">
        ${_toggle('mosquito',  'MOSQUITO', 'MOSQUITO',  s.expansions.mosquito)}
        ${_toggle('ladybug',   'LADYBUG',  'LADYBUG',   s.expansions.ladybug)}
        ${_toggle('pillbug',   'PILLBUG',  'PILLBUG',   s.expansions.pillbug)}
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-label">RULES</div>
      <div class="settings-row">
        ${_toggle('tournament', 'CROWN', 'TOURNAMENT OPENING', s.tournamentRule)}
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-label" id="clock-label">CLOCK</div>
      <div class="clock-row" role="radiogroup" aria-labelledby="clock-label" aria-describedby="clock-hint">
        ${CLOCK_PRESETS.map(p => _clockChip(p, presetIdOf(s.clock) === p.id)).join('')}
      </div>
      <p class="settings-hint clock-hint" id="clock-hint">${_clockHint(s.clock)}</p>
    </div>`;
}

/** One clock preset chip (a radio in the CLOCK group). */
function _clockChip(preset, checked) {
  const off = preset.id === 'OFF';
  const aria = off ? 'No clock' : `${preset.time / 60_000} minutes plus ${preset.increment / 1000} seconds per move`;
  return `
    <button class="clock-chip${checked ? ' on' : ''}${off ? ' off' : ''}" data-clock="${preset.id}" type="button"
            role="radio" aria-checked="${checked}" aria-label="${aria}" tabindex="${checked ? 0 : -1}">${preset.label}</button>`;
}

function _clockHint(clock) {
  if (!clock?.enabled) return 'Untimed. Pick minutes + seconds added per move.';
  const min = clock.time / 60_000, inc = clock.increment / 1000;
  return `${min} minutes each${inc ? `, +${inc} s after every move` : ', no increment'}. Run out and you lose.`;
}

function _buildGameSettings() {
  return {
    expansions:     _settings.expansions,
    tournamentRule: _settings.tournamentRule,
    clock:          _settings.clock,
  };
}

function _toggle(id, sprite, label, active) {
  return `
    <button class="setting-toggle${active ? ' on' : ''}" data-setting="${id}" type="button"
            aria-pressed="${active}" aria-label="${label}">
      <span class="toggle-emoji" aria-hidden="true">${spriteSVG(sprite)}</span>
      <span class="toggle-label">${label}</span>
      <span class="toggle-pill" aria-hidden="true">${active ? 'ON' : 'OFF'}</span>
    </button>`;
}

function _bindSettingsEvents() {
  document.querySelectorAll('.setting-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.setting;
      let val;
      if (id === 'tournament') {
        _settings.tournamentRule = !_settings.tournamentRule;
        val = _settings.tournamentRule;
      } else {
        _settings.expansions[id] = !_settings.expansions[id];
        val = _settings.expansions[id];
      }
      btn.classList.toggle('on', val);
      btn.setAttribute('aria-pressed', val);
      btn.querySelector('.toggle-pill').textContent = val ? 'ON' : 'OFF';
      _persistSettings();
    });
  });

  const chips = [...document.querySelectorAll('.clock-chip')];
  const pick = chip => {
    _settings.clock = presetSettings(chip.dataset.clock);
    for (const c of chips) {
      const on = c === chip;
      c.classList.toggle('on', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    }
    $('clock-hint').textContent = _clockHint(_settings.clock);
    _persistSettings();
  };
  chips.forEach((chip, i) => {
    chip.addEventListener('click', () => pick(chip));
    chip.addEventListener('keydown', event => { // radio-group arrows
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = chips[(i + step + chips.length) % chips.length];
      pick(next);
      next.focus();
    });
  });

  const input = $('join-code-input');
  if (input) {
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(CODE_CHARS, '').slice(0, 4);
      _joinCode = input.value;
      _clearError();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); _handleStart(); }
    });
  }
}
