import React, { useEffect } from 'react';
import { useSharing } from '../../state/sharing/SharingContext';

export const SharingPanel: React.FC = () => {
  const { created, received, loading, error, refresh } = useSharing();
  useEffect(() => { refresh(); }, [refresh]);
  if (loading) return <div className="loading">Loading shared items...</div>;
  if (error) return <div className="error">{error}</div>;
  return (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <div style={{ flex: 1 }}>
        <h3>Shared By You</h3>
        <ul>
          {created.map(s => (
            <li key={s.id}>{s.resource_type} #{s.resource_id} → {s.shared_with_email}</li>
          ))}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        <h3>Shared With You</h3>
        <ul>
          {received.map(s => (
            <li key={s.id}>{s.resource_type} #{s.resource_id} from {s.owner_username || s.owner_id}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};
