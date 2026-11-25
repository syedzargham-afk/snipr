import React, { useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  Pause,
  Play,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import './ProgressBar.css';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  const mb = bps / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bps / 1024;
  return `${kb.toFixed(0)} KB/s`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '—';
  }
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function ProgressBar({
  download,
  queue = [],
  onPause,
  onResume,
  onCancel,
  onOpenFolder,
  onOpenFile,
  onPlayInApp,
  onCopy,
  onRemoveQueue,
  onClearQueue,
  onGoHome,
  showEmptyState = false,
}) {
  const [shareOpen, setShareOpen] = useState(false);

  if (!download && queue.length === 0) {
    if (!showEmptyState) return null;
    return (
      <div className="surface-card empty-state">
        <div className="empty-state-icon">
          <Download size={26} />
        </div>
        <h2 className="empty-state-title">No active downloads</h2>
        <p className="empty-state-text">
          Paste any video link on Home or click &ldquo;Download by Snipr&rdquo; in the browser extension to start downloading.
        </p>
        {onGoHome && (
          <button type="button" className="btn btn-primary" onClick={onGoHome}>
            Go to Home
          </button>
        )}
      </div>
    );
  }

  const isCompleted = download?.status === 'completed';
  const isPaused = download?.status === 'paused';
  const isError = download?.status === 'error';
  const isMerging = download?.status === 'merging';
  const isConverting = download?.status === 'converting';

  const statusTone = isCompleted
    ? 'badge-success'
    : isError
      ? 'badge-danger'
      : isPaused || isMerging || isConverting
        ? 'badge-warning'
        : 'badge-accent';

  const statusText = isCompleted
    ? 'Completed'
    : isConverting
      ? `Optimizing MP4 · ${Math.round(download.percent || 0)}%`
      : isMerging
        ? 'Merging…'
        : isPaused
          ? 'Paused'
          : isError
            ? 'Failed'
            : `${(download?.percent || 0).toFixed(1)}%`;

  const fillWidth =
    isMerging && (!download?.percent || download.percent < 95)
      ? 98
      : Math.min(100, Math.max(0, download?.percent || 0));

  return (
    <div className="downloads-stack">
      {download && (
        <div className="surface-card download-item-card">
          <div className="download-card-head">
            <div className="download-thumb-box">
              {download.thumbnail ? (
                <img
                  src={download.thumbnail}
                  alt={download.title}
                  className="download-thumb-img"
                />
              ) : (
                <div className="download-thumb-img download-thumb-fallback">
                  <Film size={20} />
                </div>
              )}
            </div>

            <div className="download-card-meta">
              <div className="download-title-row">
                <h3 className="download-title" title={download.title}>
                  {download.title}
                </h3>
                <span className={`badge ${statusTone}`}>{statusText}</span>
              </div>

              <div className="download-sub-row">
                <span>{download.platform || 'Web'}</span>
                <span>•</span>
                <span>{String(download.quality || 'best').toUpperCase()}</span>
                {download.totalBytes > 0 && (
                  <>
                    <span>•</span>
                    <span>
                      {formatBytes(download.downloadedBytes)} /{' '}
                      {formatBytes(download.totalBytes)}
                    </span>
                  </>
                )}
                {download.status === 'downloading' && (
                  <>
                    <span>•</span>
                    <span className="download-speed">
                      {formatSpeed(download.speedBps)}
                    </span>
                    <span>•</span>
                    <span>ETA {formatEta(download.etaSeconds)}</span>
                  </>
                )}
                {isCompleted && download.vcodec && (
                  <>
                    <span>•</span>
                    <span className="badge">
                      {download.vcodec.toUpperCase()}
                      {download.acodec ? ` / ${download.acodec.toUpperCase()}` : ''}
                    </span>
                  </>
                )}
              </div>
            </div>

            {!isCompleted && (
              <div className="download-icon-controls">
                {download.status === 'downloading' && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={onPause}
                    aria-label="Pause download"
                    title="Pause"
                  >
                    <Pause size={17} />
                  </button>
                )}
                {(isPaused || isError) && (
                  <button
                    type="button"
                    className="icon-btn primary"
                    onClick={onResume}
                    aria-label="Resume download"
                    title="Resume"
                  >
                    <Play size={17} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={onCancel}
                  aria-label="Cancel download"
                  title="Cancel"
                >
                  <X size={17} />
                </button>
              </div>
            )}
          </div>

          <div className="progress-track" role="progressbar" aria-valuenow={Math.round(fillWidth)} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`progress-fill ${isCompleted ? 'done' : ''} ${
                download.status === 'downloading' ? 'active' : ''
              } ${isConverting || isMerging ? 'processing' : ''}`}
              style={{ width: `${fillWidth}%` }}
            />
          </div>

          {isError && download.error && (
            <div className="error-banner">{download.error}</div>
          )}

          {isCompleted && (
            <div className="download-done-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onPlayInApp(download)}
                disabled={!download.filePath}
              >
                <Play size={14} />
                <span>Play</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onOpenFile(download.filePath)}
                disabled={!download.filePath}
              >
                <ExternalLink size={14} />
                <span>Windows Player</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onOpenFolder(download.filePath || download.outputDir)}
              >
                <FolderOpen size={14} />
                <span>Folder</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onCopy(download.url, 'Link copied')}
              >
                <Copy size={14} />
                <span>Copy Link</span>
              </button>

              <div className="share-wrap">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShareOpen((prev) => !prev)}
                  aria-expanded={shareOpen}
                >
                  <Share2 size={14} />
                  <span>Share</span>
                </button>
                {shareOpen && (
                  <div
                    className="share-menu"
                    onMouseLeave={() => setShareOpen(false)}
                  >
                    <button
                      type="button"
                      className="share-menu-item"
                      onClick={() => {
                        setShareOpen(false);
                        onOpenFolder(download.filePath || download.outputDir);
                      }}
                    >
                      Reveal in Explorer
                    </button>
                    <button
                      type="button"
                      className="share-menu-item"
                      disabled={!download.filePath}
                      onClick={() => {
                        setShareOpen(false);
                        onCopy(download.filePath, 'File path copied');
                      }}
                    >
                      Copy file path
                    </button>
                    <button
                      type="button"
                      className="share-menu-item"
                      onClick={() => {
                        setShareOpen(false);
                        onCopy(
                          `${download.title} - ${download.url}`,
                          'Title + Link copied'
                        );
                      }}
                    >
                      Copy Title + Link
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {queue.length > 0 && (
        <div className="surface-card queue-card">
          <div className="queue-top">
            <h3 className="queue-heading">Up Next ({queue.length})</h3>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClearQueue}
            >
              Clear Queue
            </button>
          </div>
          <div className="queue-items">
            {queue.map((item, idx) => (
              <div key={item.id} className="queue-item-row">
                <span className="queue-num">#{idx + 1}</span>
                <span className="queue-item-title">{item.title}</span>
                <span className="badge">{String(item.quality || 'best').toUpperCase()}</span>
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => onRemoveQueue(item.id)}
                  aria-label={`Remove ${item.title} from queue`}
                  title="Remove from queue"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
