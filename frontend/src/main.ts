import { PhotoAPI } from './api.js';
import { Auth } from './auth.js';
import { PhotosManager } from './photos.js';
import { AlbumsManager } from './albums.js';
import { SharingManager } from './sharing.js';
import { ImageProcessor, PerformanceOptimizer } from './utils.js';

// Main application controller
export class App {
  constructor() {
    this.init();
  }

  private init(): void {
    this.setupNavigation();
    this.setupEventListeners();
    this.initializeGlobalInstances();
  }

  private initializeGlobalInstances(): void {
    // Initialize global API instance
    window.photoAPI = new PhotoAPI();
    
    // Initialize managers
    window.auth = new Auth();
    window.photosManager = new PhotosManager();
    window.albumsManager = new AlbumsManager();
    window.sharingManager = new SharingManager();
    
    // Initialize utility classes
    window.imageProcessor = ImageProcessor;
    window.performanceOptimizer = PerformanceOptimizer;
  }

  private setupNavigation(): void {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = (btn as HTMLElement).dataset.section;
        if (section) {
          this.navigateToSection(section);
        }
      });
    });
  }

  private setupEventListeners(): void {
    // Close modals on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeAllModals();
      }
    });

    // Handle responsive navigation
    window.addEventListener('resize', () => {
      this.handleResize();
    });
  }

  navigateToSection(section: string): void {
    // Update navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeBtn = document.querySelector(`[data-section="${section}"]`);
    activeBtn?.classList.add('active');

    // Update content sections
    document.querySelectorAll('.content-section').forEach(sec => {
      sec.classList.remove('active');
    });
    const activeSection = document.getElementById(`${section}Section`);
    activeSection?.classList.add('active');

    // Load section-specific data
    switch (section) {
      case 'photos':
        if (window.photosManager) {
          window.photosManager.loadPhotos();
        }
        break;
      case 'albums':
        if (window.albumsManager) {
          window.albumsManager.loadAlbums();
        }
        break;
      case 'shared':
        if (window.sharingManager) {
          window.sharingManager.loadSharedContent();
        }
        break;
    }
  }

  private closeAllModals(): void {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.classList.remove('show');
    });
  }

  private handleResize(): void {
    // Handle responsive behavior if needed
    const width = window.innerWidth;
    
    if (width < 768) {
      // Mobile view adjustments
      document.body.classList.add('mobile');
    } else {
      document.body.classList.remove('mobile');
    }
  }
}

// Service Worker registration for offline support
if ('serviceWorker' in navigator && 'caches' in window) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => {
        console.log('ServiceWorker registration successful');
      })
      .catch(() => {
        console.log('ServiceWorker registration failed');
      });
  });
}

// Initialize application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  
  // Initialize performance optimizations
  PerformanceOptimizer.lazyLoad();
  
  // Add CSS animation for slide out toasts
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideOut {
      to {
        transform: translateX(100%);
        opacity: 0;
      }
    }
    
    .btn-sm {
      padding: 0.375rem 0.75rem;
      font-size: 0.875rem;
    }
    
    .mobile .photos-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    
    .mobile .albums-grid {
      grid-template-columns: 1fr;
    }
  `;
  document.head.appendChild(style);
});

// Global error handler
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  // Note: showToast would need to be imported or made global
});

// Handle offline/online status
window.addEventListener('online', () => {
  // Note: showToast would need to be imported or made global
});

window.addEventListener('offline', () => {
  // Note: showToast would need to be imported or made global
});