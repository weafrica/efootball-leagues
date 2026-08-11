// Client-side image downscale/compress, run right before any Supabase Storage
// upload. Phone cameras and screenshots routinely come in at 3-12MB / 3000px+
// on a side; almost nowhere in this app displays an image bigger than ~1600px,
// and most spots (avatars, thumbnails) show it at well under 200px. Without
// this step we upload — and then re-download, on every single view — full
// camera-resolution files for a 32px circle.
//
// Non-image files (e.g. the PDF option on payment-proof uploads) and image
// types canvas can't safely re-encode (gif, svg) are passed through untouched.
// Any failure here (corrupt file, HEIC canvas can't decode, etc.) falls back
// to the original file rather than blocking the upload — this is an
// optimization, never a requirement.
//
// Usage: const smaller = await compressImage(file, { maxDimension: 1600 });
//        then upload `smaller` exactly where you used to upload `file`.
export async function compressImage(file, opts = {}) {
  const { maxDimension = 1600, quality = 0.82, mimeType = "image/jpeg" } = opts;

  if (!file || !file.type || !file.type.startsWith("image/")) return file;
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;

  try {
    const img = await loadImage(file);
    const { width, height } = img;
    if (!width || !height) return file;

    const scale = Math.min(1, maxDimension / Math.max(width, height));

    // Already small on disk and no resize needed — re-encoding would only
    // cost quality for no size win, so skip it.
    if (scale === 1 && file.size <= 400 * 1024) return file;

    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
    if (!blob || blob.size >= file.size) return file; // no win — keep original

    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: mimeType, lastModified: Date.now() });
  } catch (e) {
    return file;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
