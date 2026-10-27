---
title: Try the demo
aside: false
pageClass: try-page
---

<script setup>
import { withBase } from "vitepress";
const src = __DEMO_URL__ || withBase("/demo/");
</script>

# Try the demo

The demo below runs entirely in your browser: images are compressed in a Web Worker with the WASM codecs and are
not sent anywhere. A sample photo is compressed as soon as it opens — drop your own images, try the screenshot
and transparent-icon samples, switch modes, and drag the before/after slider.

<p>
  <a :href="src" target="_blank" rel="noopener">Open the demo full screen ↗</a>
</p>

<iframe :src="src + (src.includes('?') ? '&' : '?') + 'embed'" title="SmartCompress demo" class="demo-frame" loading="lazy" allow="clipboard-write"></iframe>

::: tip Upload on this site is simulated
GitHub Pages has no backend, so “Upload” here simulates the presigned URL and the PUT inside your browser. Run
`pnpm demo` locally for the full flow against a mock presigning server, and see [Uploading to S3](/guide/s3) for a
real backend.
:::

<style>
.try-page .content-container {
  max-width: 1100px !important;
}
.demo-frame {
  width: 100%;
  height: 1100px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  margin-top: 8px;
  background: var(--vp-c-bg);
}
</style>
