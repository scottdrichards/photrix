// Albums management module
class AlbumsManager {
    constructor() {
        this.albums = [];
        this.currentAlbum = null;
        this.init();
    }

    init() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        document.getElementById('createAlbumBtn').addEventListener('click', () => {
            this.createAlbum();
        });
    }

    async loadAlbums() {
        try {
            const response = await photoAPI.getAlbums();
            this.albums = response.albums;
            this.renderAlbums();
        } catch (error) {
            showToast(`Failed to load albums: ${error.message}`, 'error');
        }
    }

    renderAlbums() {
        const grid = document.getElementById('albumsGrid');
        
        if (this.albums.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: rgba(255,255,255,0.7);">
                    <i class="fas fa-folder" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                    <p>No albums created yet. Create your first album!</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = this.albums.map(album => `
            <div class="album-card" data-album-id="${album.id}">
                <div class="album-cover">
                    ${album.cover_photo_path ? 
                        `<img src="${photoAPI.getFileUrl(album.cover_photo_path)}" alt="${album.name}">` :
                        `<i class="fas fa-folder" style="font-size: 3rem;"></i>`
                    }
                </div>
                <div class="album-info">
                    <h4>${album.name}</h4>
                    <p>${album.photo_count || 0} photos</p>
                    ${album.description ? `<p style="font-size: 0.75rem; margin-top: 0.5rem;">${album.description}</p>` : ''}
                    <div class="album-actions" style="margin-top: 1rem; display: flex; gap: 0.5rem;">
                        <button class="btn btn-secondary btn-sm view-album" data-album-id="${album.id}">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button class="btn btn-danger btn-sm delete-album" data-album-id="${album.id}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        // Add event listeners
        grid.querySelectorAll('.view-album').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.viewAlbum(btn.dataset.albumId);
            });
        });

        grid.querySelectorAll('.delete-album').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteAlbum(btn.dataset.albumId);
            });
        });
    }

    async createAlbum() {
        const name = prompt('Enter album name:');
        if (!name) return;

        const description = prompt('Enter album description (optional):') || '';

        try {
            await photoAPI.createAlbum(name, description);
            showToast('Album created successfully!', 'success');
            this.loadAlbums();
        } catch (error) {
            showToast(`Failed to create album: ${error.message}`, 'error');
        }
    }

    async viewAlbum(albumId) {
        try {
            const album = await photoAPI.getAlbum(albumId);
            this.showAlbumModal(album);
        } catch (error) {
            showToast(`Failed to load album: ${error.message}`, 'error');
        }
    }

    async deleteAlbum(albumId) {
        const album = this.albums.find(a => a.id == albumId);
        if (!album) return;

        if (!confirm(`Are you sure you want to delete the album "${album.name}"?`)) {
            return;
        }

        try {
            await photoAPI.deleteAlbum(albumId);
            showToast('Album deleted successfully', 'success');
            this.loadAlbums();
        } catch (error) {
            showToast(`Failed to delete album: ${error.message}`, 'error');
        }
    }

    showAlbumModal(album) {
        // Create album modal if it doesn't exist
        let modal = document.getElementById('albumModal');
        if (!modal) {
            modal = this.createAlbumModal();
        }

        const modalTitle = modal.querySelector('.modal-title');
        const modalBody = modal.querySelector('.album-modal-body');

        modalTitle.textContent = album.name;

        if (album.photos && album.photos.length > 0) {
            modalBody.innerHTML = `
                <div class="album-description" style="margin-bottom: 1rem; color: #666;">
                    ${album.description || 'No description'}
                </div>
                <div class="album-photos-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem;">
                    ${album.photos.map(photo => `
                        <div class="album-photo-card" style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                            <img src="${photoAPI.getFileUrl(photo.thumbnail_path || photo.file_path)}" 
                                 alt="${photo.original_name}"
                                 style="width: 100%; height: 120px; object-fit: cover;">
                            <div style="padding: 0.5rem; font-size: 0.75rem;">
                                <div>${this.truncateText(photo.original_name, 20)}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        } else {
            modalBody.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: #666;">
                    <i class="fas fa-images" style="font-size: 2rem; margin-bottom: 1rem; display: block;"></i>
                    <p>This album is empty</p>
                </div>
            `;
        }

        modal.classList.add('show');
    }

    createAlbumModal() {
        const modal = document.createElement('div');
        modal.id = 'albumModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3 class="modal-title">Album</h3>
                    <button class="close-btn" onclick="this.closest('.modal').classList.remove('show')">&times;</button>
                </div>
                <div class="modal-body album-modal-body">
                    <!-- Album content will be loaded here -->
                </div>
            </div>
        `;

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                modal.classList.remove('show');
            }
        });

        document.body.appendChild(modal);
        return modal;
    }

    clearAlbums() {
        this.albums = [];
        this.renderAlbums();
    }

    truncateText(text, length) {
        return text.length > length ? text.substring(0, length) + '...' : text;
    }
}

// Initialize albums manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.albumsManager = new AlbumsManager();
});