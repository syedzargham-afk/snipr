import React from 'react';
import { ShieldCheck } from 'lucide-react';
import './QualitySelect.css';

const QUALITY_OPTIONS = [
  { value: 'best', label: 'Best', hint: 'Highest MP4' },
  { value: '1080p', label: '1080p', hint: 'Full HD' },
  { value: '720p', label: '720p', hint: 'HD Ready' },
  { value: '480p', label: '480p', hint: 'Compact' },
  { value: 'mp3', label: 'MP3', hint: 'Audio only' },
];

export default function QualitySelect({
  value,
  onChange,
  disabled,
  compatibleMp4 = true,
}) {
  return (
    <div className="quality-block">
      <div className="quality-top">
        <span className="quality-heading">Quality</span>
        {value !== 'mp3' && compatibleMp4 && (
          <span className="compat-badge">
            <ShieldCheck size={13} />
            <span>Windows Safe (H.264)</span>
          </span>
        )}
      </div>

      <div className="quality-segments" role="radiogroup" aria-label="Download quality">
        {QUALITY_OPTIONS.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={`quality-chip ${active ? 'active' : ''}`}
              onClick={() => onChange(opt.value)}
              disabled={disabled}
            >
              <span className="quality-chip-label">{opt.label}</span>
              <span className="quality-chip-hint">{opt.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
