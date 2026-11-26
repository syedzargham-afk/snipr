const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { QUALITY_FORMATS, validateUrl, fetchMetadata } = require('./ytdlp');

const BRIDGE_PORT = 48921;
const BRIDGE_HOST = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 65536;
const GRAB_RATE_WINDOW_MS = 60_000;
const GRAB_RATE_MAX = 20;
const STREAM_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_STREAMS = 32;

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function safeTokenEquals(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isValidHostHeader(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const h = hostHeader.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function isAllowedMediaOrigin(origin) {
  if (!origin || origin === 'null') return true;
  return origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';
}

function isAllowedMediaExtension(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_TYPES, ext);
}

function isPrivateOrLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  const ipType = net.isIP(host);
  if (ipType === 4) {
    const parts = host.split('.').map((n) => Number.parseInt(n, 10));
    const [a, b] = parts;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  } else if (ipType === 6) {
    if (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    ) {
      return true;
    }
  }
  return false;
}

function validateExternalGrabUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    throw new Error('Invalid URL length.');
  }
  const normalized = validateUrl(rawUrl);
  const parsed = new URL(normalized);
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error('Local or private network URLs are not permitted.');
  }
  return normalized;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        settled = true;
        const err = new Error('Request body too large.');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object.');
          err.statusCode = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('Invalid JSON body.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function isInsideDirReal(realTargetPath, baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) return false;
  try {
    const realBase = fs.realpathSync(baseDir);
    const rel = path.relative(realBase, realTargetPath);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

async function isAuthorizedMediaPath(targetPath, store, downloadManager) {
  if (!targetPath || typeof targetPath !== 'string' || !fs.existsSync(targetPath)) {
    return false;
  }
  if (!isAllowedMediaExtension(targetPath)) {
    return false;
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(targetPath);
    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const [settings, history] = await Promise.all([
    store.getSettings(),
    store.getHistory(),
  ]);

  if (isInsideDirReal(realTarget, settings.downloadDir)) {
    return true;
  }

  const activeList =
    typeof downloadManager.getDownloads === 'function'
      ? downloadManager.getDownloads()
      : [downloadManager.getCurrent()].filter(Boolean);
  for (const active of activeList) {
    if (active?.filePath && fs.existsSync(active.filePath)) {
      try {
        if (fs.realpathSync(active.filePath) === realTarget) return true;
      } catch {}
    }
  }

  for (const entry of history) {
    if (entry.filePath && fs.existsSync(entry.filePath)) {
      try {
        if (fs.realpathSync(entry.filePath) === realTarget) return true;
      } catch {}
    }
  }

  return false;
}

function streamMediaFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2]
      ? Math.min(total - 1, Number.parseInt(match[2], 10))
      : total - 1;

    if (start >= total || start > end || start < 0) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }

    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', total);
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function createBridgeServer({
  binDir,
  store,
  downloadManager,
  getMissingBinaries,
  onExtensionEvent,
  port = BRIDGE_PORT,
}) {
  let server = null;
  let listening = false;
  let lastExtensionSeen = null;
  const grabTimestamps = [];
  const streamSessions = new Map();

  function pruneStreams() {
    const now = Date.now();
    for (const [id, entry] of streamSessions.entries()) {
      if (entry.expiresAt <= now) {
        streamSessions.delete(id);
      }
    }
  }

  async function createStreamSession(filePath) {
    const allowed = await isAuthorizedMediaPath(filePath, store, downloadManager);
    if (!allowed) {
      throw new Error('Media file is not accessible.');
    }
    pruneStreams();
    if (streamSessions.size >= MAX_ACTIVE_STREAMS) {
      const oldestKey = streamSessions.keys().next().value;
      if (oldestKey) streamSessions.delete(oldestKey);
    }

    const realPath = fs.realpathSync(filePath);
    const id = crypto.randomBytes(12).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    streamSessions.set(id, {
      realPath,
      token,
      expiresAt: Date.now() + STREAM_TTL_MS,
    });

    return {
      id,
      url: `http://${BRIDGE_HOST}:${port}/stream/${id}?t=${token}`,
      expiresInMs: STREAM_TTL_MS,
    };
  }

  function checkRateLimit() {
    const now = Date.now();
    while (grabTimestamps.length > 0 && now - grabTimestamps[0] > GRAB_RATE_WINDOW_MS) {
      grabTimestamps.shift();
    }
    if (grabTimestamps.length >= GRAB_RATE_MAX) {
      return false;
    }
    grabTimestamps.push(now);
    return true;
  }

  async function handleGrab(body) {
    const validUrl = validateExternalGrabUrl(body.url);
    const requestedQuality = typeof body.quality === 'string' ? body.quality : 'best';
    const quality = Object.prototype.hasOwnProperty.call(QUALITY_FORMATS, requestedQuality)
      ? requestedQuality
      : 'best';
    const autoStart = body.autoStart !== false;
    const safeBodyTitle =
      typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';

    lastExtensionSeen = new Date().toISOString();
    if (onExtensionEvent) {
      onExtensionEvent({
        type: 'connected',
        lastExtensionSeen,
      });
    }

    let meta;
    try {
      meta = await fetchMetadata(binDir, validUrl);
    } catch {
      let fallbackHost = 'Browser';
      try {
        fallbackHost = new URL(validUrl).hostname.replace(/^www\./, '');
      } catch {}
      meta = {
        url: validUrl,
        title: safeBodyTitle || 'Browser Video',
        platform: fallbackHost,
        thumbnail: null,
        duration: 'Unknown',
      };
    }

    if (onExtensionEvent) {
      onExtensionEvent({
        type: 'grabbed',
        url: meta.url,
        title: meta.title,
        quality,
        autoStart,
        metadata: meta,
        lastExtensionSeen,
      });
    }

    if (!autoStart) {
      return { ok: true, status: 'prefilled', metadata: meta };
    }

    const result = await downloadManager.startDownload({
      url: meta.url,
      title: meta.title,
      platform: meta.platform,
      thumbnail: meta.thumbnail,
      quality,
      allowQueue: true,
    });

    return {
      ok: true,
      status: result?.queued ? 'queued' : 'started',
      metadata: meta,
      data: result,
    };
  }

  function applySecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  const requestListener = async (req, res) => {
    applySecurityHeaders(res);

    // 1. Defend against DNS-rebinding by checking Host header strictly
    if (!isValidHostHeader(req.headers.host, port)) {
      sendJson(res, 403, { ok: false, error: 'Invalid Host header.' });
      return;
    }

    const rawUrl = String(req.url || '/');
    // Block path traversal patterns immediately
    if (
      rawUrl.includes('..') ||
      rawUrl.toLowerCase().includes('%2e%2e') ||
      rawUrl.includes('\\')
    ) {
      sendJson(res, 403, { ok: false, error: 'Invalid path.' });
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl, `http://${BRIDGE_HOST}:${port}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Bad URL.' });
      return;
    }

    const reqPath = parsedUrl.pathname;
    const origin = req.headers.origin;
    const auth = await store.getBridgeAuth();
    const exactExtOrigin = `chrome-extension://${auth.extensionId}`;
    const isStreamRoute = reqPath.startsWith('/stream/');

    // 2. Strict CORS Origin enforcement (exact extension ID only, no wildcards)
    if (isStreamRoute) {
      if (origin && !isAllowedMediaOrigin(origin)) {
        sendJson(res, 403, { ok: false, error: 'Origin not permitted.' });
        return;
      }
      if (origin && isAllowedMediaOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
    } else {
      if (origin && origin !== exactExtOrigin) {
        sendJson(res, 403, { ok: false, error: 'Origin not permitted.' });
        return;
      }
      if (origin === exactExtOrigin) {
        res.setHeader('Access-Control-Allow-Origin', exactExtOrigin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Snipr-Token, X-GrabIt-Token, X-Snipr-Extension, X-GrabIt-Extension'
      );
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      // 3. Built-in player short-lived random stream URLs (/stream/<id>?t=<token>)
      if (req.method === 'GET' && isStreamRoute) {
        pruneStreams();
        const streamId = reqPath.slice('/stream/'.length);
        const queryToken = parsedUrl.searchParams.get('t') || '';
        if (!/^[0-9a-f]{24}$/.test(streamId)) {
          sendJson(res, 403, { ok: false, error: 'Invalid stream ID.' });
          return;
        }
        const sessionEntry = streamSessions.get(streamId);
        if (!sessionEntry || !safeTokenEquals(sessionEntry.token, queryToken)) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized stream token.' });
          return;
        }
        const stillAllowed = await isAuthorizedMediaPath(
          sessionEntry.realPath,
          store,
          downloadManager
        );
        if (!stillAllowed) {
          streamSessions.delete(streamId);
          sendJson(res, 403, { ok: false, error: 'Media file not accessible.' });
          return;
        }
        streamMediaFile(req, res, sessionEntry.realPath);
        return;
      }

      // 4. Require X-Snipr-Token (or legacy X-GrabIt-Token) on EVERY /api/* endpoint
      const providedToken =
        req.headers['x-snipr-token'] || req.headers['x-grabit-token'];
      if (!safeTokenEquals(auth.token, providedToken)) {
        sendJson(res, 401, {
          ok: false,
          error: 'Unauthorized: missing or invalid X-Snipr-Token.',
        });
        return;
      }

      if (req.method === 'GET' && reqPath === '/api/ping') {
        lastExtensionSeen = new Date().toISOString();
        if (onExtensionEvent) {
          onExtensionEvent({ type: 'connected', lastExtensionSeen });
        }
        const missing = getMissingBinaries ? getMissingBinaries(binDir) : [];
        sendJson(res, 200, {
          ok: true,
          app: 'Snipr Download Manager',
          shortName: 'Snipr',
          version: '1.0.0',
          ready: missing.length === 0,
          downloads:
            typeof downloadManager.getDownloads === 'function'
              ? downloadManager.getDownloads()
              : [],
          activeDownload: downloadManager.getCurrent(),
          queue: downloadManager.getQueue(),
          lastExtensionSeen,
        });
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/grab') {
        if (!checkRateLimit()) {
          sendJson(res, 429, {
            ok: false,
            error: 'Too many requests. Please wait a moment.',
          });
          return;
        }
        const body = await readJsonBody(req);
        const result = await handleGrab(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/pause') {
        const body = await readJsonBody(req).catch(() => ({}));
        sendJson(res, 200, { ok: true, data: await downloadManager.pause(body.id) });
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/resume') {
        const body = await readJsonBody(req).catch(() => ({}));
        sendJson(res, 200, { ok: true, data: await downloadManager.resume(body.id) });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      const status = Number(err?.statusCode) || 400;
      sendJson(res, status, {
        ok: false,
        error: err?.message || 'Request failed',
      });
    }
  };

  return {
    port,
    host: BRIDGE_HOST,
    createStreamSession,
    getStatus() {
      return {
        listening,
        port,
        host: BRIDGE_HOST,
        url: `http://${BRIDGE_HOST}:${port}`,
        lastExtensionSeen,
      };
    },
    start() {
      return new Promise((resolve) => {
        if (server) return resolve(this.getStatus());
        server = http.createServer((req, res) => {
          void requestListener(req, res);
        });
        server.requestTimeout = 30000;
        server.headersTimeout = 10000;
        server.keepAliveTimeout = 5000;
        server.on('error', (err) => {
          if (err && err.code === 'EADDRINUSE') {
            listening = false;
            server = null;
            resolve(this.getStatus());
          }
        });
        server.listen(port, BRIDGE_HOST, () => {
          listening = true;
          resolve(this.getStatus());
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) {
          listening = false;
          return resolve();
        }
        server.close(() => {
          server = null;
          listening = false;
          resolve();
        });
      });
    },
  };
}

module.exports = {
  BRIDGE_PORT,
  BRIDGE_HOST,
  createBridgeServer,
  isAuthorizedMediaPath,
  isAllowedMediaExtension,
  isPrivateOrLoopbackHost,
};
