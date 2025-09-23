import React, { useEffect, useState, useCallback } from 'react';
import { usePhotos } from '../../state/photos/PhotosContext';
import { useAuth } from '../../state/auth/AuthContext';
import { PhotoMap } from './PhotoMap';
import { Input, Divider } from '@fluentui/react-components';

export const PhotosPanel: React.FC = () => {
  const { filteredPhotos, loading, error, refresh, setSearch } = usePhotos();
  const { api } = useAuth();
  const [localQuery, setLocalQuery] = useState('');

  useEffect(() => { refresh(); }, [refresh]);

  const onSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalQuery(val);
    setSearch(val);
  }, [setSearch]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ padding: '1rem', borderRadius: 8, background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center' }}>
          <Input placeholder="Search photos..." value={localQuery} onChange={onSearchChange} style={{ flex: 1 }} />
          <span style={{ fontSize: 12, opacity: 0.7 }}>{filteredPhotos.length} shown</span>
        </div>
        <PhotoMap />
      </div>
      <Divider />
      {loading && <div>Loading photos...</div>}
      {error && <div style={{ color: '#f88' }}>{error}</div>}
      {!loading && !error && (
        <div className="photos-grid">
          {filteredPhotos.map(p => {
            const src = api.getFileUrl(p.thumbnail_path || p.file_path);
            return (
              <div key={p.id} className="photo-card">
                <img src={src} alt={p.original_name} loading="lazy" />
                <div className="photo-card-info">
                  <h4>{p.original_name}</h4>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
