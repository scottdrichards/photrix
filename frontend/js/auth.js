// Authentication module
class Auth {
    constructor() {
        this.currentUser = null;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.checkAuthStatus();
    }

    setupEventListeners() {
        // Tab switching
        document.querySelectorAll('.auth-tabs .tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                this.switchTab(tab);
            });
        });

        // Form submissions
        document.getElementById('loginFormData').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });

        document.getElementById('registerFormData').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRegister();
        });

        // User menu
        document.getElementById('userMenuBtn').addEventListener('click', () => {
            this.toggleUserMenu();
        });

        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.logout();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.user-menu')) {
                this.closeUserMenu();
            }
        });
    }

    switchTab(tab) {
        // Update tab buttons
        document.querySelectorAll('.auth-tabs .tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

        // Update forms
        document.querySelectorAll('.auth-tab').forEach(form => {
            form.classList.remove('active');
        });
        document.getElementById(`${tab}FormData`).classList.add('active');
    }

    async handleLogin() {
        const username = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;

        if (!username || !password) {
            showToast('Please fill in all fields', 'error');
            return;
        }

        try {
            showToast('Logging in...', 'info');
            const response = await photoAPI.login(username, password);
            
            photoAPI.setToken(response.token);
            this.currentUser = response.user;
            this.showMainApp();
            
            showToast(`Welcome back, ${response.user.username}!`, 'success');
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    async handleRegister() {
        const username = document.getElementById('registerUsername').value;
        const email = document.getElementById('registerEmail').value;
        const password = document.getElementById('registerPassword').value;

        if (!username || !email || !password) {
            showToast('Please fill in all fields', 'error');
            return;
        }

        if (password.length < 6) {
            showToast('Password must be at least 6 characters long', 'error');
            return;
        }

        try {
            showToast('Creating account...', 'info');
            const response = await photoAPI.register(username, email, password);
            
            photoAPI.setToken(response.token);
            this.currentUser = response.user;
            this.showMainApp();
            
            showToast(`Welcome to Photrix, ${response.user.username}!`, 'success');
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    checkAuthStatus() {
        const token = localStorage.getItem('photrix_token');
        if (token) {
            // Verify token is still valid by making a health check
            this.verifyToken();
        } else {
            this.showLoginForm();
        }
    }

    async verifyToken() {
        try {
            await photoAPI.healthCheck();
            // If we get here, token is valid
            this.showMainApp();
            // Load user info if needed
            if (!this.currentUser) {
                // You could decode JWT to get user info or make an API call
                this.currentUser = { username: 'User' }; // Simplified for demo
            }
        } catch (error) {
            console.log('Token verification failed:', error);
            this.logout();
        }
    }

    showLoginForm() {
        document.getElementById('loginForm').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'none';
        document.getElementById('header').style.display = 'none';
    }

    showMainApp() {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('mainContent').style.display = 'block';
        document.getElementById('header').style.display = 'block';
        
        // Update username in header
        if (this.currentUser) {
            document.getElementById('username').textContent = this.currentUser.username;
        }

        // Load initial data
        if (window.photosManager) {
            window.photosManager.loadPhotos();
        }
        if (window.albumsManager) {
            window.albumsManager.loadAlbums();
        }
        if (window.sharingManager) {
            window.sharingManager.loadSharedContent();
        }
    }

    toggleUserMenu() {
        const dropdown = document.getElementById('userDropdown');
        dropdown.classList.toggle('show');
    }

    closeUserMenu() {
        const dropdown = document.getElementById('userDropdown');
        dropdown.classList.remove('show');
    }

    logout() {
        photoAPI.setToken(null);
        this.currentUser = null;
        this.showLoginForm();
        showToast('Logged out successfully', 'success');
        
        // Clear any cached data
        if (window.photosManager) {
            window.photosManager.clearPhotos();
        }
        if (window.albumsManager) {
            window.albumsManager.clearAlbums();
        }
        if (window.sharingManager) {
            window.sharingManager.clearSharedContent();
        }
    }
}

// Initialize auth when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.auth = new Auth();
});