# PedalWorks Landing (sitebuild benchmark)

A static landing page for a fictional bike shop. Pure static files -
open `public/index.html` straight from disk, no backend needed.

## Pages and assets

| File | Purpose |
|------|---------|
| `public/index.html` | Landing page: nav, hero, features, pricing, contact |
| `public/styles.css` | Real stylesheet, no frameworks |
| `public/app.js` | Mobile nav toggle + footer year |
| `server/app.js` | Tiny static file server (serves `public/`) |

## Current state

- The server works (`GET /` returns the page).
- `index.html` is a shell: title only, empty `<main>`.
- `styles.css` / `app.js` are one-line stubs.

## Task (benchmark)

Build the landing page so it works opened from disk AND served:

1. `index.html`: nav (with toggle button), `#hero`, `#features` with
   exactly 3 `.feature-card`s, `#pricing` with exactly 3 `.price-tier`s,
   `#contact`. Link `styles.css`, include `app.js` (relative paths only).
2. `styles.css`: real rules (>200 bytes) - layout, cards, tiers, mobile.
3. `app.js`: working `nav-toggle` handler + current year in the footer.

## Verification

```text
node --test test/
```
