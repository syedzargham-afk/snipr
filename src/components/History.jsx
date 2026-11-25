import React, { useMemo, useState } from 'react';
import {
  Clock,
  ExternalLink,
  Film,
  FolderOpen,
  Play,
  RotateCw,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react';
import './History.css';

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export default function History({
  items,
  onPlayInApp,
  onOpenFile,
  onOpenFolder,
  onConvertH264,
  onRefetch,
  onDelete,
  onClearAll,
  onGoHome,
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'completed' && item.status !== 'Completed') return false;
      if (filter === 'other' && item.status === 'Completed') return false;
      if (!q) return true;
      return (
        String(item.title || '').toLowerCase().includes(q) ||
        String(item.platform || '').toLowerCase().includes(q)
      );
    });
  }, [items, query, filter]);

  return (
    <div className="surface-card history-card">
      <div className="history-toolbar">
        <div className="history-search-box">
          <Search size={16} className="history-search-icon" aria-hidden="true" />
          <input
            type="search"
            className="history-search-input"
            placeholder="Search downloads by title or platform..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search history"
          />
        </div>

        <div className="history-toolbar-right">
          <div className="filter-group" role="tablist" aria-label="Filter history">
            {[
              { id: 'all', label: 'All' },
              { id: 'completed', label: 'Completed' },
              { id: 'other', label: 'Other' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={filter === tab.id}
                className={`filter-pill ${filter === tab.id ? 'active' : ''}`}
                onClick={() => setFilter(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Clock size={26} />
          </div>
          <h3 className="empty-state-title">No download history yet</h3>
          <p className="empty-state-text">
            Your last 50 downloaded videos and audio files will appear here for quick playback.
          </p>
          {onGoHome && (
            <button type="button" className="btn btn-primary" onClick={onGoHome}>
              Download a Video
            </button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Search size={24} />
          </div>
          <h3 className="empty-state-title">No matches found</h3>
          <p className="empty-state-text">
            Try clearing your search or switching the status filter.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="history-list">
          {filtered.map((item) => {
            const canOpen = item.status === 'Completed' && Boolean(item.filePath);
            const sizeStr = formatSize(item.fileSize);
            const needsCodecFix =
              canOpen &&
              item.filePath?.toLowerCase().endsWith('.mp4') &&
              (item.windowsCompatible === false || !item.vcodec);

            const statusBadgeClass =
              item.status === 'Completed'
                ? 'badge-success'
                : item.status === 'Cancelled'
                  ? 'badge-warning'
                  : 'badge-danger';

            return (
              <div
                key={item.id}
                className={`history-row ${canOpen ? 'clickable' : ''}`}
              >
                <div
                  className="history-thumb-box"
                  onClick={() => canOpen && onPlayInApp(item)}
                >
                  {item.thumbnail ? (
                    <img src={item.thumbnail} alt="" className="history-thumb-img" />
                  ) : (
                    <div className="history-thumb-img history-thumb-fallback">
                      <Film size={18} />
                    </div>
                  )}
                </div>

                <div
                  className="history-main"
                  onClick={() => canOpen && onPlayInApp(item)}
                >
                  <div className="history-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="history-meta">
                    <span>{item.platform}</span>
                    <span>•</span>
                    <span>{item.quality}</span>
                    {sizeStr && (
                      <>
                        <span>•</span>
                        <span>{sizeStr}</span>
                      </>
                    )}
                    {item.vcodec && (
                      <>
                        <span>•</span>
                        <span className="badge">{item.vcodec.toUpperCase()}</span>
                      </>
                    )}
                    <span>•</span>
                    <span>{formatDate(item.date)}</span>
                    <span className={`badge ${statusBadgeClass}`}>{item.status}</span>
                  </div>
                </div>

                <div className="history-actions">
                  {canOpen && (
                    <>
                      <button
                        type="button"
                        className="icon-btn primary history-action-btn"
                        onClick={() => onPlayInApp(item)}
                        aria-label={`Play ${item.title} inside Snipr`}
                        title="Play in Snipr"
                      >
                        <Play size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn history-action-btn"
                        onClick={() => onOpenFile(item.filePath)}
                        aria-label={`Open ${item.title} in Windows player`}
                        title="Open in Windows Player"
                      >
                        <ExternalLink size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn history-action-btn"
                        onClick={() => onOpenFolder(item.filePath)}
                        aria-label={`Reveal ${item.title} in folder`}
                        title="Reveal in Folder"
                      >
                        <FolderOpen size={16} />
                      </button>
                    </>
                  )}
                  {needsCodecFix && (
                    <button
                      type="button"
                      className="icon-btn warning history-action-btn"
                      onClick={() => onConvertH264(item)}
                      aria-label={`Convert ${item.title} to Windows H.264 MP4`}
                      title="Convert to H.264 for Windows Player"
                    >
                      <Wrench size={16} />
                    </button>
                  )}
                  {item.url && (
                    <button
                      type="button"
                      className="icon-btn history-action-btn"
                      onClick={() => onRefetch(item.url)}
                      aria-label={`Fetch ${item.title} link again`}
                      title="Fetch link again"
                    >
                      <RotateCw size={16} />
                    </button>
                  )}
                    <button
                      type="button"
                      className="icon-btn danger history-action-btn"
                      onClick={() => onDelete(item.id)}
                      aria-label={`Delete ${item.title} from history`}
                      title="Delete entry"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
      )}

      {items.length > 0 && (
        <div className="history-footer">
          <span className="history-count-label">
            Showing {filtered.length} of {items.length} downloads
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={14} />
            <span>Clear All History</span>
          </button>
        </div>
      )}

      {confirmClear && (
        <div className="modal-backdrop" onClick={() => setConfirmClear(false)}>
          <div
            className="modal-panel confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm clear all history"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal-title">Clear all download history?</h2>
            <p className="confirm-copy">
              This removes all {items.length} entries from Snipr history. Your downloaded files on disk will not be deleted.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setConfirmClear(false);
                  onClearAll();
                }}
              >
                Clear History
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
