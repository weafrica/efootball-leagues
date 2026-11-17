// Forgiving product search: every word the shopper types has to match
// something about the product, but a "match" tolerates plurals, partial words
// and small typos ("hodie" finds "Hoodie"). Pure functions, no React.

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ");
export const tokens = (s) => norm(s).split(/\s+/).filter(Boolean);

// Edit distance with a cap: returns max+1 as soon as it can't be within max.
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = v; if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How well one typed word matches one word of the product (0 = no match).
function wordScore(t, w) {
  if (w === t) return 4;
  if (w.startsWith(t)) return 3;
  if (t.length >= 3 && w.includes(t)) return 2;
  if (t.length >= 4 && w.length >= 3) {
    const max = t.length >= 6 ? 2 : 1;
    if (editDistance(t, w, max) <= max) return 1.5;
    // typo inside the start of a longer word ("hodi" -> "hoodie")
    if (w.length > t.length && editDistance(t, w.slice(0, t.length), max) <= max) return 1;
  }
  return 0;
}

// Returns matching products best-first. `extra(p)` may add more searchable
// text per product (e.g. its department name).
export function searchProducts(products, query, extra) {
  const qt = tokens(query);
  if (qt.length === 0) return products;
  const out = [];
  products.forEach((p, idx) => {
    const nameW = tokens(p.name);
    const otherW = tokens(`${p.description || ""} ${extra ? extra(p) : ""}`);
    let total = 0;
    for (const t of qt) {
      let best = 0;
      for (const w of nameW) best = Math.max(best, wordScore(t, w) * 2);
      for (const w of otherW) best = Math.max(best, wordScore(t, w));
      if (best === 0) { total = 0; break; }
      total += best;
    }
    if (total > 0) out.push({ p, total, idx });
  });
  out.sort((a, b) => b.total - a.total || a.idx - b.idx);
  return out.map((x) => x.p);
}

// "Did you mean ...?" — the closest single product-name word, when nothing matched.
export function suggestWord(products, query) {
  const qt = tokens(query);
  if (qt.length !== 1 || qt[0].length < 3) return null;
  let best = null, bestD = 3;
  for (const p of products) for (const w of tokens(p.name)) {
    if (w.length < 3) continue;
    const d = editDistance(qt[0], w, 2);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}
