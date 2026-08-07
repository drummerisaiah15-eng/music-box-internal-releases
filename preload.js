const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback function is required.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Expose ONLY the keychain bridge to the renderer — nothing else
// The renderer has no access to Node.js or Electron internals
contextBridge.exposeInMainWorld('electronKeychain', {
  encrypt: (plaintext) => ipcRenderer.invoke('keychain-encrypt', plaintext),
  decrypt: (b64)       => ipcRenderer.invoke('keychain-decrypt', b64),
  available: true,
});

// App-session bridge. Owner authentication is verified and rate-limited in
// main; added profiles are persisted by main and are always Front Desk role.
contextBridge.exposeInMainWorld('electronSession', {
  authenticateOwner: (pin) => ipcRenderer.invoke('app-session-authenticate-owner', pin),
  startStaff:        (name) => ipcRenderer.invoke('app-session-start-staff', name),
  listProfiles:      () => ipcRenderer.invoke('app-session-list-profiles'),
  addStaffProfile:   (name) => ipcRenderer.invoke('app-session-add-staff-profile', name),
  removeStaffProfile:(name) => ipcRenderer.invoke('app-session-remove-staff-profile', name),
  setProfileRole:    (request) => ipcRenderer.invoke('app-session-set-profile-role', request),
  // V159-005: the renderer only transports the directory; main re-validates
  // every field and can never be told to grant Owner.
  exportDirectory:   () => ipcRenderer.invoke('app-session-export-directory'),
  importDirectory:   (directory) => ipcRenderer.invoke('app-session-import-directory', directory),
  end:               () => ipcRenderer.invoke('app-session-end'),
  status:            () => ipcRenderer.invoke('app-session-status'),
  stageOwnerPin:     (request) => ipcRenderer.invoke('app-session-stage-owner-pin', request),
  commitOwnerPin:    (rotationId) => ipcRenderer.invoke('app-session-commit-owner-pin', rotationId),
  cancelOwnerPin:    (rotationId) => ipcRenderer.invoke('app-session-cancel-owner-pin', rotationId),
});

// OAuth bridge — main owns the random loopback listener, authorization code,
// state, redirect URI, token endpoint, and saved tokens.
contextBridge.exposeInMainWorld('electronAuth', {
  begin:        (params) => ipcRenderer.invoke('begin-ms-oauth', params),
  // The renderer receives only a completion state; the authorization code
  // remains in main until the one-time PKCE exchange.
  onMsCode:     (cb) => subscribe('ms-auth-code', cb),
  onMsError:    (cb) => subscribe('ms-auth-error', cb),
  exchangeCode: (params) => ipcRenderer.invoke('exchange-ms-code', params),
});

// Microsoft bearer and refresh tokens never cross this bridge. Graph access is
// limited to the app's fixed mail read/send operations.
contextBridge.exposeInMainWorld('electronMicrosoft', {
  status:        (accounts) => ipcRenderer.invoke('microsoft-status', accounts),
  migrateLegacy: (request) => ipcRenderer.invoke('microsoft-migrate-legacy', request),
  refresh:       (accountId) => ipcRenderer.invoke('microsoft-refresh', accountId),
  fetchMail:     (request) => ipcRenderer.invoke('microsoft-fetch-mail', request),
  sendMail:      (request) => ipcRenderer.invoke('microsoft-send-mail', request),
  disconnect:    (accountId) => ipcRenderer.invoke('microsoft-disconnect', accountId),
});

// Firebase still runs in the renderer for backward compatibility, but the old
// arbitrary key/value secret API is gone. These operations are purpose-specific
// and configuration changes are owner-authorized in main.
contextBridge.exposeInMainWorld('electronFirebase', {
  status:        () => ipcRenderer.invoke('firebase-config-status'),
  runtimeConfig: () => ipcRenderer.invoke('firebase-runtime-config'),
  configure:     (settings) => ipcRenderer.invoke('firebase-configure', settings),
  clear:         () => ipcRenderer.invoke('firebase-clear'),
});

// iCloud Drive sync bridge — reads/writes sync.json in iCloud Drive
contextBridge.exposeInMainWorld('electronSync', {
  read:  ()     => ipcRenderer.invoke('read-sync-file'),
  write: (data) => ipcRenderer.invoke('write-sync-file', data),
});

contextBridge.exposeInMainWorld('electronSpreadsheet', {
  exportRecovery: (contents) => ipcRenderer.invoke('export-spreadsheet-recovery', contents),
  importFile:     () => ipcRenderer.invoke('import-spreadsheet'),
});

// MB161-014: Google Sheets, READ ONLY. There is no write method on this bridge
// and there is no write handler behind it. The OAuth scope requested is
// spreadsheets.readonly, so Google itself refuses a write even if something
// here were wrong. Tokens never cross the bridge; the renderer gets values.
contextBridge.exposeInMainWorld('electronGoogleSheets', {
  status:         () => ipcRenderer.invoke('google-status'),
  setCredentials: (request) => ipcRenderer.invoke('google-set-credentials', request),
  beginAuth:      (request) => ipcRenderer.invoke('google-oauth-begin', request),
  completeAuth:   (request) => ipcRenderer.invoke('google-oauth-complete', request),
  disconnect:     () => ipcRenderer.invoke('google-disconnect'),
  describe:       (request) => ipcRenderer.invoke('google-sheet-describe', request),
  read:           (request) => ipcRenderer.invoke('google-sheet-read', request),
  // MB161-016: writes only cells that still hold what the app last saw, and
  // returns what it replaced so nothing is lost without a record.
  push:           (request) => ipcRenderer.invoke('google-sheet-push', request),
  onCode:         (cb) => subscribe('google-auth-code', cb),
  onError:        (cb) => subscribe('google-auth-error', cb),
});

// Shell bridge — opens URLs in the system default browser
contextBridge.exposeInMainWorld('electronShell', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

// PDF generation bridge — renders HTML to a real PDF via Electron's printToPDF
contextBridge.exposeInMainWorld('electronPdf', {
  generate: (html, suggestedName) => ipcRenderer.invoke('print-to-pdf', html, suggestedName),
});

// AI requests are validated and sent by main so API keys never enter renderer
// memory or browser network traffic.
contextBridge.exposeInMainWorld('electronAI', {
  message:   (payload) => ipcRenderer.invoke('anthropic-message', payload),
  keyStatus: () => ipcRenderer.invoke('anthropic-key-status'),
  setKey:    (value) => ipcRenderer.invoke('anthropic-key-set', value),
  removeKey: () => ipcRenderer.invoke('anthropic-key-remove'),
});

// RingCentral credentials and access tokens remain in main. The renderer sees
// only normalized message/voicemail records and send results.
contextBridge.exposeInMainWorld('electronRingCentral', {
  status:    () => ipcRenderer.invoke('ringcentral-status'),
  configure: (settings) => ipcRenderer.invoke('ringcentral-configure', settings),
  fetchData: () => ipcRenderer.invoke('ringcentral-fetch-data'),
  sendSms:   (request) => ipcRenderer.invoke('ringcentral-send-sms', request),
});

// Auto-update bridge — lets the renderer trigger a manual update check
contextBridge.exposeInMainWorld('electronUpdater', {
  checkForUpdates:    () => ipcRenderer.invoke('check-for-updates'),
  getVersion:         () => ipcRenderer.invoke('get-app-version'),
  quitAndInstall:     () => ipcRenderer.invoke('quit-and-install'),
  onDownloadProgress: (cb) => subscribe('update-download-progress', cb),
  onUpdateDownloaded: (cb) => subscribe('update-downloaded', cb),
  onUpdateError:      (cb) => subscribe('update-error', cb),
});

// Main asks the renderer to flush its serialized encrypted-write queue before
// normal quit or explicit update installation. Preload owns the acknowledgement
// so renderer code cannot accidentally omit it.
let flushListener = null;
contextBridge.exposeInMainWorld('electronLifecycle', {
  onFlushRequested: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback function is required.');
    if (flushListener) ipcRenderer.removeListener('lifecycle-flush-request', flushListener);
    const listener = async (_event, payload) => {
      const requestId = payload?.requestId;
      let ok = false;
      try {
        // C-01: only acknowledge safe-to-install when the renderer explicitly
        // returns true. Any other value (false, undefined, void) or a thrown
        // exception must propagate as ok: false so quitAndInstall is blocked.
        const result = await callback();
        ok = result === true;
      } catch (_) {
        ok = false;
      }
      try {
        await ipcRenderer.invoke('renderer-flush-complete', { requestId, ok });
      } catch (_) {}
    };
    flushListener = listener;
    ipcRenderer.on('lifecycle-flush-request', listener);
    return () => {
      ipcRenderer.removeListener('lifecycle-flush-request', listener);
      if (flushListener === listener) flushListener = null;
    };
  },
});

// General-purpose file API — file dialog + text extraction for Policies feature
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    const allowed = ['open-file-dialog', 'read-text-file', 'fetch-musicbox-website', 'fetch-csv'];
    if (!allowed.includes(channel)) return Promise.reject(new Error('Channel not allowed: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
});
