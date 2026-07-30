// MUST be first — before requiring electron or anything else.
// Electron's native dialog for uncaughtException is suppressed when
// a process.on('uncaughtException') handler is installed by user code.
process.on('uncaughtException', (e) => {
  if (e.code === 'EADDRINUSE') return; // port in use — skip silently, don't show dialog
  console.error('[main] Uncaught exception:', e);
  // don't call process.exit — let Electron decide
});

const { app, BrowserWindow, shell, ipcMain, session, Menu, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

// ── Auto-updater config ──────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true; // electron-updater installs on quit

autoUpdater.on('download-progress', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-download-progress', info);
});

autoUpdater.on('update-downloaded', (info) => {
  const currentVer    = app.getVersion();
  const downloadedVer = info?.version || info?.releaseName || '';
  if (downloadedVer && downloadedVer === currentVer) {
    console.log(`[updater] update-downloaded: version ${downloadedVer} matches current — ignoring`);
    return;
  }
  console.log(`[updater] update-downloaded: ${downloadedVer}`);
  if (mainWindow) mainWindow.webContents.send('update-downloaded', downloadedVer);
});

autoUpdater.on('error', (err) => {
  console.warn('[updater] Error:', err?.message);
  if (mainWindow) mainWindow.webContents.send('update-error', err?.message || 'Unknown update error');
});

// ── Local OAuth callback server (catches Microsoft token redirect) ──
const OAUTH_HTML = `<!DOCTYPE html>
<html>
<head><title>Music Box — Connected</title>
<style>body{font-family:sans-serif;text-align:center;padding:80px;background:#f5f2ec;color:#1a1a1a}</style>
</head>
<body>
<h2>✅ Microsoft 365 Connected!</h2>
<p>You can close this tab and return to Music Box.</p>
<script>
  const params = new URLSearchParams(window.location.hash.replace(/^#/,''));
  const token = params.get('access_token');
  if (token) {
    fetch('/ms-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
  }
</script>
</body>
</html>`;

function startOAuthServer(win, attempt = 0) {
  // Kill any stale process occupying port 8080 on first attempt
  if (attempt === 0) {
    try { execSync('lsof -ti:8080 | xargs kill -9', { stdio: 'ignore' }); } catch (_) {}
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ms-token') {
      // Legacy implicit flow — access token delivered via POST from the redirect page JS
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { token } = JSON.parse(body);
          if (token) win.webContents.send('ms-oauth-token', token);
        } catch(e) {}
        res.writeHead(200); res.end('OK');
      });
    } else if (req.method === 'GET') {
      // PKCE auth code flow — code arrives as a query param
      try {
        const urlObj = new URL(req.url, 'http://localhost:8080');
        const code  = urlObj.searchParams.get('code');
        const error = urlObj.searchParams.get('error');
        const errorDesc = urlObj.searchParams.get('error_description');
        if (code) {
          win.webContents.send('ms-auth-code', { code });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(OAUTH_HTML);
        } else if (error) {
          win.webContents.send('ms-auth-error', { error, errorDesc });
          const errHtml = OAUTH_HTML
            .replace('✅ Microsoft 365 Connected!', '❌ Microsoft Sign-In Failed')
            .replace('You can close this tab and return to Music Box.', `Error: ${error}<br><small>${errorDesc || ''}</small>`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(errHtml);
        } else {
          // No code and no error — direct hit or prefetch. Tell the user nothing happened.
          win.webContents.send('ms-auth-error', { error: 'no_code', errorDesc: 'The Microsoft redirect did not include an auth code. Try connecting again.' });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(OAUTH_HTML.replace('You can close this tab and return to Music Box.', 'No auth code was received. Please close this tab and try again from the app.'));
        }
      } catch(_) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(OAUTH_HTML);
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(OAUTH_HTML);
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      server.close();
      if (attempt < 8) {
        // OS hasn't released the port yet — retry after a short delay
        setTimeout(() => startOAuthServer(win, attempt + 1), 250);
      }
      // After 8 retries (~2 seconds), give up silently — app still works, just no OAuth callback
    } else {
      console.error('OAuth server error:', e);
    }
  });
  server.listen(8080, '127.0.0.1', () => {
    // unref() prevents the server from keeping the process alive after the window closes
    server.unref();
  });
  oauthServer = server;
}

// ── Security: prevent new window navigation ──────────────────
const _safeExternalUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch { return false; }
};

app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (_safeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('https://login.microsoftonline.com')) {
      event.preventDefault();
      if (_safeExternalUrl(url)) shell.openExternal(url);
    }
  });
});

let mainWindow = null;
let oauthServer = null;

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
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, 'index.html')
    : path.join(__dirname, 'index.html');
  mainWindow.loadFile(htmlPath);

  // Temporary: open DevTools with Cmd+Option+I for debugging
  const { globalShortcut } = require('electron');
  globalShortcut.register('CommandOrControl+Option+I', () => {
    if (mainWindow) mainWindow.webContents.openDevTools();
  });

  // Hide instead of close when clicking the red X — keeps OAuth server alive
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  startOAuthServer(mainWindow);

  // Check for updates 5 seconds after launch (only in packaged builds)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 5000);
  }

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });

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

// Single instance lock — prevents a second copy from starting and conflicting on port 8080
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — tell it to show itself, then exit immediately
  // Do NOT proceed to app.whenReady() or startOAuthServer
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

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

  app.on('before-quit', () => {
    app.isQuitting = true;
    // Close the OAuth server so the process can exit cleanly and free port 8080
    if (oauthServer) { oauthServer.close(); oauthServer = null; }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ── IPC: Manual update check ─────────────────────────────────
ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      const current = app.getVersion();
      const latest  = result.updateInfo.version;
      if (latest === current) {
        return { status: 'up-to-date', version: current };
      }
      return { status: 'update-available', current, latest };
    }
    return { status: 'up-to-date', version: app.getVersion() };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

/// ── Policies: file picker ────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'pdf', 'docx', 'doc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result; // { canceled, filePaths }
});

// ── Policies: extract text from file ────────────────────────────────────────
// Returns true if the string looks like real readable text (not binary garbage).
function _looksLikeText(str) {
  if (!str || str.length < 10) return false;
  if (str.startsWith('%PDF')) return false; // raw PDF binary passed through
  const printable = (str.match(/[\x20-\x7E\n\r\t]/g) || []).length;
  return printable / str.length > 0.65;
}

ipcMain.handle('read-text-file', async (e, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    // 1. pdf-parse (bundled npm package — works out of the box, no install needed)
    try {
      // Use the internal module path to bypass pdf-parse's test file check in production
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      if (data && data.text && _looksLikeText(data.text)) return data.text;
    } catch (e1) {
      console.log('[pdf] pdf-parse failed:', e1.message);
    }
    // 2. pdftotext (poppler) — if user happens to have it installed
    try {
      // Use execFileSync with an argument array — filePath never touches the shell
      const out = execFileSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', timeout: 30000 });
      if (_looksLikeText(out)) return out;
    } catch (_) {}
    // 3. python3 + pdfminer — last resort
    try {
      // Pass filePath as a positional argument to avoid any shell/string interpolation
      const py = 'import sys; from pdfminer.high_level import extract_text; print(extract_text(sys.argv[1]))';
      const out = execFileSync('python3', ['-c', py, filePath], { encoding: 'utf8', timeout: 30000 });
      if (_looksLikeText(out)) return out;
    } catch (_) {}
    // 4. Nothing worked — ask user to paste manually
    throw new Error(
      'Could not extract text from this PDF.\n\n' +
      'Paste manually:\n' +
      '  Open the PDF, press Cmd+A then Cmd+C, and paste into the text box.'
    );
  } else if (ext === '.docx' || ext === '.doc') {
    try {
      // Use execFileSync with argument array — filePath never touches the shell
      const out = execFileSync('textutil', ['-convert', 'txt', '-stdout', filePath], { encoding: 'utf8', timeout: 30000 });
      if (_looksLikeText(out)) return out;
    } catch (_) {}
    throw new Error('Could not convert this document. Save it as a .txt file and import again.');
  } else {
    return fs.readFileSync(filePath, 'utf8');
  }
});

// ── Fetch Music Box website content (restricted to themusicboxinc.com only) ──
ipcMain.handle('fetch-musicbox-website', async () => {
  const ALLOWED_DOMAIN = 'themusicboxinc.com';
  const URLS = [
    'https://www.themusicboxinc.com/',
    'https://www.themusicboxinc.com/lessons',
    'https://www.themusicboxinc.com/about',
    'https://www.themusicboxinc.com/contact',
    'https://www.themusicboxinc.com/schedule',
    'https://www.themusicboxinc.com/rates',
    'https://www.themusicboxinc.com/faq',
  ];

  const fetchUrl = (url, hops = 0) => new Promise((resolve) => {
    if (hops > 3) return resolve('');
    try {
      const req = https.get(url, { timeout: 8000, headers: { 'User-Agent': 'MusicBoxInternal/1.0' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          if (loc.includes(ALLOWED_DOMAIN) || loc.startsWith('/')) {
            const next = loc.startsWith('/') ? new URL(url).origin + loc : loc;
            return resolve(fetchUrl(next, hops + 1));
          }
          return resolve('');
        }
        let data = '';
        res.on('data', chunk => { if (data.length < 400000) data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    } catch (_) { resolve(''); }
  });

  const stripHtml = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ').trim();

  const pages = await Promise.all(URLS.map(url => fetchUrl(url)));
  const labelled = pages
    .map((html, i) => { const t = stripHtml(html); return t.length > 100 ? `[${URLS[i]}]\n${t}` : ''; })
    .filter(Boolean);

  return labelled.join('\n\n---\n\n').slice(0, 60000);
});

// ── Fetch Google Sheets CSV (restricted to *.google.com only) ──
ipcMain.handle('fetch-csv', async (_, url) => {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.endsWith('.google.com') && urlObj.hostname !== 'google.com') {
      return { error: 'Only Google Sheets URLs are allowed.' };
    }
    const doFetch = (targetUrl, hops = 0) => new Promise((resolve) => {
      if (hops > 3) return resolve({ error: 'Too many redirects' });
      const req = https.get(targetUrl, { timeout: 15000, headers: { 'User-Agent': 'MusicBoxInternal/1.0' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          const next = loc.startsWith('/') ? new URL(targetUrl).origin + loc : loc;
          const ALLOWED = ['google.com', 'googleapis.com', 'googleusercontent.com'];
          if (ALLOWED.some(d => next.includes(d))) return resolve(doFetch(next, hops + 1));
          return resolve({ error: 'Redirect outside Google blocked.' });
        }
        let data = '';
        res.on('data', chunk => { if (data.length < 2000000) data += chunk; });
        res.on('end', () => resolve({ ok: true, text: data }));
        res.on('error', e => resolve({ error: e.message }));
      });
      req.on('error', e => resolve({ error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out.' }); });
    });
    return await doFetch(url);
  } catch (e) {
    return { error: e.message };
  }
});

// MB-008: Use standard electron-updater install path — no custom shell scripts.
// electron-updater handles download verification, extraction, and relaunch.
ipcMain.handle('quit-and-install', () => {
  setImmediate(() => {
    console.log('[updater] quit-and-install: calling autoUpdater.quitAndInstall');
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.error('[updater] quitAndInstall error:', e?.message);
    }
    // Safety net: if quitAndInstall didn't exit within 5s, force quit.
    setTimeout(() => {
      console.log('[updater] fallback: forcing app.quit()');
      app.quit();
    }, 5000);
  });
  return { ok: true };
});

// ── IPC: AES-256-GCM encryption — key protected by Electron safeStorage ────
// MB-009: safeStorage wraps the key with the OS credential store (macOS
// Keychain) so the raw 32-byte key never sits on disk in plaintext.
// Migration: if the old plain-file key (store-key.bin) still exists, it is
// read once, re-protected via safeStorage, then deleted.
let _cachedStoreKey = null;

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
      _cachedStoreKey = Buffer.from(keyHex, 'hex');
      return _cachedStoreKey;
    } catch (e) {
      console.error('[key] safeStorage decrypt failed, regenerating:', e.message);
      try { fs.unlinkSync(encKeyPath); } catch (_) {}
    }
  }

  // ── 2. Migrate legacy plain-file key if present ──
  let key = null;
  if (fs.existsSync(legacyPath)) {
    try {
      key = fs.readFileSync(legacyPath);
      console.log('[key] Migrating store key from plain file to safeStorage');
    } catch (e) {
      console.warn('[key] Could not read legacy key:', e.message);
    }
    try { fs.unlinkSync(legacyPath); } catch (_) {}
  }

  // ── 3. Generate a new key if nothing was found ──
  if (!key || key.length !== 32) {
    key = crypto.randomBytes(32);
    console.log('[key] Generated new 32-byte store key');
  }

  // ── 4. Persist — via safeStorage if available, else 0600 plain file ──
  if (canEncrypt) {
    try {
      const encrypted = safeStorage.encryptString(key.toString('hex'));
      fs.writeFileSync(encKeyPath, encrypted, { mode: 0o600 });
      console.log('[key] Store key saved via safeStorage (Keychain)');
    } catch (e) {
      console.error('[key] safeStorage encrypt failed, using plain file:', e.message);
      fs.writeFileSync(legacyPath, key, { mode: 0o600 });
    }
  } else {
    // Linux headless / safeStorage unavailable — fall back to file
    fs.writeFileSync(legacyPath, key, { mode: 0o600 });
    console.warn('[key] safeStorage unavailable — key stored as plain file');
  }

  _cachedStoreKey = key;
  return _cachedStoreKey;
}

ipcMain.handle('keychain-encrypt', async (_, plaintext) => {
  try {
    const key = _getStoreKey();
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag  = cipher.getAuthTag();
    // format: iv(12) + tag(16) + ciphertext
    return Buffer.concat([iv, tag, enc]).toString('base64');
  } catch { return null; }
});

ipcMain.handle('keychain-decrypt', async (_, b64) => {
  try {
    const key = _getStoreKey();
    const buf = Buffer.from(b64, 'base64');
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch { return null; }
});

// ── IPC: iMessage — read from chat.db ────────────────────────
ipcMain.handle('fetch-imessages', async (_, { dbPath }) => {
  try {
    const expandedPath = dbPath.replace(/^~/, os.homedir());

    if (!fs.existsSync(expandedPath)) {
      return { ok: false, error: 'Database not found at ' + expandedPath + '. Check path in Settings.' };
    }

    // Copy to temp to avoid lock contention with the Messages app
    const tmpPath = path.join(os.tmpdir(), 'tmb_chat_copy.db');
    fs.copyFileSync(expandedPath, tmpPath);
    try { fs.copyFileSync(expandedPath + '-wal', tmpPath + '-wal'); } catch(e) {}
    try { fs.copyFileSync(expandedPath + '-shm', tmpPath + '-shm'); } catch(e) {}

    // Get conversations with messages from last 90 days (7,776,000,000,000,000 ns)
    const sql = `
      SELECT
        c.ROWID as chat_id,
        c.chat_identifier,
        COALESCE(c.display_name, '') as display_name,
        m.ROWID as msg_id,
        COALESCE(m.text, '') as text,
        m.is_from_me,
        m.is_read,
        m.date as raw_date,
        COALESCE(h.id, '') as handle_id
      FROM chat c
      JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
      JOIN message m ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE length(trim(COALESCE(m.text, ''))) > 0
        AND c.ROWID IN (
          SELECT DISTINCT cmj2.chat_id
          FROM chat_message_join cmj2
          JOIN message m2 ON cmj2.message_id = m2.ROWID
          WHERE m2.date > (SELECT MAX(date) FROM message) - 7776000000000000
        )
      ORDER BY c.ROWID, m.date DESC;
    `;

    const output = execFileSync('/usr/bin/sqlite3', ['-json', tmpPath, sql], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15000,
    });

    const rows = JSON.parse(output || '[]');
    const APPLE_EPOCH = 978307200; // seconds between Unix epoch and Apple epoch (2001-01-01)

    // Group by chat_id; rows are already DESC by date so [0] = newest
    const chatsMap = new Map();
    rows.forEach(row => {
      const cid = row.chat_id;
      if (!chatsMap.has(cid)) {
        chatsMap.set(cid, {
          chat_id: cid,
          chat_identifier: row.chat_identifier || '',
          display_name: row.display_name || '',
          handle_id: row.handle_id || '',
          msgs: [],
          unreadCount: 0,
        });
      }
      const chat = chatsMap.get(cid);
      // Cap at 60 messages per conversation
      if (chat.msgs.length < 60) {
        chat.msgs.push(row);
        if (!row.is_from_me && !row.is_read) chat.unreadCount++;
      }
    });

    const fmtTime = (unixSec) => {
      const d = new Date(unixSec * 1000);
      const now = new Date();
      const diffDays = Math.floor((now - d) / 86400000);
      if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const chats = Array.from(chatsMap.values()).map(chat => {
      const latest = chat.msgs[0];
      const latestTs = latest ? (Number(latest.raw_date) / 1e9 + APPLE_EPOCH) : 0;
      const contactName = chat.display_name || chat.handle_id || chat.chat_identifier;

      return {
        id: String(chat.chat_id),
        from: contactName,
        phone: chat.chat_identifier,
        preview: latest?.text?.slice(0, 120) || '',
        time: latestTs ? fmtTime(latestTs) : '',
        unread: chat.unreadCount > 0,
        unreadCount: chat.unreadCount,
        flagged: false,
        latestTs,
        messages: chat.msgs.slice().reverse().map(m => ({
          id: String(m.msg_id),
          text: m.text || '',
          from_me: !!m.is_from_me,
          time: fmtTime(Number(m.raw_date) / 1e9 + APPLE_EPOCH),
        })),
      };
    }).sort((a, b) => b.latestTs - a.latestTs);

    return { ok: true, chats };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: iMessage — send via AppleScript ─────────────────────
ipcMain.handle('send-imessage', async (_, { phone, text }) => {
  try {
    // Escape for AppleScript string
    const safeTxt = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const script = [
      'tell application "Messages"',
      '  set targetService to 1st service whose service type = iMessage',
      `  set targetBuddy to buddy "${phone}" of targetService`,
      `  send "${safeTxt}" to targetBuddy`,
      'end tell',
    ].join('\n');

    execFileSync('/usr/bin/osascript', ['-e', script], { timeout: 12000 });
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: iCloud Drive sync ─────────────────────────────────
const ICLOUD_DIR = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Music Box Internal');
const ICLOUD_SYNC_PATH = path.join(ICLOUD_DIR, 'sync.json');

ipcMain.handle('read-sync-file', async () => {
  try {
    if (!fs.existsSync(ICLOUD_SYNC_PATH)) return { ok: true, data: null };
    const raw = fs.readFileSync(ICLOUD_SYNC_PATH, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('write-sync-file', async (_, data) => {
  try {
    if (!fs.existsSync(ICLOUD_DIR)) fs.mkdirSync(ICLOUD_DIR, { recursive: true });
    fs.writeFileSync(ICLOUD_SYNC_PATH, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-external', async (_, url) => {
  if (!_safeExternalUrl(url)) return { ok: false, error: 'Only https: and mailto: URLs are allowed.' };
  try { await shell.openExternal(url); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});

// ── IPC: PDF generation — renders receipt HTML to PDF via Electron ──
ipcMain.handle('print-to-pdf', async (_, html) => {
  const tmpFile = path.join(os.tmpdir(), `mb_receipt_${Date.now()}.html`);
  fs.writeFileSync(tmpFile, html, 'utf8');
  const pdfWin = new BrowserWindow({
    show: false,
    width: 816,
    height: 1056,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await pdfWin.loadURL('file://' + tmpFile);
    await new Promise(r => setTimeout(r, 900));
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      pageSize: 'Letter',
      printBackground: false,
      margins: { marginType: 'custom', top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
    });
    pdfWin.destroy();
    try { fs.unlinkSync(tmpFile); } catch(_) {}
    return { ok: true, b64: pdfBuffer.toString('base64') };
  } catch(e) {
    if (!pdfWin.isDestroyed()) pdfWin.destroy();
    try { fs.unlinkSync(tmpFile); } catch(_) {}
    return { ok: false, error: e.message };
  }
});

// ── IPC: MS PKCE token exchange ───────────────────────────────
function _msTokenPost(tenant, body) {
  return new Promise((resolve) => {
    const bodyStr = new URLSearchParams(body).toString();
    const options = {
      hostname: 'login.microsoftonline.com',
      path: `/${tenant}/oauth2/v2.0/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    let data = '';
    const req = https.request(options, (res) => {
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ ok: true, ...JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, error: e.message, raw: data }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

ipcMain.handle('exchange-ms-code', async (_, { code, codeVerifier, tenant, clientId, redirectUri }) => {
  return _msTokenPost(tenant, {
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
    scope: 'Mail.Read Mail.Send User.Read offline_access',
  });
});

ipcMain.handle('refresh-ms-token', async (_, { refreshToken, tenant, clientId }) => {
  return _msTokenPost(tenant, {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'Mail.Read Mail.Send User.Read offline_access',
  });
});
