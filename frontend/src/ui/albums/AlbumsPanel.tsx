import React, { useEffect } from 'react';
import { useAlbums } from '../../state/albums/AlbumsContext';

export const AlbumsPanel: React.FC = () => {
  const { albums, loading, error, refresh } = useAlbums();
  useEffect(() => { refresh(); }, [refresh]);
  if (loading) return <div className="loading">Loading albums...</div>;
  if (error) return <div className="error">{error}</div>;
  return (
    <div className="albums-grid">
      {albums.map(a => (
        <div key={a.id} className="album-card">
          <h4>{a.name}</h4>
          <p style={{ opacity: 0.7, fontSize: 12 }}>{a.photo_count ?? 0} photos</p>
        </div>
      ))}
    </div>
  );
};
