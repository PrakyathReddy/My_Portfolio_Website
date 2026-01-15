/**
 * Animations Module
 * Handles scroll-triggered animations, hover effects, and performance-optimized transitions
 */

const Animations = {
    // Animation elements and observers
    elements: {
        animatedElements: [],
        intersectionObserver: null,
        resizeObserver: null
    },
    
    // Animation state
    state: {
        isInitialized: false,
        reducedMotion: false,
        isScrolling: false,
        scrollTimeout: null
    },
    
    // Animation configuration
    config: {
        // Intersection Observer options
        observerOptions: {
            root: null,
            rootMargin: '0px 0px -100px 0px',
            threshold: [0, 0.25, 0.5, 0.75, 1]
        },
        
        // Animation delays and durations
        delays: {
            short: 100,
            medium: 200,
            long: 300
        },
        
        // Easing functions
        easing: {
            easeOut: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            easeInOut: 'cubic-bezier(0.645, 0.045, 0.355, 1)',
            bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)'
        }
    },
    
    // Initialize animations
    init() {
        if (this.state.isInitialized) return;
        
        try {
            this.checkMotionPreferences();
            this.setupIntersectionObserver();
            this.setupScrollAnimations();
            this.setupHoverEffects();
            this.setupLoadAnimations();
            this.setupEventListeners();
            
            this.state.isInitialized = true;
            console.log('Animations module initialized');
            
        } catch (error) {
            console.error('Error initializing animations:', error);
        }
    },
    
    // Check user's motion preferences
    checkMotionPreferences() {
        this.state.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        
        // Listen for changes in motion preferences
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        mediaQuery.addEventListener('change', (e) => {
            this.state.reducedMotion = e.matches;
            this.updateAnimationsForMotionPreference();
        });
    },
    
    // Set up Intersection Observer for scroll animations
    setupIntersectionObserver() {
        if (!('IntersectionObserver' in window)) {
            console.warn('IntersectionObserver not supported, skipping scroll animations');
            return;
        }
        
        this.elements.intersectionObserver = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            this.config.observerOptions
        );
        
        // Find and observe animated elements
        this.findAnimatedElements();
    },
    
    // Find elements that should be animated
    findAnimatedElements() {
        const selectors = [
            '.hero-content',
            '.about-content',
            '.project-card',
            '.contact-content',
            '.section-title',
            '.skill-item',
            '.achievement-item'
        ];
        
        selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach((element, index) => {
                this.prepareElementForAnimation(element, index);
                this.elements.intersectionObserver.observe(element);
            });
        });
    },
    
    // Prepare element for animation
    prepareElementForAnimation(element, index) {
        if (this.state.reducedMotion) return;
        
        // Add animation classes and data attributes
        element.classList.add('animate-on-scroll');
        element.setAttribute('data-animation-delay', index * 100);
        
        // Set initial state
        element.style.opacity = '0';
        element.style.transform = 'translateY(30px)';
        element.style.transition = `opacity 0.6s ${this.config.easing.easeOut}, transform 0.6s ${this.config.easing.easeOut}`;
    },
    
    // Handle intersection observer entries
    handleIntersection(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                this.animateElementIn(entry.target);
            }
        });
    },
    
    // Animate element into view
    animateElementIn(element) {
        if (this.state.reducedMotion) {
            element.style.opacity = '1';
            return;
        }
        
        const delay = parseInt(element.getAttribute('data-animation-delay')) || 0;
        
        setTimeout(() => {
            element.style.opacity = '1';
            element.style.transform = 'translateY(0)';
            element.classList.add('animated-in');
        }, delay);
        
        // Stop observing this element
        this.elements.intersectionObserver.unobserve(element);
    },
    
    // Set up scroll-based animations
    setupScrollAnimations() {
        // Parallax effect for hero section (if motion is allowed)
        if (!this.state.reducedMotion) {
            window.addEventListener('scroll', this.throttle(() => {
                this.handleScrollEffects();
            }, 16)); // ~60fps
        }
    },
    
    // Handle scroll effects
    handleScrollEffects() {
        const scrollY = window.scrollY;
        
        // Parallax effect for hero background
        const hero = document.querySelector('.hero');
        if (hero) {
            const heroHeight = hero.offsetHeight;
            const scrollPercent = Math.min(scrollY / heroHeight, 1);
            
            // Subtle parallax effect
            hero.style.transform = `translateY(${scrollPercent * 20}px)`;
        }
        
        // Header background opacity
        const header = document.querySelector('.header');
        if (header) {
            const opacity = Math.min(scrollY / 100, 0.95);
            header.style.backgroundColor = `rgba(255, 255, 255, ${opacity})`;
        }
    },
    
    // Set up hover effects
    setupHoverEffects() {
        if (this.state.reducedMotion) return;
        
        // Project card hover effects
        const projectCards = document.querySelectorAll('.project-card');
        projectCards.forEach(card => {
            this.setupCardHoverEffect(card);
        });
        
        // Button hover effects
        const buttons = document.querySelectorAll('.btn');
        buttons.forEach(button => {
            this.setupButtonHoverEffect(button);
        });
        
        // Social link hover effects
        const socialLinks = document.querySelectorAll('.social-link');
        socialLinks.forEach(link => {
            this.setupSocialLinkHoverEffect(link);
        });
    },
    
    // Set up project card hover effect
    setupCardHoverEffect(card) {
        card.addEventListener('mouseenter', () => {
            if (!this.state.reducedMotion) {
                card.style.transform = 'translateY(-8px) scale(1.02)';
                card.style.boxShadow = '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)';
            }
        });
        
        card.addEventListener('mouseleave', () => {
            if (!this.state.reducedMotion) {
                card.style.transform = 'translateY(0) scale(1)';
                card.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
            }
        });
    },
    
    // Set up button hover effect
    setupButtonHoverEffect(button) {
        button.addEventListener('mouseenter', () => {
            if (!this.state.reducedMotion) {
                button.style.transform = 'translateY(-2px)';
            }
        });
        
        button.addEventListener('mouseleave', () => {
            if (!this.state.reducedMotion) {
                button.style.transform = 'translateY(0)';
            }
        });
        
        // Add ripple effect on click
        button.addEventListener('click', (e) => {
            if (!this.state.reducedMotion) {
                this.createRippleEffect(e, button);
            }
        });
    },
    
    // Set up social link hover effect
    setupSocialLinkHoverEffect(link) {
        link.addEventListener('mouseenter', () => {
            if (!this.state.reducedMotion) {
                link.style.transform = 'scale(1.05)';
            }
        });
        
        link.addEventListener('mouseleave', () => {
            if (!this.state.reducedMotion) {
                link.style.transform = 'scale(1)';
            }
        });
    },
    
    // Create ripple effect
    createRippleEffect(event, element) {
        const ripple = document.createElement('span');
        const rect = element.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = event.clientX - rect.left - size / 2;
        const y = event.clientY - rect.top - size / 2;
        
        ripple.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            left: ${x}px;
            top: ${y}px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            transform: scale(0);
            animation: ripple 0.6s ease-out;
            pointer-events: none;
        `;
        
        // Add ripple animation keyframes if not already added
        if (!document.querySelector('#ripple-styles')) {
            const style = document.createElement('style');
            style.id = 'ripple-styles';
            style.textContent = `
                @keyframes ripple {
                    to {
                        transform: scale(2);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        element.style.position = 'relative';
        element.style.overflow = 'hidden';
        element.appendChild(ripple);
        
        // Remove ripple after animation
        setTimeout(() => {
            if (ripple.parentNode) {
                ripple.parentNode.removeChild(ripple);
            }
        }, 600);
    },
    
    // Set up load animations
    setupLoadAnimations() {
        if (this.state.reducedMotion) return;
        
        // Animate header on load
        const header = document.querySelector('.header');
        if (header) {
            header.style.transform = 'translateY(-100%)';
            header.style.transition = 'transform 0.6s ease-out';
            
            setTimeout(() => {
                header.style.transform = 'translateY(0)';
            }, 100);
        }
        
        // Stagger animation for navigation items
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach((item, index) => {
            item.style.opacity = '0';
            item.style.transform = 'translateY(-20px)';
            item.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
            
            setTimeout(() => {
                item.style.opacity = '1';
                item.style.transform = 'translateY(0)';
            }, 200 + (index * 100));
        });
    },
    
    // Set up event listeners
    setupEventListeners() {
        // Listen for app events
        window.addEventListener('app:scroll', (e) => {
            this.handleAppScroll(e.detail.scrollY);
        });
        
        window.addEventListener('app:resize', (e) => {
            this.handleAppResize(e.detail);
        });
        
        // Listen for page visibility changes
        document.addEventListener('visibilitychange', () => {
            this.handleVisibilityChange();
        });
    },
    
    // Handle app scroll events
    handleAppScroll(scrollY) {
        // Update scroll-based animations
        if (!this.state.reducedMotion) {
            this.updateScrollAnimations(scrollY);
        }
    },
    
    // Handle app resize events
    handleAppResize(dimensions) {
        // Recalculate animation positions if needed
        this.recalculateAnimations();
    },
    
    // Handle visibility change
    handleVisibilityChange() {
        if (document.hidden) {
            // Pause animations when page is hidden
            this.pauseAnimations();
        } else {
            // Resume animations when page is visible
            this.resumeAnimations();
        }
    },
    
    // Update animations based on motion preferences
    updateAnimationsForMotionPreference() {
        const elements = document.querySelectorAll('.animate-on-scroll');
        
        if (this.state.reducedMotion) {
            // Remove animations for users who prefer reduced motion
            elements.forEach(element => {
                element.style.opacity = '1';
                element.style.transform = 'none';
                element.style.transition = 'none';
            });
        } else {
            // Re-enable animations
            elements.forEach(element => {
                if (!element.classList.contains('animated-in')) {
                    element.style.opacity = '0';
                    element.style.transform = 'translateY(30px)';
                    element.style.transition = `opacity 0.6s ${this.config.easing.easeOut}, transform 0.6s ${this.config.easing.easeOut}`;
                }
            });
        }
    },
    
    // Update scroll-based animations
    updateScrollAnimations(scrollY) {
        // Implement additional scroll-based animations here
        // This is called on scroll events
    },
    
    // Recalculate animations (on resize)
    recalculateAnimations() {
        // Recalculate positions and thresholds if needed
    },
    
    // Pause animations
    pauseAnimations() {
        // Pause CSS animations and transitions when page is hidden
        document.body.style.animationPlayState = 'paused';
    },
    
    // Resume animations
    resumeAnimations() {
        // Resume CSS animations and transitions when page is visible
        document.body.style.animationPlayState = 'running';
    },
    
    // Utility functions
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
    animateElement(element, animation = 'fadeInUp') {
        if (this.state.reducedMotion) return;
        
        element.classList.add('animate-' + animation);
    },
    
    removeAnimation(element) {
        element.classList.remove(...Array.from(element.classList).filter(cls => cls.startsWith('animate-')));
    },
    
    // Cleanup method
    destroy() {
        if (this.elements.intersectionObserver) {
            this.elements.intersectionObserver.disconnect();
        }
        
        if (this.elements.resizeObserver) {
            this.elements.resizeObserver.disconnect();
        }
        
        this.state.isInitialized = false;
    }
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Animations.init());
} else {
    Animations.init();
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Animations;
}