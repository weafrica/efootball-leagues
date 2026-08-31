# Roadmap: Multi-language Support & Timezone-Aware Scheduling

## 1. Multi-language support

**Goal:** Support the app's 11 priority languages (see section 3), with a manual language switcher.

**Approach: static translation files, no API, no cost, no account.**

The original plan called for Google Cloud Translation — but that's an API, and an API only earns its keep when you don't know the content ahead of time or it changes constantly. This list of 11 languages is fixed and known in advance. For a fixed list, the translated text just needs to be written once and shipped as plain files in the repo — no live service involved.

- Add `react-i18next` + browser language auto-detection to the app
- Extract every hardcoded UI string (buttons, labels, toasts, WhatsApp templates) into an English source-of-truth file, referenced by key
- Generate the actual translated text for all 11 languages directly (in chat, no external service) and save each as a static JSON file in the repo (`src/locales/fr.json`, `src/locales/ar.json`, etc.)
- Add a language switcher in the header menu (same spot as "Install app" / "Share app")
- WhatsApp messages sent to opponents get translated too — into the sender's chosen language (no way to know the recipient's preference unless they've also set one)
- No Google Cloud account, no API key, no card on file, no usage meter, no Supabase translation cache, no edge function — the translated text is just static files shipped with the app, like any other asset
- **Tradeoff to accept:** there's no "auto-translate anything on demand" fallback. A 12th language outside this list needs its own translated file generated later (by Claude in a future chat, or a human translator) before it can be added — unlike an API, which could generate any language live.

## 2. Timezone-aware scheduling

**Goal:** Solve cross-timezone match scheduling, now that the ladder is round robin and the app may be advertised globally.

### 2a. Detect each player's timezone/country
- Primary source: browser/device timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) — accurate, live, no permission prompt, works even for multi-timezone countries
- Fallback: derive country from the phone number's calling code (already stored, since `wa.me` links require it) — used only if browser detection fails
- Store the resolved timezone/country on the profile

### 2b. Show it on the ladder / fixtures
- Country flag next to each opponent's profile photo
- "Their local time" shown next to their name on fixture cards

### 2c. Suggested best time to play
- Using each player's typical playing window (default 5pm–10pm, confirmed as clients' actual habit), calculate the overlap between both players' windows
- Show a concrete suggestion on the fixture card, e.g. "Suggested: 7–8 PM your time (9–10 PM their time)"
- If there's genuinely no overlap (5+ hour gap), say so honestly instead of forcing a fake suggestion

### 2d. Region-grouped round-robin signups
- Before a round robin locks and generates fixtures, group signups by rough time-zone band so no generated pairing exceeds roughly a 4-hour gap — keeps every fixture realistically playable within the 5pm–10pm habit, instead of relying on 2c to rescue an impossible pairing after the fact
- This is the piece that matters most if/when advertising worldwide — 2a–2c help people coordinate, but only this prevents genuinely unschedulable pairings from being created in the first place

---

## Suggested build order
1. **2a → 2b → 2c** can ship together as one feature (they share the same data and reinforce each other).
2. **2d** is a separate, slightly bigger change since it touches how round robins are generated — best done once 2a's timezone data exists for people at signup time.
3. **Language support (1)** is fully independent and can be built in parallel or after, whichever gets tackled first. It's also now simpler to sequence since it no longer depends on any external account setup.

---

## 3. Priority languages (UTC+0 / UTC+4 band, i.e. 2 hrs behind/ahead of UTC+2)

11 distinct languages, all generated once as static files — no character quota or free-tier limit to track, since there's no API involved.

1. English — UK, Ghana, Sierra Leone, Liberia, Gambia (UTC+0); Mauritius, Seychelles (UTC+4)
2. Irish — Ireland (UTC+0)
3. Portuguese — Portugal (UTC+0)
4. Icelandic — Iceland (UTC+0)
5. French — Senegal, Mali, Burkina Faso, Côte d'Ivoire, Guinea, Togo (UTC+0); Mauritius, Seychelles, Réunion (UTC+4)
6. Arabic — Mauritania (UTC+0); UAE, Oman (UTC+4)
7. Danish — Faroe Islands, co-official (UTC+0, edge case)
8. Azerbaijani — Azerbaijan (UTC+4)
9. Armenian — Armenia (UTC+4)
10. Georgian — Georgia (UTC+4)
11. Russian — Russia's Samara time zone (UTC+4)

---

## 4. Self-serve build plan (do-it-yourself steps)

Reason this is still partly self-serve: the code-writing side (i18next setup, string extraction, translated file generation) can be done in chat, but **installing packages and deploying/testing** need to happen on your own machine/Vercel project, since this environment doesn't have network access to that project.

Note how much shorter this is than the original plan — no Google Cloud project, no API key, no Supabase migration, no edge function, no cost dashboard to check.

### Step 1 — Add the i18n framework
1. `npm install react-i18next i18next i18next-browser-languagedetector`
2. Create `src/i18n.js`: initializes i18next, wires up the browser language detector, loads the static locale files (all 11, bundled directly — no runtime fetch needed), sets English as the fallback language.
3. Wrap the app root (`main.jsx` or equivalent) with i18next's provider setup.
4. Create `src/locales/en.json` as the single source-of-truth file — every UI string will live here as a `"key": "English text"` pair.

### Step 2 — Extract strings from the app
1. Go file by file (`App.jsx` first — it's the largest, then `Shop.jsx`, `leagueLadder.js`, etc.).
2. For each hardcoded string shown to a user (buttons, labels, toasts, modal text, WhatsApp message templates), replace it with a `t("some.key")` call from `useTranslation()`, and add the English text to `en.json` under that key.
3. This is the biggest chunk of manual work given the file size — go section by section (Header, Home, PublicHome, modals, WhatsApp templates) rather than trying to do it all at once, and test as you go so nothing silently breaks.

### Step 3 — Generate the translated locale files
1. Once `en.json` is finalized (all keys extracted), generate the other 10 locale files (`ga.json` Irish, `pt.json`, `is.json`, `fr.json`, `ar.json`, `da.json`, `az.json`, `hy.json`, `ka.json`, `ru.json`) as direct translations of `en.json`, key-for-key — this can be done in a chat session, no external calls required.
2. Drop each file into `src/locales/`.

### Step 4 — Wire up the language switcher
1. Add the language switcher to the header menu (same pattern as "Install app" / "Share app" from earlier work).
2. On selection, i18next swaps to the already-bundled locale file — instant, since nothing needs to be fetched or generated at runtime.

### Step 5 — Test
1. Click through the switcher for each of the 11 languages and confirm strings render correctly, including WhatsApp templates and RTL layout for Arabic.
