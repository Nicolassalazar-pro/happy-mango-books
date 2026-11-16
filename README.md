# Happy Mango Books

A static, book-first website for **Ready to Eat: The Guide to Baby's First Foods**.

Public demo: https://nicolassalazar-pro.github.io/happy-mango-books/

The demo combines the selected paper-stage layout with one animated hero book, photo-derived page samples, an About-page mockup, reader stories, and a general/bulk inquiry page. The two supplied reader photographs are approved for publication and included as metadata-cleared derivatives.

## Structure

- `site/` - the entire publishable website: HTML, CSS, JavaScript, images and licensed fonts.
- `tests/site.mjs` - browser, accessibility, responsive-layout and asset-delivery checks.
- `tests/requirements.json` - public-safe content and interaction expectations.
- `scripts/preview.py` - allowlisted loopback preview; raw client folders are never served.
- `.github/workflows/pages.yml` - deploys only `site/` when website changes reach `main`.

The local `client-materials/`, `archive/` and `.cache/` folders are deliberately excluded from Git. Original client documents, review screenshots, abandoned designs and development evidence must never be published.

## Local use

There is no build step or server-side runtime. The review carousel uses a pinned, self-hosted Embla Carousel 8.6.0 bundle; it does not load a CDN or contact a third party. From the project folder:

```powershell
npm start
```

Open http://127.0.0.1:64972/. The normal preview serves the same static images as the public demo and needs no private media manifest. It never serves raw client folders. The Contact form can submit to FormSubmit; other pages retain the preview's no-connection policy.

For browser checks, install the development dependencies and Chromium once:

```powershell
npm ci
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache\playwright'
node .\node_modules\playwright\cli.js install chromium
npm test
```

The checks serve the site beneath `/happy-mango-books/` to verify GitHub project-page URLs and approved photo delivery, then close their own server. They do not run against the public demo or use a private photo overlay. Every FormSubmit request is intercepted by a test fixture; automated checks never send real email.

## Inquiry delivery

General and bulk inquiries go to `info@happymangobooks.com` through FormSubmit. JavaScript uses the documented AJAX endpoint; without JavaScript, the native form hands off to FormSubmit. Provider CAPTCHA defaults remain enabled, and a honeypot is included.

The receiving inbox must confirm FormSubmit's one-time activation email before delivery is enabled. Provider acceptance is not proof of mailbox delivery. A pending request cannot be submitted twice, and an uncertain response is never retried automatically; entered text remains available and the direct email link provides a fallback. The website does not save entries to local/session storage; FormSubmit processes the submitted data.

## Publishing

GitHub Pages uses the pinned GitHub Actions workflow. Updates to `site/` on `main` deploy automatically; only that directory is uploaded. Publication requires explicit user approval.

The pages remain `noindex,nofollow`. Amazon is not configured. Inquiry routing is configured, with receiving-inbox activation required as described above. Publication permission was confirmed for the two reader photos already supplied; future additions need their own confirmation. Raw originals and conversation screenshots remain private. The recovered book-page samples have honest missing-photo corners, not generated replacement artwork.

Book artwork, branding and reader quotations are not offered under an open-source license. Included font licenses are in `site/assets/fonts/`.

Embla Carousel is MIT-licensed. Its unchanged release bundle and license are included in `site\assets\js\vendor`; the matching package version is pinned in the development dependencies for reproducibility.

The review cards use an original layered renderer over that pinned engine's input and loop coordinates, not its default horizontal layout. Cards stay level while moving through the foreground/background. Keep the 8.6.0 bundle and renderer in sync when upgrading. Quotes remain semantic HTML; without the engine, the same cards form a readable static list. The labeled demo scores are visual placeholders, not verified reviewer ratings.
