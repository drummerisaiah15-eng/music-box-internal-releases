const { contextBridge, ipcRenderer } = require('electron');

// Expose ONLY the keychain bridge to the renderer — nothing else
// The renderer has no access to Node.js or Electron internals
contextBridge.exposeInMainWorld('electronKeychain', {
  encrypt: (plaintext) => ipcRenderer.invoke('keychain-encrypt', plaintext),
  decrypt: (b64)       => ipcRenderer.invoke('keychain-decrypt', b64),
  available: true,
});

// OAuth token listener — receives MS token from local callback server
contextBridge.exposeInMainWorld('electronAuth', {
  // Legacy implicit flow: access token arrives via POST from the redirect page
  onMsToken:    (cb) => ipcRenderer.on('ms-oauth-token', (_, token) => cb(token)),
  // PKCE auth code flow: authorization code arrives via GET redirect
  onMsCode:     (cb) => ipcRenderer.on('ms-auth-code',  (_, data) => cb(data)),
  // Auth error from Microsoft redirect
  onMsError:    (cb) => ipcRenderer.on('ms-auth-error', (_, data) => cb(data)),
  // Exchange PKCE authorization code for access+refresh tokens
  exchangeCode: (params) => ipcRenderer.invoke('exchange-ms-code', params),
  // Use stored refresh token to silently get a new access token
  refreshToken: (params) => ipcRenderer.invoke('refresh-ms-token', params),
});

// iMessage bridge — reads chat.db and sends via AppleScript
contextBridge.exposeInMainWorld('electronMessages', {
  fetch: (dbPath) => ipcRenderer.invoke('fetch-imessages', { dbPath }),
  send:  (phone, text) => ipcRenderer.invoke('send-imessage', { phone, text }),
});

// iCloud Drive sync bridge — reads/writes sync.json in iCloud Drive
contextBridge.exposeInMainWorld('electronSync', {
  read:  ()     => ipcRenderer.invoke('read-sync-file'),
  write: (data) => ipcRenderer.invoke('write-sync-file', data),
});

// Shell bridge — opens URLs in the system default browser
contextBridge.exposeInMainWorld('electronShell', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

// PDF generation bridge — renders HTML to a real PDF via Electron's printToPDF
contextBridge.exposeInMainWorld('electronPdf', {
  generate: (html) => ipcRenderer.invoke('print-to-pdf', html),
});

// Auto-update bridge — lets the renderer trigger a manual update check
contextBridge.exposeInMainWorld('electronUpdater', {
  checkForUpdates:    () => ipcRenderer.invoke('check-for-updates'),
  getVersion:         () => ipcRenderer.invoke('get-app-version'),
  quitAndInstall:     () => ipcRenderer.invoke('quit-and-install'),
  onDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, ver) => cb(ver)),
});

// General-purpose file API — file dialog + text extraction for Policies feature
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    const allowed = ['open-file-dialog', 'read-text-file', 'fetch-musicbox-website', 'fetch-csv'];
    if (!allowed.includes(channel)) return Promise.reject(new Error('Channel not allowed: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
});
