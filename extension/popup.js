const connPill = document.getElementById('conn-pill');
const connText = document.getElementById('conn-text');
const tokenToggleBtn = document.getElementById('token-toggle-btn');
const tokenCard = document.getElementById('token-card');
const tokenInput = document.getElementById('token-input');
const saveTokenBtn = document.getElementById('save-token-btn');
const tokenStatus = document.getElementById('token-status');
const offlineBox = document.getElementById('offline-box');
const offlineTitle = document.getElementById('offline-title');
const offlineDesc = document.getElementById('offline-desc');
const pageTitleEl = document.getElementById('page-title');
const pageUrlEl = document.getElementById('page-url');
const qualitySelect = document.getElementById('quality-select');
const downloadBtn = document.getElementById('download-btn');
const feedbackEl = document.getElementById('feedback');
const activeCard = document.getElementById('active-card');
const activeTitleEl = document.getElementById('active-title');
const activeFillEl = document.getElementById('active-fill');
const activeStatsEl = document.getElementById('active-stats');
const togglePauseBtn = document.getElementById('toggle-pause-btn');
const streamCountEl = document.getElementById('stream-count');
const streamsListEl = document.getElementById('streams-list');

let currentTab = null;
let appOnline = false;
let currentActiveDownload = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function showFeedback(text, isError = false) {
  feedbackEl.textContent = text;
  feedbackEl.classList.toggle('err', isError);
  feedbackEl.classList.remove('hidden');
  setTimeout(() => {
    feedbackEl.classList.add('hidden');
  }, 3200);
}

function renderActiveDownload(dl) {
  currentActiveDownload = dl;
  if (
    !dl ||
    (dl.status !== 'downloading' &&
      dl.status !== 'merging' &&
      dl.status !== 'converting' &&
      dl.status !== 'paused')
  ) {
    activeCard.classList.add('hidden');
    return;
  }

  activeCard.classList.remove('hidden');
  activeTitleEl.textContent = dl.title || 'Downloading...';
  activeFillEl.style.width = `${Math.min(100, Math.max(0, dl.percent || 0))}%`;

  if (dl.status === 'paused') {
    activeStatsEl.textContent = `Paused · ${(dl.percent || 0).toFixed(1)}%`;
    togglePauseBtn.textContent = 'Resume';
    togglePauseBtn.classList.remove('hidden');
  } else if (dl.status === 'converting') {
    activeStatsEl.textContent = `Optimizing MP4 (H.264)... ${(dl.percent || 0).toFixed(0)}%`;
    togglePauseBtn.classList.add('hidden');
  } else if (dl.status === 'merging') {
    activeStatsEl.textContent = 'Merging audio & video...';
    togglePauseBtn.classList.add('hidden');
  } else {
    const mbps = dl.speedBps
      ? `${(dl.speedBps / (1024 * 1024)).toFixed(1)} MB/s`
      : '—';
    activeStatsEl.textContent = `${(dl.percent || 0).toFixed(1)}% · ${mbps}`;
    togglePauseBtn.textContent = 'Pause';
    togglePauseBtn.classList.remove('hidden');
  }
}

async function refreshConnection() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SNIPR_PING' }, (resp) => {
      appOnline = Boolean(resp && resp.ok);
      const needsToken = Boolean(resp && resp.needsToken);

      connPill.classList.toggle('online', appOnline);
      connPill.classList.toggle('offline', !appOnline);
      connText.textContent = appOnline
        ? 'Connected'
        : needsToken
          ? 'Pair Token'
          : 'Offline';

      if (needsToken) {
        tokenCard.classList.remove('hidden');
        offlineBox.classList.remove('hidden');
        offlineTitle.textContent = 'Pairing token required.';
        offlineDesc.textContent =
          'Copy the Bridge Token from Snipr Settings and paste it above.';
      } else if (!appOnline) {
        offlineBox.classList.remove('hidden');
        offlineTitle.textContent = 'Snipr Desktop App is closed.';
        offlineDesc.textContent =
          'Open Snipr Download Manager on your PC to start downloading videos.';
      } else {
        offlineBox.classList.add('hidden');
      }

      downloadBtn.disabled = !appOnline || !currentTab?.url?.startsWith('http');
      renderActiveDownload(resp?.activeDownload || null);
      resolve(appOnline);
    });
  });
}

function sendGrab(url, title, quality) {
  downloadBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: 'SNIPR_SEND',
      payload: { url, title, quality, autoStart: true },
    },
    (resp) => {
      downloadBtn.disabled = !appOnline;
      if (!resp || !resp.ok) {
        showFeedback(resp?.error || 'Could not send to Snipr.', true);
      } else if (resp.status === 'queued') {
        showFeedback('Added to Snipr Queue!');
      } else {
        showFeedback('Download started in Snipr!');
      }
      void refreshConnection();
    }
  );
}

function renderStreams(streams) {
  streamCountEl.textContent = String(streams.length);
  if (!streams.length) {
    streamsListEl.innerHTML =
      '<div class="empty">Play a video on this tab to detect streams.</div>';
    return;
  }

  streamsListEl.innerHTML = '';
  for (const s of streams) {
    const row = document.createElement('div');
    row.className = 'stream-row';

    const info = document.createElement('div');
    info.className = 'stream-info';

    const urlDiv = document.createElement('div');
    urlDiv.className = 'stream-url';
    urlDiv.textContent = s.url;
    urlDiv.title = s.url;

    const metaDiv = document.createElement('div');
    metaDiv.className = 'stream-meta';
    metaDiv.textContent = [s.type, formatBytes(s.size)].filter(Boolean).join(' · ');

    info.appendChild(urlDiv);
    info.appendChild(metaDiv);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-mini';
    btn.textContent = 'Grab';
    btn.disabled = !appOnline;
    btn.addEventListener('click', () => {
      sendGrab(s.url, currentTab?.title || 'Stream Video', qualitySelect.value);
    });

    row.appendChild(info);
    row.appendChild(btn);
    streamsListEl.appendChild(row);
  }
}

async function init() {
  const stored = await chrome.storage.local.get(['sniprToken']);
  if (typeof stored.sniprToken === 'string' && stored.sniprToken.trim()) {
    tokenInput.value = stored.sniprToken.trim();
  } else {
    tokenCard.classList.remove('hidden');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;

  if (currentTab) {
    pageTitleEl.textContent = currentTab.title || 'Current Tab';
    pageUrlEl.textContent = currentTab.url || '';
  }

  await refreshConnection();

  if (currentTab?.id) {
    chrome.runtime.sendMessage(
      { type: 'SNIPR_GET_TAB_STREAMS', tabId: currentTab.id },
      (resp) => {
        renderStreams(resp?.streams || []);
      }
    );
  }

  setInterval(() => {
    void refreshConnection();
  }, 1800);
}

tokenToggleBtn.addEventListener('click', () => {
  tokenCard.classList.toggle('hidden');
});

saveTokenBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ sniprToken: token });
  tokenStatus.textContent = token
    ? 'Token saved to chrome.storage.local.'
    : 'Token cleared.';
  const ok = await refreshConnection();
  if (ok) {
    tokenCard.classList.add('hidden');
    showFeedback('Paired with Snipr!');
  }
});

downloadBtn.addEventListener('click', () => {
  if (!currentTab?.url) return;
  sendGrab(currentTab.url, currentTab.title, qualitySelect.value);
});

togglePauseBtn.addEventListener('click', () => {
  if (!currentActiveDownload) return;
  const type =
    currentActiveDownload.status === 'paused' ? 'SNIPR_RESUME' : 'SNIPR_PAUSE';
  chrome.runtime.sendMessage({ type }, () => {
    void refreshConnection();
  });
});

void init();
