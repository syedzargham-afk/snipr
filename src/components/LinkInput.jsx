import React from 'react';
import { ClipboardPaste, Link2, Loader2, Search, X } from 'lucide-react';
import './LinkInput.css';

const PLATFORMS = ['YouTube', 'Instagram', 'Facebook', 'TikTok', 'and more'];

export default function LinkInput({
  url,
  onChangeUrl,
  onPaste,
  onFetch,
  onClear,
  fetching,
  busy,
}) {
  function handleSubmit(e) {
    e.preventDefault();
    onFetch();
  }

  return (
    <section className="surface-card hero-input-card" aria-label="Video link input">
      <form className="link-form" onSubmit={handleSubmit}>
        <div className="input-shell">
          <Link2 className="input-leading-icon" size={18} aria-hidden="true" />
          <input
            type="url"
            className="link-input"
            placeholder="Paste video URL here (YouTube, Instagram, TikTok, Facebook...)"
            value={url}
            onChange={(e) => onChangeUrl(e.target.value)}
            disabled={fetching}
            aria-label="Video URL"
          />
          {url && !fetching && (
            <button
              type="button"
              className="clear-input-btn"
              onClick={onClear}
              aria-label="Clear URL"
              title="Clear URL"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="link-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onPaste}
            disabled={fetching}
            title="Paste link from clipboard (Ctrl+V)"
          >
            <ClipboardPaste size={16} />
            <span>Paste</span>
          </button>

          <button
            type="submit"
            className="btn btn-primary btn-fetch"
            disabled={fetching || !url.trim()}
          >
            {fetching ? (
              <>
                <Loader2 size={16} className="spin" />
                <span>Fetching...</span>
              </>
            ) : (
              <>
                <Search size={16} />
                <span>Fetch</span>
              </>
            )}
          </button>
        </div>
      </form>

      <div className="platform-chips">
        {PLATFORMS.map((platform, idx) => (
          <span
            key={platform}
            className={`platform-chip ${idx === PLATFORMS.length - 1 ? 'muted' : ''}`}
          >
            {platform}
          </span>
        ))}
        {busy && !fetching && (
          <span className="queue-note">Download active — new links will queue</span>
        )}
      </div>
    </section>
  );
}
