// Type definitions for Photrix application

export interface User {
  id: number;
  username: string;
  email: string;
}

export interface Photo {
  id: number;
  user_id: number;
  filename: string;
  original_name: string;
  file_path: string;
  thumbnail_path?: string;
  file_size: number;
  mime_type: string;
  width: number;
  height: number;
  taken_at?: string;
  uploaded_at: string;
  metadata?: Record<string, any>;
  tags?: string[];
  description?: string;
  is_favorite: boolean;
  latitude?: number;
  longitude?: number;
}

export interface Album {
  id: number;
  user_id: number;
  name: string;
  description?: string;
  cover_photo_id?: number;
  cover_photo_path?: string;
  photo_count?: number;
  created_at: string;
  updated_at: string;
  photos?: Photo[];
}

export interface Share {
  id: number;
  owner_id: number;
  owner_username?: string;
  shared_with_email: string;
  resource_type: 'photo' | 'album';
  resource_id: number;
  resource_name?: string;
  permissions: 'view' | 'comment' | 'edit';
  expires_at?: string;
  created_at: string;
  thumbnail_path?: string;
}

export interface SharedResource {
  share_info: Share;
  resource: Photo | Album;
}

export interface APIResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

export interface AuthResponse {
  message: string;
  token: string;
  user: User;
}

export interface PhotosResponse {
  photos: Photo[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface AlbumsResponse {
  albums: Album[];
}

export interface SharesResponse {
  shares: Share[];
}

export interface UploadResponse {
  message: string;
  photos: Photo[];
}

export type ToastType = 'info' | 'success' | 'error' | 'warning';

// Global interfaces - these will be augmented in main.ts
declare global {
  interface Window {
    photoAPI: any;
    auth: any;
    app: any;
    photosManager: any;
    albumsManager: any;
    sharingManager: any;
    imageProcessor: any;
    performanceOptimizer: any;
  }
}