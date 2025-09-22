// Sharing management module
class SharingManager {
    constructor() {
        this.receivedShares = [];
        this.createdShares = [];
        this.currentTab = 'received';
        this.init();
    }

    init() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Tab switching
        document.querySelectorAll('.shared-tabs .tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });
    }

    switchTab(tab) {
        this.currentTab = tab;
        
        // Update tab buttons
        document.querySelectorAll('.shared-tabs .tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

        // Update content
        document.querySelectorAll('.shared-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`shared${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');

        // Load appropriate data
        if (tab === 'received') {
            this.renderReceivedShares();
        } else {
            this.renderCreatedShares();
        }
    }

    async loadSharedContent() {
        try {
            const [receivedResponse, createdResponse] = await Promise.all([
                photoAPI.getReceivedShares(),
                photoAPI.getCreatedShares()
            ]);

            this.receivedShares = receivedResponse.shares;
            this.createdShares = createdResponse.shares;

            if (this.currentTab === 'received') {
                this.renderReceivedShares();
            } else {
                this.renderCreatedShares();
            }
        } catch (error) {
            showToast(`Failed to load shared content: ${error.message}`, 'error');
        }
    }

    renderReceivedShares() {
        const container = document.getElementById('sharedReceived');
        
        if (this.receivedShares.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: rgba(255,255,255,0.7);">
                    <i class="fas fa-share" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                    <p>No content has been shared with you yet</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.receivedShares.map(share => `
            <div class="shared-item">
                <div style="display: flex; align-items: center; gap: 1rem;">
                    ${share.thumbnail_path ? 
                        `<img src="${photoAPI.getFileUrl(share.thumbnail_path)}" 
                             style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px;" 
                             alt="${share.resource_name}">` :
                        `<div style="width: 60px; height: 60px; background: rgba(255,255,255,0.2); border-radius: 4px; display: flex; align-items: center; justify-content: center;">
                            <i class="fas fa-${share.resource_type === 'photo' ? 'image' : 'folder'}"></i>
                        </div>`
                    }
                    <div style="flex: 1;">
                        <h4 style="margin-bottom: 0.5rem;">
                            <i class="fas fa-${share.resource_type === 'photo' ? 'image' : 'folder'}"></i>
                            ${share.resource_name || `${share.resource_type} #${share.resource_id}`}
                        </h4>
                        <p style="margin-bottom: 0.25rem; opacity: 0.8;">
                            Shared by: ${share.owner_username}
                        </p>
                        <p style="font-size: 0.875rem; opacity: 0.7;">
                            <i class="fas fa-calendar"></i>
                            ${this.formatDate(share.created_at)}
                            <span style="margin-left: 1rem;">
                                <i class="fas fa-key"></i>
                                ${share.permissions}
                            </span>
                            ${share.expires_at ? 
                                `<span style="margin-left: 1rem;">
                                    <i class="fas fa-clock"></i>
                                    Expires: ${this.formatDate(share.expires_at)}
                                </span>` : ''
                            }
                        </p>
                    </div>
                    <button class="btn btn-secondary btn-sm view-shared" data-share-id="${share.id}">
                        <i class="fas fa-eye"></i> View
                    </button>
                </div>
            </div>
        `).join('');

        // Add event listeners
        container.querySelectorAll('.view-shared').forEach(btn => {
            btn.addEventListener('click', () => {
                this.viewSharedResource(btn.dataset.shareId);
            });
        });
    }

    renderCreatedShares() {
        const container = document.getElementById('sharedCreated');
        
        if (this.createdShares.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: rgba(255,255,255,0.7);">
                    <i class="fas fa-share" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                    <p>You haven't shared any content yet</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.createdShares.map(share => `
            <div class="shared-item">
                <div style="display: flex; align-items: center; gap: 1rem;">
                    <div style="width: 60px; height: 60px; background: rgba(255,255,255,0.2); border-radius: 4px; display: flex; align-items: center; justify-content: center;">
                        <i class="fas fa-${share.resource_type === 'photo' ? 'image' : 'folder'}"></i>
                    </div>
                    <div style="flex: 1;">
                        <h4 style="margin-bottom: 0.5rem;">
                            <i class="fas fa-${share.resource_type === 'photo' ? 'image' : 'folder'}"></i>
                            ${share.resource_name || `${share.resource_type} #${share.resource_id}`}
                        </h4>
                        <p style="margin-bottom: 0.25rem; opacity: 0.8;">
                            Shared with: ${share.shared_with_email}
                        </p>
                        <p style="font-size: 0.875rem; opacity: 0.7;">
                            <i class="fas fa-calendar"></i>
                            ${this.formatDate(share.created_at)}
                            <span style="margin-left: 1rem;">
                                <i class="fas fa-key"></i>
                                ${share.permissions}
                            </span>
                            ${share.expires_at ? 
                                `<span style="margin-left: 1rem;">
                                    <i class="fas fa-clock"></i>
                                    Expires: ${this.formatDate(share.expires_at)}
                                </span>` : ''
                            }
                        </p>
                    </div>
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-secondary btn-sm view-shared" data-share-id="${share.id}">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button class="btn btn-danger btn-sm delete-share" data-share-id="${share.id}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        // Add event listeners
        container.querySelectorAll('.view-shared').forEach(btn => {
            btn.addEventListener('click', () => {
                this.viewSharedResource(btn.dataset.shareId);
            });
        });

        container.querySelectorAll('.delete-share').forEach(btn => {
            btn.addEventListener('click', () => {
                this.deleteShare(btn.dataset.shareId);
            });
        });
    }

    async viewSharedResource(shareId) {
        try {
            const response = await photoAPI.getSharedResource(shareId);
            this.showSharedResourceModal(response);
        } catch (error) {
            showToast(`Failed to load shared resource: ${error.message}`, 'error');
        }
    }

    showSharedResourceModal(shareData) {
        // Create shared resource modal if it doesn't exist
        let modal = document.getElementById('sharedResourceModal');
        if (!modal) {
            modal = this.createSharedResourceModal();
        }

        const modalTitle = modal.querySelector('.modal-title');
        const modalBody = modal.querySelector('.shared-resource-body');
        const { share_info, resource } = shareData;

        if (share_info.resource_type === 'photo') {
            modalTitle.textContent = resource.original_name;
            modalBody.innerHTML = `
                <div style="text-align: center; margin-bottom: 1rem;">
                    <img src="${photoAPI.getFileUrl(resource.file_path)}" 
                         alt="${resource.original_name}"
                         style="max-width: 100%; max-height: 60vh; object-fit: contain;">
                </div>
                <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
                    <h5><i class="fas fa-info-circle"></i> Photo Information</h5>
                    <div style="display: grid; gap: 0.5rem; margin-top: 1rem; font-size: 0.875rem;">
                        <div><strong>File:</strong> ${resource.original_name}</div>
                        <div><strong>Size:</strong> ${this.formatFileSize(resource.file_size)}</div>
                        <div><strong>Dimensions:</strong> ${resource.width}x${resource.height}</div>
                        <div><strong>Shared by:</strong> ${share_info.owner_username || 'Unknown'}</div>
                        <div><strong>Permissions:</strong> ${share_info.permissions}</div>
                    </div>
                </div>
            `;
        } else if (share_info.resource_type === 'album') {
            modalTitle.textContent = resource.name;
            modalBody.innerHTML = `
                <div style="margin-bottom: 1rem;">
                    <p style="color: #666; font-style: italic;">
                        ${resource.description || 'No description'}
                    </p>
                </div>
                <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                    <div style="display: grid; gap: 0.5rem; font-size: 0.875rem;">
                        <div><strong>Photos:</strong> ${resource.photos ? resource.photos.length : 0}</div>
                        <div><strong>Shared by:</strong> ${share_info.owner_username || 'Unknown'}</div>
                        <div><strong>Permissions:</strong> ${share_info.permissions}</div>
                    </div>
                </div>
                ${resource.photos && resource.photos.length > 0 ? `
                    <div class="shared-album-photos" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem;">
                        ${resource.photos.map(photo => `
                            <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                <img src="${photoAPI.getFileUrl(photo.thumbnail_path || photo.file_path)}" 
                                     alt="${photo.original_name}"
                                     style="width: 100%; height: 120px; object-fit: cover;">
                                <div style="padding: 0.5rem; font-size: 0.75rem;">
                                    <div title="${photo.original_name}">${this.truncateText(photo.original_name, 20)}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                ` : `
                    <div style="text-align: center; padding: 2rem; color: #666;">
                        <i class="fas fa-images" style="font-size: 2rem; margin-bottom: 1rem; display: block;"></i>
                        <p>This album is empty</p>
                    </div>
                `}
            `;
        }

        modal.classList.add('show');
    }

    createSharedResourceModal() {
        const modal = document.createElement('div');
        modal.id = 'sharedResourceModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 80vw;">
                <div class="modal-header">
                    <h3 class="modal-title">Shared Resource</h3>
                    <button class="close-btn" onclick="this.closest('.modal').classList.remove('show')">&times;</button>
                </div>
                <div class="modal-body shared-resource-body">
                    <!-- Shared resource content will be loaded here -->
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

    async deleteShare(shareId) {
        if (!confirm('Are you sure you want to stop sharing this item?')) {
            return;
        }

        try {
            await photoAPI.deleteShare(shareId);
            showToast('Share removed successfully', 'success');
            this.loadSharedContent();
        } catch (error) {
            showToast(`Failed to remove share: ${error.message}`, 'error');
        }
    }

    clearSharedContent() {
        this.receivedShares = [];
        this.createdShares = [];
        this.renderReceivedShares();
        this.renderCreatedShares();
    }

    // Utility methods
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

    truncateText(text, length) {
        return text.length > length ? text.substring(0, length) + '...' : text;
    }
}

// Initialize sharing manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.sharingManager = new SharingManager();
});