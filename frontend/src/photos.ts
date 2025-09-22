import type { Photo } from './types.js';
import { showToast, truncateText, formatDate, formatFileSize } from './utils.js';
import { PhotoMap } from './map.js';

// Photos management module
export class PhotosManager {
  private photos: Photo[] = [];
  private filteredPhotos: Photo[] = [];
  private isLoading: boolean = false;
  private currentPhoto: Photo | null = null;
  private searchTimeout: NodeJS.Timeout | undefined;
  private photoMap: PhotoMap | null = null;
  private isFilterPaneCollapsed: boolean = false;

  constructor() {
    this.init();
  }

  private init(): void {
    this.setupEventListeners();
    this.setupUpload();
    this.initializeMap();
    this.setupFilterPane();
  }

  private initializeMap(): void {
    // Initialize the map after a short delay to ensure DOM is ready
    setTimeout(() => {
      try {
        this.photoMap = new PhotoMap('photoMap');
        this.photoMap.setViewportChangeHandler((bounds) => {
          this.handleMapViewportChange(bounds);
        });
      } catch (error) {
        console.error('Failed to initialize map:', error);
      }
    }, 100);
  }

  private setupFilterPane(): void {
    const filterHeader = document.querySelector('.filter-header');
    const toggleBtn = document.getElementById('toggleFilterPane');
    const filterContent = document.getElementById('filterContent');
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');

    // Toggle filter pane
    if (filterHeader && toggleBtn && filterContent) {
      filterHeader.addEventListener('click', () => {
        this.toggleFilterPane();
      });
    }

    // Clear filters
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        this.clearFilters();
      });
    }
  }

  private toggleFilterPane(): void {
    const toggleBtn = document.getElementById('toggleFilterPane');
    const filterContent = document.getElementById('filterContent');
    
    if (toggleBtn && filterContent) {
      this.isFilterPaneCollapsed = !this.isFilterPaneCollapsed;
      
      if (this.isFilterPaneCollapsed) {
        filterContent.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
      } else {
        filterContent.classList.remove('collapsed');
        toggleBtn.classList.remove('collapsed');
      }
    }
  }

  private clearFilters(): void {
    const searchInput = document.getElementById('searchInput') as HTMLInputElement;
    if (searchInput) {
      searchInput.value = '';
    }
    // Reset filtered photos to show all photos
    this.filteredPhotos = this.photos;
    this.renderPhotos();
    this.updateMapInfo(this.photos.filter(p => p.latitude && p.longitude).length);
  }

  private handleMapViewportChange(_bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number; }): void {
    if (!this.photoMap) return;
    
    const photosInView = this.photoMap.getPhotosInView();
    this.filteredPhotos = photosInView;
    this.displayFilteredPhotos();
    this.updateMapInfo(photosInView.length);
  }

  private displayFilteredPhotos(): void {
    const grid = document.getElementById('photosGrid');
    if (!grid) return;

    if (this.filteredPhotos.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: rgba(255,255,255,0.7);">
          <i class="fas fa-map-marker-alt" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
          <p>No photos in this area</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = this.filteredPhotos.map(photo => `
      <div class="photo-card" data-photo-id="${photo.id}">
        <img src="${window.photoAPI.getFileUrl(photo.thumbnail_path || photo.file_path)}" 
             alt="${photo.original_name}" 
             loading="lazy">
        <div class="photo-card-info">
          <h4 title="${photo.original_name}">${truncateText(photo.original_name, 25)}</h4>
          <p>
            <i class="fas fa-calendar"></i>
            ${formatDate(photo.uploaded_at)}
          </p>
          ${photo.width && photo.height ? 
            `<p><i class="fas fa-expand-arrows-alt"></i> ${photo.width}x${photo.height}</p>` : ''}
          ${photo.latitude && photo.longitude ? 
            `<p><i class="fas fa-map-marker-alt"></i> ${photo.latitude.toFixed(4)}, ${photo.longitude.toFixed(4)}</p>` : ''}
        </div>
      </div>
    `).join('');

    // Add click handlers
    grid.querySelectorAll('.photo-card').forEach(card => {
      card.addEventListener('click', () => {
        const photoId = (card as HTMLElement).dataset.photoId;
        if (photoId) {
          this.openPhotoModal(parseInt(photoId));
        }
      });
    });
  }

  private updateMapInfo(count: number): void {
    const mapPhotoCount = document.getElementById('mapPhotoCount');
    if (mapPhotoCount) {
      mapPhotoCount.textContent = `${count} photo${count === 1 ? '' : 's'}`;
    }
  }

  private setupEventListeners(): void {
    // Search functionality
    const searchInput = document.getElementById('searchInput') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.loadPhotos(1, (e.target as HTMLInputElement).value);
      }, 300);
    });

    // Photo modal
    const closePhotoModal = document.getElementById('closePhotoModal');
    closePhotoModal?.addEventListener('click', () => {
      this.closePhotoModal();
    });

    const sharePhotoBtn = document.getElementById('sharePhotoBtn');
    sharePhotoBtn?.addEventListener('click', () => {
      this.shareCurrentPhoto();
    });

    const deletePhotoBtn = document.getElementById('deletePhotoBtn');
    deletePhotoBtn?.addEventListener('click', () => {
      this.deleteCurrentPhoto();
    });

    // Close modal when clicking outside
    const photoModal = document.getElementById('photoModal');
    photoModal?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closePhotoModal();
      }
    });
  }

  private setupUpload(): void {
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadModal = document.getElementById('uploadModal');
    const closeUploadModal = document.getElementById('closeUploadModal');
    const uploadArea = document.getElementById('uploadArea');
    const photoInput = document.getElementById('photoInput') as HTMLInputElement;

    uploadBtn?.addEventListener('click', () => {
      uploadModal?.classList.add('show');
    });

    closeUploadModal?.addEventListener('click', () => {
      this.closeUploadModal();
    });

    uploadModal?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeUploadModal();
      }
    });

    // Drag and drop
    uploadArea?.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });

    uploadArea?.addEventListener('dragleave', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
    });

    uploadArea?.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer?.files || []).filter(file => 
        file.type.startsWith('image/'));
      if (files.length > 0) {
        this.uploadPhotos(files);
      }
    });

    // File input
    photoInput?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      const files = Array.from(target.files || []);
      if (files.length > 0) {
        this.uploadPhotos(files);
      }
    });
  }

  async loadPhotos(page: number = 1, search: string = ''): Promise<void> {
    if (this.isLoading) return;
    
    this.isLoading = true;
    this.showLoading(true);

    try {
      const params: Record<string, string | number> = { page, limit: 20 };
      if (search) params.search = search;

      const response = await window.photoAPI.getPhotos(params);
      this.photos = response.photos;
      this.filteredPhotos = this.photos; // Initially show all photos
      this.renderPhotos();
      
      // Update map with new photos
      if (this.photoMap) {
        this.photoMap.setPhotos(this.photos);
        this.updateMapInfo(this.photos.filter(p => p.latitude && p.longitude).length);
      }
    } catch (error) {
      showToast(`Failed to load photos: ${(error as Error).message}`, 'error');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }

  private renderPhotos(): void {
    const grid = document.getElementById('photosGrid');
    if (!grid) return;
    
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
        <img src="${window.photoAPI.getFileUrl(photo.thumbnail_path || photo.file_path)}" 
             alt="${photo.original_name}" 
             loading="lazy">
        <div class="photo-card-info">
          <h4 title="${photo.original_name}">${truncateText(photo.original_name, 25)}</h4>
          <p>
            <i class="fas fa-calendar"></i>
            ${formatDate(photo.uploaded_at)}
          </p>
          ${photo.width && photo.height ? 
            `<p><i class="fas fa-expand-arrows-alt"></i> ${photo.width}x${photo.height}</p>` : ''}
        </div>
      </div>
    `).join('');

    // Add click handlers
    grid.querySelectorAll('.photo-card').forEach(card => {
      card.addEventListener('click', () => {
        const photoId = (card as HTMLElement).dataset.photoId;
        if (photoId) {
          this.openPhotoModal(parseInt(photoId));
        }
      });
    });
  }

  private async uploadPhotos(files: File[]): Promise<void> {
    const uploadProgress = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    if (uploadProgress) uploadProgress.style.display = 'block';
    if (progressFill) (progressFill as HTMLElement).style.width = '0%';
    if (progressText) progressText.textContent = 'Uploading...';

    try {
      const response = await window.photoAPI.uploadPhotos(files, (progress: number) => {
        if (progressFill) (progressFill as HTMLElement).style.width = `${progress}%`;
        if (progressText) progressText.textContent = `Uploading... ${Math.round(progress)}%`;
      });

      showToast(`Successfully uploaded ${response.photos.length} photos`, 'success');
      this.closeUploadModal();
      this.loadPhotos(); // Reload photos
    } catch (error) {
      showToast(`Upload failed: ${(error as Error).message}`, 'error');
    } finally {
      if (uploadProgress) uploadProgress.style.display = 'none';
    }
  }

  private closeUploadModal(): void {
    const uploadModal = document.getElementById('uploadModal');
    const photoInput = document.getElementById('photoInput') as HTMLInputElement;
    const uploadProgress = document.getElementById('uploadProgress');
    
    uploadModal?.classList.remove('show');
    if (photoInput) photoInput.value = '';
    if (uploadProgress) uploadProgress.style.display = 'none';
  }

  private async openPhotoModal(photoId: number): Promise<void> {
    try {
      const photo = await window.photoAPI.getPhoto(photoId);
      this.currentPhoto = photo;
      
      const modal = document.getElementById('photoModal');
      const modalPhoto = document.getElementById('modalPhoto') as HTMLImageElement;
      const photoTitle = document.getElementById('photoTitle');
      const photoMetadata = document.getElementById('photoMetadata');

      if (photoTitle) photoTitle.textContent = photo.original_name;
      if (modalPhoto) {
        modalPhoto.src = window.photoAPI.getFileUrl(photo.file_path);
        modalPhoto.alt = photo.original_name;
      }

      // Display metadata
      const metadata = photo.metadata || {};
      if (photoMetadata) {
        photoMetadata.innerHTML = `
          <h5><i class="fas fa-info-circle"></i> Photo Information</h5>
          <div style="display: grid; gap: 0.5rem; margin-top: 1rem;">
            <div><strong>File:</strong> ${photo.original_name}</div>
            <div><strong>Size:</strong> ${formatFileSize(photo.file_size)}</div>
            <div><strong>Dimensions:</strong> ${photo.width}x${photo.height}</div>
            <div><strong>Type:</strong> ${photo.mime_type}</div>
            <div><strong>Uploaded:</strong> ${formatDate(photo.uploaded_at)}</div>
            ${metadata.format ? `<div><strong>Format:</strong> ${metadata.format}</div>` : ''}
            ${metadata.density ? `<div><strong>Density:</strong> ${metadata.density} DPI</div>` : ''}
          </div>
        `;
      }

      modal?.classList.add('show');
    } catch (error) {
      showToast(`Failed to load photo: ${(error as Error).message}`, 'error');
    }
  }

  private closePhotoModal(): void {
    const modal = document.getElementById('photoModal');
    modal?.classList.remove('show');
    this.currentPhoto = null;
  }

  private async shareCurrentPhoto(): Promise<void> {
    if (!this.currentPhoto) return;

    const email = prompt('Enter email address to share with:');
    if (!email) return;

    try {
      await window.photoAPI.createShare('photo', this.currentPhoto.id, email);
      showToast('Photo shared successfully!', 'success');
    } catch (error) {
      showToast(`Failed to share photo: ${(error as Error).message}`, 'error');
    }
  }

  private async deleteCurrentPhoto(): Promise<void> {
    if (!this.currentPhoto) return;

    if (!confirm(`Are you sure you want to delete "${this.currentPhoto.original_name}"?`)) {
      return;
    }

    try {
      await window.photoAPI.deletePhoto(this.currentPhoto.id);
      showToast('Photo deleted successfully', 'success');
      this.closePhotoModal();
      this.loadPhotos(); // Reload photos
    } catch (error) {
      showToast(`Failed to delete photo: ${(error as Error).message}`, 'error');
    }
  }

  private showLoading(show: boolean): void {
    const loading = document.getElementById('photosLoading');
    if (loading) {
      loading.style.display = show ? 'block' : 'none';
    }
  }

  clearPhotos(): void {
    this.photos = [];
    this.renderPhotos();
  }
}