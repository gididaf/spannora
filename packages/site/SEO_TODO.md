# SEO TODO — spannora.dev

Pre-launch checklist before submitting to Google Search Console (and ongoing).
Status as of 2026-05-19 audit.

## Bottom line

On-page SEO is genuinely strong. Brand-new domain + zero backlinks is the
actual ranking limiter, not site quality. Realistic target: long-tail queries
like *"self-hosted Claude Code web UI"* in weeks, **not** broad *"Claude Code"*
(Anthropic owns that).

---

## Must fix before submitting to Search Console

These are pure-code, no-design-needed.

- [x] **Convert OG image to PNG.** `public/og-image.svg` doesn't render reliably
      on Twitter/X, Facebook, LinkedIn, Discord, Slack. Export the SVG to
      `public/og-image.png` at exactly **1200×630**, keep the SVG too, then
      change `BaseLayout.astro:19` default to `/og-image.png`.
      *Single biggest fix — affects every link share from now on.*

- [x] **Noindex the hub.** `/app/` is currently indexable; Google will index
      the PWA shell and dilute topical focus.
      - Add `<meta name="robots" content="noindex">` to `packages/hub/index.html`
      - Add `Disallow: /app/` to `packages/site/public/robots.txt`

- [x] **Block raw `install.sh` from indexing.** Currently allowed; Google may
      index the raw bash file.
      - Add `Disallow: /install.sh` to `packages/site/public/robots.txt`

- [x] **Add a `404.astro` page.** Astro falls back to a default. A branded 404
      with internal links to `/`, `/docs/`, `/docs/install/` keeps crawl budget
      from leaking on broken inbound links.

---

## High-impact follow-ups (week 1)

- [x] **HowTo schema on `/docs/install/`.** Triggers rich-result snippets for
      *"how to install …"* queries. Big win for install-intent traffic.
      Needs a small `DocsLayout.astro` tweak to accept extra JSON-LD via
      frontmatter, then add the `HowTo` block to `install.mdx` frontmatter.

- [x] **`datePublished` + `dateModified` on docs.** Google uses freshness
      signals. Add to `DocsLayout.astro` — either extend `BreadcrumbList` or
      emit a separate `Article` JSON-LD block. Source the dates from
      frontmatter so each MDX file owns its own values.

- [x] **Favicon raster variants.** Only `favicon.svg` exists today. Some SERP
      renderers and iOS want raster.
      - `public/favicon-32x32.png`
      - `public/apple-touch-icon-180x180.png`
      - Declare both in `BaseLayout.astro` `<head>`.

---

## Visuals — biggest dwell-time / SERP-surface lever

All-text pages look thin in 2026. Ordered by ROI:

- [x] **OG image PNG** (covered above — listed here too because it's a visual).

- [x] **Hero screenshot.** Composite desktop + mobile showing Claude
      mid-streaming with a Bash tool card visible. Place in the
      `<slot name="visual">` on `index.astro` Hero (currently just an
      InstallBlock — keep the InstallBlock, add the screenshot beside/below).
      *Done — `public/img/hero.png` (1600×774, 325 KB). Placed as a full-width
      figure section directly under the Hero (desktop + mobile-viewport
      browsers in a single hub-managed composite, with caption naming the
      hub).*

- [ ] **Install demo video/GIF.** ~15s silent screencap: paste curl command →
      setup token banner → login → first chat. Target ≤3 MB if GIF, or MP4 in
      `public/`. Embed on `/docs/install/` before "Customizing the install".
      If MP4, **add `VideoObject` JSON-LD** — this surfaces in Google's video
      carousel for install-intent queries. Single biggest organic lever.

- [ ] **Hub screenshot.** Left rail with 3 colored instance chips + active
      chat. On `/docs/hub/` near "When you'd use the hub".

- [x] **Architecture diagram.** browser/PWA → spannora server → Claude Agent
      SDK → Anthropic API. SVG is fine here (it's content, not OG).
      Place on `/docs/security/` near "The threat model" or on `/docs/` home.
      *Done — SVG at `public/img/architecture.svg`, embedded on `/docs/security/`
      under "The threat model" via `<figure>` with descriptive alt text.*

- [ ] **Mobile "Add to Home Screen" screenshots.** iOS + Android side by side.
      On `/docs/hub/` "Mobile install" section.

### When adding any image

- Always set a real `alt=` (indexed in Google Images = extra SERP surface).
- Use `<img loading="lazy" width="…" height="…">` to avoid CLS.
- For video, prefer self-hosted MP4 + `VideoObject` JSON-LD over YouTube embed
  (no third-party JS, faster LCP).

---

## Already in place (no action needed)

For sanity — don't re-do these:

- Canonical URLs on every page (`BaseLayout.astro:25`)
- Unique title + description per page
- OG + Twitter cards
- JSON-LD: Organization (global), SoftwareApplication + FAQPage + WebSite
  (landing), BreadcrumbList (docs)
- `@astrojs/sitemap` → `/sitemap-index.xml`, referenced from `robots.txt`
- `trailingSlash: "always"` + `build.format: "directory"` (consistent canonicals)
- Inline CSS + zero client JS by default (excellent LCP / Core Web Vitals)
- Semantic HTML — `<h1>` per page, `<article>`, `<nav aria-label>`, skip-link
- Internal cross-linking between docs pages
- `<html lang="en">`, mobile viewport with `viewport-fit=cover`
- `theme-color` for dark mode

---

## After fixing the "Must fix" block

1. Run the Google **Rich Results Test** on `https://spannora.dev/` and each
   `/docs/*` page — confirm all JSON-LD parses without warnings.
2. Run **PageSpeed Insights** — should be 95+ on every page (no client JS,
   inlined CSS).
3. Add the property to Search Console (DNS TXT verification via Cloudflare —
   see CLAUDE.md "DNS + GitHub Pages" section for the shtum-wrapped curl
   pattern; look up the zone id on demand rather than hardcoding it).
4. Submit the sitemap: `https://spannora.dev/sitemap-index.xml`.
5. Request indexing on the landing page and `/docs/install/`.
