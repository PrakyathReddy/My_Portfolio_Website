# Deployment Optimization Guide

This guide covers the steps to optimize the DevOps Portfolio Website for production deployment.

## Quick Start

```bash
# Run the optimization script
./scripts/optimize-build.sh

# This creates an optimized build in the 'build' directory
```

## Manual Optimization Steps

### 1. CSS Minification

Install cssnano:
```bash
npm install -g cssnano-cli
```

Minify CSS files:
```bash
cssnano css/main.css css/main.min.css
cssnano css/components.css css/components.min.css
cssnano css/responsive.css css/responsive.min.css
```

### 2. JavaScript Minification

Install terser:
```bash
npm install -g terser
```

Minify JavaScript files:
```bash
terser js/main.js -o js/main.min.js -c -m
terser js/navigation.js -o js/navigation.min.js -c -m
terser js/animations.js -o js/animations.min.js -c -m
```

### 3. Update HTML References

Update `index.html` to use minified files:
```html
<!-- CSS Files -->
<link rel="stylesheet" href="css/main.min.css">
<link rel="stylesheet" href="css/components.min.css">
<link rel="stylesheet" href="css/responsive.min.css">

<!-- JavaScript Files -->
<script src="js/main.min.js"></script>
<script src="js/navigation.min.js"></script>
<script src="js/animations.min.js"></script>
```

### 4. Image Optimization

Optimize images before deployment:
```bash
# Install optimization tools
npm install -g imagemin-cli

# Optimize JPEG images
imagemin images/**/*.jpg --out-dir=images --plugin=mozjpeg

# Optimize PNG images
imagemin images/**/*.png --out-dir=images --plugin=pngquant

# Convert to WebP
for file in images/**/*.jpg; do
  cwebp -q 80 "$file" -o "${file%.jpg}.webp"
done
```

## AWS S3 Deployment

### S3 Bucket Configuration

1. Create S3 bucket:
```bash
aws s3 mb s3://your-portfolio-bucket-name
```

2. Enable static website hosting:
```bash
aws s3 website s3://your-portfolio-bucket-name \
  --index-document index.html \
  --error-document index.html
```

3. Set bucket policy for public access:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-portfolio-bucket-name/*"
    }
  ]
}
```

### Upload Files with Optimization

Upload with proper cache headers and compression:
```bash
# Upload HTML (no cache)
aws s3 cp index.html s3://your-portfolio-bucket-name/ \
  --content-type "text/html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --metadata-directive REPLACE

# Upload CSS (1 year cache)
aws s3 cp css/ s3://your-portfolio-bucket-name/css/ \
  --recursive \
  --content-type "text/css" \
  --cache-control "public, max-age=31536000" \
  --content-encoding "gzip"

# Upload JavaScript (1 year cache)
aws s3 cp js/ s3://your-portfolio-bucket-name/js/ \
  --recursive \
  --content-type "application/javascript" \
  --cache-control "public, max-age=31536000" \
  --content-encoding "gzip"

# Upload images (1 year cache)
aws s3 cp images/ s3://your-portfolio-bucket-name/images/ \
  --recursive \
  --cache-control "public, max-age=31536000"

# Upload assets (1 year cache)
aws s3 cp assets/ s3://your-portfolio-bucket-name/assets/ \
  --recursive \
  --cache-control "public, max-age=31536000"
```

### CloudFront CDN (Optional but Recommended)

1. Create CloudFront distribution:
```bash
aws cloudfront create-distribution \
  --origin-domain-name your-portfolio-bucket-name.s3.amazonaws.com \
  --default-root-object index.html
```

2. Enable gzip compression in CloudFront
3. Set up custom domain with Route 53
4. Enable HTTPS with ACM certificate

## Performance Checklist

- [ ] CSS files are minified
- [ ] JavaScript files are minified
- [ ] Images are optimized and compressed
- [ ] WebP format is used with fallbacks
- [ ] Gzip/Brotli compression is enabled
- [ ] Cache headers are properly set
- [ ] CDN is configured (CloudFront)
- [ ] HTTPS is enabled
- [ ] Lighthouse score > 90

## File Size Targets

### Before Optimization
- Total CSS: ~35KB
- Total JS: ~25KB
- Total HTML: ~8KB

### After Optimization (Minified + Gzipped)
- Total CSS: < 8KB
- Total JS: < 6KB
- Total HTML: < 3KB
- **Total Page Weight**: < 20KB (excluding images)

## Validation

Run Lighthouse audit:
```bash
# Install Lighthouse
npm install -g lighthouse

# Run audit
lighthouse https://your-portfolio-url.com --view
```

Target scores:
- Performance: > 90
- Accessibility: > 95
- Best Practices: > 90
- SEO: > 90

## Continuous Deployment

### GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:
```yaml
name: Deploy to S3

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Optimize files
        run: |
          npm install -g cssnano-cli terser
          ./scripts/optimize-build.sh
      
      - name: Deploy to S3
        uses: jakejarvis/s3-sync-action@master
        with:
          args: --acl public-read --follow-symlinks --delete
        env:
          AWS_S3_BUCKET: ${{ secrets.AWS_S3_BUCKET }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: 'us-east-1'
          SOURCE_DIR: 'build'
```

## Monitoring

### Performance Monitoring Tools
- Google Analytics for traffic
- CloudWatch for S3/CloudFront metrics
- Lighthouse CI for continuous performance monitoring
- WebPageTest for detailed performance analysis

### Cost Monitoring
- Set up AWS billing alerts
- Monitor S3 storage costs
- Monitor CloudFront data transfer costs
- Typical cost: $1-5/month for low-traffic portfolio site

## Troubleshooting

### Common Issues

1. **Files not updating**: Clear CloudFront cache
```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

2. **CORS errors**: Add CORS configuration to S3 bucket
3. **404 errors**: Check bucket policy and index document settings
4. **Slow load times**: Verify gzip compression and CDN configuration

## Security Best Practices

- [ ] Enable S3 bucket encryption
- [ ] Use CloudFront with HTTPS only
- [ ] Set up WAF rules for CloudFront
- [ ] Enable CloudFront access logging
- [ ] Regularly update dependencies
- [ ] Use IAM roles with least privilege
- [ ] Enable MFA for AWS account

## Maintenance Schedule

- **Weekly**: Check Lighthouse scores
- **Monthly**: Review CloudWatch metrics
- **Quarterly**: Update dependencies and review costs
- **Annually**: Review and optimize content
