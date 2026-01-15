/**
 * Property-based test for external link behavior
 * Feature: devops-portfolio-website, Property 1: External Link Behavior
 * Validates: Requirements 2.3
 * 
 * Property: For any external link in the portfolio website, 
 * it should open in a new tab to preserve the user's session on the main site.
 */

const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

describe('Property Test: External Link Behavior', () => {
  let htmlContent;

  beforeAll(() => {
    const htmlPath = path.join(__dirname, '../index.html');
    htmlContent = fs.readFileSync(htmlPath, 'utf8');
    
    // Set up DOM in jsdom environment
    document.documentElement.innerHTML = htmlContent;
  });

  /**
   * Property 1: External Link Behavior
   * For any external link in the portfolio website, it should open in a new tab
   * to preserve the user's session on the main site.
   */
  test('all external links should have target="_blank" and rel="noopener noreferrer"', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...getAllExternalLinks()),
        (link) => {
          // Each external link must have target="_blank"
          const hasTargetBlank = link.getAttribute('target') === '_blank';
          
          // Each external link must have rel="noopener noreferrer" for security
          const relAttribute = link.getAttribute('rel');
          const hasNoopenerNoreferrer = relAttribute && 
            relAttribute.includes('noopener') && 
            relAttribute.includes('noreferrer');
          
          return hasTargetBlank && hasNoopenerNoreferrer;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Helper function to identify and extract all external links from the document
   * External links are defined as:
   * - Links with target="_blank" attribute
   * - Links pointing to external domains (http://, https://)
   * - Links to downloadable files (PDF, etc.)
   */
  function getAllExternalLinks() {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    
    // Filter for external links based on common patterns
    const externalLinks = allLinks.filter(link => {
      const href = link.getAttribute('href');
      
      // Links with target="_blank" are considered external
      if (link.getAttribute('target') === '_blank') {
        return true;
      }
      
      // Links starting with http:// or https:// (not internal anchors)
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        return true;
      }
      
      // Links to downloadable files
      if (href && (href.endsWith('.pdf') || href.endsWith('.doc') || href.endsWith('.docx'))) {
        return true;
      }
      
      return false;
    });
    
    // Ensure we have at least one external link to test
    if (externalLinks.length === 0) {
      throw new Error('No external links found in the HTML document');
    }
    
    return externalLinks;
  }
});
