# Image Optimization Guide

This document outlines the image optimization standards for the DevOps Portfolio Website.

## Image Format Guidelines

### Profile Images
- **Primary Format**: WebP
- **Fallback Format**: JPEG
- **Max Dimensions**: 800x800px
- **Compression Quality**: 80-85%
- **Target File Size**: < 100KB
- **Implementation**: Use `<picture>` element with WebP source and JPEG fallback

### Project Screenshots
- **Primary Format**: WebP
- **Fallback Format**: JPEG or PNG (depending on content)
- **Max Dimensions**: 1200x800px
- **Compression Quality**: 75-80%
- **Target File Size**: < 150KB per image

### Icons
- **Primary Format**: SVG (preferred for scalability)
- **Alternative Format**: PNG
- **Max Dimensions**: 64x64px (for PNG)
- **Target File Size**: < 5KB per icon
- **Recommendation**: Use inline SVG when possible for better performance

## Optimization Tools

### Command Line Tools
```bash
# Convert JPEG to WebP
cwebp -q 80 input.jpg -o output.webp

# Optimize JPEG
jpegoptim --max=85 --strip-all input.jpg

# Optimize PNG
optipng -o7 input.png

# Batch convert images to WebP
for file in *.jpg; do cwebp -q 80 "$file" -o "${file%.jpg}.webp"; done
```

### Online Tools
- [Squoosh](https://squoosh.app/) - Google's image compression tool
- [TinyPNG](https://tinypng.com/) - PNG and JPEG compression
- [SVGOMG](https://jakearchibald.github.io/svgomg/) - SVG optimization

## HTML Implementation

### Using Picture Element for WebP Support
```html
<picture>
  <source srcset="image.webp" type="image/webp">
  <img src="image.jpg" alt="Descriptive alt text" loading="lazy">
</picture>
```

### Responsive Images
```html
<img 
  srcset="image-320w.webp 320w,
          image-640w.webp 640w,
          image-1024w.webp 1024w"
  sizes="(max-width: 640px) 100vw,
         (max-width: 1024px) 50vw,
         33vw"
  src="image-640w.jpg"
  alt="Descriptive alt text"
  loading="lazy">
```

## Alt Text Best Practices

### Good Alt Text Examples
- ✅ "Professional headshot of DevOps Engineer"
- ✅ "Screenshot of CI/CD pipeline dashboard showing deployment status"
- ✅ "Kubernetes cluster architecture diagram"

### Poor Alt Text Examples
- ❌ "Image"
- ❌ "Picture1"
- ❌ "Screenshot"

### Alt Text Guidelines
1. Be descriptive and specific
2. Keep it concise (under 125 characters when possible)
3. Don't include "image of" or "picture of" (screen readers announce this)
4. For decorative images, use empty alt text: `alt=""`
5. For complex diagrams, consider using `aria-describedby` for longer descriptions

## Performance Checklist

- [ ] All images are compressed and optimized
- [ ] WebP format is used with appropriate fallbacks
- [ ] Images have explicit width and height attributes
- [ ] All images have descriptive alt text
- [ ] Lazy loading is enabled for below-the-fold images
- [ ] Large images are served in multiple sizes (responsive images)
- [ ] Icons use SVG format when possible
- [ ] No images exceed recommended file size limits

## Current Image Inventory

### Profile Images
- `images/profile/headshot.jpg` - Professional headshot (needs optimization)
- `images/profile/headshot.webp` - WebP version (to be created)

### Project Images
- To be added as projects are documented

### Icons
- To be added for social media and technology stack

## Validation Requirements (Requirement 7.1)

All images must meet these criteria:
1. Optimized for web delivery with appropriate compression
2. Use modern formats (WebP) with fallbacks
3. Include descriptive alt text for accessibility
4. Have explicit dimensions to prevent layout shift
5. Use lazy loading for performance
