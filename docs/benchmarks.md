# Benchmarks

The numbers below are generated from `bench/results/*.json` by `pnpm bench:report`; nothing is estimated.
Corpus: 24 images (`bench/corpus/manifest.json` lists sources, sizes and SHA-256). Hardware: Apple M4 Pro
(14 cores, 24 GB), macOS arm64, Node 24.15, headless Chromium 156.

Reproduce:

```sh
pnpm bench:corpus    # download/render the corpus
pnpm bench:node      # Optiq vs libvips (sharp); peak RSS per run in a fresh process
pnpm bench:browser   # Optiq vs browser-image-compression and canvas, in Chromium
pnpm bench:report    # regenerate bench/results/RESULTS.md
```

How to read it: fixed-quality baselines do not target a quality, so compare **size and SSIM together**. The
head-to-head tables count, per image, which tool is smaller *and* at least as good.

<!--@include: ../bench/results/RESULTS.md{5,}-->
