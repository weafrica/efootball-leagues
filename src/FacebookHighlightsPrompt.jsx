// Two small components pointing players at the club's Facebook Page to post
// match highlights, clips, and stats screens — both labeled "Highlights"
// so they read as the same feature wherever they show up. Lives in its own
// file (rather than App.jsx) so LeagueDetail.jsx — which App.jsx
// lazy-loads — can use it too without a circular import.
export const FACEBOOK_PAGE_URL = "https://www.facebook.com/weaafrica/mentions";

function FacebookGlyph({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="#fff">
      <path d="M22 12.06C22 6.51 17.52 2 12 2S2 6.51 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.23.2 2.23.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.91h-2.34V22c4.78-.76 8.44-4.92 8.44-9.94z"/>
    </svg>
  );
}

// Banner version — sits just under the photo-proof upload on every
// result-logging form (league results, challenge results, Ladder Cup
// results, walkover claims). Doesn't gate or affect submission in any way.
// Kept small and short by design — a nudge, not a feature to read.
export function FacebookHighlightsPrompt({ c }) {
  return (
    <a href={FACEBOOK_PAGE_URL} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg px-2.5 py-2 mb-5 font-body text-[11px] transition-colors"
      style={{ background: c.surfaceHover, color: c.textDim }}>
      <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: "#1877F2" }}>
        <FacebookGlyph size={11} />
      </span>
      <span>Post your <span className="font-semibold" style={{ color: c.text }}>Highlights</span> on Facebook</span>
    </a>
  );
}

// Icon version — a small round Facebook-blue button labeled "Highlights",
// for dropping next to results that are already posted/confirmed (community
// results feed, a settled challenge, a comment-posted match result) so
// players can jump straight to the Page from the result itself. Pass
// iconOnly for tight rows that don't have space for the text label —
// the title tooltip still reads "Highlights". Default size kept small
// (was 26) — this is meant to sit unobtrusively next to a result, not
// draw the eye.
export function FacebookHighlightsIcon({ c, size = 20, iconOnly = false }) {
  if (iconOnly) {
    return (
      <a href={FACEBOOK_PAGE_URL} target="_blank" rel="noopener noreferrer" title="Highlights — post to our Facebook Page"
        className="inline-flex items-center justify-center shrink-0 rounded-full"
        style={{ width: size, height: size, background: "#1877F2" }}>
        <FacebookGlyph size={size * 0.5} />
      </a>
    );
  }
  return (
    <a href={FACEBOOK_PAGE_URL} target="_blank" rel="noopener noreferrer" title="Post Highlights to our Facebook Page"
      className="inline-flex items-center shrink-0 rounded-full"
      style={{ gap: size * 0.18, background: "rgba(24,119,242,0.14)", paddingLeft: size * 0.09, paddingRight: size * 0.27, paddingTop: size * 0.09, paddingBottom: size * 0.09 }}>
      <span className="rounded-full flex items-center justify-center shrink-0" style={{ width: size, height: size, background: "#1877F2" }}>
        <FacebookGlyph size={size * 0.5} />
      </span>
      <span className="font-mono font-semibold uppercase tracking-wide" style={{ color: "#1877F2", fontSize: Math.max(size * 0.4, 7) }}>Highlights</span>
    </a>
  );
}
