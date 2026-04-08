// menu.js — Main menu, settings panel, resign confirm
// Exports: initMenu({ onLocalStart, onOnlineStart }), showMenu(), showResignConfirm(onConfirm)

import * as net from './net.js';

// ── Default settings ────────────────────────────────────

const DEFAULT_SETTINGS = {
  mode:           'LOCAL',
  expansions:     { mosquito: false, ladybug: false, pillbug: false },
  tournamentRule: false,
  clock:          { enabled: false },
};

let _settings      = deepClone(DEFAULT_SETTINGS);
let _onLocalStart  = null;
let _onOnlineStart = null;
let _onNetReady    = null; // called just before handing off to the online game

// Room state (for HOST/JOIN flow)
let _roomCode  = null; // code we're hosting/joining
let _myPlayer  = null; // 1 or 2

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── Public API ──────────────────────────────────────────

/**
 * Wire up the menu and render it.
 * @param {{ onLocalStart: Function, onOnlineStart: Function, onNetReady: Function }} callbacks
 */
export function initMenu({ onLocalStart, onOnlineStart, onNetReady }) {
  _onLocalStart  = onLocalStart;
  _onOnlineStart = onOnlineStart;
  _onNetReady    = onNetReady;
  _settings      = deepClone(DEFAULT_SETTINGS);
  _bindMenu();
  showMenu();
}

/** Fade the menu in and reset to the initial state. */
export function showMenu() {
  _settings  = deepClone(DEFAULT_SETTINGS);
  _roomCode  = null;
  _myPlayer  = null;
  _hideOnlinePanel();

  const el = document.getElementById('menu-screen');
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('active');
  _renderSettings();
  _syncModeButtons();
}

/** Fade the menu out. */
export function hideMenu() {
  const el = document.getElementById('menu-screen');
  el.classList.remove('active');
  el.setAttribute('aria-hidden', 'true');
}

/**
 * Show the resign confirmation overlay.
 * @param {() => void} onConfirm  called if player confirms resign
 */
export function showResignConfirm(onConfirm) {
  const el = document.getElementById('resign-confirm');
  el.classList.add('active');
  el.setAttribute('aria-hidden', 'false');

  const yes = document.getElementById('btn-resign-yes');
  const no  = document.getElementById('btn-resign-no');

  function cleanup() {
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    yes.removeEventListener('click', handleYes);
    no.removeEventListener('click',  handleNo);
  }

  function handleYes() { cleanup(); onConfirm(); }
  function handleNo()  { cleanup(); }

  yes.addEventListener('click', handleYes, { once: true });
  no.addEventListener('click',  handleNo,  { once: true });
}

// ── Internal ────────────────────────────────────────────

function _bindMenu() {
  // Mode buttons
  document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      _settings.mode = btn.dataset.mode;
      _syncModeButtons();
      _renderSettings();
      _hideOnlinePanel();
    });
  });

  // Start / Create / Join button
  document.getElementById('btn-start').addEventListener('click', _handleStart);
}

function _handleStart() {
  const mode = _settings.mode;

  if (mode === 'LOCAL') {
    hideMenu();
    _onLocalStart(deepClone(_settings));
    return;
  }

  if (mode === 'HOST') {
    _startHostFlow();
    return;
  }

  if (mode === 'JOIN') {
    _startJoinFlow();
    return;
  }
}

// ── HOST flow ───────────────────────────────────────────

function _startHostFlow() {
  _setOnlineStatus('Connecting…');
  _showOnlinePanel();

  net.on('_connected', () => {
    net.send('CREATE_ROOM', { settings: _buildGameSettings() });
  });

  net.on('ROOM_CREATED', ({ code, player, token }) => {
    _roomCode = code;
    _myPlayer = player;
    localStorage.setItem('hiveToken', token);
    _setOnlineStatus(`Room code: <span class="room-code">${code}</span><br>Waiting for opponent…`);
    _showCancelBtn();
  });

  _attachOnlineGameHandlers();
  net.connect();
}

// ── JOIN flow ───────────────────────────────────────────

function _startJoinFlow() {
  const codeInput = document.getElementById('join-code-input');
  const code      = (codeInput?.value ?? '').toUpperCase().trim();

  if (code.length !== 4) {
    _setOnlineStatus('Enter a 4-letter room code.', true);
    _showOnlinePanel();
    return;
  }

  _roomCode = code;
  _setOnlineStatus('Connecting…');
  _showOnlinePanel();

  net.on('_connected', () => {
    net.send('JOIN_ROOM', { code: _roomCode });
  });

  net.on('ROOM_NOT_FOUND', () => {
    _setOnlineStatus('Room not found. Check the code and try again.', true);
  });

  net.on('ERROR', ({ reason }) => {
    _setOnlineStatus(`Error: ${reason}`, true);
  });

  _attachOnlineGameHandlers();
  net.connect();
}

// ── Shared online game event handling ──────────────────

function _attachOnlineGameHandlers() {
  net.on('PLAYER_ASSIGNMENT', ({ player, token }) => {
    _myPlayer = player;
    if (token) localStorage.setItem('hiveToken', token);
  });

  net.on('GAME_START', ({ gameState, settings }) => {
    // Wire up in-game net handlers before handing off
    _onNetReady();
    hideMenu();
    _onOnlineStart(settings, _myPlayer, gameState);
  });

  net.on('_disconnected', () => {
    if (_roomCode) {
      _setOnlineStatus('Disconnected. Reconnecting…');
    }
  });
}

// ── Online panel helpers ────────────────────────────────

function _showOnlinePanel() {
  const panel = document.getElementById('online-panel');
  if (panel) panel.style.display = 'flex';

  const startBtn = document.getElementById('btn-start');
  startBtn.style.display = 'none';
}

function _hideOnlinePanel() {
  const panel = document.getElementById('online-panel');
  if (panel) {
    panel.style.display = 'none';
    _setOnlineStatus('');
  }

  const startBtn = document.getElementById('btn-start');
  startBtn.style.display = '';
}

let _statusDismissTimer = null;

function _setOnlineStatus(html, autoDismiss = false) {
  const el = document.getElementById('online-status');
  if (el) el.innerHTML = html;

  if (_statusDismissTimer) { clearTimeout(_statusDismissTimer); _statusDismissTimer = null; }

  if (autoDismiss) {
    _statusDismissTimer = setTimeout(() => {
      _statusDismissTimer = null;
      net.disconnect();
      _roomCode = null;
      _myPlayer = null;
      _hideOnlinePanel();
      _syncModeButtons();
    }, 3000);
  }
}

function _showCancelBtn() {
  const btn = document.getElementById('btn-cancel-online');
  if (btn) btn.style.display = '';
}

// ── Settings sync ───────────────────────────────────────

function _syncModeButtons() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mode === _settings.mode);
  });

  const startBtn = document.getElementById('btn-start');
  const mode     = _settings.mode;

  if (mode === 'LOCAL') {
    startBtn.textContent = 'START GAME';
    startBtn.disabled    = false;
    startBtn.classList.add('ready');
  } else if (mode === 'HOST') {
    startBtn.textContent = 'CREATE ROOM';
    startBtn.disabled    = false;
    startBtn.classList.add('ready');
  } else if (mode === 'JOIN') {
    startBtn.textContent = 'JOIN ROOM';
    startBtn.disabled    = false;
    startBtn.classList.add('ready');
  }
}

function _renderSettings() {
  const panel = document.getElementById('settings-panel');
  panel.innerHTML = _buildSettingsHTML();
  _bindSettingsEvents();

  // Bind cancel-online button if present
  document.getElementById('btn-cancel-online')?.addEventListener('click', () => {
    net.disconnect();
    _roomCode = null;
    _myPlayer = null;
    _hideOnlinePanel();
    _syncModeButtons();
  });
}

function _buildSettingsHTML() {
  const s    = _settings;
  const mode = s.mode;

  const joinInput = mode === 'JOIN'
    ? `<div class="settings-group">
         <div class="settings-label">ROOM CODE</div>
         <input id="join-code-input" class="room-code-input"
                type="text" maxlength="4" placeholder="ABCD"
                autocomplete="off" spellcheck="false"
                style="text-transform:uppercase">
       </div>`
    : '';

  const gameOptions = mode !== 'JOIN' ? `
    <div class="settings-group">
      <div class="settings-label">EXPANSIONS</div>
      <div class="settings-row">
        ${_toggle('mosquito',  '🦟', 'MOSQUITO',  s.expansions.mosquito)}
        ${_toggle('ladybug',   '🐞', 'LADYBUG',   s.expansions.ladybug)}
        ${_toggle('pillbug',   '🐛', 'PILLBUG',   s.expansions.pillbug)}
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-label">RULES</div>
      <div class="settings-row">
        ${_toggle('tournament', '👑', 'TOURNAMENT OPENING', s.tournamentRule)}
      </div>
    </div>` : '';

  return `
    ${joinInput}
    ${gameOptions}`;
}

function _buildGameSettings() {
  return {
    expansions:     _settings.expansions,
    tournamentRule: _settings.tournamentRule,
    clock:          _settings.clock,
  };
}

function _toggle(id, emoji, label, active) {
  return `
    <button class="setting-toggle${active ? ' on' : ''}" data-setting="${id}"
            aria-pressed="${active}" aria-label="${label}">
      <span class="toggle-emoji">${emoji}</span>
      <span class="toggle-label">${label}</span>
      <span class="toggle-pill">${active ? 'ON' : 'OFF'}</span>
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
    });
  });

  // Auto-uppercase for join code input
  const input = document.getElementById('join-code-input');
  if (input) {
    input.addEventListener('input', () => {
      const pos = input.selectionStart;
      input.value = input.value.toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXYZ2-9]/g, '');
      input.setSelectionRange(pos, pos);
    });
  }
}
