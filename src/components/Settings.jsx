import React, { useEffect, useState } from 'react';
import {
  Copy,
  ExternalLink,
  FolderOpen,
  Gauge,
  Info,
  KeyRound,
  Monitor,
  Moon,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import './Settings.css';

export default function Settings({
  settings,
  onSave,
  onPickFolder,
  onOpenFolder,
  extensionInfo,
  onOpenExtensionModal,
  onCopy,
  onRegenerateToken,
  onSaveExtensionId,
}) {
  const [downloadDir, setDownloadDir] = useState(settings.downloadDir || '');
  const [maxConnections, setMaxConnections] = useState(
    Number(settings.maxConnections ?? 8)
  );
  const [compatibleMp4, setCompatibleMp4] = useState(
    settings.compatibleMp4 !== false
  );
  const [theme, setTheme] = useState(settings.theme || 'system');
  const [extIdInput, setExtIdInput] = useState(extensionInfo?.extensionId || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDownloadDir(settings.downloadDir || '');
    setMaxConnections(Number(settings.maxConnections ?? 8));
    setCompatibleMp4(settings.compatibleMp4 !== false);
    setTheme(settings.theme || 'system');
  }, [settings]);

  useEffect(() => {
    if (extensionInfo?.extensionId) {
      setExtIdInput(extensionInfo.extensionId);
    }
  }, [extensionInfo?.extensionId]);

  async function handleBrowse() {
    const picked = await onPickFolder();
    if (picked) {
      setDownloadDir(picked);
      await onSave({ downloadDir: picked });
    }
  }

  async function handleThemeChange(nextTheme) {
    setTheme(nextTheme);
    await onSave({ theme: nextTheme });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        downloadDir: downloadDir.trim() || settings.downloadDir,
        maxConnections,
        compatibleMp4,
        theme,
      });
    } finally {
      setSaving(false);
    }
  }

  const extListening = extensionInfo?.listening !== false;

  return (
    <form className="settings-stack" onSubmit={handleSubmit}>
      {/* Download Folder Card */}
      <section className="surface-card settings-group">
        <div className="settings-group-head">
          <div className="settings-group-icon">
            <FolderOpen size={18} />
          </div>
          <div>
            <h2 className="settings-group-title">Download Folder</h2>
            <p className="settings-group-desc">
              Where Snipr saves downloaded videos and audio files.
            </p>
          </div>
        </div>

        <div className="folder-row">
          <input
            id="download-dir"
            type="text"
            className="settings-input"
            value={downloadDir}
            onChange={(e) => setDownloadDir(e.target.value)}
            aria-label="Download folder path"
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleBrowse}
          >
            Browse
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpenFolder(downloadDir)}
          >
            Open
          </button>
        </div>
      </section>

      {/* Speed & Compatibility Card */}
      <section className="surface-card settings-group">
        <div className="settings-group-head">
          <div className="settings-group-icon">
            <Gauge size={18} />
          </div>
          <div>
            <h2 className="settings-group-title">Speed &amp; Connections</h2>
            <p className="settings-group-desc">
              Configure segmented download threads and universal Windows playback.
            </p>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row-head">
            <label htmlFor="max-connections" className="setting-label">
              Max Parallel Connections
            </label>
            <span className="badge badge-accent">{maxConnections}× threads</span>
          </div>
          <input
            id="max-connections"
            type="range"
            min={1}
            max={16}
            value={maxConnections}
            onChange={(e) => setMaxConnections(Number(e.target.value))}
            className="settings-range"
          />
          <div className="range-scale">
            <span>1 (Gentle)</span>
            <span>8 (Recommended)</span>
            <span>16 (Maximum)</span>
          </div>
        </div>

        <label className="setting-toggle">
          <div className="setting-toggle-copy">
            <span className="setting-toggle-title">
              <ShieldCheck size={15} />
              <span>Windows-Compatible MP4 (H.264 + AAC)</span>
            </span>
            <span className="setting-toggle-sub">
              Prefers H.264 + AAC and converts AV1/VP9 automatically so Windows Media Player opens videos with zero codec errors.
            </span>
          </div>
          <input
            type="checkbox"
            checked={compatibleMp4}
            onChange={(e) => setCompatibleMp4(e.target.checked)}
          />
        </label>

        <div className="settings-save-row">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Download Settings'}
          </button>
        </div>
      </section>

      {/* Appearance Card */}
      <section className="surface-card settings-group">
        <div className="settings-group-head">
          <div className="settings-group-icon">
            <Sun size={18} />
          </div>
          <div>
            <h2 className="settings-group-title">Appearance</h2>
            <p className="settings-group-desc">
              Follows your system preference by default, or pick a theme manually.
            </p>
          </div>
        </div>

        <div className="theme-segmented" role="radiogroup" aria-label="Theme selection">
          {[
            { id: 'system', label: 'System', icon: Monitor },
            { id: 'light', label: 'Light', icon: Sun },
            { id: 'dark', label: 'Dark', icon: Moon },
          ].map((opt) => {
            const Icon = opt.icon;
            const active = theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`theme-segment ${active ? 'active' : ''}`}
                onClick={() => void handleThemeChange(opt.id)}
              >
                <Icon size={16} />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Browser Extension Card */}
      <section className="surface-card settings-group">
        <div className="settings-group-head">
          <div className="settings-group-icon">
            <Puzzle size={18} />
          </div>
          <div className="settings-head-flex">
            <div>
              <h2 className="settings-group-title">Browser Extension &amp; Pairing Token</h2>
              <p className="settings-group-desc">
                Authenticated local bridge on 127.0.0.1:{extensionInfo?.port || 48921}. Paste this token into the Snipr browser extension popup.
              </p>
            </div>
            <span className={`badge ${extListening ? 'badge-success' : 'badge-danger'}`}>
              {extListening ? `Bridge Active (${extensionInfo?.port || 48921})` : 'Bridge Offline'}
            </span>
          </div>
        </div>

        <div className="setting-row">
          <label htmlFor="bridge-token" className="setting-label">
            <KeyRound size={14} className="inline-icon" /> Bridge Pairing Token
          </label>
          <div className="folder-row">
            <input
              id="bridge-token"
              type="text"
              readOnly
              className="settings-input mono-input"
              value={extensionInfo?.token || ''}
              aria-label="Bridge pairing token"
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!extensionInfo?.token}
              onClick={() => onCopy(extensionInfo?.token, 'Pairing token copied')}
            >
              <Copy size={15} />
              <span>Copy token</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void onRegenerateToken()}
            >
              <RefreshCw size={15} />
              <span>Regenerate token</span>
            </button>
          </div>
        </div>

        <div className="setting-row">
          <label htmlFor="allowed-ext-id" className="setting-label">
            Allowed Extension Origin ID (chrome-extension://&lt;id&gt;)
          </label>
          <div className="folder-row">
            <input
              id="allowed-ext-id"
              type="text"
              className="settings-input mono-input"
              value={extIdInput}
              onChange={(e) => setExtIdInput(e.target.value)}
              placeholder="32-character extension ID"
              aria-label="Allowed extension ID"
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void onSaveExtensionId(extIdInput)}
            >
              Update ID
            </button>
          </div>
        </div>

        <div className="settings-save-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onOpenExtensionModal}
          >
            <Puzzle size={15} />
            <span>Extension Setup &amp; Folder</span>
          </button>
        </div>
      </section>

      {/* About & Disclaimer Card */}
      <section className="surface-card settings-group">
        <div className="settings-group-head">
          <div className="settings-group-icon">
            <Info size={18} />
          </div>
          <div>
            <h2 className="settings-group-title">About Snipr Download Manager (SDM)</h2>
            <p className="settings-group-desc">
              Precision. Speed. Control. · Version 1.0.0 · Powered by yt-dlp, aria2c, and FFmpeg.
            </p>
          </div>
        </div>

        <div className="about-links">
          <a
            href="https://github.com/syedzargham-afk/snipr"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
          >
            <ExternalLink size={14} />
            <span>GitHub Repository</span>
          </a>
        </div>

        <p className="disclaimer-text">
          Disclaimer: Snipr Download Manager (SDM) is intended for personal use and downloading content you have rights or permission to download. Users are responsible for complying with platform Terms of Service and copyright laws.
        </p>
      </section>
    </form>
  );
}
