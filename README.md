# Happy Mango Books

A static, book-first website for **Ready to Eat: The Guide to Baby's First Foods**.

GitHub Pages: https://nicolassalazar-pro.github.io/happy-mango-books/

## Structure

- `site/` - the entire publishable website: HTML, CSS, JavaScript, images and licensed fonts.
- `tests/site.mjs` - browser, accessibility, responsive-layout and asset-delivery checks.
- `.github/workflows/pages.yml` - deploys only `site/` when website changes reach `main`.

The local `client-materials/`, `archive/` and `.cache/` folders are deliberately excluded from Git. Original client documents, review screenshots, abandoned designs and development evidence must never be published.

## Local use

There is no build step or runtime dependency. From the project folder:

```powershell
python -m http.server 64971 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:64971/.

For browser checks, install the development dependencies and Chromium once:

```powershell
npm ci
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache\playwright'
node .\node_modules\playwright\cli.js install chromium
npm test
```

The checks serve the site beneath `/happy-mango-books/` to verify GitHub project-page URLs. Set `SITE_URL` to the published URL to run the same checks against the deployed files.

## Publishing

GitHub Pages uses the repository's GitHub Actions workflow. Updates to `site/` on `main` deploy automatically; the workflow can also be run manually. Only that directory is uploaded.

The page remains `noindex,nofollow` for review sharing. Checkout, booking and contact actions are intentionally absent until real destinations are supplied.

Book artwork, branding and reader quotations are not offered under an open-source license. Included font licenses are in `site/assets/fonts/`.
