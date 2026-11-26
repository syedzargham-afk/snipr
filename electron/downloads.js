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

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 4;
const ACTIVE_PROCESS_STATUSES = new Set(['downloading', 'merging', 'converting']);

function isRunningStatus(status) {
  return ACTIVE_PROCESS_STATUSES.has(status);
}

function isLiveStatus(status) {
  return isRunningStatus(status) || status === 'paused';
}

function createDownloadManager({
  binDir,
  store,
  onStateChange,
  onDownloadsChange,
  onQueueChange,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_DOWNLOADS,
}) {
  /** @type {Map<string, object>} Ordered newest-first for UI updates */
  const items = new Map();
  /** @type {Map<string, import('node:child_process').ChildProcess>} */
  const procs = new Map();
  const queue = [];
  let lastEmit = 0;
  let pendingTimer = null;

  function listSnapshots() {
    return Array.from(items.values())
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((item) => ({ ...item }));
  }

  function primarySnapshot() {
    const list = listSnapshots();
    return list.find((item) => isLiveStatus(item.status)) || list[0] || null;
  }

  function queueSnapshot() {
    return queue.map((q) => ({ ...q }));
  }

  function runningCount() {
    let count = 0;
    for (const item of items.values()) {
      if (isRunningStatus(item.status)) count += 1;
    }
    return count;
  }

  function flushEmit() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    lastEmit = Date.now();
    const list = listSnapshots();
    if (onDownloadsChange) onDownloadsChange(list);
    if (onStateChange) {
      const primary = list.find((item) => isLiveStatus(item.status)) || list[0] || null;
      onStateChange(primary);
    }
  }

  function emit(force = false) {
    if (force) {
      flushEmit();
      return;
    }
    const elapsed = Date.now() - lastEmit;
    if (elapsed >= 180) {
      flushEmit();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        flushEmit();
      }, 180 - elapsed);
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
    while (queue.length > 0 && runningCount() < maxConcurrent) {
      const nextItem = queue.shift();
      emitQueue();
      if (nextItem) {
        await beginItem(nextItem);
      }
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
            const live = items.get(item.id);
            if (!live || live.status !== 'converting') return;
            live.percent = pct;
            emit(false);
          },
          (proc) => {
            procs.set(item.id, proc);
          }
        );
        procs.delete(item.id);
        const live = items.get(item.id);
        if (!live || live.status === 'cancelled' || live.status === 'paused') return;
        item.filePath = res.filePath;
        if (res.probe) probe = res.probe;
      } catch {
        procs.delete(item.id);
      }
    }

    const live = items.get(item.id);
    if (!live || live.status === 'paused' || live.status === 'cancelled') return;

    live.status = 'completed';
    live.percent = 100;
    live.speedBps = 0;
    live.etaSeconds = 0;
    live.fileSize = probe?.fileSize || live.totalBytes || null;
    live.vcodec = probe?.vcodec || null;
    live.acodec = probe?.acodec || null;
    live.windowsCompatible =
      probe && typeof probe.windowsCompatible === 'boolean'
        ? probe.windowsCompatible
        : true;
    emit(true);
    await recordHistory(live, 'Completed', probe);
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
    procs.set(item.id, proc);

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
        const live = items.get(item.id);
        if (!live || live.status === 'paused' || live.status === 'cancelled') continue;

        const parsed = parseProgressLine(line);
        if (!parsed) continue;

        if (parsed.type === 'progress') {
          live.status = 'downloading';
          live.percent = parsed.percent;
          live.downloadedBytes = parsed.downloadedBytes;
          live.totalBytes = parsed.totalBytes || live.totalBytes;
          live.speedBps = parsed.speedBps;
          live.etaSeconds = parsed.etaSeconds;
          emit(false);
        } else if (parsed.type === 'merging') {
          live.status = 'merging';
          live.speedBps = 0;
          live.etaSeconds = null;
          if (parsed.filePath && fs.existsSync(parsed.filePath)) {
            live.filePath = parsed.filePath;
          }
          emit(true);
        } else if (parsed.type === 'destination') {
          if (parsed.filePath && !live.filePath && fs.existsSync(parsed.filePath)) {
            live.filePath = parsed.filePath;
          }
        } else if (parsed.type === 'file') {
          if (parsed.filePath && fs.existsSync(parsed.filePath)) {
            live.filePath = parsed.filePath;
          }
        }
      }
    };

    proc.stdout.on('data', (c) => processChunk(c, false));
    proc.stderr.on('data', (c) => processChunk(c, true));

    proc.on('error', async () => {
      procs.delete(item.id);
      const live = items.get(item.id);
      if (!live || live.status === 'paused' || live.status === 'cancelled') return;

      live.status = 'error';
      live.speedBps = 0;
      live.etaSeconds = null;
      live.error = 'Unable to launch downloader process.';
      emit(true);
      await recordHistory(live, 'Error');
      void processNextInQueue();
    });

    proc.on('close', async (code) => {
      procs.delete(item.id);
      const live = items.get(item.id);
      if (!live || live.status === 'paused' || live.status === 'cancelled') return;

      if (code === 0) {
        await finalizeSuccess(live, settings);
      } else {
        live.status = 'error';
        live.speedBps = 0;
        live.etaSeconds = null;
        live.error = mapYtDlpError(stderrText);
        emit(true);
        await recordHistory(live, 'Error');
        void processNextInQueue();
      }
    });
  }

  async function beginItem(payload) {
    const id = payload.id || crypto.randomUUID();
    const existingProc = procs.get(id);
    if (existingProc) {
      await killProcessTree(existingProc);
      procs.delete(id);
    }

    const settings = await store.getSettings();
    const item = {
      id,
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
      createdAtMs: Date.now(),
    };
    items.set(id, item);
    emit(true);
    await runActiveDownload(item);
    return { ...item };
  }

  function resolveTargetItem(id, predicate) {
    if (id && items.has(id)) {
      const target = items.get(id);
      return !predicate || predicate(target) ? target : null;
    }
    const ordered = Array.from(items.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
    return ordered.find((item) => (!predicate || predicate(item))) || null;
  }

  return {
    getCurrent: primarySnapshot,
    getDownloads: listSnapshots,
    getQueue: queueSnapshot,

    async startDownload({ url, title, platform, thumbnail, quality, allowQueue = true }) {
      const validUrl = validateUrl(url);
      const normQuality = QUALITY_FORMATS[quality] ? quality : 'best';

      const duplicateLive = Array.from(items.values()).some(
        (item) =>
          isLiveStatus(item.status) &&
          item.url === validUrl &&
          item.quality === normQuality
      );
      const duplicateQueued = queue.some(
        (q) => q.url === validUrl && q.quality === normQuality
      );
      if (duplicateLive || duplicateQueued) {
        throw new Error('This video is already active in that quality.');
      }

      if (runningCount() >= maxConcurrent) {
        if (!allowQueue) {
          throw new Error(
            `Maximum ${maxConcurrent} concurrent downloads active. Pause or finish one first.`
          );
        }
        const queuedItem = {
          id: crypto.randomUUID(),
          url: validUrl,
          title: title || 'Untitled Video',
          platform: platform || 'Web',
          thumbnail: thumbnail || null,
          quality: normQuality,
          addedAt: new Date().toISOString(),
        };
        queue.push(queuedItem);
        emitQueue();
        return {
          queued: true,
          item: queuedItem,
          downloads: listSnapshots(),
          current: primarySnapshot(),
          queue: queueSnapshot(),
        };
      }

      const started = await beginItem({
        url: validUrl,
        title,
        platform,
        thumbnail,
        quality: normQuality,
      });
      return {
        queued: false,
        item: started,
        downloads: listSnapshots(),
        current: primarySnapshot(),
        queue: queueSnapshot(),
      };
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

    async pause(id) {
      const target = resolveTargetItem(
        id,
        (item) => item.status === 'downloading' || item.status === 'merging'
      );
      if (!target) return primarySnapshot();

      target.status = 'paused';
      target.speedBps = 0;
      target.etaSeconds = null;
      emit(true);

      const proc = procs.get(target.id);
      if (proc) {
        procs.delete(target.id);
        await killProcessTree(proc);
      }
      void processNextInQueue();
      return { ...target };
    },

    async resume(id) {
      const target = resolveTargetItem(
        id,
        (item) => item.status === 'paused' || item.status === 'error'
      );
      if (!target) return primarySnapshot();

      if (runningCount() >= maxConcurrent) {
        items.delete(target.id);
        queue.unshift({
          id: target.id,
          url: target.url,
          title: target.title,
          platform: target.platform,
          thumbnail: target.thumbnail,
          quality: target.quality,
          addedAt: new Date().toISOString(),
        });
        emit(true);
        emitQueue();
        return null;
      }

      target.status = 'downloading';
      target.error = null;
      emit(true);
      await runActiveDownload(target);
      return { ...target };
    },

    async cancel(id) {
      const target = resolveTargetItem(id);
      if (!target) return null;

      if (target.status === 'completed') {
        items.delete(target.id);
        emit(true);
        return listSnapshots();
      }

      target.status = 'cancelled';
      target.speedBps = 0;
      target.etaSeconds = null;
      emit(true);

      const proc = procs.get(target.id);
      if (proc) {
        procs.delete(target.id);
        await killProcessTree(proc);
      }

      try {
        const safePrefix = `${sanitizeFilename(target.title, 'video')} [${target.quality}]`;
        const files = await fsp.readdir(target.outputDir);
        for (const f of files) {
          if (
            f.startsWith(safePrefix) &&
            (f.endsWith('.part') ||
              f.endsWith('.aria2') ||
              f.endsWith('.ytdl') ||
              f.endsWith('.grabit_h264_tmp.mp4'))
          ) {
            await fsp.rm(path.join(target.outputDir, f), { force: true });
          }
        }
      } catch {
        // Ignore cleanup errors
      }

      await recordHistory(target, 'Cancelled');
      items.delete(target.id);
      emit(true);
      void processNextInQueue();
      return listSnapshots();
    },

    dismiss(id) {
      const target = resolveTargetItem(
        id,
        (item) => item.status === 'completed' || item.status === 'error'
      );
      if (target) {
        items.delete(target.id);
        emit(true);
      }
      return listSnapshots();
    },

    clearFinished() {
      for (const [id, item] of items.entries()) {
        if (item.status === 'completed' || item.status === 'error') {
          items.delete(id);
        }
      }
      emit(true);
      return listSnapshots();
    },

    async convertExistingFile(historyId, filePath) {
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('File no longer exists on disk.');
      }
      const hasConverting = Array.from(items.values()).some(
        (item) => item.id === historyId && isRunningStatus(item.status)
      );
      if (hasConverting) {
        throw new Error('Conversion is already running for this file.');
      }

      const id = historyId || crypto.randomUUID();
      const fileName = path.basename(filePath);
      const item = {
        id,
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
        createdAtMs: Date.now(),
      };
      items.set(id, item);
      emit(true);

      try {
        const res = await convertToCompatibleMp4(
          binDir,
          filePath,
          (pct) => {
            const live = items.get(id);
            if (!live || live.status !== 'converting') return;
            live.percent = pct;
            emit(false);
          },
          (proc) => {
            procs.set(id, proc);
          }
        );
        procs.delete(id);
        const live = items.get(id);
        if (!live || live.status === 'cancelled') return null;

        live.status = 'completed';
        live.percent = 100;
        live.filePath = res.filePath;
        live.fileSize = res.probe?.fileSize || null;
        live.vcodec = res.probe?.vcodec || 'h264';
        live.acodec = res.probe?.acodec || 'aac';
        live.windowsCompatible = true;
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
        return { ok: true, filePath: res.filePath, probe: res.probe };
      } catch (err) {
        procs.delete(id);
        const live = items.get(id);
        if (live) {
          live.status = 'error';
          live.error = err?.message || 'Conversion failed.';
          emit(true);
        }
        throw err;
      }
    },

    async shutdown() {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      const running = Array.from(procs.values());
      procs.clear();
      await Promise.all(running.map((p) => killProcessTree(p)));
    },
  };
}

module.exports = { createDownloadManager, DEFAULT_MAX_CONCURRENT_DOWNLOADS };
