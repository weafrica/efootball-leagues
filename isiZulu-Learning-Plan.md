# isiZulu Learning Feature — Build Plan
### A new service added to Matchday (WeAfrica)

---

## 0. Where This Fits

Matchday is already a live app: React + Vite frontend, Supabase backend
(Postgres database, Google Auth, Storage, Edge Functions), hosted on
Vercel. It already has leagues, a ladder, a shop, an in-app currency
("Nets"), and admin roles.

**Decision:** build the isiZulu learning feature as a new module
*inside* Matchday, reusing its existing Supabase project, login, and
admin system — not as a separate app or a separate backend.

Reasoning: Supabase's free tier likely already covers this stage, and
Matchday's data (leagues, ladders) is relational — the same kind of
database Postgres/Supabase is built for. Rebuilding a working app on
Firebase, PocketBase, or a self-hosted server would mean redoing
working login, database, and storage systems for little practical
gain right now.

---

## Phase 1 — Audio & Content Foundation

**Goal:** get real, natural isiZulu audio for as much lesson content
as possible, for free.

1. **Get source material**
   - isiZulu Bible text — eBible.org (free)
   - isiZulu audio Bible — Faith Comes By Hearing / bible.is (free)
   - Check license terms before using in an app (most allow free
     ministry/educational use; some restrict resale)

2. **Align audio to text**
   - Audio Bibles come as full chapters, not single words/phrases
   - Use a free alignment tool (Aeneas or WhisperX) to match audio to
     text second-by-second
   - Output: a searchable database — look up a word/phrase, get the
     exact audio timestamp

3. **Build lesson content**
   - Use the chapter format already drafted (grammar point → example
     sentences → vocabulary list → exercises), matching the
     Sesotho/English/Shona/isiZulu chapter structure
   - Structure each chapter into: grammar explanation, example
     sentence table, vocabulary list, exercise set

4. **Match vocabulary/sentences to Bible audio**
   - For each vocabulary word and example sentence, search the
     aligned Bible audio database for a match
   - Expect this to cover roughly 30–50% of everyday teaching
     vocabulary (common verbs like see/hear/come/go appear often;
     classroom phrases like "fill in the blank" won't)

5. **Fill the gaps**
   - For anything not found in Bible audio: record a native isiZulu
     speaker reading the remaining vocabulary and example sentences
   - This is the only paid/manual step if you can't source a
     volunteer speaker

6. **Get native-speaker review**
   - The isiZulu in the uploaded chapter draft is AI-assisted — have
     a native speaker check grammar, tone, and click-consonant
     accuracy before publishing any chapter

---

## Phase 2 — Data & Backend (inside Matchday's existing Supabase)

New tables, alongside Matchday's existing ones:

- `lessons` — chapter number, title, grammar notes
- `vocabulary` — word, meaning, chapter reference, audio clip
  reference, source (Bible or recorded)
- `example_sentences` — isiZulu sentence, English translation,
  chapter reference, audio clip reference
- `quiz_questions` — generated from each chapter's exercises section
- `user_progress` — which chapters/words/quizzes a user has completed

Reuse:
- Existing `auth.users` / Google sign-in — no new login system
- Existing `admins` table — for managing lesson content
- Supabase Storage — for audio clip files (same pattern as
  `shop-photos` bucket)

---

## Phase 3 — App Screens (new React components)

Add alongside existing screens (`Ladder.jsx`, `Leaderboard.jsx`,
`Shop.jsx`):

- `LessonScreen.jsx` — grammar explanation + example sentences with
  audio playback
- `Flashcards.jsx` — generated from the vocabulary table
- `Quiz.jsx` — generated from each chapter's exercises
- Progress tracking, following the existing `activityLog.js` pattern
- New nav item: "Learn isiZulu" next to Leagues / Ladder / Shop in
  `App.jsx`

---

## Phase 4 — Voice Features

- **Voice input:** Whisper (free, open-source) to transcribe the
  learner's spoken isiZulu — run via a new Supabase Edge Function,
  matching the pattern of existing functions in `supabase/functions`
- **Pronunciation feedback:** compare the learner's transcript/audio
  against the correct word or phrase; give right/wrong or "try again"
  feedback
- **Voice output:** no usable free isiZulu text-to-speech exists yet
  (confirmed: Google Cloud TTS does not currently list a Zulu voice,
  though its Speech-to-Text does support `zu-ZA`). All spoken output
  stays either real Bible audio clips or recorded native-speaker
  clips — no synthetic isiZulu voice for now.

---

## Phase 5 — Optional: Tie Into Existing Matchday Systems

- Reward completed lessons/quizzes with **Nets** (Matchday's existing
  in-app currency), reusing `economy.js` / `NetsPanel.jsx`
- Optionally gate advanced chapters behind a small Nets cost

---

## Suggested Build Order

1. Align Bible audio to text; build the searchable clip database
2. Convert chapter content (starting with Chapter 4) into structured
   lesson data
3. Match/tag audio clips to vocabulary and sentences; record native
   speaker for gaps
4. Write the Supabase migration for the new lesson tables
5. Build `LessonScreen`, `Flashcards`, `Quiz` components
6. Wire the new nav item into `App.jsx`
7. Add Whisper-based voice input + pronunciation scoring via a new
   edge function
8. (Optional) Connect completion rewards to the Nets economy
9. Test with real isiZulu speakers, then expand chapter by chapter

---

## Open Questions / Decisions Still Needed

- [ ] Confirm license terms for the specific isiZulu Bible
      text/audio sources before publishing
- [ ] Decide who will record the "gap" vocabulary not found in Bible
      audio
- [ ] Decide whether advanced chapters are free or cost Nets
- [ ] Native-speaker review pass on all AI-assisted isiZulu content
