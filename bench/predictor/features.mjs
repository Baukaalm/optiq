// Texture features for the quality predictor, sampled on the same patch grid as the classifier
// (up to 24x24 patches of 16x16 contiguous pixels). Exploration copy; the chosen ones are ported to src/.
export function extraFeatures(img) {
  const { width: W, height: H, data } = img;
  const P = Math.min(16, W, H);
  const nx = Math.min(24, Math.max(1, Math.floor(W / P)));
  const ny = Math.min(24, Math.max(1, Math.floor(H / P)));
  const Y = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  let n = 0, sumY = 0, sumY2 = 0, sumCb2 = 0, sumCr2 = 0, grad = 0, gradN = 0, lap = 0, lapN = 0, edges = 0;
  for (let j = 0; j < ny; j++) {
    const y0 = Math.floor(((H - P) * (j + 0.5)) / ny);
    for (let i = 0; i < nx; i++) {
      const x0 = Math.floor(((W - P) * (i + 0.5)) / nx);
      for (let y = y0; y < y0 + P; y++) {
        for (let x = x0; x < x0 + P; x++) {
          const o = (y * W + x) * 4;
          const yy = Y(o);
          const cb = -0.168736 * data[o] - 0.331264 * data[o + 1] + 0.5 * data[o + 2];
          const cr = 0.5 * data[o] - 0.418688 * data[o + 1] - 0.081312 * data[o + 2];
          n++; sumY += yy; sumY2 += yy * yy; sumCb2 += cb * cb; sumCr2 += cr * cr;
          if (x + 1 < x0 + P) {
            const d = Math.abs(yy - Y(o + 4));
            grad += d; gradN++;
            if (d > 16) edges++;
          }
          if (x > x0 && x + 1 < x0 + P && y > y0 && y + 1 < y0 + P) {
            const l = 4 * yy - Y(o - 4) - Y(o + 4) - Y(o - W * 4) - Y(o + W * 4);
            lap += l * l; lapN++;
          }
        }
      }
    }
  }
  const mean = sumY / n;
  return {
    lumaStd: Math.sqrt(Math.max(0, sumY2 / n - mean * mean)) / 255,
    chromaRms: Math.sqrt((sumCb2 + sumCr2) / (2 * n)) / 128,
    meanGrad: grad / gradN / 255,
    edgeShare16: edges / gradN,
    hfEnergy: Math.sqrt(lap / Math.max(1, lapN)) / 255,
    megapixels: (W * H) / 1e6,
  };
}
