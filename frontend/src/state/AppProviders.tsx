import React, { PropsWithChildren } from 'react';
import { AuthProvider } from './auth/AuthContext';
import { PhotosProvider } from './photos/PhotosContext';
import { AlbumsProvider } from './albums/AlbumsContext';
import { SharingProvider } from './sharing/SharingContext';
import { UiProvider } from './ui/UiContext';

export const AppProviders: React.FC<PropsWithChildren> = ({ children }) => {
  return (
    <UiProvider>
      <AuthProvider>
        <PhotosProvider>
          <AlbumsProvider>
            <SharingProvider>
              {children}
            </SharingProvider>
          </AlbumsProvider>
        </PhotosProvider>
      </AuthProvider>
    </UiProvider>
  );
};
