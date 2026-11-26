import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Link2,
  Puzzle,
} from 'lucide-react';
import Sidebar from './components/Sidebar';
import LinkInput from './components/LinkInput';
import VideoCard, { VideoCardSkeleton } from './components/VideoCard';
import QualitySelect from './components/QualitySelect';
import ProgressBar from './components/ProgressBar';
import History from './components/History';
import Settings from './components/Settings';
import PlayerModal from './components/PlayerModal';
import ExtensionModal from './components/ExtensionModal';
import sniprLogo from '../assets/logo.svg';
import './App.css';

function createApiClient() {
  if (window.grabit) {
    return window.grabit;
  }

  async function postJson(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  let eventSource = null;
  function getEvents() {
    if (!eventSource) {
      eventSource = new EventSource('/api/events');
    }
    return eventSource;
  }

  return {
    async getInitialState() {
      const res = await fetch('/api/state');
      return res.json();
    },
    async runSetup() {
      return { ready: true };
    },
    async readClipboard() {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    },
    async copyText(text) {
      try {
        await navigator.clipboard.writeText(String(text || ''));
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    fetchMetadata: (url) => postJson('/api/fetch', { url }),
    startDownload: (payload) => postJson('/api/download', payload),
    pauseDownload: (id) => postJson('/api/pause', { id }),
    resumeDownload: (id) => postJson('/api/resume', { id }),
    cancelDownload: (id) => postJson('/api/cancel', { id }),
    dismissDownload: (id) => postJson('/api/dismiss', { id }),
    clearFinishedDownloads: () => postJson('/api/clear-finished'),
    removeFromQueue: (id) => postJson('/api/queue/remove', { id }),
    clearQueue: () => postJson('/api/queue/clear'),
    probeFile: (filePath) => postJson('/api/probe', { filePath }),
    createStreamUrl: (filePath) => postJson('/api/stream-url', { filePath }),
    regenerateBridgeToken: () => postJson('/api/bridge-auth/regenerate'),
    setExtensionId: (extensionId) =>
      postJson('/api/bridge-auth/extension-id', { extensionId }),
    convertToH264: (payload) => postJson('/api/convert-h264', payload),
    openFile: (filePath) => postJson('/api/open-file', { filePath }),
    openFolder: (targetPath) => postJson('/api/open-folder', { targetPath }),
    openExtensionFolder: () => postJson('/api/open-extension-folder'),
    updateSettings: (patch) => postJson('/api/settings', patch),
    pickFolder: async () => null,
    deleteHistory: (id) => postJson('/api/history/delete', { id }),
    clearHistory: () => postJson('/api/history/clear'),
    onDownloadProgress(cb) {
      const es = getEvents();
      const handler = (e) => cb(JSON.parse(e.data));
      es.addEventListener('downloadState', handler);
      return () => es.removeEventListener('downloadState', handler);
    },
    onDownloadsUpdated(cb) {
      const es = getEvents();
      const handler = (e) => cb(JSON.parse(e.data));
      es.addEventListener('downloadsUpdated', handler);
      return () => es.removeEventListener('downloadsUpdated', handler);
    },
    onQueueUpdated(cb) {
      const es = getEvents();
      const handler = (e) => cb(JSON.parse(e.data));
      es.addEventListener('queueUpdated', handler);
      return () => es.removeEventListener('queueUpdated', handler);
    },
    onHistoryUpdated(cb) {
      const es = getEvents();
      const handler = (e) => cb(JSON.parse(e.data));
      es.addEventListener('historyUpdated', handler);
      return () => es.removeEventListener('historyUpdated', handler);
    },
    onSetupProgress() {
      return () => {};
    },
    onExtensionEvent(cb) {
      const es = getEvents();
      const handler = (e) => cb(JSON.parse(e.data));
      es.addEventListener('extensionEvent', handler);
      return () => es.removeEventListener('extensionEvent', handler);
    },
  };
}

const api = createApiClient();

function extractHttpUrl(raw) {
  const match = String(raw || '').match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : '';
}

export default function App() {
  const [setupState, setSetupState] = useState({
    state: 'loading',
    percent: 0,
    message: 'Checking downloader tools...',
  });
  const [activeTab, setActiveTab] = useState('home');
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [quality, setQuality] = useState('best');
  const [downloads, setDownloads] = useState([]);
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState({
    downloadDir: '',
    maxConnections: 8,
    compatibleMp4: true,
    theme: 'system',
  });
  const [extensionInfo, setExtensionInfo] = useState(null);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [playerItem, setPlayerItem] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);

  function showToast(message, tone = 'success') {
    const next = { id: Date.now(), message, tone };
    setToast(next);
    setTimeout(() => {
      setToast((curr) => (curr?.id === next.id ? null : curr));
    }, 2600);
  }

  // Sync theme attribute on <html>
  useEffect(() => {
    const theme = settings.theme || 'system';
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [settings.theme]);

  // Initial load + IPC/SSE subscriptions
  useEffect(() => {
    let active = true;

    const unsubDownload = api.onDownloadProgress((next) => {
      if (!active || api.onDownloadsUpdated) return;
      setDownloads(next ? [next] : []);
    });
    const unsubDownloads = api.onDownloadsUpdated
      ? api.onDownloadsUpdated((list) => {
          if (active) setDownloads(Array.isArray(list) ? list : []);
        })
      : () => {};
    const unsubQueue = api.onQueueUpdated
      ? api.onQueueUpdated((q) => {
          if (active) setQueue(q || []);
        })
      : () => {};
    const unsubHistory = api.onHistoryUpdated((list) => {
      if (active) setHistory(list || []);
    });
    const unsubSetup = api.onSetupProgress((prog) => {
      if (active) setSetupState(prog);
    });
    const unsubExtension = api.onExtensionEvent
      ? api.onExtensionEvent((ev) => {
          if (!active) return;
          if (ev.bridge) {
            setExtensionInfo((prev) => ({ ...(prev || {}), ...ev.bridge }));
          }
          if (ev.type === 'grabbed') {
            if (ev.autoStart === false) {
              if (ev.url) setUrl(ev.url);
              if (ev.metadata) setMetadata(ev.metadata);
              setActiveTab('home');
            }
            showToast(`Added from Browser Extension: ${ev.title || 'Video'}`);
          }
        })
      : () => {};

    api
      .getInitialState()
      .then((init) => {
        if (!active) return;
        setSettings((prev) => ({ ...prev, ...(init.settings || {}) }));
        setHistory(init.history || []);
        const initDownloads = Array.isArray(init.downloads)
          ? init.downloads
          : init.activeDownload
            ? [init.activeDownload]
            : [];
        setDownloads(initDownloads);
        setQueue(init.queue || []);
        if (init.extension) setExtensionInfo(init.extension);
        if (init.ready) {
          setSetupState({ state: 'ready', percent: 100, message: 'Ready' });
        } else if (init.setupState && init.setupState.state !== 'loading') {
          setSetupState(init.setupState);
        } else {
          setSetupState({
            state: 'running',
            percent: 0,
            message: 'Setting up yt-dlp, aria2c, and FFmpeg...',
          });
        }
      })
      .catch(() => {
        if (!active) return;
        setSetupState({
          state: 'error',
          percent: 0,
          message: 'Unable to initialize Snipr Download Manager.',
        });
      });

    return () => {
      active = false;
      unsubDownload();
      unsubDownloads();
      unsubQueue();
      unsubHistory();
      unsubSetup();
      unsubExtension();
    };
  }, []);

  // Global Ctrl+V shortcut pastes link when not focused inside an input/textarea
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        e.preventDefault();
        void handlePaste();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Global Drag-and-Drop URL highlight & capture
  useEffect(() => {
    let dragDepth = 0;

    function onDragEnter(e) {
      e.preventDefault();
      dragDepth += 1;
      setDragOver(true);
    }

    function onDragOver(e) {
      e.preventDefault();
    }

    function onDragLeave(e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragOver(false);
    }

    function onDrop(e) {
      e.preventDefault();
      dragDepth = 0;
      setDragOver(false);
      const text =
        e.dataTransfer?.getData('text/uri-list') ||
        e.dataTransfer?.getData('text/plain') ||
        '';
      const extracted = extractHttpUrl(text);
      if (extracted) {
        setActiveTab('home');
        void handleFetch(extracted);
      } else if (text.trim()) {
        showToast('Please drop a valid video URL.', 'error');
      }
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  });

  const runningDownloadsCount = downloads.filter(
    (d) =>
      d.status === 'downloading' ||
      d.status === 'merging' ||
      d.status === 'converting'
  ).length;

  const liveDownloadsCount = downloads.filter(
    (d) =>
      d.status === 'downloading' ||
      d.status === 'merging' ||
      d.status === 'converting' ||
      d.status === 'paused'
  ).length;

  const slotsFull = runningDownloadsCount >= 4;
  const activeDownloadsCount = liveDownloadsCount + (queue ? queue.length : 0);

  async function handlePaste() {
    const text = await api.readClipboard();
    if (text && text.trim()) {
      setUrl(text.trim());
      setError('');
      setActiveTab('home');
    } else {
      showToast('Clipboard is empty.', 'error');
    }
  }

  async function handleFetch(overrideUrl) {
    setError('');
    const target = typeof overrideUrl === 'string' ? overrideUrl : url;
    const trimmed = target.trim();
    if (typeof overrideUrl === 'string') {
      setUrl(trimmed);
      setActiveTab('home');
    }

    if (!trimmed) {
      setError('Please paste a video link first.');
      return;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('Invalid link. Only http:// and https:// URLs are supported.');
        return;
      }
    } catch {
      setError('Invalid link. Include http:// or https:// and try again.');
      return;
    }

    setFetching(true);
    setMetadata(null);
    try {
      const res = await api.fetchMetadata(trimmed);
      if (!res.ok) {
        setError(res.error || 'Unable to fetch video details.');
      } else {
        setMetadata(res.data);
      }
    } catch {
      setError('Unable to fetch video details. Check your internet connection.');
    } finally {
      setFetching(false);
    }
  }

  const QUALITY_LABELS = {
    best: 'Best',
    '1080p': '1080p',
    '720p': '720p',
    '480p': '480p',
    mp3: 'Audio only (MP3)',
  };

  function hasCompletedDuplicate(targetUrl, selectedQuality) {
    const norm = String(targetUrl || '').trim();
    const expectedLabel = QUALITY_LABELS[selectedQuality] || selectedQuality;
    return history.some(
      (entry) =>
        entry.status === 'Completed' &&
        String(entry.url || '').trim() === norm &&
        (entry.quality === expectedLabel || entry.quality === selectedQuality)
    );
  }

  async function executeStartDownload() {
    if (!metadata) return;
    setError('');
    const res = await api.startDownload({
      url: metadata.url,
      title: metadata.title,
      platform: metadata.platform,
      thumbnail: metadata.thumbnail,
      quality,
      allowQueue: true,
    });
    if (!res.ok) {
      const msg = res.error || 'Could not start download.';
      setError(msg);
      showToast(msg, 'error');
    } else {
      // Clear input & preview immediately so user can paste & start another link right away
      setUrl('');
      setMetadata(null);
      if (res.data?.queued) {
        showToast('Added to download queue');
      } else {
        showToast('Download started — paste another link anytime');
      }
    }
  }

  async function handleStartDownload() {
    if (!metadata) return;
    if (hasCompletedDuplicate(metadata.url, quality)) {
      setDuplicatePrompt({
        title: metadata.title,
        quality: QUALITY_LABELS[quality] || quality,
      });
      return;
    }
    await executeStartDownload();
  }

  async function handleRegenerateToken() {
    const res = await api.regenerateBridgeToken();
    if (res?.ok && res.data) {
      setExtensionInfo((prev) => ({ ...(prev || {}), ...res.data }));
      showToast('New pairing token generated');
    } else {
      showToast('Could not regenerate token.', 'error');
    }
  }

  async function handleSaveExtensionId(extId) {
    const res = await api.setExtensionId(extId);
    if (res?.ok && res.data) {
      setExtensionInfo((prev) => ({ ...(prev || {}), ...res.data }));
      showToast('Allowed Extension ID updated');
    } else {
      showToast(res?.error || 'Invalid Extension ID.', 'error');
    }
  }

  async function handleOpenFile(filePath) {
    const res = await api.openFile(filePath);
    if (!res.ok) {
      showToast(res.error || 'Unable to open file.', 'error');
    }
  }

  async function handleOpenFolder(targetPath) {
    const res = await api.openFolder(targetPath);
    if (!res.ok) {
      showToast(res.error || 'Unable to open folder.', 'error');
    }
  }

  async function handleConvertH264(item) {
    if (!item?.filePath) return;
    showToast('Converting video to H.264 MP4...');
    setActiveTab('downloads');
    const res = await api.convertToH264({
      historyId: item.id,
      filePath: item.filePath,
    });
    if (!res.ok) {
      showToast(res.error || 'Conversion failed.', 'error');
    } else {
      showToast('Converted to Windows-safe H.264 MP4!');
    }
  }

  async function handleCopy(text, label) {
    await api.copyText(text);
    showToast(label || 'Copied to clipboard');
  }

  async function handleSaveSettings(patch) {
    const res = await api.updateSettings(patch);
    if (res.ok) {
      setSettings(res.data);
      showToast('Settings saved');
    } else {
      showToast(res.error || 'Could not save settings.', 'error');
    }
  }

  async function handleOpenExtensionFolder() {
    const res = await api.openExtensionFolder();
    if (!res.ok) {
      showToast(res.error || 'Unable to open extension folder.', 'error');
    }
  }

  if (setupState.state !== 'ready') {
    return (
      <div className="setup-screen">
        <div className="surface-card setup-card">
          <div className="setup-brand">
            <div className="brand-mark">
              <img src={sniprLogo} alt="" className="brand-logo-img" />
            </div>
            <h1 className="page-title">Setting up Snipr...</h1>
          </div>
          <p className="setup-message">
            {setupState.message || 'Downloading required engine tools...'}
          </p>
          <div className="setup-track">
            <div
              className="setup-fill"
              style={{ width: `${Math.min(100, Math.max(6, setupState.percent || 0))}%` }}
            />
          </div>
          {setupState.state === 'error' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setSetupState({
                  state: 'running',
                  percent: 0,
                  message: 'Retrying setup...',
                });
                void api.runSetup().catch(() => {
                  setSetupState({
                    state: 'error',
                    percent: 0,
                    message: 'Setup failed. Check your internet connection and click Retry Setup.',
                  });
                });
              }}
            >
              Retry Setup
            </button>
          )}
        </div>
      </div>
    );
  }

  const extOnline = extensionInfo?.listening !== false;

  return (
    <div className="app-layout">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        activeCount={activeDownloadsCount}
        historyCount={history.length}
        extensionOnline={extOnline}
        onOpenExtension={() => setExtensionOpen(true)}
      />

      <main className="main-viewport">
        <div className="main-container">
          {/* Mobile Top Bar (<900px) */}
          <header className="mobile-topbar">
            <div className="mobile-brand">
              <div className="brand-mark">
                <img src={sniprLogo} alt="" className="brand-logo-img" />
              </div>
              <div>
                <div className="brand-title">Snipr</div>
                <div className="brand-subtitle">Download Manager (SDM)</div>
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setExtensionOpen(true)}
              aria-label="Open browser extension setup"
              title="Browser Extension"
            >
              <Puzzle size={18} />
            </button>
          </header>

          {activeTab === 'home' && (
            <div className="home-stack">
              <div className="page-header">
                <div>
                  <h1 className="page-title">Download Video</h1>
                  <p className="page-subtitle">
                    Paste or drop any video link to grab it at full speed.
                  </p>
                </div>
              </div>

              <LinkInput
                url={url}
                onChangeUrl={(val) => {
                  setUrl(val);
                  if (error) setError('');
                }}
                onPaste={() => void handlePaste()}
                onFetch={() => void handleFetch()}
                onClear={() => {
                  setUrl('');
                  setMetadata(null);
                  setError('');
                }}
                fetching={fetching}
                activeCount={liveDownloadsCount}
                slotsFull={slotsFull}
              />

              {error && (
                <div className="error-banner" role="alert">
                  <AlertCircle size={18} />
                  <span>{error}</span>
                </div>
              )}

              {fetching && <VideoCardSkeleton />}

              {!fetching && metadata && (
                <section className="surface-card preview-card" aria-label="Video details">
                  <VideoCard metadata={metadata} />
                  <QualitySelect
                    value={quality}
                    onChange={setQuality}
                    disabled={fetching}
                    compatibleMp4={settings.compatibleMp4 !== false}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-download-main"
                    onClick={() => void handleStartDownload()}
                  >
                    <Download size={18} />
                    <span>{slotsFull ? 'Add to Queue' : 'Download'}</span>
                  </button>
                </section>
              )}

              {(downloads.length > 0 || queue.length > 0) && (
                <ProgressBar
                  downloads={downloads}
                  queue={queue}
                  onPause={(id) => api.pauseDownload(id)}
                  onResume={(id) => api.resumeDownload(id)}
                  onCancel={(id) => api.cancelDownload(id)}
                  onDismiss={(id) => api.dismissDownload?.(id)}
                  onClearFinished={() => api.clearFinishedDownloads?.()}
                  onOpenFolder={handleOpenFolder}
                  onOpenFile={handleOpenFile}
                  onPlayInApp={(item) => setPlayerItem(item)}
                  onCopy={handleCopy}
                  onRemoveQueue={(id) => api.removeFromQueue(id)}
                  onClearQueue={() => api.clearQueue()}
                />
              )}
            </div>
          )}

          {activeTab === 'downloads' && (
            <div className="tab-stack">
              <div className="page-header">
                <div>
                  <h1 className="page-title">Downloads</h1>
                  <p className="page-subtitle">
                    Manage active parallel downloads, speed, and your queue.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setActiveTab('home')}
                >
                  <Link2 size={16} />
                  <span>Add Link</span>
                </button>
              </div>

              <ProgressBar
                downloads={downloads}
                queue={queue}
                onPause={(id) => api.pauseDownload(id)}
                onResume={(id) => api.resumeDownload(id)}
                onCancel={(id) => api.cancelDownload(id)}
                onDismiss={(id) => api.dismissDownload?.(id)}
                onClearFinished={() => api.clearFinishedDownloads?.()}
                onOpenFolder={handleOpenFolder}
                onOpenFile={handleOpenFile}
                onPlayInApp={(item) => setPlayerItem(item)}
                onCopy={handleCopy}
                onRemoveQueue={(id) => api.removeFromQueue(id)}
                onClearQueue={() => api.clearQueue()}
                onGoHome={() => setActiveTab('home')}
                showEmptyState
              />
            </div>
          )}

          {activeTab === 'history' && (
            <div className="tab-stack">
              <div className="page-header">
                <div>
                  <h1 className="page-title">History</h1>
                  <p className="page-subtitle">
                    Search, play, or re-fetch your recent downloads.
                  </p>
                </div>
              </div>

              <History
                items={history}
                onPlayInApp={(item) => setPlayerItem(item)}
                onOpenFile={handleOpenFile}
                onOpenFolder={handleOpenFolder}
                onConvertH264={handleConvertH264}
                onRefetch={(link) => void handleFetch(link)}
                onDelete={(id) => api.deleteHistory(id)}
                onClearAll={() => api.clearHistory()}
                onGoHome={() => setActiveTab('home')}
              />
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="tab-stack">
              <div className="page-header">
                <div>
                  <h1 className="page-title">Settings</h1>
                  <p className="page-subtitle">
                    Customize storage, speed, theme, and browser integration.
                  </p>
                </div>
              </div>

              <Settings
                settings={settings}
                onSave={handleSaveSettings}
                onPickFolder={() => api.pickFolder()}
                onOpenFolder={handleOpenFolder}
                extensionInfo={extensionInfo}
                onOpenExtensionModal={() => setExtensionOpen(true)}
                onCopy={handleCopy}
                onRegenerateToken={handleRegenerateToken}
                onSaveExtensionId={handleSaveExtensionId}
              />
            </div>
          )}
        </div>
      </main>

      {dragOver && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <Link2 size={28} />
            <span>Drop video link to fetch</span>
          </div>
        </div>
      )}

      {extensionOpen && (
        <ExtensionModal
          extensionInfo={extensionInfo}
          onClose={() => setExtensionOpen(false)}
          onOpenFolder={() => void handleOpenExtensionFolder()}
          onCopy={handleCopy}
        />
      )}

      {playerItem && (
        <PlayerModal
          item={playerItem}
          onClose={() => setPlayerItem(null)}
          onOpenExternal={handleOpenFile}
          onOpenFolder={handleOpenFolder}
          onConvertH264={handleConvertH264}
          probeFile={(fp) => api.probeFile(fp)}
          createStreamUrl={(fp) => api.createStreamUrl(fp)}
        />
      )}

      {duplicatePrompt && (
        <div className="modal-backdrop" onClick={() => setDuplicatePrompt(null)}>
          <div
            className="modal-panel confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Duplicate download confirmation"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal-title">Already downloaded. Download again?</h2>
            <p className="confirm-copy">
              <strong>{duplicatePrompt.title}</strong> ({duplicatePrompt.quality}) is already in your completed history.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDuplicatePrompt(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setDuplicatePrompt(null);
                  void executeStartDownload();
                }}
              >
                Download Again
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
          {toast.tone === 'error' ? (
            <AlertCircle size={16} />
          ) : (
            <CheckCircle2 size={16} />
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
