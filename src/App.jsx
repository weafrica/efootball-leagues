import React, { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "./supabaseClient";
import {
  Trophy, Plus, Users, Calendar, ShieldCheck, ChevronRight, X, Check,
  ArrowLeft, Swords, Settings2, Moon, Sun, LogOut,
} from "lucide-react";

const THEME_KEY = "efootball-theme-v1";

const THEMES = {
  dark: {
    bg: "#0B1F17", surface: "rgba(241,250,238,0.045)", surfaceHover: "rgba(241,250,238,0.08)",
    border: "rgba(241,250,238,0.10)", borderStrong: "rgba(241,250,238,0.18)", text: "#F1FAEE",
    textDim: "rgba(241,250,238,0.55)", textFaint: "rgba(241,250,238,0.35)", accent: "#E9C46A",
    accentText: "#0B1F17", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
    red: "#E63946", toastBg: "#F1FAEE", toastText: "#0B1F17",
  },
  light: {
    bg: "#F6F5F0", surface: "rgba(14,42,32,0.04)", surfaceHover: "rgba(14,42,32,0.07)",
    border: "rgba(14,42,32,0.10)", borderStrong: "rgba(14,42,32,0.18)", text: "#0E2A20",
    textDim: "rgba(14,42,32,0.6)", textFaint: "rgba(14,42,32,0.4)", accent: "#B4802E",
    accentText: "#F6F5F0", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.15)", greenText: "#1F6B45",
    red: "#C4293A", toastBg: "#0E2A20", toastText: "#F6F5F0",
  },
};

function roundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 !== 0) ids.push(null);
  const n = ids.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const home = ids[i];
      const away = ids[n - 1 - i];
      if (home !== null && away !== null) round.push({ home, away });
    }
    rounds.push(round);
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

function doubleRoundRobin(teamIds) {
  const firstLeg = roundRobin(teamIds);
  const secondLeg = firstLeg.map((round) =>
    round.map(({ home, away }) => ({ home: away, away: home }))
  );
  return [...firstLeg, ...secondLeg];
}

function computeStandings(teams, fixtures) {
  const table = {};
  teams.forEach((t) => { table[t.id] = { id: t.id, name: t.name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }; });
  fixtures.forEach((f) => {
    if (!f.played) return;
    const h = table[f.home_team_id];
    const a = table[f.away_team_id];
    if (!h || !a) return;
    h.p++; a.p++;
    h.gf += f.home_score; h.ga += f.away_score;
    a.gf += f.away_score; a.ga += f.home_score;
    if (f.home_score > f.away_score) { h.w++; h.pts += 3; a.l++; }
    else if (f.home_score < f.away_score) { a.w++; a.pts += 3; h.l++; }
    else { h.d++; a.d++; h.pts += 1; a.pts += 1; }
  });
  const rows = Object.values(table);
  rows.forEach((r) => { r.gd = r.gf - r.ga; });
  rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
  return rows;
}

function Loader({ c }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 rounded-full animate-spin" style={{ border: `2px solid ${c.green}`, borderTopColor: "transparent" }} />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [isAdmin, setIsAdmin] = useState(false);
  const [leagues, setLeagues] = useState(null);
  const [view, setView] = useState("home");
  const [activeLeagueId, setActiveLeagueId] = useState(null);
  const [toast, setToast] = useState(null);
  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "dark");
  const c = THEMES[theme];

  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  const signInWithGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setView("home");
  };

  const loadLeagues = useCallback(async () => {
    const { data, error } = await supabase
      .from("leagues")
      .select("*, teams(*), fixtures(*), members(*)")
      .order("created_at", { ascending: false });
    if (error) { showToast("Couldn't load leagues."); setLeagues([]); return; }
    setLeagues(data || []);
  }, [showToast]);

  useEffect(() => {
    if (session === undefined) return;
    if (!session) { setLeagues(null); setIsAdmin(false); return; }
    supabase.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
    loadLeagues();
  }, [session, loadLeagues]);

  const activeLeague = useMemo(
    () => (leagues || []).find((l) => l.id === activeLeagueId) || null,
    [leagues, activeLeagueId]
  );

  const isMemberOf = (league) => {
    if (!session) return false;
    if (league.created_by === session.user.id) return true;
    return (league.members || []).some((m) => m.user_id === session.user.id);
  };

  const createLeague = async ({ name, teamNames }) => {
    const { data: league, error } = await supabase
      .from("leagues")
      .insert({ name, created_by: session.user.id })
      .select()
      .single();
    if (error) { showToast(`Couldn't create league: ${error.message}`); console.error(error); return; }

    const { data: teams, error: teamErr } = await supabase
      .from("teams")
      .insert(teamNames.map((n) => ({ league_id: league.id, name: n })))
      .select();
    if (teamErr) { showToast(`Couldn't add clubs: ${teamErr.message}`); console.error(teamErr); return; }

    const rounds = doubleRoundRobin(teams.map((t) => t.id));
    const fixtureRows = [];
    rounds.forEach((round, ri) => {
      round.forEach(({ home, away }) => {
        fixtureRows.push({ league_id: league.id, round: ri + 1, home_team_id: home, away_team_id: away });
      });
    });

    const CHUNK_SIZE = 500;
    for (let i = 0; i < fixtureRows.length; i += CHUNK_SIZE) {
      const chunk = fixtureRows.slice(i, i + CHUNK_SIZE);
      const { error: fxErr } = await supabase.from("fixtures").insert(chunk);
      if (fxErr) {
        showToast(`Fixtures failed partway (${i} of ${fixtureRows.length} saved): ${fxErr.message}`);
        console.error(fxErr);
        return;
      }
    }

    await loadLeagues();
    setActiveLeagueId(league.id);
    setView("league");
    showToast(`League created with ${fixtureRows.length} fixtures.`);
  };

  const [pendingJoinId, setPendingJoinId] = useState(null);
  const requestJoin = (leagueId) => { setPendingJoinId(leagueId); setNameModalOpen(true); };

  const joinLeague = async (leagueId, name, phone) => {
    const { error } = await supabase.from("members").insert({
      league_id: leagueId, user_id: session.user.id, display_name: name, phone: phone || null,
    });
    if (error) { showToast("Couldn't join — you may already be a member."); return; }
    await loadLeagues();
    showToast(`Joined as ${name}.`);
  };

  const confirmJoin = async (name, phone) => {
    setNameModalOpen(false);
    if (pendingJoinId) { await joinLeague(pendingJoinId, name, phone); setPendingJoinId(null); }
  };

  const recordResult = async (fixtureId, homeScore, awayScore) => {
    const { error } = await supabase
      .from("fixtures")
      .update({ played: true, home_score: homeScore, away_score: awayScore })
      .eq("id", fixtureId);
    if (error) { showToast("Couldn't save result."); return; }
    await loadLeagues();
  };

  const updateTeamPhone = async (teamId, phone) => {
    const { error } = await supabase.from("teams").update({ phone }).eq("id", teamId);
    if (error) { showToast("Couldn't save number."); return; }
    await loadLeagues();
  };

  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: THEMES.dark.bg }}><Loader c={THEMES.dark} /></div>;
  }

  if (!session) {
    return <LoginScreen c={c} theme={theme} toggleTheme={toggleTheme} onSignIn={signInWithGoogle} />;
  }

  return (
    <div className="min-h-screen transition-colors duration-200" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <Header view={view} setView={setView} activeLeague={activeLeague} theme={theme} toggleTheme={toggleTheme} c={c} onSignOut={signOut} userEmail={session.user.email} />
      <main className="max-w-3xl mx-auto px-4 pb-24">
        {leagues === null ? <Loader c={c} /> : (
          <>
            {view === "home" && (
              <Home leagues={leagues} session={session} isAdmin={isAdmin} isMemberOf={isMemberOf}
                onOpen={(id) => { setActiveLeagueId(id); setView("league"); }}
                onCreate={() => setView("create")} onJoin={requestJoin} c={c} />
            )}
            {view === "create" && <CreateLeague onCancel={() => setView("home")} onCreate={createLeague} c={c} />}
            {view === "league" && activeLeague && (
              <LeagueDetail league={activeLeague} joined={isMemberOf(activeLeague)}
                onBack={() => setView("home")} onJoin={() => requestJoin(activeLeague.id)}
                onRecordResult={recordResult} onUpdateTeamPhone={updateTeamPhone} c={c} />
            )}
          </>
        )}
      </main>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full font-body text-sm font-medium shadow-lg z-50" style={{ background: c.toastBg, color: c.toastText }}>
          {toast}
        </div>
      )}
      {nameModalOpen && <NameModal onCancel={() => setNameModalOpen(false)} onConfirm={confirmJoin} c={c} defaultName={session.user.user_metadata?.full_name || ""} />}
    </div>
  );
}

function LoginScreen({ c, theme, toggleTheme, onSignIn }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <button onClick={toggleTheme} className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-5" style={{ background: c.green }}>
        <Trophy size={26} color={c.accent} />
      </div>
      <h1 className="text-4xl font-extrabold uppercase tracking-tight text-center leading-none mb-2">Matchday</h1>
      <p className="font-body text-center max-w-xs mb-8" style={{ color: c.textDim }}>
        Sign in to create leagues, join fixtures, and track your table.
      </p>
      <button onClick={onSignIn} className="flex items-center gap-3 font-body font-semibold px-6 py-3 rounded-full" style={{ background: c.accent, color: c.accentText }}>
        <GoogleIcon /> Continue with Google
      </button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z" />
      <path fill="#FBBC05" d="M3.97 10.73a5.4 5.4 0 010-3.46V4.94H.96a9 9 0 000 8.12l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function Header({ view, setView, activeLeague, theme, toggleTheme, c, onSignOut, userEmail }) {
  return (
    <header className="border-b sticky top-0 backdrop-blur z-40" style={{ borderColor: c.border, background: `${c.bg}F2` }}>
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
        <button onClick={() => setView("home")} className="flex items-center gap-2">
          <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: c.green }}><Trophy size={16} color={c.accent} /></div>
          <div className="text-lg font-extrabold tracking-tight uppercase">Matchday</div>
        </button>
        {view === "league" && activeLeague && (
          <div className="hidden sm:block font-mono text-xs uppercase tracking-wider" style={{ color: c.textFaint }}>
            {activeLeague.teams.length} clubs · {activeLeague.fixtures.filter((f) => f.played).length}/{activeLeague.fixtures.length} played
          </div>
        )}
        <div className="flex items-center gap-2">
          <button onClick={toggleTheme} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button onClick={onSignOut} title={userEmail} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}

function Home({ leagues, session, isAdmin, isMemberOf, onOpen, onCreate, onJoin, c }) {
  return (
    <div>
      <section className="pt-10 pb-6">
        <div className="font-mono text-xs tracking-[0.2em] uppercase mb-2" style={{ color: c.accent }}>Season 2026</div>
        <h1 className="text-4xl sm:text-5xl font-extrabold uppercase tracking-tight leading-[0.95]">Run your table.<br />Own your league.</h1>
        <p className="font-body mt-3 max-w-md" style={{ color: c.textDim }}>
          {isAdmin ? "Leagues you create here are public. " : ""}Create an eFootball league, invite people to join, log results — the table updates itself.
        </p>
        <button onClick={onCreate} className="mt-5 inline-flex items-center gap-2 font-body font-semibold px-5 py-2.5 rounded-full" style={{ background: c.accent, color: c.accentText }}>
          <Plus size={16} strokeWidth={2.5} /> New league
        </button>
      </section>
      <section>
        <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>{leagues.length ? "Your leagues" : "No leagues yet"}</div>
        {leagues.length === 0 && (
          <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>Start the first one — it takes about a minute.</div>
        )}
        <div className="space-y-2">
          {leagues.map((l) => {
            const played = l.fixtures.filter((f) => f.played).length;
            const joined = isMemberOf(l);
            const leader = computeStandings(l.teams, l.fixtures)[0];
            return (
              <div key={l.id} onClick={() => onOpen(l.id)} className="rounded-xl p-4 flex items-center justify-between cursor-pointer border" style={{ background: c.surface, borderColor: c.border }}>
                <div>
                  <div className="font-semibold text-lg leading-tight">{l.name}</div>
                  <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>
                    {l.teams.length} clubs · {played}/{l.fixtures.length} played{leader && leader.p > 0 ? ` · ${leader.name} leads` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {joined ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Joined</span>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); onJoin(l.id); }} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border" style={{ borderColor: c.borderStrong }}>Join</button>
                  )}
                  <ChevronRight size={18} style={{ color: c.textFaint }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function CreateLeague({ onCancel, onCreate, c }) {
  const [name, setName] = useState("");
  const [teamsText, setTeamsText] = useState("");
  const teamNames = teamsText.split("\n").map((t) => t.trim()).filter(Boolean);
  const canCreate = name.trim().length > 0 && teamNames.length >= 2;
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };
  return (
    <div className="pt-10">
      <button onClick={onCancel} className="flex items-center gap-1.5 font-body text-sm mb-6" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight mb-1">New league</h1>
      <p className="font-body mb-6 text-sm" style={{ color: c.textDim }}>A full round-robin fixture list is generated automatically.</p>
      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friday Night eFootball Cup" className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-5" style={inputStyle} />
      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Clubs <span style={{ color: c.textFaint }}>(one per line, min. 2)</span></label>
      <textarea value={teamsText} onChange={(e) => setTeamsText(e.target.value)} rows={8} placeholder={"Real Madrid\nManchester City\nAl Nassr\nBoca Juniors"} className="w-full border rounded-lg px-4 py-2.5 font-body outline-none resize-none" style={inputStyle} />
      <div className="font-mono text-xs mt-1.5" style={{ color: c.textFaint }}>{teamNames.length} club{teamNames.length === 1 ? "" : "s"} · {teamNames.length >= 2 ? teamNames.length * (teamNames.length - 1) : 0} fixtures</div>
      <button disabled={!canCreate} onClick={() => onCreate({ name: name.trim(), teamNames })} className="mt-6 w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full" style={canCreate ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
        <Trophy size={16} /> Create league
      </button>
    </div>
  );
}

function NameModal({ onCancel, onConfirm, c, defaultName }) {
  const [name, setName] = useState(defaultName || "");
  const [phone, setPhone] = useState("");
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="border rounded-2xl p-6 w-full max-w-sm" style={{ background: c.bg, borderColor: c.borderStrong }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg uppercase tracking-tight">Join league</h3>
          <button onClick={onCancel}><X size={18} style={{ color: c.textDim }} /></button>
        </div>
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-4" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Phone <span style={{ color: c.textFaint }}>(optional)</span></label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. +1 555 123 4567" type="tel" className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-4" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button disabled={!name.trim()} onClick={() => onConfirm(name.trim(), phone.trim())} className="w-full font-body font-semibold px-4 py-2.5 rounded-full" style={name.trim() ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>Join league</button>
      </div>
    </div>
  );
}

function LeagueDetail({ league, joined, onBack, onJoin, onRecordResult, onUpdateTeamPhone, c }) {
  const [tab, setTab] = useState("table");
  const standings = useMemo(() => computeStandings(league.teams, league.fixtures), [league]);
  const getTeam = (id) => league.teams.find((t) => t.id === id) || { name: "—", phone: "" };
  const totalRounds = Math.max(...league.fixtures.map((f) => f.round), 0);
  const n = standings.length;
  const zoneFor = (idx) => {
    if (idx === 0 && n > 4) return c.accent;
    if (idx < Math.ceil(n / 3) && n > 6) return c.green;
    if (idx >= n - Math.max(1, Math.floor(n / 4)) && n > 6) return c.red;
    return "transparent";
  };

  return (
    <div className="pt-8">
      <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-3xl font-extrabold uppercase tracking-tight leading-none">{league.name}</h1>
          <div className="font-mono text-xs mt-2" style={{ color: c.textFaint }}>{league.teams.length} clubs · {league.members.length} member{league.members.length === 1 ? "" : "s"}</div>
        </div>
        {!joined && <button onClick={onJoin} className="shrink-0 flex items-center gap-1.5 font-body font-semibold text-sm px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}><Users size={14} /> Join</button>}
      </div>
      <div className="flex gap-1 mb-5 rounded-full p-1 w-fit" style={{ background: c.surface }}>
        {[{ id: "table", label: "Table", icon: Trophy }, { id: "fixtures", label: "Fixtures", icon: Calendar }, { id: "members", label: "Members", icon: Users }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-body text-xs font-semibold uppercase tracking-wide" style={tab === t.id ? { background: c.text, color: c.bg } : { color: c.textDim }}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "table" && (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full font-mono text-sm min-w-[460px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider border-b" style={{ color: c.textFaint, borderColor: c.border }}>
                <th className="text-left py-2 pl-2 font-medium">#</th><th className="text-left py-2 font-medium">Club</th>
                <th className="text-center py-2 font-medium">P</th><th className="text-center py-2 font-medium">W</th>
                <th className="text-center py-2 font-medium">D</th><th className="text-center py-2 font-medium">L</th>
                <th className="text-center py-2 font-medium">GD</th><th className="text-center py-2 pr-2 font-medium">Pts</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((r, i) => (
                <tr key={r.id} className="border-b" style={{ borderColor: c.border }}>
                  <td className="py-2.5 pl-2 relative"><span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: zoneFor(i) }} /><span style={{ color: c.textFaint }}>{i + 1}</span></td>
                  <td className="py-2.5 font-body font-medium">{r.name}</td>
                  <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.p}</td>
                  <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.w}</td>
                  <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.d}</td>
                  <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.l}</td>
                  <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                  <td className="text-center py-2.5 pr-2 font-bold">{r.pts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "fixtures" && (
        <div className="space-y-6">
          {joined && (
            <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Player contacts</div>
              <div className="space-y-2">
                {league.teams.map((t) => <TeamContactRow key={t.id} team={t} onUpdateTeamPhone={onUpdateTeamPhone} c={c} />)}
              </div>
            </div>
          )}
          {Array.from({ length: totalRounds }, (_, i) => i + 1).map((round) => (
            <div key={round}>
              <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Round {round}</div>
              <div className="space-y-1.5">
                {league.fixtures.filter((f) => f.round === round).map((f) => (
                  <FixtureRow key={f.id} fixture={f} getTeam={getTeam} joined={joined} onRecord={onRecordResult} c={c} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "members" && (
        <div>
          {league.members.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's joined yet.</div>
          ) : (
            <div className="space-y-1.5">
              {league.members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
                  <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{m.display_name[0]?.toUpperCase()}</div>
                  <span className="font-body text-sm flex-1">{m.display_name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TeamContactRow({ team, onUpdateTeamPhone, c }) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(team.phone || "");
  useEffect(() => { setPhone(team.phone || ""); }, [team.phone]);
  if (editing) {
    return (
      <div className="flex items-center gap-2 font-body text-sm">
        <span className="flex-1 truncate">{team.name}</span>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" type="tel" className="w-40 rounded font-mono text-xs px-2 py-1 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
        <button onClick={() => { onUpdateTeamPhone(team.id, phone.trim()); setEditing(false); }} style={{ color: c.greenText }} className="p-1"><Check size={15} /></button>
        <button onClick={() => setEditing(false)} style={{ color: c.textFaint }} className="p-1"><X size={15} /></button>
      </div>
    );
  }
  return (
    <div onClick={() => setEditing(true)} className="flex items-center gap-2 font-body text-sm cursor-pointer">
      <span className="flex-1 truncate">{team.name}</span>
      {team.phone ? <span className="font-mono text-xs" style={{ color: c.textDim }}>{team.phone}</span> : <span className="font-mono text-xs" style={{ color: c.textFaint }}>Add number</span>}
      <Settings2 size={12} className="shrink-0" style={{ color: c.textFaint }} />
    </div>
  );
}

function FixtureRow({ fixture, getTeam, joined, onRecord, c }) {
  const [editing, setEditing] = useState(false);
  const [h, setH] = useState(fixture.home_score);
  const [a, setA] = useState(fixture.away_score);
  useEffect(() => { setH(fixture.home_score); setA(fixture.away_score); }, [fixture.home_score, fixture.away_score]);
  const home = getTeam(fixture.home_team_id);
  const away = getTeam(fixture.away_team_id);

  if (editing) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-2 font-body text-sm" style={{ background: c.surfaceHover }}>
        <span className="flex-1 text-right truncate">{home.name}</span>
        <input type="number" min={0} value={h} onChange={(e) => setH(Number(e.target.value))} className="w-12 text-center rounded font-mono px-1 py-0.5 outline-none" style={{ background: c.surface, color: c.text }} />
        <span style={{ color: c.textFaint }}>–</span>
        <input type="number" min={0} value={a} onChange={(e) => setA(Number(e.target.value))} className="w-12 text-center rounded font-mono px-1 py-0.5 outline-none" style={{ background: c.surface, color: c.text }} />
        <span className="flex-1 truncate">{away.name}</span>
        <button onClick={() => { onRecord(fixture.id, h, a); setEditing(false); }} style={{ color: c.greenText }} className="p-1"><Check size={16} /></button>
        <button onClick={() => setEditing(false)} style={{ color: c.textFaint }} className="p-1"><X size={16} /></button>
      </div>
    );
  }

  return (
    <div onClick={() => joined && setEditing(true)} className={`rounded-lg px-3 py-2 font-body text-sm ${joined ? "cursor-pointer" : ""}`} style={{ background: fixture.played ? c.surface : "transparent" }}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-right truncate">{home.name}</span>
        {fixture.played ? <span className="font-mono font-bold w-16 text-center">{fixture.home_score} – {fixture.away_score}</span> : <span className="font-mono w-16 text-center flex items-center justify-center gap-1" style={{ color: c.textFaint }}><Swords size={11} /> vs</span>}
        <span className="flex-1 truncate">{away.name}</span>
        {joined && <Settings2 size={13} className="shrink-0" style={{ color: c.textFaint }} />}
      </div>
      {joined && (home.phone || away.phone) && (
        <div className="flex items-center gap-2 mt-1 font-mono text-[11px]" style={{ color: c.textFaint }}>
          <span className="flex-1 text-right truncate">{home.phone || "—"}</span>
          <span className="w-16 text-center">·</span>
          <span className="flex-1 truncate">{away.phone || "—"}</span>
        </div>
      )}
    </div>
  );
}
