import React from 'react';
import { Clock, Film, Globe, User } from 'lucide-react';
import './VideoCard.css';

export function VideoCardSkeleton() {
  return (
    <div className="surface-card video-preview-skeleton" aria-busy="true" aria-label="Loading video info">
      <div className="video-card-layout">
        <div className="skeleton skeleton-thumb" />
        <div className="video-card-info">
          <div className="skeleton skeleton-line lg" />
          <div className="skeleton skeleton-line md" />
          <div className="skeleton-badges">
            <div className="skeleton skeleton-pill" />
            <div className="skeleton skeleton-pill" />
          </div>
        </div>
      </div>
      <div className="skeleton-chips">
        <div className="skeleton skeleton-chip" />
        <div className="skeleton skeleton-chip" />
        <div className="skeleton skeleton-chip" />
        <div className="skeleton skeleton-chip" />
        <div className="skeleton skeleton-chip" />
      </div>
      <div className="skeleton skeleton-btn" />
    </div>
  );
}

export default function VideoCard({ metadata }) {
  if (!metadata) return null;

  return (
    <div className="video-card-layout">
      <div className="video-thumb-frame">
        {metadata.thumbnail ? (
          <img
            src={metadata.thumbnail}
            alt={metadata.title}
            className="video-thumb-img"
          />
        ) : (
          <div className="video-thumb-img video-thumb-fallback">
            <Film size={28} />
          </div>
        )}
        {metadata.duration && (
          <span className="video-duration-badge">
            <Clock size={11} />
            <span>{metadata.duration}</span>
          </span>
        )}
      </div>

      <div className="video-card-info">
        <h2 className="video-card-title">{metadata.title}</h2>
        <div className="video-card-badges">
          <span className="badge badge-accent">
            <Globe size={12} />
            <span>{metadata.platform}</span>
          </span>
          {metadata.uploader && (
            <span className="badge">
              <User size={12} />
              <span>{metadata.uploader}</span>
            </span>
          )}
          {metadata.resolution && (
            <span className="badge">{metadata.resolution}</span>
          )}
        </div>
      </div>
    </div>
  );
}
