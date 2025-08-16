import { useEffect, useState } from "react";
import { getFileInfo, type FileInfo } from "./data/api";

type Props = {
  filePath: string;
  style?: React.CSSProperties;
};

export const FileInfoPanel: React.FC<Props> = ({ filePath, style }) => {
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) return;

    const loadFileInfo = async () => {
      setLoading(true);
      setError(null);
      try {
        const info = await getFileInfo(filePath);
        setFileInfo(info);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file info');
        setFileInfo(null);
      } finally {
        setLoading(false);
      }
    };

    loadFileInfo();
  }, [filePath]);

  if (loading) {
    return <div style={{ padding: '16px' }}>Loading file information...</div>;
  }

  if (error) {
    return <div style={{ padding: '16px', color: 'red' }}>Error: {error}</div>;
  }

  if (!fileInfo) {
    return null;
  }

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleDateString();
  };

  const formatResolution = (width?: number, height?: number) => {
    if (!width || !height) return 'N/A';
    return `${width} × ${height}`;
  };

  const formatRating = (rating?: number) => {
    if (!rating) return 'Unrated';
    return '★'.repeat(rating) + '☆'.repeat(5 - rating);
  };

  return (
    <div style={{ 
      padding: '16px', 
      backgroundColor: 'rgba(0, 0, 0, 0.7)', 
      color: 'white',
      fontSize: '14px',
      maxHeight: '300px',
      overflowY: 'auto',
      fontFamily: 'monospace',
      ...style
    }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>{fileInfo.name}</h3>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <div>
          <strong>Resolution:</strong> {formatResolution(fileInfo.image_width, fileInfo.image_height)}
        </div>
        <div>
          <strong>Rating:</strong> {formatRating(fileInfo.rating)}
        </div>
        
        {fileInfo.date_taken && (
          <div>
            <strong>Date Taken:</strong> {formatDate(fileInfo.date_taken)}
          </div>
        )}
        
        {fileInfo.hierarchical_subject && (
          <div style={{ gridColumn: '1 / -1' }}>
            <strong>Subject:</strong> {fileInfo.hierarchical_subject}
          </div>
        )}
        {fileInfo.keywords && fileInfo.keywords.length > 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <strong>Keywords:</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
              {fileInfo.keywords.map((keyword, index) => (
                <span
                  key={index}
                  style={{
                    background: '#e0e0e0',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    fontSize: '0.8em',
                    color: '#333'
                  }}
                >
                  {keyword}
                </span>
              ))}
            </div>
          </div>
        )}
        
        {fileInfo.camera_make && (
          <div>
            <strong>Camera:</strong> {fileInfo.camera_make}
          </div>
        )}
        
        {fileInfo.camera_model && (
          <div>
            <strong>Model:</strong> {fileInfo.camera_model}
          </div>
        )}
        
        {fileInfo.lens_model && (
          <div style={{ gridColumn: '1 / -1' }}>
            <strong>Lens:</strong> {fileInfo.lens_model}
          </div>
        )}
        
        {fileInfo.focal_length && (
          <div>
            <strong>Focal Length:</strong> {fileInfo.focal_length}
          </div>
        )}
        
        {fileInfo.aperture && (
          <div>
            <strong>Aperture:</strong> {fileInfo.aperture}
          </div>
        )}
        
        {fileInfo.shutter_speed && (
          <div>
            <strong>Shutter:</strong> {fileInfo.shutter_speed}
          </div>
        )}
        
        {fileInfo.iso && (
          <div>
            <strong>ISO:</strong> {fileInfo.iso}
          </div>
        )}
      </div>
    </div>
  );
};
