const {
  app,
  autoUpdater: nativeAutoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  utilityProcess,
} = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let oauthServer = null;
let pendingOAuth = null;
let trustedRendererPath = null;
let trustedVendorRoot = null;
let allowImmediateQuit = false;
let gracefulQuitInProgress = false;
let updateInstallRequested = false;
let updateCheckPromise = null;
let updateDownloadPromise = null;
let appSession = null;
let ownerAuthFailures = 0;
let ownerAuthLockedUntil = 0;
let firebaseRuntimeSecretIssued = false;
const pendingFlushRequests = new Map();

const MAX_IPC_STRING = 32 * 1024;
const MAX_SYNC_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_SPREADSHEET_RESULT_BYTES = 700000;
const MAX_SPREADSHEET_RECOVERY_BYTES = 8 * 1024 * 1024;
const MAX_PDF_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_AI_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const APP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function _safeRendererSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

// ── Auto-updater config ──────────────────────────────────────
// Keep updater promises under our control. electron-updater's convenience
// notifier starts an untracked download promise and its default notification
// incorrectly promises install-on-exit, which this app intentionally disables.
autoUpdater.autoDownload = false;
// MB1188-062: a feed that regresses — rolled back, mis-published, or tampered
// with — must not be able to walk the studio backwards onto a build whose bugs
// are already fixed. electron-updater defaults this to false, but it is left
// implicit, and the whole point of a guard is that it does not depend on a
// default staying put.
autoUpdater.allowDowngrade = false;
// Installation is explicit: ordinary quit must never apply an update the user
// chose to defer, and Restart to Install first waits for pending saves.
autoUpdater.autoInstallOnAppQuit = false;

// electron-updater reports transport failures by pasting the whole HTTP
// exchange into the message, including a stock "check that your authentication
// token is correct" line that is wrong for a public repository and sends people
// hunting for a credential problem that does not exist. Translate the cases we
// can recognise into something that names the real situation.
function _describeUpdaterError(raw) {
  const text = String(raw || '');
  if (/latest-mac\.yml/.test(text) && /404/.test(text)) {
    return 'The latest release on GitHub has no downloadable build attached, so there is nothing to update to. ' +
      'This is a problem with the published release, not with this Mac.';
  }
  if (/\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT)\b/.test(text)) {
    return 'Could not reach GitHub to check for updates. This is usually the network.';
  }
  if (/\b403\b/.test(text) && /rate limit/i.test(text)) {
    return 'GitHub is rate-limiting update checks right now. Try again shortly.';
  }
  if (/code signature|not signed|rejected/i.test(text)) {
    return 'The downloaded update failed its signature check and was not installed.';
  }
  return null;
}

function _reportUpdaterError(err) {
  const raw = String(err?.message || 'Unknown update error');
  const friendly = _describeUpdaterError(raw);
  // Keep the raw text in the log: the readable version is for whoever is on
  // shift, the original is what makes a real fault diagnosable.
  console.warn('[updater] Error:', raw);
  const message = (friendly || raw).slice(0, 500);
  _safeRendererSend('update-error', message);
  return message;
}

function _startUpdateDownload() {
  if (updateDownloadPromise) return updateDownloadPromise;

  const activeDownload = (async () => {
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      _reportUpdaterError(err);
      return false;
    }
  })();
  updateDownloadPromise = activeDownload;
  // Register both settlement handlers so cleanup never creates a detached
  // rejected promise. The download itself also converts rejection to `false`.
  activeDownload.then(
    () => { if (updateDownloadPromise === activeDownload) updateDownloadPromise = null; },
    () => { if (updateDownloadPromise === activeDownload) updateDownloadPromise = null; },
  );
  return activeDownload;
}

function _checkForUpdatesAndStartDownload() {
  if (updateCheckPromise) return updateCheckPromise;

  const activeCheck = (async () => {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable === true) {
      // The tracked helper consumes its own rejection and reports a bounded
      // message to the renderer, so this deliberate background task is safe.
      void _startUpdateDownload();
    }
    return result;
  })();
  updateCheckPromise = activeCheck;
  activeCheck.then(
    () => { if (updateCheckPromise === activeCheck) updateCheckPromise = null; },
    () => { if (updateCheckPromise === activeCheck) updateCheckPromise = null; },
  );
  return activeCheck;
}

autoUpdater.on('download-progress', (info) => {
  _safeRendererSend('update-download-progress', {
    percent: Math.max(0, Math.min(100, Number(info?.percent) || 0)),
    transferred: Math.max(0, Number(info?.transferred) || 0),
    total: Math.max(0, Number(info?.total) || 0),
    bytesPerSecond: Math.max(0, Number(info?.bytesPerSecond) || 0),
  });
});

autoUpdater.on('update-downloaded', (info) => {
  const currentVer    = app.getVersion();
  const downloadedVer = info?.version || info?.releaseName || '';
  if (downloadedVer && downloadedVer === currentVer) {
    console.log(`[updater] update-downloaded: version ${downloadedVer} matches current — ignoring`);
    return;
  }
  console.log(`[updater] update-downloaded: ${downloadedVer}`);
  _safeRendererSend('update-downloaded', String(downloadedVer).slice(0, 64));
});

autoUpdater.on('error', (err) => {
  _reportUpdaterError(err);
});

// Squirrel.Mac closes windows before Electron's normal `before-quit` event.
// Only bypass the ordinary save gate after our explicit Restart to Install
// action has already flushed renderer persistence and invoked quitAndInstall.
nativeAutoUpdater.on('before-quit-for-update', () => {
  if (!updateInstallRequested) {
    console.error('[updater] Ignoring an unexpected before-quit-for-update signal.');
    return;
  }
  allowImmediateQuit = true;
  app.isQuitting = true;
  pendingOAuth = null;
  _closeOAuthServer();
});

// ── Microsoft OAuth: random loopback port + one-time state ────
const OAUTH_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Music Box — Connected</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:80px;background:#f5f2ec;color:#1a1a1a}</style>
</head><body><h2>Microsoft 365 connected</h2><p>You can close this tab and return to Music Box.</p></body></html>`;
const OAUTH_ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Music Box — Sign-in failed</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:80px;background:#f5f2ec;color:#1a1a1a}</style>
</head><body><h2>Microsoft sign-in failed</h2><p>Close this tab and try connecting again from Music Box.</p></body></html>`;

function _oauthResponse(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(html);
}

function _closeOAuthServer() {
  if (oauthServer) {
    try { oauthServer.close(); } catch (_) {}
    oauthServer = null;
  }
}

function _isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function _validTenant(value) {
  return _isUuid(value) || ['common', 'organizations', 'consumers'].includes(value);
}

function _validPkceChallenge(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

async function _beginMicrosoftOAuth({ accountId, tenant, clientId, codeChallenge }) {
  if (!_validMsAccountId(accountId) || !_validTenant(tenant) ||
      !_isUuid(clientId) || !_validPkceChallenge(codeChallenge)) {
    throw new Error('Invalid Microsoft OAuth configuration.');
  }

  _closeOAuthServer();
  pendingOAuth = null;

  const state = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      _oauthResponse(res, 405, OAUTH_ERROR_HTML);
      return;
    }

    let callback;
    try {
      callback = new URL(req.url, pendingOAuth?.redirectUri || 'http://127.0.0.1/');
    } catch (_) {
      _oauthResponse(res, 400, OAUTH_ERROR_HTML);
      return;
    }

    if (!pendingOAuth || pendingOAuth.callbackReceived ||
        String(req.headers.host || '').toLowerCase() !== pendingOAuth.expectedHost ||
        callback.origin !== pendingOAuth.redirectUri ||
        callback.pathname !== '/' ||
        callback.searchParams.get('state') !== pendingOAuth.state ||
        Date.now() > pendingOAuth.expiresAt) {
      _oauthResponse(res, 400, OAUTH_ERROR_HTML);
      return;
    }

    const error = callback.searchParams.get('error');
    const errorDesc = callback.searchParams.get('error_description');
    const code = callback.searchParams.get('code');
    if (error) {
      _safeRendererSend('ms-auth-error', {
        error: String(error).slice(0, 100),
        errorDesc: String(errorDesc || 'Microsoft sign-in was not completed.').slice(0, 500),
      });
      pendingOAuth = null;
      _oauthResponse(res, 400, OAUTH_ERROR_HTML);
      setImmediate(_closeOAuthServer);
      return;
    }
    if (!code || code.length > 8192) {
      _safeRendererSend('ms-auth-error', {
        error: 'no_code',
        errorDesc: 'The Microsoft redirect did not include a valid authorization code.',
      });
      pendingOAuth = null;
      _oauthResponse(res, 400, OAUTH_ERROR_HTML);
      setImmediate(_closeOAuthServer);
      return;
    }

    pendingOAuth.code = code;
    pendingOAuth.callbackReceived = true;
    // Keep the authorization code in main. The renderer receives only the
    // one-time state needed to finish the PKCE exchange.
    _safeRendererSend('ms-auth-code', { state: pendingOAuth.state });
    _oauthResponse(res, 200, OAUTH_SUCCESS_HTML);
    setImmediate(_closeOAuthServer);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 1;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  oauthServer = server;

  const address = server.address();
  if (!address || typeof address === 'string') {
    _closeOAuthServer();
    throw new Error('Could not start the Microsoft sign-in callback.');
  }
  // Microsoft treats dynamic ports on registered `http://localhost` desktop
  // redirect URIs as equivalent. Keep the registered root path while binding
  // the socket itself to IPv4 loopback only.
  const redirectUri = `http://localhost:${address.port}`;
  pendingOAuth = {
    state,
    redirectUri,
    expectedHost: `localhost:${address.port}`,
    tenant,
    clientId,
    accountId,
    codeChallenge,
    expiresAt: Date.now() + OAUTH_TIMEOUT_MS,
    callbackReceived: false,
    code: null,
  };

  const authorizeUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'Mail.Read Mail.Send User.Read offline_access',
    response_mode: 'query',
    prompt: 'select_account',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  try {
    await shell.openExternal(authorizeUrl.toString());
  } catch (error) {
    pendingOAuth = null;
    _closeOAuthServer();
    throw error;
  }

  setTimeout(() => {
    if (pendingOAuth?.state === state && Date.now() >= pendingOAuth.expiresAt) {
      pendingOAuth = null;
      _closeOAuthServer();
    }
  }, OAUTH_TIMEOUT_MS + 1000).unref();

  return { ok: true, state };
}

// ── Security: prevent new window navigation ──────────────────
const EXTERNAL_DESTINATION_ALLOWLIST = new Set([
  'https://console.anthropic.com/',
  'https://developers.ringcentral.com/',
  'https://console.firebase.google.com/',
  'https://clients.mindbodyonline.com/',
]);

function _safeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (url.length > 512 || parsed.username || parsed.password ||
        parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443') ||
        parsed.search || parsed.hash) return false;
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return EXTERNAL_DESTINATION_ALLOWLIST.has(parsed.toString());
  } catch { return false; }
}

function _openExternalSafely(url) {
  return shell.openExternal(url).then(
    () => true,
    (err) => {
      const message = String(err?.message || 'Unknown external-link error').slice(0, 300);
      console.warn('[external] Failed to open approved URL:', message);
      return false;
    },
  );
}

function _isExactFileUrl(url, expectedPath) {
  if (!expectedPath || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' &&
      !parsed.username && !parsed.password && !parsed.host &&
      path.resolve(fileURLToPath(parsed)) === path.resolve(expectedPath);
  } catch (_) {
    return false;
  }
}

function _isTrustedRendererUrl(url) {
  return _isExactFileUrl(url, trustedRendererPath);
}

const TRUSTED_VENDOR_RELATIVE_PATHS = new Set([
  'firebase-12.15.0/firebase-app-compat.js',
  'firebase-12.15.0/firebase-firestore-compat.js',
  'firebase-12.15.0/firebase-auth-compat.js',
  'firebase-12.15.0/firebase-app-check-compat.js',
  'sheetjs-0.20.3/xlsx.full.min.js',
]);

function _isTrustedVendorUrl(url) {
  if (!trustedVendorRoot || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.host) return false;
    const filePath = path.resolve(fileURLToPath(parsed));
    const relative = path.relative(trustedVendorRoot, filePath).split(path.sep).join('/');
    return !relative.startsWith('../') && !path.isAbsolute(relative) &&
      TRUSTED_VENDOR_RELATIVE_PATHS.has(relative);
  } catch (_) {
    return false;
  }
}

app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (_safeExternalUrl(url)) void _openExternalSafely(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (_isTrustedRendererUrl(url)) return;
    event.preventDefault();
    if (_safeExternalUrl(url)) void _openExternalSafely(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    title: 'Music Box Internal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      webviewTag: false,
      plugins: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });

  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, 'index.html')
    : path.join(__dirname, 'index.html');
  trustedRendererPath = path.resolve(htmlPath);
  trustedVendorRoot = path.resolve(
    app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, 'vendor')
  );

  // This app does not need camera, microphone, geolocation, notifications,
  // MIDI, USB, serial, Bluetooth, or other Chromium permission grants.
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      const isAppDocument = details.resourceType === 'mainFrame' &&
        _isExactFileUrl(details.url, trustedRendererPath);
      const isVendorScript = details.resourceType === 'script' &&
        mainWindow && !mainWindow.isDestroyed() &&
        details.webContentsId === mainWindow.webContents.id &&
        _isTrustedVendorUrl(details.url);
      callback({ cancel: !(isAppDocument || isVendorScript) });
    }
  );
  // MB1188-062: ERR_ABORTED on a reload rejects this, and it was floating.
  mainWindow.loadFile(htmlPath).catch(error => {
    console.warn('[main] loadFile:', error?.message || error);
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) _resetAppSession();
  });
  mainWindow.webContents.on('render-process-gone', () => _resetAppSession());

  // Hide instead of close when clicking the red X.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    _resetAppSession();
    mainWindow = null;
  });

  // Check for updates 5 seconds after launch (only in packaged builds)
  if (app.isPackaged) {
    setTimeout(() => {
      void _checkForUpdatesAndStartDownload().catch(_reportUpdaterError);
    }, 5000);
  }

  mainWindow.setMenuBarVisibility(false);

  // Set a proper application menu so macOS registers standard keyboard shortcuts
  // (Backspace, Cmd+A, Cmd+C, Cmd+V, Cmd+Z, etc.) in all text fields.
  // Without this, the OS never wires up Edit keys and inputs become read-only.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Music Box Internal',
      submenu: [
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' }, { role: 'selectAll' }
      ]
    }
  ]));
}

// Remove Chromium's localStorage quota so encrypted studio data never hits the
// 10 MB browser limit. This is safe in a controlled Electron context.
app.commandLine.appendSwitch('unlimited-storage');

// Single instance lock — prevents duplicate app processes.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — tell it to show itself, then exit immediately
  // Do NOT proceed to app.whenReady().
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  // MB1188-062: an unhandled rejection in main terminates the process under
  // Node's default, taking unsaved renderer work with it because no flush runs.
  // Logged instead: nothing here is a corruption signal, and losing the day's
  // typing to a transient failure is far worse than carrying on.
  process.on('unhandledRejection', reason => {
    console.warn('[main] unhandled rejection:', reason?.message || reason);
  });
  // Deliberately NOT uncaughtException. A rejected promise is usually a
  // transport failure this app already handles; a thrown exception that nothing
  // caught means main is in a state it does not understand, and carrying on
  // there risks writing something wrong. The test suite pins that distinction.

  app.whenReady().then(() => {
    createWindow();

    // Clicking dock icon shows the hidden window
    app.on('activate', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
  });

  app.on('before-quit', (event) => {
    if (allowImmediateQuit) {
      app.isQuitting = true;
      pendingOAuth = null;
      _closeOAuthServer();
      return;
    }
    event.preventDefault();
    if (gracefulQuitInProgress) return;
    gracefulQuitInProgress = true;
    void _finishGracefulQuit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function _isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _boundedString(value, max = MAX_IPC_STRING) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !value.includes('\0');
}

function _isTrustedIpcEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed() || !event?.sender || !event?.senderFrame) return false;
  if (event.sender !== mainWindow.webContents || event.sender.isDestroyed()) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;
  return _isTrustedRendererUrl(event.senderFrame.url);
}

function _secureHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!_isTrustedIpcEvent(event)) {
      throw new Error('Blocked IPC request from an untrusted frame.');
    }
    return handler(event, ...args);
  });
}

function _requestRendererFlush(timeoutMs = 5000) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.resolve(true);
  }
  const requestId = crypto.randomBytes(18).toString('base64url');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingFlushRequests.delete(requestId);
      resolve(false);
    }, timeoutMs);
    pendingFlushRequests.set(requestId, {
      finish(ok) {
        clearTimeout(timer);
        pendingFlushRequests.delete(requestId);
        resolve(ok === true);
      },
    });
    _safeRendererSend('lifecycle-flush-request', { requestId });
  });
}

_secureHandle('renderer-flush-complete', async (_, result) => {
  if (!_isPlainObject(result) || !_boundedString(result.requestId, 128) || typeof result.ok !== 'boolean') {
    throw new Error('Invalid save-flush acknowledgement.');
  }
  const pending = pendingFlushRequests.get(result.requestId);
  if (!pending) return { ok: false };
  pending.finish(result.ok);
  return { ok: true };
});

async function _finishGracefulQuit() {
  let flushed = await _requestRendererFlush();
  while (!flushed) {
    const result = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Music Box could not finish saving',
      message: 'Some recent changes may still be waiting to save.',
      detail: 'Retry saving before quitting, cancel, or explicitly quit without the pending changes.',
      buttons: ['Retry Save', 'Cancel Quit', 'Quit Without Saving'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      flushed = await _requestRendererFlush();
      continue;
    }
    if (result.response !== 2) {
      gracefulQuitInProgress = false;
      return;
    }
    break;
  }
  allowImmediateQuit = true;
  app.isQuitting = true;
  pendingOAuth = null;
  _closeOAuthServer();
  app.quit();
}

// ── IPC: Manual update check ─────────────────────────────────
_secureHandle('check-for-updates', async () => {
  try {
    const result = await _checkForUpdatesAndStartDownload();
    const current = app.getVersion();
    if (result?.isUpdateAvailable === true && result.updateInfo?.version) {
      const latest = result.updateInfo.version;
      return { status: 'update-available', current, latest };
    }
    return { status: 'up-to-date', version: current };
  } catch (e) {
    return { status: 'error', message: _reportUpdaterError(e) };
  }
});

_secureHandle('get-app-version', () => app.getVersion());

/// ── Policies: file picker ────────────────────────────────────────────────────
const selectedFileCapabilities = new Map();
const ALLOWED_IMPORT_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.docx', '.doc']);

function _pruneFileCapabilities() {
  const now = Date.now();
  for (const [token, record] of selectedFileCapabilities) {
    if (record.expiresAt <= now) selectedFileCapabilities.delete(token);
  }
}

async function _consumeFileCapability(token) {
  _pruneFileCapabilities();
  if (!_boundedString(token, 256) || !token.startsWith('mbfile:')) {
    throw new Error('Select the document using the file picker before importing it.');
  }
  const record = selectedFileCapabilities.get(token);
  selectedFileCapabilities.delete(token);
  if (!record || record.expiresAt <= Date.now()) {
    throw new Error('The selected-file permission expired. Choose the document again.');
  }
  const resolved = await fs.promises.realpath(record.path);
  if (resolved !== record.path) throw new Error('The selected document changed. Choose it again.');
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) {
    throw new Error('The selected document must be a file no larger than 20 MB.');
  }
  return { filePath: resolved, ext: path.extname(resolved).toLowerCase(), size: stat.size };
}

function _execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout || '');
    });
  });
}

_secureHandle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'pdf', 'docx', 'doc'] },
    ],
  });
  if (result.canceled || !result.filePaths?.length) {
    return { canceled: true, filePaths: [], fileNames: [] };
  }
  const selectedPath = await fs.promises.realpath(result.filePaths[0]);
  const ext = path.extname(selectedPath).toLowerCase();
  const stat = await fs.promises.stat(selectedPath);
  if (!ALLOWED_IMPORT_EXTENSIONS.has(ext) || !stat.isFile() || stat.size > MAX_IMPORT_BYTES) {
    throw new Error('Choose a TXT, Markdown, PDF, DOC, or DOCX file no larger than 20 MB.');
  }
  _pruneFileCapabilities();
  const token = `mbfile:${crypto.randomBytes(24).toString('base64url')}`;
  selectedFileCapabilities.set(token, {
    path: selectedPath,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  // `filePaths` remains for renderer compatibility but contains only an opaque,
  // one-time capability. The filesystem path never enters renderer memory.
  return { canceled: false, filePaths: [token], fileNames: [path.basename(selectedPath)] };
});

// ── Policies: extract text from file ────────────────────────────────────────
// Returns true if the string looks like real readable text (not binary garbage).
function _looksLikeText(str) {
  if (!str || str.length < 10) return false;
  if (str.startsWith('%PDF')) return false; // raw PDF binary passed through
  const printable = (str.match(/[\x20-\x7E\n\r\t]/g) || []).length;
  return printable / str.length > 0.65;
}

function _parsePdfInUtility(filePath) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'pdf-worker.js');
    let settled = false;
    let child;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid) child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error('PDF extraction timed out after 20 seconds.'));
    }, 20000);

    try {
      child = utilityProcess.fork(workerPath, [], {
        env: {
          LANG: typeof process.env.LANG === 'string' ? process.env.LANG : 'en_US.UTF-8',
          LC_ALL: typeof process.env.LC_ALL === 'string' ? process.env.LC_ALL : 'en_US.UTF-8',
        },
        execArgv: ['--max-old-space-size=256'],
        stdio: 'ignore',
        serviceName: 'Music Box PDF Parser',
        allowLoadingUnsignedLibraries: false,
      });
      child.once('spawn', () => {
        child.postMessage({ filePath, maxTextBytes: MAX_PDF_TEXT_BYTES });
      });
      child.once('message', (message) => {
        if (!_isPlainObject(message) || message.ok !== true ||
            typeof message.text !== 'string' ||
            Buffer.byteLength(message.text, 'utf8') > MAX_PDF_TEXT_BYTES) {
          finish(new Error(
            _isPlainObject(message) && typeof message.error === 'string'
              ? message.error.slice(0, 500)
              : 'The separate PDF parser returned an invalid result.'
          ));
          return;
        }
        finish(null, message.text);
      });
      child.once('error', () => finish(new Error('The separate PDF parser stopped unexpectedly.')));
      child.once('exit', (code) => {
        if (!settled) finish(new Error(`The separate PDF parser exited before completing (${code}).`));
      });
    } catch (error) {
      finish(error);
    }
  });
}

_secureHandle('read-text-file', async (_event, capability) => {
  const { filePath, ext } = await _consumeFileCapability(capability);
  if (ext === '.pdf') {
    // Parse untrusted PDF bytes in a bounded utility process. PDF.js expression
    // evaluation is disabled again inside pdf-worker.js.
    try {
      const text = await _parsePdfInUtility(filePath);
      if (_looksLikeText(text)) return text;
    } catch (e1) {
      console.warn('[pdf] separate parser failed:', String(e1?.message || 'unknown error').slice(0, 500));
    }
    throw new Error(
      'Could not extract text from this PDF.\n\n' +
      'Paste manually:\n' +
      '  Open the PDF, press Cmd+A then Cmd+C, and paste into the text box.'
    );
  } else if (ext === '.docx' || ext === '.doc') {
    try {
      // Use the fixed macOS system binary and an argument array; neither PATH
      // lookup nor a shell can redirect the selected file into another tool.
      const out = await _execFileText('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath]);
      if (_looksLikeText(out)) return out;
    } catch (_) {}
    throw new Error('Could not convert this document. Save it as a .txt file and import again.');
  } else {
    return fs.promises.readFile(filePath, 'utf8');
  }
});

// MB161-029: importing a spreadsheet FILE is gone.
//
// The studio brings its sheets in from Google, so the file path was a second
// way to do the same job that nobody used — and it was the larger attack
// surface of the two: a file dialog, a path realpath'd and stat'd, and an
// untrusted .xlsx parsed in a utility process. Removing it removes all of that.
// Exporting a recovery bundle is a different thing and stays; it is the only
// way out of a quarantined workbook.

function _isAllowedHttpsUrl(value, allowedDomains) {
  try {
    const parsed = value instanceof URL ? value : new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        (parsed.port && parsed.port !== '443')) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch (_) {
    return false;
  }
}

function _boundedHttpsGet(targetUrl, { allowedDomains, timeout, maxBytes, hops = 0 }) {
  return new Promise((resolve) => {
    if (hops > 3 || !_isAllowedHttpsUrl(targetUrl, allowedDomains)) {
      resolve({ ok: false, error: 'Blocked URL or redirect.' });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.get(targetUrl, {
      timeout,
      headers: { 'User-Agent': `MusicBoxInternal/${app.getVersion()}` },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, targetUrl); }
        catch (_) { finish({ ok: false, error: 'Invalid redirect.' }); return; }
        if (!_isAllowedHttpsUrl(next, allowedDomains)) {
          finish({ ok: false, error: 'Redirect outside the approved domain was blocked.' });
          return;
        }
        _boundedHttpsGet(next, { allowedDomains, timeout, maxBytes, hops: hops + 1 }).then(finish);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish({ ok: false, error: `Remote server returned HTTP ${res.statusCode}.` });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        finish({ ok: false, error: 'Remote response exceeded the size limit.' });
        return;
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy();
          finish({ ok: false, error: 'Remote response exceeded the size limit.' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => finish({ ok: false, error: error.message }));
    });
    req.on('error', (error) => finish({ ok: false, error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'Request timed out.' });
    });
  });
}

// ── Fetch Music Box website content (restricted to themusicboxinc.com only) ──
_secureHandle('fetch-musicbox-website', async () => {
  const ALLOWED_DOMAINS = ['themusicboxinc.com'];
  const URLS = [
    'https://www.themusicboxinc.com/',
    'https://www.themusicboxinc.com/lessons',
    'https://www.themusicboxinc.com/about',
    'https://www.themusicboxinc.com/contact',
    'https://www.themusicboxinc.com/schedule',
    'https://www.themusicboxinc.com/rates',
    'https://www.themusicboxinc.com/faq',
  ];

  const stripHtml = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ').trim();

  const pages = await Promise.all(URLS.map(url =>
    _boundedHttpsGet(url, {
      allowedDomains: ALLOWED_DOMAINS,
      timeout: 8000,
      maxBytes: 400000,
    })
  ));
  const labelled = pages
    .map((result, i) => {
      const t = result.ok ? stripHtml(result.text) : '';
      return t.length > 100 ? `[${URLS[i]}]\n${t}` : '';
    })
    .filter(Boolean);

  return labelled.join('\n\n---\n\n').slice(0, 60000);
});

// ── Fetch Google Sheets CSV (restricted to *.google.com only) ──
_secureHandle('fetch-csv', async (_, url) => {
  try {
    if (!_boundedString(url, 4096)) return { error: 'Invalid Google Sheets URL.' };
    const allowedDomains = ['google.com', 'googleapis.com', 'googleusercontent.com'];
    if (!_isAllowedHttpsUrl(url, allowedDomains)) {
      return { error: 'Only Google Sheets URLs are allowed.' };
    }
    const result = await _boundedHttpsGet(url, {
      allowedDomains,
      timeout: 15000,
      maxBytes: 2 * 1024 * 1024,
    });
    return result.ok ? result : { error: result.error };
  } catch (e) {
    return { error: e.message };
  }
});

// MB-008: Use standard electron-updater install path — no custom shell scripts.
// electron-updater handles download verification, extraction, and relaunch.
_secureHandle('quit-and-install', async () => {
  if (updateInstallRequested) {
    return { ok: false, error: 'The update restart is already in progress.' };
  }
  const flushed = await _requestRendererFlush();
  if (!flushed) {
    return {
      ok: false,
      error: 'The update was not installed because pending changes could not be saved. Retry after the save completes.',
    };
  }
  updateInstallRequested = true;
  setImmediate(() => {
    console.log('[updater] quit-and-install: calling autoUpdater.quitAndInstall');
    try {
      autoUpdater.quitAndInstall(false, true);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          updateInstallRequested = false;
          _safeRendererSend('update-error', 'The updater did not restart the app. Quit and reopen, then try again.');
        }
      }, 15000).unref();
    } catch (e) {
      updateInstallRequested = false;
      const message = String(e?.message || 'Could not install the update.').slice(0, 500);
      console.error('[updater] quitAndInstall error:', message);
      _safeRendererSend('update-error', message);
    }
  });
  return { ok: true };
});

// ── IPC: AES-256-GCM encryption — key protected by Electron safeStorage ────
// MB-009: safeStorage wraps the key with the OS credential store (macOS
// Keychain) so the raw 32-byte key never sits on disk in plaintext.
// Migration: if the old plain-file key (store-key.bin) still exists, it is
// read once, re-protected via safeStorage, then deleted.
let _cachedStoreKey = null;

// MB1188-084: atomic AND durable.
//
// write-to-temp plus rename gives atomicity — a reader never sees half a file.
// It does NOT give durability: without fsync the bytes can still be in the
// page cache when the power goes, and the rename can land before the contents.
// The audit found the same gap one layer up, in the renderer; this closes it
// for everything main owns, which is the vault — profiles, roles, tombstones,
// passcode verifiers and lockouts.
//
// Three syncs, in the only order that is sound: the DATA first, so the file has
// contents before anything points at it; then the rename; then the DIRECTORY,
// so the rename itself survives. A failure to sync is a failure to write.
function _atomicWriteFileSync(targetPath, data, mode = 0o600) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let handle = null;
  try {
    handle = fs.openSync(tmpPath, 'w', mode);
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmpPath, targetPath);
    // Durability of the rename lives in the parent directory, not the file.
    // Not fatal on the platforms that refuse it: the data is already synced,
    // and refusing the whole write here would be worse than the residual risk.
    let dir = null;
    try {
      dir = fs.openSync(path.dirname(targetPath), 'r');
      fs.fsyncSync(dir);
    } catch (error) {
      console.warn('[storage] directory sync unavailable:', error?.message || error);
    } finally {
      if (dir !== null) { try { fs.closeSync(dir); } catch (_) {} }
    }
  } catch (error) {
    if (handle !== null) { try { fs.closeSync(handle); } catch (_) {} }
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw error;
  }
}

function _getStoreKey() {
  if (_cachedStoreKey) return _cachedStoreKey;

  const { safeStorage } = require('electron');
  const encKeyPath  = path.join(app.getPath('userData'), 'store-key-v2.bin');
  const legacyPath  = path.join(app.getPath('userData'), 'store-key.bin');
  const canEncrypt  = safeStorage.isEncryptionAvailable();

  // ── 1. Try to load the safeStorage-protected key ──
  if (canEncrypt && fs.existsSync(encKeyPath)) {
    try {
      const encrypted = fs.readFileSync(encKeyPath);
      const keyHex = safeStorage.decryptString(encrypted);
      if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('Invalid protected key data.');
      _cachedStoreKey = Buffer.from(keyHex, 'hex');
      return _cachedStoreKey;
    } catch (e) {
      // Never replace a key merely because it could not be decrypted. That
      // would make every existing encrypted record unrecoverable.
      console.error('[key] Protected store key could not be opened.');
      throw new Error('Secure data could not be unlocked with macOS Keychain.');
    }
  }

  // ── 2. Migrate legacy plain-file key if present ──
  let key = null;
  if (fs.existsSync(legacyPath)) {
    try {
      key = fs.readFileSync(legacyPath);
    } catch (e) {
      throw new Error('The legacy data-encryption key could not be read.');
    }
  }

  // ── 3. Generate a new key if nothing was found ──
  if (!key || key.length !== 32) {
    if (key) throw new Error('The legacy data-encryption key is invalid.');
    key = crypto.randomBytes(32);
  }

  // ── 4. Persist through safeStorage only. Retain an existing legacy key
  // until its protected replacement is safely on disk.
  if (!canEncrypt) {
    throw new Error('Secure credential storage is unavailable.');
  }
  try {
    const encrypted = safeStorage.encryptString(key.toString('hex'));
    _atomicWriteFileSync(encKeyPath, encrypted, 0o600);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  } catch (e) {
    throw new Error('Could not protect the data-encryption key with macOS Keychain.');
  }

  _cachedStoreKey = key;
  return _cachedStoreKey;
}

_secureHandle('keychain-encrypt', async (_, plaintext) => {
  try {
    if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_SYNC_BYTES) return null;
    const key = _getStoreKey();
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag  = cipher.getAuthTag();
    // format: iv(12) + tag(16) + ciphertext
    return Buffer.concat([iv, tag, enc]).toString('base64');
  } catch { return null; }
});

_secureHandle('keychain-decrypt', async (_, b64) => {
  try {
    if (!_boundedString(b64, Math.ceil(MAX_SYNC_BYTES * 1.5)) || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
    const key = _getStoreKey();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 29 || buf.length > MAX_SYNC_BYTES + 28) return null;
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch { return null; }
});

// ─────────────────────────────────────────────────────────────
// MB161-014/021: Google Sheets, one direction — Google to the app.
//
// This was read-only, then briefly two-way, and is read-only again. The round
// trip is worth recording, because the second version was not broken:
//
// Pushing meant widening the scope to `spreadsheets`, splitting writes across
// two input options, reconciling the cells Google refused, and keeping a
// checkpoint accurate enough to write from. All of that worked. But its failure
// mode was somebody's real spreadsheet being overwritten, and the studio does
// not actually need it — they edit in the app, and Google only has to be able
// to feed changes in.
//
// So the scope is `spreadsheets.readonly` again and there is no write handler.
// Google itself refuses a write, which is a guarantee that holds even if
// everything in this file is wrong. That is worth more than the feature was.
//
// Same loopback-plus-PKCE shape as the Microsoft flow above, with the three
// differences Google requires: `access_type=offline` and `prompt=consent` to
// receive a refresh token at all, and a client id that is not a UUID.
// ─────────────────────────────────────────────────────────────

const GOOGLE_VAULT_KEY = 'app_google_sheets_v1';
// MB161-016 / P3-01: READ ONLY, and this comment used to say the opposite.
//
// Two-way sync existed briefly and was removed. The scope below is the narrow
// readonly one, which means Google itself refuses a write on our behalf no
// matter what this file does — a guarantee that does not depend on this code
// being correct. There is no push path, no write IPC and no write method on
// the preload bridge.
//
// The previous version of this note described pushes and claimed the readonly
// scope was gone. It was wrong, and wrong in the dangerous direction: it read
// as licence to add a write. Do not.
//
// google-oauth-complete verifies the scope actually granted rather than the
// one requested, because Google does not silently upgrade an existing grant.
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
let pendingGoogleOAuth = null;
let googleOAuthServer = null;

// MB161-015: this page is served the moment Google hands back the authorization
// code — BEFORE Music Box exchanges it for a token. Saying "connected" here was
// a lie: the browser reported success while the app was still not connected,
// and the exchange could fail with the person having been told it worked.
const GOOGLE_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Music Box — Returning</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:80px;background:#f5f2ec;color:#1a1a1a}</style>
</head><body><h2>Google approved the request</h2><p>Close this tab and go back to Music Box &mdash;
it will say whether the connection finished.</p></body></html>`;
const GOOGLE_ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Music Box — Sign-in failed</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:80px;background:#f5f2ec;color:#1a1a1a}</style>
</head><body><h2>Google sign-in failed</h2><p>Close this tab and try connecting again from Music Box.</p></body></html>`;

// `123456789012-abc123def456.apps.googleusercontent.com`
// Characters that render as nothing and survive a copy/paste: zero-width
// spaces and joiners, soft hyphens, bidi marks, the BOM. JavaScript's \s does
// NOT match most of these, which is why a client ID that looked perfect on
// screen kept being refused — the visible text validated fine, the stored
// string had something invisible wedged into it.
const INVISIBLE = /[\s\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;

function _cleanGoogleClientId(value) {
  // A Google client ID is digits, one hyphen, alphanumerics/underscore, dots.
  // Anything else is contamination from wherever it was copied.
  return String(value || '').replace(INVISIBLE, '').replace(/[^A-Za-z0-9._-]/g, '');
}

function _cleanGoogleSecret(value) {
  // Invisible characters only. A secret's real content is never guessed at or
  // rewritten — if what remains is not valid, it is refused, not repaired.
  return String(value || '').replace(INVISIBLE, '');
}

function _describeGoogleClientIdProblem(raw, cleaned) {
  const base = 'That does not look like a Google OAuth client ID. ' +
    'It should end in .apps.googleusercontent.com';
  const original = String(raw || '');
  if (original !== cleaned && _validGoogleClientId(cleaned)) {
    // Should not happen — cleaned is what gets validated — but never lie.
    return base;
  }
  if (original !== cleaned) {
    const removed = original.length - cleaned.length;
    return `${base} (${removed} hidden or invalid character${removed === 1 ? '' : 's'} ` +
      `were removed from what you pasted, and what was left still does not match: "${cleaned}")`;
  }
  return `${base} (received: "${cleaned}")`;
}

function _validGoogleClientId(value) {
  return typeof value === 'string' &&
    /^[0-9]{6,32}-[A-Za-z0-9_]{8,64}\.apps\.googleusercontent\.com$/.test(value);
}

// A desktop client secret is NOT confidential — Google's own native-app guidance
// says so — but it is still a credential the studio would rather not leave in a
// plain file, so it lives in the same safeStorage vault as everything else.
function _validGoogleClientSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value);
}

function _closeGoogleOAuthServer() {
  if (googleOAuthServer) {
    try { googleOAuthServer.close(); } catch (_) {}
    googleOAuthServer = null;
  }
}

// The last failure reading the secret vault, if any.
//
// This used to swallow every error and return {}, which made "you have not
// saved a client ID yet" and "I cannot read the vault at all" produce the exact
// same message: 'Add the Google OAuth client ID in Settings before connecting.'
// On a second Mac that is the difference between a five-second fix and an hour
// of guessing, and we spent that hour.
let _googleVaultReadError = null;

function _googleVault() {
  try {
    const vault = _loadSecretVault();
    _googleVaultReadError = null;
    const entry = vault[GOOGLE_VAULT_KEY];
    return _isPlainObject(entry) ? entry : {};
  } catch (error) {
    _googleVaultReadError = String(error?.message || error).slice(0, 300);
    return {};
  }
}

function _saveGoogleVault(next) {
  const vault = _loadSecretVault();
  if (next === null) delete vault[GOOGLE_VAULT_KEY];
  else vault[GOOGLE_VAULT_KEY] = next;
  _saveSecretVault(vault);
}

async function _beginGoogleOAuth({ clientId, codeChallenge }) {
  if (!_validGoogleClientId(clientId) || !_validPkceChallenge(codeChallenge)) {
    throw new Error('Invalid Google OAuth configuration.');
  }

  _closeGoogleOAuthServer();
  pendingGoogleOAuth = null;

  const state = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      _oauthResponse(res, 405, GOOGLE_ERROR_HTML);
      return;
    }
    let callback;
    try {
      callback = new URL(req.url, pendingGoogleOAuth?.redirectUri || 'http://127.0.0.1/');
    } catch (_) {
      _oauthResponse(res, 400, GOOGLE_ERROR_HTML);
      return;
    }
    if (!pendingGoogleOAuth || pendingGoogleOAuth.callbackReceived ||
        String(req.headers.host || '').toLowerCase() !== pendingGoogleOAuth.expectedHost ||
        callback.origin !== pendingGoogleOAuth.redirectUri ||
        callback.pathname !== '/' ||
        callback.searchParams.get('state') !== pendingGoogleOAuth.state ||
        Date.now() > pendingGoogleOAuth.expiresAt) {
      _oauthResponse(res, 400, GOOGLE_ERROR_HTML);
      return;
    }

    const error = callback.searchParams.get('error');
    const code = callback.searchParams.get('code');
    if (error) {
      _safeRendererSend('google-auth-error', {
        error: String(error).slice(0, 100),
        errorDesc: String(callback.searchParams.get('error_description') ||
          'Google sign-in was not completed.').slice(0, 500),
      });
      pendingGoogleOAuth = null;
      _oauthResponse(res, 400, GOOGLE_ERROR_HTML);
      setImmediate(_closeGoogleOAuthServer);
      return;
    }
    if (!code || code.length > 8192) {
      _safeRendererSend('google-auth-error', {
        error: 'no_code',
        errorDesc: 'The Google redirect did not include a valid authorization code.',
      });
      pendingGoogleOAuth = null;
      _oauthResponse(res, 400, GOOGLE_ERROR_HTML);
      setImmediate(_closeGoogleOAuthServer);
      return;
    }

    // The authorization code never leaves the main process. The renderer is
    // told only the one-time state, exactly as the Microsoft flow does.
    pendingGoogleOAuth.code = code;
    pendingGoogleOAuth.callbackReceived = true;
    _safeRendererSend('google-auth-code', { state: pendingGoogleOAuth.state });
    _oauthResponse(res, 200, GOOGLE_SUCCESS_HTML);
    setImmediate(_closeGoogleOAuthServer);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 1;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  googleOAuthServer = server;

  const address = server.address();
  if (!address || typeof address === 'string') {
    _closeGoogleOAuthServer();
    throw new Error('Could not start the Google sign-in callback.');
  }
  // Google's native-app guidance permits a loopback redirect on an arbitrary
  // port, and matches on the IP literal rather than the hostname — so unlike
  // Microsoft this must be 127.0.0.1, not localhost.
  const redirectUri = `http://127.0.0.1:${address.port}`;
  pendingGoogleOAuth = {
    state,
    redirectUri,
    expectedHost: `127.0.0.1:${address.port}`,
    clientId,
    codeChallenge,
    expiresAt: Date.now() + OAUTH_TIMEOUT_MS,
    callbackReceived: false,
    code: null,
  };

  const authorizeUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPE,
    // Without both of these Google returns an access token and no refresh
    // token, and the connection silently dies an hour later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  try {
    await shell.openExternal(authorizeUrl.toString());
  } catch (error) {
    pendingGoogleOAuth = null;
    _closeGoogleOAuthServer();
    throw error;
  }

  setTimeout(() => {
    if (pendingGoogleOAuth?.state === state && Date.now() >= pendingGoogleOAuth.expiresAt) {
      pendingGoogleOAuth = null;
      _closeGoogleOAuthServer();
    }
  }, OAUTH_TIMEOUT_MS + 1000).unref();

  return { ok: true };
}

// MB161-017: every Google call goes through Electron's `net`, not Node's
// `https`.
//
// Node ships its own CA bundle and ignores the macOS keychain. Any machine
// running TLS-inspecting software — parental controls, corporate filtering,
// some antivirus — presents a certificate signed by a root CA that the system
// trusts and Node does not, and every request dies with "unable to verify the
// first certificate". Reported from a real Mac running Qustodio.
//
// Electron's `net` uses Chromium's network stack, which reads the system trust
// store, so it succeeds exactly where the OS itself would. It also picks up
// system proxy settings for free. This is not a workaround and it does not
// weaken verification: the certificate is still verified, against the store
// that actually reflects the machine.
function _googleHttp({ method, url, headers = {}, body = null, limit = 8 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const { net } = require('electron');
    const request = net.request({ method, url });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch (_) {}
      reject(new Error('Google did not respond in time.'));
    }, 30000);
    request.on('response', response => {
      let raw = '';
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { request.abort(); } catch (_) {}
          reject(new Error('The Google response was too large to read safely.'));
          return;
        }
        raw += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ statusCode: response.statusCode, text: raw });
      });
    });
    request.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    if (body !== null) request.write(body);
    request.end();
  });
}

async function _googleTokenRequest(body) {
  const payload = new URLSearchParams(body).toString();
  const { statusCode, text } = await _googleHttp({
    method: 'POST',
    url: GOOGLE_TOKEN_ENDPOINT,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: payload,
    limit: 256 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Google returned a response this app could not read.');
  }
  if (statusCode !== 200) {
    // Google names the actual problem here; passing it through saves an hour
    // of guessing which of the six setup steps was missed.
    const detail = parsed.error_description || parsed.error || `HTTP ${statusCode}`;
    throw new Error(`Google refused the sign-in: ${String(detail).slice(0, 300)}`);
  }
  return parsed;
}

// Access tokens live in memory only. They expire in an hour, they are not worth
// persisting, and a token on disk is one more thing to leak.
let _googleAccessToken = null;

async function _googleAccessTokenFor() {
  if (_googleAccessToken && Date.now() < _googleAccessToken.expiresAt - 60000) {
    return _googleAccessToken.value;
  }
  const vault = _googleVault();
  if (!vault.refreshToken) throw new Error('Google Sheets is not connected.');
  const tokens = await _googleTokenRequest({
    client_id: vault.clientId,
    client_secret: vault.clientSecret || '',
    refresh_token: vault.refreshToken,
    grant_type: 'refresh_token',
  });
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('Google did not return a usable access token.');
  }
  const lifetime = Number.isFinite(tokens.expires_in) ? tokens.expires_in * 1000 : 3600000;
  _googleAccessToken = { value: tokens.access_token, expiresAt: Date.now() + lifetime };
  return _googleAccessToken.value;
}

async function _googleApiGet(host, requestPath, accessToken, limit) {
  const { statusCode, text } = await _googleHttp({
    method: 'GET',
    url: `https://${host}${requestPath}`,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    ...(limit ? { limit } : {}),
  });
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
  if (statusCode === 200 && parsed && typeof parsed === 'object') return parsed;
  const detail = parsed?.error?.message || `HTTP ${statusCode}`;
  const error = new Error(String(detail).slice(0, 300));
  error.statusCode = statusCode;
  throw error;
}

async function _googleAccountEmail(accessToken) {
  const info = await _googleApiGet('www.googleapis.com', '/oauth2/v2/userinfo', accessToken);
  return typeof info?.email === 'string' ? info.email.slice(0, 200) : null;
}

// A Google Sheets URL, or a bare spreadsheet id. Rejected rather than coerced:
// silently reading the wrong sheet is worse than saying "that is not a link".
function _googleSpreadsheetId(input) {
  const text = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{20,80}$/.test(text)) return text;
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,80})(?:\/|\?|$)/.exec(text);
  return match ? match[1] : null;
}

// ── Main-process credential vault and authenticated app session ──────────────
function _secretVaultPath() {
  return path.join(app.getPath('userData'), 'renderer-secrets-v1.bin');
}

function _loadSecretVault() {
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
  const vaultPath = _secretVaultPath();
  if (!fs.existsSync(vaultPath)) return {};
  const stat = fs.statSync(vaultPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('The protected credential vault is invalid.');
  const cleartext = safeStorage.decryptString(fs.readFileSync(vaultPath));
  const parsed = JSON.parse(cleartext);
  if (!_isPlainObject(parsed)) throw new Error('The protected credential vault is invalid.');
  return parsed;
}

function _saveSecretVault(vault) {
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
  const serialized = JSON.stringify(vault);
  if (Object.keys(vault).length > 128 || Buffer.byteLength(serialized, 'utf8') > 512 * 1024) {
    throw new Error('The protected credential vault exceeds its safety limit.');
  }
  const encrypted = safeStorage.encryptString(serialized);
  _atomicWriteFileSync(_secretVaultPath(), encrypted, 0o600);
}

const APP_PROFILE_ROLES = Object.freeze({
  'Elizabeth Chaves': 'Owner',
  'Carrie Gass': 'Operations & Events',
  'Ana Chaves': 'Front Desk',
  'Emma Minnetto': 'Front Desk',
});
const COMMUNICATION_ROLES = new Set(['Owner', 'Operations Manager', 'Operations & Events', 'Front Desk']);

// MB161-031: Operations Manager — a senior role below Owner.
//
// It can do the administrative work that used to require the owner: managing
// staff profiles, and connecting Google. What it deliberately CANNOT do is
// anything that touches the Owner: it cannot grant the Owner role (that is
// proved by the owner passcode, not assigned), it cannot remove or demote an
// Owner profile, and it has no access to the owner passcode, Firebase
// configuration, or the encrypted credential vault.
//
// Those exclusions are enforced here, in main, not in the renderer — the
// renderer can be wrong or worked around; this cannot.
const OPERATIONS_MANAGER_ROLES = new Set(['Owner', 'Operations Manager']);

// A profile the Owner may hand out. Owner is absent on purpose: it is proved by
// the owner passcode rather than assigned, so granting it would create a
// profile that cannot actually sign in.
function _requireNotOwnerTarget(target, action) {
  if (target?.role === 'Owner' && !_appSessionHasRole(new Set(['Owner']))) {
    throw new Error(`Only an Owner can ${action} an Owner profile.`);
  }
}

function _requireRemovableProfileTarget(target) {
  if (_appSessionHasRole(new Set(['Owner']))) return;
  if (!_appSessionHasRole(new Set(['Operations Manager']))) {
    throw new Error('Only an Owner or Operations Manager can remove profiles.');
  }
  if (target?.role === 'Owner' || target?.role === 'Operations Manager') {
    throw new Error('An Operations Manager cannot remove an Owner or Operations Manager profile.');
  }
}

function _appSessionHasRole(allowed) {
  try { return !!appSession && allowed.has(appSession.role); } catch (_) { return false; }
}
const OWNER_AUTH_VAULT_KEY = 'app_owner_auth_v1';
const STAFF_PROFILES_VAULT_KEY = 'app_staff_profiles_v1';
const OWNER_AUTH_ITERATIONS = 310000;
const OWNER_AUTH_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CUSTOM_STAFF_PROFILES = 50;

function _normalizeStaffProfileName(value) {
  if (typeof value !== 'string') throw new Error('Enter a staff name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80 ||
      /[\u0000-\u001F\u007F]/.test(name) ||
      !/^[\p{L}\p{M}\d .'-]+$/u.test(name)) {
    throw new Error('Staff names must be 2–80 characters and contain only letters, numbers, spaces, periods, apostrophes, or hyphens.');
  }
  if (name.toLocaleLowerCase('en-US') === 'team') {
    throw new Error('Team is reserved for shared task assignments.');
  }
  return name;
}

function _customStaffProfilesFromVault(vault) {
  const stored = vault[STAFF_PROFILES_VAULT_KEY];
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || stored.length > MAX_CUSTOM_STAFF_PROFILES) {
    throw new Error('The protected staff-profile list is invalid.');
  }
  // MB1188-060: a custom entry colliding with a BUILT-IN name is dropped, not
  // fatal. The built-in is authoritative, so there is nothing to preserve — and
  // throwing here is what bricked every sign-in on a Mac that had already been
  // poisoned before MB1188-060 closed the way in. A vault written by an older
  // build heals itself the first time this runs.
  const builtInNames = new Set(
    Object.keys(APP_PROFILE_ROLES).map(name => name.toLocaleLowerCase('en-US')));
  const seen = new Set();
  return stored.map(profile => {
    if (!_isPlainObject(profile) ||
        !Object.keys(profile).every(key => ['name', 'role', 'createdAt'].includes(key)) ||
        profile.role !== 'Front Desk' ||
        !Number.isSafeInteger(profile.createdAt) ||
        profile.createdAt <= 0) {
      throw new Error('The protected staff-profile list is invalid.');
    }
    const name = _normalizeStaffProfileName(profile.name);
    const folded = name.toLocaleLowerCase('en-US');
    if (builtInNames.has(folded)) return null;
    if (seen.has(folded)) throw new Error('The protected staff-profile list contains a duplicate name.');
    seen.add(folded);
    return { name, role: 'Front Desk', createdAt: profile.createdAt };
  }).filter(Boolean);
}

// Owner-managed overrides layered on top of the shipped defaults, so any profile
// — built-in included — can be re-roled or removed.
const PROFILE_ROLE_OVERRIDES_VAULT_KEY = 'app_profile_roles_v1';
const REMOVED_BUILTIN_PROFILES_VAULT_KEY = 'app_removed_builtins_v1';
// Custom profiles used to be removed by simply dropping them from the vault.
// The directory merge treats absence as "not seen", never as deletion, so the
// other Mac's copy put them straight back. Removals are now remembered.
const REMOVED_CUSTOM_PROFILES_VAULT_KEY = 'app_removed_custom_v1';

function _removedCustomProfiles(vault) {
  const stored = vault[REMOVED_CUSTOM_PROFILES_VAULT_KEY];
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(record => _isPlainObject(record) && _boundedString(record.name, 120))
    .slice(0, 200);
}
// Owner is deliberately NOT assignable: owner login is proved by the single
// owner passcode, and app-session-authenticate-owner resolves to the built-in
// owner identity. Granting Owner to another name would create a profile that
// cannot actually sign in.
const ASSIGNABLE_PROFILE_ROLES = Object.freeze(['Operations Manager', 'Operations & Events', 'Front Desk']);
// MB1188-073: how much authority a role carries, for comparison only. Owner is
// absent because it is never assignable — it is proved by the owner passcode.
// MB1188-081: Operations & Events outranks Front Desk.
//
// Giving them the same rank made a "non-elevating" import able to move somebody
// from Front Desk to Operations & Events laterally, which is a grant of access
// they did not have. Rank is about AUTHORITY, not about how the roles feel:
// anything that adds reach has to sit above what it adds reach to.
const PROFILE_ROLE_RANK = Object.freeze({
  'Front Desk': 1,
  'Operations & Events': 2,
  'Operations Manager': 3,
});

function _profileRoleOverrides(vault) {
  const stored = vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY];
  if (stored === undefined) return {};
  if (!_isPlainObject(stored)) {
    throw new Error('The protected profile-role list is invalid.');
  }
  for (const value of Object.values(stored)) {
    if (!ASSIGNABLE_PROFILE_ROLES.includes(value)) {
      throw new Error('The protected profile-role list is invalid.');
    }
  }
  // MB1188-062: a null-prototype copy, so a profile named `constructor` or
  // `toString` resolves to its real role instead of inheriting a function from
  // Object.prototype — which made the whole profile list uncloneable over IPC
  // and stopped the login screen rendering.
  return Object.assign(Object.create(null), stored);
}

function _removedBuiltInProfiles(vault) {
  const stored = vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY];
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || stored.length > 32 ||
      stored.some(name => !Object.prototype.hasOwnProperty.call(APP_PROFILE_ROLES, name))) {
    throw new Error('The protected removed-profile list is invalid.');
  }
  return stored;
}

// MB1188-062: re-read immediately before writing.
//
// Both owner-passcode paths held a vault snapshot across two PBKDF2 rounds
// (~300-600ms) and then wrote the stale copy back, silently reverting anything
// saved in that window — a refreshed Microsoft token, for instance, which would
// disconnect the mailbox with no error. _saveMsTokenResult already re-reads for
// exactly this reason.
function _persistOwnerAuthRecord(record) {
  const fresh = _loadSecretVault();
  fresh[OWNER_AUTH_VAULT_KEY] = record;
  _saveSecretVault(fresh);
}

function _allAppProfiles() {
  const vault = _loadSecretVault();
  const overrides = _profileRoleOverrides(vault);
  const removed = new Set(_removedBuiltInProfiles(vault));
  const builtIn = Object.entries(APP_PROFILE_ROLES)
    .filter(([name]) => !removed.has(name))
    .map(([name, role]) => ({
      name,
      role: overrides[name] || role,
      builtIn: true,
    }));
  const custom = _customStaffProfilesFromVault(vault).map(profile => ({
    name: profile.name,
    role: overrides[profile.name] || 'Front Desk',
    builtIn: false,
  }));
  return [...builtIn, ...custom];
}

// Names are compared case- and spacing-insensitively everywhere (duplicate
// detection on add already folds this way), so lookups must too.
function _findProfileByFoldedName(profiles, name) {
  const folded = String(name).toLocaleLowerCase('en-US');
  return profiles.find(
    profile => profile.name.toLocaleLowerCase('en-US') === folded
  ) || null;
}

// At least one Owner must always remain, otherwise nobody can administer the
// app — no profile management, no Firebase configuration, no passcode rotation.
function _ownerProfileCount(profiles) {
  return profiles.filter(profile => profile.role === 'Owner').length;
}

function _roleForAppProfile(name) {
  if (typeof name !== 'string') return null;
  // Resolve through _allAppProfiles() so overrides and removals apply uniformly
  // — a removed built-in must not keep resolving to its shipped role.
  const profile = _allAppProfiles().find(entry => entry.name === name);
  return profile ? profile.role : null;
}

function _resetAppSession() {
  appSession = null;
  firebaseRuntimeSecretIssued = false;
  pendingOAuth = null;
  _closeOAuthServer();
}

function _setAppSession(name, role) {
  firebaseRuntimeSecretIssued = false;
  appSession = {
    name,
    role,
    webContentsId: mainWindow?.webContents?.id ?? null,
    expiresAt: Date.now() + APP_SESSION_TTL_MS,
  };
  return { ok: true, name, role, expiresAt: appSession.expiresAt };
}

function _requireAppRole(allowedRoles) {
  if (!appSession || Date.now() >= appSession.expiresAt ||
      !mainWindow || mainWindow.isDestroyed() ||
      appSession.webContentsId !== mainWindow.webContents.id) {
    _resetAppSession();
    throw new Error('Sign in to Music Box before using this feature.');
  }
  if (!allowedRoles.has(appSession.role)) {
    throw new Error('This signed-in profile is not authorized for that action.');
  }
  appSession.expiresAt = Date.now() + APP_SESSION_TTL_MS;
  return appSession;
}

function _validOwnerPin(pin, allowLegacy = true) {
  return typeof pin === 'string' &&
    (allowLegacy ? /^\d{4,6}$/.test(pin) : /^\d{6}$/.test(pin));
}

function _deriveOwnerVerifier(pin, salt, iterations = OWNER_AUTH_ITERATIONS) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(pin, salt, iterations, 32, 'sha256', (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function _validOwnerVerifier(value) {
  return _isPlainObject(value) &&
    Number.isSafeInteger(value.iterations) &&
    value.iterations >= OWNER_AUTH_ITERATIONS && value.iterations <= 2000000 &&
    typeof value.salt === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.salt) &&
    Buffer.from(value.salt, 'base64').length === 16 &&
    typeof value.verifier === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.verifier) &&
    Buffer.from(value.verifier, 'base64').length === 32;
}

async function _buildOwnerVerifier(pin) {
  const salt = crypto.randomBytes(16);
  const verifier = await _deriveOwnerVerifier(pin, salt);
  return {
    iterations: OWNER_AUTH_ITERATIONS,
    salt: salt.toString('base64'),
    verifier: verifier.toString('base64'),
  };
}

async function _ownerPinMatches(pin, record) {
  if (!_validOwnerPin(pin) || !_validOwnerVerifier(record)) return false;
  const expected = Buffer.from(record.verifier, 'base64');
  const actual = await _deriveOwnerVerifier(
    pin,
    Buffer.from(record.salt, 'base64'),
    record.iterations,
  );
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function _ownerAuthRecord(vault) {
  const record = vault[OWNER_AUTH_VAULT_KEY];
  if (record === undefined) return null;
  if (!_isPlainObject(record) || record.version !== 1 || !_validOwnerVerifier(record.active)) {
    throw new Error('The protected owner-authentication record is invalid.');
  }
  if (record.pending !== undefined && record.pending !== null &&
      (!_isPlainObject(record.pending) ||
       !_boundedString(record.pending.rotationId, 128) ||
       !Number.isSafeInteger(record.pending.createdAt) ||
       !_validOwnerVerifier(record.pending.verifier))) {
    throw new Error('The protected owner-authentication record is invalid.');
  }
  return record;
}

// ── MB1188-069: an optional passcode for Operations Managers ───────────────
//
// Deliberately narrow. It is OPT-IN — an Operations Manager who has not set one
// signs in exactly as before, so nobody can be locked out by this existing. It
// applies to the Operations Manager role ONLY: Operations & Events and Step Up
// stay passwordless by product rule, Front Desk is unchanged, and the Owner has
// its own passcode which also wraps that Mac's data key.
//
// The verifier travels in the SYNCED store so both Macs enforce it, but main is
// the authority: the vault holds the copy that start-staff checks, and the
// renderer can only deliver updates into it. Records carry a version so a
// clear made on one Mac propagates to the other without a stale copy putting
// the passcode back.
//
// Only ever the PBKDF2 verifier — the passcode itself is never stored, synced,
// or written anywhere.
const STAFF_AUTH_VAULT_KEY = 'app_staff_auth_v1';
const STAFF_AUTH_ROLE = 'Operations Manager';
// Named rather than written out at the call site: three hand-written copies of
// a role list have already gone stale in this file (MB161-045).
const STAFF_PASSCODE_ROLES = new Set([STAFF_AUTH_ROLE]);
// A record's version only ever increments by one per change, so a real one will
// never approach this. It exists so a record cannot be PINNED at the top of the
// integer range: at MAX_SAFE_INTEGER the next `version + 1` stops being a safe
// integer, which would make every future set and clear invalid — and the vault
// unreadable with it.
const MAX_STAFF_AUTH_VERSION = 1000000000;
// MB1188-075: the lockout has to survive a relaunch.
//
// Five wrong attempts correctly start a five-minute lock, but as process memory
// it was erased by quitting the app — which anybody guessing would do on the
// sixth try. Persisted in the protected vault, which is main-owned and local:
// it deliberately does NOT sync, because a lockout is about one keyboard.
const STAFF_AUTH_LOCKOUT_VAULT_KEY = 'app_staff_auth_lockout_v1';
const MAX_STAFF_LOCKOUT_MS = 24 * 60 * 60 * 1000;
const staffAuthFailures = new Map();
const staffAuthLockedUntil = new Map();

// Malformed or absurd values are dropped rather than trusted: a corrupt record
// must not be able to lock somebody out for a thousand years.
function _loadStaffAuthLockouts() {
  if (staffAuthFailures.size || staffAuthLockedUntil.size) return;
  let stored;
  try { stored = _loadSecretVault()[STAFF_AUTH_LOCKOUT_VAULT_KEY]; } catch (_) { return; }
  if (!_isPlainObject(stored)) return;
  const now = Date.now();
  for (const [name, record] of Object.entries(stored)) {
    if (!_boundedString(name, 120) || !_isPlainObject(record)) continue;
    const failures = Number.isSafeInteger(record.failures) ? record.failures : 0;
    const until = Number.isSafeInteger(record.until) ? record.until : 0;
    if (failures > 0 && failures < 1000) staffAuthFailures.set(name, failures);
    // A time in the past has expired; one absurdly far ahead is a corrupt or
    // clock-skewed record and is ignored rather than honoured.
    if (until > now && until - now <= MAX_STAFF_LOCKOUT_MS) staffAuthLockedUntil.set(name, until);
  }
}

function _saveStaffAuthLockouts() {
  const record = {};
  const now = Date.now();
  for (const [name, failures] of staffAuthFailures) {
    const until = staffAuthLockedUntil.get(name) || 0;
    if (failures > 0 || until > now) record[name] = { failures, until };
  }
  try {
    const vault = _loadSecretVault();
    if (Object.keys(record).length) vault[STAFF_AUTH_LOCKOUT_VAULT_KEY] = record;
    else delete vault[STAFF_AUTH_LOCKOUT_VAULT_KEY];
    _saveSecretVault(vault);
  } catch (error) {
    // Never fatal: a lockout that cannot be written is a weaker lockout, not a
    // reason to refuse a sign-in that is otherwise correct.
    console.warn('[staff-auth] lockout state was not persisted:', error?.message || error);
  }
}

function _validStaffPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

function _staffAuthName(name) {
  return _normalizeStaffProfileName(name).toLocaleLowerCase('en-US');
}

function _validStaffAuthRecord(value) {
  if (!_isPlainObject(value)) return false;
  if (!Number.isSafeInteger(value.version) ||
      value.version < 1 || value.version > MAX_STAFF_AUTH_VERSION) return false;
  if (value.cleared === true) return value.active === undefined || value.active === null;
  return _validOwnerVerifier(value.active);
}

// MB1188-069: a malformed entry is DROPPED, not fatal.
//
// This is the same lesson MB1188-060 learned one screen down in
// _customStaffProfilesFromVault: throwing here does not protect anything, it
// just takes the Mac down. start-staff reads this list, so a single bad record
// — belonging to somebody else entirely — meant no Operations Manager could
// sign in on that Mac ever again, with no way to clear it from inside the app.
//
// Dropping cannot weaken a passcode that is actually set: a VALID record is
// still enforced. It only discards entries that were already unusable, and the
// next set or clear writes the cleaned list back, so the vault heals itself.
function _staffAuthRecords(vault) {
  const stored = vault[STAFF_AUTH_VAULT_KEY];
  if (stored === undefined) return Object.create(null);
  const records = Object.create(null);
  if (!_isPlainObject(stored)) {
    console.warn('[staff-auth] the stored passcode list was not an object; ignoring it');
    return records;
  }
  let dropped = 0;
  for (const [name, record] of Object.entries(stored)) {
    if (!_boundedString(name, 120) || !_validStaffAuthRecord(record)) { dropped += 1; continue; }
    records[name] = record;
  }
  if (dropped) console.warn(`[staff-auth] ignored ${dropped} unusable passcode record(s)`);
  return records;
}

// A record only counts while the profile still HOLDS the role. Demoting someone
// must not leave them standing at a passcode prompt they can no longer change.
function _activeStaffAuthRecord(vault, name) {
  if (_roleForAppProfile(name) !== STAFF_AUTH_ROLE) return null;
  const record = _staffAuthRecords(vault)[_staffAuthName(name)];
  if (!record || record.cleared === true) return null;
  return record;
}

// MB1188-069: which of two records for the same profile survives. The renderer
// runs the identical rule when it merges the synced key (_mergeVersionedRecordMaps);
// if the two ever disagree the Macs stop converging, so keep them in step.
// Higher version wins; on a tie a removal beats a set, because a passcode
// nobody chose is a lockout and an absent one is a second's work to restore.
function _incomingStaffAuthRecordWins(incoming, held) {
  if (!held) return true;
  const heldVersion = Number.isSafeInteger(held.version) ? held.version : 0;
  if (incoming.version !== heldVersion) return incoming.version > heldVersion;
  const incomingCleared = incoming.cleared === true;
  const heldCleared = held.cleared === true;
  if (incomingCleared !== heldCleared) return incomingCleared;
  return JSON.stringify(incoming) > JSON.stringify(held);
}

function _recordStaffAuthFailure(key) {
  const failures = (staffAuthFailures.get(key) || 0) + 1;
  staffAuthFailures.set(key, failures);
  if (failures >= 5) {
    staffAuthLockedUntil.set(key, Date.now() + (failures >= 10 ? 30 * 60 * 1000 : 5 * 60 * 1000));
  }
  _saveStaffAuthLockouts();
}

function _clearStaffAuthFailures(key) {
  staffAuthFailures.delete(key);
  staffAuthLockedUntil.delete(key);
  _saveStaffAuthLockouts();
}

function _recordOwnerAuthFailure() {
  ownerAuthFailures += 1;
  if (ownerAuthFailures >= 5) {
    const delay = ownerAuthFailures >= 10 ? 30 * 60 * 1000 : 5 * 60 * 1000;
    ownerAuthLockedUntil = Date.now() + delay;
  }
}



_secureHandle('app-session-authenticate-owner', async (_, pin) => {
  if (!_validOwnerPin(pin)) throw new Error('Enter the owner passcode.');
  if (Date.now() < ownerAuthLockedUntil) {
    throw new Error('Too many owner-authentication attempts. Try again later.');
  }
  const vault = _loadSecretVault();
  let record = _ownerAuthRecord(vault);

  // Trust-on-first-use (TOFU) upgrade bootstrap: the legacy renderer verifies
  // its existing PIN before this call, but main cannot retroactively prove that
  // old renderer state. This is defense-in-depth for subsequent sessions, not a
  // new cryptographic boundary against a renderer already compromised at first
  // launch after upgrade.
  if (!record) {
    record = { version: 1, active: await _buildOwnerVerifier(pin), pending: null };
    _persistOwnerAuthRecord(record);
  } else {
    let matched = await _ownerPinMatches(pin, record.active);
    if (!matched && record.pending &&
        Date.now() - record.pending.createdAt <= OWNER_AUTH_PENDING_MAX_AGE_MS &&
        await _ownerPinMatches(pin, record.pending.verifier)) {
      record.active = record.pending.verifier;
      record.pending = null;
      _persistOwnerAuthRecord(record);
      matched = true;
    }
    if (!matched) {
      _recordOwnerAuthFailure();
      throw new Error('The owner passcode did not match the protected app session.');
    }
  }

  ownerAuthFailures = 0;
  ownerAuthLockedUntil = 0;
  return _setAppSession('Elizabeth Chaves', APP_PROFILE_ROLES['Elizabeth Chaves']);
});

_secureHandle('app-session-start-staff', async (_, request) => {
  // MB1188-069: still accepts a bare name. A profile with no passcode signs in
  // exactly as it always did.
  const requested = _isPlainObject(request) ? request.name : request;
  const pin = _isPlainObject(request) ? request.pin : null;
  const role = _roleForAppProfile(requested);
  if (!role || role === 'Owner') throw new Error('Unknown staff profile.');
  const vault = _loadSecretVault();
  const record = _activeStaffAuthRecord(vault, requested);
  if (record) {
    _loadStaffAuthLockouts();
    const key = _staffAuthName(requested);
    const lockedUntil = staffAuthLockedUntil.get(key) || 0;
    if (Date.now() < lockedUntil) {
      const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
      throw new Error(`Too many passcode attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    if (!_validStaffPin(pin)) throw new Error('Enter your 4-digit passcode.');
    if (!await _ownerPinMatches(pin, record.active)) {
      _recordStaffAuthFailure(key);
      throw new Error('That passcode did not match.');
    }
    _clearStaffAuthFailures(key);
  }
  return _setAppSession(_normalizeStaffProfileName(requested), role);
});

// Which profiles are passcode-protected. Ungated on purpose: the login screen
// has to know before any session exists, and it reveals only what that screen
// already shows — never a verifier, a salt or an iteration count.
_secureHandle('app-session-staff-passcode-status', async () => {
  // One decrypt, not one per profile: this runs on every paint of the login
  // screen and _loadSecretVault reads and decrypts the file each call.
  const vault = _loadSecretVault();
  return {
    ok: true,
    protectedProfiles: _allAppProfiles()
      .filter(profile => _activeStaffAuthRecord(vault, profile.name))
      .map(profile => profile.name),
  };
});

// Set or change your OWN passcode. Never somebody else's — an owner who needs
// to help resets it with the clear handler below, which cannot set a new one.
_secureHandle('app-session-set-staff-passcode', async (_, request) => {
  _requireAppRole(STAFF_PASSCODE_ROLES);
  if (!_isPlainObject(request)) throw new Error('Invalid passcode change.');
  const name = _normalizeStaffProfileName(appSession.name);
  if (_roleForAppProfile(name) !== STAFF_AUTH_ROLE) {
    throw new Error('Only an Operations Manager can set a passcode.');
  }
  if (!_validStaffPin(request.newPin)) {
    throw new Error('Choose a 4-digit passcode.');
  }
  const vault = _loadSecretVault();
  const existing = _activeStaffAuthRecord(vault, name);
  if (existing && !await _ownerPinMatches(request.currentPin, existing.active)) {
    throw new Error('Your current passcode did not match.');
  }
  const records = _staffAuthRecords(vault);
  const key = _staffAuthName(name);
  const previous = records[key];
  const record = {
    version: (Number.isSafeInteger(previous?.version) ? previous.version : 0) + 1,
    active: await _buildOwnerVerifier(request.newPin),
  };
  // Fail before saving, not after. A record this handler refuses to read back
  // would be dropped on the next load, silently leaving the passcode unset
  // while the person believes they have one.
  if (!_validStaffAuthRecord(record)) {
    throw new Error('This passcode could not be saved. Ask the owner to remove your current one, then set a new one.');
  }
  records[key] = record;
  const fresh = _loadSecretVault();
  fresh[STAFF_AUTH_VAULT_KEY] = { ...records };
  _saveSecretVault(fresh);
  _clearStaffAuthFailures(key);
  // Handed back so the renderer can put it in the synced store. The passcode
  // itself never leaves the keypad.
  return { ok: true, name, record };
});

// Remove a passcode: your own with the current one, or the owner clearing it
// for somebody who has forgotten theirs. The owner cannot CHOOSE a passcode,
// only remove it, so nobody else can ever know what it is.
_secureHandle('app-session-clear-staff-passcode', async (_, request) => {
  _requireAppRole(COMMUNICATION_ROLES);
  const wanted = _isPlainObject(request) ? request.name : request;
  const name = _normalizeStaffProfileName(wanted);
  const isOwner = _appSessionHasRole(new Set(['Owner']));
  const isSelf = appSession && _staffAuthName(appSession.name) === _staffAuthName(name);
  if (!isOwner && !isSelf) {
    throw new Error('Only the owner can remove somebody else\'s passcode.');
  }
  const vault = _loadSecretVault();
  const records = _staffAuthRecords(vault);
  const key = _staffAuthName(name);
  const existing = records[key];
  if (!existing || existing.cleared === true) return { ok: true, name, record: null };
  if (!isOwner && !await _ownerPinMatches(
    _isPlainObject(request) ? request.currentPin : null, existing.active)) {
    throw new Error('Your current passcode did not match.');
  }
  // A TOMBSTONE, not a deletion: the other Mac still holds the old record, and
  // absence would let it put the passcode straight back on the next sync.
  // Clamped, never refused. Removing a passcode is the escape hatch for the
  // whole feature, so it has to work even from a record sitting at the ceiling:
  // a tombstone AT the ceiling still beats everything at or below it, and beats
  // a set at the same version by the tie-break both Macs share.
  const record = { version: Math.min(existing.version + 1, MAX_STAFF_AUTH_VERSION), cleared: true };
  records[key] = record;
  const fresh = _loadSecretVault();
  fresh[STAFF_AUTH_VAULT_KEY] = { ...records };
  _saveSecretVault(fresh);
  _clearStaffAuthFailures(key);
  return { ok: true, name, record };
});

// The renderer delivers what the synced store holds. Merged by version, so the
// newer decision wins whichever Mac made it and a stale copy can never restore
// a passcode that was removed.
_secureHandle('app-session-apply-staff-passcodes', async (_, incoming) => {
  // COMMUNICATION_ROLES is every role main defines, so this reads as "any
  // signed-in session" — which is exactly the requirement. Sync only runs after
  // sign-in, so nothing legitimate is turned away, and the login screen, which
  // holds no session, can no longer post a tombstone that would strip a
  // passcode before anybody has proved who they are.
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_isPlainObject(incoming)) return { ok: true, applied: 0 };
  const vault = _loadSecretVault();
  const records = _staffAuthRecords(vault);
  let applied = 0;
  for (const [rawName, record] of Object.entries(incoming)) {
    if (!_boundedString(rawName, 120) || !_validStaffAuthRecord(record)) continue;
    const key = String(rawName).toLocaleLowerCase('en-US');
    if (!_incomingStaffAuthRecordWins(record, records[key])) continue;
    records[key] = record;
    applied += 1;
  }
  if (applied) {
    vault[STAFF_AUTH_VAULT_KEY] = { ...records };
    _saveSecretVault(vault);
  }
  return { ok: true, applied };
});

_secureHandle('app-session-list-profiles', async () => ({
  ok: true,
  profiles: _allAppProfiles(),
}));

_secureHandle('app-session-add-staff-profile', async (_, requestedName) => {
  const name = _normalizeStaffProfileName(requestedName);
  const vault = _loadSecretVault();
  const profiles = _customStaffProfilesFromVault(vault);
  const folded = name.toLocaleLowerCase('en-US');
  const duplicate = _allAppProfiles().some(profile =>
    profile.name.toLocaleLowerCase('en-US') === folded
  );
  if (duplicate) throw new Error('A user with that name already exists.');

  // MB1188-060: a name that belongs to a REMOVED built-in restores the built-in
  // rather than creating a custom profile beside it.
  //
  // The duplicate check above reads _allAppProfiles(), which excludes removed
  // built-ins — so "Ana Chaves" sailed through after Ana had been removed. But
  // _customStaffProfilesFromVault seeds its duplicate set from EVERY built-in
  // name including removed ones, so the next read of the vault threw. That is
  // list-profiles, start-staff, add, remove and export-directory: every staff
  // sign-in on this Mac failed, and the renderer swallowed the error and went
  // on drawing login buttons that could not work. Two ordinary clicks weeks
  // apart — somebody removes a departed built-in, somebody later types that
  // name into Add user — and the Mac stopped letting anyone in.
  //
  // Restored at Front Desk, not at the built-in's shipped role: this channel
  // has no session gate, so it may lower privilege but must never grant it.
  // The owner can re-role afterwards through the gated channel.
  const suppressedBuiltIn = Object.keys(APP_PROFILE_ROLES).find(
    builtInName => builtInName.toLocaleLowerCase('en-US') === folded
  );
  if (suppressedBuiltIn) {
    const stillRemoved = _removedBuiltInProfiles(vault)
      .filter(entry => entry !== suppressedBuiltIn);
    if (stillRemoved.length) vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY] = stillRemoved;
    else delete vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY];
    if (APP_PROFILE_ROLES[suppressedBuiltIn] !== 'Front Desk') {
      const roles = { ..._profileRoleOverrides(vault) };
      roles[suppressedBuiltIn] = 'Front Desk';
      vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY] = roles;
    }
    const builtInMeta = _directoryMeta(vault);
    delete builtInMeta[_directoryEntryId(suppressedBuiltIn)];
    vault[DIRECTORY_META_VAULT_KEY] = builtInMeta;
    _saveSecretVault(vault);
    return { ok: true, profile: { name: suppressedBuiltIn, role: 'Front Desk', builtIn: true } };
  }
  if (profiles.length >= MAX_CUSTOM_STAFF_PROFILES) {
    throw new Error(`This Mac already has the maximum of ${MAX_CUSTOM_STAFF_PROFILES} added users.`);
  }
  profiles.push({ name, role: 'Front Desk', createdAt: Date.now() });
  vault[STAFF_PROFILES_VAULT_KEY] = profiles;
  // Re-adding a name that was removed before must clear its tombstone, or the
  // directory would publish the new profile and its own deletion together.
  const clearedTombstones = _removedCustomProfiles(vault)
    .filter(record => record.name.toLocaleLowerCase('en-US') !== folded);
  if (clearedTombstones.length) vault[REMOVED_CUSTOM_PROFILES_VAULT_KEY] = clearedTombstones;
  else delete vault[REMOVED_CUSTOM_PROFILES_VAULT_KEY];
  // The id is reused, so its causality must restart rather than inherit the
  // version the deleted profile ended on.
  const meta = _directoryMeta(vault);
  delete meta[_directoryEntryId(name)];
  vault[DIRECTORY_META_VAULT_KEY] = meta;
  _saveSecretVault(vault);
  return { ok: true, profile: { name, role: 'Front Desk', builtIn: false } };
});

// Owner-only removal of an added Front Desk profile.
//
// Deliberate constraints:
//  - built-in profiles are structural and cannot be removed;
//  - the signed-in profile cannot delete itself out from under the session;
//  - task history is NOT touched. Assigned tasks reference a display name, and
//    deleting the records would destroy studio history rather than a login.
_secureHandle('app-session-remove-staff-profile', async (_, requestedName) => {
  _requireAppRole(OPERATIONS_MANAGER_ROLES);
  const name = _normalizeStaffProfileName(requestedName);
  if (appSession && appSession.name === name) {
    throw new Error('You cannot remove the profile that is currently signed in.');
  }
  const existing = _allAppProfiles();
  // Case- and spacing-insensitive, matching how names are compared everywhere
  // else (duplicate detection on add uses the same folding).
  const target = _findProfileByFoldedName(existing, name);
  if (!target) throw new Error('That user was not found on this Mac.');
  // Operations Manager is removal-only and cannot target either protected
  // tier. This check is main-process authoritative; renderer visibility is
  // only presentation.
  _requireRemovableProfileTarget(target);
  // Removing the last Owner would leave nobody able to administer the app.
  if (target.role === 'Owner' && _ownerProfileCount(existing) <= 1) {
    throw new Error('The last Owner profile cannot be removed.');
  }

  const vault = _loadSecretVault();
  const canonical = target.name;
  const folded = canonical.toLocaleLowerCase('en-US');
  if (target.builtIn) {
    // Built-ins live in code, so removal is recorded as a suppression list.
    const removed = _removedBuiltInProfiles(vault);
    if (!removed.includes(canonical)) {
      vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY] = [...removed, canonical];
    }
  } else {
    const profiles = _customStaffProfilesFromVault(vault);
    const remaining = profiles.filter(
      profile => profile.name.toLocaleLowerCase('en-US') !== folded
    );
    if (remaining.length) vault[STAFF_PROFILES_VAULT_KEY] = remaining;
    else delete vault[STAFF_PROFILES_VAULT_KEY];
    // Record the removal so it can be published as a tombstone. Without this
    // the other Mac reads absence as "never heard of it" and reintroduces the
    // profile from its own stale copy.
    const removedCustom = _removedCustomProfiles(vault)
      .filter(record => record.name.toLocaleLowerCase('en-US') !== folded);
    vault[REMOVED_CUSTOM_PROFILES_VAULT_KEY] = [
      ...removedCustom,
      { name: canonical, at: new Date().toISOString() },
    ].slice(-200);
  }

  // A removed profile keeps no role override behind it.
  const overrides = _profileRoleOverrides(vault);
  if (Object.prototype.hasOwnProperty.call(overrides, canonical)) {
    const nextRoles = { ...overrides };
    delete nextRoles[canonical];
    if (Object.keys(nextRoles).length) vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY] = nextRoles;
    else delete vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY];
  }

  _saveSecretVault(vault);
  // Count from the freshly resolved list: `remaining` only exists on the custom
  // branch, and built-in removals are recorded as a suppression list instead.
  return {
    ok: true,
    name: canonical,
    remaining: _allAppProfiles().length,
    directory: _buildStaffDirectory(),
  };
});

// ─── V159-005: synchronized staff directory ─────────────────────────────────
//
// Profiles live in each Mac's safeStorage vault, so adds, removals and role
// changes never reached a second machine. This publishes the owner's profile
// configuration as an ordinary synchronized dataset and imports it elsewhere.
//
// Trust direction matters: main stays authoritative. The renderer transports
// the directory but cannot decide roles — every field is re-validated here, and
// Owner can never be granted through an imported record. Otherwise a tampered
// renderer could promote itself simply by publishing a directory entry.
// MB1188-052: big enough that a real directory can never reach it.
//
// This was `+ 16`, which sounds generous and is not: the document also carries
// a removal TOMBSTONE for every profile ever deleted, bounded at 200, so about
// 62 lifetime removals made every other Mac refuse the whole thing. The
// tombstone trim in _buildStaffDirectory bounds the document either way, but a
// trim is not free — dropping a removal record means the id appears on one side
// only at the next CAS rebase, and _mergeTombstonedRecordLists reads presence
// on one side as creation, so a deleted profile comes back. Sizing the ceiling
// to the real worst case turns the trim into a backstop that never fires.
//
// Worst case: 4 built-in profiles + 50 custom + 4 built-in removals + 200
// custom removals. Measured at 33 KB — 5% of the 600 KB sync budget.
const MAX_DIRECTORY_ENTRIES =
  Object.keys(APP_PROFILE_ROLES).length * 2 + MAX_CUSTOM_STAFF_PROFILES + 200;

function _directoryEntryId(name) {
  return 'profile:' + name.toLocaleLowerCase('en-US');
}

// Snapshot of this Mac's profile configuration, shaped as a tombstoned record
// list so it merges with the same rules as logs.
// Per-entry causality. Every entry used to publish as version 1 with a fresh
// timestamp, so the merge had nothing to reason about: an unchanged republish
// manufactured conflicts purely because `updated` moved, and a genuine role
// change could lose to stale data because both sides looked equally recent.
// The version now advances only when the entry's content actually changes, and
// `updated` holds still otherwise.
const DIRECTORY_META_VAULT_KEY = 'app_directory_meta_v1';

function _directoryMeta(vault) {
  const stored = vault[DIRECTORY_META_VAULT_KEY];
  return _isPlainObject(stored) ? stored : {};
}

function _directoryEntryDigest(entry) {
  return [entry.name, entry.role, entry.builtIn === true, entry._deleted === true].join(' ');
}

function _stampDirectoryEntry(entry, meta, now) {
  const previous = _isPlainObject(meta[entry.id]) ? meta[entry.id] : null;
  const digest = _directoryEntryDigest(entry);
  if (previous && previous.digest === digest &&
      Number.isSafeInteger(previous.version) && previous.version >= 1 &&
      typeof previous.updated === 'string') {
    entry.version = previous.version;
    entry.updated = previous.updated;
    return meta;
  }
  const version = previous && Number.isSafeInteger(previous.version) ? previous.version + 1 : 1;
  entry.version = version;
  entry.updated = now;
  meta[entry.id] = { digest, version, updated: now };
  return meta;
}

function _buildStaffDirectory() {
  const vault = _loadSecretVault();
  const removedBuiltIns = _removedBuiltInProfiles(vault);
  const removedCustom = _removedCustomProfiles(vault);
  const now = new Date().toISOString();
  const meta = _directoryMeta(vault);

  let entries = _allAppProfiles().map(profile => ({
    id: _directoryEntryId(profile.name),
    name: profile.name,
    role: profile.role,
    builtIn: profile.builtIn === true,
  }));
  // Removals travel as tombstones so other Macs apply them. Absence is not a
  // deletion to the merge — it reads as "this Mac simply has not heard of it" —
  // so a custom profile removed here was being reintroduced by the stale copy
  // still held in the cloud and on the other Mac.
  for (const name of removedBuiltIns) {
    entries.push({
      id: _directoryEntryId(name), name,
      role: APP_PROFILE_ROLES[name] || 'Front Desk',
      builtIn: true, _deleted: true, _deletedAt: now,
    });
  }
  for (const record of removedCustom) {
    entries.push({
      id: _directoryEntryId(record.name), name: record.name,
      role: 'Front Desk', builtIn: false,
      _deleted: true, _deletedAt: record.at || now,
    });
  }

  // MB1188-052: the document this Mac publishes can never exceed what the
  // receiving Mac will accept.
  //
  // _applyStaffDirectory throws on more than MAX_DIRECTORY_ENTRIES and nothing
  // bounded what is emitted here, so enough lifetime removals made every other
  // Mac refuse the whole directory — silently, because the refusal is swallowed
  // and the sync badge stays green. Since MB1188-047 that refusal also blocks
  // publishing, turning a stale list into a permanent studio-wide lockout whose
  // only message blames the connection.
  //
  // Live profiles are never dropped: they ARE the directory. Tombstones are
  // bookkeeping, and the oldest go first — one older than every peer's last
  // sync has already done its work, and losing it costs far less than refusing
  // the document.
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    const liveEntries = entries.filter(entry => entry._deleted !== true);
    const graves = entries
      .filter(entry => entry._deleted === true)
      .sort((a, b) => String(b._deletedAt || '').localeCompare(String(a._deletedAt || '')));
    entries = [...liveEntries, ...graves.slice(0, Math.max(0, MAX_DIRECTORY_ENTRIES - liveEntries.length))];
  }

  const live = new Set(entries.map(entry => entry.id));
  for (const entry of entries) _stampDirectoryEntry(entry, meta, now);
  // Forget bookkeeping for ids this Mac no longer publishes at all.
  for (const id of Object.keys(meta)) if (!live.has(id)) delete meta[id];
  vault[DIRECTORY_META_VAULT_KEY] = meta;
  _saveSecretVault(vault);

  return entries;
}

function _validDirectoryEntry(entry) {
  if (!_isPlainObject(entry)) return false;
  if (typeof entry.name !== 'string') return false;
  if (entry.role !== 'Owner' && !ASSIGNABLE_PROFILE_ROLES.includes(entry.role)) return false;
  return true;
}

// A receiving Mac can be sitting at the profile picker when another Mac adds a
// user. Requiring an existing profile to sign in before the picker can refresh
// creates a catch-22 for the new person. This deliberately narrow importer is
// callable before an app session exists, and therefore may only make a login
// less privileged: it adds missing profiles as Front Desk. Removals and role
// changes are reported as deferred and remain on the authenticated importer.
function _applyLoginDirectoryAdditions(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new Error('The staff directory is invalid.');
  }

  const vault = _loadSecretVault();
  const currentProfiles = _allAppProfiles();
  const currentByName = new Map(currentProfiles.map(profile => [
    profile.name.toLocaleLowerCase('en-US'), profile,
  ]));
  const builtInByName = new Map(Object.keys(APP_PROFILE_ROLES).map(name => [
    name.toLocaleLowerCase('en-US'), name,
  ]));
  const custom = _customStaffProfilesFromVault(vault);
  let removedBuiltIns = _removedBuiltInProfiles(vault);
  let removedCustom = _removedCustomProfiles(vault);
  const overrides = { ..._profileRoleOverrides(vault) };
  const meta = { ..._directoryMeta(vault) };
  const added = [];
  const deferred = [];
  const deferredKeys = new Set();
  let changed = false;

  const defer = (name, reason) => {
    const key = `${name.toLocaleLowerCase('en-US')}\0${reason}`;
    if (deferredKeys.has(key)) return;
    deferredKeys.add(key);
    deferred.push({ name, reason });
  };

  for (const raw of entries) {
    if (!_validDirectoryEntry(raw)) continue;
    let requestedName;
    try { requestedName = _normalizeStaffProfileName(raw.name); } catch { continue; }
    const folded = requestedName.toLocaleLowerCase('en-US');
    const builtInName = builtInByName.get(folded) || null;
    const canonicalName = builtInName || requestedName;
    const held = currentByName.get(folded) || null;

    if (raw._deleted === true) {
      if (held && held.role !== 'Owner') defer(held.name, 'removal');
      continue;
    }

    const requestedRole = raw.role === 'Owner'
      ? (builtInName && APP_PROFILE_ROLES[builtInName] === 'Owner' ? 'Owner' : 'Front Desk')
      : (ASSIGNABLE_PROFILE_ROLES.includes(raw.role) ? raw.role : 'Front Desk');

    if (held) {
      if (requestedRole !== held.role && held.role !== 'Owner') defer(held.name, 'role');
      continue;
    }

    if (builtInName) {
      // Owner is structural and is never absent from a valid local vault.
      if (APP_PROFILE_ROLES[builtInName] === 'Owner') continue;
      const nextRemoved = removedBuiltIns.filter(name => name !== builtInName);
      if (nextRemoved.length === removedBuiltIns.length) continue;
      removedBuiltIns = nextRemoved;
      if (APP_PROFILE_ROLES[builtInName] === 'Front Desk') delete overrides[builtInName];
      else overrides[builtInName] = 'Front Desk';
      delete meta[_directoryEntryId(builtInName)];
      currentByName.set(folded, { name: builtInName, role: 'Front Desk', builtIn: true });
      added.push(builtInName);
      changed = true;
      if (requestedRole !== 'Front Desk') defer(builtInName, 'role');
      continue;
    }

    if (custom.length >= MAX_CUSTOM_STAFF_PROFILES) {
      defer(canonicalName, 'capacity');
      continue;
    }
    custom.push({ name: canonicalName, role: 'Front Desk', createdAt: Date.now() });
    removedCustom = removedCustom.filter(
      record => record.name.toLocaleLowerCase('en-US') !== folded
    );
    delete meta[_directoryEntryId(canonicalName)];
    currentByName.set(folded, { name: canonicalName, role: 'Front Desk', builtIn: false });
    added.push(canonicalName);
    changed = true;
    if (requestedRole !== 'Front Desk') defer(canonicalName, 'role');
  }

  if (changed) {
    if (custom.length) vault[STAFF_PROFILES_VAULT_KEY] = custom;
    else delete vault[STAFF_PROFILES_VAULT_KEY];
    if (removedBuiltIns.length) vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY] = removedBuiltIns;
    else delete vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY];
    if (removedCustom.length) vault[REMOVED_CUSTOM_PROFILES_VAULT_KEY] = removedCustom;
    else delete vault[REMOVED_CUSTOM_PROFILES_VAULT_KEY];
    if (Object.keys(overrides).length) vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY] = overrides;
    else delete vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY];
    vault[DIRECTORY_META_VAULT_KEY] = meta;
    _saveSecretVault(vault);
  }

  return { profiles: _allAppProfiles(), added, deferred };
}

// Apply a directory published by the owner's Mac to this Mac's vault.
// MB1188-061: reconcile an incoming directory with what this Mac already holds.
//
// Grouped by id. A tombstone beats a live record of the same generation,
// because a deletion must not be undone by a copy that has not heard about it;
// otherwise the higher version wins, and an equal version breaks on `updated`
// so both Macs land on the same answer. An id only ONE side knows about is
// kept — that is the whole point.
function _mergeDirectoryEntries(local, incoming) {
  const byId = new Map();
  const consider = entry => {
    if (!_isPlainObject(entry) || !_boundedString(entry.id, 200)) return;
    const held = byId.get(entry.id);
    if (!held) { byId.set(entry.id, entry); return; }
    const heldDead = held._deleted === true;
    const nextDead = entry._deleted === true;
    const heldVersion = Number.isSafeInteger(held.version) ? held.version : 1;
    const nextVersion = Number.isSafeInteger(entry.version) ? entry.version : 1;
    if (nextVersion > heldVersion) { byId.set(entry.id, entry); return; }
    if (nextVersion < heldVersion) return;
    if (heldDead !== nextDead) { if (nextDead) byId.set(entry.id, entry); return; }
    // Same generation and both alive: the incoming copy wins, because it is
    // considered second. That keeps this identical to the old behaviour for
    // every id the document actually names — the change here is only that an id
    // it does NOT name survives. Tie-breaking on `updated` was tried and is
    // wrong: the local side is stamped at apply time, so it would always look
    // newer and a published role change would never land.
    byId.set(entry.id, entry);
  };
  for (const entry of local) consider(entry);
  for (const entry of incoming) consider(entry);
  return [...byId.values()];
}

// MB1188-073: `elevate` is false unless an Owner session asked for this.
//
// The import path has to stay callable by any signed-in session, because it is
// how a profile added on one Mac reaches the others, and product rule 7 says a
// new profile appears everywhere after synchronization. But a directory is also
// a list of ROLES, and applying it is the one way a non-Owner session can hand
// out privilege. So a non-Owner import may create, remove and keep profiles —
// it simply cannot raise anybody above Front Desk. Roles already held locally
// are preserved; only an INCREASE arriving from outside is refused.
function _applyStaffDirectory(entries, { elevate = false, deferred = [] } = {}) {
  if (!Array.isArray(entries) || entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new Error('The staff directory is invalid.');
  }
  // MB1188-061: rebuild from the MERGE of both sides, not from the argument.
  //
  // This used to rebuild the vault from the incoming list alone, so any profile
  // only this Mac held was destroyed — and the destruction was reported as
  // success and then republished. No attacker and no stale document required:
  // a profile added at the login screen cannot publish (that is owner-only), so
  // the moment the other Mac published anything, the addition was gone. Role
  // changes made while Firebase was down were reverted the same way.
  //
  // Genuine removals still delete, because they travel as tombstones.
  //
  // Built FIRST: _buildStaffDirectory stamps the version metadata and saves the
  // vault, so the vault must be read after it rather than before.
  const localEntries = _buildStaffDirectory();
  entries = _mergeDirectoryEntries(localEntries, entries);
  const vault = _loadSecretVault();
  const custom = [];
  const overrides = {};
  const removedBuiltIns = [];
  const seen = new Set();

  for (const raw of entries) {
    if (!_validDirectoryEntry(raw)) continue;
    let name;
    try { name = _normalizeStaffProfileName(raw.name); } catch { continue; }
    const folded = name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) continue;
    seen.add(folded);
    const isBuiltIn = Object.prototype.hasOwnProperty.call(APP_PROFILE_ROLES, name);

    if (raw._deleted === true) {
      // A tombstone for a built-in suppresses it here too. Custom profiles are
      // simply omitted from the rebuilt list.
      if (isBuiltIn && APP_PROFILE_ROLES[name] !== 'Owner') removedBuiltIns.push(name);
      continue;
    }
    // Owner is never granted by import: it is proved by the owner passcode and
    // belongs only to the built-in owner identity.
    let role = (raw.role === 'Owner' && isBuiltIn && APP_PROFILE_ROLES[name] === 'Owner')
      ? 'Owner'
      : (ASSIGNABLE_PROFILE_ROLES.includes(raw.role) ? raw.role : 'Front Desk');
    if (!elevate && role !== 'Owner') {
      // What this Mac already believes, which an import may confirm but not raise.
      const held = _roleForAppProfile(name) || APP_PROFILE_ROLES[name] || 'Front Desk';
      if (PROFILE_ROLE_RANK[role] > (PROFILE_ROLE_RANK[held] ?? 0)) {
        // MB1188-081: RECORDED, not swallowed.
        //
        // This used to drop the elevation and report success. The sync layer
        // persists the revision before calling this, so the directory was
        // marked consumed and never delivered again — two Macs left permanently
        // disagreeing about somebody's role, decided by nothing more than who
        // happened to be signed in when it arrived.
        deferred.push({ name, requested: role, held });
        role = held;
      }
    }
    if (role !== 'Owner' && APP_PROFILE_ROLES[name] !== role) overrides[name] = role;
    if (!isBuiltIn) {
      if (custom.length >= MAX_CUSTOM_STAFF_PROFILES) continue;
      custom.push({ name, role: 'Front Desk', createdAt: Date.now() });
    }
  }

  // Refuse an import that would leave this Mac with no owner.
  const wouldHaveOwner = Object.entries(APP_PROFILE_ROLES).some(
    ([name, role]) => role === 'Owner' && !removedBuiltIns.includes(name)
  );
  if (!wouldHaveOwner) throw new Error('The staff directory would leave no owner.');

  if (custom.length) vault[STAFF_PROFILES_VAULT_KEY] = custom;
  else delete vault[STAFF_PROFILES_VAULT_KEY];
  if (Object.keys(overrides).length) vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY] = overrides;
  else delete vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY];
  if (removedBuiltIns.length) vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY] = removedBuiltIns;
  else delete vault[REMOVED_BUILTIN_PROFILES_VAULT_KEY];
  _saveSecretVault(vault);

  // A signed-in session whose role just changed must not keep old privileges.
  if (appSession) {
    const resolved = _roleForAppProfile(appSession.name);
    if (!resolved) _resetAppSession();
    else if (resolved !== appSession.role) appSession.role = resolved;
  }
  return _allAppProfiles();
}

// Owner publishes; any profile may import what the owner published.
//
// MB1188-029 widened this to COMMUNICATION_ROLES and it was WRONG. The safety
// case rested on two claims a pentest disproved:
//
//   "absence is not a deletion" — false on the path that actually runs. The
//   tombstoned merge only happens on the CAS-conflict rebase; steady state is
//   _reconcileRemoteSnapshot -> _refreshForSyncKey(key, decoded) with the RAW
//   remote list, and _applyStaffDirectory below rebuilds the vault wholesale.
//   A stale Mac publishing therefore DELETES custom profiles and resets role
//   overrides on the other Mac. No attacker needed — being behind is enough.
//
//   "removals stay owner-gated" — false. app-session-remove-staff-profile and
//   app-session-set-profile-role are OPERATIONS_MANAGER_ROLES, and
//   ASSIGNABLE_PROFILE_ROLES contains 'Operations Manager', so an imported
//   directory can promote someone who may then remove and re-role everybody
//   except the Owner.
//
// Reverted until _applyStaffDirectory merges against local state instead of
// replacing it. Widening the publisher is only safe once absence stops meaning
// deletion on the receiving side.
_secureHandle('app-session-export-directory', async () => {
  _requireAppRole(new Set(['Owner']));
  return { ok: true, directory: _buildStaffDirectory() };
});

_secureHandle('app-session-import-directory', async (_, directory) => {
  _requireAppRole(COMMUNICATION_ROLES);
  // MB1188-073: only an Owner session may let an import raise a role.
  // MB1188-081: and whatever that refused is reported back, so the renderer can
  // keep the debt and settle it the next time an Owner signs in. A partial
  // apply that claims success is how two Macs disagree forever.
  const deferred = [];
  const profiles = _applyStaffDirectory(directory, {
    elevate: _appSessionHasRole(new Set(['Owner'])),
    deferred,
  });
  return { ok: true, profiles, deferred, applied: deferred.length === 0 };
});

_secureHandle('app-login-import-directory', async (_, directory) => {
  const result = _applyLoginDirectoryAdditions(directory);
  return {
    ok: true,
    profiles: result.profiles,
    added: result.added,
    deferred: result.deferred,
    applied: result.deferred.length === 0,
  };
});

// ── MB161-014: Google Sheets, read-only ─────────────────────────────────────
//
// Owner-only to configure and connect, because linking a Google account is the
// same class of act as configuring Firebase. Reading a linked sheet is open to
// the roles that can already see spreadsheets — the data is the studio's either
// way, and gating the read would just mean staff see stale cells.

_secureHandle('google-set-credentials', async (_, request) => {
  _requireAppRole(OPERATIONS_MANAGER_ROLES);
  if (!_isPlainObject(request)) throw new Error('Invalid Google credentials.');
  // Strip whitespace AND the invisible characters \s does not cover.
  //
  // A client ID pasted from the Google console can arrive with spaces or a line
  // break inside it — from the paste, from text substitution, from a value that
  // was wrapped on screen when it was copied. `.trim()` leaves those, the
  // pattern below then rejects it, Save fails, and the next thing the operator
  // sees is "No client ID saved yet" on a field that visibly contains their
  // client ID. Neither a Google client ID nor a client secret can legitimately
  // contain whitespace, so removing it is unambiguous and cannot corrupt a
  // valid value.
  const clientId = _cleanGoogleClientId(request.clientId);
  const clientSecret = _cleanGoogleSecret(request.clientSecret);
  if (!_validGoogleClientId(clientId)) {
    // The client ID is public, so it is safe to say precisely what is wrong.
    // The secret is not, and is never described.
    throw new Error(_describeGoogleClientIdProblem(request.clientId, clientId));
  }
  if (!_validGoogleClientSecret(clientSecret)) {
    throw new Error('That does not look like a Google OAuth client secret.');
  }
  // A truncated client ID still matches the shape above, and Google answers a
  // truncated one with 'Error 401: invalid_client — The OAuth client was not
  // found', which reads like a project or test-user problem rather than a typo.
  // Every client ID Google issues has a 32-character suffix, so a different
  // length is worth saying out loud. It is a warning, not a refusal: the length
  // is Google's convention, not a documented guarantee.
  const suffix = /-([A-Za-z0-9_]+)\.apps\.googleusercontent\.com$/.exec(clientId)?.[1] || '';
  const lengthWarning = suffix.length === 32 ? null :
    `This client ID has ${suffix.length} characters after the dash; Google issues 32. ` +
    `If Google then says the OAuth client was not found, it was copied incompletely — ` +
    `use the copy button in the console rather than retyping it.`;

  const existing = _googleVault();
  // Changing the client identity invalidates any token issued under the old
  // one, so drop them rather than leaving credentials that cannot work.
  const sameClient = existing.clientId === clientId;
  _saveGoogleVault({
    clientId,
    clientSecret,
    refreshToken: sameClient ? existing.refreshToken : undefined,
    account: sameClient ? existing.account : undefined,
    connectedAt: sameClient ? existing.connectedAt : undefined,
  });
  return { ok: true, reconnectRequired: !sameClient, lengthWarning };
});

_secureHandle('google-status', async () => {
  _requireAppRole(COMMUNICATION_ROLES);
  const vault = _googleVault();
  return {
    ok: true,
    // Surfaced so Settings can distinguish an empty vault from an unreadable
    // one instead of showing "not connected" for both.
    vaultError: _googleVaultReadError || null,
    configured: _validGoogleClientId(vault.clientId || ''),
    connected: typeof vault.refreshToken === 'string' && vault.refreshToken.length > 0,
    account: typeof vault.account === 'string' ? vault.account : null,
    connectedAt: typeof vault.connectedAt === 'string' ? vault.connectedAt : null,
    // Stated in the UI so nobody has to take it on trust.
    scope: GOOGLE_SCOPE,
    readOnly: true,
  };
});

_secureHandle('google-oauth-begin', async (_, request) => {
  _requireAppRole(OPERATIONS_MANAGER_ROLES);
  if (!_isPlainObject(request)) throw new Error('Invalid Google sign-in request.');
  const vault = _googleVault();
  if (!_validGoogleClientId(vault.clientId || '')) {
    // Say WHICH of the two it is.
    if (_googleVaultReadError) {
      throw new Error(
        `The saved Google credentials on this Mac could not be read: ${_googleVaultReadError}. ` +
        `Re-enter the client ID and secret in Settings.`);
    }
    throw new Error('Add the Google OAuth client ID in Settings before connecting.');
  }
  return _beginGoogleOAuth({
    clientId: vault.clientId,
    codeChallenge: request.codeChallenge,
  });
});

_secureHandle('google-oauth-complete', async (_, request) => {
  _requireAppRole(OPERATIONS_MANAGER_ROLES);
  if (!_isPlainObject(request)) throw new Error('Invalid Google sign-in completion.');
  const attempt = pendingGoogleOAuth;
  const { state, codeVerifier } = request;
  if (!attempt || !attempt.callbackReceived || !attempt.code ||
      typeof state !== 'string' || state !== attempt.state ||
      !_validPkceChallenge(codeVerifier) ||
      Date.now() > attempt.expiresAt) {
    pendingGoogleOAuth = null;
    _closeGoogleOAuthServer();
    throw new Error('That Google sign-in is no longer valid. Try connecting again.');
  }
  const verifierChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  if (verifierChallenge !== attempt.codeChallenge) {
    pendingGoogleOAuth = null;
    _closeGoogleOAuthServer();
    throw new Error('The Google sign-in could not be verified.');
  }

  const vault = _googleVault();
  let tokens;
  try {
    tokens = await _googleTokenRequest({
      client_id: attempt.clientId,
      client_secret: vault.clientSecret || '',
      code: attempt.code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: attempt.redirectUri,
    });
  } finally {
    // One use, win or lose.
    pendingGoogleOAuth = null;
    _closeGoogleOAuthServer();
  }

  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token, so the connection would stop working within the hour. ' +
      'Remove Music Box from your Google account permissions and connect again.');
  }
  // Confirm the scope Google actually granted rather than the one we asked for.
  const granted = String(tokens.scope || '');
  if (granted && !granted.split(/\s+/).includes(GOOGLE_SCOPE)) {
    throw new Error(`Google granted "${granted.slice(0, 200)}" rather than read-only spreadsheet access.`);
  }

  let account = null;
  try {
    account = await _googleAccountEmail(tokens.access_token);
  } catch (_) {
    account = null;
  }

  _saveGoogleVault({
    ...vault,
    refreshToken: tokens.refresh_token,
    account,
    connectedAt: new Date().toISOString(),
  });
  return { ok: true, account, scope: GOOGLE_SCOPE };
});

_secureHandle('google-disconnect', async () => {
  _requireAppRole(OPERATIONS_MANAGER_ROLES);
  const vault = _googleVault();
  // Keep the client configuration; drop only the account grant.
  _saveGoogleVault({
    clientId: vault.clientId,
    clientSecret: vault.clientSecret,
  });
  _googleAccessToken = null;
  return { ok: true };
});

// What tabs does this spreadsheet have, and how big are they? Cheap enough to
// call before committing to reading anything.
_secureHandle('google-sheet-describe', async (_, request) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_isPlainObject(request)) throw new Error('Invalid spreadsheet request.');
  const spreadsheetId = _googleSpreadsheetId(request.url);
  if (!spreadsheetId) {
    throw new Error('Paste a Google Sheets link, e.g. https://docs.google.com/spreadsheets/d/…');
  }
  const token = await _googleAccessTokenFor();
  // A field mask, so Google does not send the entire workbook just to list tabs.
  const mask = encodeURIComponent('properties.title,sheets.properties');
  let payload;
  try {
    payload = await _googleApiGet('sheets.googleapis.com',
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${mask}`, token);
  } catch (error) {
    throw new Error(_googleReadFailure(error));
  }
  const tabs = (Array.isArray(payload.sheets) ? payload.sheets : []).map(entry => {
    const props = entry?.properties || {};
    const grid = props.gridProperties || {};
    return {
      sheetId: Number.isSafeInteger(props.sheetId) ? props.sheetId : null,
      title: String(props.title || '').slice(0, 200),
      rows: Number.isSafeInteger(grid.rowCount) ? grid.rowCount : 0,
      columns: Number.isSafeInteger(grid.columnCount) ? grid.columnCount : 0,
    };
  }).filter(tab => tab.sheetId !== null);
  return {
    ok: true,
    spreadsheetId,
    title: String(payload.properties?.title || 'Untitled').slice(0, 200),
    tabs,
  };
});

// Read one tab as text. FORMATTED_VALUE is deliberate: the app's cell model is
// text, so what a person SEES in Google is the honest thing to mirror. A date
// shows as the date, a formula shows its result. The formula itself is not
// imported, and the plan says so rather than pretending otherwise.
_secureHandle('google-sheet-read', async (_, request) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_isPlainObject(request)) throw new Error('Invalid spreadsheet read request.');
  const spreadsheetId = _googleSpreadsheetId(request.spreadsheetId || request.url);
  const title = String(request.title || '').trim();
  if (!spreadsheetId) throw new Error('That spreadsheet link is not valid.');
  if (!title || title.length > 200) throw new Error('Choose which tab to read.');
  const rows = Math.min(Math.max(Number(request.rows) || 200, 1), 500);
  const columns = Math.min(Math.max(Number(request.columns) || 30, 1), 100);

  // A bounded A1 range. Never the whole tab: Google tabs carry thousands of
  // empty default rows, and asking for them wastes quota and memory alike.
  const range = _googleRange(title, `A1:${_columnLetters(columns)}${rows}`);
  const token = await _googleAccessTokenFor();

  // MB161-018: read the grid, not just the values.
  //
  // The values endpoint returns text and nothing else, which is why the first
  // import landed as an unstyled grid: a schedule sheet carries most of its
  // meaning in the fills (blocked-out slots, colour-coded lesson types) and in
  // the merges (a lesson spanning two 15-minute rows). Dropping those does not
  // lose decoration, it loses the schedule.
  //
  // So this asks for grid data instead, with a strict `fields` mask. The mask
  // is not an optimisation detail — without it Google returns every format
  // property of every cell and a 500x100 window runs to tens of megabytes.
  const fields = [
    'sheets(properties(sheetId,title)',
    'merges',
    // dataValidation is how Google carries a checkbox. The cell's VALUE is the
    // string TRUE or FALSE — which is why an imported checkbox column arrived as
    // a column reading "FALSE". The box itself is the validation rule, so
    // without this the tick is simply not in the response.
    //
    // MB1188-032: `values` as well as `type`, because the same rule is how
    // Google carries a DROPDOWN. Without the option list a dropdown imported as
    // whatever text happened to be selected — "Wednesday" as a word, with no
    // way to pick a different day and nothing stopping a typo. The list is a few
    // short strings per column, not per cell, so the extra payload is small.
    'data(rowData(values(formattedValue,dataValidation(condition(type,values(userEnteredValue))),effectiveFormat(backgroundColor,backgroundColorStyle,textFormat(bold,foregroundColor,foregroundColorStyle)))),columnMetadata(pixelSize)))',
  ].join(',');
  let payload;
  try {
    payload = await _googleApiGet('sheets.googleapis.com',
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
      `?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${encodeURIComponent(fields)}`,
      token,
      // Formatted reads are an order of magnitude larger than value reads.
      // Still bounded — an unbounded read is how a hostile or corrupt response
      // becomes a memory problem.
      48 * 1024 * 1024);
  } catch (error) {
    throw new Error(_googleReadFailure(error));
  }

  const sheet = Array.isArray(payload.sheets) ? payload.sheets[0] : null;
  const rowData = sheet?.data?.[0]?.rowData;
  const sourceRows = Array.isArray(rowData) ? rowData : [];

  const grid = [];
  const formats = [];
  let cells = 0;
  let lastRow = -1;
  let lastCol = -1;

  for (let r = 0; r < Math.min(sourceRows.length, rows); r += 1) {
    const values = Array.isArray(sourceRows[r]?.values) ? sourceRows[r].values : [];
    const textLine = [];
    const formatLine = [];
    for (let c = 0; c < Math.min(values.length, columns); c += 1) {
      const cell = values[c] || {};
      const text = String(cell.formattedValue ?? '').slice(0, 50000);
      const effective = cell.effectiveFormat || {};
      // White is what Google reports for an unformatted cell, so treating it as
      // "no fill" is what keeps a blank sheet from importing as 50,000 white
      // cells. The app's own background is white, so nothing looks different.
      const bg = _googleColorHex(effective.backgroundColorStyle, effective.backgroundColor, '#ffffff');
      const tc = _googleColorHex(effective.textFormat?.foregroundColorStyle,
                                 effective.textFormat?.foregroundColor, '#000000');
      const bold = effective.textFormat?.bold === true;
      const checkbox = cell.dataValidation?.condition?.type === 'BOOLEAN';
      // MB1188-032: a dropdown. ONE_OF_LIST carries its options inline;
      // ONE_OF_RANGE points at another range and is deliberately NOT followed —
      // that would be a second read of a range we were never asked for, and the
      // options could sit outside the window or even another tab.
      let options = null;
      if (cell.dataValidation?.condition?.type === 'ONE_OF_LIST') {
        const listed = Array.isArray(cell.dataValidation.condition.values)
          ? cell.dataValidation.condition.values : [];
        const seen = new Set();
        options = [];
        for (const entry of listed) {
          const value = String(entry?.userEnteredValue ?? '').slice(0, 200);
          if (!value || seen.has(value)) continue;
          seen.add(value);
          options.push(value);
          if (options.length >= 50) break;
        }
        if (!options.length) options = null;
      }
      textLine.push(text);
      formatLine.push(options
        ? { bg, tc, b: bold, cb: checkbox, dv: options }
        : { bg, tc, b: bold, cb: checkbox });
      if (text !== '') { cells += 1; lastCol = Math.max(lastCol, c); lastRow = Math.max(lastRow, r); }
      // A fill with no text is meaningful on its own — that is exactly how a
      // blocked-out slot is drawn — so it counts towards the used extent.
      // A dropdown with nothing chosen yet is still a cell somebody set up.
      else if (bg || tc || bold || checkbox || options) { lastCol = Math.max(lastCol, c); lastRow = Math.max(lastRow, r); }
    }
    grid.push(textLine);
    formats.push(formatLine);
  }

  // Trim to what is actually used. Google reports an effective format for every
  // cell in the requested window whether or not anybody touched it, so without
  // this every import would arrive as the full 500 rows.
  const usedRows = lastRow + 1;
  const usedCols = lastCol + 1;
  const trimmedRows = grid.slice(0, usedRows).map(row => row.slice(0, usedCols));
  const trimmedFormats = formats.slice(0, usedRows).map(row => row.slice(0, usedCols));

  // Merges are reported for the whole tab, so clip them to the window we read.
  // Half-open in Google (endRowIndex is exclusive), inclusive spans here.
  const merges = [];
  for (const merge of Array.isArray(sheet?.merges) ? sheet.merges : []) {
    const r1 = Number(merge?.startRowIndex ?? 0);
    const c1 = Number(merge?.startColumnIndex ?? 0);
    const r2 = Number(merge?.endRowIndex ?? 0);
    const c2 = Number(merge?.endColumnIndex ?? 0);
    if (![r1, c1, r2, c2].every(Number.isSafeInteger)) continue;
    if (r1 < 0 || c1 < 0 || r2 <= r1 || c2 <= c1) continue;
    if (r1 >= usedRows || c1 >= usedCols) continue;       // anchor outside the window
    const rowSpan = Math.min(r2, usedRows) - r1;
    const colSpan = Math.min(c2, usedCols) - c1;
    if (rowSpan < 1 || colSpan < 1 || (rowSpan === 1 && colSpan === 1)) continue;
    merges.push({ row: r1, column: c1, rowSpan, colSpan });
    if (merges.length >= 5000) break;
  }

  // MB161-028: Google's actual column widths, in pixels.
  //
  // The importer used to guess a width from the longest value in each column.
  // That is a reasonable guess and it is wrong every time: it made columns
  // wider than the sheet they came from wherever one cell held a long note, so
  // an imported schedule never lined up with the original. Google reports the
  // real widths, so there is no reason to estimate.
  const columnMetadata = Array.isArray(sheet?.data?.[0]?.columnMetadata)
    ? sheet.data[0].columnMetadata
    : [];
  const columnWidths = columnMetadata.slice(0, usedCols).map(entry => {
    const pixels = Number(entry?.pixelSize);
    // Bounded: a hidden column is 0 in Google and would vanish here, and a
    // pathological width should not be able to make one column the whole grid.
    // MB1188-014: floor is 40, not 24 — the workbook validator and the
    // renderer both treat 40 as the minimum. A 0 still means "hidden".
    return Number.isFinite(pixels) && pixels > 0 ? Math.min(Math.max(Math.round(pixels), 40), 600) : 0;
  });

  return {
    ok: true, spreadsheetId, title, range,
    rows: trimmedRows, formats: trimmedFormats, merges, columnWidths,
    filledCells: cells,
  };
});

// Google gives colour as floats 0..1, with missing channels meaning zero.
//
// MB161-022: it reports the SAME colour two ways. `backgroundColor` is
// deprecated; `backgroundColorStyle` supersedes it and, per Google's reference,
// "takes precedence" when both are set. Reading only the deprecated field is
// how a sheet whose colours come from conditional formatting or the document
// theme imported as plain white — the value was in the field we never asked
// for. So the style wins, and the deprecated field is the fallback.
//
// A ColorStyle is a union: either `rgbColor` or a named `themeColor` that
// cannot be resolved to hex without the spreadsheet's palette. In the theme
// case there is no rgbColor to read, and the deprecated field — which Google
// still fills in with the resolved colour — is exactly the right fallback.
//
// Anything that resolves to `treatAsBlank` comes back as '' — the app's "no
// colour" — rather than as an explicit hex, so a default sheet imports clean.
function _googleColorHex(style, legacy, treatAsBlank) {
  const color = _isPlainObject(style?.rgbColor) ? style.rgbColor : legacy;
  if (!_isPlainObject(color)) return '';
  const channel = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(255, Math.round(number * 255)));
  };
  const hex = '#' + [color.red, color.green, color.blue]
    .map(value => channel(value).toString(16).padStart(2, '0')).join('');
  return hex === treatAsBlank ? '' : hex;
}

// MB161-021: there is no write path to Google, by construction.
//
// Two-way sync was built and then deliberately taken back out. Pushing meant
// widening the OAuth scope, splitting writes across input options, reconciling
// what Google refused, and keeping a checkpoint honest enough to write from —
// a lot of machinery whose failure mode is somebody's real spreadsheet being
// overwritten. The studio edits in the app; Google only has to be able to feed
// changes IN. So the scope went back to spreadsheets.readonly and Google itself
// refuses a write again, which is a guarantee that does not depend on this file
// staying correct.


// MB161-018: an A1 range naming a tab.
//
// `Monday!A1` happens to work, which is exactly why this was missed: every tab
// in the sheet that got tested had a one-word name. Google's A1 grammar needs a
// sheet name quoted the moment it contains a space or punctuation, so a tab
// called "Color Block" or "Week 1" produced a parse error from the API and, on
// an all-tabs import, took the whole batch down with it. Internal quotes are
// escaped by doubling, which is the escape A1 defines.
function _googleRange(title, cells) {
  return `'${String(title).replace(/'/g, "''")}'!${cells}`;
}

function _columnLetters(count) {
  let n = count - 1;
  let letters = '';
  while (n >= 0) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
}

// Google's own message, plus what to do about it. "HTTP 403" on its own has
// cost more debugging hours than any other string in this project.
function _googleReadFailure(error) {
  const detail = String(error?.message || error).slice(0, 300);
  switch (error?.statusCode) {
    case 401:
      return `Google rejected the saved sign-in. Disconnect and reconnect the Google account. (${detail})`;
    case 403:
      return `That Google account cannot open this spreadsheet, or the Sheets API is not enabled on the Cloud project. (${detail})`;
    case 404:
      return `No spreadsheet was found at that link. Check it is shared with the connected account. (${detail})`;
    case 429:
      return `Google is rate limiting this app. Wait a minute and try again. (${detail})`;
    default:
      return `Google could not be read: ${detail}`;
  }
}

// Owner-only role assignment. Any profile, built-in included, can be moved
// between the assignable roles — so Operations & Events is not limited to one
// person. Owner is not assignable; see ASSIGNABLE_PROFILE_ROLES.
// MB1188-073: changing a role is OWNER-ONLY.
//
// MB161-031 gave Operations Manager the whole of "managing staff profiles".
// Splitting that: adding and removing profiles is routine onboarding work and
// stays with the Operations Manager; changing a ROLE is granting privilege and
// is the step that closes the escalation chain the comment above
// app-session-import-directory already describes — an imported directory
// promotes somebody to Operations Manager, who can then re-role everybody
// except the Owner. With this Owner-gated, that chain has no payoff.
_secureHandle('app-session-set-profile-role', async (_, request) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(request)) throw new Error('Invalid role change request.');
  const name = _normalizeStaffProfileName(request.name);
  const role = request.role;
  if (!ASSIGNABLE_PROFILE_ROLES.includes(role)) {
    throw new Error(
      `Role must be one of: ${ASSIGNABLE_PROFILE_ROLES.join(', ')}. ` +
      `Owner cannot be reassigned because it is proved by the owner passcode.`
    );
  }
  const existing = _allAppProfiles();
  const target = _findProfileByFoldedName(existing, name);
  if (!target) throw new Error('That user was not found on this Mac.');
  if (target.role === role) return { ok: true, name: target.name, role, unchanged: true };
  // MB161-031: and cannot demote one either.
  _requireNotOwnerTarget(target, 'change the role of');
  if (target.role === 'Owner' && _ownerProfileCount(existing) <= 1) {
    throw new Error('The last Owner profile cannot be demoted.');
  }

  const vault = _loadSecretVault();
  const overrides = { ..._profileRoleOverrides(vault) };
  const canonical = target.name;
  const shippedRole = APP_PROFILE_ROLES[canonical];
  if (shippedRole === role) delete overrides[canonical]; // back to default; store nothing
  else overrides[canonical] = role;
  if (Object.keys(overrides).length) vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY] = overrides;
  else delete vault[PROFILE_ROLE_OVERRIDES_VAULT_KEY];
  _saveSecretVault(vault);

  // A live session whose role just changed must not keep its old privileges.
  if (appSession?.name === canonical) appSession.role = role;
  return { ok: true, name: canonical, role };
});

_secureHandle('app-session-end', async () => {
  _resetAppSession();
  return { ok: true };
});

_secureHandle('app-session-status', async () => {
  if (!appSession || Date.now() >= appSession.expiresAt) {
    _resetAppSession();
    return { ok: true, authenticated: false };
  }
  return {
    ok: true,
    authenticated: true,
    name: appSession.name,
    role: appSession.role,
    expiresAt: appSession.expiresAt,
  };
});

_secureHandle('app-session-stage-owner-pin', async (_, request) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(request) ||
      !Object.keys(request).every(key => ['currentPin', 'newPin'].includes(key)) ||
      !_validOwnerPin(request.currentPin) || !_validOwnerPin(request.newPin, false)) {
    throw new Error('Invalid owner passcode change.');
  }
  const vault = _loadSecretVault();
  const record = _ownerAuthRecord(vault);
  if (!record || !await _ownerPinMatches(request.currentPin, record.active)) {
    throw new Error('The current owner passcode did not match.');
  }
  const rotationId = crypto.randomBytes(24).toString('base64url');
  record.pending = {
    rotationId,
    createdAt: Date.now(),
    verifier: await _buildOwnerVerifier(request.newPin),
  };
  _persistOwnerAuthRecord(record);
  return { ok: true, rotationId };
});

_secureHandle('app-session-commit-owner-pin', async (_, rotationId) => {
  _requireAppRole(new Set(['Owner']));
  if (!_boundedString(rotationId, 128)) throw new Error('Invalid owner passcode change.');
  const vault = _loadSecretVault();
  const record = _ownerAuthRecord(vault);
  if (!record?.pending || record.pending.rotationId !== rotationId) {
    throw new Error('The pending owner passcode change was not found.');
  }
  record.active = record.pending.verifier;
  record.pending = null;
  vault[OWNER_AUTH_VAULT_KEY] = record;
  _saveSecretVault(vault);
  return { ok: true };
});

_secureHandle('app-session-cancel-owner-pin', async (_, rotationId) => {
  _requireAppRole(new Set(['Owner']));
  if (!_boundedString(rotationId, 128)) throw new Error('Invalid owner passcode change.');
  const vault = _loadSecretVault();
  const record = _ownerAuthRecord(vault);
  if (record?.pending?.rotationId === rotationId) {
    record.pending = null;
    vault[OWNER_AUTH_VAULT_KEY] = record;
    _saveSecretVault(vault);
  }
  return { ok: true };
});

// Firebase must remain renderer-hosted until the sync layer can move behind a
// backend/main proxy. Remove arbitrary vault reads while keeping this one
// backward-compatible, purpose-specific runtime configuration path.
const FIREBASE_SECRET_KEYS_MAIN = Object.freeze({
  apiKey: 'firebase_api_key',
  projectId: 'firebase_project_id',
  appId: 'firebase_app_id',
  email: 'firebase_email',
  password: 'firebase_password',
});

function _validFirebaseConfig(config) {
  return _isPlainObject(config) &&
    typeof config.apiKey === 'string' && config.apiKey.length >= 8 && config.apiKey.length <= 512 &&
    !/[\u0000-\u0020\u007f]/.test(config.apiKey) &&
    typeof config.projectId === 'string' && /^[a-z0-9][a-z0-9-]{3,62}$/.test(config.projectId) &&
    (config.appId === '' ||
      (typeof config.appId === 'string' && config.appId.length <= 512 &&
       !/[\u0000-\u001f\u007f]/.test(config.appId))) &&
    typeof config.email === 'string' && config.email.length >= 3 && config.email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email) &&
    typeof config.password === 'string' && config.password.length >= 6 &&
    config.password.length <= 2048 && !config.password.includes('\0');
}

function _firebaseConfigFromVault(vault) {
  return {
    apiKey: typeof vault[FIREBASE_SECRET_KEYS_MAIN.apiKey] === 'string'
      ? vault[FIREBASE_SECRET_KEYS_MAIN.apiKey] : '',
    projectId: typeof vault[FIREBASE_SECRET_KEYS_MAIN.projectId] === 'string'
      ? vault[FIREBASE_SECRET_KEYS_MAIN.projectId] : '',
    appId: typeof vault[FIREBASE_SECRET_KEYS_MAIN.appId] === 'string'
      ? vault[FIREBASE_SECRET_KEYS_MAIN.appId] : '',
    email: typeof vault[FIREBASE_SECRET_KEYS_MAIN.email] === 'string'
      ? vault[FIREBASE_SECRET_KEYS_MAIN.email] : '',
    password: typeof vault[FIREBASE_SECRET_KEYS_MAIN.password] === 'string'
      ? vault[FIREBASE_SECRET_KEYS_MAIN.password] : '',
  };
}

_secureHandle('firebase-config-status', async () => {
  _requireAppRole(COMMUNICATION_ROLES);
  const config = _firebaseConfigFromVault(_loadSecretVault());
  return {
    ok: true,
    configured: _validFirebaseConfig(config),
    hasPassword: typeof config.password === 'string' && config.password.length >= 6,
    config: {
      apiKey: config.apiKey,
      projectId: config.projectId,
      appId: config.appId,
      email: config.email,
    },
  };
});

// The profile picker has to learn about a newly added Front Desk profile before
// that person can sign in. Return only the public Firebase application
// coordinates needed to restore Firebase Auth's already-provisioned browser
// session. The email and password stay in main; provisioning and ordinary
// runtime credential release remain session-gated below.
_secureHandle('firebase-login-directory-config', async () => {
  const config = _firebaseConfigFromVault(_loadSecretVault());
  return {
    ok: true,
    configured: _validFirebaseConfig(config),
    config: {
      apiKey: config.apiKey,
      projectId: config.projectId,
      appId: config.appId,
    },
  };
});

// Any signed-in profile on a provisioned Mac may start cloud sync.
//
// This is deliberately weaker than Owner-only, and worth being precise about
// what it does and does not change. A staff renderer that inherited a live
// session already held full Firestore read/write through the SDK — the same
// capability this credential grants. What Owner-only actually bought was that
// staff had it only when the owner happened to sign in first that morning, and
// otherwise silently worked offline while believing they were synced. That is
// not a security boundary, it is a coin flip.
//
// What it does concede: a passwordless Front Desk profile can now obtain a
// credential that works outside the app, where the UI's role gates do not
// apply. Provisioning still requires the owner — the vault is written only by
// firebase-configure, which stays Owner-only — so this releases an existing
// secret to an existing session rather than letting anyone create one.
_secureHandle('firebase-runtime-config', async () => {
  // A session is still required: this must not be reachable before login.
  //
  // MB161-045: COMMUNICATION_ROLES, not a hand-written copy of it. Spelling the
  // roles out here meant a role added later — Operations Manager — silently
  // could not fetch the Firebase configuration, so that profile ran entirely
  // local-only: no sync, no attribution reaching the other Macs, and a "Local
  // only" badge with nothing explaining it. Third list of this kind in this
  // change; every one of them is now derived rather than repeated.
  _requireAppRole(COMMUNICATION_ROLES);
  if (firebaseRuntimeSecretIssued) {
    throw new Error('Firebase runtime credentials were already delivered for this app session.');
  }
  const config = _firebaseConfigFromVault(_loadSecretVault());
  if (_validFirebaseConfig(config)) firebaseRuntimeSecretIssued = true;
  return { ok: true, configured: _validFirebaseConfig(config), config };
});

_secureHandle('firebase-configure', async (_, settings) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(settings) ||
      !Object.keys(settings).every(key => ['apiKey', 'projectId', 'appId', 'email', 'password'].includes(key))) {
    throw new Error('Invalid Firebase configuration.');
  }
  const vault = _loadSecretVault();
  const current = _firebaseConfigFromVault(vault);
  const config = {
    apiKey: settings.apiKey,
    projectId: settings.projectId,
    appId: settings.appId || '',
    email: settings.email,
    password: settings.password || current.password,
  };
  if (!_validFirebaseConfig(config)) throw new Error('Enter valid Firebase credentials.');
  for (const [field, key] of Object.entries(FIREBASE_SECRET_KEYS_MAIN)) {
    vault[key] = config[field];
  }
  _saveSecretVault(vault);
  firebaseRuntimeSecretIssued = false;
  return {
    ok: true,
    configured: true,
    config: { ...config, password: '' },
    hasPassword: true,
  };
});

_secureHandle('firebase-clear', async () => {
  _requireAppRole(new Set(['Owner']));
  const vault = _loadSecretVault();
  for (const key of Object.values(FIREBASE_SECRET_KEYS_MAIN)) delete vault[key];
  _saveSecretVault(vault);
  firebaseRuntimeSecretIssued = false;
  return { ok: true, configured: false };
});

// ── Anthropic proxy ──────────────────────────────────────────────────────────
// The renderer may submit a newly typed key once, but saved keys, Authorization
// headers, and API responses never expose credentials back across IPC.
const ANTHROPIC_SECRET_KEY = 'anthropic_api_key';
const ANTHROPIC_MODELS = new Set([
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const aiCallTimestamps = [];
let activeAiRequests = 0;

function _validAnthropicKey(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 512 &&
    value.startsWith('sk-ant-') && !/[\u0000-\u0020\u007f]/.test(value);
}

function _validateAnthropicContent(content) {
  if (typeof content === 'string') {
    return content.length > 0 && Buffer.byteLength(content, 'utf8') <= 2 * 1024 * 1024;
  }
  if (!Array.isArray(content) || content.length < 1 || content.length > 64) return false;
  return content.every((block) => {
    if (!_isPlainObject(block)) return false;
    if (block.type === 'text') {
      return Object.keys(block).every(key => ['type', 'text'].includes(key)) &&
        typeof block.text === 'string' && block.text.length > 0 &&
        Buffer.byteLength(block.text, 'utf8') <= 2 * 1024 * 1024;
    }
    if (block.type === 'image' && _isPlainObject(block.source)) {
      return Object.keys(block).every(key => ['type', 'source'].includes(key)) &&
        Object.keys(block.source).every(key => ['type', 'media_type', 'data'].includes(key)) &&
        block.source.type === 'base64' &&
        ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(block.source.media_type) &&
        typeof block.source.data === 'string' &&
        block.source.data.length > 0 && block.source.data.length <= 10 * 1024 * 1024 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(block.source.data);
    }
    return false;
  });
}

function _validatedAnthropicPayload(payload) {
  if (!_isPlainObject(payload) ||
      !Object.keys(payload).every(key => ['model', 'max_tokens', 'system', 'messages'].includes(key)) ||
      !ANTHROPIC_MODELS.has(payload.model) ||
      !Number.isSafeInteger(payload.max_tokens) ||
      payload.max_tokens < 1 || payload.max_tokens > 4096 ||
      (payload.system !== undefined &&
        (typeof payload.system !== 'string' ||
         Buffer.byteLength(payload.system, 'utf8') > 2 * 1024 * 1024)) ||
      !Array.isArray(payload.messages) ||
      payload.messages.length < 1 || payload.messages.length > 20) {
    throw new Error('Invalid AI request.');
  }
  for (const message of payload.messages) {
    if (!_isPlainObject(message) ||
        !Object.keys(message).every(key => ['role', 'content'].includes(key)) ||
        !['user', 'assistant'].includes(message.role) ||
        !_validateAnthropicContent(message.content)) {
      throw new Error('Invalid AI message content.');
    }
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AI_REQUEST_BYTES) {
    throw new Error('AI request exceeds the 12 MB limit.');
  }
  return serialized;
}

function _consumeAiRateLimit() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (aiCallTimestamps.length && aiCallTimestamps[0] < cutoff) aiCallTimestamps.shift();
  if (aiCallTimestamps.length >= 60 || activeAiRequests >= 2) return false;
  aiCallTimestamps.push(Date.now());
  return true;
}

function _anthropicPost(apiKey, body) {
  return new Promise((resolve) => {
    const req = https.request({
      protocol: 'https:',
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      timeout: 45000,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body, 'utf8'),
        'user-agent': `MusicBoxInternal/${app.getVersion()}`,
      },
    }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_AI_RESPONSE_BYTES) {
          req.destroy(new Error('AI response exceeded the 2 MB limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_) {
          resolve({ ok: false, status: res.statusCode, error: 'The AI service returned an invalid response.' });
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = typeof parsed?.error?.message === 'string'
            ? parsed.error.message.slice(0, 300)
            : `HTTP ${res.statusCode}`;
          resolve({ ok: false, status: res.statusCode, error: `AI request failed: ${detail}` });
          return;
        }
        if (!_isPlainObject(parsed)) {
          resolve({ ok: false, error: 'The AI service returned an invalid response.' });
          return;
        }
        resolve({ ok: true, data: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI request timed out.')));
    req.on('error', (error) => {
      resolve({ ok: false, error: String(error?.message || 'AI request failed.').slice(0, 300) });
    });
    req.end(body);
  });
}

_secureHandle('anthropic-key-status', async () => {
  _requireAppRole(COMMUNICATION_ROLES);
  const vault = _loadSecretVault();
  return { ok: true, configured: _validAnthropicKey(vault[ANTHROPIC_SECRET_KEY]) };
});

_secureHandle('anthropic-key-set', async (_, value) => {
  _requireAppRole(new Set(['Owner']));
  if (!_validAnthropicKey(value)) throw new Error('Enter a valid Anthropic API key.');
  const vault = _loadSecretVault();
  vault[ANTHROPIC_SECRET_KEY] = value;
  _saveSecretVault(vault);
  return { ok: true, configured: true };
});

_secureHandle('anthropic-key-remove', async () => {
  _requireAppRole(new Set(['Owner']));
  const vault = _loadSecretVault();
  delete vault[ANTHROPIC_SECRET_KEY];
  _saveSecretVault(vault);
  return { ok: true, configured: false };
});

_secureHandle('anthropic-message', async (_, payload) => {
  _requireAppRole(COMMUNICATION_ROLES);
  let body;
  try { body = _validatedAnthropicPayload(payload); }
  catch (error) { return { ok: false, error: error.message }; }
  const vault = _loadSecretVault();
  const apiKey = vault[ANTHROPIC_SECRET_KEY];
  if (!_validAnthropicKey(apiKey)) {
    return { ok: false, error: 'Add an Anthropic API key in Settings first.' };
  }
  if (!_consumeAiRateLimit()) {
    return { ok: false, error: 'AI request limit reached. Wait before trying again.' };
  }
  activeAiRequests++;
  try {
    return await _anthropicPost(apiKey, body);
  } finally {
    activeAiRequests--;
  }
});

// ── RingCentral proxy ────────────────────────────────────────────────────────
// Credentials and OAuth tokens stay in the main-process vault. Only normalized,
// bounded message records cross into the renderer.
const RC_SECRET_KEYS = Object.freeze({
  clientId: 'rc_client_id',
  clientSecret: 'rc_client_secret',
  jwt: 'rc_jwt',
  myPhone: 'rc_my_phone',
});
let rcAccessToken = null;
let rcAccessTokenExpiry = 0;
let rcTokenInFlight = null;
let rcFetchInFlight = null;
const rcSendTimestamps = [];

function _cleanString(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
    : '';
}

function _normalizeRcPhone(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const normalized = value.trim().replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

function _validRcCredentials({ clientId, clientSecret, jwt }) {
  return typeof clientId === 'string' && clientId.length >= 4 && clientId.length <= 512 &&
    /^[A-Za-z0-9._~-]+$/.test(clientId) &&
    typeof clientSecret === 'string' && clientSecret.length >= 8 && clientSecret.length <= 2048 &&
    !/[\u0000-\u0020\u007f]/.test(clientSecret) &&
    typeof jwt === 'string' && jwt.length >= 20 && jwt.length <= 32768 &&
    /^[A-Za-z0-9._~-]+$/.test(jwt);
}

function _ringCentralRequest({ method, requestPath, headers = {}, body = null, maxBytes = 5 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    const req = https.request({
      protocol: 'https:',
      hostname: 'platform.ringcentral.com',
      port: 443,
      method,
      path: requestPath,
      timeout: 20000,
      headers: {
        ...headers,
        'user-agent': `MusicBoxInternal/${app.getVersion()}`,
        ...(body === null ? {} : { 'content-length': Buffer.byteLength(body, 'utf8') }),
      },
    }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error('RingCentral response exceeded its safety limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = {};
        if (raw) {
          try { data = JSON.parse(raw); }
          catch (_) {
            resolve({ ok: false, status: res.statusCode, error: 'RingCentral returned an invalid response.' });
            return;
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = _cleanString(data?.message || data?.error_description || '', 300);
          resolve({
            ok: false,
            status: res.statusCode,
            error: detail ? `RingCentral request failed: ${detail}` : `RingCentral request failed (HTTP ${res.statusCode}).`,
          });
          return;
        }
        resolve({ ok: true, status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('RingCentral request timed out.')));
    req.on('error', (error) => {
      resolve({ ok: false, error: _cleanString(error?.message || 'RingCentral request failed.', 300) });
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

async function _getRcAccessTokenMain(forceRefresh = false) {
  if (!forceRefresh && rcAccessToken && Date.now() < rcAccessTokenExpiry - 5 * 60 * 1000) {
    return { ok: true, token: rcAccessToken };
  }
  if (rcTokenInFlight) return rcTokenInFlight;
  const request = (async () => {
    const vault = _loadSecretVault();
    const credentials = {
      clientId: vault[RC_SECRET_KEYS.clientId],
      clientSecret: vault[RC_SECRET_KEYS.clientSecret],
      jwt: vault[RC_SECRET_KEYS.jwt],
    };
    if (!_validRcCredentials(credentials)) {
      return { ok: false, error: 'Add valid RingCentral credentials in Settings first.' };
    }
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: credentials.jwt,
    }).toString();
    const result = await _ringCentralRequest({
      method: 'POST',
      requestPath: '/restapi/oauth/token',
      headers: {
        authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
      maxBytes: 1024 * 1024,
    });
    if (!result.ok || typeof result.data?.access_token !== 'string' ||
        result.data.access_token.length < 20 || result.data.access_token.length > 32768) {
      return { ok: false, error: result.error || 'RingCentral authentication failed.' };
    }
    const expiresIn = Number(result.data.expires_in);
    rcAccessToken = result.data.access_token;
    rcAccessTokenExpiry = Date.now() +
      (Number.isFinite(expiresIn) ? Math.max(300, Math.min(expiresIn, 86400)) : 3600) * 1000;
    return { ok: true, token: rcAccessToken };
  })();
  rcTokenInFlight = request;
  try {
    return await request;
  } finally {
    if (rcTokenInFlight === request) rcTokenInFlight = null;
  }
}

async function _ringCentralAuthedRequest(method, requestPath, body = null) {
  let auth = await _getRcAccessTokenMain();
  if (!auth.ok) return auth;
  const makeRequest = (token) => _ringCentralRequest({
    method,
    requestPath,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === null ? {} : { 'content-type': 'application/json' }),
    },
    body: body === null ? null : JSON.stringify(body),
  });
  let result = await makeRequest(auth.token);
  if (result.status === 401) {
    rcAccessToken = null;
    rcAccessTokenExpiry = 0;
    auth = await _getRcAccessTokenMain(true);
    if (!auth.ok) return auth;
    result = await makeRequest(auth.token);
  }
  return result;
}

function _normalizeRcMessage(record, forcedDirection = null) {
  if (!_isPlainObject(record)) return null;
  const direction = forcedDirection ||
    (String(record.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound');
  const to = Array.isArray(record.to)
    ? record.to.slice(0, 20).map(item => _cleanString(item?.phoneNumber, 64)).filter(Boolean)
    : [];
  const from = _cleanString(record.from?.phoneNumber || '?', 64);
  return {
    id: _cleanString(String(record.id || ''), 128),
    from,
    fromName: _cleanString(record.from?.name || '', 256),
    to,
    body: _cleanString(record.subject || '', 20000),
    createdAt: _cleanString(record.creationTime || '', 64),
    direction,
    readStatus: direction === 'outbound' ? 'Read' : _cleanString(record.readStatus || 'Unread', 32),
  };
}

async function _fetchRingCentralDataMain() {
  const base = '/restapi/v1.0/account/~/extension/~/message-store';
  const [smsIn, smsOut, voicemail] = await Promise.all([
    _ringCentralAuthedRequest('GET', `${base}?type=SMS&direction=Inbound&perPage=100`),
    _ringCentralAuthedRequest('GET', `${base}?type=SMS&direction=Outbound&perPage=100`),
    _ringCentralAuthedRequest('GET', `${base}?type=VoiceMail&direction=Inbound&perPage=30`),
  ]);
  const failed = [smsIn, smsOut, voicemail].find(result => !result.ok);
  if (failed) return { ok: false, error: failed.error || 'RingCentral refresh failed.' };

  const inbound = Array.isArray(smsIn.data?.records) ? smsIn.data.records.slice(0, 100) : [];
  const outbound = Array.isArray(smsOut.data?.records) ? smsOut.data.records.slice(0, 100) : [];
  const allSms = [
    ...inbound.map(record => _normalizeRcMessage(record, 'inbound')),
    ...outbound.map(record => _normalizeRcMessage(record, 'outbound')),
  ].filter(Boolean);
  const conversations = new Map();
  for (const message of allSms) {
    const phone = message.direction === 'inbound' ? message.from : (message.to[0] || 'Unknown');
    if (!conversations.has(phone)) {
      conversations.set(phone, {
        phone,
        name: message.direction === 'inbound' ? message.fromName : '',
        messages: [],
        unread: false,
      });
    }
    const conversation = conversations.get(phone);
    if (message.fromName && !conversation.name) conversation.name = message.fromName;
    if (message.direction === 'inbound' && message.readStatus === 'Unread') conversation.unread = true;
    conversation.messages.push(message);
  }
  for (const conversation of conversations.values()) {
    conversation.messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    conversation.lastMsg = conversation.messages[conversation.messages.length - 1] || null;
  }
  const voicemailRecords = Array.isArray(voicemail.data?.records)
    ? voicemail.data.records.slice(0, 30)
    : [];
  const voicemails = voicemailRecords.map(record => ({
    id: _cleanString(String(record?.id || ''), 128),
    from: _cleanString(record?.from?.phoneNumber || record?.from?.name || 'Unknown', 256),
    fromName: _cleanString(record?.from?.name || record?.from?.phoneNumber || '', 256),
    createdAt: _cleanString(record?.creationTime || '', 64),
    voicemail: { transcript: _cleanString(record?.subject || '', 20000) },
  }));
  return {
    ok: true,
    data: {
      messages: allSms.filter(message => message.direction === 'inbound'),
      voicemails,
      conversations: Array.from(conversations.values())
        .sort((a, b) => Date.parse(b.lastMsg?.createdAt || 0) - Date.parse(a.lastMsg?.createdAt || 0))
        .slice(0, 200),
    },
  };
}

_secureHandle('ringcentral-status', async () => {
  _requireAppRole(COMMUNICATION_ROLES);
  const vault = _loadSecretVault();
  const configured = _validRcCredentials({
    clientId: vault[RC_SECRET_KEYS.clientId],
    clientSecret: vault[RC_SECRET_KEYS.clientSecret],
    jwt: vault[RC_SECRET_KEYS.jwt],
  });
  const clientId = typeof vault[RC_SECRET_KEYS.clientId] === 'string' ? vault[RC_SECRET_KEYS.clientId] : '';
  return {
    ok: true,
    configured,
    myPhone: configured ? (_normalizeRcPhone(vault[RC_SECRET_KEYS.myPhone]) || '') : '',
    clientIdHint: configured ? `••••${clientId.slice(-4)}` : '',
  };
});

_secureHandle('ringcentral-configure', async (_, settings) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(settings) ||
      !Object.keys(settings).every(key => ['clientId', 'clientSecret', 'jwt', 'myPhone', 'clear'].includes(key))) {
    throw new Error('Invalid RingCentral settings.');
  }
  const vault = _loadSecretVault();
  const requestedClear = settings.clear === true ||
    [settings.clientId, settings.clientSecret, settings.jwt, settings.myPhone]
      .every(value => value === '' || value === undefined);
  if (requestedClear) {
    for (const key of Object.values(RC_SECRET_KEYS)) delete vault[key];
    _saveSecretVault(vault);
    rcAccessToken = null;
    rcAccessTokenExpiry = 0;
    return { ok: true, configured: false };
  }
  const next = {
    clientId: settings.clientId || vault[RC_SECRET_KEYS.clientId] || '',
    clientSecret: settings.clientSecret || vault[RC_SECRET_KEYS.clientSecret] || '',
    jwt: settings.jwt || vault[RC_SECRET_KEYS.jwt] || '',
  };
  if (!_validRcCredentials(next)) {
    throw new Error('Enter a valid Client ID, Client Secret, and JWT.');
  }
  const phoneInput = settings.myPhone === undefined
    ? (vault[RC_SECRET_KEYS.myPhone] || '')
    : settings.myPhone;
  const phone = phoneInput ? _normalizeRcPhone(phoneInput) : '';
  if (phoneInput && !phone) throw new Error('Enter the RingCentral number in E.164 format, such as +15551234567.');
  vault[RC_SECRET_KEYS.clientId] = next.clientId;
  vault[RC_SECRET_KEYS.clientSecret] = next.clientSecret;
  vault[RC_SECRET_KEYS.jwt] = next.jwt;
  if (phone) vault[RC_SECRET_KEYS.myPhone] = phone;
  else delete vault[RC_SECRET_KEYS.myPhone];
  _saveSecretVault(vault);
  rcAccessToken = null;
  rcAccessTokenExpiry = 0;
  return { ok: true, configured: true, myPhone: phone, clientIdHint: `••••${next.clientId.slice(-4)}` };
});

_secureHandle('ringcentral-fetch-data', async () => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (rcFetchInFlight) return rcFetchInFlight;
  const request = _fetchRingCentralDataMain();
  rcFetchInFlight = request;
  try {
    return await request;
  } finally {
    if (rcFetchInFlight === request) rcFetchInFlight = null;
  }
});

_secureHandle('ringcentral-send-sms', async (_, request) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_isPlainObject(request) ||
      !Object.keys(request).every(key => ['phone', 'text'].includes(key))) {
    return { ok: false, error: 'Invalid text-message request.' };
  }
  const phone = _normalizeRcPhone(request.phone);
  const text = typeof request.text === 'string' ? request.text.trim() : '';
  if (!phone || !text || text.length > 5000 || text.includes('\0')) {
    return { ok: false, error: 'Enter a valid recipient and a message no longer than 5,000 characters.' };
  }
  const cutoff = Date.now() - 60 * 1000;
  while (rcSendTimestamps.length && rcSendTimestamps[0] < cutoff) rcSendTimestamps.shift();
  if (rcSendTimestamps.length >= 10) {
    return { ok: false, error: 'Text-message rate limit reached. Wait before sending again.' };
  }
  const vault = _loadSecretVault();
  const from = _normalizeRcPhone(vault[RC_SECRET_KEYS.myPhone]);
  if (!from) return { ok: false, error: 'Add your RingCentral number in Settings first.' };
  // MB1188-062: the slot is RESERVED here and given back if the send fails.
  //
  // Counting on attempt meant a flaky connection could exhaust the limit
  // without a single message going out; counting only on success would let
  // concurrent attempts slip past the check. Reserve, then refund.
  const rcReservedAt = Date.now();
  rcSendTimestamps.push(rcReservedAt);
  const result = await _ringCentralAuthedRequest(
    'POST',
    '/restapi/v1.0/account/~/extension/~/sms',
    { from: { phoneNumber: from }, to: [{ phoneNumber: phone }], text }
  );
  if (!result.ok) {
    const reserved = rcSendTimestamps.lastIndexOf(rcReservedAt);
    if (reserved !== -1) rcSendTimestamps.splice(reserved, 1);
    return { ok: false, error: result.error || 'RingCentral could not send the message.' };
  }
  const message = _normalizeRcMessage(result.data, 'outbound') || {
    id: String(Date.now()),
    from,
    fromName: '',
    to: [phone],
    body: text,
    createdAt: new Date().toISOString(),
    direction: 'outbound',
    readStatus: 'Read',
  };
  return { ok: true, message };
});

// ── IPC: iCloud Drive sync ─────────────────────────────────
function _resolveICloudDirectory() {
  const productionDirectory = path.join(
    os.homedir(),
    'Library',
    'Mobile Documents',
    'com~apple~CloudDocs',
    'Music Box Internal'
  );
  const override = process.env.MUSIC_BOX_E2E_ICLOUD_DIR;
  if (app.isPackaged || !override) return productionDirectory;

  const resolvedOverride = fs.realpathSync(path.resolve(override));
  const resolvedTempRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(resolvedTempRoot, resolvedOverride);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('MUSIC_BOX_E2E_ICLOUD_DIR must be an existing directory inside the system temporary directory.');
  }
  if (!fs.statSync(resolvedOverride).isDirectory()) {
    throw new Error('MUSIC_BOX_E2E_ICLOUD_DIR must name a directory.');
  }
  return resolvedOverride;
}

const ICLOUD_DIR = _resolveICloudDirectory();
const ICLOUD_SYNC_PATH = path.join(ICLOUD_DIR, 'sync.json');
let iCloudWriteChain = Promise.resolve();

// ─── V159-008: immutable per-device backup snapshots ────────────────────────
//
// Every Mac previously wrote the same `sync.json`. Two Macs could both report a
// successful backup while the later write silently replaced the earlier one, so
// a recovery point vanished. iCloud Drive offers no dependable CAS/generation to
// coordinate that, so the fix is to stop sharing a filename: each Mac writes its
// own immutable, timestamped snapshot and both recovery points survive.
//
// Legacy `sync.json` is still READ (newest-wins alongside snapshots) so existing
// backups keep working; it is never written again and never modified.
const ICLOUD_SNAPSHOT_PREFIX = 'sync-';
const ICLOUD_SNAPSHOT_SUFFIX = '.json';
const MAX_SNAPSHOTS_PER_DEVICE = 5;
const MAX_TOTAL_SNAPSHOTS = 40;
const SNAPSHOT_NAME_PATTERN =
  /^sync-([a-z0-9]{4,32})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;
// MB1188-014: the same name with a monotonic per-device sequence in front of
// the timestamp. Ordering a device's own snapshots by wall clock is wrong
// whenever that clock moves — daylight saving, an NTP correction, or a Mac
// whose date is simply set wrong — and the old name had nothing else to sort
// by. The sequence only ever increases, so a device's own history stays in
// order no matter what its clock does. Files written by earlier builds still
// match the pattern above and are read as sequence 0.
const SNAPSHOT_SEQ_NAME_PATTERN =
  /^sync-([a-z0-9]{4,32})-s(\d{9})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;
const SNAPSHOT_SEQ_FILE = 'icloud-snapshot-seq.json';
const MAX_SNAPSHOT_SEQ = 999999999;

function _backupDeviceId() {
  // Stable per-Mac, derived from the machine's own identifiers. Not a secret —
  // it only has to differ between machines so filenames never collide.
  const seed = `${os.hostname()}|${os.userInfo().username}|${app.getPath('userData')}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function _snapshotFileName(deviceId, sequence, when = new Date()) {
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  const seq = String(Math.min(Math.max(Number(sequence) || 0, 0), MAX_SNAPSHOT_SEQ)).padStart(9, '0');
  return `${ICLOUD_SNAPSHOT_PREFIX}${deviceId}-s${seq}-${stamp}${ICLOUD_SNAPSHOT_SUFFIX}`;
}

// Monotonic, and recoverable if the counter file is lost: the snapshots already
// in the folder are themselves the record of how far this device has got.
async function _nextSnapshotSequence(deviceId, existing) {
  const counterPath = path.join(app.getPath('userData'), SNAPSHOT_SEQ_FILE);
  let stored = 0;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(counterPath, 'utf8'));
    if (Number.isSafeInteger(parsed?.sequence) && parsed.sequence >= 0) stored = parsed.sequence;
  } catch (_) { /* first run, or the counter was lost — rebuilt below */ }
  let highestOnDisk = 0;
  for (const snapshot of existing || []) {
    if (snapshot.deviceId === deviceId) highestOnDisk = Math.max(highestOnDisk, snapshot.sequence || 0);
  }
  const next = Math.max(stored, highestOnDisk) + 1;
  try {
    await _atomicWriteFile(counterPath, JSON.stringify({ sequence: next }), 0o600);
  } catch (_) { /* the name still carries it, so a failure here costs nothing */ }
  return next;
}

async function _listBackupSnapshots() {
  let names;
  try { names = await fs.promises.readdir(ICLOUD_DIR); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map(name => {
      const seqMatch = SNAPSHOT_SEQ_NAME_PATTERN.exec(name);
      const match = seqMatch || SNAPSHOT_NAME_PATTERN.exec(name);
      if (!match) return null;
      const stamp = seqMatch ? match[3] : match[2];
      // Recover the ISO instant from the filesystem-safe stamp.
      const iso = stamp.replace(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
        '$1T$2:$3:$4.$5Z'
      );
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return null;
      return {
        name,
        deviceId: match[1],
        at,
        sequence: seqMatch ? Number(match[2]) : 0,
      };
    })
    .filter(Boolean)
    // MB1188-014: within one device, the sequence decides — it cannot go
    // backwards, and its clock can. Across devices there is no shared clock to
    // appeal to, so the timestamp is still used, and the reader treats it as a
    // hint rather than as truth (see _pruneBackupSnapshots and the per-key
    // revision checks the renderer applies to whatever is read).
    .sort((a, b) => {
      if (a.deviceId === b.deviceId) return b.sequence - a.sequence || b.at - a.at;
      return b.at - a.at || (a.name < b.name ? 1 : -1);
    });
}

// Retention is bounded per device AND overall, so one Mac cannot crowd another's
// recovery points out of the shared folder.
async function _pruneBackupSnapshots(snapshots) {
  const perDevice = new Map();
  const doomed = [];
  for (const snapshot of snapshots) {
    const kept = perDevice.get(snapshot.deviceId) || 0;
    if (kept >= MAX_SNAPSHOTS_PER_DEVICE) doomed.push(snapshot);
    else perDevice.set(snapshot.deviceId, kept + 1);
  }
  const survivors = snapshots.filter(s => !doomed.includes(s));

  // MB1188-014: the overall cap is applied round-robin across devices, newest
  // of each first, rather than by timestamp order.
  //
  // Sorted purely by time, one Mac whose clock is far ahead occupies the whole
  // front of the list, and every other Mac's recovery points are the ones
  // pruned away — the failure is silent and only discovered when a restore is
  // actually needed. Taking one per device in turn means a wrong clock costs
  // that device nothing and costs the others nothing either.
  const byDevice = new Map();
  for (const snapshot of survivors) {
    if (!byDevice.has(snapshot.deviceId)) byDevice.set(snapshot.deviceId, []);
    byDevice.get(snapshot.deviceId).push(snapshot);
  }
  const queues = [...byDevice.values()];
  const keep = new Set();
  let round = 0;
  while (keep.size < MAX_TOTAL_SNAPSHOTS && queues.some(queue => round < queue.length)) {
    for (const queue of queues) {
      if (round >= queue.length) continue;
      if (keep.size >= MAX_TOTAL_SNAPSHOTS) break;
      keep.add(queue[round]);
    }
    round += 1;
  }
  for (const extra of survivors) if (!keep.has(extra)) doomed.push(extra);
  for (const snapshot of doomed) {
    try { await fs.promises.unlink(path.join(ICLOUD_DIR, snapshot.name)); }
    catch (_) { /* a peer may have pruned it already */ }
  }
  return doomed.length;
}

async function _readBackupCandidate() {
  const snapshots = await _listBackupSnapshots();
  for (const snapshot of snapshots) {
    const full = path.join(ICLOUD_DIR, snapshot.name);
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile() || stat.size > MAX_SYNC_BYTES) continue;
      const parsed = JSON.parse(await fs.promises.readFile(full, 'utf8'));
      if (_isPlainObject(parsed)) return { data: parsed, source: snapshot.name, at: snapshot.at };
    } catch (_) { continue; } // a corrupt snapshot must not hide an older good one
  }
  // Fall back to the legacy shared file if no snapshot is usable.
  try {
    const stat = await fs.promises.stat(ICLOUD_SYNC_PATH);
    if (stat.isFile() && stat.size <= MAX_SYNC_BYTES) {
      const parsed = JSON.parse(await fs.promises.readFile(ICLOUD_SYNC_PATH, 'utf8'));
      if (_isPlainObject(parsed)) {
        return { data: parsed, source: 'sync.json', at: stat.mtimeMs, legacy: true };
      }
    }
  } catch (_) {}
  return null;
}

async function _atomicWriteFile(targetPath, contents, mode = 0o600) {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  let handle = null;
  try {
    handle = await fs.promises.open(tempPath, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
    try { await fs.promises.unlink(tempPath); } catch (_) {}
    throw error;
  }
}

_secureHandle('read-sync-file', async () => {
  try {
    await iCloudWriteChain;
    // V159-008: read the newest VALID snapshot. A corrupt newest file must not
    // hide an older good one, and the legacy shared sync.json remains readable.
    const candidate = await _readBackupCandidate();
    if (!candidate) return { ok: true, data: null };
    return {
      ok: true,
      data: candidate.data,
      source: candidate.source,
      legacy: candidate.legacy === true,
    };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});


// ── MB1188-085: the durability journal ───────────────────────────────────────
//
// The renderer stores everything in localStorage and treats setItem as an
// acknowledgement. It is not one: Chromium buffers LevelDB writes, so a save
// could be reported complete, be readable in the running process, and still be
// absent after a hard kill. A graceful quit was safe; sudden power loss or a
// crash was not. A timeout is not a durability contract, so this is a real
// on-disk commit instead.
//
// Deliberately narrow. localStorage stays the read path and the cache; this is
// a write-behind backstop that answers one question at startup: "is there a
// record on disk newer than what the cache came back with?"
//
// What crosses the boundary is CIPHERTEXT the renderer has already encrypted —
// main never sees plaintext human data, and never gains the ability to.
const JOURNAL_DIR = () => path.join(app.getPath('userData'), 'journal-v1');
const JOURNAL_KEY_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
// The largest legitimate record is a spreadsheet project document, capped at
// 600 KB of plaintext by MAX_SPREADSHEET_SYNC_JSON_BYTES — roughly 840 KB once
// encrypted. 2 MB leaves generous headroom while halving what a compromised
// renderer could put on the disk.
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_CAPSULE_BYTES = 6 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 200;
let _journalSeq = 0;

function _journalPath(key) {
  return path.join(JOURNAL_DIR(), `${key}.jrn`);
}

function _readJournalFile(fullPath, expectedKey = null) {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JOURNAL_CAPSULE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!_isPlainObject(parsed)) return null;
    if (expectedKey !== null && parsed.key !== expectedKey) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// The sequence has to survive a restart or a recovered record could look older
// than the stale one it is meant to replace. Derived from what is already on
// disk rather than stored separately, so there is no second thing to corrupt.
function _journalHighestSeq() {
  let highest = 0;
  let entries;
  try { entries = fs.readdirSync(JOURNAL_DIR()); } catch (_) { return 0; }
  for (const name of entries) {
    if (!name.endsWith('.jrn')) continue;
    const fileKey = name.slice(0, -4);
    if (!JOURNAL_KEY_PATTERN.test(fileKey) || fileKey === '__proto__' || fileKey === 'constructor') continue;
    const parsed = _readJournalFile(path.join(JOURNAL_DIR(), name), fileKey);
    if (Number.isSafeInteger(parsed?.seq) && parsed.seq > highest) highest = parsed.seq;
  }
  return highest;
}

_secureHandle('durable-journal-put', async (_, request) => {
  if (!_isPlainObject(request)) throw new Error('Invalid journal write.');
  const key = String(request.key ?? '');
  const ciphertext = request.ciphertext;
  // `__proto__` and `constructor` match the pattern and are never real store
  // keys. Refusing them costs nothing and keeps a class of surprise off disk.
  if (!JOURNAL_KEY_PATTERN.test(key) || key === '__proto__' || key === 'constructor') {
    throw new Error('Invalid journal key.');
  }
  if (typeof ciphertext !== 'string' || !ciphertext.length) {
    throw new Error('The journal takes encrypted text only.');
  }
  if (Buffer.byteLength(ciphertext, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new Error('This record is too large to journal.');
  }
  // Refuse plaintext outright. Every value the renderer commits is prefixed by
  // its own encryption; anything else is a bug that must not reach disk.
  if (!ciphertext.startsWith('E:')) throw new Error('The journal takes encrypted text only.');

  const schemaVersion = request.schemaVersion === 2 ? 2 : 1;
  const previousCiphertext = request.previousCiphertext === null || request.previousCiphertext === undefined
    ? null
    : request.previousCiphertext;
  if (previousCiphertext !== null &&
      (typeof previousCiphertext !== 'string' || !previousCiphertext.startsWith('E:') ||
       Buffer.byteLength(previousCiphertext, 'utf8') > MAX_JOURNAL_BYTES)) {
    throw new Error('The journal predecessor is invalid.');
  }
  const pendingSync = request.pendingSync === null || request.pendingSync === undefined
    ? null
    : request.pendingSync;
  if (pendingSync !== null &&
      (typeof pendingSync !== 'string' || Buffer.byteLength(pendingSync, 'utf8') > 4 * 1024 * 1024)) {
    throw new Error('The journal pending operation is invalid.');
  }
  const revision = request.revision === null || request.revision === undefined
    ? null
    : request.revision;
  if (revision !== null && (typeof revision !== 'string' || !/^\d+$/.test(revision) ||
      !Number.isSafeInteger(Number(revision)) || Number(revision) < 0)) {
    throw new Error('The journal revision is invalid.');
  }
  const localTimestamp = request.localTimestamp === null || request.localTimestamp === undefined
    ? null
    : request.localTimestamp;
  if (localTimestamp !== null && (typeof localTimestamp !== 'string' || localTimestamp.length > 100 ||
      !Number.isFinite(Date.parse(localTimestamp)))) {
    throw new Error('The journal timestamp is invalid.');
  }

  fs.mkdirSync(JOURNAL_DIR(), { recursive: true, mode: 0o700 });
  if (!_journalSeq) _journalSeq = _journalHighestSeq();
  // A bounded directory: one entry per key, and a ceiling so a runaway key set
  // cannot fill the disk.
  let existing = [];
  try { existing = fs.readdirSync(JOURNAL_DIR()).filter(n => n.endsWith('.jrn')); } catch (_) {}
  if (existing.length >= MAX_JOURNAL_ENTRIES && !fs.existsSync(_journalPath(key))) {
    throw new Error('The journal is full.');
  }
  const seq = ++_journalSeq;
  const entry = {
    key,
    seq,
    ciphertext,
    schemaVersion,
    previousCiphertext,
    pendingSync,
    revision,
    localTimestamp,
  };
  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_CAPSULE_BYTES) {
    throw new Error('This journal capsule is too large.');
  }
  // _atomicWriteFileSync fsyncs the data, renames, then fsyncs the directory,
  // so this returns only once the bytes are genuinely on disk. That is the
  // whole point: the renderer awaits this before calling a save complete.
  _atomicWriteFileSync(_journalPath(key), serialized, 0o600);
  return { ok: true, seq };
});

_secureHandle('durable-journal-ack', async (_, request) => {
  if (!_isPlainObject(request)) throw new Error('Invalid journal acknowledgement.');
  const key = String(request.key ?? '');
  const opId = String(request.opId ?? '');
  if (!JOURNAL_KEY_PATTERN.test(key) || key === '__proto__' || key === 'constructor' ||
      opId.length < 8 || opId.length > 512) {
    throw new Error('Invalid journal acknowledgement.');
  }
  const parsed = _readJournalFile(_journalPath(key), key);
  if (!parsed) return { ok: true, unchanged: true };
  if (!_isPlainObject(parsed) || parsed.schemaVersion !== 2 || parsed.pendingSync === null) {
    return { ok: true, unchanged: true };
  }
  let pending;
  try { pending = JSON.parse(parsed.pendingSync); } catch (_) { return { ok: true, unchanged: true }; }
  if (!_isPlainObject(pending) || pending.opId !== opId) {
    return { ok: true, unchanged: true };
  }
  parsed.pendingSync = null;
  _atomicWriteFileSync(_journalPath(key), JSON.stringify(parsed), 0o600);
  return { ok: true };
});

_secureHandle('durable-journal-read', async () => {
  const records = [];
  let entries;
  try { entries = fs.readdirSync(JOURNAL_DIR()); } catch (_) { return { ok: true, records }; }
  for (const name of entries) {
    if (!name.endsWith('.jrn')) continue;
    const fileKey = name.slice(0, -4);
    if (!JOURNAL_KEY_PATTERN.test(fileKey) || fileKey === '__proto__' || fileKey === 'constructor') continue;
    try {
      const parsed = _readJournalFile(path.join(JOURNAL_DIR(), name), fileKey);
      // A half-written or corrupt entry is DROPPED, never repaired and never
      // fatal: it can only ever be a copy of something localStorage may still
      // hold, and refusing to start over it would be the worse failure.
      if (!parsed || !Number.isSafeInteger(parsed.seq) || parsed.seq <= 0 ||
          typeof parsed.ciphertext !== 'string' || !parsed.ciphertext.startsWith('E:') ||
          Buffer.byteLength(parsed.ciphertext, 'utf8') > MAX_JOURNAL_BYTES) continue;
      const record = { key: parsed.key, seq: parsed.seq, ciphertext: parsed.ciphertext };
      if (parsed.schemaVersion === 2) {
        const predecessorValid = parsed.previousCiphertext === null ||
          (typeof parsed.previousCiphertext === 'string' && parsed.previousCiphertext.startsWith('E:') &&
           Buffer.byteLength(parsed.previousCiphertext, 'utf8') <= MAX_JOURNAL_BYTES);
        const pendingValid = parsed.pendingSync === null ||
          (typeof parsed.pendingSync === 'string' && Buffer.byteLength(parsed.pendingSync, 'utf8') <= 4 * 1024 * 1024);
        const revisionValid = parsed.revision === null ||
          (typeof parsed.revision === 'string' && /^\d+$/.test(parsed.revision) &&
           Number.isSafeInteger(Number(parsed.revision)) && Number(parsed.revision) >= 0);
        const timestampValid = parsed.localTimestamp === null ||
          (typeof parsed.localTimestamp === 'string' && parsed.localTimestamp.length <= 100 &&
           Number.isFinite(Date.parse(parsed.localTimestamp)));
        if (!predecessorValid || !pendingValid || !revisionValid || !timestampValid) continue;
        Object.assign(record, {
          schemaVersion: 2,
          previousCiphertext: parsed.previousCiphertext,
          pendingSync: parsed.pendingSync,
          revision: parsed.revision,
          localTimestamp: parsed.localTimestamp,
        });
      }
      records.push(record);
    } catch (_) { continue; }
  }
  return { ok: true, records };
});

_secureHandle('write-sync-file', async (_, data) => {
  if (!_isPlainObject(data)) return { ok: false, error: 'The iCloud backup has an invalid format.' };
  let serialized;
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch (_) {
    return { ok: false, error: 'The iCloud backup could not be serialized.' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SYNC_BYTES) {
    return { ok: false, error: 'The iCloud backup exceeds the 8 MB limit.' };
  }
  const write = iCloudWriteChain.then(async () => {
    try {
      await fs.promises.mkdir(ICLOUD_DIR, { recursive: true, mode: 0o700 });
      // V159-008: never overwrite a shared filename. Each Mac writes its own
      // immutable snapshot so a concurrent backup on another Mac cannot destroy
      // this recovery point (and vice versa).
      const deviceId = _backupDeviceId();
      const existing = await _listBackupSnapshots().catch(() => []);
      const name = _snapshotFileName(deviceId, await _nextSnapshotSequence(deviceId, existing));
      await _atomicWriteFile(path.join(ICLOUD_DIR, name), serialized, 0o600);
      let pruned = 0;
      try { pruned = await _pruneBackupSnapshots(await _listBackupSnapshots()); }
      catch (_) { /* retention is best-effort; the new snapshot is already safe */ }
      return { ok: true, snapshot: name, pruned };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  });
  iCloudWriteChain = write.then(() => undefined, () => undefined);
  return write;
});

_secureHandle('export-spreadsheet-recovery', async (_, contents) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (typeof contents !== 'string' || contents.length < 1 ||
      Buffer.byteLength(contents, 'utf8') > MAX_SPREADSHEET_RECOVERY_BYTES) {
    return { ok: false, error: 'The spreadsheet recovery file is invalid or exceeds the 8 MB limit.' };
  }
  try {
    const parsed = JSON.parse(contents);
    if (!_isPlainObject(parsed)) {
      return { ok: false, error: 'The spreadsheet recovery file must contain workbook data.' };
    }
    const saveResult = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Export Spreadsheet Recovery Data',
      defaultPath: path.join(
        app.getPath('documents'),
        `Music-Box-Spreadsheets-Recovery-${new Date().toISOString().slice(0, 10)}.json`
      ),
      filters: [{ name: 'JSON Data', extensions: ['json'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: true, canceled: true };
    }
    const destination = saveResult.filePath.toLowerCase().endsWith('.json')
      ? saveResult.filePath
      : `${saveResult.filePath}.json`;
    await _atomicWriteFile(destination, contents, 0o600);
    return { ok: true, canceled: false, fileName: path.basename(destination) };
  } catch (error) {
    return { ok: false, error: error?.message || 'The recovery file could not be saved.' };
  }
});

_secureHandle('open-external', async (_, url) => {
  if (!_safeExternalUrl(url)) return { ok: false, error: 'This external destination is not approved.' };
  try { await shell.openExternal(url); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});

function _safePdfFileName(value) {
  const raw = typeof value === 'string' ? value : 'Music-Box-Receipt.pdf';
  let name = path.basename(raw)
    .replace(/[\u0000-\u001f\u007f/:\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!name) name = 'Music-Box-Receipt.pdf';
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  return name;
}

// ── IPC: PDF generation — renders receipt HTML in an isolated, networkless
// window and writes the result only to a user-confirmed save destination.
_secureHandle('print-to-pdf', async (_, html, suggestedName) => {
  if (typeof html !== 'string' || html.length < 1 || Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) {
    return { ok: false, error: 'Receipt HTML is invalid or exceeds the 2 MB limit.' };
  }
  const nonce = crypto.randomBytes(12).toString('hex');
  const tmpFile = path.join(os.tmpdir(), `mb-receipt-${nonce}.html`);
  let pdfWin = null;
  try {
    await fs.promises.writeFile(tmpFile, html, { encoding: 'utf8', mode: 0o600 });
    const pdfSession = session.fromPartition(`pdf-${nonce}`);
    pdfSession.webRequest.onBeforeRequest(
      { urls: ['file://*/*', 'http://*/*', 'https://*/*'] },
      (details, callback) => {
        const isOwnTopDocument = details.resourceType === 'mainFrame' &&
          _isExactFileUrl(details.url, tmpFile);
        callback({ cancel: !isOwnTopDocument });
      }
    );
    pdfWin = new BrowserWindow({
      show: false,
      width: 816,
      height: 1056,
      webPreferences: {
        session: pdfSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
        allowFileAccessFromFileURLs: false,
        allowUniversalAccessFromFileURLs: false,
        webviewTag: false,
        devTools: false,
      },
    });
    await pdfWin.loadFile(tmpFile);
    await new Promise(r => setTimeout(r, 900));
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      pageSize: 'Letter',
      printBackground: false,
      margins: { marginType: 'custom', top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
    });
    pdfWin.destroy();
    try { await fs.promises.unlink(tmpFile); } catch(_) {}
    if (pdfBuffer.length > 20 * 1024 * 1024) {
      return { ok: false, error: 'Generated PDF exceeds the 20 MB limit.' };
    }
    const saveResult = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Save Music Box PDF',
      defaultPath: path.join(app.getPath('documents'), _safePdfFileName(suggestedName)),
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: true, canceled: true };
    }
    const destination = saveResult.filePath.toLowerCase().endsWith('.pdf')
      ? saveResult.filePath
      : `${saveResult.filePath}.pdf`;
    await _atomicWriteFile(destination, pdfBuffer, 0o600);
    return { ok: true, canceled: false, fileName: path.basename(destination) };
  } catch(e) {
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
    try { await fs.promises.unlink(tmpFile); } catch(_) {}
    return { ok: false, error: e.message };
  }
});

// ── IPC: MS PKCE token exchange ───────────────────────────────
function _msTokenPost(tenant, body) {
  return new Promise((resolve) => {
    if (!_validTenant(tenant) || !_isPlainObject(body)) {
      resolve({ ok: false, error: 'invalid_request', error_description: 'Invalid Microsoft token request.' });
      return;
    }
    const bodyStr = new URLSearchParams(body).toString();
    if (Buffer.byteLength(bodyStr, 'utf8') > 128 * 1024) {
      resolve({ ok: false, error: 'invalid_request', error_description: 'Microsoft token request is too large.' });
      return;
    }
    const options = {
      hostname: 'login.microsoftonline.com',
      path: `/${tenant}/oauth2/v2.0/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = https.request(options, (res) => {
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          res.destroy();
          finish({ ok: false, error: 'response_too_large', error_description: 'Microsoft returned an oversized response.' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!_isPlainObject(parsed)) throw new Error('Invalid response.');
          if (res.statusCode < 200 || res.statusCode >= 300 || parsed.error) {
            finish({
              ok: false,
              error: String(parsed.error || `http_${res.statusCode}`).slice(0, 100),
              error_description: String(parsed.error_description || 'Microsoft rejected the token request.').slice(0, 1000),
            });
            return;
          }
          if (!_boundedString(parsed.access_token, MAX_IPC_STRING)) {
            finish({ ok: false, error: 'invalid_response', error_description: 'Microsoft did not return a valid access token.' });
            return;
          }
          finish({
            ok: true,
            access_token: parsed.access_token,
            refresh_token: _boundedString(parsed.refresh_token, MAX_IPC_STRING) ? parsed.refresh_token : null,
            expires_in: Math.max(60, Math.min(86400, Number(parsed.expires_in) || 3600)),
            token_type: String(parsed.token_type || 'Bearer').slice(0, 32),
            scope: String(parsed.scope || '').slice(0, 1000),
          });
        } catch(e) {
          finish({ ok: false, error: 'invalid_response', error_description: 'Microsoft returned an invalid token response.' });
        }
      });
      res.on('error', () => finish({ ok: false, error: 'network_error', error_description: 'Microsoft sign-in response failed.' }));
    });
    req.setTimeout(15000, () => {
      req.destroy();
      finish({ ok: false, error: 'timeout', error_description: 'Microsoft sign-in timed out.' });
    });
    req.on('error', () => finish({ ok: false, error: 'network_error', error_description: 'Could not reach Microsoft sign-in.' }));
    req.write(bodyStr);
    req.end();
  });
}

const MS_ACCOUNT_VAULT_PREFIX = 'microsoft_account_v1_';
const msRefreshInFlight = new Map();
const msSendTimestamps = [];

function _validMsAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function _normalizeMsAccountMetadata(value) {
  if (!_isPlainObject(value) || !_validMsAccountId(value.id) ||
      !_validTenant(value.tenant) || !_isUuid(value.clientId)) {
    return null;
  }
  return { id: value.id, tenant: value.tenant, clientId: value.clientId };
}

function _msAccountVaultKey(accountId) {
  if (!_validMsAccountId(accountId)) throw new Error('Invalid Microsoft account ID.');
  return MS_ACCOUNT_VAULT_PREFIX + accountId;
}

function _validMsBearer(value) {
  return typeof value === 'string' && value.length >= 20 &&
    value.length <= MAX_IPC_STRING && !/[\u0000-\u0020\u007f]/.test(value);
}

function _validMsAccountRecord(record) {
  return _isPlainObject(record) && record.version === 1 &&
    _validMsAccountId(record.accountId) && _validTenant(record.tenant) &&
    _isUuid(record.clientId) &&
    (record.accessToken === null || _validMsBearer(record.accessToken)) &&
    (record.refreshToken === null || _validMsBearer(record.refreshToken)) &&
    Number.isSafeInteger(record.expiresAt) && record.expiresAt >= 0;
}

function _migrateLegacyMsRecord(vault, metadata) {
  const recordKey = _msAccountVaultKey(metadata.id);
  const existing = vault[recordKey];
  if (existing !== undefined) {
    if (!_validMsAccountRecord(existing)) {
      throw new Error('The protected Microsoft account record is invalid.');
    }
    return existing;
  }

  const legacyAccessKey = `ms_access_${metadata.id}`;
  const legacyRefreshKey = `ms_refresh_${metadata.id}`;
  const legacyExpiryKey = `ms_expiry_${metadata.id}`;
  const accessToken = vault[legacyAccessKey];
  const refreshToken = vault[legacyRefreshKey];
  const expiresAt = Number(vault[legacyExpiryKey] || 0);
  if (!_validMsBearer(accessToken) && !_validMsBearer(refreshToken)) return null;

  const record = {
    version: 1,
    accountId: metadata.id,
    tenant: metadata.tenant,
    clientId: metadata.clientId,
    accessToken: _validMsBearer(accessToken) ? accessToken : null,
    refreshToken: _validMsBearer(refreshToken) ? refreshToken : null,
    expiresAt: Number.isSafeInteger(expiresAt) && expiresAt >= 0 ? expiresAt : 0,
  };
  vault[recordKey] = record;
  delete vault[legacyAccessKey];
  delete vault[legacyRefreshKey];
  delete vault[legacyExpiryKey];
  _saveSecretVault(vault);
  return record;
}

function _loadMsAccountRecord(accountId) {
  const vault = _loadSecretVault();
  const record = vault[_msAccountVaultKey(accountId)];
  if (record === undefined) return { vault, record: null };
  if (!_validMsAccountRecord(record)) {
    throw new Error('The protected Microsoft account record is invalid.');
  }
  return { vault, record };
}

function _msPublicStatus(accountId, record) {
  const hasAccess = !!record?.accessToken && record.expiresAt > Date.now();
  const hasRefresh = !!record?.refreshToken;
  return {
    accountId,
    connected: hasAccess || hasRefresh,
    hasRefresh,
    expiresAt: hasAccess ? record.expiresAt : 0,
  };
}

function _saveMsTokenResult(metadata, result, priorRecord = null) {
  if (!result?.ok || !_validMsBearer(result.access_token)) {
    throw new Error('Microsoft did not return a valid access token.');
  }
  const vault = _loadSecretVault();
  const current = priorRecord || vault[_msAccountVaultKey(metadata.id)] || null;
  const record = {
    version: 1,
    accountId: metadata.id,
    tenant: metadata.tenant,
    clientId: metadata.clientId,
    accessToken: result.access_token,
    refreshToken: _validMsBearer(result.refresh_token)
      ? result.refresh_token
      : (_validMsBearer(current?.refreshToken) ? current.refreshToken : null),
    expiresAt: Date.now() + Math.max(60, Math.min(86400, Number(result.expires_in) || 3600)) * 1000,
  };
  vault[_msAccountVaultKey(metadata.id)] = record;
  for (const kind of ['access', 'refresh', 'expiry']) delete vault[`ms_${kind}_${metadata.id}`];
  _saveSecretVault(vault);
  return record;
}

async function _refreshMicrosoftAccount(accountId, force = false) {
  if (msRefreshInFlight.has(accountId)) return msRefreshInFlight.get(accountId);
  const refresh = (async () => {
    const { record } = _loadMsAccountRecord(accountId);
    if (!record) return { ok: false, error: 'Microsoft account is not connected.' };
    if (!force && record.accessToken && record.expiresAt > Date.now() + 10 * 60 * 1000) {
      return { ok: true, token: record.accessToken, record };
    }
    if (!_validMsBearer(record.refreshToken)) {
      if (record.accessToken && record.expiresAt > Date.now()) {
        return { ok: true, token: record.accessToken, record };
      }
      return { ok: false, error: 'Microsoft sign-in has expired. Reconnect this account.' };
    }
    const result = await _msTokenPost(record.tenant, {
      client_id: record.clientId,
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
      scope: 'Mail.Read Mail.Send User.Read offline_access',
    });
    if (!result.ok) {
      return {
        ok: false,
        error: String(result.error_description || result.error || 'Microsoft refresh failed.').slice(0, 500),
      };
    }
    const saved = _saveMsTokenResult({
      id: record.accountId,
      tenant: record.tenant,
      clientId: record.clientId,
    }, result, record);
    return { ok: true, token: saved.accessToken, record: saved };
  })();
  msRefreshInFlight.set(accountId, refresh);
  try {
    return await refresh;
  } finally {
    if (msRefreshInFlight.get(accountId) === refresh) msRefreshInFlight.delete(accountId);
  }
}

function _microsoftGraphRequest({ token, method, requestPath, body = null }) {
  return new Promise((resolve) => {
    if (!_validMsBearer(token) || !['GET', 'POST'].includes(method) ||
        typeof requestPath !== 'string' || !requestPath.startsWith('/v1.0/me/')) {
      resolve({ ok: false, error: 'Invalid Microsoft Graph request.' });
      return;
    }
    const serialized = body === null ? null : JSON.stringify(body);
    if (serialized !== null && Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
      resolve({ ok: false, error: 'Microsoft mail request is too large.' });
      return;
    }
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = https.request({
      protocol: 'https:',
      hostname: 'graph.microsoft.com',
      port: 443,
      method,
      path: requestPath,
      timeout: 20000,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(serialized === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized, 'utf8'),
        }),
        'user-agent': `MusicBoxInternal/${app.getVersion()}`,
      },
    }, (res) => {
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          res.destroy();
          finish({ ok: false, error: 'Microsoft Graph response exceeded 8 MB.' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch (_) {
            finish({ ok: false, status: res.statusCode, error: 'Microsoft Graph returned an invalid response.' });
            return;
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = typeof parsed?.error?.message === 'string'
            ? parsed.error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
            : `HTTP ${res.statusCode}`;
          finish({ ok: false, status: res.statusCode, error: `Microsoft Graph request failed: ${detail}` });
          return;
        }
        finish({ ok: true, status: res.statusCode, data: parsed });
      });
      res.on('error', () => finish({ ok: false, error: 'Microsoft Graph response failed.' }));
    });
    req.on('timeout', () => req.destroy(new Error('Microsoft Graph request timed out.')));
    req.on('error', (error) => {
      finish({ ok: false, error: String(error?.message || 'Microsoft Graph request failed.').slice(0, 300) });
    });
    if (serialized !== null) req.write(serialized);
    req.end();
  });
}

async function _microsoftAuthedGraphRequest(accountId, method, requestPath, body = null) {
  let auth = await _refreshMicrosoftAccount(accountId);
  if (!auth.ok) return auth;
  let result = await _microsoftGraphRequest({ token: auth.token, method, requestPath, body });
  if (result.status === 401) {
    auth = await _refreshMicrosoftAccount(accountId, true);
    if (!auth.ok) return auth;
    result = await _microsoftGraphRequest({ token: auth.token, method, requestPath, body });
  }
  return result;
}

function _boundedMicrosoftText(value, max) {
  return typeof value === 'string'
    ? value.replace(/\0/g, '').slice(0, max)
    : '';
}

function _normalizeMicrosoftAddress(value) {
  if (!_isPlainObject(value?.emailAddress)) return null;
  const address = _boundedMicrosoftText(value.emailAddress.address, 320).trim();
  if (!address || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return null;
  return {
    emailAddress: {
      address,
      name: _boundedMicrosoftText(value.emailAddress.name, 256),
    },
  };
}

function _normalizeMicrosoftMail(value, folder) {
  if (!_isPlainObject(value)) return null;
  const normalized = {
    id: _boundedMicrosoftText(value.id, 512),
    conversationId: _boundedMicrosoftText(value.conversationId, 512) || null,
    subject: _boundedMicrosoftText(value.subject, 1000),
    bodyPreview: _boundedMicrosoftText(value.bodyPreview, 5000),
    body: {
      contentType: value.body?.contentType === 'html' || value.body?.contentType === 'HTML'
        ? 'html' : 'text',
      content: _boundedMicrosoftText(value.body?.content, 250000),
    },
  };
  if (folder === 'inbox') {
    normalized.from = _normalizeMicrosoftAddress(value.from);
    normalized.receivedDateTime = _boundedMicrosoftText(value.receivedDateTime, 64);
    normalized.isRead = value.isRead === true;
    normalized.inferenceClassification =
      value.inferenceClassification === 'focused' ? 'focused' :
        (value.inferenceClassification === 'other' ? 'other' : null);
  } else {
    normalized.toRecipients = Array.isArray(value.toRecipients)
      ? value.toRecipients.slice(0, 20).map(_normalizeMicrosoftAddress).filter(Boolean)
      : [];
    normalized.sentDateTime = _boundedMicrosoftText(value.sentDateTime, 64);
  }
  return normalized.id ? normalized : null;
}

function _validMicrosoftSendRequest(request) {
  if (!_isPlainObject(request) ||
      !Object.keys(request).every(key => ['accountId', 'message', 'saveToSentItems'].includes(key)) ||
      !_validMsAccountId(request.accountId) || request.saveToSentItems !== true ||
      !_isPlainObject(request.message) ||
      !Object.keys(request.message).every(key => ['subject', 'body', 'toRecipients'].includes(key)) ||
      typeof request.message.subject !== 'string' ||
      request.message.subject.length > 998 || /[\r\n\0]/.test(request.message.subject) ||
      !_isPlainObject(request.message.body) ||
      !Object.keys(request.message.body).every(key => ['contentType', 'content'].includes(key)) ||
      !['Text', 'HTML'].includes(request.message.body.contentType) ||
      typeof request.message.body.content !== 'string' ||
      request.message.body.content.length < 1 ||
      Buffer.byteLength(request.message.body.content, 'utf8') > 512 * 1024 ||
      request.message.body.content.includes('\0') ||
      !Array.isArray(request.message.toRecipients) ||
      request.message.toRecipients.length < 1 || request.message.toRecipients.length > 20) {
    return false;
  }
  return request.message.toRecipients.every((recipient) => {
    if (!_isPlainObject(recipient) || !_isPlainObject(recipient.emailAddress) ||
        !Object.keys(recipient).every(key => key === 'emailAddress') ||
        !Object.keys(recipient.emailAddress).every(key => ['address', 'name'].includes(key))) {
      return false;
    }
    const address = recipient.emailAddress.address;
    const name = recipient.emailAddress.name;
    return typeof address === 'string' && address.length <= 320 &&
      /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) &&
      (name === undefined ||
       (typeof name === 'string' && name.length <= 256 && !/[\r\n\0]/.test(name)));
  });
}

_secureHandle('begin-ms-oauth', async (_, request) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(request)) throw new Error('Invalid Microsoft OAuth request.');
  return _beginMicrosoftOAuth(request);
});

_secureHandle('exchange-ms-code', async (_, request) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(request)) {
    return { ok: false, error: 'invalid_request', error_description: 'Invalid Microsoft OAuth exchange.' };
  }
  const { accountId, state, codeVerifier } = request;
  const matchesPending = pendingOAuth &&
    pendingOAuth.callbackReceived &&
    Date.now() <= pendingOAuth.expiresAt &&
    state === pendingOAuth.state &&
    accountId === pendingOAuth.accountId;
  if (!matchesPending || !_validPkceChallenge(codeVerifier)) {
    return { ok: false, error: 'invalid_state', error_description: 'The sign-in attempt expired or did not match this app session.' };
  }
  const verifierChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const verifierBuffer = Buffer.from(verifierChallenge);
  const expectedBuffer = Buffer.from(pendingOAuth.codeChallenge);
  if (verifierBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(verifierBuffer, expectedBuffer)) {
    pendingOAuth = null;
    return { ok: false, error: 'invalid_verifier', error_description: 'The sign-in verifier did not match.' };
  }
  const attempt = pendingOAuth;
  pendingOAuth = null; // One-time use, including failed exchanges.
  const result = await _msTokenPost(attempt.tenant, {
    client_id: attempt.clientId,
    code: attempt.code,
    redirect_uri: attempt.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
    scope: 'Mail.Read Mail.Send User.Read offline_access',
  });
  if (!result.ok) {
    return {
      ok: false,
      error: String(result.error || 'token_exchange_failed').slice(0, 100),
      error_description: String(result.error_description || 'Microsoft sign-in failed.').slice(0, 500),
    };
  }
  const record = _saveMsTokenResult({
    id: attempt.accountId,
    tenant: attempt.tenant,
    clientId: attempt.clientId,
  }, result);
  return { ok: true, ..._msPublicStatus(attempt.accountId, record) };
});

_secureHandle('microsoft-status', async (_, accounts) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!Array.isArray(accounts) || accounts.length > 20) {
    throw new Error('Invalid Microsoft account list.');
  }
  const metadata = accounts.map(_normalizeMsAccountMetadata);
  if (metadata.some(value => !value)) throw new Error('Invalid Microsoft account list.');
  const vault = _loadSecretVault();
  const statuses = metadata.map((account) => {
    const record = _migrateLegacyMsRecord(vault, account);
    return _msPublicStatus(account.id, record);
  });
  return { ok: true, accounts: statuses };
});

_secureHandle('microsoft-migrate-legacy', async (_, request) => {
  _requireAppRole(new Set(['Owner']));
  if (!_isPlainObject(request) ||
      !Object.keys(request).every(key =>
        ['account', 'accessToken', 'refreshToken', 'expiresAt'].includes(key))) {
    throw new Error('Invalid legacy Microsoft migration.');
  }
  const metadata = _normalizeMsAccountMetadata(request.account);
  if (!metadata || (!_validMsBearer(request.accessToken) && !_validMsBearer(request.refreshToken))) {
    throw new Error('Invalid legacy Microsoft migration.');
  }
  const vault = _loadSecretVault();
  const key = _msAccountVaultKey(metadata.id);
  let record = vault[key];
  if (record !== undefined && !_validMsAccountRecord(record)) {
    throw new Error('The protected Microsoft account record is invalid.');
  }
  if (!record) {
    const expiresAt = Number(request.expiresAt || 0);
    record = {
      version: 1,
      accountId: metadata.id,
      tenant: metadata.tenant,
      clientId: metadata.clientId,
      accessToken: _validMsBearer(request.accessToken) ? request.accessToken : null,
      refreshToken: _validMsBearer(request.refreshToken) ? request.refreshToken : null,
      expiresAt: Number.isSafeInteger(expiresAt) && expiresAt >= 0 ? expiresAt : 0,
    };
    vault[key] = record;
    _saveSecretVault(vault);
  }
  return { ok: true, ..._msPublicStatus(metadata.id, record) };
});

_secureHandle('microsoft-refresh', async (_, accountId) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_validMsAccountId(accountId)) throw new Error('Invalid Microsoft account ID.');
  const result = await _refreshMicrosoftAccount(accountId, true);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, ..._msPublicStatus(accountId, result.record) };
});

_secureHandle('microsoft-fetch-mail', async (_, request) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_isPlainObject(request) ||
      !Object.keys(request).every(key => ['accountId', 'folder', 'limit'].includes(key)) ||
      !_validMsAccountId(request.accountId) ||
      !['inbox', 'sent'].includes(request.folder) ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    return { ok: false, error: 'Invalid Microsoft mail request.' };
  }
  const select = request.folder === 'inbox'
    ? 'id,conversationId,subject,from,bodyPreview,body,receivedDateTime,isRead,inferenceClassification'
    : 'id,conversationId,toRecipients,subject,bodyPreview,body,sentDateTime';
  const folderPath = request.folder === 'inbox' ? 'messages' : 'mailFolders/SentItems/messages';
  const orderField = request.folder === 'inbox' ? 'receivedDateTime' : 'sentDateTime';
  const requestPath = `/v1.0/me/${folderPath}?$top=${request.limit}&$select=${select}&$orderby=${orderField}%20desc`;
  const result = await _microsoftAuthedGraphRequest(request.accountId, 'GET', requestPath);
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  const values = Array.isArray(result.data?.value)
    ? result.data.value.slice(0, request.limit)
      .map(value => _normalizeMicrosoftMail(value, request.folder))
      .filter(Boolean)
    : [];
  return { ok: true, value: values };
});

_secureHandle('microsoft-send-mail', async (_, request) => {
  _requireAppRole(COMMUNICATION_ROLES);
  if (!_validMicrosoftSendRequest(request)) {
    return { ok: false, error: 'Invalid Microsoft send-mail request.' };
  }
  const cutoff = Date.now() - 60 * 1000;
  while (msSendTimestamps.length && msSendTimestamps[0] < cutoff) msSendTimestamps.shift();
  if (msSendTimestamps.length >= 30) {
    return { ok: false, error: 'Email rate limit reached. Wait before sending again.' };
  }
  // MB1188-062: reserved, then refunded on failure. See the RingCentral note.
  const msReservedAt = Date.now();
  msSendTimestamps.push(msReservedAt);
  const result = await _microsoftAuthedGraphRequest(
    request.accountId,
    'POST',
    '/v1.0/me/sendMail',
    { message: request.message, saveToSentItems: true },
  );
  if (!result.ok) {
    const reserved = msSendTimestamps.lastIndexOf(msReservedAt);
    if (reserved !== -1) msSendTimestamps.splice(reserved, 1);
    return { ok: false, status: result.status, error: result.error };
  }
  return { ok: true };
});

_secureHandle('microsoft-disconnect', async (_, accountId) => {
  _requireAppRole(new Set(['Owner']));
  if (!_validMsAccountId(accountId)) throw new Error('Invalid Microsoft account ID.');
  const vault = _loadSecretVault();
  delete vault[_msAccountVaultKey(accountId)];
  for (const kind of ['access', 'refresh', 'expiry']) delete vault[`ms_${kind}_${accountId}`];
  _saveSecretVault(vault);
  msRefreshInFlight.delete(accountId);
  return { ok: true, accountId, connected: false, hasRefresh: false, expiresAt: 0 };
});
