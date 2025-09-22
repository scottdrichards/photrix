// Main application controller
class App {
    constructor() {
        this.currentSection = 'photos';
        this.init();
    }

    init() {
        this.setupNavigation();
        this.setupEventListeners();
    }

    setupNavigation() {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.navigateToSection(btn.dataset.section);
            });
        });
    }

    setupEventListeners() {
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

    navigateToSection(section) {
        // Update navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-section="${section}"]`).classList.add('active');

        // Update content sections
        document.querySelectorAll('.content-section').forEach(sec => {
            sec.classList.remove('active');
        });
        document.getElementById(`${section}Section`).classList.add('active');

        this.currentSection = section;

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

    closeAllModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('show');
        });
    }

    handleResize() {
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

// Toast notification system
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'check-circle' :
                type === 'error' ? 'exclamation-circle' :
                type === 'warning' ? 'exclamation-triangle' :
                'info-circle';

    toast.innerHTML = `
        <i class="fas fa-${icon}"></i>
        <span>${message}</span>
    `;

    container.appendChild(toast);

    // Auto remove after duration
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => {
                if (toast.parentNode) {
                    container.removeChild(toast);
                }
            }, 300);
        }
    }, duration);

    // Add click to dismiss
    toast.addEventListener('click', () => {
        if (toast.parentNode) {
            container.removeChild(toast);
        }
    });
}

// Utility functions for client-side image processing
class ImageProcessor {
    static async generateThumbnail(file, maxWidth = 300, maxHeight = 300, quality = 0.8) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
                // Calculate new dimensions
                let { width, height } = img;
                
                if (width > height) {
                    if (width > maxWidth) {
                        height = (height * maxWidth) / width;
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = (width * maxHeight) / height;
                        height = maxHeight;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                // Draw and compress
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(resolve, 'image/jpeg', quality);
            };

            img.src = URL.createObjectURL(file);
        });
    }

    static async extractMetadata(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const metadata = {
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                    fileSize: file.size,
                    fileName: file.name,
                    fileType: file.type,
                    lastModified: new Date(file.lastModified).toISOString()
                };
                resolve(metadata);
            };
            img.src = URL.createObjectURL(file);
        });
    }

    static async resizeImage(file, maxWidth, maxHeight, quality = 0.9) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
                let { width, height } = img;

                // Calculate new dimensions maintaining aspect ratio
                const aspectRatio = width / height;
                
                if (width > maxWidth || height > maxHeight) {
                    if (aspectRatio > 1) {
                        // Landscape
                        width = Math.min(width, maxWidth);
                        height = width / aspectRatio;
                    } else {
                        // Portrait
                        height = Math.min(height, maxHeight);
                        width = height * aspectRatio;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                
                canvas.toBlob(resolve, 'image/jpeg', quality);
            };

            img.src = URL.createObjectURL(file);
        });
    }
}

// Performance optimization utilities
class PerformanceOptimizer {
    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    static throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    static lazyLoad() {
        const images = document.querySelectorAll('img[loading="lazy"]');
        
        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.classList.remove('lazy');
                        imageObserver.unobserve(img);
                    }
                });
            });

            images.forEach(img => imageObserver.observe(img));
        }
    }
}

// Service Worker registration for offline support
if ('serviceWorker' in navigator && 'caches' in window) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then((registration) => {
                console.log('ServiceWorker registration successful');
            })
            .catch((error) => {
                console.log('ServiceWorker registration failed');
            });
    });
}

// Initialize application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    window.imageProcessor = ImageProcessor;
    window.performanceOptimizer = PerformanceOptimizer;
    
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
    showToast('An unexpected error occurred', 'error');
});

// Handle offline/online status
window.addEventListener('online', () => {
    showToast('Back online!', 'success');
});

window.addEventListener('offline', () => {
    showToast('You are offline. Some features may not work.', 'warning', 8000);
});