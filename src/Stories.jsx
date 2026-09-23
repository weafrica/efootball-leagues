import React, { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Play, Globe, RotateCcw, Volume2, VolumeX, Sparkles } from "lucide-react";
import { supabase } from "./supabaseClient";
import PlayerCharacter from "./PlayerCharacter.jsx";
import { isHdVoiceEnabled, setHdVoiceEnabled, getVoiceTier, loadNeuralVoice, neuralVoiceReady } from "./chessVoiceHD.js";

// Pre-generated narration (Piper TTS, synthesized offline — see
// synthesize_story.py / upload_story_audio.py) lives as plain files in
// the public story-audio bucket. A node with no audio yet (script hasn't
// been run against it) simply plays nothing — text-only is always a
// valid, complete experience, narration is an enhancement on top.
const AUDIO_BASE = "https://jobgzxljuczzqljwavyq.supabase.co/storage/v1/object/public/story-audio";
const SFX_BASE = "https://jobgzxljuczzqljwavyq.supabase.co/storage/v1/object/public/story-sfx";
const NARRATION_PREF_KEY = "storyGame:narrationOn";
const AUDIO_CACHE_NAME = "story-audio-cache-v1";
const DATA_CACHE_NAME = "story-data-cache-v1";

// Same Cache Storage mechanism as the audio helpers below, but for the
// story text/choices JSON itself (a Supabase query result, not a plain
// URL) — so a story someone has already opened stays readable, and its
// choices stay tappable, with no connection.
function dataCacheRequest(key) {
  return new Request(`https://story-data-cache.local/${key}`);
}

async function readDataCache(key) {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(DATA_CACHE_NAME);
    const response = await cache.match(dataCacheRequest(key));
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}

async function writeDataCache(key, value) {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(DATA_CACHE_NAME);
    await cache.put(dataCacheRequest(key), new Response(JSON.stringify(value)));
  } catch {
    // best-effort only
  }
}

// Persistent, visited-only offline caching: uses the browser's Cache
// Storage API (the same mechanism a service worker uses, callable
// directly from a page too) rather than downloading a whole story's
// branches upfront. A node's narration/ambience/sfx only ever get cached
// once actually fetched — either because the player reached that node, or
// because it was prefetched one hop ahead (see the prefetch effect below).
// Nothing is cached "just in case" beyond that one-hop lookahead, so a big
// story with dozens of unexplored side-branches doesn't balloon offline
// storage for content nobody's heard yet.
async function cachedAudioUrl(url) {
  if (!("caches" in window)) {
    // No Cache Storage support (rare) — just use the URL directly, same
    // as before; browser HTTP cache still helps somewhat, offline won't.
    return url;
  }
  try {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    let response = await cache.match(url);
    if (!response) {
      const fresh = await fetch(url);
      if (!fresh.ok) return url; // 404 (not synthesized yet) — let the caller's own fallback handle it
      await cache.put(url, fresh.clone());
      response = fresh;
    }
    return URL.createObjectURL(await response.blob());
  } catch {
    return url; // cache storage failed for some reason — fall back to a direct fetch
  }
}

// Warms the cache for a URL without needing the audio right now — used
// for the one-hop-ahead prefetch, so a later cachedAudioUrl() call for the
// same URL is an instant cache hit instead of a network wait.
async function warmAudioCache(url) {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    if (await cache.match(url)) return;
    const fresh = await fetch(url);
    if (fresh.ok) await cache.put(url, fresh.clone());
  } catch {
    // best-effort only
  }
}

// Stories — a data-light, code-only branching text "game" under Quick
// Actions. Deliberately NOT a game engine: it's a generic state machine
// over a JSON graph (game_story_content.graph — see the migration for the
// shape), so the whole "game" is this one file. No images, no audio, no
// dependencies beyond what the app already ships.
//
// Data flow, in order of how much it costs:
//   1. List screen — reads game_stories only (id, title, emoji, languages).
//      No story content, no graph, ever touched here. This is the only
//      query every visitor to this screen pays for.
//   2. Opening one story — fetches ONE row from game_story_content (one
//      story, one language: a few KB of JSON). Nothing else loads.
//   3. Replaying an already-opened story costs nothing further this
//      session (React state holds the graph); a fresh visit re-fetches
//      the same few KB, same as any other page's data.
//
// Progress (game_story_progress) is upserted on every node change so a
// player can resume — cheap, one small row per player per story.

const LAST_LANGUAGE_KEY = "storyGame:lastLanguage";

const LANGUAGE_LABELS = {
  en: "English",
  fr: "Français",
  sw: "Kiswahili",
  ha: "Hausa",
  yo: "Yorùbá",
  ar: "العربية",
  pt: "Português",
};

function languageLabel(code) {
  return LANGUAGE_LABELS[code] || code.toUpperCase();
}

export default function StoriesPage({ session, showToast, onBack, c }) {
  const [stories, setStories] = useState(null); // null = loading
  const [screen, setScreen] = useState("list"); // list | language | play
  const [activeStory, setActiveStory] = useState(null); // row from game_stories
  const [language, setLanguage] = useState(null);
  const [content, setContent] = useState(null); // { title, graph }
  const [nodeId, setNodeId] = useState(null);
  const [progressByStory, setProgressByStory] = useState({}); // story_id -> progress row
  const [loadingContent, setLoadingContent] = useState(false);
  const [narrationOn, setNarrationOn] = useState(() => localStorage.getItem(NARRATION_PREF_KEY) !== "off");
  const [winBanner, setWinBanner] = useState(null);
  const audioRef = useRef(null);
  const ambienceRef = useRef(null);
  const sfxRef = useRef(null);
  const currentAmbienceTagRef = useRef(null); // tracks which ambience tag is loaded, since .src becomes a blob URL

  useEffect(() => {
    let cancelled = false;

    const fetchStoryList = async () => {
      const { data, error } = await supabase
        .from("game_stories")
        .select("id, slug, default_title, emoji, languages")
        .order("sort_order", { ascending: true });
      return error ? null : data;
    };

    (async () => {
      const cached = await readDataCache("story-list");
      if (!cancelled && cached) setStories(cached);

      const fresh = await fetchStoryList();
      if (cancelled) return;
      if (fresh) {
        setStories(fresh); // background refresh landing — updates the list even if a cached copy already showed
        writeDataCache("story-list", fresh);
      } else if (!cached) {
        setStories([]); // offline with nothing cached yet — stop spinning, show "no stories yet" rather than hang forever
      }

      // Progress is per-player and only meaningful live — no offline
      // caching here, it's small and fast when there IS a connection,
      // and stale progress ("in progress" / "completed" labels) offline
      // isn't worth the complexity. If this fails offline, the list
      // above still renders fine, just without those labels yet.
      const { data: progressRows } = await supabase
        .from("game_story_progress")
        .select("story_id, language, current_node_id, completed, ending_id")
        .eq("user_id", session.user.id);
      if (cancelled) return;
      const byStory = {};
      (progressRows || []).forEach((p) => { byStory[p.story_id] = p; });
      setProgressByStory(byStory);
    })();
    return () => { cancelled = true; };
  }, [session.user.id]);

  const openStory = (story) => {
    setActiveStory(story);
    const preferred = localStorage.getItem(LAST_LANGUAGE_KEY);
    const existing = progressByStory[story.id];
    // Skip the picker entirely when there's only one language, or when the
    // player's last-used language is already available for this story —
    // one less tap for the common case.
    const lang = existing?.language
      || (story.languages.length === 1 ? story.languages[0] : null)
      || (preferred && story.languages.includes(preferred) ? preferred : null);
    if (lang) loadContent(story, lang);
    else setScreen("language");
  };

  const loadContent = useCallback(async (story, lang) => {
    setLoadingContent(true);
    setLanguage(lang);
    localStorage.setItem(LAST_LANGUAGE_KEY, lang);

    const cacheKey = `story-content:${story.id}:${lang}`;
    const fetchContent = async () => {
      const { data, error } = await supabase
        .from("game_story_content")
        .select("title, graph")
        .eq("story_id", story.id)
        .eq("language", lang)
        .maybeSingle();
      return error || !data ? null : data;
    };

    const cached = await readDataCache(cacheKey);
    let data = cached;

    if (cached) {
      // Enter immediately from cache; refresh quietly in the background
      // for next time. Deliberately doesn't re-render mid-story if this
      // lands after the player's already reading — it only updates what
      // the NEXT visit sees.
      fetchContent().then((fresh) => { if (fresh) writeDataCache(cacheKey, fresh); });
    } else {
      data = await fetchContent();
      if (!data) {
        setLoadingContent(false);
        showToast?.("Couldn't load that story — check your connection and try again.");
        return;
      }
      writeDataCache(cacheKey, data);
    }

    setLoadingContent(false);
    setContent(data);
    const existing = progressByStory[story.id];
    const startId = (existing && existing.language === lang && !existing.completed)
      ? existing.current_node_id
      : data.graph.startNode;
    setNodeId(startId);
    setScreen("play");
  }, [progressByStory, showToast]);

  // Writes always need a live connection — unlike the reads above, there's
  // no offline queue here. Supabase's client doesn't throw on a failed
  // upsert, it just returns silently, so playing offline still works
  // (local state below still updates), it just won't sync progress to the
  // server until back online. A "retry when reconnected" queue would
  // close that gap, but is a deliberately separate piece of work.
  const saveProgress = useCallback(async (story, lang, id, node, existingFlags) => {
    const isEnding = !!node.ending;
    const flags = node.win ? { ...existingFlags, [node.win.flag]: true } : existingFlags;
    await supabase.from("game_story_progress").upsert({
      user_id: session.user.id,
      story_id: story.id,
      language: lang,
      current_node_id: id,
      completed: isEnding,
      ending_id: isEnding ? node.ending : null,
      flags,
      updated_at: new Date().toISOString(),
    });
    setProgressByStory((prev) => ({
      ...prev,
      [story.id]: { story_id: story.id, language: lang, current_node_id: id, completed: isEnding, ending_id: isEnding ? node.ending : null, flags },
    }));
    return flags;
  }, [session.user.id]);

  // Ambience: a quiet looping background sound keyed by the node's
  // `ambience` tag (e.g. "stadium_training", "locker_room"). Many nodes
  // share the same tag, so this is a handful of files reused throughout,
  // not one per node. Crossfades are skipped for simplicity — it just
  // swaps when the tag changes, which reads fine since ambience is subtle
  // by design (low volume, not meant to be a focal point).
  useEffect(() => {
    if (!narrationOn || !content || !nodeId) return;
    const node = content.graph.nodes[nodeId];
    const ambience = ambienceRef.current;
    if (!ambience) return;
    if (!node?.ambience) { ambience.pause(); currentAmbienceTagRef.current = null; return; }
    if (currentAmbienceTagRef.current === node.ambience) {
      ambience.play().catch(() => {});
      return;
    }
    let cancelled = false;
    (async () => {
      const playableUrl = await cachedAudioUrl(`${SFX_BASE}/${node.ambience}.mp3`);
      if (cancelled) return;
      currentAmbienceTagRef.current = node.ambience;
      ambience.src = playableUrl;
      ambience.loop = true;
      ambience.volume = 0.18;
      ambience.play().catch(() => { /* missing sfx file yet — silent, no ambience this node */ });
    })();
    return () => { cancelled = true; };
  }, [narrationOn, content, nodeId]);

  // One-shot sound effects: a short list of tags per node (footsteps, a
  // dog bark, a phone buzz), played once when the node is reached. Missing
  // files fail silently — same principle as narration and ambience,
  // sound is always an enhancement, never required.
  useEffect(() => {
    if (!narrationOn || !content || !nodeId) return;
    const node = content.graph.nodes[nodeId];
    if (!node?.sfx?.length) return;
    let cancelled = false;
    node.sfx.forEach(async (tag, i) => {
      const playableUrl = await cachedAudioUrl(`${SFX_BASE}/${tag}.mp3`);
      if (cancelled) return;
      const el = new Audio(playableUrl);
      el.volume = 0.5;
      setTimeout(() => { el.play().catch(() => {}); }, i * 300);
    });
    return () => { cancelled = true; };
  }, [narrationOn, content, nodeId]);

  const [hdEnabled, setHdEnabledState] = useState(() => isHdVoiceEnabled());
  const [hdLoading, setHdLoading] = useState(false);
  const [hdProgress, setHdProgress] = useState(0);
  const [speakingChoices, setSpeakingChoices] = useState(false);
  const speakingChoicesRef = useRef(false);
  const choiceAudioRef = useRef(null);
  const choiceBlobCacheRef = useRef({}); // nodeId -> [blob, ...] in choice order, synthesized ahead of time
  const prefetchedNarrationRef = useRef(new Set()); // "storyId/lang/nodeId" already warmed in the browser cache

  const stopChoiceSpeech = () => {
    speakingChoicesRef.current = false;
    choiceAudioRef.current?.pause();
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingChoices(false);
  };

  // Reads the current choices aloud. Choice text is player-facing and
  // grows with every new branch anyone writes — pre-generating audio for
  // it, the way narration is handled, doesn't scale. This reuses the
  // same live, in-browser neural voice built for Chess (chessVoiceHD.js):
  // real quality (Kokoro, ~86MB, or the lighter Piper-in-browser tier),
  // downloaded once on opt-in and cached, then able to speak ANY text
  // instantly from then on — no authoring step, ever. Falls back to the
  // plain built-in browser voice if HD is off or fails to load, same
  // resilience chess already relies on.
  const speakChoices = async (choices) => {
    if (speakingChoices) { stopChoiceSpeech(); return; }
    speakingChoicesRef.current = true;
    setSpeakingChoices(true);

    if (isHdVoiceEnabled()) {
      try {
        let blobs = choiceBlobCacheRef.current[nodeId];
        if (!blobs) {
          // Prefetch effect hasn't finished (or wasn't running, e.g. HD
          // was just turned on) — fall back to synthesizing now.
          setHdLoading(!neuralVoiceReady());
          const engine = await loadNeuralVoice((frac) => setHdProgress(frac));
          setHdLoading(false);
          blobs = await Promise.all(
            choices.map((choice, i) => engine.speak(`Option ${i + 1}. ${choice.text}`).then((r) => r.blob))
          );
          choiceBlobCacheRef.current[nodeId] = blobs;
        }
        for (const blob of blobs) {
          if (!speakingChoicesRef.current) return; // stopped mid-sequence
          const audio = new Audio(URL.createObjectURL(blob));
          choiceAudioRef.current = audio;
          await new Promise((resolve) => {
            audio.onended = resolve;
            audio.onerror = resolve;
            audio.play().catch(resolve);
          });
        }
        setSpeakingChoices(false);
        return;
      } catch (err) {
        console.warn("HD voice failed for choices, falling back to the built-in voice:", err);
        setHdLoading(false);
      }
    }

    if (!("speechSynthesis" in window)) { setSpeakingChoices(false); return; }
    window.speechSynthesis.cancel();
    choices.forEach((choice, i) => {
      const utter = new SpeechSynthesisUtterance(`Option ${i + 1}: ${choice.text}`);
      utter.rate = 1.0;
      if (i === choices.length - 1) utter.onend = () => setSpeakingChoices(false);
      window.speechSynthesis.speak(utter);
    });
  };

  // Plays the current node's pre-generated narration, if any exists yet,
  // then auto-reads the choices via the HD engine once it ends — so a
  // node fully narrates itself without any tap, the same way an audiobook
  // would move from scene into "what do you do next?" Falls through to
  // reading choices immediately if narration is off, missing (404), or
  // blocked by the browser's autoplay policy, so silence never blocks it.
  useEffect(() => {
    if (!activeStory || !nodeId || !content) return;
    const node = content.graph.nodes[nodeId];
    const hasChoices = !node?.ending && node?.choices?.length;

    const autoReadChoices = () => {
      // Not gated on hdEnabled — speakChoices() itself already picks HD
      // vs. the plain built-in voice. Gating the AUTO-TRIGGER on HD meant
      // choices simply never auto-played at all whenever HD was off
      // (different device, never toggled on, etc.) — that silence is what
      // read as "auto play isn't working."
      if (hasChoices) speakChoices(node.choices);
    };

    if (!narrationOn) { autoReadChoices(); return; }
    const audio = audioRef.current;
    if (!audio) return;

    let cancelled = false;
    (async () => {
      const url = `${AUDIO_BASE}/${activeStory.id}/${language}/${nodeId}.wav`;
      const playableUrl = await cachedAudioUrl(url);
      if (cancelled) return;
      audio.src = playableUrl;
      audio.onended = autoReadChoices;
      audio.onerror = autoReadChoices; // no narration file yet — still auto-read choices
      audio.play().catch(autoReadChoices); // autoplay blocked — still auto-read choices
    })();

    return () => { cancelled = true; audio.pause(); audio.onended = null; audio.onerror = null; };
  }, [narrationOn, activeStory, language, nodeId, content]);

  // Starts synthesizing this node's choice audio the moment the node
  // loads — in parallel with narration playing, not after it ends. This
  // is what actually fixes the "options are slow to respond" lag: by the
  // time narration finishes and auto-read (or a manual tap) wants to play
  // the choices, they're usually already sitting in the cache, ready to
  // play instantly instead of waiting on fresh synthesis.
  useEffect(() => {
    if (!hdEnabled || !content || !nodeId) return;
    const node = content.graph.nodes[nodeId];
    const hasChoices = !node?.ending && node?.choices?.length;
    if (!hasChoices || choiceBlobCacheRef.current[nodeId]) return;
    let cancelled = false;
    (async () => {
      try {
        const engine = await loadNeuralVoice((frac) => setHdProgress(frac));
        if (cancelled) return;
        const blobs = await Promise.all(
          node.choices.map((choice, i) => engine.speak(`Option ${i + 1}. ${choice.text}`).then((r) => r.blob))
        );
        if (!cancelled) choiceBlobCacheRef.current[nodeId] = blobs;
      } catch {
        // Silent — speakChoices() falls back to synthesizing on demand.
      }
    })();
    return () => { cancelled = true; };
  }, [hdEnabled, content, nodeId]);

  // Prefetches the narration file for every node this one's choices could
  // lead to, while the player is still reading/listening to THIS node —
  // "preload the next page before it starts." Writes into the same
  // persistent Cache Storage as cachedAudioUrl() above, so it's not just a
  // fleeting HTTP cache warm-up: whichever branch gets chosen is already
  // fully offline-available by the time the player taps it, and stays
  // that way. This is the one deliberate exception to "only cache what's
  // actually visited" — one hop ahead, not the whole tree.
  useEffect(() => {
    if (!narrationOn || !activeStory || !content || !nodeId) return;
    const node = content.graph.nodes[nodeId];
    if (!node?.choices) return;
    node.choices.forEach((choice) => {
      const key = `${activeStory.id}/${language}/${choice.goto}`;
      if (prefetchedNarrationRef.current.has(key)) return;
      prefetchedNarrationRef.current.add(key);
      warmAudioCache(`${AUDIO_BASE}/${key}.wav`);
    });
  }, [narrationOn, activeStory, language, content, nodeId]);

  const toggleNarration = () => {
    setNarrationOn((prev) => {
      const next = !prev;
      localStorage.setItem(NARRATION_PREF_KEY, next ? "on" : "off");
      if (!next) { audioRef.current?.pause(); ambienceRef.current?.pause(); }
      return next;
    });
  };

  // Shows a brief small-win banner whenever the current node carries one —
  // fires on choice clicks and on resume, so a win earned in a past
  // session still gets its own moment when reached, not just on first hit.
  useEffect(() => {
    if (!content || !nodeId) return;
    const node = content.graph.nodes[nodeId];
    if (!node?.win) return;
    setWinBanner(node.win.label);
    const t = setTimeout(() => setWinBanner(null), 3200);
    return () => clearTimeout(t);
  }, [content, nodeId]);

  const currentFlags = () => progressByStory[activeStory?.id]?.flags || {};

  const choose = (goto) => {
    // Cuts any choices still being read aloud immediately — previously
    // that audio kept playing over the new page loading, which is what
    // made tapping a choice feel slow/unresponsive even though the text
    // itself had already moved on.
    stopChoiceSpeech();
    const node = content.graph.nodes[goto];
    setNodeId(goto);
    saveProgress(activeStory, language, goto, node, currentFlags());
  };

  const restart = () => {
    stopChoiceSpeech();
    const startId = content.graph.startNode;
    setNodeId(startId);
    saveProgress(activeStory, language, startId, content.graph.nodes[startId], {});
  };

  const backToList = () => {
    setScreen("list");
    setActiveStory(null);
    setContent(null);
    setNodeId(null);
  };

  if (screen === "language") {
    return (
      <div className="max-w-md mx-auto pt-6">
        <button onClick={backToList} className="flex items-center gap-1.5 text-sm font-semibold mb-4" style={{ color: c.textDim }}>
          <ArrowLeft size={15} /> Back
        </button>
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none mb-1">{activeStory.default_title}</h1>
        <p className="text-sm mb-5" style={{ color: c.textFaint }}>Choose a language to play in</p>
        <div className="flex flex-col gap-2">
          {activeStory.languages.map((lang) => (
            <button key={lang} onClick={() => loadContent(activeStory, lang)}
              className="flex items-center gap-3 rounded-xl px-4 py-3.5 text-left font-semibold"
              style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              <Globe size={16} style={{ color: c.accent }} />
              {languageLabel(lang)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (screen === "play") {
    if (loadingContent || !content || !nodeId) {
      return <div className="text-center pt-16 text-sm" style={{ color: c.textFaint }}>Loading…</div>;
    }
    const node = content.graph.nodes[nodeId];
    const isEnding = !!node.ending;
    return (
      <div className="max-w-md mx-auto pt-6">
        <div className="flex items-center justify-between mb-4">
          <button onClick={backToList} className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: c.textDim }}>
            <ArrowLeft size={15} /> Stories
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { const next = !hdEnabled; setHdVoiceEnabled(next); setHdEnabledState(next); }}
              className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-2 py-1.5 rounded-full"
              style={{ background: c.surface, border: `1px solid ${c.border}`, color: hdEnabled ? c.accent : c.textFaint }}
              title={`HD voice for choices (${getVoiceTier() === "hd" ? "~86MB, best quality" : "~20-60MB, lighter"}) — downloads once, opt-in`}
            >
              <Sparkles size={11} /> HD
            </button>
            <button onClick={toggleNarration} aria-label={narrationOn ? "Mute narration" : "Unmute narration"}
              className="flex items-center justify-center w-8 h-8 rounded-full" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              {narrationOn ? <Volume2 size={15} style={{ color: c.accent }} /> : <VolumeX size={15} style={{ color: c.textFaint }} />}
            </button>
          </div>
        </div>
        <audio ref={audioRef} className="hidden" />
        <audio ref={ambienceRef} className="hidden" />
        {winBanner && (
          <div className="rounded-xl px-4 py-2.5 mb-3 text-sm font-semibold text-center animate-pulse"
            style={{ background: c.accent, color: c.accentText }}>
            ✨ {winBanner}
          </div>
        )}
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>
          {content.title} · {languageLabel(language)}
        </div>
        <div className="rounded-2xl p-5 mb-4" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
          {/* scene.pose is optional per node — authors can skip it entirely
              and the character just stays idle. Keeps writing a story a
              purely-text task; animation is opt-in set dressing on top. */}
          <PlayerCharacter pose={node.scene?.pose} kitColor={c.accent} />
          <p className="text-base leading-relaxed text-center mt-3">
            {node.lines ? node.lines.map((l) => l.text).join(" ") : node.text}
          </p>
        </div>
        {isEnding ? (
          <div className="flex flex-col gap-2">
            {node.ending === "cliffhanger" ? (
              <div className="text-center mb-1">
                <div className="text-sm font-extrabold uppercase tracking-[0.15em]" style={{ color: c.accent }}>
                  To be continued
                </div>
                {node.nextEpisode && (
                  <div className="text-xs mt-1" style={{ color: c.textFaint }}>Next: {node.nextEpisode}</div>
                )}
              </div>
            ) : (
              <div className="text-sm font-bold uppercase tracking-wide mb-1" style={{ color: node.ending === "success" ? c.green : c.textDim }}>
                {node.ending === "success" ? "Task accomplished" : "Ending reached"}
              </div>
            )}
            <button onClick={restart} className="flex items-center justify-center gap-2 rounded-xl py-3 font-bold"
              style={{ background: c.accent, color: c.accentText }}>
              <RotateCcw size={15} /> Play again
            </button>
            <button onClick={backToList} className="rounded-xl py-3 font-semibold" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              Back to Stories
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button onClick={() => speakChoices(node.choices)}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold self-center mb-1" style={{ color: c.textFaint }}>
              <Volume2 size={12} />
              {hdLoading ? `Loading HD voice… ${Math.round(hdProgress * 100)}%` : speakingChoices ? "Tap to stop" : "Hear your options"}
            </button>
            {node.choices.map((choice, i) => (
              <button key={i} onClick={() => choose(choice.goto)}
                className="text-left rounded-xl px-4 py-3 font-semibold"
                style={{ background: c.surface, border: `1px solid ${c.border}` }}>
                {choice.text}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // List screen
  return (
    <div className="max-w-md mx-auto pt-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-semibold mb-4" style={{ color: c.textDim }}>
        <ArrowLeft size={15} /> Back
      </button>
      <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none mb-1">Stories</h1>
      <p className="text-sm mb-5" style={{ color: c.textFaint }}>Short branching stories — pick your language and play.</p>

      {stories === null ? (
        <div className="text-center pt-10 text-sm" style={{ color: c.textFaint }}>Loading…</div>
      ) : stories.length === 0 ? (
        <div className="text-center pt-10 text-sm" style={{ color: c.textFaint }}>No stories yet — check back soon.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {stories.map((story) => {
            const progress = progressByStory[story.id];
            return (
              <button key={story.id} onClick={() => openStory(story)}
                className="flex items-center gap-3 rounded-2xl p-4 text-left"
                style={{ background: c.surface, border: `1px solid ${c.border}` }}>
                <span className="w-11 h-11 rounded-full flex items-center justify-center text-xl shrink-0" style={{ background: c.surfaceHover }}>
                  {story.emoji || "📖"}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-bold truncate">{story.default_title}</span>
                  <span className="block text-xs" style={{ color: c.textFaint }}>
                    {progress?.completed ? "Completed — tap to play again" : progress ? "In progress — tap to continue" : `${story.languages.length} language${story.languages.length === 1 ? "" : "s"} available`}
                  </span>
                </span>
                <Play size={16} style={{ color: c.accent }} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
