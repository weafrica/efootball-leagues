// The two front doors of the standalone Stories app (mounted by
// src/StoriesApp.jsx at /stories/):
//   StoriesLanding — public, shown to anyone not signed in: what Stories is,
//                    a live demo of the green read-along, and the sign-in ask.
//   StoriesHome    — shown once signed in: continue where you left off, plus
//                    the whole library as cards.
// Stories themselves stay behind sign-in, same as in the Matchday app.

import React, { useEffect, useState } from "react";
import { BookOpen, Headphones, Sparkles, Globe, GitBranch, Play, Download, ChevronRight } from "lucide-react";

const DEMO_WORDS = "The final whistle was seconds away, and every eye was on you.".split(" ");

// A sentence whose words light up green one after another — the same
// highlight the reader uses, shown without needing an account.
function ReadAlongDemo({ c }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % (DEMO_WORDS.length + 3)), 420);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="text-lg leading-relaxed text-center font-semibold" style={{ color: c.text }}>
      <span style={{ background: c.greenSoft, borderRadius: 6, padding: "2px 4px" }}>
        {DEMO_WORDS.map((w, k) => (
          <React.Fragment key={k}>
            <span style={k === i ? { background: c.green, color: "#fff", borderRadius: 4, padding: "0 3px" } : undefined}>{w}</span>
            {k < DEMO_WORDS.length - 1 ? " " : ""}
          </React.Fragment>
        ))}
      </span>
    </p>
  );
}

const FEATURES = [
  { icon: Headphones, title: "Hear every page", text: "Narrated by a full cast of voices — listen like an audiobook, or read in silence." },
  { icon: Sparkles, title: "Follow along", text: "The words light up green as they're spoken, so you never lose your place." },
  { icon: GitBranch, title: "Choose your path", text: "You decide what happens next. Different choices lead to different endings." },
  { icon: Globe, title: "Your language", text: "Pick the language you want to read and hear each story in." },
];

export function StoriesLanding({ c, onSignIn, onMatchday }) {
  return (
    <div className="pt-8 pb-16">
      <section className="text-center max-w-xl mx-auto">
        <div className="font-mono text-[11px] tracking-[0.25em] uppercase mb-3" style={{ color: c.accent }}>WeAfrica Stories</div>
        <h1 className="text-4xl sm:text-5xl font-extrabold uppercase tracking-tight leading-[0.95] mb-4">
          Stories you can read, hear and play
        </h1>
        <p className="text-base mb-7" style={{ color: c.textDim }}>
          Short stories where you make the choices. Listen to every page, follow the words as they're read, and play it in your own language.
        </p>
        <button onClick={onSignIn} className="inline-flex items-center gap-2 font-semibold px-7 py-3.5 rounded-full text-base"
          style={{ background: c.accent, color: c.accentText }}>
          <BookOpen size={18} /> Sign in to start reading
        </button>
        <div className="text-xs mt-3" style={{ color: c.textFaint }}>Free · sign in with Google · same account as Matchday</div>
      </section>

      <section className="max-w-xl mx-auto mt-10 rounded-2xl p-6" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
        <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-center mb-3" style={{ color: c.textFaint }}>Here's how it reads</div>
        <ReadAlongDemo c={c} />
      </section>

      <section className="max-w-3xl mx-auto mt-10 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="flex gap-3 rounded-2xl p-4" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            <span className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: c.greenSoft }}>
              <Icon size={18} style={{ color: c.greenText }} />
            </span>
            <div>
              <div className="font-bold">{title}</div>
              <div className="text-sm" style={{ color: c.textDim }}>{text}</div>
            </div>
          </div>
        ))}
      </section>

      <div className="text-center mt-10">
        <button onClick={onMatchday} className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: c.textDim }}>
          Looking for leagues and the ladder? Open Matchday <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export function StoriesHome({ stories, progressByStory, openStory, session, audiobookBase, onMatchday, c }) {
  const list = stories || [];
  const inProgress = list.find((s) => progressByStory[s.id] && !progressByStory[s.id].completed);
  const finished = list.filter((s) => progressByStory[s.id]?.completed).length;
  const name = (session?.user?.user_metadata?.full_name || "").split(" ")[0];

  return (
    <div className="pt-6 pb-16">
      <section className="mb-6">
        <div className="font-mono text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: c.accent }}>WeAfrica Stories</div>
        <h1 className="text-3xl font-extrabold uppercase tracking-tight leading-none">{name ? `Welcome back, ${name}` : "Welcome back"}</h1>
        {list.length > 0 && (
          <p className="text-sm mt-2" style={{ color: c.textDim }}>
            {finished > 0 ? `${finished} of ${list.length} stor${list.length === 1 ? "y" : "ies"} finished.` : `${list.length} stor${list.length === 1 ? "y" : "ies"} to play.`}
          </p>
        )}
      </section>

      {inProgress && (
        <button onClick={() => openStory(inProgress)} className="w-full flex items-center gap-4 rounded-2xl p-5 mb-6 text-left"
          style={{ background: `linear-gradient(120deg, ${c.greenSoft}, ${c.surface})`, border: `1px solid ${c.green}` }}>
          <span className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl shrink-0" style={{ background: c.surfaceHover }}>{inProgress.emoji || "📖"}</span>
          <span className="flex-1 min-w-0">
            <span className="block font-mono text-[10px] tracking-[0.2em] uppercase" style={{ color: c.greenText }}>Continue reading</span>
            <span className="block text-lg font-extrabold truncate">{inProgress.default_title}</span>
          </span>
          <span className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: c.green }}>
            <Play size={16} color="#fff" />
          </span>
        </button>
      )}

      <div className="font-mono text-[11px] tracking-[0.2em] uppercase mb-3" style={{ color: c.textFaint }}>All stories</div>
      {stories === null ? (
        <div className="text-center pt-10 text-sm" style={{ color: c.textFaint }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="text-center pt-10 text-sm" style={{ color: c.textFaint }}>No stories yet — check back soon.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {list.map((story) => {
            const progress = progressByStory[story.id];
            return (
              <div key={story.id} className="flex flex-col rounded-2xl overflow-hidden" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
                <button onClick={() => openStory(story)} className="flex items-center gap-3 p-4 text-left">
                  <span className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl shrink-0" style={{ background: c.surfaceHover }}>{story.emoji || "📖"}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-bold leading-tight">{story.default_title}</span>
                    <span className="block text-xs mt-1" style={{ color: c.textFaint }}>
                      {progress?.completed ? "Finished — play again" : progress ? "In progress" : `${story.languages.length} language${story.languages.length === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <ChevronRight size={18} style={{ color: c.accent }} />
                </button>
                {story.audiobook_path && (
                  <a href={`${audiobookBase}/${story.audiobook_path}`} download
                    className="flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 border-t" style={{ color: c.accent, borderColor: c.border }}>
                    <Download size={13} /> Download the audiobook
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="text-center mt-10">
        <button onClick={onMatchday} className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: c.textDim }}>
          Open Matchday — leagues, ladder and more <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
