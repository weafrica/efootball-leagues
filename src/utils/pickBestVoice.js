// Picks the best available natural-sounding US English female voice out of
// whatever the browser/OS ships. Browsers vary a lot here — Edge's "Online
// (Natural)" voices and Chrome's Google voices sound far more human than
// the default system voice, so we look for those by name first, then fall
// back progressively (any en-US voice, then any English voice, then just
// let the browser use its default).
//
// Shared by App.jsx's comment/notification read-aloud (commentSpeech) and
// Rules.jsx's own independent read-aloud feature — both need the exact same
// voice-picking logic, so it lives here once instead of being duplicated.
export function pickBestVoice(voices) {
  if (!voices || !voices.length) return null;
  const preferredNames = [
    "Microsoft Jenny Online (Natural)",
    "Microsoft Aria Online (Natural)",
    "Google US English",
    "Samantha",
    "Microsoft Zira",
  ];
  for (const name of preferredNames) {
    const match = voices.find((v) => v.name.includes(name));
    if (match) return match;
  }
  const maleHints = ["male", "david", "mark", "guy", "fred", "alex", "daniel", "james", "tom"];
  const isLikelyFemale = (v) => !maleHints.some((h) => v.name.toLowerCase().includes(h));
  const usVoices = voices.filter((v) => v.lang === "en-US" || v.lang === "en_US");
  const usFemale = usVoices.find(isLikelyFemale);
  if (usFemale) return usFemale;
  if (usVoices.length) return usVoices[0];
  const enVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
  const enFemale = enVoices.find(isLikelyFemale);
  return enFemale || enVoices[0] || voices[0];
}
