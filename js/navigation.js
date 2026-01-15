/**
 * Navigation Module
 * Handles navigation functionality, smooth scrolling, and mobile menu
 */

const Navigation = {
    // Navigation elements
    elements: {
        header: null,
        navToggle: null,
        navMenu: null,
        navLinks: null,
        backToTop: null
    },
    
    // Navigation state
    state: {
        isInitialized: false,
        isMobileMenuOpen: false,
        activeSection: null,
        scrollOffset: 80 // Height of fixed header
    },
    
    // Initialize navigation
    init() {
        if (this.state.isInitialized) return;
        
        try {
            this.cacheElements();
            this.setupEventListeners();
            this.setupSmoothScrolling();
            this.setupActiveNavigation();
            this.setupBackToTop();
            
            this.state.isInitialized = true;
            console.log('Navigation module initialized');
            
        } catch (error) {
            console.error('Error initializing navigation:', error);
        }
    },
    
    // Cache DOM elements
    cacheElements() {
        this.elements.header = document.querySelector('.header');
        this.elements.navToggle = document.querySelector('.nav-toggle');
        this.elements.navMenu = document.querySelector('.nav-menu');
        this.elements.navLinks = document.querySelectorAll('.nav-link');
        this.elements.backToTop = document.querySelector('.back-to-top');
        
        // Validate required elements
        if (!this.elements.navToggle || !this.elements.navMenu) {
            throw new Error('Required navigation elements not found');
        }
    },
    
    // Set up event listeners
    setupEventListeners() {
        // Mobile menu toggle
        this.elements.navToggle.addEventListener('click', (e) => {
            e.preventDefault();
            this.toggleMobileMenu();
        });
        
        // Navigation links
        this.elements.navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                this.handleNavLinkClick(e, link);
            });
        });
        
        // Back to top button
        if (this.elements.backToTop) {
            this.elements.backToTop.addEventListener('click', (e) => {
                e.preventDefault();
                this.scrollToTop();
            });
        }
        
        // Listen for scroll events to update active navigation
        window.addEventListener('scroll', this.throttle(() => {
            this.updateActiveNavigation();
        }, 100));
        
        // Listen for resize events
        window.addEventListener('resize', this.debounce(() => {
            this.handleResize();
        }, 250));
    },
    
    // Set up smooth scrolling for navigation links
    setupSmoothScrolling() {
        this.elements.navLinks.forEach(link => {
            const href = link.getAttribute('href');
            
            // Only handle internal anchor links
            if (href && href.startsWith('#')) {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.smoothScrollToSection(href);
                    
                    // Close mobile menu after navigation
                    if (this.state.isMobileMenuOpen) {
                        this.closeMobileMenu();
                    }
                });
            }
        });
    },
    
    // Set up active navigation highlighting
    setupActiveNavigation() {
        // Get all sections that have corresponding navigation links
        this.sections = Array.from(this.elements.navLinks)
            .map(link => {
                const href = link.getAttribute('href');
                if (href && href.startsWith('#')) {
                    const section = document.querySelector(href);
                    return section ? { element: section, id: href.substring(1), link } : null;
                }
                return null;
            })
            .filter(Boolean);
        
        // Initial active navigation update
        this.updateActiveNavigation();
    },
    
    // Set up back to top functionality
    setupBackToTop() {
        if (!this.elements.backToTop) return;
        
        // Initially hide the button
        this.elements.backToTop.style.opacity = '0';
        this.elements.backToTop.style.visibility = 'hidden';
        this.elements.backToTop.style.transition = 'opacity 0.3s ease, visibility 0.3s ease';
    },
    
    // Handle navigation link clicks
    handleNavLinkClick(e, link) {
        const href = link.getAttribute('href');
        
        // Handle external links
        if (href && !href.startsWith('#')) {
            // External links should open in new tab (handled by HTML attributes)
            return;
        }
        
        // Handle internal anchor links
        if (href && href.startsWith('#')) {
            e.preventDefault();
            this.smoothScrollToSection(href);
            
            // Close mobile menu
            if (this.state.isMobileMenuOpen) {
                this.closeMobileMenu();
            }
        }
    },
    
    // Toggle mobile menu
    toggleMobileMenu() {
        if (this.state.isMobileMenuOpen) {
            this.closeMobileMenu();
        } else {
            this.openMobileMenu();
        }
    },
    
    // Open mobile menu
    openMobileMenu() {
        this.elements.navMenu.classList.add('active');
        this.elements.navToggle.classList.add('active');
        this.elements.navToggle.setAttribute('aria-expanded', 'true');
        
        this.state.isMobileMenuOpen = true;
        
        // Update global app state
        if (typeof App !== 'undefined') {
            App.isMobileMenuOpen = true;
        }
        
        // Prevent body scroll on mobile
        document.body.style.overflow = 'hidden';
        
        // Focus first menu item for accessibility
        const firstLink = this.elements.navMenu.querySelector('.nav-link');
        if (firstLink) {
            setTimeout(() => firstLink.focus(), 100);
        }
    },
    
    // Close mobile menu
    closeMobileMenu() {
        this.elements.navMenu.classList.remove('active');
        this.elements.navToggle.classList.remove('active');
        this.elements.navToggle.setAttribute('aria-expanded', 'false');
        
        this.state.isMobileMenuOpen = false;
        
        // Update global app state
        if (typeof App !== 'undefined') {
            App.isMobileMenuOpen = false;
        }
        
        // Restore body scroll
        document.body.style.overflow = '';
    },
    
    // Smooth scroll to section
    smoothScrollToSection(sectionId) {
        const target = document.querySelector(sectionId);
        if (!target) return;
        
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset;
        const offsetPosition = targetPosition - this.state.scrollOffset;
        
        window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
        });
    },
    
    // Scroll to top
    scrollToTop() {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    },
    
    // Update active navigation based on scroll position
    updateActiveNavigation() {
        if (!this.sections || this.sections.length === 0) return;
        
        const scrollPosition = window.scrollY + this.state.scrollOffset + 50;
        let activeSection = null;
        
        // Find the current section
        for (let i = this.sections.length - 1; i >= 0; i--) {
            const section = this.sections[i];
            const sectionTop = section.element.getBoundingClientRect().top + window.pageYOffset;
            
            if (scrollPosition >= sectionTop) {
                activeSection = section;
                break;
            }
        }
        
        // Update active state if changed
        if (activeSection && activeSection !== this.state.activeSection) {
            this.setActiveNavigation(activeSection);
        }
        
        // Handle case when at top of page
        if (window.scrollY < 100) {
            this.clearActiveNavigation();
        }
    },
    
    // Set active navigation item
    setActiveNavigation(section) {
        // Remove active class from all links
        this.elements.navLinks.forEach(link => {
            link.classList.remove('active');
        });
        
        // Add active class to current section link
        if (section && section.link) {
            section.link.classList.add('active');
        }
        
        this.state.activeSection = section;
    },
    
    // Clear active navigation
    clearActiveNavigation() {
        this.elements.navLinks.forEach(link => {
            link.classList.remove('active');
        });
        this.state.activeSection = null;
    },
    
    // Handle window resize
    handleResize() {
        // Close mobile menu on resize to desktop
        if (window.innerWidth >= 768 && this.state.isMobileMenuOpen) {
            this.closeMobileMenu();
        }
    },
    
    // Utility functions
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
    
    // Public API methods
    navigateToSection(sectionId) {
        if (sectionId.startsWith('#')) {
            this.smoothScrollToSection(sectionId);
        } else {
            this.smoothScrollToSection(`#${sectionId}`);
        }
    },
    
    getCurrentSection() {
        return this.state.activeSection;
    },
    
    isMobileMenuOpen() {
        return this.state.isMobileMenuOpen;
    }
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Navigation.init());
} else {
    Navigation.init();
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Navigation;
}