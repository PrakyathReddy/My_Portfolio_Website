/**
 * Unit tests for project structure
 * Tests that required directories and files exist
 * Verifies HTML5 semantic structure is present
 * Requirements: 4.1, 5.2
 */

const fs = require('fs');
const path = require('path');

describe('Project Structure Tests', () => {
  describe('Required Directories', () => {
    test('should have css directory', () => {
      expect(fs.existsSync(path.join(__dirname, '../css'))).toBe(true);
    });

    test('should have js directory', () => {
      expect(fs.existsSync(path.join(__dirname, '../js'))).toBe(true);
    });

    test('should have images directory', () => {
      expect(fs.existsSync(path.join(__dirname, '../images'))).toBe(true);
    });

    test('should have assets directory', () => {
      expect(fs.existsSync(path.join(__dirname, '../assets'))).toBe(true);
    });

    test('should have images subdirectories', () => {
      expect(fs.existsSync(path.join(__dirname, '../images/profile'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../images/projects'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../images/icons'))).toBe(true);
    });
  });

  describe('Required Files', () => {
    test('should have index.html', () => {
      expect(fs.existsSync(path.join(__dirname, '../index.html'))).toBe(true);
    });

    test('should have CSS files', () => {
      expect(fs.existsSync(path.join(__dirname, '../css/main.css'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../css/components.css'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../css/responsive.css'))).toBe(true);
    });

    test('should have JavaScript files', () => {
      expect(fs.existsSync(path.join(__dirname, '../js/main.js'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../js/navigation.js'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../js/animations.js'))).toBe(true);
    });

    test('should have asset files', () => {
      expect(fs.existsSync(path.join(__dirname, '../assets/favicon.ico'))).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../assets/resume.pdf'))).toBe(true);
    });
  });

  describe('HTML5 Semantic Structure', () => {
    let htmlContent;

    beforeAll(() => {
      const htmlPath = path.join(__dirname, '../index.html');
      htmlContent = fs.readFileSync(htmlPath, 'utf8');
    });

    test('should have DOCTYPE html declaration', () => {
      expect(htmlContent).toMatch(/<!DOCTYPE html>/i);
    });

    test('should have html element with lang attribute', () => {
      expect(htmlContent).toMatch(/<html[^>]*lang="en"[^>]*>/i);
    });

    test('should have proper head section with meta tags', () => {
      expect(htmlContent).toMatch(/<head>/i);
      expect(htmlContent).toMatch(/<meta charset="UTF-8">/i);
      expect(htmlContent).toMatch(/<meta name="viewport"[^>]*>/i);
      expect(htmlContent).toMatch(/<title>/i);
    });

    test('should have semantic header element', () => {
      expect(htmlContent).toMatch(/<header[^>]*>/i);
    });

    test('should have semantic nav element', () => {
      expect(htmlContent).toMatch(/<nav[^>]*>/i);
    });

    test('should have semantic main element', () => {
      expect(htmlContent).toMatch(/<main[^>]*>/i);
    });

    test('should have semantic section elements', () => {
      // Should have multiple section elements for different content areas
      const sectionMatches = htmlContent.match(/<section[^>]*>/gi);
      expect(sectionMatches).not.toBeNull();
      expect(sectionMatches.length).toBeGreaterThanOrEqual(3); // hero, about, projects, contact
    });

    test('should have semantic footer element', () => {
      expect(htmlContent).toMatch(/<footer[^>]*>/i);
    });

    test('should have proper heading hierarchy', () => {
      expect(htmlContent).toMatch(/<h1[^>]*>/i); // Main heading
      expect(htmlContent).toMatch(/<h2[^>]*>/i); // Section headings
    });

    test('should have semantic article elements in projects section', () => {
      expect(htmlContent).toMatch(/<article[^>]*>/i);
    });

    test('should have proper accessibility attributes', () => {
      // Check for aria-label attributes
      expect(htmlContent).toMatch(/aria-label/i);
      // Check for alt attributes on images
      expect(htmlContent).toMatch(/alt="/i);
    });

    test('should have proper external link attributes', () => {
      // External links should have target="_blank" and rel="noopener noreferrer"
      expect(htmlContent).toMatch(/target="_blank"/i);
      expect(htmlContent).toMatch(/rel="noopener noreferrer"/i);
    });
  });
});