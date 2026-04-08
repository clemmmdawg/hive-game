// menu.js — Main menu, settings panel, resign confirm
// Exports: initMenu(onGameStart), showMenu(), showResignConfirm(onConfirm)

// ── Default settings ────────────────────────────────────

const DEFAULT_SETTINGS = {
  mode:           'LOCAL',
  expansions:     { mosquito: false, ladybug: false, pillbug: false },
  tournamentRule: false,
  clock:          { enabled: false },
};

let _settings    = deepClone(DEFAULT_SETTINGS);
let _onGameStart = null;

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── Public API ──────────────────────────────────────────

/**
 * Wire up the menu and render it.
 * @param {(settings: object) => void} onGameStart  called when player hits START
 */
export function initMenu(onGameStart) {
  _onGameStart = onGameStart;
  _settings    = deepClone(DEFAULT_SETTINGS);
  _bindMenu();
  showMenu();
}

/** Fade the menu in. */
export function showMenu() {
  _settings = deepClone(DEFAULT_SETTINGS);
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
      if (btn.dataset.disabled) return;
      _settings.mode = btn.dataset.mode;
      _syncModeButtons();
      _renderSettings();
    });
  });

  // Start button
  document.getElementById('btn-start').addEventListener('click', () => {
    hideMenu();
    _onGameStart(deepClone(_settings));
  });
}

function _syncModeButtons() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mode === _settings.mode);
  });

  // Only LOCAL is selectable; HOST/JOIN always show disabled
  const startBtn = document.getElementById('btn-start');
  startBtn.disabled = (_settings.mode !== 'LOCAL');
  startBtn.classList.toggle('ready', _settings.mode === 'LOCAL');
}

function _renderSettings() {
  const panel = document.getElementById('settings-panel');
  panel.innerHTML = _buildSettingsHTML();
  _bindSettingsEvents();
}

function _buildSettingsHTML() {
  const s = _settings;
  return `
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
    </div>`;
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
}
