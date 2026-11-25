const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { QUALITY_FORMATS, sanitizeFilename } = require('./ytdlp');

const MAX_HISTORY = 50;
const DEFAULT_EXTENSION_ID = 'kofcdoipnfdooikalliekaklfocgaaeg';

function healHistoryEntryPath(entry) {
  if (!entry || entry.status !== 'Completed') return { entry, changed: false };
  if (entry.filePath && fs.existsSync(entry.filePath)) {
    return { entry, changed: false };
  }
  if (!entry.outputDir || !fs.existsSync(entry.outputDir)) {
    return { entry, changed: false };
  }

  const qualityKey =
    Object.keys(QUALITY_FORMATS).find(
      (k) => QUALITY_FORMATS[k].label === entry.quality || k === entry.quality
    ) || 'best';
  const preset = QUALITY_FORMATS[qualityKey] || QUALITY_FORMATS.best;
  const safeTitle = sanitizeFilename(entry.title, 'video');
  const exts = Array.from(new Set([preset.ext, 'mp4', 'mkv', 'webm', 'mp3', 'm4a']));

  for (const ext of exts) {
    const candidate = path.join(entry.outputDir, `${safeTitle} [${qualityKey}].${ext}`);
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      return {
        entry: {
          ...entry,
          filePath: candidate,
          fileSize: entry.fileSize || stat.size,
        },
        changed: true,
      };
    }
  }
  return { entry, changed: false };
}

function createDefaultSettings(downloadsPath) {
  return {
    downloadDir: path.join(downloadsPath, 'Snipr'),
    maxConnections: 8,
    compatibleMp4: true,
    theme: 'system',
  };
}

function clampConnections(val, fallback = 8) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(16, Math.max(1, Math.round(n)));
}

function normalizeTheme(val, fallback = 'system') {
  if (val === 'dark' || val === 'light' || val === 'system') return val;
  return fallback;
}

function normalizeExtensionId(val, fallback = DEFAULT_EXTENSION_ID) {
  const cleaned = String(val || '').trim().toLowerCase();
  if (/^[a-p]{32}$/.test(cleaned)) return cleaned;
  return fallback;
}

function generateRandomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createStore(userDataDir, downloadsPath) {
  const settingsPath = path.join(userDataDir, 'settings.json');
  const historyPath = path.join(userDataDir, 'history.json');
  const bridgeAuthPath = path.join(userDataDir, 'bridge-auth.json');
  const defaults = createDefaultSettings(downloadsPath);

  async function writeJsonAtomic(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.rename(tmp, filePath);
  }

  async function readJsonSafe(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = await fsp.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  return {
    async getBridgeAuth() {
      const saved = await readJsonSafe(bridgeAuthPath, null);
      if (
        saved &&
        typeof saved.token === 'string' &&
        /^[0-9a-f]{64}$/i.test(saved.token)
      ) {
        return {
          token: saved.token,
          extensionId: normalizeExtensionId(saved.extensionId, DEFAULT_EXTENSION_ID),
        };
      }
      const created = {
        token: generateRandomToken(),
        extensionId: DEFAULT_EXTENSION_ID,
      };
      await writeJsonAtomic(bridgeAuthPath, created);
      return created;
    },

    async regenerateBridgeToken() {
      const current = await this.getBridgeAuth();
      const next = {
        token: generateRandomToken(),
        extensionId: current.extensionId,
      };
      await writeJsonAtomic(bridgeAuthPath, next);
      return next;
    },

    async setAllowedExtensionId(extensionId) {
      const cleaned = String(extensionId || '').trim().toLowerCase();
      if (!/^[a-p]{32}$/.test(cleaned)) {
        throw new Error('Extension ID must be a 32-character Chrome/Edge ID (a-p).');
      }
      const current = await this.getBridgeAuth();
      const next = {
        token: current.token,
        extensionId: cleaned,
      };
      await writeJsonAtomic(bridgeAuthPath, next);
      return next;
    },

    async getSettings() {
      const saved = await readJsonSafe(settingsPath, {});
      const settings = {
        downloadDir:
          typeof saved.downloadDir === 'string' && saved.downloadDir.trim()
            ? saved.downloadDir.trim()
            : defaults.downloadDir,
        maxConnections: clampConnections(saved.maxConnections, defaults.maxConnections),
        compatibleMp4:
          typeof saved.compatibleMp4 === 'boolean'
            ? saved.compatibleMp4
            : defaults.compatibleMp4,
        theme: normalizeTheme(saved.theme, defaults.theme),
      };
      await fsp.mkdir(settings.downloadDir, { recursive: true }).catch(() => {});
      return settings;
    },

    async updateSettings(patch = {}) {
      const current = await this.getSettings();
      const next = {
        downloadDir:
          typeof patch.downloadDir === 'string' && patch.downloadDir.trim()
            ? patch.downloadDir.trim()
            : current.downloadDir,
        maxConnections:
          patch.maxConnections !== undefined
            ? clampConnections(patch.maxConnections, current.maxConnections)
            : current.maxConnections,
        compatibleMp4:
          typeof patch.compatibleMp4 === 'boolean'
            ? patch.compatibleMp4
            : current.compatibleMp4,
        theme:
          patch.theme !== undefined
            ? normalizeTheme(patch.theme, current.theme)
            : current.theme,
      };
      await fsp.mkdir(next.downloadDir, { recursive: true });
      await writeJsonAtomic(settingsPath, next);
      return next;
    },

    async getHistory() {
      const list = await readJsonSafe(historyPath, []);
      if (!Array.isArray(list)) return [];
      const sliced = list.slice(0, MAX_HISTORY);
      let anyChanged = false;
      const healed = sliced.map((item) => {
        const res = healHistoryEntryPath(item);
        if (res.changed) anyChanged = true;
        return res.entry;
      });
      if (anyChanged) {
        await writeJsonAtomic(historyPath, healed).catch(() => {});
      }
      return healed;
    },

    async addHistoryEntry(entry) {
      const list = await this.getHistory();
      const filtered = list.filter((item) => item.id !== entry.id);
      const next = [entry, ...filtered].slice(0, MAX_HISTORY);
      await writeJsonAtomic(historyPath, next);
      return next;
    },

    async updateHistoryEntry(id, patch) {
      const list = await this.getHistory();
      const next = list.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      );
      await writeJsonAtomic(historyPath, next);
      return next;
    },

    async deleteHistoryEntry(id) {
      const list = await this.getHistory();
      const next = list.filter((item) => item.id !== id);
      await writeJsonAtomic(historyPath, next);
      return next;
    },

    async clearHistory() {
      await writeJsonAtomic(historyPath, []);
      return [];
    },
  };
}

module.exports = {
  DEFAULT_EXTENSION_ID,
  createStore,
  clampConnections,
};
