import React from 'react';
import { PhotosPanel } from '../photos/PhotosPanel';
import { AlbumsPanel } from '../albums/AlbumsPanel';
import { SharingPanel } from '../sharing/SharingPanel';
import { useUi } from '../../state/ui/UiContext';

export const MainView: React.FC = () => {
  const { activeSection } = useUi();
  return (
    <main className="main" style={{ padding: '1rem 2rem' }}>
      {activeSection === 'photos' && <PhotosPanel />}
      {activeSection === 'albums' && <AlbumsPanel />}
      {activeSection === 'shared' && <SharingPanel />}
    </main>
  );
};
