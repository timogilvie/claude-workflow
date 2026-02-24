# Deploy to wavemill.org

This site is intentionally simple: markdown pages in `docs/` published as a static site.

## Option A: GitHub Pages + Route 53 (recommended)

### 1) Enable GitHub Pages

In the GitHub repository settings:

1. Open `Settings -> Pages`
2. Under Build and deployment, set:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/docs`
3. Save and wait for the first Pages build.

### 2) Set Custom Domain

Add `wavemill.org` as the custom domain in GitHub Pages settings.

This repo includes `docs/CNAME` with:

```txt
wavemill.org
```

### 3) Configure DNS in Route 53

Use your hosted zone for `wavemill.org` and create records:

- Root domain `wavemill.org`:
  - Type: `A`
  - Values:
    - `185.199.108.153`
    - `185.199.109.153`
    - `185.199.110.153`
    - `185.199.111.153`

- Optional `www.wavemill.org`:
  - Type: `CNAME`
  - Value: `<your-github-username>.github.io`

If `www` is used, configure redirect behavior in GitHub Pages or Route 53 according to your preference.

### 4) Wait for Propagation and TLS

- DNS propagation usually completes within minutes but can take longer.
- GitHub Pages provisions HTTPS automatically after domain verification.
- Verify:
  - `https://wavemill.org`
  - `https://www.wavemill.org` (if configured)

## Option B: Static Export to AWS Hosting

You can also host the same `docs/` content on S3 + CloudFront if you prefer AWS-native hosting.

## Post-Deploy Checklist

- Homepage loads at `wavemill.org`
- Navigation links resolve
- Command snippets render correctly
- HTTPS is valid and no browser warnings appear
