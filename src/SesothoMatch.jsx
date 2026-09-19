import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ArrowLeft, RotateCcw, Star, Lock, Check, Trophy } from "lucide-react";
import PlayerCharacter from "./PlayerCharacter.jsx";

// Sesotho Match — a local, code-only match-3 puzzle (like Ludo/Chess: no
// Supabase, no Nets, no network cost beyond the page load itself). Every
// tile is drawn with plain SVG shapes and CSS — zero images, zero audio,
// zero external assets — so it costs almost nothing on a slow connection
// and works offline once the app shell has loaded once.
//
// The vocabulary below is copied verbatim from the book's own chapters
// (Chapter 2 greetings, Chapter 8 numbers, the glossary's animals/food/
// family/home/nature/people entries) — nothing here is invented or
// auto-translated; every Sesotho/Shona/isiZulu word is exactly what the
// uploaded book already said. Matching 3+ tiles reveals that word in all
// four languages, so the "candy" is doing double duty as a flash card.
//
// The level map borrows Ludo's "walk a path, one stepping stone per
// level" shape (instead of a literal dice-and-track board, which has no
// natural fit for a linear campaign) — each stone is one vocabulary
// category, and finishing a level's puzzle steps your token to the next
// stone, same visual idea as a board-game piece advancing round a track.

const LEVELS = [
  {
    id: "numbers", title: "Numbers", target: 400, moves: 18,
    words: [
      { id: "ngoe", sesotho: "ngoe", english: "one", shona: "potsi", isizulu: "kunye" },
      { id: "peli", sesotho: "peli", english: "two", shona: "piri", isizulu: "kubili" },
      { id: "tharo", sesotho: "tharo", english: "three", shona: "tatu", isizulu: "kuthathu" },
      { id: "ne", sesotho: "'ne", english: "four", shona: "ina", isizulu: "kune" },
      { id: "hlano", sesotho: "hlano", english: "five", shona: "shanu", isizulu: "kuhlanu" },
      { id: "tselela", sesotho: "tselela", english: "six", shona: "tanhatu", isizulu: "isithupha" },
    ],
  },
  {
    id: "greetings", title: "Greetings", target: 450, moves: 18,
    words: [
      { id: "e", sesotho: "e", english: "yes", shona: "hongu", isizulu: "yebo" },
      { id: "che", sesotho: "che", english: "no", shona: "kwete", isizulu: "cha" },
      { id: "lumela", sesotho: "lumela", english: "hello", shona: "mhoro", isizulu: "sawubona" },
      { id: "kealeboha", sesotho: "kea leboha", english: "thank you", shona: "ndatenda", isizulu: "ngiyabonga" },
      { id: "hantle", sesotho: "hantle", english: "well/good", shona: "zvakanaka", isizulu: "kahle" },
      { id: "fonane", sesotho: "fonane", english: "good night", shona: "urare zvakanaka", isizulu: "lala kahle" },
    ],
  },
  {
    id: "animals", title: "Animals", target: 500, moves: 20,
    words: [
      { id: "ntja", sesotho: "ntja", english: "dog", shona: "imbwa", isizulu: "inja" },
      { id: "katse", sesotho: "katse", english: "cat", shona: "katsi", isizulu: "ikati" },
      { id: "khoho", sesotho: "khoho", english: "chicken", shona: "huku", isizulu: "inkukhu" },
      { id: "poli", sesotho: "poli", english: "goat", shona: "mbudzi", isizulu: "imbuzi" },
      { id: "nku", sesotho: "nku", english: "sheep", shona: "gwai", isizulu: "imvu" },
      { id: "nonyana", sesotho: "nonyana", english: "bird", shona: "shiri", isizulu: "inyoni" },
    ],
  },
  {
    id: "food", title: "Food & Drink", target: 500, moves: 20,
    words: [
      { id: "bohobe", sesotho: "bohobe", english: "bread", shona: "chingwa", isizulu: "isinkwa" },
      { id: "lebese", sesotho: "lebese", english: "milk", shona: "mukaka", isizulu: "ubisi" },
      { id: "lehe", sesotho: "lehe", english: "egg", shona: "zai", isizulu: "iqanda" },
      { id: "tee", sesotho: "tee", english: "tea", shona: "tii", isizulu: "itiye" },
      { id: "tsoekere", sesotho: "tsoekere", english: "sugar", shona: "shuga", isizulu: "ushukela" },
      { id: "tlhapi", sesotho: "tlhapi", english: "fish", shona: "hove", isizulu: "inhlanzi" },
    ],
  },
  {
    id: "family", title: "Family & Friends", target: 550, moves: 20,
    words: [
      { id: "me", sesotho: "'mè", english: "mother", shona: "mai", isizulu: "umama" },
      { id: "ntate", sesotho: "ntate", english: "father", shona: "baba", isizulu: "ubaba" },
      { id: "abuti", sesotho: "abuti", english: "brother", shona: "hama", isizulu: "umfowabo" },
      { id: "ausi", sesotho: "ausi", english: "sister", shona: "hanzvadzi", isizulu: "udadewabo" },
      { id: "ngoana", sesotho: "ngoana", english: "child", shona: "mwana", isizulu: "ingane" },
      { id: "motsoalle", sesotho: "motsoalle", english: "friend", shona: "shamwari", isizulu: "umngane" },
    ],
  },
  {
    id: "home", title: "Home & Things", target: 550, moves: 20,
    words: [
      { id: "ntlo", sesotho: "ntlo", english: "house", shona: "imba", isizulu: "indlu" },
      { id: "lemati", sesotho: "lemati", english: "door", shona: "gonhi", isizulu: "umnyango" },
      { id: "setulo", sesotho: "setulo", english: "chair", shona: "chigaro", isizulu: "isihlalo" },
      { id: "tafole", sesotho: "tafole", english: "table", shona: "tafura", isizulu: "itafula" },
      { id: "buka", sesotho: "buka", english: "book", shona: "bhuku", isizulu: "incwadi" },
      { id: "chelete", sesotho: "chelete", english: "money", shona: "mari", isizulu: "imali" },
    ],
  },
  {
    id: "nature", title: "Nature & Time", target: 600, moves: 22,
    words: [
      { id: "naleli", sesotho: "naleli", english: "star", shona: "nyeredzi", isizulu: "inkanyezi" },
      { id: "pula", sesotho: "pula", english: "rain", shona: "mvura", isizulu: "imvula" },
      { id: "sefate", sesotho: "sefate", english: "tree", shona: "muti", isizulu: "umuthi" },
      { id: "bosiu", sesotho: "bosiu", english: "night", shona: "usiku", isizulu: "ubusuku" },
      { id: "hoseng", sesotho: "hoseng", english: "morning", shona: "mangwanani", isizulu: "ekuseni" },
      { id: "hosasa", sesotho: "hosasa", english: "tomorrow", shona: "mangwana", isizulu: "kusasa" },
    ],
  },
  {
    id: "people", title: "People", target: 600, moves: 22,
    words: [
      { id: "morena", sesotho: "morena", english: "chief", shona: "ishe", isizulu: "inkosi" },
      { id: "tichere", sesotho: "tichere", english: "teacher", shona: "mudzidzisi", isizulu: "uthisha" },
      { id: "ngaka", sesotho: "ngaka", english: "doctor", shona: "chiremba", isizulu: "udokotela" },
      { id: "mooki", sesotho: "mooki", english: "nurse", shona: "mukoti", isizulu: "umhlengikazi" },
      { id: "molemi", sesotho: "molemi", english: "farmer", shona: "murimi", isizulu: "umlimi" },
      { id: "moeti", sesotho: "moeti", english: "visitor", shona: "mushanyi", isizulu: "isivakashi" },
    ],
  },
];

const CAT_COLORS = {
  numbers: "#3B7FE0", greetings: "#E8B923", animals: "#2FA84F", food: "#E0743D",
  family: "#C6538C", home: "#7D5BA6", nature: "#2FA8A0", people: "#E0433D",
};

const GRID = 7;
const PROGRESS_KEY = "sesothoMatch:progress:v1";

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { unlocked: 0, bestScore: {} };
    const parsed = JSON.parse(raw);
    return { unlocked: parsed.unlocked || 0, bestScore: parsed.bestScore || {} };
  } catch { return { unlocked: 0, bestScore: {} }; }
}
function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* storage unavailable — game still works, just won't remember progress */ }
}

// ---------------------------------------------------------------------
// Tile art — every icon is plain SVG shapes, procedurally composed from a
// small set of reusable primitives so 48 words don't mean 48 hand-drawn
// pictures. `hue` picks the fill/accent color for that word's tile.
// ---------------------------------------------------------------------

function Ears({ kind, color }) {
  if (kind === "point") return (<><polygon points="34,26 42,4 50,26" fill={color} /><polygon points="70,26 78,4 86,26" fill={color} /></>);
  if (kind === "round") return (<><circle cx="36" cy="20" r="12" fill={color} /><circle cx="84" cy="20" r="12" fill={color} /></>);
  if (kind === "floppy") return (<><ellipse cx="28" cy="34" rx="10" ry="18" fill={color} /><ellipse cx="92" cy="34" rx="10" ry="18" fill={color} /></>);
  return null;
}

function AnimalFace({ word, color }) {
  const earKind = { ntja: "floppy", katse: "point", khoho: "point", poli: "point", nku: "round", nonyana: "round" }[word] || "round";
  return (
    <>
      <Ears kind={earKind} color={color} />
      <circle cx="60" cy="52" r="34" fill={color} />
      {word === "khoho" && <polygon points="60,20 52,4 68,4" fill="#E0433D" />}
      {word === "poli" && <><rect x="50" y="8" width="5" height="16" rx="2" fill="#6b5a4a" /><rect x="65" y="8" width="5" height="16" rx="2" fill="#6b5a4a" /></>}
      <circle cx="48" cy="48" r="5" fill="#2b2b2b" />
      <circle cx="72" cy="48" r="5" fill="#2b2b2b" />
      {word === "nonyana" ? (
        <polygon points="55,62 65,62 60,74" fill="#E8B923" />
      ) : (
        <ellipse cx="60" cy="66" rx="10" ry="7" fill="rgba(0,0,0,0.15)" />
      )}
      {word === "katse" && (
        <g stroke="#2b2b2b" strokeWidth="1.5">
          <line x1="20" y1="58" x2="42" y2="60" /><line x1="20" y1="66" x2="42" y2="66" />
          <line x1="78" y1="60" x2="100" y2="58" /><line x1="78" y1="66" x2="100" y2="66" />
        </g>
      )}
    </>
  );
}

function FoodIcon({ word, color }) {
  if (word === "bohobe") return (<><rect x="24" y="46" width="72" height="42" rx="20" fill={color} /><path d="M36 46 Q60 20 84 46" fill={color} /><path d="M40 58 v20 M60 55 v25 M80 58 v20" stroke="rgba(0,0,0,0.2)" strokeWidth="3" /></>);
  if (word === "lebese") return (<><path d="M42 30 h36 l6 58 a6 6 0 0 1-6 6 H42 a6 6 0 0 1-6-6 Z" fill="#fff" stroke={color} strokeWidth="6" /><rect x="42" y="46" width="36" height="34" fill={color} /></>);
  if (word === "lehe") return (<ellipse cx="60" cy="60" rx="26" ry="34" fill="#fdf6e3" stroke={color} strokeWidth="5" />);
  if (word === "tee") return (<><path d="M30 50 h50 v24 a25 25 0 0 1-25 25 a25 25 0 0 1-25-25 Z" fill={color} /><path d="M80 56 q18 4 10 20 q-6 12-18 8" fill="none" stroke={color} strokeWidth="6" /><path d="M40 44 q4-10 0-18 M55 44 q4-10 0-18 M70 44 q4-10 0-18" stroke="#bbb" strokeWidth="3" fill="none" /></>);
  if (word === "tsoekere") return (<><rect x="34" y="34" width="52" height="52" fill={color} /><rect x="44" y="44" width="8" height="8" fill="#fff" opacity="0.7" /><rect x="60" y="58" width="8" height="8" fill="#fff" opacity="0.7" /><rect x="70" y="40" width="8" height="8" fill="#fff" opacity="0.7" /></>);
  if (word === "tlhapi") return (<><ellipse cx="52" cy="60" rx="30" ry="18" fill={color} /><polygon points="80,60 100,44 100,76" fill={color} /><circle cx="34" cy="56" r="3" fill="#2b2b2b" /></>);
  return null;
}

function PersonBase({ skin = "#e8b98a", shirt, accessory }) {
  return (
    <>
      <circle cx="60" cy="30" r="17" fill={skin} />
      <rect x="42" y="50" width="36" height="44" rx="12" fill={shirt} />
      {accessory}
    </>
  );
}

function FamilyIcon({ word, color }) {
  if (word === "me") return <PersonBase shirt={color} accessory={<path d="M40 24 a20 14 0 0 1 40 0 v6 h-40 Z" fill="#7D5BA6" />} />;
  if (word === "ntate") return <PersonBase shirt={color} accessory={<rect x="38" y="10" width="44" height="8" rx="3" fill="#3a3a3a" />} />;
  if (word === "abuti") return <PersonBase skin="#e8b98a" shirt={color} accessory={null} />;
  if (word === "ausi") return <PersonBase shirt={color} accessory={<path d="M48 14 q12 -10 24 0" fill="none" stroke="#3a2a1a" strokeWidth="6" />} />;
  if (word === "ngoana") return (<><circle cx="60" cy="38" r="13" fill="#e8b98a" /><rect x="46" y="52" width="28" height="34" rx="10" fill={color} /></>);
  if (word === "motsoalle") return (<>
    <circle cx="42" cy="32" r="13" fill="#e8b98a" /><rect x="28" y="50" width="28" height="36" rx="10" fill={color} />
    <circle cx="78" cy="32" r="13" fill="#c98a5a" /><rect x="64" y="50" width="28" height="36" rx="10" fill="#3B7FE0" />
  </>);
  return null;
}

function HomeIcon({ word, color }) {
  if (word === "ntlo") return (<><polygon points="60,14 100,48 20,48" fill={color} /><rect x="30" y="48" width="60" height="42" fill="#f0e6d8" /><rect x="52" y="64" width="16" height="26" fill={color} /></>);
  if (word === "lemati") return (<><rect x="34" y="18" width="52" height="82" rx="4" fill={color} /><circle cx="72" cy="60" r="4" fill="#fff" /></>);
  if (word === "setulo") return (<><rect x="34" y="20" width="8" height="70" fill={color} /><rect x="34" y="20" width="52" height="8" fill={color} /><rect x="30" y="58" width="60" height="8" fill={color} /><rect x="34" y="66" width="8" height="30" fill={color} /><rect x="78" y="66" width="8" height="30" fill={color} /></>);
  if (word === "tafole") return (<><rect x="20" y="42" width="80" height="10" fill={color} /><rect x="26" y="52" width="8" height="36" fill={color} /><rect x="86" y="52" width="8" height="36" fill={color} /></>);
  if (word === "buka") return (<><rect x="26" y="20" width="68" height="80" rx="4" fill={color} /><rect x="26" y="20" width="10" height="80" fill="rgba(0,0,0,0.25)" /><rect x="44" y="36" width="40" height="4" fill="#fff" opacity="0.7" /><rect x="44" y="48" width="40" height="4" fill="#fff" opacity="0.7" /></>);
  if (word === "chelete") return (<><circle cx="60" cy="60" r="38" fill={color} /><circle cx="60" cy="60" r="30" fill="none" stroke="#fff" strokeWidth="3" opacity="0.6" /><text x="60" y="70" fontSize="26" textAnchor="middle" fill="#fff" fontWeight="bold">M</text></>);
  return null;
}

function NatureIcon({ word, color }) {
  if (word === "naleli") return (<polygon points="60,10 71,42 105,42 78,62 88,96 60,76 32,96 42,62 15,42 49,42" fill={color} />);
  if (word === "pula") return (<><path d="M24 46 a22 22 0 0 1 42-10 a18 18 0 0 1 20 26 H30 a20 20 0 0 1-6-16Z" fill={color} /><g stroke={color} strokeWidth="5" strokeLinecap="round"><line x1="40" y1="76" x2="34" y2="96" /><line x1="60" y1="76" x2="54" y2="96" /><line x1="80" y1="76" x2="74" y2="96" /></g></>);
  if (word === "sefate") return (<><rect x="52" y="60" width="16" height="40" fill="#7a5a3a" /><circle cx="60" cy="42" r="34" fill={color} /></>);
  if (word === "bosiu") return (<><rect x="10" y="10" width="100" height="100" rx="14" fill="#1c2540" /><path d="M75 30a26 26 0 1 0 12 46 30 30 0 0 1-12-46Z" fill="#F4D160" /><circle cx="42" cy="34" r="2.5" fill="#fff" /><circle cx="88" cy="70" r="2" fill="#fff" /><circle cx="30" cy="70" r="1.8" fill="#fff" /></>);
  if (word === "hoseng") return (<><rect x="10" y="10" width="100" height="100" rx="14" fill="#bfe3f0" /><circle cx="60" cy="70" r="24" fill="#F4A950" /><g stroke="#F4A950" strokeWidth="4"><line x1="60" y1="30" x2="60" y2="18" /><line x1="30" y1="46" x2="20" y2="38" /><line x1="90" y1="46" x2="100" y2="38" /></g></>);
  if (word === "hosasa") return (<><rect x="10" y="10" width="100" height="100" rx="14" fill="#dfeef7" /><circle cx="46" cy="60" r="20" fill="#F4A950" /><path d="M78 46 L96 60 L78 74 Z" fill={color} /></>);
  return null;
}

function PeopleIcon({ word, color }) {
  if (word === "morena") return <PersonBase shirt={color} accessory={<polygon points="40,10 60,-2 80,10 74,20 46,20" fill="#E8B923" />} />;
  if (word === "tichere") return <PersonBase shirt={color} accessory={<rect x="70" y="60" width="26" height="20" rx="2" fill="#fdf6e3" stroke="#7D5BA6" strokeWidth="2" />} />;
  if (word === "ngaka") return <PersonBase shirt="#fff" accessory={<g stroke={color} strokeWidth="6" strokeLinecap="round"><line x1="60" y1="60" x2="60" y2="80" /><line x1="50" y1="70" x2="70" y2="70" /></g>} />;
  if (word === "mooki") return <PersonBase shirt="#fff" accessory={<><rect x="50" y="14" width="20" height="20" rx="3" fill="#fff" stroke={color} strokeWidth="3" /><line x1="60" y1="18" x2="60" y2="30" stroke={color} strokeWidth="3" /><line x1="54" y1="24" x2="66" y2="24" stroke={color} strokeWidth="3" /></>} />;
  if (word === "molemi") return <PersonBase shirt={color} accessory={<ellipse cx="60" cy="14" rx="26" ry="8" fill="#C89B5C" />} />;
  if (word === "moeti") return <PersonBase shirt={color} accessory={<rect x="76" y="58" width="22" height="26" rx="4" fill="#7a5a3a" />} />;
  return null;
}

function GreetingIcon({ word, color }) {
  if (word === "e") return (<><circle cx="60" cy="60" r="46" fill={color} /><path d="M38 62 l16 16 30-34" stroke="#fff" strokeWidth="9" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>);
  if (word === "che") return (<><circle cx="60" cy="60" r="46" fill={color} /><g stroke="#fff" strokeWidth="9" strokeLinecap="round"><line x1="42" y1="42" x2="78" y2="78" /><line x1="78" y1="42" x2="42" y2="78" /></g></>);
  if (word === "lumela") return (<><circle cx="54" cy="54" r="30" fill={color} /><g stroke={color} strokeWidth="10" strokeLinecap="round"><line x1="84" y1="30" x2="84" y2="8" /><line x1="94" y1="34" x2="100" y2="14" /><line x1="76" y1="30" x2="72" y2="10" /></g></>);
  if (word === "kealeboha") return (<path d="M60 96 C 20 66,20 30,48 26 C60 24,60 40,60 40 C60 40,60 24,72 26 C100 30,100 66,60 96 Z" fill={color} />);
  if (word === "hantle") return (<><circle cx="60" cy="66" r="30" fill={color} /><rect x="50" y="16" width="20" height="40" rx="10" fill={color} /><circle cx="60" cy="16" r="10" fill={color} /></>);
  if (word === "fonane") return (<><path d="M75 20a35 35 0 1 0 20 62 40 40 0 0 1-20-62Z" fill={color} /><text x="82" y="96" fontSize="16" fill={color} fontWeight="bold">z z Z</text></>);
  return null;
}

function TileArt({ level, word, size = 44 }) {
  const color = CAT_COLORS[level] || "#888";
  let inner = null;
  if (level === "numbers") {
    const n = { ngoe: 1, peli: 2, tharo: 3, ne: 4, hlano: 5, tselela: 6 }[word];
    inner = (<><circle cx="60" cy="60" r="46" fill={color} /><text x="60" y="78" fontSize="56" textAnchor="middle" fill="#fff" fontWeight="bold" fontFamily="sans-serif">{n}</text></>);
  } else if (level === "greetings") inner = <GreetingIcon word={word} color={color} />;
  else if (level === "animals") inner = <AnimalFace word={word} color={color} />;
  else if (level === "food") inner = <FoodIcon word={word} color={color} />;
  else if (level === "family") inner = <FamilyIcon word={word} color={color} />;
  else if (level === "home") inner = <HomeIcon word={word} color={color} />;
  else if (level === "nature") inner = <NatureIcon word={word} color={color} />;
  else if (level === "people") inner = <PeopleIcon word={word} color={color} />;

  return (
    <svg viewBox="0 0 120 120" width={size} height={size} style={{ overflow: "visible" }}>
      {inner}
    </svg>
  );
}

// ---------------------------------------------------------------------
// Match-3 engine — a plain 2D array of word-indexes (0..5), tap-select +
// tap-adjacent to swap (no drag, so it works the same on any screen size
// the way Ludo's tap-to-move does), then standard match-3 clear/gravity/
// refill/cascade.
// ---------------------------------------------------------------------

function randType(n) { return Math.floor(Math.random() * n); }

function makeBoard(n) {
  let board;
  // Avoid pre-existing matches so the board doesn't start half-solved.
  do {
    board = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => randType(n)));
  } while (findMatches(board).size > 0);
  return board;
}

function findMatches(board) {
  const matched = new Set();
  for (let r = 0; r < GRID; r++) {
    let runStart = 0;
    for (let cc = 1; cc <= GRID; cc++) {
      if (cc < GRID && board[r][cc] === board[r][runStart]) continue;
      if (cc - runStart >= 3) for (let k = runStart; k < cc; k++) matched.add(`${r},${k}`);
      runStart = cc;
    }
  }
  for (let cc = 0; cc < GRID; cc++) {
    let runStart = 0;
    for (let r = 1; r <= GRID; r++) {
      if (r < GRID && board[r][cc] === board[runStart][cc]) continue;
      if (r - runStart >= 3) for (let k = runStart; k < r; k++) matched.add(`${k},${cc}`);
      runStart = r;
    }
  }
  return matched;
}

function applyGravity(board, n) {
  const next = board.map((row) => row.slice());
  for (let cc = 0; cc < GRID; cc++) {
    let write = GRID - 1;
    for (let r = GRID - 1; r >= 0; r--) {
      if (next[r][cc] !== null) { next[write][cc] = next[r][cc]; if (write !== r) next[r][cc] = null; write--; }
    }
    for (let r = write; r >= 0; r--) next[r][cc] = randType(n);
  }
  return next;
}

function areAdjacent(a, b) { return (a.r === b.r && Math.abs(a.c - b.c) === 1) || (a.c === b.c && Math.abs(a.r - b.r) === 1); }

export default function SesothoMatchPage({ onBack, c }) {
  const [progress, setProgress] = useState(loadProgress);
  const [screen, setScreen] = useState("map"); // map | play | levelComplete
  const [levelIdx, setLevelIdx] = useState(0);
  const [board, setBoard] = useState(null);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [movesLeft, setMovesLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [wordToast, setWordToast] = useState(null);
  const [outcome, setOutcome] = useState(null); // "won" | "lost" | null
  const [walkTo, setWalkTo] = useState(null); // animate token to this level index on map
  const toastTimer = useRef(null);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const level = LEVELS[levelIdx];

  const openLevel = (idx) => {
    if (idx > progress.unlocked) return;
    const lv = LEVELS[idx];
    setLevelIdx(idx);
    setBoard(makeBoard(lv.words.length));
    setScore(0);
    setMovesLeft(lv.moves);
    setSelected(null);
    setOutcome(null);
    setBusy(false);
    setScreen("play");
  };

  const showWord = (w) => {
    setWordToast(w);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setWordToast(null), 1800);
  };

  const resolveCascade = useCallback((startBoard, wordsForLevel) => {
    let cur = startBoard;
    let gained = 0;
    let firstMatchWord = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const matched = findMatches(cur);
      if (matched.size === 0) break;
      gained += matched.size * 10 + (matched.size > 3 ? (matched.size - 3) * 15 : 0);
      if (!firstMatchWord) {
        const [r, cIdx] = matched.values().next().value.split(",").map(Number);
        firstMatchWord = wordsForLevel[cur[r][cIdx]];
      }
      const cleared = cur.map((row) => row.slice());
      matched.forEach((key) => { const [r, cIdx] = key.split(",").map(Number); cleared[r][cIdx] = null; });
      cur = applyGravity(cleared, wordsForLevel.length);
    }
    return { board: cur, gained, firstMatchWord };
  }, []);

  const trySwap = (a, b) => {
    if (busy || movesLeft <= 0 || outcome) return;
    if (!areAdjacent(a, b)) { setSelected({ r: b.r, c: b.c }); return; }
    setBusy(true);
    const swapped = board.map((row) => row.slice());
    const tmp = swapped[a.r][a.c]; swapped[a.r][a.c] = swapped[b.r][b.c]; swapped[b.r][b.c] = tmp;
    const matched = findMatches(swapped);
    if (matched.size === 0) {
      // Invalid swap — snap back, still costs nothing (no move spent),
      // matching how Ludo doesn't penalize an accidental tap.
      setSelected(null);
      setBusy(false);
      return;
    }
    setBoard(swapped);
    setSelected(null);
    setMovesLeft((m) => m - 1);
    setTimeout(() => {
      const { board: finalBoard, gained, firstMatchWord } = resolveCascade(swapped, level.words);
      setBoard(finalBoard);
      setScore((s) => {
        const next = s + gained;
        if (next >= level.target && !outcome) setOutcome("won");
        return next;
      });
      if (firstMatchWord) showWord(firstMatchWord);
      setBusy(false);
    }, 220);
  };

  useEffect(() => {
    // Gate on !busy so a final move that both wins and empties the move
    // counter always resolves as a win first — busy only clears after the
    // cascade has fully settled and score has been updated, so checking
    // the loss condition while busy is still true would race ahead of a
    // last-move win and show "out of moves" incorrectly.
    if (screen === "play" && !busy && movesLeft <= 0 && score < level.target && !outcome) {
      setOutcome("lost");
    }
  }, [movesLeft, score, level, outcome, screen, busy]);

  useEffect(() => {
    if (outcome === "won") {
      const next = { ...progress };
      next.unlocked = Math.max(next.unlocked, Math.min(levelIdx + 1, LEVELS.length - 1));
      next.bestScore = { ...next.bestScore, [level.id]: Math.max(next.bestScore[level.id] || 0, score) };
      setProgress(next);
      saveProgress(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const onTapCell = (r, cIdx) => {
    if (!selected) { setSelected({ r, c: cIdx }); return; }
    if (selected.r === r && selected.c === cIdx) { setSelected(null); return; }
    trySwap(selected, { r, c: cIdx });
  };

  const backToMap = () => {
    if (outcome === "won" && walkTo == null) setWalkTo(Math.min(levelIdx + 1, LEVELS.length - 1));
    setScreen("map");
  };

  useEffect(() => {
    if (screen === "map" && walkTo != null) {
      const t = setTimeout(() => setWalkTo(null), 900);
      return () => clearTimeout(t);
    }
  }, [screen, walkTo]);

  const tokenAt = walkTo != null ? walkTo : progress.unlocked;

  // ---- Map screen ----
  if (screen === "map") {
    return (
      <div className="max-w-md mx-auto px-4 pt-6 pb-16">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}>
          <ArrowLeft size={15} /> Back
        </button>
        <div className="mb-1 font-display text-2xl" style={{ color: c.text }}>Sesotho Match</div>
        <div className="mb-6 font-body text-sm" style={{ color: c.textDim }}>
          Match 3 to learn a word — Sesotho, English, Shona &amp; isiZulu.
        </div>

        <div className="relative">
          {LEVELS.map((lv, i) => {
            const locked = i > progress.unlocked;
            const done = progress.bestScore[lv.id] != null;
            const isToken = i === tokenAt;
            const align = i % 2 === 0 ? "flex-start" : "flex-end";
            return (
              <div key={lv.id} style={{ display: "flex", justifyContent: align, marginBottom: 18, position: "relative" }}>
                {i < LEVELS.length - 1 && (
                  <div style={{
                    position: "absolute", top: "100%", [i % 2 === 0 ? "left" : "right"]: 34,
                    width: 3, height: 26, background: c.border, zIndex: 0,
                  }} />
                )}
                <button
                  onClick={() => !locked && openLevel(i)}
                  disabled={locked}
                  style={{
                    position: "relative", width: 76, height: 76, borderRadius: 22,
                    background: locked ? c.surfaceHover : CAT_COLORS[lv.id] + "22",
                    border: `2px solid ${locked ? c.border : CAT_COLORS[lv.id]}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: locked ? 0.55 : 1, cursor: locked ? "default" : "pointer",
                  }}>
                  {locked ? <Lock size={22} style={{ color: c.textFaint }} /> : <TileArt level={lv.id} word={lv.words[0].id} size={40} />}
                  {done && (
                    <span style={{ position: "absolute", top: -6, right: -6, background: "#2FA84F", borderRadius: 999, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Check size={12} color="#fff" />
                    </span>
                  )}
                  {isToken && (
                    <div style={{ position: "absolute", bottom: -30, transition: "all 0.6s ease" }}>
                      <PlayerCharacter pose="idle" size={46} kitColor={c.accent} />
                    </div>
                  )}
                </button>
                <div style={{
                  position: "absolute", top: 82, [i % 2 === 0 ? "left" : "right"]: 0,
                  fontSize: 11, fontWeight: 700, color: c.textDim, width: 90, textAlign: i % 2 === 0 ? "left" : "right",
                }}>
                  {lv.title}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ---- Play screen ----
  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-16">
      <button onClick={() => setScreen("map")} className="flex items-center gap-1.5 font-body text-sm mb-4" style={{ color: c.textDim }}>
        <ArrowLeft size={15} /> Map
      </button>

      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-display text-lg" style={{ color: c.text }}>{level.title}</div>
          <div className="font-body text-xs" style={{ color: c.textFaint }}>Target {level.target} pts</div>
        </div>
        <div className="text-right">
          <div className="font-display text-lg" style={{ color: CAT_COLORS[level.id] }}>{score}</div>
          <div className="font-body text-xs" style={{ color: c.textFaint }}>{movesLeft} moves left</div>
        </div>
      </div>

      <div className="w-full h-2 rounded-full mb-4 overflow-hidden" style={{ background: c.border }}>
        <div style={{ width: `${Math.min(100, (score / level.target) * 100)}%`, height: "100%", background: CAT_COLORS[level.id], transition: "width 0.3s" }} />
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: `repeat(${GRID}, 1fr)`, gap: 4,
        background: c.surface, border: `1px solid ${c.border}`, borderRadius: 16, padding: 8,
      }}>
        {board && board.map((row, r) => row.map((t, cIdx) => {
          const isSel = selected && selected.r === r && selected.c === cIdx;
          const w = level.words[t];
          return (
            <button key={`${r}-${cIdx}`} onClick={() => onTapCell(r, cIdx)}
              style={{
                aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: 10, background: isSel ? CAT_COLORS[level.id] + "33" : "transparent",
                border: isSel ? `2px solid ${CAT_COLORS[level.id]}` : "2px solid transparent",
                transition: "transform 0.15s", transform: isSel ? "scale(1.08)" : "scale(1)",
              }}>
              <TileArt level={level.id} word={w.id} size={30} />
            </button>
          );
        }))}
      </div>

      {wordToast && (
        <div className="fixed left-1/2 bottom-24 z-40 rounded-xl px-4 py-2.5 text-center"
          style={{ transform: "translateX(-50%)", background: c.surface, border: `1.5px solid ${CAT_COLORS[level.id]}`, boxShadow: "0 6px 20px rgba(0,0,0,0.25)" }}>
          <div className="font-display text-base" style={{ color: CAT_COLORS[level.id] }}>{wordToast.sesotho}</div>
          <div className="font-body text-xs" style={{ color: c.textDim }}>{wordToast.english} · {wordToast.shona} · {wordToast.isizulu}</div>
        </div>
      )}

      {outcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${outcome === "won" ? "#2FA84F" : c.border}` }}>
            {outcome === "won" ? (
              <>
                <PlayerCharacter pose="celebrate" kitColor={CAT_COLORS[level.id]} size={90} />
                <div className="font-display text-xl mt-2 mb-1" style={{ color: c.text }}>Level complete!</div>
                <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>{score} points</div>
              </>
            ) : (
              <>
                <PlayerCharacter pose="disappointed" kitColor={c.accent} size={90} />
                <div className="font-display text-xl mt-2 mb-1" style={{ color: c.text }}>Out of moves</div>
                <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>{score} / {level.target} points</div>
              </>
            )}
            <div className="flex flex-col gap-2">
              {outcome === "won" ? (
                <button onClick={backToMap} className="w-full flex items-center justify-center gap-2 rounded-xl py-3 font-display text-base" style={{ background: c.accent, color: c.accentText || "#fff" }}>
                  <Trophy size={16} /> Continue
                </button>
              ) : (
                <>
                  <button onClick={() => openLevel(levelIdx)} className="w-full flex items-center justify-center gap-2 rounded-xl py-3 font-display text-base" style={{ background: c.accent, color: c.accentText || "#fff" }}>
                    <RotateCcw size={16} /> Try again
                  </button>
                  <button onClick={backToMap} className="rounded-xl py-3 font-semibold" style={{ background: c.surfaceHover || c.surface, border: `1px solid ${c.border}` }}>
                    Back to map
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
