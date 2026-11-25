import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

function grabitDevApiPlugin() {
  return {
    name: 'grabit-dev-api',
    configureServer(server) {
      const binDir = path.resolve(process.cwd(), 'bin');
      const extensionDir = path.resolve(process.cwd(), 'extension');
      const userDataDir = path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'snipr-download-manager'
      );
      const legacyDir = path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'grabit'
      );
      if (!fs.existsSync(path.join(userDataDir, 'history.json')) && fs.existsSync(legacyDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
        for (const f of ['settings.json', 'history.json', 'bridge-auth.json']) {
          const s = path.join(legacyDir, f);
          const d = path.join(userDataDir, f);
          if (fs.existsSync(s) && !fs.existsSync(d)) fs.copyFileSync(s, d);
        }
      }
      const downloadsDir = path.join(os.homedir(), 'Downloads');

      const { createStore } = require('./electron/store');
      const { fetchMetadata, probeMedia } = require('./electron/ytdlp');
      const { createDownloadManager } = require('./electron/downloads');
      const {
        createBridgeServer,
        isAuthorizedMediaPath,
        isAllowedMediaExtension,
      } = require('./electron/bridgeServer');
      const { getMissingBinaries } = require('./scripts/setup-binaries');

      const store = createStore(userDataDir, downloadsDir);
      const sseClients = new Set();

      function broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of sseClients) {
          res.write(payload);
        }
      }

      const wrappedStore = {
        ...store,
        async addHistoryEntry(entry) {
          const next = await store.addHistoryEntry(entry);
          broadcast('historyUpdated', next);
          return next;
        },
        async updateHistoryEntry(id, patch) {
          const next = await store.updateHistoryEntry(id, patch);
          broadcast('historyUpdated', next);
          return next;
        },
        async deleteHistoryEntry(id) {
          const next = await store.deleteHistoryEntry(id);
          broadcast('historyUpdated', next);
          return next;
        },
        async clearHistory() {
          const next = await store.clearHistory();
          broadcast('historyUpdated', next);
          return next;
        },
      };

      const downloadManager = createDownloadManager({
        binDir,
        store: wrappedStore,
        onStateChange: (state) => broadcast('downloadState', state),
        onQueueChange: (queue) => broadcast('queueUpdated', queue),
      });

      const bridgeServer = createBridgeServer({
        binDir,
        store: wrappedStore,
        downloadManager,
        getMissingBinaries,
        onExtensionEvent: (event) =>
          broadcast('extensionEvent', { ...event, bridge: bridgeServer.getStatus() }),
      });
      void bridgeServer.start();

      function readJsonBody(req) {
        return new Promise((resolve, reject) => {
          let raw = '';
          req.on('data', (c) => {
            raw += c.toString('utf8');
            if (raw.length > 65536) reject(new Error('Body too large'));
          });
          req.on('end', () => {
            if (!raw) return resolve({});
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error('Invalid JSON'));
            }
          });
        });
      }

      function sendJson(res, status, obj) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      }

      server.middlewares.use('/api', async (req, res, next) => {
        const reqPath = (req.url || '/').split('?')[0];

        try {
          if (req.method === 'GET' && reqPath === '/events') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            res.write(':\n\n');
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
          }

          if (req.method === 'GET' && reqPath === '/state') {
            const [settings, history, auth] = await Promise.all([
              wrappedStore.getSettings(),
              wrappedStore.getHistory(),
              wrappedStore.getBridgeAuth(),
            ]);
            const missing = getMissingBinaries(binDir);
            return sendJson(res, 200, {
              ready: missing.length === 0,
              missing,
              settings,
              history,
              activeDownload: downloadManager.getCurrent(),
              queue: downloadManager.getQueue(),
              extension: {
                ...bridgeServer.getStatus(),
                extensionDir,
                token: auth.token,
                extensionId: auth.extensionId,
              },
            });
          }

          if (req.method === 'POST' && reqPath === '/bridge-auth/regenerate') {
            const auth = await wrappedStore.regenerateBridgeToken();
            return sendJson(res, 200, { ok: true, data: auth });
          }

          if (req.method === 'POST' && reqPath === '/bridge-auth/extension-id') {
            const body = await readJsonBody(req);
            try {
              const auth = await wrappedStore.setAllowedExtensionId(body.extensionId);
              return sendJson(res, 200, { ok: true, data: auth });
            } catch (err) {
              return sendJson(res, 200, {
                ok: false,
                error: err?.message || 'Invalid extension ID.',
              });
            }
          }

          if (req.method === 'POST' && reqPath === '/stream-url') {
            const body = await readJsonBody(req);
            try {
              const sessionInfo = await bridgeServer.createStreamSession(body.filePath);
              return sendJson(res, 200, { ok: true, url: sessionInfo.url });
            } catch (err) {
              return sendJson(res, 200, {
                ok: false,
                error: err?.message || 'Unable to stream media.',
              });
            }
          }

          if (req.method === 'POST' && reqPath === '/fetch') {
            const body = await readJsonBody(req);
            try {
              const data = await fetchMetadata(binDir, body.url);
              return sendJson(res, 200, { ok: true, data });
            } catch (err) {
              return sendJson(res, 200, {
                ok: false,
                error: err?.message || 'Unable to fetch video info.',
              });
            }
          }

          if (req.method === 'POST' && reqPath === '/download') {
            const body = await readJsonBody(req);
            try {
              const data = await downloadManager.startDownload(body);
              return sendJson(res, 200, { ok: true, data });
            } catch (err) {
              return sendJson(res, 200, {
                ok: false,
                error: err?.message || 'Unable to start download.',
              });
            }
          }

          if (req.method === 'POST' && reqPath === '/pause') {
            return sendJson(res, 200, { ok: true, data: await downloadManager.pause() });
          }

          if (req.method === 'POST' && reqPath === '/resume') {
            return sendJson(res, 200, { ok: true, data: await downloadManager.resume() });
          }

          if (req.method === 'POST' && reqPath === '/cancel') {
            return sendJson(res, 200, { ok: true, data: await downloadManager.cancel() });
          }

          if (req.method === 'POST' && reqPath === '/queue/remove') {
            const body = await readJsonBody(req);
            return sendJson(res, 200, downloadManager.removeFromQueue(body.id));
          }

          if (req.method === 'POST' && reqPath === '/queue/clear') {
            return sendJson(res, 200, downloadManager.clearQueue());
          }

          if (req.method === 'POST' && reqPath === '/probe') {
            const body = await readJsonBody(req);
            const data = await probeMedia(binDir, body.filePath);
            return sendJson(res, 200, { ok: Boolean(data), data });
          }

          if (req.method === 'POST' && reqPath === '/convert-h264') {
            const body = await readJsonBody(req);
            try {
              const data = await downloadManager.convertExistingFile(
                body.historyId,
                body.filePath
              );
              return sendJson(res, 200, data);
            } catch (err) {
              return sendJson(res, 200, {
                ok: false,
                error: err?.message || 'Conversion failed.',
              });
            }
          }

          if (req.method === 'POST' && reqPath === '/settings') {
            const body = await readJsonBody(req);
            const data = await wrappedStore.updateSettings(body);
            return sendJson(res, 200, { ok: true, data });
          }

          if (req.method === 'POST' && reqPath === '/history/delete') {
            const body = await readJsonBody(req);
            const list = await wrappedStore.deleteHistoryEntry(body.id);
            return sendJson(res, 200, list);
          }

          if (req.method === 'POST' && reqPath === '/history/clear') {
            const list = await wrappedStore.clearHistory();
            return sendJson(res, 200, list);
          }

          if (req.method === 'POST' && reqPath === '/open-file') {
            const body = await readJsonBody(req);
            const allowed =
              isAllowedMediaExtension(body.filePath) &&
              (await isAuthorizedMediaPath(
                body.filePath,
                wrappedStore,
                downloadManager
              ));
            if (!allowed) {
              return sendJson(res, 200, {
                ok: false,
                error: 'File is not an authorized media file.',
              });
            }
            spawn('cmd.exe', ['/c', 'start', '', fs.realpathSync(body.filePath)], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            }).unref();
            return sendJson(res, 200, { ok: true });
          }

          if (req.method === 'POST' && reqPath === '/open-folder') {
            const body = await readJsonBody(req);
            const target = body.targetPath;
            if (!target || !fs.existsSync(target)) {
              return sendJson(res, 200, { ok: false, error: 'Folder does not exist.' });
            }
            const stat = fs.statSync(target);
            const args = stat.isFile() ? [`/select,${target}`] : [target];
            spawn('explorer.exe', args, {
              detached: true,
              stdio: 'ignore',
            }).unref();
            return sendJson(res, 200, { ok: true });
          }

          if (req.method === 'POST' && reqPath === '/open-extension-folder') {
            if (!fs.existsSync(extensionDir)) {
              return sendJson(res, 200, { ok: false, error: 'Extension folder missing.' });
            }
            spawn('explorer.exe', [extensionDir], {
              detached: true,
              stdio: 'ignore',
            }).unref();
            return sendJson(res, 200, { ok: true, path: extensionDir });
          }

          next();
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err?.message || 'Server error' });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), grabitDevApiPlugin()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
