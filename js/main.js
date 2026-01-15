/**
 * Main JavaScript Module
 * Handles DOM initialization and global functionality
 */

// Global application state
const App = {
    isInitialized: false,
    isMobileMenuOpen: false,
    
    // Initialize the application
    init() {
        if (this.isInitialized) return;
        
        try {
            console.log('Initializing DevOps Portfolio Website...');
            
            // Wait for DOM to be fully loaded
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setupApp());
            } else {
                this.setupApp();
            }
            
        } catch (error) {
            console.error('Error initializing application:', error);
            this.handleError(error);
        }
    },
    
    // Set up the application after DOM is ready
    setupApp() {
        try {
            // Initialize core functionality
            this.setupGlobalEventListeners();
            this.setupErrorHandling();
            this.setupAccessibility();
            
            // Initialize modules
            if (typeof Navigation !== 'undefined') {
                Navigation.init();
            }
            
            if (typeof Animations !== 'undefined') {
                Animations.init();
            }
            
            this.isInitialized = true;
            console.log('Application initialized successfully');
            
        } catch (error) {
            console.error('Error setting up application:', error);
            this.handleError(error);
        }
    },
    
    // Set up global event listeners
    setupGlobalEventListeners() {
        // Handle window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.handleResize();
            }, 250);
        });
        
        // Handle scroll events
        let scrollTimeout;
        window.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.handleScroll();
            }, 16); // ~60fps
        });
        
        // Handle keyboard navigation
        document.addEventListener('keydown', (e) => {
            this.handleKeydown(e);
        });
        
        // Handle clicks outside mobile menu
        document.addEventListener('click', (e) => {
            this.handleDocumentClick(e);
        });
    },
    
    // Set up error handling
    setupErrorHandling() {
        window.addEventListener('error', (e) => {
            console.error('Global error:', e.error);
            this.handleError(e.error);
        });
        
        window.addEventListener('unhandledrejection', (e) => {
            console.error('Unhandled promise rejection:', e.reason);
            this.handleError(e.reason);
        });
    },
    
    // Set up accessibility features
    setupAccessibility() {
        // Add skip link functionality
        const skipLink = document.querySelector('.skip-link');
        if (skipLink) {
            skipLink.addEventListener('click', (e) => {
                e.preventDefault();
                const target = document.querySelector(skipLink.getAttribute('href'));
                if (target) {
                    target.focus();
                    target.scrollIntoView({ behavior: 'smooth' });
                }
            });
        }
        
        // Ensure proper focus management
        this.setupFocusManagement();
    },
    
    // Handle window resize
    handleResize() {
        // Close mobile menu on resize to desktop
        if (window.innerWidth >= 768 && this.isMobileMenuOpen) {
            if (typeof Navigation !== 'undefined') {
                Navigation.closeMobileMenu();
            }
        }
        
        // Emit custom resize event for other modules
        window.dispatchEvent(new CustomEvent('app:resize', {
            detail: {
                width: window.innerWidth,
                height: window.innerHeight
            }
        }));
    },
    
    // Handle scroll events
    handleScroll() {
        const scrollY = window.scrollY;
        
        // Update header appearance based on scroll
        const header = document.querySelector('.header');
        if (header) {
            if (scrollY > 100) {
                header.classList.add('scrolled');
            } else {
                header.classList.remove('scrolled');
            }
        }
        
        // Show/hide back to top button
        const backToTop = document.querySelector('.back-to-top');
        if (backToTop) {
            if (scrollY > 500) {
                backToTop.style.opacity = '1';
                backToTop.style.visibility = 'visible';
            } else {
                backToTop.style.opacity = '0';
                backToTop.style.visibility = 'hidden';
            }
        }
        
        // Emit custom scroll event for other modules
        window.dispatchEvent(new CustomEvent('app:scroll', {
            detail: { scrollY }
        }));
    },
    
    // Handle keyboard navigation
    handleKeydown(e) {
        // Close mobile menu on Escape key
        if (e.key === 'Escape' && this.isMobileMenuOpen) {
            if (typeof Navigation !== 'undefined') {
                Navigation.closeMobileMenu();
            }
        }
        
        // Handle tab navigation
        if (e.key === 'Tab') {
            this.handleTabNavigation(e);
        }
    },
    
    // Handle document clicks
    handleDocumentClick(e) {
        // Close mobile menu when clicking outside
        const navMenu = document.querySelector('.nav-menu');
        const navToggle = document.querySelector('.nav-toggle');
        
        if (this.isMobileMenuOpen && navMenu && navToggle) {
            if (!navMenu.contains(e.target) && !navToggle.contains(e.target)) {
                if (typeof Navigation !== 'undefined') {
                    Navigation.closeMobileMenu();
                }
            }
        }
    },
    
    // Handle tab navigation for accessibility
    handleTabNavigation(e) {
        // Trap focus in mobile menu when open
        if (this.isMobileMenuOpen) {
            const navMenu = document.querySelector('.nav-menu');
            if (navMenu) {
                const focusableElements = navMenu.querySelectorAll(
                    'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
                );
                
                if (focusableElements.length > 0) {
                    const firstElement = focusableElements[0];
                    const lastElement = focusableElements[focusableElements.length - 1];
                    
                    if (e.shiftKey && document.activeElement === firstElement) {
                        e.preventDefault();
                        lastElement.focus();
                    } else if (!e.shiftKey && document.activeElement === lastElement) {
                        e.preventDefault();
                        firstElement.focus();
                    }
                }
            }
        }
    },
    
    // Set up focus management
    setupFocusManagement() {
        // Add focus-visible polyfill behavior
        document.addEventListener('mousedown', () => {
            document.body.classList.add('using-mouse');
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                document.body.classList.remove('using-mouse');
            }
        });
    },
    
    // Handle errors gracefully
    handleError(error) {
        // Log error for debugging
        console.error('Application error:', error);
        
        // In production, you might want to send errors to a logging service
        // For now, we'll just ensure the app continues to function
        
        // Show user-friendly error message if needed
        if (error && error.message && error.message.includes('critical')) {
            this.showErrorMessage('Something went wrong. Please refresh the page.');
        }
    },
    
    // Show error message to user
    showErrorMessage(message) {
        // Create or update error message element
        let errorElement = document.querySelector('.app-error-message');
        
        if (!errorElement) {
            errorElement = document.createElement('div');
            errorElement.className = 'app-error-message alert alert-error';
            errorElement.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 9999;
                max-width: 300px;
                padding: 1rem;
                background-color: #fee2e2;
                border: 1px solid #fca5a5;
                border-radius: 0.5rem;
                color: #991b1b;
            `;
            document.body.appendChild(errorElement);
        }
        
        errorElement.textContent = message;
        errorElement.style.display = 'block';
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            if (errorElement) {
                errorElement.style.display = 'none';
            }
        }, 5000);
    },
    
    // Utility functions
    utils: {
        // Debounce function
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },
        
        // Throttle function
        throttle(func, limit) {
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
        },
        
        // Check if element is in viewport
        isInViewport(element) {
            const rect = element.getBoundingClientRect();
            return (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
        },
        
        // Smooth scroll to element
        scrollToElement(element, offset = 0) {
            if (!element) return;
            
            const elementPosition = element.getBoundingClientRect().top + window.pageYOffset;
            const offsetPosition = elementPosition - offset;
            
            window.scrollTo({
                top: offsetPosition,
                behavior: 'smooth'
            });
        }
    }
};

// Initialize the application
App.init();

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = App;
}