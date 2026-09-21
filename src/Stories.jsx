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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: storyRows } = await supabase
        .from("game_stories")
        .select("id, slug, default_title, emoji, languages")
        .order("sort_order", { ascending: true });

      const { data: progressRows } = await supabase
        .from("game_story_progress")
        .select("story_id, language, current_node_id, completed, ending_id")
        .eq("user_id", session.user.id);

      if (cancelled) return;
      setStories(storyRows || []);
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
    const { data, error } = await supabase
      .from("game_story_content")
      .select("title, graph")
      .eq("story_id", story.id)
      .eq("language", lang)
      .maybeSingle();
    setLoadingContent(false);
    if (error || !data) { showToast?.("Couldn't load that story — try again."); return; }
    setContent(data);
    const existing = progressByStory[story.id];
    const startId = (existing && existing.language === lang && !existing.completed)
      ? existing.current_node_id
      : data.graph.startNode;
    setNodeId(startId);
    setScreen("play");
  }, [progressByStory, showToast]);

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

  // Plays the current node's pre-generated narration, if any exists yet.
  // A 404 (audio not synthesized for this node) is expected and silent —
  // text is always the complete experience on its own.
  useEffect(() => {
    if (!narrationOn || !activeStory || !nodeId) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = `${AUDIO_BASE}/${activeStory.id}/${language}/${nodeId}.wav`;
    audio.play().catch(() => { /* missing file or autoplay blocked — fine, stay silent */ });
    return () => { audio.pause(); };
  }, [narrationOn, activeStory, language, nodeId]);

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
    if (!node?.ambience) { ambience.pause(); return; }
    const src = `${SFX_BASE}/${node.ambience}.mp3`;
    if (!ambience.src.endsWith(`${node.ambience}.mp3`)) {
      ambience.src = src;
      ambience.loop = true;
      ambience.volume = 0.18;
    }
    ambience.play().catch(() => { /* missing sfx file yet — silent, no ambience this node */ });
  }, [narrationOn, content, nodeId]);

  // One-shot sound effects: a short list of tags per node (footsteps, a
  // dog bark, a phone buzz), played once when the node is reached. Missing
  // files fail silently — same principle as narration and ambience,
  // sound is always an enhancement, never required.
  useEffect(() => {
    if (!narrationOn || !content || !nodeId) return;
    const node = content.graph.nodes[nodeId];
    if (!node?.sfx?.length) return;
    node.sfx.forEach((tag, i) => {
      const el = new Audio(`${SFX_BASE}/${tag}.mp3`);
      el.volume = 0.5;
      setTimeout(() => { el.play().catch(() => {}); }, i * 300);
    });
  }, [narrationOn, content, nodeId]);

  const [hdEnabled, setHdEnabledState] = useState(() => isHdVoiceEnabled());
  const [hdLoading, setHdLoading] = useState(false);
  const [hdProgress, setHdProgress] = useState(0);
  const [speakingChoices, setSpeakingChoices] = useState(false);
  const speakingChoicesRef = useRef(false);
  const choiceAudioRef = useRef(null);

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
        setHdLoading(!neuralVoiceReady());
        const engine = await loadNeuralVoice((frac) => setHdProgress(frac));
        setHdLoading(false);
        for (const [i, choice] of choices.entries()) {
          if (!speakingChoicesRef.current) return; // stopped mid-sequence
          const { blob } = await engine.speak(`Option ${i + 1}. ${choice.text}`);
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
    const node = content.graph.nodes[goto];
    setNodeId(goto);
    saveProgress(activeStory, language, goto, node, currentFlags());
  };

  const restart = () => {
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
