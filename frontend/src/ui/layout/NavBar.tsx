import React from 'react';
import { useUi } from '../../state/ui/UiContext';

const tabs: { key: 'photos' | 'albums' | 'shared'; icon: string; label: string }[] = [
  { key: 'photos', icon: 'fa-images', label: 'Photos' },
  { key: 'albums', icon: 'fa-folder', label: 'Albums' },
  { key: 'shared', icon: 'fa-share', label: 'Shared' }
];

export const NavBar: React.FC = () => {
  const { activeSection, navigate } = useUi();
  return (
    <nav className="nav" style={{ display: 'flex', gap: '0.5rem' }}>
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => navigate(t.key)}
          className={`nav-btn ${activeSection === t.key ? 'active' : ''}`}
        >
          <i className={`fas ${t.icon}`} /> {t.label}
        </button>
      ))}
    </nav>
  );
};
