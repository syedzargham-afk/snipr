const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  QUALITY_FORMATS,
  validateUrl,
  buildDownloadArgs,
  spawnYtDlp,
  parseProgressLine,
  mapYtDlpError,
  probeMedia,
  convertToCompatibleMp4,
  killProcessTree,
  sanitizeFilename,
} = require('./ytdlp');

function createDownloadManager({ binDir, store, onStateChange, onQueueChange }) {
  let current = null;
  let activeProc = null;
  let lastEmit = 0;
  const queue = [];

  function snapshot() {
    return current ? { ...current } : null;
  }

  function queueSnapshot() {
    return queue.map((q) => ({ ...q }));
  }

  function emit(force = false) {
    const now = Date.now();
    if (force || now - lastEmit >= 180) {
      lastEmit = now;
      onStateChange(snapshot());
    }
  }

  function emitQueue() {
    if (onQueueChange) onQueueChange(queueSnapshot());
  }

  async function recordHistory(item, status, probe = null) {
    await store.addHistoryEntry({
      id: item.id,
      title: item.title,
      url: item.url,
      platform: item.platform,
      thumbnail: item.thumbnail || null,
      quality: QUALITY_FORMATS[item.quality]?.label || item.quality,
      date: new Date().toISOString(),
      status,
      filePath: item.filePath || null,
      outputDir: item.outputDir,
      fileSize: probe?.fileSize || item.fileSize || null,
      vcodec: probe?.vcodec || item.vcodec || null,
      acodec: probe?.acodec || item.acodec || null,
      windowsCompatible:
        probe && typeof probe.windowsCompatible === 'boolean'
          ? probe.windowsCompatible
          : true,
    });
  }

  async function processNextInQueue() {
    if (queue.length === 0) return;
    if (
      current &&
      (current.status === 'downloading' ||
        current.status === 'merging' ||
        current.status === 'converting' ||
        current.status === 'paused')
    ) {
      return;
    }
    const nextItem = queue.shift();
    emitQueue();
    if (nextItem) {
      await beginItem(nextItem);
    }
  }

  async function resolveOutputFilePath(item) {
    if (item.filePath && fs.existsSync(item.filePath)) {
      return item.filePath;
    }

    const preset = QUALITY_FORMATS[item.quality] || QUALITY_FORMATS.best;
    const safeTitle = sanitizeFilename(item.title, 'video');
    const candidateExts = Array.from(
      new Set([preset.ext, 'mp4', 'mkv', 'webm', 'mp3', 'm4a'])
    );

    for (const ext of candidateExts) {
      const candidate = path.join(
        item.outputDir,
        `${safeTitle} [${item.quality}].${ext}`
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    try {
      const files = await fsp.readdir(item.outputDir);
      const tag = `[${item.quality}]`;
      const matches = [];
      for (const name of files) {
        if (
          !name.includes(tag) ||
          name.endsWith('.part') ||
          name.endsWith('.aria2') ||
          name.endsWith('.ytdl') ||
          name.includes('.grabit_h264_tmp')
        ) {
          continue;
        }
        const full = path.join(item.outputDir, name);
        const stat = await fsp.stat(full).catch(() => null);
        if (stat && stat.isFile()) {
          matches.push({ full, mtimeMs: stat.mtimeMs });
        }
      }
      if (matches.length > 0) {
        matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return matches[0].full;
      }
    } catch {
      // Ignore scan errors
    }

    return item.filePath || null;
  }

  async function finalizeSuccess(item, settings) {
    item.filePath = await resolveOutputFilePath(item);

    let probe = await probeMedia(binDir, item.filePath);

    // Automatically ensure Windows-compatible H.264 + AAC for video downloads when enabled
    if (
      settings.compatibleMp4 !== false &&
      item.quality !== 'mp3' &&
      item.filePath &&
      probe &&
      !probe.windowsCompatible
    ) {
      item.status = 'converting';
      item.percent = 0;
      item.speedBps = 0;
      item.etaSeconds = null;
      emit(true);
      try {
        const res = await convertToCompatibleMp4(
          binDir,
          item.filePath,
          (pct) => {
            if (!current || current.id !== item.id) return;
            if (current.status !== 'converting') return;
            current.percent = pct;
            emit(false);
          },
          (proc) => {
            activeProc = proc;
          }
        );
        activeProc = null;
        if (!current || current.id !== item.id) return;
        if (current.status === 'cancelled' || current.status === 'paused') return;
        item.filePath = res.filePath;
        if (res.probe) probe = res.probe;
      } catch {
        activeProc = null;
        // Keep original file if conversion fails, user can still play in Snipr's built-in player
      }
    }

    if (!current || current.id !== item.id) return;
    if (current.status === 'paused' || current.status === 'cancelled') return;

    current.status = 'completed';
    current.percent = 100;
    current.speedBps = 0;
    current.etaSeconds = 0;
    current.fileSize = probe?.fileSize || current.totalBytes || null;
    current.vcodec = probe?.vcodec || null;
    current.acodec = probe?.acodec || null;
    current.windowsCompatible =
      probe && typeof probe.windowsCompatible === 'boolean'
        ? probe.windowsCompatible
        : true;
    emit(true);
    await recordHistory(current, 'Completed', probe);
    void processNextInQueue();
  }

  async function runActiveDownload(item) {
    const settings = await store.getSettings();
    item.outputDir = item.outputDir || settings.downloadDir;
    item.maxConnections = settings.maxConnections || 8;
    await fsp.mkdir(item.outputDir, { recursive: true });

    const { args } = buildDownloadArgs({
      url: item.url,
      outputDir: item.outputDir,
      title: item.title,
      quality: item.quality,
      maxConnections: settings.maxConnections,
      compatibleMp4: settings.compatibleMp4 !== false,
      binDir,
    });

    const proc = spawnYtDlp(binDir, args);
    activeProc = proc;

    let buffer = '';
    let stderrText = '';

    const processChunk = (chunk, isStderr) => {
      const str = chunk.toString('utf8');
      if (isStderr) {
        stderrText = (stderrText + str).slice(-3000);
      }
      buffer += str;
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!current || current.id !== item.id) continue;
        if (current.status === 'paused' || current.status === 'cancelled') continue;

        const parsed = parseProgressLine(line);
        if (!parsed) continue;

        if (parsed.type === 'progress') {
          current.status = 'downloading';
          current.percent = parsed.percent;
          current.downloadedBytes = parsed.downloadedBytes;
          current.totalBytes = parsed.totalBytes || current.totalBytes;
          current.speedBps = parsed.speedBps;
          current.etaSeconds = parsed.etaSeconds;
          emit(false);
        } else if (parsed.type === 'merging') {
          current.status = 'merging';
          current.speedBps = 0;
          current.etaSeconds = null;
          if (parsed.filePath && fs.existsSync(parsed.filePath)) {
            current.filePath = parsed.filePath;
          }
          emit(true);
        } else if (parsed.type === 'destination') {
          if (
            parsed.filePath &&
            !current.filePath &&
            fs.existsSync(parsed.filePath)
          ) {
            current.filePath = parsed.filePath;
          }
        } else if (parsed.type === 'file') {
          if (parsed.filePath && fs.existsSync(parsed.filePath)) {
            current.filePath = parsed.filePath;
          }
        }
      }
    };

    proc.stdout.on('data', (c) => processChunk(c, false));
    proc.stderr.on('data', (c) => processChunk(c, true));

    proc.on('error', async () => {
      activeProc = null;
      if (!current || current.id !== item.id) return;
      if (current.status === 'paused' || current.status === 'cancelled') return;

      current.status = 'error';
      current.speedBps = 0;
      current.etaSeconds = null;
      current.error = 'Unable to launch downloader process.';
      emit(true);
      await recordHistory(current, 'Error');
    });

    proc.on('close', async (code) => {
      activeProc = null;
      if (!current || current.id !== item.id) return;
      if (current.status === 'paused' || current.status === 'cancelled') return;

      if (code === 0) {
        await finalizeSuccess(current, settings);
      } else {
        current.status = 'error';
        current.speedBps = 0;
        current.etaSeconds = null;
        current.error = mapYtDlpError(stderrText);
        emit(true);
        await recordHistory(current, 'Error');
      }
    });
  }

  async function beginItem(payload) {
    if (activeProc) {
      await killProcessTree(activeProc);
      activeProc = null;
    }
    const settings = await store.getSettings();
    current = {
      id: payload.id || crypto.randomUUID(),
      url: payload.url,
      title: payload.title || 'Untitled Video',
      platform: payload.platform || 'Web',
      thumbnail: payload.thumbnail || null,
      quality: QUALITY_FORMATS[payload.quality] ? payload.quality : 'best',
      outputDir: settings.downloadDir,
      maxConnections: settings.maxConnections || 8,
      filePath: null,
      fileSize: null,
      vcodec: null,
      acodec: null,
      windowsCompatible: true,
      status: 'downloading',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
    };
    emit(true);
    await runActiveDownload(current);
    return snapshot();
  }

  return {
    getCurrent: snapshot,
    getQueue: queueSnapshot,

    async startDownload({ url, title, platform, thumbnail, quality, allowQueue = true }) {
      const validUrl = validateUrl(url);
      const isBusy =
        current &&
        (current.status === 'downloading' ||
          current.status === 'merging' ||
          current.status === 'converting' ||
          current.status === 'paused');

      if (isBusy) {
        if (!allowQueue) {
          throw new Error('A download is already in progress. Pause or cancel it first.');
        }
        const queuedItem = {
          id: crypto.randomUUID(),
          url: validUrl,
          title: title || 'Untitled Video',
          platform: platform || 'Web',
          thumbnail: thumbnail || null,
          quality: QUALITY_FORMATS[quality] ? quality : 'best',
          addedAt: new Date().toISOString(),
        };
        queue.push(queuedItem);
        emitQueue();
        return { queued: true, item: queuedItem, current: snapshot(), queue: queueSnapshot() };
      }

      return beginItem({
        url: validUrl,
        title,
        platform,
        thumbnail,
        quality,
      });
    },

    removeFromQueue(id) {
      const idx = queue.findIndex((q) => q.id === id);
      if (idx !== -1) {
        queue.splice(idx, 1);
        emitQueue();
      }
      return queueSnapshot();
    },

    clearQueue() {
      queue.length = 0;
      emitQueue();
      return [];
    },

    async pause() {
      if (
        !current ||
        (current.status !== 'downloading' && current.status !== 'merging')
      ) {
        return snapshot();
      }
      current.status = 'paused';
      current.speedBps = 0;
      current.etaSeconds = null;
      emit(true);
      if (activeProc) {
        const p = activeProc;
        activeProc = null;
        await killProcessTree(p);
      }
      return snapshot();
    },

    async resume() {
      if (!current || (current.status !== 'paused' && current.status !== 'error')) {
        return snapshot();
      }
      current.status = 'downloading';
      current.error = null;
      emit(true);
      await runActiveDownload(current);
      return snapshot();
    },

    async cancel() {
      if (!current) return null;
      const item = current;
      item.status = 'cancelled';
      item.speedBps = 0;
      item.etaSeconds = null;
      emit(true);

      if (activeProc) {
        const p = activeProc;
        activeProc = null;
        await killProcessTree(p);
      }

      try {
        const safePrefix = `${sanitizeFilename(item.title, 'video')} [${item.quality}]`;
        const files = await fsp.readdir(item.outputDir);
        for (const f of files) {
          if (
            f.startsWith(safePrefix) &&
            (f.endsWith('.part') ||
              f.endsWith('.aria2') ||
              f.endsWith('.ytdl') ||
              f.endsWith('.grabit_h264_tmp.mp4'))
          ) {
            await fsp.rm(path.join(item.outputDir, f), { force: true });
          }
        }
      } catch {
        // Ignore cleanup errors
      }

      await recordHistory(item, 'Cancelled');
      current = null;
      emit(true);
      void processNextInQueue();
      return null;
    },

    async convertExistingFile(historyId, filePath) {
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('File no longer exists on disk.');
      }
      if (
        current &&
        (current.status === 'downloading' ||
          current.status === 'merging' ||
          current.status === 'converting')
      ) {
        throw new Error('Wait for the active download to finish before converting.');
      }

      const fileName = path.basename(filePath);
      current = {
        id: historyId || crypto.randomUUID(),
        url: '',
        title: `Converting: ${fileName}`,
        platform: 'FFmpeg',
        thumbnail: null,
        quality: 'H.264 MP4',
        outputDir: path.dirname(filePath),
        filePath,
        status: 'converting',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        error: null,
      };
      emit(true);

      try {
        const res = await convertToCompatibleMp4(
          binDir,
          filePath,
          (pct) => {
            if (!current || current.status !== 'converting') return;
            current.percent = pct;
            emit(false);
          },
          (proc) => {
            activeProc = proc;
          }
        );
        activeProc = null;
        if (!current || current.status === 'cancelled') return null;

        current.status = 'completed';
        current.percent = 100;
        current.filePath = res.filePath;
        current.fileSize = res.probe?.fileSize || null;
        current.vcodec = res.probe?.vcodec || 'h264';
        current.acodec = res.probe?.acodec || 'aac';
        current.windowsCompatible = true;
        emit(true);

        if (historyId) {
          await store.updateHistoryEntry(historyId, {
            filePath: res.filePath,
            fileSize: res.probe?.fileSize || null,
            vcodec: res.probe?.vcodec || 'h264',
            acodec: res.probe?.acodec || 'aac',
            windowsCompatible: true,
          });
        }
        void processNextInQueue();
        return { ok: true, filePath: res.filePath, probe: res.probe };
      } catch (err) {
        activeProc = null;
        if (current) {
          current.status = 'error';
          current.error = err?.message || 'Conversion failed.';
          emit(true);
        }
        throw err;
      }
    },

    async shutdown() {
      if (activeProc) {
        const p = activeProc;
        activeProc = null;
        await killProcessTree(p);
      }
    },
  };
}

module.exports = { createDownloadManager };
