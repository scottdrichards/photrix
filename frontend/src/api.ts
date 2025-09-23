import type { 
  AuthResponse, 
  PhotosResponse, 
  Photo, 
  Album, 
  AlbumsResponse,
  Share,
  SharesResponse, 
  SharedResource,
  UploadResponse,
  APIResponse
} from './types.js';

// API Client for Photrix Backend
export class PhotoAPI {
  private baseURL: string;
  private token: string | null;

  constructor() {
    this.baseURL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? 'http://localhost:3001/api' 
      : '/api';
    this.token = localStorage.getItem('photrix_token');
  }

  setToken(token: string | null): void {
    this.token = token;
    if (token) {
      localStorage.setItem('photrix_token', token);
    } else {
      localStorage.removeItem('photrix_token');
    }
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    
    return headers;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const config: RequestInit = {
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...options.headers
      }
    };

    try {
      const response = await fetch(url, config);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      
      return data;
    } catch (error) {
      console.error('API Request failed:', error);
      throw error;
    }
  }

  // Current user endpoint
  async getCurrentUser(): Promise<{ user: { id: number; username: string; email: string } }> {
    return this.request<{ user: { id: number; username: string; email: string } }>("/auth/me");
  }

  // Auth endpoints
  async login(username: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
  }

  async register(username: string, email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password })
    });
  }

  // Photo endpoints
  async getPhotos(params: Record<string, string | number> = {}): Promise<PhotosResponse> {
    const queryString = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    ).toString();
    return this.request<PhotosResponse>(`/photos${queryString ? '?' + queryString : ''}`);
  }

  async getPhoto(id: number): Promise<Photo> {
    return this.request<Photo>(`/photos/${id}`);
  }

  async uploadPhotos(files: File[], onProgress?: (progress: number) => void): Promise<UploadResponse> {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('photos', file);
    });

    const url = `${this.baseURL}/photos/upload`;
    
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const percentComplete = (e.loaded / e.total) * 100;
          onProgress(percentComplete);
        }
      });
      
      xhr.addEventListener('load', () => {
        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            const data = JSON.parse(xhr.responseText);
            resolve(data);
          } else {
            // Try to parse error response
            try {
              const errorData = JSON.parse(xhr.responseText);
              reject(new Error(errorData.error || `HTTP ${xhr.status}`));
            } catch (parseError) {
              // If response is not JSON (e.g., HTML error page), use status text
              reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText || 'Upload failed'}`));
            }
          }
        } catch (error) {
          reject(new Error('Failed to parse server response'));
        }
      });
      
      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });
      
      xhr.open('POST', url);
      if (this.token) {
        xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      }
      xhr.send(formData);
    });
  }

  async deletePhoto(id: number): Promise<APIResponse<void>> {
    return this.request<APIResponse<void>>(`/photos/${id}`, {
      method: 'DELETE'
    });
  }

  // Album endpoints
  async getAlbums(): Promise<AlbumsResponse> {
    return this.request<AlbumsResponse>('/albums');
  }

  async getAlbum(id: number): Promise<Album> {
    return this.request<Album>(`/albums/${id}`);
  }

  async createAlbum(name: string, description?: string): Promise<Album> {
    return this.request<Album>('/albums', {
      method: 'POST',
      body: JSON.stringify({ name, description })
    });
  }

  async deleteAlbum(id: number): Promise<APIResponse<void>> {
    return this.request<APIResponse<void>>(`/albums/${id}`, {
      method: 'DELETE'
    });
  }

  async addPhotoToAlbum(albumId: number, photoId: number): Promise<APIResponse<void>> {
    return this.request<APIResponse<void>>(`/albums/${albumId}/photos`, {
      method: 'POST',
      body: JSON.stringify({ photo_id: photoId })
    });
  }

  async removePhotoFromAlbum(albumId: number, photoId: number): Promise<APIResponse<void>> {
    return this.request<APIResponse<void>>(`/albums/${albumId}/photos/${photoId}`, {
      method: 'DELETE'
    });
  }

  // Sharing endpoints
  async createShare(
    resourceType: 'photo' | 'album', 
    resourceId: number, 
    email: string, 
    permissions: 'view' | 'comment' | 'edit' = 'view', 
    expiresAt: string | null = null
  ): Promise<Share> {
    return this.request<Share>('/sharing', {
      method: 'POST',
      body: JSON.stringify({
        resource_type: resourceType,
        resource_id: resourceId,
        shared_with_email: email,
        permissions,
        expires_at: expiresAt
      })
    });
  }

  async getCreatedShares(): Promise<SharesResponse> {
    return this.request<SharesResponse>('/sharing/created');
  }

  async getReceivedShares(): Promise<SharesResponse> {
    return this.request<SharesResponse>('/sharing/received');
  }

  async getSharedResource(shareId: number): Promise<SharedResource> {
    return this.request<SharedResource>(`/sharing/resource/${shareId}`);
  }

  async deleteShare(shareId: number): Promise<APIResponse<void>> {
    return this.request<APIResponse<void>>(`/sharing/${shareId}`, {
      method: 'DELETE'
    });
  }

  // Health check
  async healthCheck(): Promise<{ status: string; message: string; timestamp: string }> {
    return this.request<{ status: string; message: string; timestamp: string }>('/health');
  }

  // Helper method to get file URL
  getFileUrl(path: string | undefined): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    
    // For relative paths, construct the full URL
    const baseUrl = this.baseURL.replace('/api', '');
    return `${baseUrl}/uploads/${path}`;
  }
}