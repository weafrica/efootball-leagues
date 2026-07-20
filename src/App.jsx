import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "./supabaseClient";
import {
  Trophy, Plus, Users, Calendar, ChevronRight, X, Check,
  ArrowLeft, Settings2, Moon, Sun, LogOut, Lock, Crown, Layers, Share2, Trash2, Clock,
} from "lucide-react";

const THEME_KEY = "efootball-theme-v1";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

const THEMES = {
  dark: {
    bg: "#0B1F17", surface: "rgba(241,250,238,0.045)", surfaceHover: "rgba(241,250,238,0.08)",
    border: "rgba(241,250,238,0.10)", borderStrong: "rgba(241,250,238,0.18)", text: "#F1FAEE",
    textDim: "rgba(241,250,238,0.55)", textFaint: "rgba(241,250,238,0.35)", accent: "#E9C46A",
    accentText: "#0B1F17", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
    red: "#E63946", redSoft: "rgba(230,57,70,0.2)", toastBg: "#F1FAEE", toastText: "#0B1F17",
  },
  light: {
    bg: "#F6F5F0", surface: "rgba(14,42,32,0.04)", surfaceHover: "rgba(14,42,32,0.07)",
    border: "rgba(14,42,32,0.10)", borderStrong: "rgba(14,42,32,0.18)", text: "#0E2A20",
    textDim: "rgba(14,42,32,0.6)", textFaint: "rgba(14,42,32,0.4)", accent: "#B4802E",
    accentText: "#F6F5F0", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.15)", greenText: "#1F6B45",
    red: "#C4293A", redSoft: "rgba(196,41,58,0.12)", toastBg: "#0E2A20", toastText: "#F6F5F0",
  },
};

const FORMATS = [
  { id: "single_round_robin", label: "Single Round Robin", desc: "Every club plays every other club once.", available: true },
  { id: "double_round_robin", label: "Double Round Robin", desc: "Home and away — every club plays every other club twice.", available: true },
  { id: "knockout", label: "Knockout", desc: "Single elimination. Lose and you're out.", available: true },
  { id: "survivor", label: "Survivor", desc: "Play a set number of matches, cut the bottom %, repeat until a target number remain, then finish with a round robin.", available: true },
  { id: "groups_knockout", label: "Groups + Knockout", desc: "Groups of 4, then a knockout stage.", available: false },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
  const secondLeg = firstLeg.map((round) => round.map(({ home, away }) => ({ home: away, away: home })));
  return [...firstLeg, ...secondLeg];
}

function knockoutRound1(teamIds) {
  const shuffled = shuffle(teamIds);
  const pairs = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    if (i + 1 < shuffled.length) pairs.push({ home: shuffled[i], away: shuffled[i + 1] });
    else pairs.push({ home: shuffled[i], away: null });
  }
  return pairs;
}

function stageSchedule(teamIds, matchesWanted) {
  const k = Math.max(1, Math.min(matchesWanted, teamIds.length - 1));
  return roundRobin(shuffle(teamIds)).slice(0, k);
}

function finalStageSchedule(teamIds, finalFormat) {
  return finalFormat === "double_round_robin" ? doubleRoundRobin(teamIds) : roundRobin(teamIds);
}

// dueBase: Date the clock starts counting from. Each round gets +2 days on top of the previous.
function toFixtureRows(leagueId, rounds, stage, dueBase, roundOffset = 0) {
  const rows = [];
  rounds.forEach((round, ri) => {
    const roundNumber = ri + 1 + roundOffset;
    const dueAt = new Date(dueBase.getTime() + roundNumber * TWO_DAYS_MS).toISOString();
    round.forEach(({ home, away }) => {
      const bye = away === null;
      rows.push({
        league_id: leagueId, round: roundNumber, stage,
        home_team_id: home, away_team_id: away,
        played: bye, home_score: bye ? 1 : 0, away_score: 0,
        due_at: dueAt,
      });
    });
  });
  return rows;
}

function generateOpeningFixtures(league, teamIds, dueBase) {
  const { id: leagueId, format, survivor_matches_per_stage, survivor_target_count, survivor_final_format } = league;
  if (format === "single_round_robin") return { fixtureRows: toFixtureRows(leagueId, roundRobin(teamIds), 1, dueBase), startsInFinal: false };
  if (format === "double_round_robin") return { fixtureRows: toFixtureRows(leagueId, doubleRoundRobin(teamIds), 1, dueBase), startsInFinal: false };
  if (format === "knockout") return { fixtureRows: toFixtureRows(leagueId, [knockoutRound1(teamIds)], 1, dueBase), startsInFinal: false };
  if (format === "survivor") {
    if (teamIds.length <= survivor_target_count) {
      return { fixtureRows: toFixtureRows(leagueId, finalStageSchedule(teamIds, survivor_final_format), 1, dueBase), startsInFinal: true };
    }
    return { fixtureRows: toFixtureRows(leagueId, stageSchedule(teamIds, survivor_matches_per_stage), 1, dueBase), startsInFinal: false };
  }
  return { fixtureRows: [], startsInFinal: false };
}

function generationDueBase(league) {
  const now = new Date();
  if (league.starts_at) {
    const starts = new Date(league.starts_at);
    return starts > now ? starts : now;
  }
  return now;
}

async function insertChunked(table, rows, showToast) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) { showToast(`Couldn't save: ${error.message}`); return false; }
  }
  return true;
}

function isExpired(fixture) {
  return !fixture.played && !!fixture.due_at && new Date(fixture.due_at) < new Date();
}

// Expired, unplayed fixtures count as a loss for both sides once past their deadline.
function computeStandings(teams, fixtures) {
  const table = {};
  teams.forEach((t) => { table[t.id] = { id: t.id, name: t.name, eliminated: t.eliminated, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }; });
  fixtures.forEach((f) => {
    if (f.away_team_id === null) return;
    const h = table[f.home_team_id];
    const a = table[f.away_team_id];
    if (!h || !a) return;
    if (f.played) {
      h.p++; a.p++;
      h.gf += f.home_score; h.ga += f.away_score;
      a.gf += f.away_score; a.ga += f.home_score;
      if (f.home_score > f.away_score) { h.w++; h.pts += 3; a.l++; }
      else if (f.home_score < f.away_score) { a.w++; a.pts += 3; h.l++; }
      else { h.d++; a.d++; h.pts += 1; a.pts += 1; }
    } else if (isExpired(f)) {
      h.p++; a.p++; h.l++; a.l++;
    }
  });
  const rows = Object.values(table);
  rows.forEach((r) => { r.gd = r.gf - r.ga; });
  rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
  return rows;
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Loader({ c }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 rounded-full animate-spin" style={{ border: `2px solid ${c.green}`, borderTopColor: "transparent" }} />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [leagues, setLeagues] = useState(null);
  const [view, setView] = useState("home");
  const [activeLeagueId, setActiveLeagueId] = useState(null);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "dark");
  const [handledDeepLink, setHandledDeepLink] = useState(false);
  const c = THEMES[theme];

  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 3200); }, []);

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
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
  };

  const signOut = async () => { await supabase.auth.signOut(); setView("home"); };

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
    if (!session) { setProfile(undefined); setLeagues(null); setIsAdmin(false); return; }
    supabase.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setProfile(data || null));
  }, [session]);

  useEffect(() => {
    if (!session || !profile) return;
    supabase.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
    loadLeagues();
  }, [session, profile, loadLeagues]);

  // Handle a shared deep link like ?league=<id> once leagues have loaded.
  useEffect(() => {
    if (handledDeepLink || leagues === null) return;
    const params = new URLSearchParams(window.location.search);
    const linkedId = params.get("league");
    if (linkedId) {
      const found = leagues.find((l) => l.id === linkedId);
      if (found) { setActiveLeagueId(found.id); setView("league"); }
      else showToast("That league link isn't accessible — you may need to be added as a member first.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    setHandledDeepLink(true);
  }, [leagues, handledDeepLink, showToast]);

  const completeProfile = async (phone, username) => {
    const { data, error } = await supabase.from("profiles")
      .insert({ user_id: session.user.id, phone, efootball_username: username })
      .select().single();
    if (error) { showToast("Couldn't save your details — try again."); return; }
    setProfile(data);
  };

  const activeLeague = useMemo(() => (leagues || []).find((l) => l.id === activeLeagueId) || null, [leagues, activeLeagueId]);

  const myMembership = (league) => (session ? (league.members || []).find((m) => m.user_id === session.user.id) : null);
  const isMemberOf = (league) => !!myMembership(league);
  // Creating a league or being a platform admin gives management rights,
  // but doesn't by itself count as having joined — the creator/admin can
  // still choose to register a club and join like any other player.
  const canManageLeague = (league) => !!session && (isAdmin || league.created_by === session.user.id);
  const myTeam = (league) => {
    const m = myMembership(league);
    if (!m || !m.team_id) return null;
    return league.teams.find((t) => t.id === m.team_id) || null;
  };
  const canSeePhones = (league) => {
    if (canManageLeague(league)) return true;
    if (!isMemberOf(league)) return false;
    const t = myTeam(league);
    return !(t && t.eliminated);
  };
  const entryClosed = (league) => league.entry_closes_at && new Date(league.entry_closes_at) < new Date();

  const createLeague = async (input) => {
    const { name, teamNames, format, survivor, entryClosesAt, startsAt } = input;
    const insertPayload = {
      name, created_by: session.user.id, format,
      entry_closes_at: entryClosesAt, starts_at: startsAt,
    };
    if (format === "survivor") {
      insertPayload.survivor_matches_per_stage = survivor.matchesPerStage;
      insertPayload.survivor_elimination_percent = survivor.eliminationPercent;
      insertPayload.survivor_target_count = survivor.targetCount;
      insertPayload.survivor_final_format = survivor.finalFormat;
    }

    const { data: league, error } = await supabase.from("leagues").insert(insertPayload).select().single();
    if (error) { showToast(`Couldn't create league: ${error.message}`); return; }

    if (teamNames.length >= 2) {
      const { data: teams, error: teamErr } = await supabase.from("teams")
        .insert(teamNames.map((n) => ({ league_id: league.id, name: n }))).select();
      if (teamErr) { showToast(`Couldn't add clubs: ${teamErr.message}`); return; }

      const { fixtureRows, startsInFinal } = generateOpeningFixtures(league, teams.map((t) => t.id), generationDueBase(league));
      const ok = await insertChunked("fixtures", fixtureRows, showToast);
      if (!ok) return;
      if (startsInFinal) await supabase.from("leagues").update({ final_stage_started: true }).eq("id", league.id);
      showToast(`League created — ${fixtureRows.length} fixtures generated.`);
    } else {
      showToast("League created — open for registration. Players can join, then you can start it.");
    }

    await loadLeagues();
    setActiveLeagueId(league.id);
    setView("league");
  };

  const generateFixtures = async (league) => {
    if (league.teams.length < 2) { showToast("Need at least 2 registered clubs to start the league."); return; }
    const { fixtureRows, startsInFinal } = generateOpeningFixtures(league, league.teams.map((t) => t.id), generationDueBase(league));
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;
    if (startsInFinal) await supabase.from("leagues").update({ final_stage_started: true }).eq("id", league.id);
    await loadLeagues();
    showToast(`League started — ${fixtureRows.length} fixtures generated for ${league.teams.length} clubs.`);
  };

  const joinInFlight = useRef(new Set());
  const joinLeague = async (leagueId) => {
    if (joinInFlight.current.has(leagueId)) return;
    joinInFlight.current.add(leagueId);
    try {
    const league = (leagues || []).find((l) => l.id === leagueId);
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return; }

    const started = league.fixtures.length > 0;
    let match = league?.teams.find((t) => t.name.trim().toLowerCase() === profile.efootball_username.trim().toLowerCase());

    if (match) {
      const alreadyClaimed = league.members.some((m) => m.team_id === match.id);
      if (alreadyClaimed) {
        showToast(`"${match.name}" is already claimed by another member in this league — contact the league admin.`);
        return;
      }
    } else if (!started) {
      const { data: newTeam, error: teamErr } = await supabase.from("teams")
        .insert({ league_id: leagueId, name: profile.efootball_username, phone: profile.phone })
        .select().single();
      if (teamErr) {
        if (teamErr.code === "23505") {
          showToast(`"${profile.efootball_username}" is already registered in this league — contact the league admin if that's a mistake.`);
        } else {
          showToast(`Couldn't register your club: ${teamErr.message}`);
        }
        return;
      }
      match = newTeam;
    }

    const { error } = await supabase.from("members").insert({
      league_id: leagueId, user_id: session.user.id,
      display_name: profile.efootball_username, phone: profile.phone,
      team_id: match ? match.id : null,
    });
    if (error) { showToast("Couldn't join — you may already be a member."); return; }
    await loadLeagues();
    showToast(match ? `Joined — you're playing as ${match.name}.` : "Joined as a spectator — your username isn't on this league's team list.");
    } finally {
      joinInFlight.current.delete(leagueId);
    }
  };

  const recordResult = async (league, fixture, homeScore, awayScore) => {
    const { error } = await supabase.from("fixtures")
      .update({ played: true, home_score: homeScore, away_score: awayScore }).eq("id", fixture.id);
    if (error) { showToast("Couldn't save result."); return; }

    if (league.format === "knockout" && homeScore !== awayScore) {
      const loserId = homeScore > awayScore ? fixture.away_team_id : fixture.home_team_id;
      if (loserId) await supabase.from("teams").update({ eliminated: true }).eq("id", loserId);
    }
    await loadLeagues();
    const homeName = league.teams.find((t) => t.id === fixture.home_team_id)?.name || "Home";
    const awayName = league.teams.find((t) => t.id === fixture.away_team_id)?.name || "Away";
    showToast(`Saved: ${homeName} ${homeScore} – ${awayScore} ${awayName}`);
  };

  const advanceKnockout = async (league) => {
    const maxRound = Math.max(...league.fixtures.map((f) => f.round));
    const currentRoundFixtures = league.fixtures.filter((f) => f.round === maxRound);
    const unplayed = currentRoundFixtures.filter((f) => !f.played);
    if (unplayed.length > 0) { showToast(`${unplayed.length} match(es) still need a result.`); return; }
    const draws = currentRoundFixtures.filter((f) => f.away_team_id !== null && f.home_score === f.away_score);
    if (draws.length > 0) { showToast("Every match needs a winner before advancing — no draws in knockout."); return; }

    const winners = currentRoundFixtures.map((f) =>
      f.away_team_id === null ? f.home_team_id : (f.home_score > f.away_score ? f.home_team_id : f.away_team_id));
    if (winners.length <= 1) { showToast("This league already has a champion."); return; }

    const fixtureRows = toFixtureRows(league.id, [knockoutRound1(winners)], 1, new Date(), maxRound);
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;
    await loadLeagues();
    showToast(`Round ${maxRound + 1} created.`);
  };

  const advanceSurvivor = async (league) => {
    const currentStage = league.current_stage;
    const stageFixtures = league.fixtures.filter((f) => f.stage === currentStage);
    const unplayed = stageFixtures.filter((f) => !f.played);
    if (unplayed.length > 0) { showToast(`${unplayed.length} match(es) in this stage still need a result.`); return; }

    if (league.final_stage_started) { showToast("This is the final stage — check the table for the champion."); return; }

    const activeTeams = league.teams.filter((t) => !t.eliminated);
    const standings = computeStandings(activeTeams, stageFixtures);
    let toEliminate = Math.max(1, Math.round(activeTeams.length * (league.survivor_elimination_percent / 100)));
    if (activeTeams.length - toEliminate < league.survivor_target_count) {
      toEliminate = activeTeams.length - league.survivor_target_count;
    }
    const eliminatedIds = standings.slice(standings.length - toEliminate).map((r) => r.id);

    if (eliminatedIds.length > 0) {
      const { error } = await supabase.from("teams").update({ eliminated: true }).in("id", eliminatedIds);
      if (error) { showToast(`Couldn't eliminate teams: ${error.message}`); return; }
    }

    const remainingIds = activeTeams.map((t) => t.id).filter((id) => !eliminatedIds.includes(id));
    const nextStage = currentStage + 1;
    const goingFinal = remainingIds.length <= league.survivor_target_count;

    const rounds = goingFinal
      ? finalStageSchedule(remainingIds, league.survivor_final_format)
      : stageSchedule(remainingIds, league.survivor_matches_per_stage);
    const fixtureRows = toFixtureRows(league.id, rounds, nextStage, new Date());
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;

    const { error: updErr } = await supabase.from("leagues")
      .update({ current_stage: nextStage, final_stage_started: goingFinal }).eq("id", league.id);
    if (updErr) { showToast(`Couldn't update league: ${updErr.message}`); return; }

    await loadLeagues();
    showToast(goingFinal ? `Final stage started — ${remainingIds.length} clubs remain.` : `Stage ${nextStage} started — ${remainingIds.length} clubs remain.`);
  };

  const advanceStage = async (league) => {
    if (league.format === "knockout") return advanceKnockout(league);
    if (league.format === "survivor") return advanceSurvivor(league);
  };

  const updateTeamPhone = async (teamId, phone) => {
    const { error } = await supabase.from("teams").update({ phone }).eq("id", teamId);
    if (error) { showToast("Couldn't save number."); return; }
    await loadLeagues();
  };

  const removeTeam = async (team) => {
    if (!window.confirm(`Remove ${team.name} from this league? This can't be undone.`)) return;
    await supabase.from("members").delete().eq("team_id", team.id);
    const { error } = await supabase.from("teams").delete().eq("id", team.id);
    if (error) { showToast(`Couldn't remove club: ${error.message}`); return; }
    await loadLeagues();
    showToast(`${team.name} removed from the league.`);
  };

  const updateLeaguePhoto = async (league, file) => {
    const ext = file.name.split(".").pop();
    const path = `${league.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("league-photos").upload(path, file, { upsert: true });
    if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }
    const { data: pub } = supabase.storage.from("league-photos").getPublicUrl(path);
    const { error } = await supabase.from("leagues").update({ photo_url: pub.publicUrl }).eq("id", league.id);
    if (error) { showToast(`Couldn't save photo: ${error.message}`); return; }
    await loadLeagues();
    showToast("League photo updated.");
  };

  const deleteLeague = async (league) => {
    if (!window.confirm(`Delete "${league.name}"? This removes all clubs, fixtures and members permanently.`)) return;
    const { error } = await supabase.from("leagues").delete().eq("id", league.id);
    if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
    setView("home");
    setActiveLeagueId(null);
    await loadLeagues();
    showToast("League deleted.");
  };

  const shareLeague = (league) => {
    const url = `${window.location.origin}${window.location.pathname}?league=${league.id}`;
    navigator.clipboard?.writeText(url);
    showToast("Invite link copied — share it with members who already have access.");
  };

  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: THEMES.dark.bg }}><Loader c={THEMES.dark} /></div>;
  }
  if (!session) return <LoginScreen c={c} theme={theme} toggleTheme={toggleTheme} onSignIn={signInWithGoogle} />;
  if (profile === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: c.bg }}><Loader c={c} /></div>;
  }
  if (profile === null) return <ProfileGate c={c} theme={theme} toggleTheme={toggleTheme} onSubmit={completeProfile} />;

  return (
    <div className="min-h-screen transition-colors duration-200" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <Header view={view} setView={setView} activeLeague={activeLeague} theme={theme} toggleTheme={toggleTheme} c={c} onSignOut={signOut} userEmail={session.user.email} />
      <main className="max-w-3xl mx-auto px-4 pb-24">
        {leagues === null ? <Loader c={c} /> : (
          <>
            {view === "home" && (
              <Home leagues={leagues} isAdmin={isAdmin} isMemberOf={isMemberOf} entryClosed={entryClosed}
                onOpen={(id) => { setActiveLeagueId(id); setView("league"); }}
                onCreate={() => setView("create")} onJoin={joinLeague} c={c} />
            )}
            {view === "create" && <CreateLeague onCancel={() => setView("home")} onCreate={createLeague} c={c} />}
            {view === "league" && activeLeague && (
              <LeagueDetail league={activeLeague} session={session} isAdmin={isAdmin} joined={isMemberOf(activeLeague)}
                canSeePhones={canSeePhones(activeLeague)} myTeam={myTeam(activeLeague)} entryClosed={entryClosed(activeLeague)}
                onBack={() => setView("home")} onJoin={() => joinLeague(activeLeague.id)}
                onRecordResult={recordResult} onUpdateTeamPhone={updateTeamPhone} onRemoveTeam={removeTeam} onUpdatePhoto={updateLeaguePhoto}
                onAdvance={advanceStage} onGenerateFixtures={generateFixtures}
                onDelete={deleteLeague} onShare={shareLeague} c={c} />
            )}
          </>
        )}
      </main>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full font-body text-sm font-medium shadow-lg z-50 max-w-[90vw] text-center" style={{ background: c.toastBg, color: c.toastText }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function LoginScreen({ c, theme, toggleTheme, onSignIn }) {
  return (
    <div className="min-h-screen flex flex-col items-center px-6 py-10" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <style>{`
        @keyframes medallionGlow { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.85; } }
        .medallion-glow { animation: medallionGlow 4.5s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .medallion-glow { animation: none; opacity: 0.7; } }
      `}</style>

      <div className="w-full flex items-center justify-between max-w-md">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: c.green }}><Trophy size={14} color={c.accent} /></div>
          <span className="font-extrabold text-sm uppercase tracking-wider">Matchday</span>
        </div>
        <button onClick={toggleTheme} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center min-h-[70vh] w-full">
        <div className="font-mono text-[11px] uppercase tracking-[0.35em] mb-6" style={{ color: c.accent }}>Season 2026</div>

        <div className="relative w-64 h-64 sm:w-72 sm:h-72 mb-8">
          <div className="medallion-glow absolute -inset-6 rounded-full" style={{ background: `radial-gradient(circle, ${c.accent}55 0%, ${c.accent}00 70%)`, filter: "blur(18px)" }} />
          <div className="absolute inset-0 rounded-full overflow-hidden" style={{ boxShadow: `0 0 0 1px ${c.accent}66, 0 20px 60px -10px rgba(0,0,0,0.5)` }}>
            <img src="/hero-emblem.png" alt="" className="w-full h-full object-cover" style={{ transform: "scale(1.12)" }} />
            <div className="absolute inset-0" style={{ background: `radial-gradient(circle, transparent 45%, ${c.bg}CC 92%)` }} />
            <div className="absolute inset-0 rounded-full" style={{ boxShadow: `inset 0 0 40px 10px ${c.bg}` }} />
          </div>
        </div>

        <h1 className="text-4xl sm:text-5xl font-extrabold uppercase tracking-tight text-center leading-[0.95] mb-3">
          Run your table.<br />Own your league.
        </h1>
        <p className="font-body text-center max-w-xs mb-8" style={{ color: c.textDim }}>Create an eFootball league, invite people to join, log results — the table updates itself.</p>
        <button onClick={onSignIn} className="flex items-center gap-3 font-body font-semibold px-6 py-3 rounded-full" style={{ background: c.accent, color: c.accentText }}>
          <GoogleIcon /> Continue with Google
        </button>
      </div>
      <PublicLeaguePreview c={c} />
    </div>
  );
}

// Shows standings for admin-created leagues to visitors who haven't signed in yet.
// Reads from public_leagues / public_league_teams / public_league_fixtures views,
// which must be granted SELECT access for the `anon` role in Supabase.
function PublicLeaguePreview({ c }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [leaguesRes, teamsRes, fixturesRes] = await Promise.all([
        supabase.from("public_leagues").select("*"),
        supabase.from("public_league_teams").select("*"),
        supabase.from("public_league_fixtures").select("*"),
      ]);
      if (cancelled) return;
      setData({
        leagues: leaguesRes.data || [],
        teams: teamsRes.data || [],
        fixtures: fixturesRes.data || [],
      });
    })();
    return () => { cancelled = true; };
  }, []);

  if (!data || data.leagues.length === 0) return null;

  return (
    <div className="w-full max-w-md mt-4 space-y-6">
      <div className="font-mono text-xs uppercase tracking-[0.2em] text-center" style={{ color: c.textFaint }}>Current tables</div>
      {data.leagues.map((l) => {
        const leagueTeams = data.teams.filter((t) => t.league_id === l.id);
        const leagueFixtures = data.fixtures.filter((f) => f.league_id === l.id && (l.format !== "survivor" || f.stage === l.current_stage));
        const activeTeams = l.format === "survivor" ? leagueTeams.filter((t) => !t.eliminated) : leagueTeams;
        const standings = computeStandings(activeTeams, leagueFixtures);
        if (standings.length === 0) return null;
        return (
          <div key={l.id} className="rounded-xl border p-4" style={{ borderColor: c.border, background: c.surface }}>
            <div className="font-semibold text-sm mb-3">{l.name}</div>
            <table className="w-full font-body text-xs" style={{ color: c.text }}>
              <thead>
                <tr style={{ color: c.textFaint }}>
                  <th className="text-left font-normal pb-1.5">Club</th>
                  <th className="font-normal pb-1.5 w-7">P</th>
                  <th className="font-normal pb-1.5 w-7">W</th>
                  <th className="font-normal pb-1.5 w-7">D</th>
                  <th className="font-normal pb-1.5 w-7">L</th>
                  <th className="font-normal pb-1.5 w-9">GD</th>
                  <th className="font-normal pb-1.5 w-9">Pts</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s) => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${c.border}` }}>
                    <td className="py-1.5 truncate max-w-[9rem]">{s.name}</td>
                    <td className="text-center">{s.p}</td>
                    <td className="text-center">{s.w}</td>
                    <td className="text-center">{s.d}</td>
                    <td className="text-center">{s.l}</td>
                    <td className="text-center">{s.gd}</td>
                    <td className="text-center font-semibold">{s.pts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
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

function ProfileGate({ c, theme, toggleTheme, onSubmit }) {
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const usernameTrimmed = username.trim();
  const usernameIsOneWord = usernameTrimmed.length > 0 && !/\s/.test(usernameTrimmed);
  const valid = phone.trim().startsWith("+") && phone.trim().length >= 8 && usernameTrimmed.length >= 2 && usernameIsOneWord;

  const submit = async () => {
    setSubmitting(true);
    await onSubmit(phone.trim(), usernameTrimmed);
    setSubmitting(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <button onClick={toggleTheme} className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-5" style={{ background: c.green }}><Lock size={24} color={c.accent} /></div>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight text-center leading-none mb-2">One more step</h1>
      <p className="font-body text-center max-w-sm mb-6" style={{ color: c.textDim }}>
        Confirm your phone number and eFootball username before you can access leagues. Other players use these to reach you for matches.
      </p>
      <div className="w-full max-w-sm">
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>eFootball username <span style={{ color: c.textFaint }}>(one word, exactly as it appears in-game)</span></label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Ndosi_123"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        {usernameTrimmed.length > 0 && !usernameIsOneWord && (
          <p className="font-body text-xs mb-1.5" style={{ color: c.red }}>No spaces — use one word, like your actual in-game username (e.g. "Bounce_Academy" not "Bounce Academy").</p>
        )}
        <div className="mb-4" />
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Phone number <span style={{ color: c.textFaint }}>(with country code)</span></label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+27 82 123 4567" type="tel"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <p className="font-body text-xs mb-5" style={{ color: c.textFaint }}>Must start with + and your country code, e.g. +27, +234, +1.</p>
        <button disabled={!valid || submitting} onClick={submit}
          className="w-full font-body font-semibold px-4 py-3 rounded-full"
          style={valid ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {submitting ? "Saving..." : "Continue to Matchday"}
        </button>
      </div>
    </div>
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
          <button onClick={onSignOut} title={userEmail} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><LogOut size={14} /></button>
        </div>
      </div>
    </header>
  );
}

function Home({ leagues, isAdmin, isMemberOf, entryClosed, onOpen, onCreate, onJoin, c }) {
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
            const closed = entryClosed(l);
            const activeTeams = l.format === "survivor" ? l.teams.filter((t) => !t.eliminated) : l.teams;
            const leader = computeStandings(activeTeams, l.fixtures.filter((f) => l.format !== "survivor" || f.stage === l.current_stage))[0];
            const formatLabel = FORMATS.find((f) => f.id === l.format)?.label || l.format;
            const stageLabel = l.format === "survivor" ? (l.final_stage_started ? " · Final stage" : ` · Stage ${l.current_stage}`) : "";
            return (
              <div key={l.id} onClick={() => onOpen(l.id)} className="rounded-xl p-4 flex items-center justify-between cursor-pointer border" style={{ background: c.surface, borderColor: c.border }}>
                <div className="flex items-center gap-3 min-w-0">
                  {l.photo_url && (
                    <img src={l.photo_url} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0" style={{ border: `1px solid ${c.border}` }} />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-lg leading-tight truncate">{l.name}</div>
                    <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>
                      {l.fixtures.length === 0
                        ? `${formatLabel} · Registration open · ${l.teams.length} club${l.teams.length === 1 ? "" : "s"} joined`
                        : `${formatLabel}${stageLabel} · ${l.teams.length} clubs · ${played}/${l.fixtures.length} played${leader && leader.p > 0 ? ` · ${leader.name} leads` : ""}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {joined ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Joined</span>
                  ) : closed ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.redSoft, color: c.red }}>Entry closed</span>
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
  const [format, setFormat] = useState("double_round_robin");
  const [matchesPerStage, setMatchesPerStage] = useState(10);
  const [eliminationPercent, setEliminationPercent] = useState(50);
  const [targetCount, setTargetCount] = useState(20);
  const [finalFormat, setFinalFormat] = useState("double_round_robin");
  const [entryClosesAt, setEntryClosesAt] = useState("");
  const [startsAt, setStartsAt] = useState("");

  const teamNames = teamsText.split("\n").map((t) => t.trim()).filter(Boolean);
  const teamNameDupes = (() => {
    const seen = new Set(); const dupes = new Set();
    for (const n of teamNames) {
      const key = n.toLowerCase();
      if (seen.has(key)) dupes.add(n); else seen.add(key);
    }
    return [...dupes];
  })();
  const teamNameMultiWord = teamNames.filter((n) => /\s/.test(n));
  const survivorValid = format !== "survivor" || (matchesPerStage >= 1 && eliminationPercent >= 1 && eliminationPercent <= 99 && targetCount >= 2);
  const canCreate = name.trim().length > 0 && (teamNames.length === 0 || teamNames.length >= 2) && teamNameDupes.length === 0 && teamNameMultiWord.length === 0 && survivorValid && entryClosesAt && startsAt;
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };

  const submit = () => {
    onCreate({
      name: name.trim(), teamNames, format,
      survivor: format === "survivor" ? { matchesPerStage: Number(matchesPerStage), eliminationPercent: Number(eliminationPercent), targetCount: Number(targetCount), finalFormat } : null,
      entryClosesAt: new Date(entryClosesAt).toISOString(),
      startsAt: new Date(startsAt).toISOString(),
    });
  };

  return (
    <div className="pt-10">
      <button onClick={onCancel} className="flex items-center gap-1.5 font-body text-sm mb-6" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight mb-1">New league</h1>
      <p className="font-body mb-6 text-sm" style={{ color: c.textDim }}>Fixtures are generated automatically based on the format you pick. Each match gets 2 days to be played once it opens.</p>

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friday Night eFootball Cup" className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-5" style={inputStyle} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Entry closes</label>
          <input type="datetime-local" value={entryClosesAt} onChange={(e) => setEntryClosesAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League starts</label>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
      </div>

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Format</label>
      <div className="space-y-2 mb-2">
        {FORMATS.map((f) => (
          <button key={f.id} disabled={!f.available} onClick={() => setFormat(f.id)}
            className="w-full text-left rounded-lg px-4 py-3 border flex items-start justify-between gap-3"
            style={{
              borderColor: format === f.id ? c.accent : c.border,
              background: format === f.id ? c.surfaceHover : "transparent",
              opacity: f.available ? 1 : 0.5,
              cursor: f.available ? "pointer" : "not-allowed",
            }}>
            <div>
              <div className="font-body font-semibold text-sm">{f.label}</div>
              <div className="font-body text-xs mt-0.5" style={{ color: c.textFaint }}>{f.desc}</div>
            </div>
            {!f.available && <span className="font-mono text-[10px] uppercase tracking-wider shrink-0 px-2 py-1 rounded" style={{ background: c.surface, color: c.textFaint }}>Coming soon</span>}
          </button>
        ))}
      </div>

      {format === "survivor" && (
        <div className="rounded-lg p-4 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.textFaint }}><Layers size={12} /> Survivor settings</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Matches per stage</label>
              <input type="number" min={1} value={matchesPerStage} onChange={(e) => setMatchesPerStage(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Eliminate bottom %</label>
              <input type="number" min={1} max={99} value={eliminationPercent} onChange={(e) => setEliminationPercent(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
          </div>
          <div className="mb-3">
            <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Stop cutting once this many clubs remain</label>
            <input type="number" min={2} value={targetCount} onChange={(e) => setTargetCount(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          </div>
          <div>
            <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Final stage format</label>
            <div className="flex gap-2">
              {[{ id: "single_round_robin", label: "Single RR" }, { id: "double_round_robin", label: "Double RR" }].map((opt) => (
                <button key={opt.id} onClick={() => setFinalFormat(opt.id)}
                  className="flex-1 font-body text-xs font-semibold px-3 py-2 rounded-lg border"
                  style={{ borderColor: finalFormat === opt.id ? c.accent : c.border, background: finalFormat === opt.id ? c.surfaceHover : "transparent" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Clubs <span style={{ color: c.textFaint }}>(optional — leave blank for open registration)</span></label>
      <textarea value={teamsText} onChange={(e) => setTeamsText(e.target.value)} rows={8} placeholder={"Leave blank for open registration, or pre-list usernames:\nNdosi_123\nAsonele2k\nAshozi_10\nTheAnimal5"} className="w-full border rounded-lg px-4 py-2.5 font-body outline-none resize-none" style={inputStyle} />
      <div className="font-mono text-xs mt-1.5" style={{ color: (teamNameDupes.length || teamNameMultiWord.length) ? c.red : c.textFaint }}>
        {teamNameDupes.length > 0
          ? `Duplicate name${teamNameDupes.length === 1 ? "" : "s"}: ${teamNameDupes.join(", ")} — each club needs a unique username.`
          : teamNameMultiWord.length > 0
          ? `Usernames must be one word — fix: ${teamNameMultiWord.join(", ")}`
          : teamNames.length === 0 ? "Open registration — fixtures generate once you start the league." : `${teamNames.length} club${teamNames.length === 1 ? "" : "s"} pre-listed — fixtures generate immediately.`}
      </div>

      <button disabled={!canCreate} onClick={submit} className="mt-6 w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full" style={canCreate ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
        <Trophy size={16} /> Create league
      </button>
    </div>
  );
}

function LeaguePhotoBanner({ league, canManage, onUpdatePhoto, c }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    await onUpdatePhoto(league, file);
    setUploading(false);
  };

  if (!league.photo_url && !canManage) return null;

  return (
    <div className="relative mb-5 rounded-xl overflow-hidden" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
      {league.photo_url ? (
        <img src={league.photo_url} alt="" className="w-full h-40 sm:h-48 object-cover" />
      ) : (
        <div className="w-full h-28 flex items-center justify-center font-body text-sm" style={{ color: c.textFaint }}>No league photo yet</div>
      )}
      {canManage && (
        <>
          <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
          <button onClick={() => inputRef.current?.click()} disabled={uploading}
            className="absolute bottom-2 right-2 flex items-center gap-1.5 font-body text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ background: c.bg, color: c.text, opacity: uploading ? 0.6 : 0.92 }}>
            <Settings2 size={12} /> {uploading ? "Uploading…" : league.photo_url ? "Change photo" : "Add photo"}
          </button>
        </>
      )}
    </div>
  );
}

function LeagueDetail({ league, session, isAdmin, joined, canSeePhones, myTeam, entryClosed, onBack, onJoin, onRecordResult, onUpdateTeamPhone, onRemoveTeam, onUpdatePhoto, onAdvance, onGenerateFixtures, onDelete, onShare, c }) {
  const [tab, setTab] = useState("table");
  const isCreator = session && league.created_by === session.user.id;
  const canManage = isCreator || isAdmin;
  const isKnockout = league.format === "knockout";
  const isSurvivor = league.format === "survivor";

  const stageFixtures = isSurvivor ? league.fixtures.filter((f) => f.stage === league.current_stage) : league.fixtures;
  const displayTeams = isSurvivor ? league.teams.filter((t) => !t.eliminated) : league.teams;
  const standings = useMemo(() => computeStandings(displayTeams, stageFixtures), [displayTeams, stageFixtures]);
  const totalRounds = Math.max(...stageFixtures.map((f) => f.round), 0);

  const n = standings.length;
  const zoneFor = (idx) => {
    if (idx === 0 && n > 4) return c.accent;
    if (idx < Math.ceil(n / 3) && n > 6) return c.green;
    if (idx >= n - Math.max(1, Math.floor(n / 4)) && n > 6) return c.red;
    return "transparent";
  };

  const currentRoundFixtures = league.fixtures.filter((f) => f.round === totalRounds && (!isSurvivor || f.stage === league.current_stage));
  const currentRoundDone = currentRoundFixtures.length > 0 && currentRoundFixtures.every((f) => f.played);
  const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played);

  const activeTeamsCount = league.teams.filter((t) => !t.eliminated).length;
  const knockoutChampion = isKnockout && activeTeamsCount === 1 ? league.teams.find((t) => !t.eliminated) : null;
  const survivorComplete = isSurvivor && league.final_stage_started && stageDone;
  const survivorChampion = survivorComplete ? standings[0] : null;

  const formatLabel = FORMATS.find((f) => f.id === league.format)?.label;
  const notStarted = league.fixtures.length === 0;
  const expiredCount = league.fixtures.filter((f) => isExpired(f)).length;

  return (
    <div className="pt-8">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
        <div className="flex items-center gap-2">
          {canManage && (
            <button onClick={() => onShare(league)} title="Copy invite link" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><Share2 size={14} /></button>
          )}
          {canManage && (
            <button onClick={() => onDelete(league)} title="Delete league" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.red }}><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      <LeaguePhotoBanner league={league} canManage={canManage} onUpdatePhoto={onUpdatePhoto} c={c} />

      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-3xl font-extrabold uppercase tracking-tight leading-none">{league.name}</h1>
          <div className="font-mono text-xs mt-2" style={{ color: c.textFaint }}>
            {formatLabel} · {league.teams.length} clubs · {league.members.length} member{league.members.length === 1 ? "" : "s"}
          </div>
          <div className="font-mono text-[11px] mt-1 flex items-center gap-1" style={{ color: c.textFaint }}>
            <Clock size={11} /> Entry closes {fmtDate(league.entry_closes_at)} · Starts {fmtDate(league.starts_at)}
          </div>
        </div>
        {!joined && !entryClosed && <button onClick={onJoin} className="shrink-0 flex items-center gap-1.5 font-body font-semibold text-sm px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}><Users size={14} /> Join</button>}
        {!joined && entryClosed && <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1.5 rounded shrink-0" style={{ background: c.redSoft, color: c.red }}>Entry closed</span>}
      </div>

      {notStarted ? (
        <div>
          <div className="rounded-xl p-5 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
            <div className="font-body font-bold text-base mb-1">Registration open</div>
            <div className="font-body text-sm mb-3" style={{ color: c.textDim }}>
              {league.teams.length} club{league.teams.length === 1 ? "" : "s"} registered
              {isSurvivor ? ` · needs 2+ to start, cuts to ${league.survivor_target_count} over time` : " · needs 2+ to start"}.
              {" "}Players who join automatically register their eFootball username as their club — no need to list them upfront.
            </div>
            {canManage && (
              <button disabled={league.teams.length < 2} onClick={() => onGenerateFixtures(league)}
                className="font-body text-sm font-semibold px-4 py-2.5 rounded-full"
                style={league.teams.length >= 2 ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
                Start league &amp; generate fixtures
              </button>
            )}
          </div>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Registered clubs</div>
          {league.teams.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's registered yet — share the league so players can join.</div>
          ) : (
            <div className="space-y-1.5">
              {league.teams.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
                  <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{t.name[0]?.toUpperCase()}</div>
                  <span className="font-body text-sm flex-1">{t.name}</span>
                  {canManage && (
                    <button onClick={() => onRemoveTeam(t)} className="p-1.5 rounded-full shrink-0" style={{ color: c.textFaint }} title={`Remove ${t.name}`}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      <>
      {knockoutChampion && (
        <div className="rounded-xl p-4 mb-5 flex items-center gap-3" style={{ background: c.greenSoft }}>
          <Crown size={20} style={{ color: c.accent }} />
          <div><div className="font-body font-bold text-sm">{knockoutChampion.name} wins the league!</div><div className="font-body text-xs" style={{ color: c.textDim }}>Knockout complete.</div></div>
        </div>
      )}
      {survivorChampion && (
        <div className="rounded-xl p-4 mb-5 flex items-center gap-3" style={{ background: c.greenSoft }}>
          <Crown size={20} style={{ color: c.accent }} />
          <div><div className="font-body font-bold text-sm">{survivorChampion.name} wins the league!</div><div className="font-body text-xs" style={{ color: c.textDim }}>Survivor final stage complete.</div></div>
        </div>
      )}

      {joined && myTeam && myTeam.eliminated && (
        <div className="rounded-xl p-3 mb-5 font-body text-xs" style={{ background: c.redSoft, color: c.red }}>
          {myTeam.name} has been eliminated — you no longer have access to other players' phone numbers in this league.
        </div>
      )}

      {expiredCount > 0 && (
        <div className="rounded-xl p-3 mb-5 font-body text-xs flex items-center gap-2" style={{ background: c.redSoft, color: c.red }}>
          <Clock size={13} /> {expiredCount} fixture{expiredCount === 1 ? "" : "s"} passed the 2-day deadline unplayed — both clubs recorded a loss automatically.
        </div>
      )}

      {isSurvivor && !survivorComplete && (
        <div className="rounded-xl p-4 mb-5 border" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-body text-xs mb-2" style={{ color: c.textDim }}>
            {league.final_stage_started
              ? `Final stage (${league.survivor_final_format === "double_round_robin" ? "double" : "single"} round robin) · ${activeTeamsCount} clubs · ${stageFixtures.filter((f) => f.played).length}/${stageFixtures.length} played`
              : `Stage ${league.current_stage} · ${activeTeamsCount} clubs, ${league.survivor_matches_per_stage} matches each · ${stageFixtures.filter((f) => f.played).length}/${stageFixtures.length} played · bottom ${league.survivor_elimination_percent}% cut when complete`}
          </div>
          {canManage && !league.final_stage_started && (
            <button disabled={!stageDone} onClick={() => onAdvance(league)}
              className="font-body text-xs font-semibold px-3 py-2 rounded-full"
              style={stageDone ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              {stageDone ? "Cut bottom % and start next stage" : "Waiting for all matches"}
            </button>
          )}
        </div>
      )}

      {canManage && isKnockout && !knockoutChampion && (
        <div className="rounded-xl p-4 mb-5 border flex items-center justify-between gap-3" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-body text-xs" style={{ color: c.textDim }}>
            {currentRoundDone ? `Round ${totalRounds} complete — ready for the next round.` : `Round ${totalRounds} in progress: ${currentRoundFixtures.filter((f) => f.played).length}/${currentRoundFixtures.length} played.`}
          </div>
          <button disabled={!currentRoundDone} onClick={() => onAdvance(league)}
            className="font-body text-xs font-semibold px-3 py-2 rounded-full shrink-0"
            style={currentRoundDone ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
            Advance round
          </button>
        </div>
      )}

      <div className="flex gap-1 mb-5 rounded-full p-1 w-fit" style={{ background: c.surface }}>
        {[{ id: "table", label: "Table", icon: Trophy }, { id: "fixtures", label: "Fixtures", icon: Calendar }, { id: "members", label: "Members", icon: Users }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-body text-xs font-semibold uppercase tracking-wide" style={tab === t.id ? { background: c.text, color: c.bg } : { color: c.textDim }}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "table" && (
        <div className="overflow-x-auto -mx-4 px-4">
          <div className="font-mono text-xs mb-3 px-2" style={{ color: c.textFaint }}>
            {stageFixtures.filter((f) => f.played).length} of {stageFixtures.length} matches played
            {isSurvivor ? ` · ${league.final_stage_started ? "final stage" : `stage ${league.current_stage}`}` : ""}
          </div>
          <table className="w-full font-mono text-sm min-w-[500px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider border-b" style={{ color: c.textFaint, borderColor: c.border }}>
                <th className="text-left py-2 pl-2 font-medium">#</th><th className="text-left py-2 font-medium">Club</th>
                <th className="text-center py-2 font-medium">P</th>
                <th className="text-center py-2 font-medium">W</th><th className="text-center py-2 font-medium">D</th>
                <th className="text-center py-2 font-medium">L</th><th className="text-center py-2 font-medium">GD</th>
                <th className="text-center py-2 pr-2 font-medium">Pts</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((r, i) => (
                <tr key={r.id} className="border-b" style={{ borderColor: c.border, opacity: r.eliminated ? 0.4 : 1 }}>
                  <td className="py-2.5 pl-2 relative"><span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: zoneFor(i) }} /><span style={{ color: c.textFaint }}>{i + 1}</span></td>
                  <td className="py-2.5 font-body font-medium">{r.name}{r.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : ""}</td>
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
            <OpponentFinder teams={league.teams} fixtures={stageFixtures} totalRounds={totalRounds} canManage={canManage}
              canSeePhones={canSeePhones} onRecordResult={(fixture, h, a) => onRecordResult(league, fixture, h, a)} c={c} />
          )}
          {canSeePhones && <TeamContactsPanel teams={league.teams} onUpdateTeamPhone={onUpdateTeamPhone} c={c} />}
          {joined && !canSeePhones && (
            <div className="rounded-xl p-4 border font-body text-xs" style={{ borderColor: c.borderStrong, color: c.textFaint }}>
              Player contacts are hidden because your club has been eliminated from this league.
            </div>
          )}
        </div>
      )}

      {tab === "members" && (
        <div>
          {league.members.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's joined yet.</div>
          ) : (
            <div className="space-y-1.5">
              {league.members.map((m) => {
                const t = league.teams.find((t) => t.id === m.team_id);
                return (
                  <div key={m.id} className="flex items-center gap-3 rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
                    <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{m.display_name[0]?.toUpperCase()}</div>
                    <span className="font-body text-sm flex-1">{m.display_name}</span>
                    {t && <span className="font-mono text-xs" style={{ color: t.eliminated ? c.red : c.textFaint }}>{t.name}{t.eliminated ? " (out)" : ""}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

function TeamContactsPanel({ teams, onUpdateTeamPhone, c }) {
  const [query, setQuery] = useState("");
  const filtered = query.trim() ? teams.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase())) : teams;
  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Player contacts</div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search club name..."
        className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none mb-3" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="font-body text-xs" style={{ color: c.textFaint }}>No clubs match "{query}".</div>
        ) : filtered.map((t) => <TeamContactRow key={t.id} team={t} onUpdateTeamPhone={onUpdateTeamPhone} c={c} />)}
      </div>
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
      <span className="flex-1 truncate">{team.name}{team.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : ""}</span>
      {team.phone ? <span className="font-mono text-xs" style={{ color: c.textDim }}>{team.phone}</span> : <span className="font-mono text-xs" style={{ color: c.textFaint }}>Add number</span>}
      <Settings2 size={12} className="shrink-0" style={{ color: c.textFaint }} />
    </div>
  );
}

function OpponentFinder({ teams, fixtures, totalRounds, canManage, canSeePhones, onRecordResult, c }) {
  const [matchday, setMatchday] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const [result, setResult] = useState(null);
  const [h, setH] = useState(0);
  const [a, setA] = useState(0);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved

  const search = () => {
    const md = Number(matchday);
    if (!md || md < 1 || md > totalRounds) { setResult({ notFound: true, reason: `Enter a matchday between 1 and ${totalRounds}.` }); return; }
    const team = teams.find((t) => t.name.trim().toLowerCase() === teamQuery.trim().toLowerCase());
    if (!team) { setResult({ notFound: true, reason: "No club with that exact name — pick one from the suggestions." }); return; }
    const fixture = fixtures.find((f) => f.round === md && (f.home_team_id === team.id || f.away_team_id === team.id));
    if (!fixture) { setResult({ notFound: true, reason: `${team.name} has no fixture on matchday ${md} in the current stage.` }); return; }
    const expired = isExpired(fixture);
    if (expired && !canManage) {
      setResult({ notFound: true, reason: "This match passed its 2-day deadline without a result — both clubs received a loss. It's no longer viewable." });
      return;
    }
    const isHome = fixture.home_team_id === team.id;
    const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
    const opponent = opponentId ? teams.find((t) => t.id === opponentId) : null;
    setH(fixture.home_score); setA(fixture.away_score);
    setSaveState("idle");
    setResult({ fixture, team, opponent, isHome, bye: opponentId === null, venue: isHome ? "Home" : "Away", expired });
  };

  const save = async () => {
    setSaveState("saving");
    await onRecordResult(result.fixture, h, a);
    setSaveState("saved");
    setResult((r) => r && ({ ...r, fixture: { ...r.fixture, played: true, home_score: h, away_score: a } }));
  };

  const homeTeam = result && !result.notFound && !result.bye ? (result.isHome ? result.team : result.opponent) : null;
  const awayTeam = result && !result.notFound && !result.bye ? (result.isHome ? result.opponent : result.team) : null;

  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Find your opponent</div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input type="number" min={1} max={totalRounds} value={matchday} onChange={(e) => setMatchday(e.target.value)} placeholder="Matchday #"
          className="w-full sm:w-32 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <input list="team-names-datalist" value={teamQuery} onChange={(e) => setTeamQuery(e.target.value)} placeholder="Your club name"
          className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <datalist id="team-names-datalist">{teams.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        <button onClick={search} className="font-body text-sm font-semibold px-4 py-2 rounded-lg shrink-0" style={{ background: c.accent, color: c.accentText }}>Find</button>
      </div>

      {result && (result.notFound ? (
        <div className="font-body text-xs mt-3" style={{ color: c.textFaint }}>{result.reason}</div>
      ) : result.bye ? (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>{result.team.name} has a bye this round — automatic advance.</div>
      ) : (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
          <div className="font-semibold">{result.opponent.name} <span className="font-mono text-xs font-normal" style={{ color: c.textFaint }}>({result.venue})</span></div>
          {result.fixture.played ? (
            <div className="font-mono text-xs mt-1" style={{ color: c.textDim }}>Final score: {result.fixture.home_score} – {result.fixture.away_score}</div>
          ) : (
            <div className="font-mono text-xs mt-1" style={{ color: result.expired ? c.red : c.textFaint }}>
              {result.expired ? "Expired — recorded as a loss for both clubs" : `Due by ${fmtDate(result.fixture.due_at)}`}
            </div>
          )}
          {canSeePhones ? (
            result.opponent.phone ? <div className="font-mono text-xs mt-1" style={{ color: c.greenText }}>{result.opponent.phone}</div>
              : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
          ) : (
            <div className="font-mono text-xs mt-1" style={{ color: c.red }}>Contact hidden — your club is eliminated.</div>
          )}
          {canManage && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
              <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>
                Enter result{result.expired ? " (expired)" : ""}:
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam.name} <span style={{ color: c.textFaint }}>(Home)</span></div>
                  <input type="number" min={0} value={h} onChange={(e) => { setH(Number(e.target.value)); setSaveState("idle"); }} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                </div>
                <span className="self-end pb-1.5" style={{ color: c.textFaint }}>–</span>
                <div className="flex-1 min-w-0">
                  <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam.name} <span style={{ color: c.textFaint }}>(Away)</span></div>
                  <input type="number" min={0} value={a} onChange={(e) => { setA(Number(e.target.value)); setSaveState("idle"); }} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                </div>
                <button onClick={save} disabled={saveState === "saving"} className="self-end font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 flex items-center gap-1"
                  style={{ background: saveState === "saved" ? c.greenSoft : c.accent, color: saveState === "saved" ? c.greenText : c.accentText, opacity: saveState === "saving" ? 0.6 : 1 }}>
                  {saveState === "saved" ? (<><Check size={13} /> Saved</>) : saveState === "saving" ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
