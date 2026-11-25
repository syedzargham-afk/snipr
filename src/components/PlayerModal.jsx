import React, { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Music, Wrench, X } from 'lucide-react';
import './PlayerModal.css';

export default function PlayerModal({
  item,
  onClose,
  onOpenExternal,
  onOpenFolder,
  onConvertH264,
  probeFile,
  createStreamUrl,
}) {
  const [probe, setProbe] = useState(null);
  const [streamUrl, setStreamUrl] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    if (!item?.filePath) return;
    let active = true;
    setMediaError('');
    setProbe(null);
    setStreamUrl('');

    probeFile(item.filePath).then((res) => {
      if (active && res?.ok && res.data) {
        setProbe(res.data);
      }
    });

    createStreamUrl(item.filePath)
      .then((res) => {
        if (!active) return;
        if (res?.ok && res.url) {
          setStreamUrl(res.url);
        } else {
          setMediaError(res?.error || 'Unable to authorize media stream.');
        }
      })
      .catch(() => {
        if (active) setMediaError('Unable to authorize media stream.');
      });

    return () => {
      active = false;
    };
  }, [item?.filePath, probeFile, createStreamUrl]);

  if (!item || !item.filePath) return null;

  const isAudio = item.filePath.toLowerCase().endsWith('.mp3');

  async function handleFixCodec() {
    setConverting(true);
    try {
      await onConvertH264(item);
      onClose();
    } finally {
      setConverting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel player-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Playing ${item.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="player-head-meta">
            <h2 className="modal-title player-modal-title" title={item.title}>
              {item.title}
            </h2>
            <div className="player-badges">
              {probe?.vcodec && (
                <span className="badge">Video: {probe.vcodec.toUpperCase()}</span>
              )}
              {probe?.acodec && (
                <span className="badge">Audio: {probe.acodec.toUpperCase()}</span>
              )}
              {probe?.width && probe?.height && (
                <span className="badge">
                  {probe.width}×{probe.height}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close player"
            title="Close player"
          >
            <X size={18} />
          </button>
        </div>

        {probe && !probe.windowsCompatible && (
          <div className="player-compat-banner">
            <div className="player-compat-copy">
              <strong>Windows Codec Notice:</strong> This video uses{' '}
              <code>{probe.vcodec?.toUpperCase() || 'AV1'}</code>
              {probe.acodec ? ` / ${probe.acodec.toUpperCase()}` : ''}. It plays
              here inside Snipr, or you can convert it to universal H.264 MP4 for Windows Media Player.
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleFixCodec}
              disabled={converting}
            >
              <Wrench size={14} />
              <span>{converting ? 'Converting...' : 'Convert to H.264'}</span>
            </button>
          </div>
        )}

        <div className="player-stage">
          {!streamUrl ? (
            <div className="audio-stage">
              <div className="player-compat-copy">
                {mediaError || 'Preparing secure playback stream...'}
              </div>
            </div>
          ) : isAudio ? (
            <div className="audio-stage">
              <div className="audio-disc">
                <Music size={32} />
              </div>
              <audio src={streamUrl} controls autoPlay className="audio-element" />
            </div>
          ) : (
            <video
              key={streamUrl}
              src={streamUrl}
              controls
              autoPlay
              className="video-element"
              onError={() =>
                setMediaError(
                  'Unable to play preview here. Try converting to H.264 MP4 or opening in an external player.'
                )
              }
            />
          )}
        </div>

        {mediaError && <div className="error-banner player-err">{mediaError}</div>}

        <div className="player-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpenExternal(item.filePath)}
          >
            <ExternalLink size={15} />
            <span>Open in Windows Player</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpenFolder(item.filePath)}
          >
            <FolderOpen size={15} />
            <span>Show in Folder</span>
          </button>
        </div>
      </div>
    </div>
  );
}
