# Happy Mango Books

A static, book-first website for **Ready to Eat: The Guide to Baby's First Foods**.

Public demo: https://nicolassalazar-pro.github.io/happy-mango-books/

The demo combines the selected paper-stage layout with one animated hero book, photo-derived page samples, an About-page mockup, reader stories, and a non-sending general/bulk inquiry page. Private reader photographs appear only in the local preview; the public demo uses neutral photo slots.

## Structure

- `site/` - the entire publishable website: HTML, CSS, JavaScript, images and licensed fonts.
- `tests/site.mjs` - browser, accessibility, responsive-layout and asset-delivery checks.
- `tests/requirements.json` - public-safe content and interaction expectations.
- `scripts/preview.py` - allowlisted loopback preview; optional private reader photos never enter `site/`.
- `.github/workflows/pages.yml` - deploys only `site/` when website changes reach `main`.

The local `client-materials/`, `archive/` and `.cache/` folders are deliberately excluded from Git. Original client documents, review screenshots, abandoned designs and development evidence must never be published.

## Local use

There is no build step or server-side runtime. The review carousel uses a pinned, self-hosted Embla Carousel 8.6.0 bundle; it does not load a CDN or contact a third party. From the project folder:

```powershell
npm start
```

Open http://127.0.0.1:64972/. The review server reads the private `.cache\hybrid-control\demo-media.json` only when available. Without it, the same pages show neutral reader-photo slots. It never serves raw client folders or sends forms.

For browser checks, install the development dependencies and Chromium once:

```powershell
npm ci
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache\playwright'
node .\node_modules\playwright\cli.js install chromium
npm test
```

The checks serve the site beneath `/happy-mango-books/` to verify GitHub project-page URLs, then close their own server. They do not run against the public demo. For this workspace's photo-enabled review, use `node tests\site.mjs --require-demo-photos`. A checkout without the private media manifest exercises the public placeholder version.

## Publishing

GitHub Pages uses the pinned GitHub Actions workflow. Updates to `site/` on `main` deploy automatically; only that directory is uploaded. Publication requires explicit user approval.

The pages remain `noindex,nofollow`. Amazon and the business inbox are not configured. Contact reviews input locally and explicitly sends or saves nothing. Reader-photo bytes remain private pending renewed publication permission; the static source contains only neutral slots. The recovered book-page samples have honest missing-photo corners, not generated replacement artwork.

Book artwork, branding and reader quotations are not offered under an open-source license. Included font licenses are in `site/assets/fonts/`.

Embla Carousel is MIT-licensed. Its unchanged release bundle and license are included in `site\assets\js\vendor`; the matching package version is pinned in the development dependencies for reproducibility.

The review cards use an original layered renderer over that pinned engine's input and loop coordinates, not its default horizontal layout. Cards stay level while moving through the foreground/background. Keep the 8.6.0 bundle and renderer in sync when upgrading. Quotes remain semantic HTML; without the engine, the same cards form a readable static list. The labeled demo scores are visual placeholders, not verified reviewer ratings.
