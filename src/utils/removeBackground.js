// Background removal for product photos, written from scratch (no library, no
// upload: everything runs in the browser on the shop admin's own device).
//
// How it works: take the colour of the picture's border as "the background",
// then flood-fill inwards from every border pixel, removing each connected
// pixel whose colour is close enough to it. Because it only spreads from the
// outside, a white label or a light patch *inside* the product is kept.
//
// It works well on studio-style photos (plain white, grey or coloured
// backdrop). It cannot cut a product out of a busy scene; for that the editor
// also has an erase / restore brush.

// Mask values: 255 = keep, 0 = removed.

function colorDistance(d, i, r, g, b) {
  const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

// Median colour of the outer ring of the picture.
export function estimateBackground(data, w, h) {
  const rs = [], gs = [], bs = [];
  const ring = Math.max(1, Math.min(3, Math.floor(Math.min(w, h) / 50)));
  const push = (x, y) => { const i = (y * w + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); };
  for (let x = 0; x < w; x++) for (let k = 0; k < ring; k++) { push(x, k); push(x, h - 1 - k); }
  for (let y = ring; y < h - ring; y++) for (let k = 0; k < ring; k++) { push(k, y); push(w - 1 - k, y); }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

// Flood-fill from the border. `tolerance` is how different from the
// background colour a pixel may be and still count as background (0 to 255).
export function autoMask(data, w, h, tolerance = 28, bg = estimateBackground(data, w, h)) {
  const mask = new Uint8Array(w * h).fill(255);
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const [r, g, b] = bg;
  const consider = (x, y) => {
    const p = y * w + x;
    if (seen[p]) return;
    seen[p] = 1;
    const i = p * 4;
    if (data[i + 3] < 16 || colorDistance(data, i, r, g, b) <= tolerance) {
      mask[p] = 0;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) { consider(x, 0); consider(x, h - 1); }
  for (let y = 0; y < h; y++) { consider(0, y); consider(w - 1, y); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w, y = (p - x) / w;
    if (x > 0) consider(x - 1, y);
    if (x < w - 1) consider(x + 1, y);
    if (y > 0) consider(x, y - 1);
    if (y < h - 1) consider(x, y + 1);
  }
  return mask;
}

// Soft edge: box-blur the mask by `radius` pixels (0 = hard edge), so the cut
// does not look jagged. Returns alpha values 0..255.
export function softenMask(mask, w, h, radius = 1) {
  if (radius <= 0) return mask;
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  const win = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) sum += mask[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += mask[row + Math.min(w - 1, x + radius + 1)] - mask[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / win);
      sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

// Paints a round brush into the mask (value 0 erases, 255 restores).
export function paintMask(mask, w, h, cx, cy, radius, value) {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = value;
    }
  }
}

// Writes the mask into an RGBA buffer: alpha = mask (over the original
// alpha). With `whiteBackground`, removed areas become white instead of clear.
export function composite(src, alpha, w, h, whiteBackground = false) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const a = (alpha[p] / 255) * (src[i + 3] / 255);
    if (whiteBackground) {
      out[i] = src[i] * a + 255 * (1 - a);
      out[i + 1] = src[i + 1] * a + 255 * (1 - a);
      out[i + 2] = src[i + 2] * a + 255 * (1 - a);
      out[i + 3] = 255;
    } else {
      out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2];
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}
