import { defineConfig } from "vitepress";

// Deployed to GitHub Pages under /<repo>/; the demo app is copied to /<repo>/demo/ (scripts/build-site.mjs).
const base = process.env.SITE_BASE ?? "/";

export default defineConfig({
  base,
  title: "Optiq",
  description: "Browser-side image optimisation for uploads: the smallest output that meets a measured quality constraint.",
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ["**/node_modules/**"],
  head: [
    ["meta", { name: "theme-color", content: "#3355ff" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }],
    ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: `${base}favicon-32.png` }],
    ["link", { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png` }],
  ],
  vite: {
    // Local docs dev: point the embedded demo at a running `pnpm demo` with DEMO_URL=http://localhost:5173/
    define: { __DEMO_URL__: JSON.stringify(process.env.DEMO_URL ?? "") },
  },
  themeConfig: {
    nav: [
      { text: "Try the demo", link: "/try" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API", link: "/api/" },
      { text: "Benchmarks", link: "/benchmarks" },
      { text: "Architecture", link: "/architecture" },
    ],
    sidebar: {
      "/": [
        {
          text: "Guide",
          items: [
            { text: "Try the demo", link: "/try" },
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Modes and quality", link: "/guide/modes" },
            { text: "Options and results", link: "/guide/options" },
            { text: "Formats, metadata, colour", link: "/guide/formats" },
            { text: "Errors, cancellation, fallbacks", link: "/guide/errors" },
            { text: "Bundlers and deployment", link: "/guide/bundlers" },
            { text: "Uploading to S3", link: "/guide/s3" },
            { text: "Limitations and FAQ", link: "/guide/faq" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "API: optiq-image", link: "/api/" },
            { text: "API: optiq-image/upload", link: "/api/upload" },
            { text: "API: optiq-image/node", link: "/api/node" },
            { text: "Benchmarks", link: "/benchmarks" },
            { text: "Audit", link: "/audit" },
            { text: "Architecture", link: "/architecture" },
          ],
        },
      ],
    },
    // <img> cannot inherit currentColor, so ship explicit light/dark variants.
    logo: { light: "/logo-black.svg", dark: "/logo-white.svg", alt: "Optiq" },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/Baukaalm/optiq" }],
    editLink: { pattern: "https://github.com/Baukaalm/optiq/edit/main/docs/:path", text: "Edit this page on GitHub" },
    outline: { level: [2, 3] },
    footer: {
      message: 'Apache-2.0 · <a href="https://github.com/Baukaalm/optiq">GitHub</a> · <a href="https://github.com/Baukaalm/optiq/issues">Issues</a> · codec notices in <a href="https://github.com/Baukaalm/optiq/blob/main/NOTICE">NOTICE</a>',
    },
  },
});
