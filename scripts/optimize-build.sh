#!/bin/bash

# Build Optimization Script for DevOps Portfolio Website
# This script optimizes CSS and JavaScript files for production deployment

echo "Starting build optimization..."

# Create build directory
mkdir -p build
mkdir -p build/css
mkdir -p build/js

# Copy HTML
echo "Copying HTML files..."
cp index.html build/

# Copy and optimize CSS
echo "Optimizing CSS files..."
# Note: Install cssnano for CSS minification: npm install -g cssnano-cli
# For now, just copy the files (minification to be added)
cp css/main.css build/css/
cp css/components.css build/css/
cp css/responsive.css build/css/

# Copy and optimize JavaScript
echo "Optimizing JavaScript files..."
# Note: Install terser for JS minification: npm install -g terser
# For now, just copy the files (minification to be added)
cp js/main.js build/js/
cp js/navigation.js build/js/
cp js/animations.js build/js/

# Copy assets
echo "Copying assets..."
cp -r images build/
cp -r assets build/

echo "Build optimization complete!"
echo "Optimized files are in the 'build' directory"
echo ""
echo "Next steps for production:"
echo "1. Install minification tools: npm install -g cssnano-cli terser"
echo "2. Minify CSS: cssnano build/css/main.css build/css/main.min.css"
echo "3. Minify JS: terser build/js/main.js -o build/js/main.min.js"
echo "4. Update HTML to reference .min files"
echo "5. Enable gzip compression on your web server"
