# AWS Static Website Hosting

This is a static website hosted on AWS with a custom domain name, HTTPS security and Global Content Delivery. 

This project leverages:
1. S3 buckets for hosting
2. GitHub Actions to push changes to S3 everytime a commit is made and pushed
3. Amazon CloudFront for Global Distribution
4. Amazon Route53 for DNS management
5. AWS Certificate Manager (ACM) for securing my site with SSL/TLS, and 
6. AWS Web Application Firewall (WAF) to protect against common web exploits

- Original CloudFront URL after setting up the distribution: https://d2tavlqvuofhhp.cloudfront.net/

## Security features
- Disabled public access of S3 endpoint which uses http endpoint. Disabled static website hosting. Switched from S3 Website Endpoint to S3 Bucket REST Endpoint using Origin Access Control (OAC)

- Purchased prakyath.dev domain from namecheap.com and configured to use AWS Hosted Zone
- Requested SSL Certificate on Certificate Manager (ACM)
- prakyath.dev successfully configured. https://d2tavlqvuofhhp.cloudfront.net/ now redirects to my custom domain - prakyath.dev

## Add on's
- Add a feature to track the number of visitors to my site