const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const { pathToFileURL } = require('node:url');

dns.setDefaultResultOrder('ipv4first');
const {
  getMissingBinaries,
  getUnhealthyBinaries,
  mapSetupError,
  setupBinaries,
} = require('../scripts/setup-binaries');
const { createStore } = require('./store');
const { autoUpdateYtDlp, fetchMetadata, probeMedia } = require('./ytdlp');
const { createDownloadManager } = require('./downloads');
const {
  createBridgeServer,
  isAuthorizedMediaPath,
  isAllowedMediaExtension,
} = require('./bridgeServer');

let mainWindow = null;
let setupRunning = false;
let currentSetupState = {
  state: 'loading',
  percent: 0,
  message: 'Checking downloader tools...',
};

const PACKAGED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' https: http: data:",
  "media-src 'self' http://127.0.0.1:48921",
  "connect-src 'self' http://127.0.0.1:48921",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

function getBinDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'bin');
  }
  return path.resolve(__dirname, '..', 'bin');
}

function getAssetsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets');
  }
  return path.resolve(__dirname, '..', 'assets');
}

function getExtensionDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'extension');
  }
  return path.resolve(__dirname, '..', 'extension');
}

function isAllowedAppUrl(targetUrl) {
  if (!targetUrl) return false;
  if (!app.isPackaged) {
    return targetUrl.startsWith('http://localhost:5173');
  }
  const indexUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'dist', 'index.html')
  ).href;
  return targetUrl.toLowerCase().startsWith(indexUrl.toLowerCase());
}

function assertAuthorizedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Application window unavailable.');
  }
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC sender.');
  }
  const frameUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isAllowedAppUrl(frameUrl)) {
    throw new Error('Unauthorized frame origin.');
  }
}

async function isAuthorizedFolderTarget(targetPath, store, downloadManager) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
  const [settings, history] = await Promise.all([
    store.getSettings(),
    store.getHistory(),
  ]);

  const dlDir = path.resolve(settings.downloadDir);
  if (resolved === dlDir || resolved.startsWith(`${dlDir}${path.sep}`)) {
    return true;
  }

  const active = downloadManager.getCurrent();
  if (active) {
    if (active.filePath && path.resolve(active.filePath) === resolved) return true;
    if (active.outputDir && path.resolve(active.outputDir) === resolved) return true;
  }

  return history.some((entry) => {
    if (entry.filePath && path.resolve(entry.filePath) === resolved) return true;
    if (entry.outputDir && path.resolve(entry.outputDir) === resolved) return true;
    return false;
  });
}

function publishSetupState(next) {
  currentSetupState = next;
  mainWindow?.webContents.send('grabit:setupProgress', next);
}

async function ensureBinaries(binDir) {
  if (setupRunning) return;
  setupRunning = true;
  try {
    const unhealthy = await getUnhealthyBinaries(binDir);
    if (unhealthy.length === 0) {
      publishSetupState({
        state: 'ready',
        percent: 100,
        message: 'Ready',
      });
      void autoUpdateYtDlp(binDir);
      return;
    }

    publishSetupState({
      state: 'running',
      percent: 2,
      message: 'Setting up yt-dlp, aria2c, and FFmpeg...',
    });

    await setupBinaries(binDir, (ev) => {
      publishSetupState({
        state: 'running',
        tool: ev.tool,
        percent: ev.percent,
        message: ev.message,
      });
    });

    publishSetupState({
      state: 'ready',
      percent: 100,
      message: 'Setup complete',
    });
    void autoUpdateYtDlp(binDir);
  } catch (err) {
    publishSetupState({
      state: 'error',
      percent: 0,
      message: mapSetupError(err),
    });
  } finally {
    setupRunning = false;
  }
}

function migrateLegacyUserData() {
  const newUserData = app.getPath('userData');
  const legacyUserData = path.join(app.getPath('appData'), 'grabit');
  const markerPath = path.join(newUserData, '.legacy_migrated');
  if (
    newUserData === legacyUserData ||
    !fs.existsSync(legacyUserData) ||
    fs.existsSync(markerPath)
  ) {
    return;
  }

  try {
    fs.mkdirSync(newUserData, { recursive: true });
    for (const file of [
      'settings.json',
      'history.json',
      'bridge-auth.json',
      'window-state.json',
    ]) {
      const src = path.join(legacyUserData, file);
      const dst = path.join(newUserData, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {
    // Non-fatal migration error
  }
}

function applyEnvAppDataOverride() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const envAppData = path.resolve(process.env.APPDATA);
    try {
      if (
        envAppData.toLowerCase() !==
        path.resolve(app.getPath('appData')).toLowerCase()
      ) {
        app.setPath('appData', envAppData);
        app.setPath('userData', path.join(envAppData, app.getName()));
      }
    } catch {
      // Ignore if path override fails
    }
  }
}

async function bootstrap() {
  applyEnvAppDataOverride();
  migrateLegacyUserData();
  // Deny all browser permission prompts (camera, mic, geolocation, notifications, etc.)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith('file://')) {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [PACKAGED_CSP],
          },
        });
      } else {
        callback({ responseHeaders: details.responseHeaders });
      }
    });
  }

  const binDir = getBinDir();
  const store = createStore(app.getPath('userData'), app.getPath('downloads'));

  const wrappedStore = {
    ...store,
    async addHistoryEntry(entry) {
      const next = await store.addHistoryEntry(entry);
      mainWindow?.webContents.send('grabit:historyUpdated', next);
      return next;
    },
    async updateHistoryEntry(id, patch) {
      const next = await store.updateHistoryEntry(id, patch);
      mainWindow?.webContents.send('grabit:historyUpdated', next);
      return next;
    },
    async deleteHistoryEntry(id) {
      const next = await store.deleteHistoryEntry(id);
      mainWindow?.webContents.send('grabit:historyUpdated', next);
      return next;
    },
    async clearHistory() {
      const next = await store.clearHistory();
      mainWindow?.webContents.send('grabit:historyUpdated', next);
      return next;
    },
  };

  const downloadManager = createDownloadManager({
    binDir,
    store: wrappedStore,
    onStateChange: (state) => {
      mainWindow?.webContents.send('grabit:downloadState', state);
    },
    onQueueChange: (queue) => {
      mainWindow?.webContents.send('grabit:queueUpdated', queue);
    },
  });

  const bridgeServer = createBridgeServer({
    binDir,
    store: wrappedStore,
    downloadManager,
    getMissingBinaries,
    onExtensionEvent: (event) => {
      mainWindow?.webContents.send('grabit:extensionEvent', {
        ...event,
        bridge: bridgeServer.getStatus(),
      });
      if (event.type === 'grabbed' && mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
      }
    },
  });

  await bridgeServer.start();

  function loadWindowState() {
    const statePath = path.join(app.getPath('userData'), 'window-state.json');
    const defaults = { width: 1080, height: 800, isMaximized: false };
    try {
      if (!fs.existsSync(statePath)) return defaults;
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const width = Math.max(380, Number(saved.width) || defaults.width);
      const height = Math.max(600, Number(saved.height) || defaults.height);
      const hasCoords = Number.isFinite(saved.x) && Number.isFinite(saved.y);
      if (hasCoords) {
        const visible = screen.getAllDisplays().some((d) => {
          const b = d.workArea;
          return (
            saved.x + 80 > b.x &&
            saved.x < b.x + b.width - 80 &&
            saved.y + 80 > b.y &&
            saved.y < b.y + b.height - 80
          );
        });
        if (visible) {
          return {
            x: saved.x,
            y: saved.y,
            width,
            height,
            isMaximized: Boolean(saved.isMaximized),
          };
        }
      }
      return { width, height, isMaximized: Boolean(saved.isMaximized) };
    } catch {
      return defaults;
    }
  }

  function saveWindowState(win) {
    if (!win || win.isDestroyed()) return;
    const statePath = path.join(app.getPath('userData'), 'window-state.json');
    try {
      const isMaximized = win.isMaximized();
      const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ ...bounds, isMaximized }, null, 2),
        'utf8'
      );
    } catch {
      // Ignore window state write errors
    }
  }

  function createWindow() {
    const iconPath = path.join(getAssetsDir(), 'icon.png');
    const icon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : undefined;
    const winState = loadWindowState();

    mainWindow = new BrowserWindow({
      width: winState.width,
      height: winState.height,
      x: winState.x,
      y: winState.y,
      minWidth: 380,
      minHeight: 600,
      show: true,
      title: 'Snipr Download Manager (SDM)',
      icon: icon && !icon.isEmpty() ? icon : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });

    if (winState.isMaximized) {
      mainWindow.maximize();
    }

    // Block in-app navigation to external pages; open safe https/http links in OS browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          void shell.openExternal(parsed.toString());
        }
      } catch {}
      return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, navUrl) => {
      if (!isAllowedAppUrl(navUrl)) {
        event.preventDefault();
      }
    });

    let saveTimer = null;
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveWindowState(mainWindow), 250);
    };
    mainWindow.on('resize', scheduleSave);
    mainWindow.on('move', scheduleSave);
    mainWindow.on('close', () => {
      clearTimeout(saveTimer);
      saveWindowState(mainWindow);
    });

    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });

    if (!app.isPackaged) {
      void mainWindow.loadURL('http://localhost:5173');
    } else {
      void mainWindow.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html'));
    }

    mainWindow.webContents.on('did-finish-load', () => {
      void ensureBinaries(binDir);
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  function handleIpc(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertAuthorizedIpcSender(event);
      return fn(event, ...args);
    });
  }

  handleIpc('grabit:getInitialState', async () => {
    const [settings, history, auth] = await Promise.all([
      wrappedStore.getSettings(),
      wrappedStore.getHistory(),
      wrappedStore.getBridgeAuth(),
    ]);
    const missing = getMissingBinaries(binDir);
    const isReady =
      missing.length === 0 &&
      !setupRunning &&
      currentSetupState.state !== 'error';
    return {
      ready: isReady,
      missing,
      setupState: isReady
        ? { state: 'ready', percent: 100, message: 'Ready' }
        : currentSetupState,
      settings,
      history,
      activeDownload: downloadManager.getCurrent(),
      queue: downloadManager.getQueue(),
      extension: {
        ...bridgeServer.getStatus(),
        extensionDir: getExtensionDir(),
        token: auth.token,
        extensionId: auth.extensionId,
      },
    };
  });

  handleIpc('grabit:getBridgeAuth', () => wrappedStore.getBridgeAuth());

  handleIpc('grabit:regenerateBridgeToken', async () => {
    const auth = await wrappedStore.regenerateBridgeToken();
    return { ok: true, data: auth };
  });

  handleIpc('grabit:setExtensionId', async (_e, extensionId) => {
    try {
      const auth = await wrappedStore.setAllowedExtensionId(extensionId);
      return { ok: true, data: auth };
    } catch (err) {
      return { ok: false, error: err?.message || 'Invalid extension ID.' };
    }
  });

  handleIpc('grabit:createStreamUrl', async (_e, filePath) => {
    try {
      const sessionInfo = await bridgeServer.createStreamSession(filePath);
      return { ok: true, url: sessionInfo.url };
    } catch (err) {
      return { ok: false, error: err?.message || 'Unable to stream media.' };
    }
  });

  handleIpc('grabit:runSetup', async () => {
    await ensureBinaries(binDir);
    return {
      ready:
        currentSetupState.state === 'ready' &&
        getMissingBinaries(binDir).length === 0,
      setupState: currentSetupState,
    };
  });

  handleIpc('grabit:readClipboard', () => {
    try {
      return clipboard.readText() || '';
    } catch {
      return '';
    }
  });

  handleIpc('grabit:copyText', (_e, text) => {
    try {
      clipboard.writeText(String(text || '').slice(0, 16384));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  handleIpc('grabit:fetchMetadata', async (_e, url) => {
    try {
      const data = await fetchMetadata(binDir, url);
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || 'Unable to fetch video info.',
      };
    }
  });

  handleIpc('grabit:startDownload', async (_e, payload) => {
    try {
      const data = await downloadManager.startDownload(payload);
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || 'Unable to start download.',
      };
    }
  });

  handleIpc('grabit:pauseDownload', async () => {
    try {
      return { ok: true, data: await downloadManager.pause() };
    } catch (err) {
      return { ok: false, error: err?.message || 'Unable to pause download.' };
    }
  });

  handleIpc('grabit:resumeDownload', async () => {
    try {
      return { ok: true, data: await downloadManager.resume() };
    } catch (err) {
      return { ok: false, error: err?.message || 'Unable to resume download.' };
    }
  });

  handleIpc('grabit:cancelDownload', async () => {
    try {
      return { ok: true, data: await downloadManager.cancel() };
    } catch (err) {
      return { ok: false, error: err?.message || 'Unable to cancel download.' };
    }
  });

  handleIpc('grabit:removeFromQueue', (_e, id) => {
    return downloadManager.removeFromQueue(id);
  });

  handleIpc('grabit:clearQueue', () => {
    return downloadManager.clearQueue();
  });

  handleIpc('grabit:probeFile', async (_e, filePath) => {
    try {
      const allowed = await isAuthorizedMediaPath(
        filePath,
        wrappedStore,
        downloadManager
      );
      if (!allowed) return { ok: false, data: null };
      const probe = await probeMedia(binDir, filePath);
      return { ok: Boolean(probe), data: probe };
    } catch {
      return { ok: false, data: null };
    }
  });

  handleIpc('grabit:convertToH264', async (_e, { historyId, filePath }) => {
    try {
      const allowed = await isAuthorizedMediaPath(
        filePath,
        wrappedStore,
        downloadManager
      );
      if (!allowed) {
        return { ok: false, error: 'File is not in an authorized download location.' };
      }
      return await downloadManager.convertExistingFile(historyId, filePath);
    } catch (err) {
      return { ok: false, error: err?.message || 'Conversion failed.' };
    }
  });

  handleIpc('grabit:openFile', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'File no longer exists on disk.' };
      }
      const allowed =
        isAllowedMediaExtension(filePath) &&
        (await isAuthorizedMediaPath(filePath, wrappedStore, downloadManager));
      if (!allowed) {
        return { ok: false, error: 'Blocked opening unauthorized or non-media file.' };
      }
      const errMsg = await shell.openPath(fs.realpathSync(filePath));
      if (errMsg) return { ok: false, error: errMsg };
      return { ok: true };
    } catch {
      return { ok: false, error: 'Unable to open file.' };
    }
  });

  handleIpc('grabit:openFolder', async (_e, targetPath) => {
    try {
      if (!targetPath) return { ok: false, error: 'Folder path is unavailable.' };
      const allowed = await isAuthorizedFolderTarget(
        targetPath,
        wrappedStore,
        downloadManager
      );
      if (!allowed) {
        return { ok: false, error: 'Folder path is not authorized.' };
      }
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.isFile()) {
          shell.showItemInFolder(targetPath);
          return { ok: true };
        }
        const errMsg = await shell.openPath(targetPath);
        return errMsg ? { ok: false, error: errMsg } : { ok: true };
      }
      const parent = path.dirname(targetPath);
      if (fs.existsSync(parent)) {
        await shell.openPath(parent);
        return { ok: true };
      }
      return { ok: false, error: 'Folder does not exist.' };
    } catch {
      return { ok: false, error: 'Unable to open folder.' };
    }
  });

  handleIpc('grabit:openExtensionFolder', async () => {
    try {
      const extDir = getExtensionDir();
      if (!fs.existsSync(extDir)) {
        return { ok: false, error: 'Extension folder was not found.' };
      }
      const errMsg = await shell.openPath(extDir);
      return errMsg ? { ok: false, error: errMsg } : { ok: true, path: extDir };
    } catch {
      return { ok: false, error: 'Unable to open extension folder.' };
    }
  });

  handleIpc('grabit:getSettings', () => wrappedStore.getSettings());

  handleIpc('grabit:updateSettings', async (_e, patch) => {
    try {
      if (patch && typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) {
        const trimmedDir = patch.downloadDir.trim();
        if (!path.isAbsolute(trimmedDir)) {
          return { ok: false, error: 'Download folder must be an absolute path.' };
        }
      }
      const settings = await wrappedStore.updateSettings(patch);
      return { ok: true, data: settings };
    } catch (err) {
      return { ok: false, error: err?.message || 'Unable to save settings.' };
    }
  });

  handleIpc('grabit:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  handleIpc('grabit:getHistory', () => wrappedStore.getHistory());

  handleIpc('grabit:deleteHistory', async (_e, id) => {
    return wrappedStore.deleteHistoryEntry(id);
  });

  handleIpc('grabit:clearHistory', async () => {
    return wrappedStore.clearHistory();
  });

  createWindow();

  app.on('before-quit', async () => {
    await downloadManager.shutdown();
    await bridgeServer.stop();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

applyEnvAppDataOverride();
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    void bootstrap();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
