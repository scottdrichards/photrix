// API Client for Photrix Backend
class PhotoAPI {
    constructor() {
        this.baseURL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
            ? 'http://localhost:3001/api' 
            : '/api';
        this.token = localStorage.getItem('photrix_token');
    }

    setToken(token) {
        this.token = token;
        if (token) {
            localStorage.setItem('photrix_token', token);
        } else {
            localStorage.removeItem('photrix_token');
        }
    }

    getAuthHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        
        return headers;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const config = {
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

    // Auth endpoints
    async login(username, password) {
        return this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    }

    async register(username, email, password) {
        return this.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, email, password })
        });
    }

    // Photo endpoints
    async getPhotos(params = {}) {
        const queryString = new URLSearchParams(params).toString();
        return this.request(`/photos${queryString ? '?' + queryString : ''}`);
    }

    async getPhoto(id) {
        return this.request(`/photos/${id}`);
    }

    async uploadPhotos(files, onProgress) {
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
                    const data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(data.error || `HTTP ${xhr.status}`));
                    }
                } catch (error) {
                    reject(error);
                }
            });
            
            xhr.addEventListener('error', () => {
                reject(new Error('Upload failed'));
            });
            
            xhr.open('POST', url);
            xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
            xhr.send(formData);
        });
    }

    async deletePhoto(id) {
        return this.request(`/photos/${id}`, {
            method: 'DELETE'
        });
    }

    // Album endpoints
    async getAlbums() {
        return this.request('/albums');
    }

    async getAlbum(id) {
        return this.request(`/albums/${id}`);
    }

    async createAlbum(name, description) {
        return this.request('/albums', {
            method: 'POST',
            body: JSON.stringify({ name, description })
        });
    }

    async deleteAlbum(id) {
        return this.request(`/albums/${id}`, {
            method: 'DELETE'
        });
    }

    async addPhotoToAlbum(albumId, photoId) {
        return this.request(`/albums/${albumId}/photos`, {
            method: 'POST',
            body: JSON.stringify({ photo_id: photoId })
        });
    }

    async removePhotoFromAlbum(albumId, photoId) {
        return this.request(`/albums/${albumId}/photos/${photoId}`, {
            method: 'DELETE'
        });
    }

    // Sharing endpoints
    async createShare(resourceType, resourceId, email, permissions = 'view', expiresAt = null) {
        return this.request('/sharing', {
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

    async getCreatedShares() {
        return this.request('/sharing/created');
    }

    async getReceivedShares() {
        return this.request('/sharing/received');
    }

    async getSharedResource(shareId) {
        return this.request(`/sharing/resource/${shareId}`);
    }

    async deleteShare(shareId) {
        return this.request(`/sharing/${shareId}`, {
            method: 'DELETE'
        });
    }

    // Health check
    async healthCheck() {
        return this.request('/health');
    }

    // Helper method to get file URL
    getFileUrl(path) {
        if (!path) return '';
        return path.startsWith('http') ? path : `${this.baseURL.replace('/api', '')}/uploads/${path.split('/').pop()}`;
    }
}

// Create global API instance
window.photoAPI = new PhotoAPI();