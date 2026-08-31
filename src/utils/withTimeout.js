// Wraps a promise so it rejects with a friendly error instead of hanging
// forever. fetch() (and libraries built on it, like @vercel/blob/client's
// upload() and supabase-js's .rpc()) has no built-in timeout — on a flaky
// mobile connection the underlying TCP request can stall indefinitely
// without ever resolving OR rejecting, so an `await` on it just never
// returns. That leaves whatever UI state was watching it (a "Submitting…"
// button, a busy flag) stuck forever, with no error surfaced anywhere for
// the user to act on or for us to log.
//
// Usage: await withTimeout(uploadToBlob(...), 25000, "Upload timed out — check your connection and try again.");
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Timed out after ${ms}ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
