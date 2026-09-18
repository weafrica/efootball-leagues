import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Play, Globe, RotateCcw } from "lucide-react";
import { supabase } from "./supabaseClient";

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

  const saveProgress = useCallback(async (story, lang, id, node) => {
    const isEnding = !!node.ending;
    await supabase.from("game_story_progress").upsert({
      user_id: session.user.id,
      story_id: story.id,
      language: lang,
      current_node_id: id,
      completed: isEnding,
      ending_id: isEnding ? node.ending : null,
      updated_at: new Date().toISOString(),
    });
    setProgressByStory((prev) => ({
      ...prev,
      [story.id]: { story_id: story.id, language: lang, current_node_id: id, completed: isEnding, ending_id: isEnding ? node.ending : null },
    }));
  }, [session.user.id]);

  const choose = (goto) => {
    const node = content.graph.nodes[goto];
    setNodeId(goto);
    saveProgress(activeStory, language, goto, node);
  };

  const restart = () => {
    const startId = content.graph.startNode;
    setNodeId(startId);
    saveProgress(activeStory, language, startId, content.graph.nodes[startId]);
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
        <button onClick={backToList} className="flex items-center gap-1.5 text-sm font-semibold mb-4" style={{ color: c.textDim }}>
          <ArrowLeft size={15} /> Stories
        </button>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>
          {content.title} · {languageLabel(language)}
        </div>
        <div className="rounded-2xl p-5 mb-4" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
          <p className="text-base leading-relaxed">{node.text}</p>
        </div>
        {isEnding ? (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-bold uppercase tracking-wide mb-1" style={{ color: node.ending === "success" ? c.green : c.textDim }}>
              {node.ending === "success" ? "Task accomplished" : "Ending reached"}
            </div>
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
