import React from 'react';
import { Copy, FolderOpen, Puzzle, X } from 'lucide-react';
import './ExtensionModal.css';

export default function ExtensionModal({
  extensionInfo,
  onClose,
  onOpenFolder,
  onCopy,
}) {
  const port = extensionInfo?.port || 48921;
  const listening = extensionInfo?.listening !== false;
  const extDir = extensionInfo?.extensionDir || '';
  const lastSeen = extensionInfo?.lastExtensionSeen;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Snipr Browser Extension"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="ext-head">
            <div className="ext-head-icon">
              <Puzzle size={20} />
            </div>
            <div>
              <h2 className="modal-title">Snipr Browser Extension</h2>
              <p className="ext-head-sub">
                IDM-style &ldquo;Download by Snipr&rdquo; button for Chrome, Edge &amp; Brave
              </p>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close extension modal"
          >
            <X size={18} />
          </button>
        </div>

        <div className="ext-status-box">
          <div className="ext-status-line">
            <span className="ext-status-key">Local Bridge Server</span>
            <span className={`badge ${listening ? 'badge-success' : 'badge-danger'}`}>
              {listening ? `Active · 127.0.0.1:${port}` : 'Offline'}
            </span>
          </div>
          <div className="ext-status-line">
            <span className="ext-status-key">Extension Activity</span>
            <span className="ext-status-val">
              {lastSeen
                ? `Connected at ${new Date(lastSeen).toLocaleTimeString()}`
                : 'Waiting for browser extension'}
            </span>
          </div>
        </div>

        <div className="ext-steps-card">
          <div className="ext-steps-heading">Quick Install (30 seconds)</div>
          <ol className="ext-steps-list">
            <li>
              Click <strong>Open Extension Folder</strong> below.
            </li>
            <li>
              Open <code>chrome://extensions</code> or <code>edge://extensions</code>.
            </li>
            <li>
              Enable <strong>Developer mode</strong> (top right).
            </li>
            <li>
              Click <strong>Load unpacked</strong> and select the <code>extension</code> folder.
            </li>
            <li>
              Copy your <strong>Pairing Token</strong> below and paste it into the extension popup.
            </li>
          </ol>
        </div>

        {extensionInfo?.token && (
          <div className="ext-path-row">
            <span className="ext-path-value" title="Bridge Pairing Token">
              Token: {extensionInfo.token}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onCopy(extensionInfo.token, 'Pairing token copied')}
            >
              <Copy size={13} />
              <span>Copy token</span>
            </button>
          </div>
        )}

        {extDir && (
          <div className="ext-path-row">
            <span className="ext-path-value" title={extDir}>
              {extDir}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onCopy(extDir, 'Extension folder path copied')}
            >
              <Copy size={13} />
              <span>Copy</span>
            </button>
          </div>
        )}

        <div className="ext-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onOpenFolder}
          >
            <FolderOpen size={15} />
            <span>Open Extension Folder</span>
          </button>
        </div>
      </div>
    </div>
  );
}
