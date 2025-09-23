import React, { useCallback, useRef, useState } from 'react';
import { usePhotos } from '../../state/photos/PhotosContext';
import { useAuth } from '../../state/auth/AuthContext';
import { Button, ProgressBar, Spinner } from '@fluentui/react-components';

interface Props { open: boolean; onClose: () => void; }

export const UploadModal: React.FC<Props> = ({ open, onClose }) => {
  const { refresh } = usePhotos();
  const { api } = useAuth();
  const [progress, setProgress] = useState<number>(0);
  const [isUploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const arr = Array.from(files);
      await api.uploadPhotos(arr, (p: number) => setProgress(p));
      await refresh();
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
      setProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [api, refresh, onClose]);

  if (!open) return null;
  return (
    <div className="modal show" style={{ display: 'flex' }}>
      <div className="modal-content" style={{ maxWidth: 520 }}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Upload Photos</h3>
          <Button size="small" onClick={onClose} appearance="secondary">Close</Button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div
            style={{ border: '2px dashed var(--colorNeutralStroke1)', padding: '2rem', textAlign: 'center', borderRadius: 12 }}
            onDragOver={e => { e.preventDefault(); }}
            onDrop={e => { e.preventDefault(); onFiles(e.dataTransfer?.files || null); }}
          >
            <p style={{ margin: 0, fontWeight: 500 }}>Drag & Drop or Select Files</p>
            <small style={{ opacity: 0.7 }}>JPG, PNG, GIF, WebP, HEIC</small>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.heic,.heif"
              multiple
              onChange={e => onFiles(e.target.files)}
              style={{ display: 'block', margin: '1rem auto 0' }}
            />
          </div>
          {isUploading && (
            <div style={{ width: '100%' }}>
              <ProgressBar value={progress / 100} />
              <p style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                {Math.round(progress)}% {progress < 100 && <Spinner size="tiny" />}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
