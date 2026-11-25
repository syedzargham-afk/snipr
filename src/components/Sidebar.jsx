import React from 'react';
import {
  Clock,
  Download,
  Home,
  Puzzle,
  Settings as SettingsIcon,
} from 'lucide-react';
import sniprLogo from '../../assets/logo.svg';
import './Sidebar.css';

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'history', label: 'History', icon: Clock },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export default function Sidebar({
  activeTab,
  onSelectTab,
  activeCount = 0,
  historyCount = 0,
  extensionOnline = false,
  onOpenExtension,
}) {
  return (
    <aside className="sidebar" aria-label="Primary Navigation">
      <div className="sidebar-brand">
        <div className="brand-mark" aria-hidden="true">
          <img src={sniprLogo} alt="" className="brand-logo-img" />
        </div>
        <div>
          <div className="brand-title">Snipr</div>
          <div className="brand-subtitle">Download Manager (SDM)</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          const badge =
            item.id === 'downloads' && activeCount > 0
              ? activeCount
              : item.id === 'history' && historyCount > 0
                ? historyCount
                : null;

          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${active ? 'active' : ''}`}
              onClick={() => onSelectTab(item.id)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={19} strokeWidth={active ? 2.3 : 1.9} />
              <span className="nav-label">{item.label}</span>
              {badge !== null && <span className="nav-badge">{badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="ext-bridge-btn"
          onClick={onOpenExtension}
          title="Browser Extension Companion"
        >
          <span
            className={`bridge-dot ${extensionOnline ? 'online' : 'offline'}`}
            aria-hidden="true"
          />
          <Puzzle size={16} />
          <span className="ext-bridge-text">Browser Extension</span>
        </button>
      </div>
    </aside>
  );
}
