import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://spannora.dev",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
    // Inline all CSS regardless of size. Site is small (~6 pages, ~5KB CSS);
    // inlining maximizes LCP / Core Web Vitals on every direct landing.
    inlineStylesheets: "always",
  },
  integrations: [mdx(), sitemap()],
});
