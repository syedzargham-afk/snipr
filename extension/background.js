const BRIDGE_BASE = 'http://127.0.0.1:48921';
const MEDIA_EXT_RE = /\.(mp4|m4v|webm|m3u8|mpd|mp3|m4a)(\?|$)/i;
const MAX_STREAMS_PER_TAB = 12;
const STORAGE_TOKEN_KEY = 'sniprToken';

const tabStreams = new Map();

async function getStoredToken() {
  try {
    const res = await chrome.storage.local.get([STORAGE_TOKEN_KEY]);
    return typeof res[STORAGE_TOKEN_KEY] === 'string'
      ? res[STORAGE_TOKEN_KEY].trim()
      : '';
  } catch {
    return '';
  }
}

function recordStream(tabId, stream) {
  if (!tabId || tabId < 0 || !stream?.url) return;
  if (!stream.url.startsWith('http://') && !stream.url.startsWith('https://')) return;

  const list = tabStreams.get(tabId) || [];
  const existingIdx = list.findIndex((item) => item.url === stream.url);
  if (existingIdx !== -1) {
    list.splice(existingIdx, 1);
  }
  list.unshift({
    url: stream.url,
    type: stream.type || 'video',
    size: stream.size || null,
    capturedAt: Date.now(),
  });
  if (list.length > MAX_STREAMS_PER_TAB) {
    list.length = MAX_STREAMS_PER_TAB;
  }
  tabStreams.set(tabId, list);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabStreams.delete(tabId);
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.url.startsWith(BRIDGE_BASE)) return;

    const headers = details.responseHeaders || [];
    const ctHeader = headers.find((h) => h.name.toLowerCase() === 'content-type');
    const clHeader = headers.find((h) => h.name.toLowerCase() === 'content-length');
    const contentType = (ctHeader?.value || '').toLowerCase();
    const contentLength = clHeader?.value ? Number.parseInt(clHeader.value, 10) : null;

    const isMediaMime =
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType.includes('mpegurl') ||
      contentType.includes('dash+xml');

    const isMediaExt = MEDIA_EXT_RE.test(details.url);

    if (
      (isMediaMime || isMediaExt) &&
      (!contentLength ||
        contentLength > 65536 ||
        contentType.includes('mpegurl') ||
        details.url.includes('.m3u8'))
    ) {
      recordStream(details.tabId, {
        url: details.url,
        type: contentType.split(';')[0] || 'media',
        size: Number.isFinite(contentLength) ? contentLength : null,
      });
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders']
);

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'snipr-download-page',
      title: 'Download by Snipr (Page Video)',
      contexts: ['page', 'video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'snipr-download-link',
      title: 'Download by Snipr (Link)',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'snipr-download-media',
      title: 'Download by Snipr (Direct Media)',
      contexts: ['video', 'audio'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

async function pingSnipr() {
  const token = await getStoredToken();
  if (!token) {
    return { ok: false, needsToken: true };
  }
  try {
    const res = await fetch(`${BRIDGE_BASE}/api/ping`, {
      method: 'GET',
      headers: {
        'X-Snipr-Extension': '1.0.0',
        'X-Snipr-Token': token,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, needsToken: true, status: res.status };
    }
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false, offline: true };
  }
}

async function sendToSnipr({ url, title, quality = 'best', autoStart = true }) {
  const token = await getStoredToken();
  if (!token) {
    return {
      ok: false,
      needsToken: true,
      error: 'Pairing token missing. Open extension popup and paste token from Snipr Settings.',
    };
  }

  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Only HTTP/HTTPS URLs are supported.' };
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local')
    ) {
      return { ok: false, error: 'Local addresses cannot be downloaded.' };
    }
  } catch {
    return { ok: false, error: 'Invalid video URL.' };
  }

  try {
    const res = await fetch(`${BRIDGE_BASE}/api/grab`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Snipr-Extension': '1.0.0',
        'X-Snipr-Token': token,
      },
      body: JSON.stringify({ url, title, quality, autoStart }),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        needsToken: true,
        error: 'Invalid pairing token. Update it in the extension popup.',
      };
    }
    return await res.json();
  } catch {
    return {
      ok: false,
      offline: true,
      error: 'Snipr Desktop app is not running. Please open Snipr first.',
    };
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let targetUrl = tab?.url || '';
  if (info.menuItemId === 'snipr-download-link' && info.linkUrl) {
    targetUrl = info.linkUrl;
  } else if (
    info.menuItemId === 'snipr-download-media' &&
    info.srcUrl &&
    !info.srcUrl.startsWith('blob:')
  ) {
    targetUrl = info.srcUrl;
  }

  if (targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
    void sendToSnipr({
      url: targetUrl,
      title: tab?.title || 'Browser Video',
      quality: 'best',
      autoStart: true,
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || !msg.type) return;

  if (msg.type === 'SNIPR_PING') {
    pingSnipr().then(sendResponse);
    return true;
  }

  if (msg.type === 'SNIPR_SEND') {
    sendToSnipr(msg.payload || {}).then(sendResponse);
    return true;
  }

  if (msg.type === 'SNIPR_GET_TAB_STREAMS') {
    const list = tabStreams.get(msg.tabId) || [];
    sendResponse({ streams: list });
    return false;
  }

  if (msg.type === 'SNIPR_PAUSE' || msg.type === 'SNIPR_RESUME') {
    const endpoint = msg.type === 'SNIPR_PAUSE' ? 'pause' : 'resume';
    getStoredToken()
      .then((token) =>
        fetch(`${BRIDGE_BASE}/api/${endpoint}`, {
          method: 'POST',
          headers: {
            'X-Snipr-Extension': '1.0.0',
            'X-Snipr-Token': token,
          },
        })
      )
      .then((r) => r.json())
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'SNIPR_CONTENT_FOUND_VIDEO' && sender?.tab?.id) {
    if (msg.src && !msg.src.startsWith('blob:')) {
      recordStream(sender.tab.id, { url: msg.src, type: 'video/element' });
    }
    sendResponse({ ok: true });
    return false;
  }
});
