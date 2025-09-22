// Photos management module
class PhotosManager {
    constructor() {
        this.photos = [];
        this.currentPage = 1;
        this.isLoading = false;
        this.currentPhoto = null;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupUpload();
    }

    setupEventListeners() {
        // Search functionality
        document.getElementById('searchInput').addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.loadPhotos(1, e.target.value);
            }, 300);
        });

        // Photo modal
        document.getElementById('closePhotoModal').addEventListener('click', () => {
            this.closePhotoModal();
        });

        document.getElementById('sharePhotoBtn').addEventListener('click', () => {
            this.shareCurrentPhoto();
        });

        document.getElementById('deletePhotoBtn').addEventListener('click', () => {
            this.deleteCurrentPhoto();
        });

        // Close modal when clicking outside
        document.getElementById('photoModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.closePhotoModal();
            }
        });
    }

    setupUpload() {
        const uploadBtn = document.getElementById('uploadBtn');
        const uploadModal = document.getElementById('uploadModal');
        const closeUploadModal = document.getElementById('closeUploadModal');
        const uploadArea = document.getElementById('uploadArea');
        const photoInput = document.getElementById('photoInput');

        uploadBtn.addEventListener('click', () => {
            uploadModal.classList.add('show');
        });

        closeUploadModal.addEventListener('click', () => {
            this.closeUploadModal();
        });

        uploadModal.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.closeUploadModal();
            }
        });

        // Drag and drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });

        uploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files).filter(file => 
                file.type.startsWith('image/'));
            if (files.length > 0) {
                this.uploadPhotos(files);
            }
        });

        // File input
        photoInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                this.uploadPhotos(files);
            }
        });
    }

    async loadPhotos(page = 1, search = '') {
        if (this.isLoading) return;
        
        this.isLoading = true;
        this.showLoading(true);

        try {
            const params = { page, limit: 20 };
            if (search) params.search = search;

            const response = await photoAPI.getPhotos(params);
            this.photos = response.photos;
            this.currentPage = page;
            this.renderPhotos();
        } catch (error) {
            showToast(`Failed to load photos: ${error.message}`, 'error');
        } finally {
            this.isLoading = false;
            this.showLoading(false);
        }
    }

    renderPhotos() {
        const grid = document.getElementById('photosGrid');
        
        if (this.photos.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: rgba(255,255,255,0.7);">
                    <i class="fas fa-images" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                    <p>No photos found. Start by uploading some!</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = this.photos.map(photo => `
            <div class="photo-card" data-photo-id="${photo.id}">
                <img src="${photoAPI.getFileUrl(photo.thumbnail_path || photo.file_path)}" 
                     alt="${photo.original_name}" 
                     loading="lazy">
                <div class="photo-card-info">
                    <h4 title="${photo.original_name}">${this.truncateText(photo.original_name, 25)}</h4>
                    <p>
                        <i class="fas fa-calendar"></i>
                        ${this.formatDate(photo.uploaded_at)}
                    </p>
                    ${photo.width && photo.height ? 
                        `<p><i class="fas fa-expand-arrows-alt"></i> ${photo.width}x${photo.height}</p>` : ''}
                </div>
            </div>
        `).join('');

        // Add click handlers
        grid.querySelectorAll('.photo-card').forEach(card => {
            card.addEventListener('click', () => {
                const photoId = card.dataset.photoId;
                this.openPhotoModal(photoId);
            });
        });
    }

    async uploadPhotos(files) {
        const uploadProgress = document.getElementById('uploadProgress');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');

        uploadProgress.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = 'Uploading...';

        try {
            const response = await photoAPI.uploadPhotos(files, (progress) => {
                progressFill.style.width = `${progress}%`;
                progressText.textContent = `Uploading... ${Math.round(progress)}%`;
            });

            showToast(`Successfully uploaded ${response.photos.length} photos`, 'success');
            this.closeUploadModal();
            this.loadPhotos(); // Reload photos
        } catch (error) {
            showToast(`Upload failed: ${error.message}`, 'error');
        } finally {
            uploadProgress.style.display = 'none';
        }
    }

    closeUploadModal() {
        const uploadModal = document.getElementById('uploadModal');
        uploadModal.classList.remove('show');
        document.getElementById('photoInput').value = '';
        document.getElementById('uploadProgress').style.display = 'none';
    }

    async openPhotoModal(photoId) {
        try {
            const photo = await photoAPI.getPhoto(photoId);
            this.currentPhoto = photo;
            
            const modal = document.getElementById('photoModal');
            const modalPhoto = document.getElementById('modalPhoto');
            const photoTitle = document.getElementById('photoTitle');
            const photoMetadata = document.getElementById('photoMetadata');

            photoTitle.textContent = photo.original_name;
            modalPhoto.src = photoAPI.getFileUrl(photo.file_path);
            modalPhoto.alt = photo.original_name;

            // Display metadata
            const metadata = photo.metadata || {};
            photoMetadata.innerHTML = `
                <h5><i class="fas fa-info-circle"></i> Photo Information</h5>
                <div style="display: grid; gap: 0.5rem; margin-top: 1rem;">
                    <div><strong>File:</strong> ${photo.original_name}</div>
                    <div><strong>Size:</strong> ${this.formatFileSize(photo.file_size)}</div>
                    <div><strong>Dimensions:</strong> ${photo.width}x${photo.height}</div>
                    <div><strong>Type:</strong> ${photo.mime_type}</div>
                    <div><strong>Uploaded:</strong> ${this.formatDate(photo.uploaded_at)}</div>
                    ${metadata.format ? `<div><strong>Format:</strong> ${metadata.format}</div>` : ''}
                    ${metadata.density ? `<div><strong>Density:</strong> ${metadata.density} DPI</div>` : ''}
                </div>
            `;

            modal.classList.add('show');
        } catch (error) {
            showToast(`Failed to load photo: ${error.message}`, 'error');
        }
    }

    closePhotoModal() {
        document.getElementById('photoModal').classList.remove('show');
        this.currentPhoto = null;
    }

    async shareCurrentPhoto() {
        if (!this.currentPhoto) return;

        const email = prompt('Enter email address to share with:');
        if (!email) return;

        try {
            await photoAPI.createShare('photo', this.currentPhoto.id, email);
            showToast('Photo shared successfully!', 'success');
        } catch (error) {
            showToast(`Failed to share photo: ${error.message}`, 'error');
        }
    }

    async deleteCurrentPhoto() {
        if (!this.currentPhoto) return;

        if (!confirm(`Are you sure you want to delete "${this.currentPhoto.original_name}"?`)) {
            return;
        }

        try {
            await photoAPI.deletePhoto(this.currentPhoto.id);
            showToast('Photo deleted successfully', 'success');
            this.closePhotoModal();
            this.loadPhotos(); // Reload photos
        } catch (error) {
            showToast(`Failed to delete photo: ${error.message}`, 'error');
        }
    }

    showLoading(show) {
        const loading = document.getElementById('photosLoading');
        loading.style.display = show ? 'block' : 'none';
    }

    clearPhotos() {
        this.photos = [];
        this.renderPhotos();
    }

    // Utility methods
    truncateText(text, length) {
        return text.length > length ? text.substring(0, length) + '...' : text;
    }

    formatDate(dateString) {
        return new Date(dateString).toLocaleDateString();
    }

    formatFileSize(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// Initialize photos manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.photosManager = new PhotosManager();
});