import React, { useState, useMemo, useRef, useEffect } from "react";
import { Info, Pause, Play, Search, Square, Swords, Target, Trophy, Volume2, X } from "lucide-react";
import { supabase } from "./supabaseClient";
import { pickBestVoice } from "./utils/pickBestVoice";

// ---------------------------------------------------------------------------
// In-app rules reference. Mirrors the community's RULES.md so players can
// check how leagues, the ladder, or challenges actually work without leaving
// the screen they're on. Split into three focused modals (rather than one
// long wall of text) so each "Rules" button surfaces only what's relevant to
// where the player already is.
const RULES_CONTENT = {
  league: {
    icon: Trophy,
    title: "League Rules",
    sections: [
      { heading: "The basics", items: [
        "Fun leagues are free to join. Cash leagues are admin-created only, with a real entry fee.",
        "Your eFootball username has to match a club name to actually play — no match and you're just spectating.",
        "One active fun league at a time — your club there needs to be eliminated (or the league finished) before you can join another.",
        "Once a league starts, no new clubs can register — late joiners can only step into an already-listed, unclaimed club.",
      ]},
      { heading: "Formats", items: [
        "Single / Double Round Robin — everyone plays everyone once, or home-and-away.",
        "Knockout — single elimination, single- or double-legged ties.",
        "Survivor — play a set number of matches, the bottom % get cut, repeat until a target number remain, then a round-robin decider.",
        "Groups + Knockout — a group-stage round robin first, then the top clubs from each group go into a knockout bracket.",
      ]},
      { heading: "Arranging your fixture", items: [
        "Text your opponent once to propose a date & time, as soon as your fixture is published.",
        "No reply? You may call them once, on a different day, as a backup.",
        "Everything must be finalized before the fixture deadline.",
        "No response at all before the deadline = an automatic loss for whoever went silent.",
        "Agreed a time but they didn't show? Automatic forfeit.",
      ]},
      { heading: "Arrangements", items: [
        "📸 If you reject a time, offer a new one.",
        "🤔 Otherwise it looks like you don't want to play.",
        "📅 If you're busy, set and confirm the date.",
        "✅ Can't make it? Give your opponent the win.",
      ]},
      { heading: "On-pitch rules", items: [
        "15-minute halves (30 min total), up to 6 subs, no extra time or penalties — decided at 90 minutes.",
        "Bad connection during the match? That player takes the loss.",
        "Both players can agree to play ahead of schedule.",
        "Your screenshot is your proof — no screenshot, no result.",
        "3 different players report you for foul play and you're eliminated from the league.",
      ]},
      { heading: "Fixtures & deadlines", items: [
        "Each round is due 2 days after the previous one.",
        "Miss the deadline unplayed and it's a loss for both sides — both concede 4 goals, no points either way.",
      ]},
      { heading: "Standings", items: [
        "Sorted by points, then goal difference, then goals scored, then name.",
        "Knockout rounds are ranked by how far you got, not points — same-round ties are broken by aggregate goal difference in your exit round.",
        "Level on aggregate after two legs? It needs a manual edit to break it — there's no away-goals rule.",
      ]},
      { heading: "Cash leagues", items: [
        "Entry fee is R10–R200, your choice, paid and approved before you're confirmed.",
        "Payment rejected? Resubmit proof without losing your club.",
        "The organizer takes a flat 5% off the top; the rest splits gold/silver/bronze (55/25/15) in table-based leagues, or champion/runner-up (75/20) in knockout-based ones.",
        "The more you put in, the bigger your slice of your place's prize.",
      ]},
    ],
  },
  ladder: {
    icon: Swords,
    title: "Ladder Rules",
    sections: [
      { heading: "How it works", items: [
        "One permanent ranking, shared by everyone — it never resets. Ranked by points.",
        "You can only challenge names that are up to 10 points ahead of you — or level with you on points, for your first ladder match.",
        "5 days to accept, or it goes to an admin who decides whether to grant a walkover.",
        "Reported a score and they're ignoring it? It auto-confirms after 2 days — stalling doesn't work.",
        "Win = 3 points, draw = 1 point, loss = 0. Rank is points first, most wins as the tiebreaker.",
        "A photo of the final scoreboard is required, same as everywhere else.",
      ]},
      { heading: "Arrangements", items: [
        "📸 If you reject a time, offer a new one.",
        "🤔 Otherwise it looks like you don't want to play.",
        "📅 If you're busy, set and confirm the date.",
        "✅ Can't make it? Give your opponent the win.",
      ]},
    ],
  },
  challenge: {
    icon: Target,
    title: "Challenge Rules",
    sections: [
      { heading: "Direct & random challenges", items: [
        "Direct — challenge one specific player, any time.",
        "Random — broadcast open to everyone; first to accept gets the match, everyone else misses out.",
      ]},
      { heading: "Arrangements", items: [
        "📸 If you reject a time, offer a new one.",
        "🤔 Otherwise it looks like you don't want to play.",
        "📅 If you're busy, set and confirm the date.",
        "✅ Can't make it? Give your opponent the win.",
      ]},
      { heading: "Reporting results", items: [
        "A screenshot of the final scoreboard is required, always.",
        "Whoever didn't report the score has to confirm it before it counts — you can't confirm your own.",
        "Dispute it and the score clears completely — ask them to re-log it.",
      ]},
    ],
  },
};

// Highlights the matched substring of `text` for the given (lowercased)
// query. Pure display helper — doesn't touch the underlying rule text.
// When onClick is provided, the highlighted word itself becomes clickable
// (used in search results so tapping the word jumps to its heading, same
// as tapping the heading directly).
function highlightMatch(text, query, c, onClick) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      {onClick ? (
        <mark
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className="cursor-pointer"
          style={{ background: c.accent, color: c.bg, borderRadius: 2, padding: "0 1px" }}
        >
          {text.slice(idx, idx + query.length)}
        </mark>
      ) : (
        <mark style={{ background: c.accent, color: c.bg, borderRadius: 2, padding: "0 1px" }}>
          {text.slice(idx, idx + query.length)}
        </mark>
      )}
      {text.slice(idx + query.length)}
    </>
  );
}

// Persisted across sessions so a player's chosen playback speed and recent
// lookups are still there next time they open Rules.
const RULES_SPEED_KEY = "efootball-rules-speed-v1";
const RULES_RECENT_SEARCHES_KEY = "efootball-rules-recent-searches-v1";

const SPEED_OPTIONS = [
  { id: "slow", label: "Slow", rate: 0.75 },
  { id: "normal", label: "Normal", rate: 1 },
  { id: "fast", label: "Fast", rate: 1.35 },
];
const SPEED_RATES = Object.fromEntries(SPEED_OPTIONS.map((o) => [o.id, o.rate]));

// Shown as chips under the search box before a player has searched anything
// yet — the most common things people look up, until real recent-search
// history takes over.
const DEFAULT_SEARCH_CHIPS = ["forfeit", "screenshot", "deadline", "aggregate"];

// Maps how players actually phrase things to the word that's really in the
// rules text, so a search that comes up empty can still nudge them toward
// the right term instead of just saying "no results".
const SEARCH_ALIASES = {
  "no show": "forfeit", "noshow": "forfeit", "no-show": "forfeit", "didn't show": "forfeit",
  "not show": "forfeit", "afk": "forfeit", "quit": "forfeit", "rage quit": "forfeit", "ragequit": "forfeit",
  "away goals": "aggregate", "away goal": "aggregate", "tie": "aggregate", "draw": "aggregate", "level": "aggregate",
  "disconnect": "connection", "internet": "connection", "lag": "connection", "wifi": "connection", "dc": "connection",
  "proof": "screenshot", "photo": "screenshot", "picture": "screenshot", "pic": "screenshot",
  "money": "entry fee", "payout": "prize", "split": "prize", "cut": "organizer",
  "late": "deadline", "time up": "deadline", "expired": "deadline", "out of time": "deadline",
  "cheat": "foul play", "cheating": "foul play", "hacking": "foul play",
  "rank": "standings", "position": "standings", "leaderboard": "standings",
};

// Best-effort, anonymous search-term logging — no personal data, just the
// term and whether it matched anything, so admins can spot which rules
// keep tripping players up (e.g. lots of "away goals" or "disconnect"
// searches signals the rule text itself needs clarifying). Wrapped so a
// missing table or offline connection never interrupts the player's search.
async function logRulesSearch(term, hadResults) {
  try {
    await supabase.from("rules_search_logs").insert({ term, had_results: hadResults });
  } catch (e) {
    // Table may not exist yet, or the player's offline — logging is
    // best-effort and silent either way.
  }
}

// When a search comes up empty, suggest the real rules term the player
// probably meant, based on SEARCH_ALIASES — falls back to null if nothing
// in the alias map is a plausible match.
function suggestForQuery(q) {
  for (const [phrase, term] of Object.entries(SEARCH_ALIASES)) {
    if (q.includes(phrase) || phrase.includes(q)) return term;
  }
  return null;
}

function RulesModal({ type, onClose, c }) {
  const data = RULES_CONTENT[type];
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // Which search-result section (if any) the player tapped the heading of —
  // that section gets pinned to the top of the list, still with its search
  // term highlighted, so they don't lose their place scrolling to re-find it.
  const [pinnedKey, setPinnedKey] = useState(null);
  // The scrollable results list — pinning a section moves it visually to
  // the top of the data, but the player may still be scrolled further down,
  // so we also scroll the list itself back to the top when that happens.
  const listRef = useRef(null);
  const scrollListToTop = () => {
    if (listRef.current) listRef.current.scrollTo({ top: 0, behavior: "smooth" });
  };
  const pinSection = (key) => {
    setPinnedKey(key);
    scrollListToTop();
  };

  // Search runs across every rules category (league/ladder/challenge), not
  // just the one this modal was opened from — a player typing "forfeit"
  // should find it even if they opened this from the Ladder screen. Each
  // hit is tagged with which category it came from so results stay legible
  // once they're mixed together. Clicking a heading pins that section AND
  // expands it to show every rule under it (not just the matching ones) —
  // the typed word still gets highlighted wherever it shows up.
  const searchResults = useMemo(() => {
    if (!q) return null;
    const out = [];
    for (const key of Object.keys(RULES_CONTENT)) {
      const cat = RULES_CONTENT[key];
      for (const s of cat.sections) {
        const matched = s.items.filter((it) => it.toLowerCase().includes(q));
        if (matched.length) {
          const isPinned = pinnedKey === `${key}|${s.heading}`;
          out.push({ catKey: key, catTitle: cat.title, catIcon: cat.icon, heading: s.heading, items: isPinned ? s.items : matched, expanded: isPinned });
        }
      }
    }
    // Pinned section (if it's still in the results) floats to the top.
    if (pinnedKey) {
      const idx = out.findIndex((r) => `${r.catKey}|${r.heading}` === pinnedKey);
      if (idx > 0) out.unshift(out.splice(idx, 1)[0]);
    }
    return out;
  }, [q, pinnedKey]);

  // Which section (if any) is currently being read aloud, keyed the same
  // way as pinnedKey. Tapping the speaker icon on the section that's
  // already playing stops it; tapping a different one cancels the first
  // and starts the new one. speakingLine tracks which line within that
  // section the browser is currently voicing — -1 for the heading, or the
  // item's index — so that exact line can be highlighted as it's read.
  const [speakingKey, setSpeakingKey] = useState(null);
  const [speakingLine, setSpeakingLine] = useState(null);

  // Playback speed — persisted so a player's choice sticks next time they
  // open Rules, not just for this session.
  const [speed, setSpeed] = useState(() => {
    if (typeof window === "undefined") return "normal";
    const saved = window.localStorage.getItem(RULES_SPEED_KEY);
    return SPEED_RATES[saved] ? saved : "normal";
  });

  // "Read all" plays every section of this category in order, like a
  // podcast, instead of one heading at a time. queueRef holds the ordered
  // list of sections currently queued; queueIndexRef tracks progress
  // through it for the "3 of 7" style progress label.
  const [isReadingAll, setIsReadingAll] = useState(false);
  const queueRef = useRef([]);
  const queueIndexRef = useRef(0);
  const currentSectionRef = useRef(null);
  // Bumped on every stop/start so a cancel()-triggered onend from a
  // *previous* utterance can't advance a queue or clear state that
  // belongs to whatever started after it.
  const playTokenRef = useRef(0);

  // True pause/resume (rather than a hard stop) is desktop-only — see the
  // isMobileDevice comment further down for why it's unreliable on phones.
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);

  // Recent searches remembered across sessions, shown as tappable chips so
  // players don't have to retype a common lookup. Falls back to a short
  // list of common terms until there's any history yet.
  const [recentSearches, setRecentSearches] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(RULES_RECENT_SEARCHES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  });
  const addRecentSearch = (term) => {
    const clean = term.trim().toLowerCase();
    if (clean.length < 2) return;
    setRecentSearches((prev) => {
      const next = [clean, ...prev.filter((t) => t !== clean)].slice(0, 6);
      try { window.localStorage.setItem(RULES_RECENT_SEARCHES_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
      return next;
    });
  };

  // A short debounce after the player stops typing: log the term (for the
  // "what confuses players" signal) and, if it's worth remembering, save
  // it as a recent search chip.
  useEffect(() => {
    if (!q || q.length < 2) return undefined;
    const t = setTimeout(() => {
      addRecentSearch(query);
      logRulesSearch(query.trim().toLowerCase(), !!(searchResults && searchResults.length));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Keyboard navigation through search results — which result index (if
  // any) is highlighted by arrow keys. Resets whenever the query changes.
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => { setActiveIndex(-1); }, [q]);

  // The list of voices a browser exposes often isn't ready on first render
  // — it loads asynchronously — so we listen for the change event too and
  // pick the best natural-sounding one once it's available. Some older
  // desktop browsers (notably Chrome/Edge on Windows) never fire
  // onvoiceschanged at all, so we also poll for a bit as a fallback.
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const loadVoices = () => setVoices(window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      loadVoices();
      if (window.speechSynthesis.getVoices().length || attempts > 10) clearInterval(poll);
    }, 300);
    // Desktop Chrome/Edge on Windows has a long-standing bug where the very
    // first speak() call after a page load is silently swallowed. Sending a
    // no-op cancel() early "wakes up" the engine so the first real read
    // isn't the one that gets lost.
    window.speechSynthesis.cancel();
    return () => { window.speechSynthesis.onvoiceschanged = null; clearInterval(poll); };
  }, []);

  // Desktop Chrome/Edge also has a documented bug where the utterance
  // object can be garbage-collected mid-speech if nothing keeps a
  // reference to it, which silently kills playback partway through (or
  // right away) — this mostly shows up on desktop, not phones. Keeping it
  // in a ref keeps it alive for the duration of the read.
  const utteranceRef = useRef(null);
  // Same family of bug: on desktop, the speech engine can go silent after
  // ~15s of continuous speaking, and nudging pause()/resume() keeps it
  // going. Mobile browsers (iOS Safari, Android Chrome) don't have that
  // bug, and calling pause()/resume() on them can actually kill the
  // speech instead of resuming it — so this workaround is desktop-only.
  const isMobileDevice = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const resumeWatchdogRef = useRef(null);
  const clearResumeWatchdog = () => {
    if (resumeWatchdogRef.current) { clearInterval(resumeWatchdogRef.current); resumeWatchdogRef.current = null; }
  };

  // Core playback: builds the text + line-boundary segments for one
  // section and speaks it, calling onFinish when it naturally ends (or
  // errors). Both the single-section speak() and the "read all" queue
  // funnel through this so pause/resume/speed/highlighting all work the
  // same way regardless of which triggered it.
  const runUtterance = (key, heading, items, onFinish, rateOverride) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    clearResumeWatchdog();
    const token = ++playTokenRef.current;

    const segments = [];
    let text = "";
    const addLine = (lineText, lineIndex) => {
      const chunk = `${lineText}. `;
      segments.push({ start: text.length, end: text.length + chunk.length, lineIndex });
      text += chunk;
    };
    addLine(heading, -1);
    items.forEach((it, idx) => addLine(it, idx));

    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickBestVoice(voices);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || "en-US";
    utter.rate = rateOverride ?? SPEED_RATES[speed] ?? 1;
    utter.onboundary = (e) => {
      if (playTokenRef.current !== token) return;
      const seg = segments.find((s) => e.charIndex >= s.start && e.charIndex < s.end);
      if (seg) setSpeakingLine(seg.lineIndex);
    };
    utter.onend = () => {
      if (playTokenRef.current !== token) return;
      clearResumeWatchdog();
      utteranceRef.current = null;
      onFinish();
    };
    utter.onerror = () => {
      if (playTokenRef.current !== token) return;
      clearResumeWatchdog();
      utteranceRef.current = null;
      onFinish();
    };
    utteranceRef.current = utter;
    currentSectionRef.current = { key, heading, items, onFinish };
    setSpeakingKey(key);
    setSpeakingLine(-1);
    setIsPaused(false);
    isPausedRef.current = false;
    window.speechSynthesis.speak(utter);
    if (!isMobileDevice) {
      resumeWatchdogRef.current = setInterval(() => {
        if (playTokenRef.current !== token) { clearResumeWatchdog(); return; }
        if (isPausedRef.current) return;
        if (!window.speechSynthesis.speaking) { clearResumeWatchdog(); return; }
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 5000);
    }
  };

  // Hard stop — cancels speech entirely and clears all reading state,
  // including a "read all" queue in progress. Used by the persistent
  // "Reading… ⏹" bar's stop control.
  const stopReading = () => {
    playTokenRef.current++;
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    clearResumeWatchdog();
    queueRef.current = [];
    queueIndexRef.current = 0;
    currentSectionRef.current = null;
    setIsReadingAll(false);
    setSpeakingKey(null);
    setSpeakingLine(null);
    setIsPaused(false);
    isPausedRef.current = false;
  };

  // Reads (or stops) a single section — the speaker icon next to each
  // heading.
  const speak = (key, heading, items) => {
    if (speakingKey === key && !isReadingAll) { stopReading(); return; }
    setIsReadingAll(false);
    queueRef.current = [];
    runUtterance(key, heading, items, () => { setSpeakingKey(null); setSpeakingLine(null); currentSectionRef.current = null; });
  };

  // Advances through the "read all" queue one section at a time.
  const playAt = (index) => {
    const queue = queueRef.current;
    if (index >= queue.length) { stopReading(); return; }
    queueIndexRef.current = index;
    playAt._current = queue[index];
    runUtterance(queue[index].key, queue[index].heading, queue[index].items, () => playAt(index + 1));
  };

  // "Read all" — queues every section in this category and reads them
  // start to finish, like a podcast, rather than one heading at a time.
  const startReadAll = () => {
    if (!data.sections.length) return;
    queueRef.current = data.sections.map((s) => ({ key: `${type}|${s.heading}`, heading: s.heading, items: s.items }));
    setIsReadingAll(true);
    playAt(0);
  };

  // Pause/resume is desktop-only — see isMobileDevice above: on phones,
  // pause()/resume() can silently kill playback instead of resuming it, so
  // mobile players just get the stop control.
  const togglePause = () => {
    if (typeof window === "undefined" || !window.speechSynthesis || isMobileDevice) return;
    if (isPausedRef.current) {
      window.speechSynthesis.resume();
      isPausedRef.current = false;
      setIsPaused(false);
    } else {
      window.speechSynthesis.pause();
      isPausedRef.current = true;
      setIsPaused(true);
    }
  };

  // Changing speed mid-read restarts the current section (or queue item)
  // at the new rate — small UX cost, but simplest way to keep the rate in
  // sync since the browser can't change an utterance's rate once started.
  const changeSpeed = (newSpeed) => {
    setSpeed(newSpeed);
    try { window.localStorage.setItem(RULES_SPEED_KEY, newSpeed); } catch (e) { /* ignore */ }
    if (currentSectionRef.current) {
      const cur = currentSectionRef.current;
      runUtterance(cur.key, cur.heading, cur.items, cur.onFinish, SPEED_RATES[newSpeed]);
    }
  };

  // Stop any in-progress reading if the player closes the modal mid-sentence.
  useEffect(() => {
    return () => {
      clearResumeWatchdog();
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  // Esc closes the modal from anywhere inside it; Enter/arrow keys (added
  // on the search input below) move through search results.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!data) return null;
  const Icon = data.icon;
  const suggestion = q && searchResults && !searchResults.length ? suggestForQuery(q) : null;

  const handleSearchKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      if (!q || !searchResults || !searchResults.length) return;
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!q || !searchResults || !searchResults.length) return;
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (!q || !searchResults || !searchResults.length) return;
      e.preventDefault();
      const r = searchResults[activeIndex >= 0 ? activeIndex : 0];
      pinSection(`${r.catKey}|${r.heading}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-5 max-h-[85vh] flex flex-col" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2">
            <Icon size={18} style={{ color: c.accent }} />
            <h2 className="text-xl font-extrabold uppercase tracking-tight">{data.title}</h2>
          </div>
          <button aria-label="Close" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>

        <div className="relative mb-2 shrink-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPinnedKey(null); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search rules — e.g. forfeit, screenshot, deadline..."
            className="w-full font-body text-sm rounded-xl pl-9 pr-8 py-2.5 outline-none"
            style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
          />
          {query && (
            <button onClick={() => { setQuery(""); setPinnedKey(null); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}>
              <X size={12} />
            </button>
          )}
        </div>

        {!query && (
          <div className="flex flex-wrap gap-1.5 mb-4 shrink-0">
            {(recentSearches.length ? recentSearches : DEFAULT_SEARCH_CHIPS).map((term) => (
              <button
                key={term}
                onClick={() => setQuery(term)}
                className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-full"
                style={{ background: c.surface, color: c.textFaint, border: `1px solid ${c.border}` }}
              >
                {term}
              </button>
            ))}
          </div>
        )}
        {query && <div className="mb-4 shrink-0" />}

        <div ref={listRef} className="space-y-5 overflow-y-auto relative">
          {speakingKey && (
            <div
              className="sticky top-0 z-10 flex items-center gap-2 rounded-xl px-3 py-2 mb-1 font-body text-xs"
              style={{ background: c.bg, border: `1px solid ${c.borderStrong}`, boxShadow: `0 2px 8px rgba(0,0,0,0.15)` }}
            >
              <Volume2 size={13} style={{ color: c.accent }} className="shrink-0" />
              <div className="flex-1 min-w-0 truncate" style={{ color: c.textDim }}>
                {isReadingAll
                  ? `Reading ${queueIndexRef.current + 1} of ${queueRef.current.length} — ${currentSectionRef.current?.heading || ""}`
                  : `Reading — ${currentSectionRef.current?.heading || ""}`}
              </div>
              <div className="flex items-center gap-0.5 shrink-0 rounded-full p-0.5" style={{ background: c.surface }}>
                {SPEED_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => changeSpeed(opt.id)}
                    className="font-mono text-[9px] uppercase px-1.5 py-1 rounded-full"
                    style={{ background: speed === opt.id ? c.accent : "transparent", color: speed === opt.id ? c.accentText : c.textFaint }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {!isMobileDevice && (
                <button onClick={togglePause} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }} aria-label={isPaused ? "Resume reading" : "Pause reading"}>
                  {isPaused ? <Play size={11} /> : <Pause size={11} />}
                </button>
              )}
              <button onClick={stopReading} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }} aria-label="Stop reading">
                <Square size={11} />
              </button>
            </div>
          )}
          {q ? (
            searchResults.length ? (
              searchResults.map((r, ri) => {
                const RIcon = r.catIcon;
                const rKey = `${r.catKey}|${r.heading}`;
                const isActiveSection = speakingKey === rKey;
                const isKeyboardActive = activeIndex === ri;
                return (
                  <div
                    key={`${r.catKey}-${r.heading}-${ri}`}
                    className="rounded-lg"
                    style={isKeyboardActive ? { outline: `1px solid ${c.accent}`, outlineOffset: 2 } : undefined}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <button
                        onClick={() => pinSection(pinnedKey === rKey ? null : rKey)}
                        className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] rounded px-1 -mx-1 min-w-0"
                        style={{ color: c.accent, background: isActiveSection && speakingLine === -1 ? c.surface : "transparent" }}
                      >
                        <RIcon size={11} className="shrink-0" />
                        <span className="underline decoration-dotted underline-offset-2 truncate">{r.catTitle} — {r.heading}</span>
                      </button>
                      <button
                        onClick={() => speak(rKey, `${r.catTitle} — ${r.heading}`, r.items)}
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full"
                        style={{
                          background: isActiveSection ? c.accent : c.surface,
                          color: isActiveSection ? c.bg : c.textFaint,
                        }}
                        aria-label="Read this section aloud"
                      >
                        <Volume2 size={12} />
                      </button>
                    </div>
                    <ul className="space-y-1.5">
                      {r.items.map((it, i) => (
                        <li
                          key={i}
                          className="font-body text-sm flex items-start gap-2 leading-snug rounded-lg px-1.5 py-1 -mx-1.5 transition-colors"
                          style={{ color: c.textDim, background: isActiveSection && speakingLine === i ? c.surface : "transparent" }}
                        >
                          <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: isActiveSection && speakingLine === i ? c.accent : c.textFaint }} />
                          <span>{highlightMatch(it, q, c, () => pinSection(rKey))}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            ) : (
              <div className="font-body text-sm text-center py-8" style={{ color: c.textFaint }}>
                <div>No rules match "{query}".</div>
                {suggestion && (
                  <button
                    onClick={() => setQuery(suggestion)}
                    className="font-body text-sm mt-2 underline decoration-dotted underline-offset-2"
                    style={{ color: c.accent }}
                  >
                    Try "{suggestion}" instead?
                  </button>
                )}
              </div>
            )
          ) : (
            <>
              <div className="flex items-center justify-between -mt-1">
                <button
                  onClick={isReadingAll ? stopReading : startReadAll}
                  className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] rounded-full px-2.5 py-1"
                  style={{ background: isReadingAll ? c.accent : c.surface, color: isReadingAll ? c.accentText : c.textDim, border: `1px solid ${c.border}` }}
                >
                  {isReadingAll ? <Square size={11} /> : <Volume2 size={11} />}
                  {isReadingAll ? "Stop reading all" : `Read all (${data.sections.length} sections)`}
                </button>
              </div>
              {data.sections.map((s) => {
              const sKey = `${type}|${s.heading}`;
              const isActiveSection = speakingKey === sKey;
              return (
                <div key={s.heading}>
                  <div className="flex items-center gap-2 mb-2">
                    <div
                      className="font-mono text-[11px] uppercase tracking-[0.2em] rounded px-1 -mx-1"
                      style={{ color: c.textFaint, background: isActiveSection && speakingLine === -1 ? c.surface : "transparent" }}
                    >
                      {s.heading}
                    </div>
                    <button
                      onClick={() => speak(sKey, s.heading, s.items)}
                      className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full"
                      style={{
                        background: isActiveSection ? c.accent : c.surface,
                        color: isActiveSection ? c.bg : c.textFaint,
                      }}
                      aria-label="Read this section aloud"
                    >
                      <Volume2 size={12} />
                    </button>
                  </div>
                  <ul className="space-y-1.5">
                    {s.items.map((it, i) => (
                      <li
                        key={i}
                        className="font-body text-sm flex items-start gap-2 leading-snug rounded-lg px-1.5 py-1 -mx-1.5 transition-colors"
                        style={{ color: c.textDim, background: isActiveSection && speakingLine === i ? c.surface : "transparent" }}
                      >
                        <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: isActiveSection && speakingLine === i ? c.accent : c.textFaint }} />
                        <span>{it}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default RulesModal;
