import type { User } from './types.js';
import { showToast } from './utils.js';

// Authentication module
export class Auth {
  private currentUser: User | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.setupEventListeners();
    this.checkAuthStatus();
  }

  private setupEventListeners(): void {
    // Tab switching
    document.querySelectorAll('.auth-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab;
        if (tab) {
          this.switchTab(tab);
        }
      });
    });

    // Form submissions
    const loginForm = document.getElementById('loginFormData') as HTMLFormElement;
    loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    const registerForm = document.getElementById('registerFormData') as HTMLFormElement;
    registerForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleRegister();
    });

    // User menu
    const userMenuBtn = document.getElementById('userMenuBtn');
    userMenuBtn?.addEventListener('click', () => {
      this.toggleUserMenu();
    });

    const logoutBtn = document.getElementById('logoutBtn');
    logoutBtn?.addEventListener('click', () => {
      this.logout();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!(e.target as Element)?.closest('.user-menu')) {
        this.closeUserMenu();
      }
    });
  }

  private switchTab(tab: string): void {
    // Update tab buttons
    document.querySelectorAll('.auth-tabs .tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeTab = document.querySelector(`[data-tab="${tab}"]`);
    activeTab?.classList.add('active');

    // Update forms
    document.querySelectorAll('.auth-tab').forEach(form => {
      form.classList.remove('active');
    });
    const activeForm = document.getElementById(`${tab}FormData`);
    activeForm?.classList.add('active');
  }

  private async handleLogin(): Promise<void> {
    const usernameInput = document.getElementById('loginUsername') as HTMLInputElement;
    const passwordInput = document.getElementById('loginPassword') as HTMLInputElement;
    
    const username = usernameInput?.value;
    const password = passwordInput?.value;

    if (!username || !password) {
      showToast('Please fill in all fields', 'error');
      return;
    }

    try {
      showToast('Logging in...', 'info');
      const response = await window.photoAPI.login(username, password);
      
      window.photoAPI.setToken(response.token);
      this.currentUser = response.user;
      this.showMainApp();
      
      showToast(`Welcome back, ${response.user.username}!`, 'success');
    } catch (error) {
      showToast((error as Error).message, 'error');
    }
  }

  private async handleRegister(): Promise<void> {
    const usernameInput = document.getElementById('registerUsername') as HTMLInputElement;
    const emailInput = document.getElementById('registerEmail') as HTMLInputElement;
    const passwordInput = document.getElementById('registerPassword') as HTMLInputElement;
    
    const username = usernameInput?.value;
    const email = emailInput?.value;
    const password = passwordInput?.value;

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
      const response = await window.photoAPI.register(username, email, password);
      
      window.photoAPI.setToken(response.token);
      this.currentUser = response.user;
      this.showMainApp();
      
      showToast(`Welcome to Photrix, ${response.user.username}!`, 'success');
    } catch (error) {
      showToast((error as Error).message, 'error');
    }
  }

  private checkAuthStatus(): void {
    const token = localStorage.getItem('photrix_token');
    if (token) {
      // Verify token is still valid by making a health check
      this.verifyToken();
    } else {
      this.showLoginForm();
    }
  }

  private async verifyToken(): Promise<void> {
    try {
      await window.photoAPI.healthCheck();
      // If we get here, token is valid
      this.showMainApp();
      // Load user info if needed
      if (!this.currentUser) {
        // You could decode JWT to get user info or make an API call
        this.currentUser = { id: 0, username: 'User', email: '' }; // Simplified for demo
      }
    } catch (error) {
      console.log('Token verification failed:', error);
      this.logout();
    }
  }

  private showLoginForm(): void {
    const loginForm = document.getElementById('loginForm');
    const mainContent = document.getElementById('mainContent');
    const header = document.getElementById('header');
    
    if (loginForm) loginForm.style.display = 'flex';
    if (mainContent) mainContent.style.display = 'none';
    if (header) header.style.display = 'none';
  }

  private showMainApp(): void {
    const loginForm = document.getElementById('loginForm');
    const mainContent = document.getElementById('mainContent');
    const header = document.getElementById('header');
    
    if (loginForm) loginForm.style.display = 'none';
    if (mainContent) mainContent.style.display = 'block';
    if (header) header.style.display = 'block';
    
    // Update username in header
    if (this.currentUser) {
      const usernameElement = document.getElementById('username');
      if (usernameElement) {
        usernameElement.textContent = this.currentUser.username;
      }
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

  private toggleUserMenu(): void {
    const dropdown = document.getElementById('userDropdown');
    dropdown?.classList.toggle('show');
  }

  private closeUserMenu(): void {
    const dropdown = document.getElementById('userDropdown');
    dropdown?.classList.remove('show');
  }

  logout(): void {
    window.photoAPI.setToken(null);
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