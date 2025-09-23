import React from 'react';
import { NavBar } from './NavBar';
import { useAuth } from '../../state/auth/AuthContext';
import { useUi } from '../../state/ui/UiContext';
import { UploadModal } from '../upload/UploadModal';
import { Button, Toolbar, Tooltip } from '@fluentui/react-components';
import { SignOut24Regular, ArrowUpload24Regular, Camera24Regular } from '@fluentui/react-icons';

export const Header: React.FC = () => {
  const { user, logout } = useAuth();
  const { openModal, closeModal, modals } = useUi();
  return (
    <header style={{ padding: '0.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 600, fontSize: 18 }}>
          <Camera24Regular /> Photrix
        </div>
        <NavBar />
        <Toolbar style={{ marginLeft: 'auto', display: 'flex', gap: '.5rem' }}>
          <Tooltip content="Upload" relationship="label">
            <Button appearance="primary" icon={<ArrowUpload24Regular />} onClick={() => openModal('upload')} />
          </Tooltip>
          {user && (
            <Tooltip content={user.username} relationship="description">
              <Button appearance="secondary" icon={<SignOut24Regular />} onClick={logout} />
            </Tooltip>
          )}
        </Toolbar>
      </div>
      <UploadModal open={!!modals.upload} onClose={() => closeModal('upload')} />
    </header>
  );
};
