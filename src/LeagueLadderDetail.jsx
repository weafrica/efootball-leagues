// src/LeagueLadderDetail.jsx
//
// WEAFRICA LEAGUE LADDER SYSTEM — Phase 2 minimal UI, extended in Phase 6
// with a countdown display for pending fixtures (countdown_expires_at is
// now populated by generateRoundRobinFixtures/_generate_round_robin_
// fixtures_internal's staggered release schedule) and a due-soon warning
// once a fixture's window is closing — the sweep job (hourly,
// _ladder_forfeit_expired_fixtures_internal) is what actually turns an
// expired pending fixture into a forfeit; this is read-only, it doesn't
// enforce anything itself.
//
// Deliberately small: read-only standings + fixture list + a manual score
// entry for pending fixtures, enough to run the "2-3 fake weeks end-to-end,
// confirm standings/tie-breaks come out right" check from Phase 2's own
// checklist. No join flow, no bidding UI, no fee display, no promotion/
// relegation UI — none of that exists yet (Phases 3-5). This screen is a
// test harness as much as a feature.
//
// Named LeagueLadderDetail rather than LadderDetail specifically to avoid
// colliding with the existing Ladder.jsx/LadderPage, which is the
// unrelated Survival Ladder Cup format — same "ladder" word, different
// system entirely.

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowLeft, Trophy, Gavel, Star, Check, X, ShieldAlert, Pencil, RotateCcw, Camera, Image as ImageIcon, Search, PiggyBank, ChevronRight, Flame, TrendingUp, Users, MessageCircle, ListChecks, CalendarDays, Send, Heart, Trash2 } from "lucide-react";
import { supabase } from "./supabaseClient";
import { computeStandings, classifyLadderZones } from "./formats/leagueLadder.js";
import { watchLadderBidTicker, placeLadderBidRpc } from "./ladderBidTicker.js";
import { ladderEntryFeeForTier } from "./economy.js";
import { getLadderTierTheme } from "./ladderTierThemes.js";
import { NetsAmount } from "./NetCoinIcon";
import CountdownBadge from "./CountdownBadge.jsx";
import { FacebookHighlightsIcon } from "./FacebookHighlightsPrompt.jsx";
import { WhatsAppLink, WhatsAppCallLink, waLink, WHATSAPP_GREEN } from "./App.jsx";
import { Globe } from "lucide-react";
import { countryCodeToFlagEmoji, countryName, formatLocalTimeNow, suggestPlayTime } from "./utils/timezone.js";
// Same upload path Survivor Ladder Cup's submitLadderCupMatchResult uses
// (App.jsx) — downscale client-side, then straight to the shared
// "result-proofs" Blob bucket (src/utils/blobUpload.js's KNOWN_BUCKETS).
// submit_ladder_fixture_result (20260888) already accepts and stores
// p_proof_url; only the client side was missing it here.
import { compressImage } from "./utils/imageCompress.js";
import { uploadToR2 } from "./utils/r2Upload.js";
import { withTimeout } from "./utils/withTimeout.js";

// ZONE_LABEL / ZONE_COLOR_KEY — Elite Safety Zone / Checkpoint Safety /
// Danger Zone badges (Phase 7). Purely cosmetic on top of
// classifyLadderZones' classification; see that function's own header for
// why these never change what actually gets promoted/relegated.
const ZONE_LABEL = {
  elite_safe: "Elite Safety Zone",
  checkpoint_safe: "Checkpoint Safety",
  danger_zone: "Danger Zone",
};

// BID_TICKER_MESSAGES — 50 header/subtext variations for the Live Bid
// Ticker, all leaning into the same true story (see LiveBidTicker's own
// comment below): the pool bidding on THIS league's open spot is always a
// mix of relegated players buying their way straight back in, and
// League-below risers trying to force an early promotion. Each entry is a
// (tier, belowTier) => { header, subtext } template rather than a plain
// string so every variation can drop the real tier numbers in wherever it
// reads naturally, same pattern OPPONENT_CHASE_MESSAGES above uses for the
// WhatsApp nudge templates. LiveBidTicker picks a new random entry every
// time the pending leader actually changes (a new bid winner) — not on
// every bid/raise — so the copy feels alive without flickering mid-raise.
const BID_TICKER_MESSAGES = [
  (t, b) => ({ header: `🔥 Promotion Battle · League ${t}`, subtext: `Relegated fighters buying their way back + League ${b} risers chasing an early leap — highest bid Sunday takes the seat.` }),
  (t, b) => ({ header: `⚔️ War For League ${t}`, subtext: `One seat, two hungry sides: castaways from League ${t} fighting to return, climbers from League ${b} fighting to arrive early.` }),
  (t) => ({ header: `🎯 The Golden Ticket`, subtext: `Buy your way into League ${t} — relegated legends want revenge, the league below wants a shortcut.` }),
  (t) => ({ header: `💰 Deadline Day: League ${t}`, subtext: `Money talks. Whoever bids highest by Sunday walks straight into League ${t} — no fixtures needed.` }),
  (t, b) => ({ header: `🚀 Express Lane to League ${t}`, subtext: `Skip the grind — outbid the field and League ${b}'s best get an instant promotion.` }),
  (t) => ({ header: `🥊 Fight For The Seat`, subtext: `Relegated from League ${t}? Buy back in. Rising from below? Buy your way up. Only one wins.` }),
  (t) => ({ header: `🏆 One Spot. Everyone Wants It.`, subtext: `The League ${t} seat goes to the highest bidder — redemption or promotion, your call.` }),
  (t) => ({ header: `🔥 Bidding War: League ${t}`, subtext: `Every Naira counts. Outbid the field or watch someone else take your League ${t} dream.` }),
  (t) => ({ header: `⏳ Countdown to Promotion`, subtext: `Sunday 23:59 UTC decides who buys their way into League ${t}. Place your bid now.` }),
  (t) => ({ header: `💎 Last Chance Saloon`, subtext: `Relegated players get one shot to buy back into League ${t} before the window shuts.` }),
  (t, b) => ({ header: `📈 Climb Early Or Wait`, subtext: `League ${b}'s best don't have to wait for rank 1 — outbid everyone and jump straight to League ${t}.` }),
  (t) => ({ header: `🎟️ The Ticket Up`, subtext: `Highest bidder wins a golden ticket into League ${t}. Everyone else gets refunded in full.` }),
  (t) => ({ header: `🛡️ Redemption Round`, subtext: `Just relegated from League ${t}? This is your chance to buy your way straight back.` }),
  (t) => ({ header: `👑 Crown Up For Grabs`, subtext: `The League ${t} seat isn't earned this week — it's bought. Who wants it more?` }),
  (t) => ({ header: `🏟️ Transfer Window: League ${t}`, subtext: `Think of this as deadline day — bid big, move up, no fixtures required.` }),
  (t) => ({ header: `⚡ Instant Promotion Auction`, subtext: `Forget waiting for rank 1 — the highest bid buys instant entry into League ${t}.` }),
  (t) => ({ header: `🔓 Unlock League ${t}`, subtext: `One bid stands between you and a League ${t} badge. Make it count.` }),
  (t, b) => ({ header: `🎮 Pay-To-Play Promotion`, subtext: `League ${b} risers and League ${t} exiles, same target: buy the seat before Sunday.` }),
  (t) => ({ header: `🌟 Prove Your Ambition`, subtext: `The highest bidder proves they want League ${t} more than anyone else in the room.` }),
  (t) => ({ header: `🧨 Explosive Bidding Round`, subtext: `Bids are flying for the League ${t} seat — relegated pride vs rising hunger.` }),
  (t) => ({ header: `🏹 Aim For League ${t}`, subtext: `One shot, one seat. Outbid the competition before the clock runs out.` }),
  (t) => ({ header: `💸 Highest Bidder Wins`, subtext: `It's simple: whoever pays the most by Sunday gets the League ${t} seat. Everyone else gets their nets back.` }),
  (t) => ({ header: `🎢 The Comeback Auction`, subtext: `Relegated last week? This is how you undo it — buy your way straight back into League ${t}.` }),
  (t, b) => ({ header: `🏆 Buy Your Promotion`, subtext: `League ${b}'s top climbers don't have to finish first — just outbid the field.` }),
  (t, b) => ({ header: `🔺 Rise Above League ${b}`, subtext: `This auction is your shortcut out of League ${b} and into League ${t}.` }),
  (t) => ({ header: `🥇 The Seat Everyone Wants`, subtext: `Ex-League ${t} players and hungry risers below, same prize, one winner.` }),
  (t) => ({ header: `⏱️ Sunday Deadline: League ${t}`, subtext: `The clock's ticking on the League ${t} seat. Bid now or watch it go.` }),
  (t) => ({ header: `🎯 Target: League ${t}`, subtext: `Whoever puts the most Nairas on the table takes the seat — no fixtures, no draws, just bids.` }),
  (t) => ({ header: `🏦 The Nets War Chest`, subtext: `Dig into your war chest — the League ${t} seat belongs to the biggest spender.` }),
  (t) => ({ header: `🚨 Bidding Alert: League ${t}`, subtext: `A new leader has emerged for the League ${t} seat. Can you top them?` }),
  (t) => ({ header: `🏆 Promotion Isn't Free`, subtext: `Prove it with Nairas — the top bid by Sunday earns a League ${t} badge.` }),
  (t) => ({ header: `🔥 Two Roads, One Prize`, subtext: `Relegated and desperate to return, or rising and eager to skip the queue — same seat, same deadline.` }),
  (t) => ({ header: `💥 High Stakes: League ${t}`, subtext: `Nothing's decided by matches here — just who wants League ${t} enough to pay for it.` }),
  (t) => ({ header: `🏁 Race To Bid`, subtext: `First past the highest bid wins a straight ticket into League ${t}.` }),
  (t, b) => ({ header: `🎖️ Earn It The Fast Way`, subtext: `League ${b} risers can skip the wait — the top bid jumps them straight to League ${t}.` }),
  (t) => ({ header: `🔑 The Key To League ${t}`, subtext: `Someone's about to unlock a League ${t} spot with the biggest bid on the board.` }),
  (t) => ({ header: `🏆 A Second Chance`, subtext: `Relegated from League ${t}? Nets can buy you straight back — if you bid high enough.` }),
  (t, b) => ({ header: `⚔️ Clash Of Ambitions`, subtext: `League ${t} exiles vs League ${b} climbers — only the highest bidder gets the seat.` }),
  (t) => ({ header: `💰 Show Me The Nets`, subtext: `The League ${t} seat has a price tag, and someone's about to pay it.` }),
  (t) => ({ header: `🌋 Eruption Of Bids`, subtext: `The League ${t} seat is heating up — who's ready to go all in?` }),
  (t) => ({ header: `🏆 Buy The Badge`, subtext: `League ${t} status isn't just earned on the pitch this week — it's bought.` }),
  (t) => ({ header: `🎯 Nobody's Safe`, subtext: `Any leader here can be outbid before Sunday — keep watching, keep bidding.` }),
  (t) => ({ header: `🔥 The Real Final`, subtext: `Forget fixtures — this bidding war decides who joins League ${t}.` }),
  (t, b) => ({ header: `🏆 Chase The Seat`, subtext: `League ${b}'s hungriest and League ${t}'s exiles collide over one open spot.` }),
  (t) => ({ header: `💸 Money Moves`, subtext: `One bid can undo a relegation or fast-track a promotion. Choose your move.` }),
  (t, b) => ({ header: `🚀 Jump The Queue`, subtext: `Why wait to finish top of League ${b} when you can just outbid your way into League ${t}?` }),
  (t) => ({ header: `🏆 The Auction Never Sleeps`, subtext: `Every new bid could flip who's heading into League ${t}. Stay sharp.` }),
  (t) => ({ header: `🔥 Winner Takes The Badge`, subtext: `One League ${t} seat, unlimited ambition — only the top bid gets it.` }),
  (t) => ({ header: `🏆 Prove You Belong`, subtext: `League ${t} isn't given here, it's bought by whoever wants it most.` }),
  (t) => ({ header: `⚡ Final Call: League ${t}`, subtext: `Last chance to bid before Sunday 23:59 UTC decides the League ${t} seat.` }),
];

// RANK1_SAFE_MESSAGES — 20 congratulatory variations for rank 1, shown in
// place of this league's LiveBidTicker (see the render below). Rank 1
// auto-promotes at week close (resolveLadderWeek) regardless of what
// anyone bids, so the bidding war for a spot in League {tier} has nothing
// to do with them — showing it anyway would read as "you might need to
// bid to stay," which isn't true. One is picked at random per mount, same
// non-live pick as BID_TICKER_MESSAGES's initial index, just never
// re-rolled since there's no "leader changed" moment to react to here.
const RANK1_SAFE_MESSAGES = [
  (t) => `👑 Top of the table. No bid required — you're already through to League ${t - 1}.`,
  (t) => `🏆 Rank 1 and locked in. League ${t - 1} is yours, bid-free.`,
  (t) => `🎉 You're the one everyone else is bidding to catch. Promotion's already secured.`,
  (t) => `⭐ First place doesn't negotiate. You're through to League ${t - 1} automatically.`,
  (t) => `🚀 Nothing to bid on here — you punched your ticket to League ${t - 1} on the pitch.`,
  (t) => `🥇 Sitting pretty at #1. The bidding war below is for everyone else's seat, not yours.`,
  (t) => `💪 Earned, not bought. Rank 1 walks straight into League ${t - 1}.`,
  (t) => `🔥 Untouchable at the top. Your promotion's already confirmed — save your Nairas.`,
  (t) => `🏅 No auction for you — first place goes up automatically, every time.`,
  (t) => `📈 You did the hard part already. Rank 1 = automatic League ${t - 1} promotion.`,
  (t) => `🎯 Mission accomplished. You're through to League ${t - 1} — no bidding needed.`,
  (t) => `✨ The safest spot on the whole ladder. Enjoy it — League ${t - 1} awaits.`,
  (t) => `🏆 Champions don't bid, they qualify. See you in League ${t - 1}.`,
  (t) => `👑 Rank 1 status: promotion guaranteed, bid box not required.`,
  (t) => `🚨 Relax — the bidding war below is background noise. You're already promoted.`,
  (t) => `💯 Perfect position. First place skips the auction entirely.`,
  (t) => `🎊 Congratulations — top spot means an automatic seat in League ${t - 1}.`,
  (t) => `🏆 You out-earned the bidders. Rank 1 promotes for free.`,
  (t) => `⚡ No stress, no bidding — #1 is a straight line to League ${t - 1}.`,
  (t) => `🌟 The view from the top: guaranteed promotion, zero Nairas spent.`,
];

// RANK1_TOP_TIER_MESSAGES retired — League 1's non-danger-zone members
// (not just rank 1) now get KIT_ROOM_MESSAGES below instead, per request.

// KIT_ROOM_MESSAGES — 50 short, exciting congratulatory variations for
// League 1 members who are safe (i.e. not one of the bottom 2 in the
// Danger Zone). League 1 has no league above it to promote into and no
// bidding pool they're part of either way (this league's own LiveBidTicker
// pool is previously-relegated players + League 2 risers, never a
// currently-safe League 1 member — see the DangerZoneBanner comment
// above), so showing them a bid ticker for their own seat would be pure
// noise. Nudges The Kit Room (the existing items/market feature) as a
// place to cash in the seat's prestige instead. One picked at random per
// mount, name filled in from nameFor(session.user.id).
const KIT_ROOM_MESSAGES = [
  (n) => `👑 ${n}, League 1 is still yours. No bid needed — just enjoy it.`,
  (n) => `🏆 Safe as houses, ${n}. Top league, zero bidding required.`,
  (n) => `🔥 ${n}'s not going anywhere. League 1 stays locked in.`,
  (n) => `💎 ${n}, that's a League 1 seat — and it's paid for already.`,
  (n) => `🎉 No bid box for you, ${n}. You're already at the summit.`,
  (n) => `🥇 ${n}, top tier, no ticket needed. Just flex it.`,
  (n) => `⭐ Safe in League 1, ${n}. Fancy selling that seat in The Kit Room?`,
  (n) => `🚀 ${n} stays untouchable in League 1 — no bidding required.`,
  (n) => `👑 Prestige status confirmed, ${n}. List it in The Kit Room if you dare.`,
  (n) => `💰 ${n}, your League 1 spot is worth something — The Kit Room's open.`,
  (n) => `🏆 ${n} is elite. No bid, no worries — just top-flight comfort.`,
  (n) => `🔒 Locked into League 1, ${n}. Bidding? Not your problem.`,
  (n) => `✨ ${n}, that's a top-league seat. Cash it in on The Kit Room?`,
  (n) => `🎊 No bidding here, ${n} — you're safe at the very top.`,
  (n) => `🥂 League 1 royalty, ${n}. Sell the seat or savor it — your call.`,
  (n) => `💪 ${n} earned this. Top tier, no auction attached.`,
  (n) => `🏅 Safe zone, ${n}. Prestige seat, and it's yours to keep or sell in The Kit Room.`,
  (n) => `🚨 Relax, ${n} — the bidding war isn't for you. You're safe.`,
  (n) => `👑 ${n}, top of the food chain. No bid required, ever.`,
  (n) => `🔥 ${n} owns a League 1 badge. The Kit Room would pay well for that.`,
  (n) => `💎 Elite and untouchable, ${n}. That seat's a flex, not a fight.`,
  (n) => `🏆 ${n}, no bidding drama for you — top league, secured.`,
  (n) => `🎯 Safe zone confirmed, ${n}. Fancy listing that seat in The Kit Room?`,
  (n) => `⚡ ${n} stays put in League 1 — no bid, no stress.`,
  (n) => `🥇 Prestige unlocked, ${n}. That seat's worth Nairas in The Kit Room.`,
  (n) => `👑 League 1, no auction, all ${n}.`,
  (n) => `🎉 ${n}, you're safe — the bid box is for someone else this week.`,
  (n) => `🔒 Top tier, ${n}. Locked in, nothing to bid for.`,
  (n) => `💰 That's a prestigious seat, ${n}. The Kit Room's buying, if you're selling.`,
  (n) => `🏆 ${n} stays in League 1. Sell the badge in The Kit Room or keep flexing it.`,
  (n) => `✨ Safe and sound, ${n} — League 1 doesn't ask you to bid.`,
  (n) => `🥂 ${n}, top-flight for another week. No bid required.`,
  (n) => `👑 ${n} rules League 1. Bidding's beneath you.`,
  (n) => `🔥 Nothing to bid on, ${n} — you're already elite.`,
  (n) => `💎 ${n}'s seat is prestige on legs. The Kit Room wants it.`,
  (n) => `🏅 Safe zone, ${n}. Enjoy the view from the top.`,
  (n) => `🎊 ${n}, League 1 doesn't need a bid from you — it's already yours.`,
  (n) => `⚡ ${n} stays elite. No auction, no drama.`,
  (n) => `🥇 Untouchable, ${n}. Sell the seat in The Kit Room if you're feeling generous.`,
  (n) => `👑 ${n}, that's a top-league flex — no bid attached.`,
  (n) => `💪 ${n} earned safety. League 1, secured.`,
  (n) => `🎯 No bid needed, ${n}. You're locked into League 1.`,
  (n) => `🏆 ${n}'s prestige seat is safe — and sellable, if The Kit Room tempts you.`,
  (n) => `🔒 Safe zone, ${n}. Top tier, no strings attached.`,
  (n) => `💰 ${n}, that badge is worth Nairas. The Kit Room's calling.`,
  (n) => `🥂 ${n} stays at the top — no bidding, just bragging rights.`,
  (n) => `👑 League 1's finest, ${n}. No bid box for royalty.`,
  (n) => `🎉 Safe, elite, and prestige-loaded, ${n}. Sell it in The Kit Room or flex it.`,
  (n) => `🔥 ${n}, top tier and untouchable. The Kit Room would love that seat.`,
  (n) => `🏅 ${n} keeps the crown — League 1, no bid required.`,
];

// ─────────────────────────────────────────────────────────────────────
// MEMBERS PANEL — admin-only "find a member, send them a ready WhatsApp
// message" tool (see LadderMembersPanel below). Mirrors the "reminded"
// highlight pattern from markWaReminder/isWaReminderActive in App.jsx
// (see WA-REMINDER-MIGRATION.md), but scoped to ladder_memberships since
// League Ladder participants live there, not in the regular `members`
// table — see LADDER-MEMBERS-MIGRATION.md for the required column.
// ─────────────────────────────────────────────────────────────────────

const LADDER_WA_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000; // same window as the regular-league version

// LADDER_MEMBER_WA_HOOKS — 50 short, exciting openers for the per-member
// "ready message" WhatsApp icon in the Members panel. Each one already
// bakes in the member's name and their live ladder position
// (ctx.rankLabel, e.g. "#3" — or "the ladder" as a graceful fallback
// before any fixtures have been played), so every variation genuinely
// reads as a different message rather than a reused template with one
// swapped word. buildLadderMemberMessage below appends the (optional)
// best-time-to-play line, the "call me" quick-response line, and the
// weafrica.co.za link — those three stay constant since they're
// instructions/data, not creative copy, so they don't need 50 versions
// of their own. Rotation across taps (never the same hook twice in a
// row for the same member) is handled by nextLadderMemberMsgIndex.
const LADDER_MEMBER_WA_HOOKS = [
  (ctx) => `🔥 ${ctx.name}, you're sitting at ${ctx.rankLabel} right now — let's keep the run going!`,
  (ctx) => `⚡ Big week on deck, ${ctx.name}! ${ctx.rankLabel} is yours to defend.`,
  (ctx) => `🏆 ${ctx.name}, ${ctx.rankLabel} on the ladder and climbing. Let's lock this one in.`,
  (ctx) => `🎯 Eyes on the target, ${ctx.name} — ${ctx.rankLabel} won't hold itself.`,
  (ctx) => `🚀 ${ctx.name} is flying at ${ctx.rankLabel}! Time to book the next win.`,
  (ctx) => `👑 ${ctx.rankLabel} and looking good, ${ctx.name}. Don't sleep on this fixture!`,
  (ctx) => `⭐ ${ctx.name}, ${ctx.rankLabel} on the table — one more win moves you up.`,
  (ctx) => `🥇 Currently ${ctx.rankLabel}, ${ctx.name} — let's make sure it stays that way.`,
  (ctx) => `💪 ${ctx.name}, you've earned ${ctx.rankLabel}. Now let's defend it!`,
  (ctx) => `🎮 Controller ready, ${ctx.name}? ${ctx.rankLabel} on the ladder is calling.`,
  (ctx) => `🔥🔥 ${ctx.name} at ${ctx.rankLabel} — the pressure's on the rest of the league, not you.`,
  (ctx) => `📈 ${ctx.name}, you're trending upward at ${ctx.rankLabel}. Keep it climbing!`,
  (ctx) => `🛡️ ${ctx.rankLabel} is your spot to protect this week, ${ctx.name}.`,
  (ctx) => `🎉 Congrats on ${ctx.rankLabel}, ${ctx.name} — let's back it up on the pitch.`,
  (ctx) => `⚽ ${ctx.name}, matchday's close and you're ${ctx.rankLabel}. Let's finish strong.`,
  (ctx) => `🏁 ${ctx.name} holding ${ctx.rankLabel} — the chasing pack is right behind you!`,
  (ctx) => `💥 ${ctx.rankLabel} on the ladder, ${ctx.name}. One result decides what's next.`,
  (ctx) => `🥊 ${ctx.name}, this week's fixture could push you past ${ctx.rankLabel}. Let's go!`,
  (ctx) => `🌟 ${ctx.name}, ${ctx.rankLabel} suits you. Let's keep the momentum rolling.`,
  (ctx) => `🎖️ Standing at ${ctx.rankLabel}, ${ctx.name} — a big scalp this week seals it.`,
  (ctx) => `🚨 Heads up ${ctx.name} — ${ctx.rankLabel} is live and your fixture's ready.`,
  (ctx) => `🔱 ${ctx.name}, ${ctx.rankLabel} on the ladder. Time to make a statement.`,
  (ctx) => `🏅 ${ctx.rankLabel} and hungry for more, ${ctx.name}? Let's set up the match.`,
  (ctx) => `💫 ${ctx.name} shining at ${ctx.rankLabel} — let's keep that shine going.`,
  (ctx) => `🥂 Cheers to ${ctx.rankLabel}, ${ctx.name}. Now let's earn the next one.`,
  (ctx) => `🧨 ${ctx.name}, ${ctx.rankLabel} on the board and the ladder's heating up.`,
  (ctx) => `🎊 ${ctx.rankLabel}, ${ctx.name}! Let's keep the good results coming.`,
  (ctx) => `⚔️ ${ctx.name}, this week's clash could rewrite ${ctx.rankLabel}. Ready?`,
  (ctx) => `🕹️ ${ctx.name} at ${ctx.rankLabel} — controllers up, let's get this fixture sorted.`,
  (ctx) => `💯 ${ctx.rankLabel} and no signs of slowing down, ${ctx.name}!`,
  (ctx) => `🏆 ${ctx.name}, every week at ${ctx.rankLabel} counts. Let's play this one.`,
  (ctx) => `🔥 The ladder's watching, ${ctx.name} — ${ctx.rankLabel} and rising.`,
  (ctx) => `🎯 Locked in at ${ctx.rankLabel}, ${ctx.name}. Let's find a time to play.`,
  (ctx) => `🚀 ${ctx.name}, launch week! ${ctx.rankLabel} could move again after this one.`,
  (ctx) => `👊 ${ctx.name} holding strong at ${ctx.rankLabel} — let's finish the job.`,
  (ctx) => `🌍 ${ctx.name}, ${ctx.rankLabel} on the weAfrica ladder. Let's set this match up.`,
  (ctx) => `📣 Shoutout to ${ctx.name} at ${ctx.rankLabel} — your fixture's waiting!`,
  (ctx) => `🥇 ${ctx.rankLabel} suits you well, ${ctx.name}. Let's keep it that way this week.`,
  (ctx) => `⏱️ Clock's ticking, ${ctx.name} — ${ctx.rankLabel} and a fixture to play.`,
  (ctx) => `🎆 ${ctx.name}, ${ctx.rankLabel} on the ladder — let's light this week up.`,
  (ctx) => `🏆 Champions are made at ${ctx.rankLabel}, ${ctx.name}. Let's get it done.`,
  (ctx) => `🔋 ${ctx.name} fully charged at ${ctx.rankLabel} — let's book this fixture.`,
  (ctx) => `🥁 Drumroll for ${ctx.name} — ${ctx.rankLabel} and one more win to build on.`,
  (ctx) => `🎇 ${ctx.rankLabel}, ${ctx.name}! Every match counts from here.`,
  (ctx) => `🛎️ Quick one, ${ctx.name} — ${ctx.rankLabel} and your next fixture is ready to go.`,
  (ctx) => `🏹 ${ctx.name}, take aim from ${ctx.rankLabel} — let's push higher this week.`,
  (ctx) => `🎈 ${ctx.rankLabel} and climbing, ${ctx.name}! Let's keep the streak alive.`,
  (ctx) => `🧭 ${ctx.name}, ${ctx.rankLabel} on the map. Let's chart the next win.`,
  (ctx) => `🥋 ${ctx.name} defending ${ctx.rankLabel} this week — let's get it locked in.`,
  (ctx) => `🎬 Action time, ${ctx.name}! ${ctx.rankLabel} and a fixture to settle.`,
];

// buildLadderMemberMessage — composes the actual WhatsApp text from one
// hook plus the shared, data-driven parts requested for every message:
// the best-time-to-play line (from suggestPlayTime, only when both
// players' timezones are on file — omitted gracefully otherwise), the
// "call me for the fastest response" line, and the weafrica.co.za link.
function buildLadderMemberMessage(hookIndex, ctx) {
  const hook = LADDER_MEMBER_WA_HOOKS[hookIndex % LADDER_MEMBER_WA_HOOKS.length](ctx);
  const lines = [hook];
  if (ctx.timeLine) lines.push(ctx.timeLine);
  lines.push(`📞 Call me for the quickest response!`);
  lines.push(`🌍 weafrica.co.za`);
  return lines.join("\n");
}

// nextLadderMemberMsgIndex — picks the next hook so the same member never
// gets the same message twice in a row across separate taps, persisted
// per-browser in localStorage (no DB round trip needed for this part —
// see LADDER-MEMBERS-MIGRATION.md). Cycles through all 50 before any
// repeat, then wraps around.
function nextLadderMemberMsgIndex(leagueId, userId) {
  const key = `ladder-wa-msg:${leagueId}:${userId}`;
  let last = -1;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) last = parseInt(stored, 10);
  } catch { /* storage unavailable, e.g. private browsing — just start at 0 */ }
  const next = (Number.isFinite(last) ? last + 1 : 0) % LADDER_MEMBER_WA_HOOKS.length;
  try { localStorage.setItem(key, String(next)); } catch { /* best effort only */ }
  return next;
}

// isLadderMemberWaReminderActive / markLadderMemberWaReminder /
// clearLadderMemberWaReminder — the ladder_memberships equivalent of
// isWaReminderActive/markWaReminder/clearWaReminder in App.jsx. Kept
// self-contained here (rather than lifted into App.jsx and threaded
// through as props) since the Members panel already has everything it
// needs locally: `supabase`, `session`, and the member rows themselves.
export function isLadderMemberWaReminderActive(m) {
  if (!m?.wa_reminder_due_at) return false;
  return Date.now() - new Date(m.wa_reminder_due_at).getTime() < LADDER_WA_REMINDER_WINDOW_MS;
}

// Same keepalive-fetch pattern as markWaReminder in App.jsx — the write
// races the browser navigating away to open WhatsApp, so a raw fetch
// with keepalive:true is used instead of a normal supabase-js call (see
// that function's own comment for the full reasoning). session is read
// synchronously (never re-fetched here) for the same reason: an
// in-flight token refresh could itself get cut off by the same
// navigation race.
async function markLadderMemberWaReminder(session, leagueId, userId, onLocalUpdate) {
  const token = session?.access_token;
  const sentAt = new Date().toISOString();
  onLocalUpdate?.(sentAt); // update the UI instantly, independent of the network call below
  if (!token) { console.warn("[ladder-wa-reminder] skipped — no session token"); return; }
  try {
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/ladder_memberships?league_id=eq.${leagueId}&user_id=eq.${userId}&status=eq.active`,
      {
        method: "PATCH",
        keepalive: true,
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ wa_reminder_due_at: sentAt }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[ladder-wa-reminder] PATCH failed", res.status, body);
    } else {
      console.log("[ladder-wa-reminder] PATCH ok for", userId, sentAt);
    }
  } catch (err) {
    console.error("[ladder-wa-reminder] PATCH threw", err);
  }
}

async function clearLadderMemberWaReminder(leagueId, userId, onLocalUpdate) {
  onLocalUpdate?.();
  const { error } = await supabase.from("ladder_memberships")
    .update({ wa_reminder_due_at: null }).eq("league_id", leagueId).eq("user_id", userId).eq("status", "active");
  if (error) console.error("[ladder-wa-reminder] clear failed", error);
}

// LadderMembersPanel — admin-only. "Find user first" search box up top
// (per request), then every current member with their live ladder
// position, a flag + local time when known, and a WhatsApp icon that
// sends the rotating ready message built above and flags the row red for
// every admin, same highlight as the regular members list.
function LadderMembersPanel({ leagueId, tier, members, profilesById, standings, fixtures, session, reminders, onSent, onCleared, c }) {
  const [query, setQuery] = useState("");

  if (!members || members.length === 0) return null;

  const rankByUser = {};
  standings.forEach((row, i) => { rankByUser[row.user_id] = i + 1; });

  const opponentByUser = {};
  (fixtures || []).forEach((f) => {
    if (f.home_user_id) opponentByUser[f.home_user_id] = f.away_user_id;
    if (f.away_user_id) opponentByUser[f.away_user_id] = f.home_user_id;
  });

  const q = query.trim().toLowerCase();
  const filtered = q
    ? members.filter((uid) => {
        const p = profilesById[uid];
        return (p?.efootball_username || "").toLowerCase().includes(q) || (p?.phone || "").toLowerCase().includes(q);
      })
    : members;

  const remindedCount = filtered.filter((uid) => isLadderMemberWaReminderActive({ wa_reminder_due_at: reminders[uid] })).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Users size={16} style={{ color: c.accent }} />
        <span className="text-sm font-bold" style={{ color: c.text, fontFamily: c.font }}>Members</span>
        <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>({members.length})</span>
      </div>

      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a member first — search by username or phone…"
          className="w-full border rounded-lg pl-8 pr-3 py-2 font-body text-xs outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      {remindedCount > 0 && (
        <div className="flex justify-end mb-2">
          <span className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>
            {remindedCount} messaged recently
          </span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="border border-dashed rounded-xl p-4 text-center font-body text-xs" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No member matches "{query}".
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((uid) => (
            <LadderMemberRow key={uid} leagueId={leagueId} tier={tier} userId={uid}
              profile={profilesById[uid]} rank={rankByUser[uid] || null}
              opponentProfile={opponentByUser[uid] ? profilesById[opponentByUser[uid]] : null}
              session={session}
              reminderAt={reminders?.[uid] ?? null}
              onSent={(sentAt) => onSent(uid, sentAt)}
              onCleared={() => onCleared(uid)}
              c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function LadderMemberRow({ leagueId, tier, userId, profile, rank, opponentProfile, session, reminderAt, onSent, onCleared, c }) {
  const reminded = isLadderMemberWaReminderActive({ wa_reminder_due_at: reminderAt });
  const name = profile?.efootball_username || "Unknown player";
  const flag = countryCodeToFlagEmoji(profile?.country_code);
  const localTime = profile?.timezone ? formatLocalTimeNow(profile.timezone) : null;

  const rankLabel = rank ? `#${rank}` : "the ladder";

  let timeLine = null;
  if (profile?.timezone && opponentProfile?.timezone) {
    const suggestion = suggestPlayTime(profile.timezone, opponentProfile.timezone);
    if (suggestion?.hasOverlap) {
      timeLine = `⏰ Best time to play ${opponentProfile.efootball_username || "your opponent"}: ${suggestion.myRangeLabel} your time (${suggestion.theirRangeLabel} for them).`;
    }
  }

  const digitsOnly = (profile?.phone || "").replace(/\D/g, "");

  const sendMessage = () => {
    const hookIndex = nextLadderMemberMsgIndex(leagueId, userId);
    const text = buildLadderMemberMessage(hookIndex, { name, rankLabel, timeLine });
    markLadderMemberWaReminder(session, leagueId, userId, onSent);
    window.open(waLink(profile.phone, text), "_blank", "noopener,noreferrer");
  };

  return (
    <div className="rounded-lg px-3 py-2 border transition-colors" style={reminded ? { background: c.redSoft, borderColor: c.red } : { background: c.surface, borderColor: "transparent" }}>
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.accent, color: c.accentText }}>
          {name[0]?.toUpperCase() || "?"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-body text-sm truncate flex items-center gap-1.5" style={{ color: c.text }}>
            <span className="truncate font-semibold">{name}</span>
            <span className="font-mono text-[10px] shrink-0" style={{ color: c.accent }}>{rankLabel !== "the ladder" ? rankLabel : ""}</span>
          </div>
          <div className="font-mono text-[10px] flex items-center gap-1 truncate" style={{ color: c.textFaint }}>
            {flag && <span>{flag}</span>}
            {localTime && <span>{localTime} their time</span>}
            {!flag && !localTime && (profile?.phone || "No number on file")}
          </div>
        </div>
        {digitsOnly ? (
          <button onClick={sendMessage} title="Send ready WhatsApp message" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: WHATSAPP_GREEN }}>
            <MessageCircle size={14} />
          </button>
        ) : (
          <span className="font-mono text-[9px] shrink-0" style={{ color: c.textFaint }}>No number</span>
        )}
        {reminded && (
          <button onClick={() => clearLadderMemberWaReminder(leagueId, userId, onCleared)} title="Clear reminder highlight" className="w-6 h-6 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}>
            <X size={13} />
          </button>
        )}
      </div>
      {timeLine && (
        <div className="flex items-start gap-1.5 font-body text-[11px] mt-1.5 pl-9" style={{ color: c.accent }}>
          <Globe size={11} className="mt-0.5 shrink-0" />
          <span>{timeLine.replace(/^⏰ /, "")}</span>
        </div>
      )}
    </div>
  );
}

// LiveBidTicker — Phase 5's bidding is fully wired server-side (the RPC,
// the eligibility pool, the bidding_open window that runs through Sunday
// 23:59 UTC). There's no fixed opening day anymore either — 20260875
// removed the separate open-week cron, so a league's bidding_open window
// starts the moment it exists, not on a scheduled weekday (see
// league-ladder-redesign-build-spec.md's addendum). This component is
// just the "button" that window was missing. Shown whenever bidding is
// open for the cycle — place_ladder_bid itself rejects an ineligible
// bidder (or a bid below the floor) server-side, so this doesn't need to
// duplicate that eligibility check client-side to be safe, just to be
// helpful with the error message.
function LiveBidTicker({ leagueId, weekNumber, tier, maxTier, session, c }) {
  const [bids, setBids] = useState([]);
  const [currentLeader, setCurrentLeader] = useState(null); // { userId, name, amount } | null — Phase G
  const [amount, setAmount] = useState("");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState(null);

  // msgIndex — which BID_TICKER_MESSAGES entry is showing. Picked randomly
  // on mount, then re-picked only when the pending LEADER actually changes
  // (a new bid winner), not on every raise/re-render — a leader raising
  // their own bid stays the same leader, so the copy holding steady there
  // is correct, not stale. prevLeaderRef starts at undefined (not null) so
  // the very first real leader (null → someone) still counts as a change
  // and gets its own fresh message instead of reusing the mount-time pick.
  const [msgIndex, setMsgIndex] = useState(() => Math.floor(Math.random() * BID_TICKER_MESSAGES.length));
  const prevLeaderRef = useRef(undefined);

  useEffect(() => {
    let unsub;
    let cancelled = false;
    watchLadderBidTicker(leagueId, weekNumber, ({ bids: rows, currentLeader: leader }) => {
      if (cancelled) return;
      setBids(rows);
      setCurrentLeader(leader);
    }).then((fn) => { unsub = fn; });
    return () => { cancelled = true; unsub?.(); };
  }, [leagueId, weekNumber]);

  useEffect(() => {
    const leaderId = currentLeader?.userId ?? null;
    if (leaderId !== prevLeaderRef.current) {
      prevLeaderRef.current = leaderId;
      setMsgIndex(Math.floor(Math.random() * BID_TICKER_MESSAGES.length));
    }
  }, [currentLeader?.userId]);

  const floor = tier != null && maxTier != null ? ladderEntryFeeForTier(tier, maxTier) : null;
  const myBid = bids.find((b) => b.bidder_user_id === session?.user?.id);

  const submitBid = async () => {
    if (!amount) return;
    setPlacing(true);
    setError(null);
    try {
      await placeLadderBidRpc(leagueId, Number(amount));
      setAmount("");
    } catch (e) {
      setError(e.message || "Bid failed");
    } finally {
      setPlacing(false);
    }
  };

  // The pool bidding on THIS league's open spot is always a mix of two
  // stories (see 20260861_ladder_bidding.sql's _ladder_bid_eligible_pool_
  // internal): players just relegated OUT of this league fighting to buy
  // their way straight back in, and players climbing up from the league
  // below trying to force their way up early. Neither the bids row itself
  // nor watchLadderBidTicker tags which is which, so BID_TICKER_MESSAGES
  // leans into both motives at once rather than guessing per-bidder —
  // "one spot, two directions" is true regardless of who's actually in
  // the list.
  const { header: msgHeader, subtext: msgSubtext } = BID_TICKER_MESSAGES[msgIndex](tier, (tier ?? 0) + 1);

  return (
    <div className="rounded-xl border p-3 overflow-hidden relative" style={{ borderColor: c.accent, background: `${c.accent}0d` }}>
      <div className="flex items-center gap-2 mb-1">
        <Flame size={15} style={{ color: c.accent }} />
        <span className="text-sm font-bold" style={{ color: c.text, fontFamily: c.font }}>
          {msgHeader}
        </span>
      </div>
      <div className="font-body text-[11px] mb-2" style={{ color: c.textFaint }}>
        {msgSubtext}
      </div>
      <div className="flex items-center justify-between mb-2 font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
        <span>⏳ Closes Sun 23:59 UTC</span>
        {floor != null && <span>Floor {floor}N</span>}
      </div>
      <div className="flex flex-col gap-1 mb-2">
        {bids.length === 0 && (
          <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>No bids yet — be the first to stake your claim.</div>
        )}
        {bids.map((b) => {
          // The leader is whichever row is still 'pending' — NOT
          // necessarily bids[0]/the highest amount shown (see
          // ladderBidTicker.js's findLeader for why a voided-but-not-yet-
          // replaced leader can leave a larger amount sitting on an
          // already-'refunded' row above it in this amount-sorted list).
          const isLeader = b.status === "pending" && b.bidder_user_id === currentLeader?.userId;
          const isMe = b.bidder_user_id === session?.user?.id;
          const label = isMe ? "You" : (isLeader && currentLeader?.name) || b.bidder_user_id.slice(0, 8);
          return (
            <div key={b.id} className="flex justify-between font-mono text-xs" style={{ color: isMe ? c.accent : c.text }}>
              <span>{isLeader ? "🏆 " : ""}{label}</span>
              <span>{b.amount}N</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input type="number" min={floor ?? 0} placeholder={myBid ? "Raise your bid" : "Stake your claim…"}
          className="flex-1 rounded font-mono text-xs p-2"
          style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button onClick={submitBid} disabled={placing || !amount}
          className="font-mono text-[10px] uppercase px-3 py-2 rounded flex items-center gap-1"
          style={{ background: c.accent, color: c.accentText }}>
          <TrendingUp size={12} />
          {placing ? "…" : myBid ? "Raise" : "Bid"}
        </button>
      </div>
      {error && <div className="font-mono text-[10px] mt-1" style={{ color: c.red }}>{error}</div>}
    </div>
  );
}

// FORFEITED_DISPLAY_LABELS — the on-screen word for a fixture whose
// status is 'forfeited' server-side. Deliberately not the word
// "Forfeited" itself: that implies a team actively defaulted, when in
// practice this almost always just means neither side submitted a
// result before the countdown ran out. 50 time-themed variations,
// rotating on a weekly cadence (see forfeitedLabelForWeek below) purely
// for a bit of freshness — the underlying status/scoring is unaffected,
// this only ever touches the label text.
const FORFEITED_DISPLAY_LABELS = [
  "Expired", "Auto-Expired", "Timed Out", "Lapsed", "Deadline Passed",
  "Overdue", "Match Expired", "Time Elapsed", "Missed", "Ran Out of Time",
  "Time's Up", "Window Closed", "Past Deadline", "Deadline Missed", "Clock Ran Out",
  "Time Expired", "Out of Time", "Deadline Lapsed", "Match Lapsed", "Grace Period Ended",
  "Window Expired", "Time Ran Out", "Late — Expired", "Never Submitted (Expired)", "Beyond Deadline",
  "Slot Expired", "Fixture Expired", "Fixture Lapsed", "Match Window Closed", "Kickoff Missed",
  "Kickoff Expired", "Result Window Closed", "Submission Expired", "Overdue — No Result", "Match Timed Out",
  "Auto-Closed", "Cycle Ended — No Result", "Round Expired", "Round Closed", "Match Not Completed in Time",
  "Time Limit Reached", "Time Limit Exceeded", "Countdown Ended", "Countdown Expired", "Stale — Expired",
  "Aged Out", "Match Aged Out", "Cutoff Passed", "Cutoff Reached", "Match Cutoff Missed",
];

// forfeitedLabelForWeek(date) → picks one FORFEITED_DISPLAY_LABELS entry
// deterministically from the ISO week number, so the label is stable for
// everyone viewing the app in the same week and rotates on its own each
// Monday without needing a deploy. Pure function of the date, no storage.
function forfeitedLabelForWeek(date = new Date()) {
  // ISO week number (1-53): days since the Thursday of this date's week,
  // divided by 7. Using Thursday keeps the calc simple and matches the
  // standard ISO-8601 definition of "week 1 contains the year's first
  // Thursday" closely enough for a label rotation (doesn't need to be
  // audit-grade correct, just consistent).
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  const index = weekNumber % FORFEITED_DISPLAY_LABELS.length;
  return FORFEITED_DISPLAY_LABELS[index];
}

// formatCountdown(expiresAt) → a short human string for how much time is
// left on a pending fixture's 24h window, or "Expired" once past it (the
// hourly sweep hasn't necessarily run yet, so a pending fixture can
// briefly show "Expired" before it flips to 'forfeited' — that's expected,
// not a bug). null in, null out — callers only render this for fixtures
// that actually have a countdown (Phase 6 onward; older/legacy rows can
// still be null).
// OPPONENT_CHASE_MESSAGES — 20 variations of the same "let's lock in a
// time, the clock's running, don't make me claim the walkover" vibe, so
// tapping the WhatsApp icon doesn't send the exact same text every time.
// Each entry is a (name, clock) => string template — `clock` is already a
// fully-formed phrase (built by buildOpponentChaseMessage below) so every
// template can just drop it in wherever it reads naturally, no matter how
// or whether that template mentions the countdown.
const OPPONENT_CHASE_MESSAGES = [
  (name, clock) => `Hi, it's ${name}! 🔥⚽ Our ladder fixture is LIVE — ${clock} before kickoff closes! Reply now so we can lock in a time and battle it out 🎮🏆... don't make me claim the walkover by default 😅`,
  (name, clock) => `Yo it's ${name} 👀🔥 Ladder clash incoming — ${clock}! Lock in a time before I'm forced to claim the walkover 😬⚽`,
  (name, clock) => `${name} here ⚡ Our fixture's ticking — ${clock}! One reply and we're locked in 🎮 No reply and it's a walkover, your call 😏🏆`,
  (name, clock) => `🚨 Fixture alert! It's ${name} — ${clock} on the clock. Let's set a time before this turns into an easy walkover for me 😅⚽`,
  (name, clock) => `Hey, ${name} here 🔥 Our ladder match won't wait — ${clock}! Hit me back so we can play it out properly, not let the clock decide 🕹️🏆`,
  (name, clock) => `It's ${name} ⚽💥 Countdown's live: ${clock}. Reply and let's ball — or I claim the walkover, no hard feelings 😅🏆`,
  (name, clock) => `${name} calling! 📞🔥 ${clock} before our fixture window shuts. Lock in the time now — I'd rather beat you on the pitch than by default 😏⚽`,
  (name, clock) => `Hi it's ${name} 🎮 Ladder fixture's heating up — ${clock}! Reply quick so we can play — silence = walkover 😬🏆`,
  (name, clock) => `${name} here, game face on 😤⚽ ${clock} remaining on our fixture. Let's lock a time in — don't leave me no choice but to claim it 🚨`,
  (name, clock) => `Yo! ${name} 🔥 Our match is on the clock — ${clock}! Reply and let's settle this on the pitch, not on a technicality 😅🏆`,
  (name, clock) => `${name} 🕹️ Time's running on our ladder fixture — ${clock}. Set the time, let's play for real — walkover's boring anyway 😏⚽`,
  (name, clock) => `Hey it's ${name} ⚡🏆 ${clock} to go before this fixture expires! Lock in and let's give the league a show — don't force a walkover 😬`,
  (name, clock) => `${name} here 🔥⚽ Clock's ticking on our match — ${clock}! Reply now, I want the W on the pitch, not by walkover 😅`,
  (name, clock) => `It's ${name} 👊 ${clock} left on our fixture! Reply and let's lock in a time — I'd hate to claim an easy walkover 🏆😏`,
  (name, clock) => `${name} pinging you 📲🔥 Our ladder fixture's got ${clock} left! Let's play it out — reply before the walkover clock wins 😬⚽`,
  (name, clock) => `Hi, ${name} here! 🎮💥 ${clock} until our fixture deadline. Set a time and let's battle — don't make this a walkover story 😅🏆`,
  (name, clock) => `${name} 🔥 Ladder showdown pending — ${clock}! Reply so we lock in a time, because I'd rather earn this win than claim it 😏⚽`,
  (name, clock) => `Yo, ${name} here ⚽⚡ ${clock} on our fixture clock! Let's get it scheduled — reply now or it's walkover time 😬🏆`,
  (name, clock) => `${name} checking in 🔥🎮 Our match has ${clock} left! Lock in the time, let's play for real — I don't want an easy walkover 😅`,
  (name, clock) => `It's ${name}! 🚨⚽ ${clock} before our ladder fixture closes. Reply and let's lock in a time — or I'll have no choice but to claim the walkover 🏆😬`,
];

// buildOpponentTimeLine — the same "where they are / whether our usual
// playing hours actually overlap" info OpponentTimezoneInfo renders
// on-screen (see below), folded into one WhatsApp-ready line so the chase
// message carries it too instead of it only being visible mid-page.
// Overlap -> the suggested window in both time zones; no overlap -> the
// gap in hours, same "say so honestly" approach suggestPlayTime's other
// caller uses rather than forcing a fake suggestion. Returns null (no
// line added) when there's not enough data on file to say anything useful.
function buildOpponentTimeLine(theirLocation, myTimezone) {
  if (!theirLocation?.timezone && !theirLocation?.country_code) return null;

  const flag = countryCodeToFlagEmoji(theirLocation.country_code);
  const countryLabel = countryName(theirLocation.country_code);
  const where = countryLabel ? `${flag ? flag + " " : ""}${countryLabel}` : null;

  const suggestion = myTimezone && theirLocation.timezone ? suggestPlayTime(myTimezone, theirLocation.timezone) : null;
  if (!suggestion) return where ? `📍 They're in ${where}.` : null;

  const whereText = where ? `They're in ${where} — ` : "";
  return suggestion.hasOverlap
    ? `🌍 ${whereText}best overlap is ${suggestion.myRangeLabel} your time (${suggestion.theirRangeLabel} for them).`
    : `🌍 ${whereText}no overlap in our usual hours (~${suggestion.gapHours}h gap) — we'll need to arrange a one-off time.`;
}

// buildOpponentChaseMessage — picks a random template each call (so
// re-clicking the WhatsApp icon sends a different message rather than a
// carbon copy) and folds the live countdown into a natural-reading
// "clock" phrase. No countdown set yet: falls back to a phrase that still
// reads fine in every template above without naming a number. theirLocation/
// myTimezone are optional — when present, appends the country + timezone-
// overlap line above as its own message line; when a profile has neither
// on file, the message is unchanged from before.
function buildOpponentChaseMessage(name, countdownText, theirLocation = null, myTimezone = null) {
  const clock = countdownText ? `⏳ ${countdownText} on the clock` : "the clock's already ticking";
  const template = OPPONENT_CHASE_MESSAGES[Math.floor(Math.random() * OPPONENT_CHASE_MESSAGES.length)];
  const lines = [template(name, clock)];
  const timeLine = buildOpponentTimeLine(theirLocation, myTimezone);
  if (timeLine) lines.push(timeLine);
  return lines.join("\n");
}

function formatCountdown(expiresAt) {
  if (!expiresAt) return null;
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "Expired";
  const hours = Math.floor(msLeft / (3600 * 1000));
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
  if (hours >= 1) return `${hours}h left`;
  return `${Math.max(1, Math.floor(msLeft / (60 * 1000)))}m left`;
}

// ─────────────────────────────────────────────────────────────────────────
// Result-approval helpers — mirror the submit -> confirm/dispute ->
// admin-escalation shape used everywhere else in this app (regular
// fixtures' result_submissions, Survivor Ladder Cup's ladder_cup_matches),
// applied here to ladder_fixture_result_submissions (one row per attempt,
// see 20260887). These are pure/local to this screen rather than reused
// from App.jsx, since App.jsx's equivalents read `result_reported_at` off
// an evolving row — this table has `created_at` on a per-attempt row
// instead.
// ─────────────────────────────────────────────────────────────────────────
const RESULT_CONFIRM_WINDOW_MINUTES = 30;
const DISPUTE_ESCALATION_THRESHOLD = 2;
const ADMIN_AUTO_APPROVE_WINDOW_MINUTES = 60;

function confirmDeadline(submission) {
  return new Date(new Date(submission.created_at).getTime() + RESULT_CONFIRM_WINDOW_MINUTES * 60 * 1000);
}
function confirmExpired(submission) {
  return Date.now() >= confirmDeadline(submission).getTime();
}
function confirmMinutesLeft(submission) {
  const ms = confirmDeadline(submission).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 1000));
}

// How many PRIOR submissions on this fixture were rejected before this
// one — same "two honest mistakes, a third needs a referee" logic
// ladderCupResultEscalationReason/resultEscalationReason use elsewhere.
function priorRejectedCount(fixtureSubmissions, submission) {
  return fixtureSubmissions.filter(
    (s) => s.status === "rejected" && new Date(s.created_at) < new Date(submission.created_at)
  ).length;
}

// null = still the opponent's turn to confirm/dispute; "timeout" = the
// 30-minute window passed with no response; "dispute-cap" = this fixture's
// already had 2 rejected attempts before this one.
function resultEscalationReason(fixtureSubmissions, submission) {
  if (!submission) return null;
  if (priorRejectedCount(fixtureSubmissions, submission) >= DISPUTE_ESCALATION_THRESHOLD) return "dispute-cap";
  if (confirmExpired(submission)) return "timeout";
  return null;
}

// When a submission actually ENTERED the admin queue — needed to know
// when its 1-hour auto-approve window (the sweep job, 20260891) runs out.
// Dispute-cap escalations are queue-eligible from the moment they're
// created; timeout escalations only become queue-eligible once the
// 30-minute opponent window lapses. Mirrors the sweep's own SQL exactly.
function escalatedAt(fixtureSubmissions, submission) {
  if (priorRejectedCount(fixtureSubmissions, submission) >= DISPUTE_ESCALATION_THRESHOLD) {
    return new Date(submission.created_at);
  }
  return confirmDeadline(submission);
}
function autoApproveMinutesLeft(fixtureSubmissions, submission) {
  const deadline = new Date(escalatedAt(fixtureSubmissions, submission).getTime() + ADMIN_AUTO_APPROVE_WINDOW_MINUTES * 60 * 1000);
  const ms = deadline.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 1000));
}

// JoinLadderLeagueBanner — the missing "join flow" LeagueLadderDetail's own
// header comment used to call out. Only ever offered for the league this
// screen is currently showing, which is fine in practice: join_ladder_league()
// always seats the caller in the highest-tier active league (the bottom,
// entry-level one) regardless of which leagueId this screen was opened
// with, so the fee shown here (this league's tier) matches what actually
// gets charged whenever this screen happens to be tier 8 — the case the
// button is meant for. Kept simple rather than resolving "the" entry
// league separately, since tier 8 is the only league that exists today.
function JoinLadderLeagueBanner({ tier, maxTier, joining, joinError, onJoin, c }) {
  const fee = tier != null && maxTier != null ? ladderEntryFeeForTier(tier, maxTier) : null;
  return (
    <div className="rounded-xl border p-3 flex items-center justify-between gap-3" style={{ borderColor: c.border, background: c.surface }}>
      <div>
        <div className="text-xs font-bold" style={{ color: c.text, fontFamily: c.font }}>Not on the ladder yet</div>
        <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>
          {fee ? <>One-time <NetsAmount amount={fee} /> to join.</> : "Free to join."}
        </div>
        {joinError && <div className="font-mono text-[10px] mt-1" style={{ color: c.red }}>{joinError}</div>}
      </div>
      <button onClick={onJoin} disabled={joining}
        className="font-mono text-[10px] uppercase px-3 py-2 rounded shrink-0"
        style={{ background: c.accent, color: c.accentText }}>
        {joining ? "…" : "Join"}
      </button>
    </div>
  );
}

// JoinedPlayersList — shown whenever standings can't yet ("No fixtures
// yet") so a fresh joiner (possibly the league's only member so far) gets
// visible confirmation they're actually in, instead of an empty screen
// that looks like the join silently failed. `members` is a flat list of
// user_ids from ladder_memberships; `session` decides which row gets the
// "You" tag.
function JoinedPlayersList({ members, profilesById, session, c }) {
  if (!members || members.length === 0) return null;
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: c.border, background: c.surface }}>
      <div className="font-mono text-[10px] uppercase tracking-widest mb-2" style={{ color: c.textFaint }}>
        {members.length === 1
          ? "1 player joined — waiting for an opponent before fixtures generate"
          : `${members.length} players joined — matches are generating now, refresh in a moment`}
      </div>
      <div className="flex flex-col gap-1.5">
        {members.map((userId) => {
          const isMe = session?.user?.id === userId;
          return (
            <div key={userId} className="flex items-center justify-between font-mono text-xs" style={{ color: isMe ? c.accent : c.text }}>
              <span className="font-semibold">{profilesById[userId]?.efootball_username || "Unknown player"}</span>
              {isMe && <span className="font-mono text-[9px] uppercase" style={{ color: c.textFaint }}>You</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Timezone-aware scheduling (roadmap 2b/2c) — ladder fixtures pair user_ids
// directly (no team/club layer), so unlike the regular-league version of
// this in LeagueDetail.jsx, `theirLocation` here is just the opponent's
// own profile row (already fetched with timezone/country_code — see
// profilesById above). Renders nothing if there's not enough data to say
// anything useful.
function OpponentTimezoneInfo({ theirLocation, myTimezone, c }) {
  if (!theirLocation || (!theirLocation.timezone && !theirLocation.country_code)) return null;

  const flag = countryCodeToFlagEmoji(theirLocation.country_code);
  const name = countryName(theirLocation.country_code);
  const localTime = theirLocation.timezone ? formatLocalTimeNow(theirLocation.timezone) : null;
  const suggestion = myTimezone && theirLocation.timezone ? suggestPlayTime(myTimezone, theirLocation.timezone) : null;

  if (!flag && !name && !localTime && !suggestion) return null;

  return (
    <div className="flex flex-col gap-1">
      {(flag || localTime) && (
        <div className="flex items-center gap-1.5 font-mono text-xs" style={{ color: c.textFaint }}>
          {flag && <span>{flag}</span>}
          <span>{[name, localTime && `${localTime} their time`].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      {suggestion && (
        <div className="flex items-start gap-1.5 font-body text-xs" style={{ color: suggestion.hasOverlap ? c.accent : c.textFaint }}>
          <Globe size={12} className="mt-0.5 shrink-0" />
          {suggestion.hasOverlap
            ? <span>Suggested: {suggestion.myRangeLabel} your time ({suggestion.theirRangeLabel} their time)</span>
            : <span>No overlap in your usual playing hours (~{suggestion.gapHours}h gap) — you'll need to arrange a one-off time.</span>}
        </div>
      )}
    </div>
  );
}

// WIDGET_TABS — the four lazy-loaded widgets shown below the Standings
// table (Results, Bids, Fixtures, Comments). Module-level (not per-render)
// since it's static; the tab bar just maps over it and only the active
// one's content actually mounts (see activeWidget below).
const WIDGET_TABS = [
  { id: "results", label: "Results", Icon: ListChecks },
  { id: "bids", label: "Bids", Icon: Gavel },
  { id: "fixtures", label: "Fixtures", Icon: CalendarDays },
  { id: "comments", label: "Comments", Icon: MessageCircle },
];

export default function LeagueLadderDetail({ leagueId, session, isAdmin, onBack, showToast, onOpenLadderLeague, onOpenLadderPoolAdmin, myTimezone, c: appTheme }) {
  // activeWidget — which of Results/Bids/Fixtures/Comments is currently
  // shown below Standings. Only this one's content mounts (see the tab
  // section near the bottom of the return) — LiveBidTicker's own
  // polling/subscriptions and the comment thread's own fetch only kick in
  // once a player actually opens that tab, rather than all four widgets
  // loading on every visit to this screen. Defaults to Fixtures — the
  // most commonly-needed widget (this week's matchups) — rather than
  // nothing, so the screen isn't empty on first open.
  const [activeWidget, setActiveWidget] = useState("fixtures");
  const [cycle, setCycle] = useState(null); // { current_week, fixtures_locked, bidding_open }
  // displayWeek — the week whose fixtures this screen actually shows.
  // NOT the same thing as cycle.current_week: join_ladder_league() always
  // schedules a joiner into current_week + 1 (you can't retroactively add
  // someone to a round-robin that's already in progress), and
  // _ladder_sync_fixtures_internal generates that week's fixtures
  // immediately, well before the Sunday 23:59 UTC cutover ever bumps
  // current_week to match. Querying by cycle.current_week alone means a
  // just-joined player's own fixtures — which already exist — are
  // invisible until the following week's cutover, showing a false "no
  // fixtures yet" state the whole time. Falls back to current_week only
  // when there's no active membership to anchor on (e.g. viewing a league
  // you haven't joined).
  const [displayWeek, setDisplayWeek] = useState(0);
  const [fixtures, setFixtures] = useState(null);
  const [profilesById, setProfilesById] = useState({});
  const [loading, setLoading] = useState(true);
  const [scoreDrafts, setScoreDrafts] = useState({}); // fixtureId -> { home, away }
  const [submittingId, setSubmittingId] = useState(null);
  const [proofFiles, setProofFiles] = useState({}); // fixtureId -> File, mirrors scoreDrafts
  // fixtureId -> true once a submit attempt has failed (upload timeout, RPC
  // timeout, etc.) and the photo is still attached — lets the button read
  // "Retry upload" instead of "Submit" so it's obvious tapping again reuses
  // the same photo rather than requiring the player to re-attach it. Cleared
  // on success (submitResult) or if they swap in a different photo.
  const [uploadFailedId, setUploadFailedId] = useState({});
  // submissions — every ladder_fixture_result_submissions row (any status)
  // for this week's fixtures, newest first. Kept as a flat list (not keyed
  // by fixture) since resultEscalationReason/priorRejectedCount need to
  // see a fixture's whole history, not just its current pending row.
  const [submissions, setSubmissions] = useState([]);
  const [respondingId, setRespondingId] = useState(null); // submission id mid-confirm/dispute
  const [adminActingId, setAdminActingId] = useState(null); // submission id mid-admin-approve/reject
  // Admin-only post-play score correction (correct_ladder_fixture_result,
  // 20260892) — correctingId is the fixture whose score is currently being
  // edited inline (mirrors editResultForFixture's score correction for
  // league results, but scoped to a single fixture row rather than a
  // posted comment).
  const [correctingId, setCorrectingId] = useState(null);
  const [correctionDraft, setCorrectionDraft] = useState({ home: "", away: "" });
  const [correctingSubmitting, setCorrectingSubmitting] = useState(false);
  // correctionProofFile — the (optional) new/replacement proof photo an
  // admin attaches while correcting a fixture (20260908). Mirrors
  // proofFiles' shape/upload path but single-slot: only one correction
  // can be in progress at a time (same constraint correctingId already
  // enforces for the score fields), so no need to key this by fixture id.
  const [correctionProofFile, setCorrectionProofFile] = useState(null);
  // Admin-only cancel (cancel_ladder_fixture_result, 20260910) — sends an
  // already-played/forfeited fixture back to unplayed. cancelingId is the
  // fixture currently showing its inline "are you sure" row, same
  // click-to-arm pattern as the confirm/dispute buttons elsewhere in this
  // file — no separate modal system needed for a single yes/no.
  const [cancelingId, setCancelingId] = useState(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  // corrections — every ladder_fixture_corrections row for this week's
  // fixtures, newest first (matches the submissions query's shape/order
  // just above). Used only to find each fixture's most recently attached
  // correction photo, if any — see latestCorrectionProofFor below.
  const [corrections, setCorrections] = useState([]);
  const [tier, setTier] = useState(null);
  const [maxTier, setMaxTier] = useState(null);
  const [membership, setMembership] = useState(null); // latest ladder_memberships row for this user, or null
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);
  // Everyone currently seated in *this* league for the current week —
  // separate from `standings`, which is derived purely from fixtures
  // (computeStandings) and so stays empty until there are at least 2
  // players and fixtures actually generate. Without this, a lone joiner
  // (or anyone joining before a second player arrives) saw "No fixtures
  // yet" and nothing else — not even themselves — with no confirmation
  // the join actually went through. This is read straight from
  // ladder_memberships, so it shows up the moment join_ladder_league()
  // succeeds, fixtures or not.
  const [members, setMembers] = useState([]);
  // memberReminders — user_id -> wa_reminder_due_at (ISO string | null |
  // undefined) for the admin-only Members panel's WhatsApp "reminded"
  // highlight. Seeded from ladder_memberships on load, then updated
  // locally the instant an admin taps a member's WhatsApp icon (see
  // markLadderMemberWaReminder) so the highlight appears immediately
  // regardless of the PATCH's own timing.
  const [memberReminders, setMemberReminders] = useState({});
  // opponentQuery — "Find my opponent" quick filter over the Fixtures
  // list below (see filteredFixtures). Purely client-side over whatever
  // visibleFixtures already returned; no extra fetch of its own.
  const [opponentQuery, setOpponentQuery] = useState("");
  // biddingTargetLeagueId — the id of the league one tier up (tier - 1),
  // fetched only while bidding is actually open and this isn't already
  // the top league. This is who a non-promoted active member of THIS
  // league is eligible to bid for (see ladderBidEligiblePool's
  // "activeInLeagueBelow" half in leagueLadder.js), so the banner below
  // can send them straight there with a real leagueId instead of just
  // naming the tier.
  const [biddingTargetLeagueId, setBiddingTargetLeagueId] = useState(null);

  // Per-tier visual identity (colors, font) — see ladderTierThemes.js.
  // Falls back to the League 1 look while `tier` is still null (first
  // load), then swaps the instant the league row comes back, so every
  // element below (including the loading/empty-state screens) reads in
  // its tier's own colors and font rather than the app's normal theme
  // that used to be passed in as `c`.
  const c = useMemo(() => getLadderTierTheme(tier), [tier]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: leagueRow } = await supabase.from("ladder_leagues").select("tier").eq("id", leagueId).maybeSingle();
    setTier(leagueRow?.tier ?? null);

    // maxTier — the JS mirror of Phase A's pricing formulas is pure (no
    // Supabase calls of its own, see economy.js's header), so this screen
    // has to fetch "the current max active tier" itself and pass it in,
    // same query _ladder_current_max_tier_internal() runs server-side.
    const { data: maxTierRow } = await supabase.from("ladder_leagues")
      .select("tier").eq("status", "active").order("tier", { ascending: false }).limit(1).maybeSingle();
    setMaxTier(maxTierRow?.tier ?? null);

    let memberRow = null;
    if (session?.user?.id) {
      const { data } = await supabase.from("ladder_memberships")
        .select("week_number, status, league_id")
        .eq("user_id", session.user.id)
        .order("week_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      memberRow = data || null;
      setMembership(memberRow);
    }

    const { data: cycleRow } = await supabase.from("ladder_cycle").select("*").eq("id", true).maybeSingle();
    const currentWeek = cycleRow?.current_week ?? 0;

    // Anchor on the viewer's own active membership for THIS league when
    // they have one — that's the week join_ladder_league() actually
    // scheduled them into, and the week _ladder_sync_fixtures_internal
    // already generated fixtures for. Otherwise fall back to
    // cycle.current_week (a non-member browsing the league, or no
    // membership row at all yet).
    const week = (memberRow && memberRow.status === "active" && memberRow.league_id === leagueId && memberRow.week_number >= currentWeek)
      ? memberRow.week_number
      : currentWeek;
    setDisplayWeek(week);

    // Active members of THIS league for the current week — see `members`
    // state comment above for why this is fetched independently of
    // fixtures. Runs regardless of whether a cycle/current_week exists yet,
    // so a lone early joiner shows up even before week 1 has started.
    // wa_reminder_due_at is only selected when isAdmin — it powers the
    // Members panel's WhatsApp "reminded" highlight (see
    // LADDER-MEMBERS-MIGRATION.md), which non-admins never see anyway.
    const { data: memberRows } = await supabase.from("ladder_memberships")
      .select(isAdmin ? "user_id, wa_reminder_due_at" : "user_id")
      .eq("league_id", leagueId).eq("status", "active").gte("week_number", currentWeek);
    const memberUserIds = [...new Set((memberRows || []).map((m) => m.user_id))];
    setMembers(memberUserIds);
    if (isAdmin) {
      const meta = {};
      (memberRows || []).forEach((m) => { meta[m.user_id] = m.wa_reminder_due_at; });
      setMemberReminders(meta);
    }
    if (memberUserIds.length > 0) {
      const { data: memberProfileRows } = await supabase.from("profiles")
        .select("user_id, efootball_username, avatar_url, phone, timezone, country_code").in("user_id", memberUserIds);
      const memberMap = {};
      (memberProfileRows || []).forEach((p) => { memberMap[p.user_id] = p; });
      setProfilesById((prev) => ({ ...prev, ...memberMap }));
    }

    if (!week) {
      setCycle(cycleRow || null);
      setFixtures([]);
      setLoading(false);
      return;
    }
    setCycle(cycleRow);

    const { data: fixtureRows, error } = await supabase.from("ladder_fixtures")
      .select("*")
      .eq("league_id", leagueId)
      .eq("week_number", week);
    if (error) { setFixtures([]); setLoading(false); return; }
    setFixtures(fixtureRows || []);

    // Every submission attempt for this week's fixtures — drives the
    // report/confirm-dispute/admin-queue states below. Fetched regardless
    // of isAdmin: a non-admin participant still needs to see their own
    // pending submission (to render "waiting on opponent") and its
    // history (to know if it's already hit the dispute cap).
    const fixtureIds = (fixtureRows || []).map((f) => f.id);
    if (fixtureIds.length > 0) {
      const { data: submissionRows } = await supabase.from("ladder_fixture_result_submissions")
        .select("*")
        .in("fixture_id", fixtureIds)
        .order("created_at", { ascending: false });
      setSubmissions(submissionRows || []);

      // Corrections, same shape/order as the submissions query above —
      // only field we actually need per-fixture is proof_url, but fetching
      // the full row costs nothing extra and keeps this consistent with
      // every other "history for these fixtures" query on this screen.
      const { data: correctionRows } = await supabase.from("ladder_fixture_corrections")
        .select("*")
        .in("fixture_id", fixtureIds)
        .order("created_at", { ascending: false });
      setCorrections(correctionRows || []);
    } else {
      setSubmissions([]);
      setCorrections([]);
    }

    const userIds = [...new Set((fixtureRows || []).flatMap((f) => [f.home_user_id, f.away_user_id]))];

    // Wall of Fame for League 1 now lives on the homepage only (merged
    // into the platform-wide trophy/badge ranking — see App.jsx's
    // ladder_champion achievement + loadLadderChampions), not here.

    const allUserIds = [...new Set(userIds)];
    if (allUserIds.length > 0) {
      const { data: profileRows } = await supabase.from("profiles")
        .select("user_id, efootball_username, avatar_url, phone, timezone, country_code")
        .in("user_id", allUserIds);
      const map = {};
      (profileRows || []).forEach((p) => { map[p.user_id] = p; });
      setProfilesById(map);
    }
    setLoading(false);
  }, [leagueId, session?.user?.id]);

  useEffect(() => { load(); }, [load]);

  const nameFor = (userId) => profilesById[userId]?.efootball_username || "Unknown player";

  const standings = useMemo(() => computeStandings(fixtures || []), [fixtures]);
  const zones = useMemo(() => classifyLadderZones(standings), [standings]);
  // myRankPosition — the viewer's own row in this league's live table
  // (1-based), or null if they're not on it. Rank 1 in a non-top tier is
  // the one guaranteed automatic promotion (resolveLadderWeek); everyone
  // else who's active is instead an eligible BIDDER for the league above
  // once bidding opens (see biddingTargetLeagueId below) — two different
  // routes into the same "next league up", surfaced separately since
  // only one of them needs the live bid ticker.
  const myRankPosition = useMemo(() => {
    const idx = standings.findIndex((r) => r.user_id === session?.user?.id);
    return idx >= 0 ? idx + 1 : null;
  }, [standings, session?.user?.id]);
  // myZone — the viewer's own Phase 7 badge on this week's live table (see
  // classifyLadderZones' header), or null. Used below to keep the
  // promotion-bid banner from being offered to someone it can't actually
  // help: a danger_zone player isn't fighting for a promoted spot right
  // now, they're fighting to not be one of the bottom 2 at all, so a
  // "bid for League {tier-1}" banner aimed at them would just be noise
  // (and, being a real player, they're not excluded from bidding
  // server-side either — this is purely about not misleading the UI into
  // suggesting a wrong strategy).
  const myZone = session?.user?.id ? zones[session.user.id] ?? null : null;

  // rank1MsgIndex — which RANK1_SAFE_MESSAGES entry to show rank 1 in a
  // non-top tier, in place of this league's own LiveBidTicker (see the
  // render below). Picked once per mount, same non-live pattern as
  // LiveBidTicker's initial msgIndex — there's no "leader changed" event
  // to react to here, rank 1's promotion is already locked in.
  const [rank1MsgIndex] = useState(() => Math.floor(Math.random() * RANK1_SAFE_MESSAGES.length));
  // kitRoomMsgIndex — same idea, for KIT_ROOM_MESSAGES (League 1's
  // non-danger-zone members).
  const [kitRoomMsgIndex] = useState(() => Math.floor(Math.random() * KIT_ROOM_MESSAGES.length));

  useEffect(() => {
    if (!cycle?.bidding_open || tier == null || tier <= 1) { setBiddingTargetLeagueId(null); return; }
    let cancelled = false;
    supabase.from("ladder_leagues").select("id").eq("tier", tier - 1).eq("status", "active").maybeSingle()
      .then(({ data }) => { if (!cancelled) setBiddingTargetLeagueId(data?.id ?? null); });
    return () => { cancelled = true; };
  }, [cycle?.bidding_open, tier]);

  // Report-only now — no longer finalizes the fixture (see
  // 20260888_ladder_fixture_result_submit_rpc.sql). Just inserts a pending
  // ladder_fixture_result_submissions row; the fixture stays 'pending'
  // until the opponent confirms, an admin approves, or the 1-hour
  // auto-approve sweep fires.
  //
  // Photo proof — copied from Survivor Ladder Cup's submitLadderCupMatchResult
  // (App.jsx): mandatory scoreboard screenshot, downscaled with
  // compressImage the same way (1600px / 0.85), then uploaded to the same
  // shared "result-proofs" Blob bucket before the RPC call. The RPC
  // (submit_ladder_fixture_result, 20260888) already had a p_proof_url
  // param sitting unused — this is the client finally passing it through.
  const submitResult = async (fixtureId) => {
    const draft = scoreDrafts[fixtureId];
    // An untouched side is treated as 0 rather than forcing the player to
    // type it explicitly — a 3-0 result only needs the "3" entered, and a
    // 0-0 result doesn't need either box touched at all. Still bail out
    // entirely if BOTH sides were left blank (draft never opened, or
    // cleared back out) — that's "nothing entered", not "0-0 entered".
    if (!draft || (draft.home === "" && draft.away === "")) return;
    const homeScore = draft.home === "" ? 0 : Number(draft.home);
    const awayScore = draft.away === "" ? 0 : Number(draft.away);
    const file = proofFiles[fixtureId];
    if (!file) { showToast("Attach a photo of the final scoreboard before submitting."); return; }

    setSubmittingId(fixtureId);

    let proofUrl;
    try {
      const compressed = await compressImage(file, { maxDimension: 1600, quality: 0.85 });
      const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/${fixtureId}-${Date.now()}.${ext}`;
      proofUrl = await uploadToR2("result-proofs", path, compressed);
    } catch (uploadErr) {
      setSubmittingId(null);
      setUploadFailedId((m) => ({ ...m, [fixtureId]: true }));
      showToast(`Couldn't upload photo: ${uploadErr.message}`);
      return;
    }

    const { error } = await withTimeout(
      supabase.rpc("submit_ladder_fixture_result", {
        p_fixture_id: fixtureId,
        p_home_score: homeScore,
        p_away_score: awayScore,
        p_proof_url: proofUrl,
      }),
      15000,
      "Submitting the result timed out — check your connection and try again."
    ).catch((timeoutErr) => ({ error: timeoutErr }));
    setSubmittingId(null);
    if (error) {
      setUploadFailedId((m) => ({ ...m, [fixtureId]: true }));
      showToast(error.message);
      return;
    }
    setScoreDrafts((d) => ({ ...d, [fixtureId]: undefined }));
    setProofFiles((f) => ({ ...f, [fixtureId]: undefined }));
    setUploadFailedId((m) => ({ ...m, [fixtureId]: undefined }));
    await load();
  };

  // Blob URLs are permanent, public CDN URLs (see uploadToBlob's header) —
  // no signed-URL step needed, unlike the legacy Supabase-storage-path rows
  // downloadResultProof (App.jsx) still has to handle for the older,
  // pre-Blob result-proofs rows elsewhere in the app. Every ladder proof is
  // written post-migration, so this is always the simple case.
  const viewProof = (url) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // Opponent confirm/dispute — respond_to_ladder_fixture_result_submission
  // rejects the caller server-side if they're not the other participant,
  // so this doesn't need to duplicate that check to be safe, only to be
  // helpful with the button's visibility.
  const respondToSubmission = async (submissionId, accept) => {
    setRespondingId(submissionId);
    const { error } = await supabase.rpc("respond_to_ladder_fixture_result_submission", {
      p_submission_id: submissionId,
      p_accept: accept,
    });
    setRespondingId(null);
    if (error) { showToast(error.message); return; }
    await load();
  };

  const adminApprove = async (submissionId) => {
    setAdminActingId(submissionId);
    const { error } = await supabase.rpc("admin_approve_ladder_fixture_result", { p_submission_id: submissionId });
    setAdminActingId(null);
    if (error) { showToast(error.message); return; }
    await load();
  };

  const adminReject = async (submissionId) => {
    setAdminActingId(submissionId);
    const { error } = await supabase.rpc("admin_reject_ladder_fixture_result", { p_submission_id: submissionId });
    setAdminActingId(null);
    if (error) { showToast(error.message); return; }
    await load();
  };

  // Admin-only correction of an already-played OR forfeited fixture's
  // score (correct_ladder_fixture_result, 20260892/20260904). Only
  // callable server-side once the fixture is 'played' or 'forfeited' — the
  // RPC itself rejects anything else, so this doesn't need to duplicate
  // that check to be safe, only to know when to show the pencil icon. A
  // forfeited fixture keeps status='forfeited' after correction (still
  // excluded from Match Reward/streak crediting per economy.js — a
  // corrected walkover score still isn't a played match for reward
  // purposes), only its stored score changes.
  const startCorrection = (f) => {
    setCorrectingId(f.id);
    setCorrectionDraft({ home: String(f.home_score ?? ""), away: String(f.away_score ?? "") });
    setCorrectionProofFile(null);
  };
  const cancelCorrection = () => {
    setCorrectingId(null);
    setCorrectionDraft({ home: "", away: "" });
    setCorrectionProofFile(null);
  };
  const submitCorrection = async (fixtureId) => {
    // Same "blank side = 0" treatment as the player-facing submitResult
    // above — an admin correcting a 4-0 shouldn't have to type the 0.
    // Still block on BOTH sides blank (nothing entered at all) and on any
    // genuinely invalid (non-integer / negative) value typed into either.
    if (correctionDraft.home === "" && correctionDraft.away === "") {
      showToast("Enter a valid score for both players.");
      return;
    }
    const homeScore = correctionDraft.home === "" ? 0 : Number(correctionDraft.home);
    const awayScore = correctionDraft.away === "" ? 0 : Number(correctionDraft.away);
    if (
      !Number.isInteger(homeScore) || !Number.isInteger(awayScore) ||
      homeScore < 0 || awayScore < 0
    ) {
      showToast("Enter a valid score for both players.");
      return;
    }
    setCorrectingSubmitting(true);

    // Proof photo is optional here (unlike the player-facing submitResult
    // above, which requires one) — an admin correcting a score with no
    // new photo just shouldn't touch whatever proof is already on file,
    // and p_proof_url defaulting to null on the RPC handles exactly that:
    // no new correction-level photo is recorded, so proofUrlFor keeps
    // resolving to whatever it already did before this correction.
    let proofUrl = null;
    if (correctionProofFile) {
      try {
        const compressed = await compressImage(correctionProofFile, { maxDimension: 1600, quality: 0.85 });
        const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${session.user.id}/${fixtureId}-correction-${Date.now()}.${ext}`;
        proofUrl = await uploadToR2("result-proofs", path, compressed);
      } catch (uploadErr) {
        setCorrectingSubmitting(false);
        showToast(`Couldn't upload photo: ${uploadErr.message}`);
        return;
      }
    }

    const { error } = await supabase.rpc("correct_ladder_fixture_result", {
      p_fixture_id: fixtureId,
      p_home_score: homeScore,
      p_away_score: awayScore,
      p_proof_url: proofUrl,
    });
    setCorrectingSubmitting(false);
    if (error) { showToast(error.message); return; }
    cancelCorrection();
    await load();
  };

  // Sends an already-played/forfeited fixture back to unplayed
  // (cancel_ladder_fixture_result, 20260910) — for a result that
  // shouldn't exist at all (wrong opponent, mistaken entry), as opposed
  // to submitCorrection above which fixes the score but keeps it played.
  // See that migration's header for the one thing this deliberately does
  // NOT undo: Match Reward Nets already credited to both players.
  const cancelResult = async (fixtureId) => {
    setCancelSubmitting(true);
    const { error } = await supabase.rpc("cancel_ladder_fixture_result", { p_fixture_id: fixtureId });
    setCancelSubmitting(false);
    if (error) { showToast(error.message); return; }
    setCancelingId(null);
    showToast("Result cancelled — the fixture is unplayed again.");
    await load();
  };

  // Same threshold join_ladder_league() itself checks server-side
  // (week_number >= current_week) — mirrored here just to decide whether
  // to show the Join banner, not as a substitute for that check.
  const currentWeekForMembership = cycle?.current_week ?? 0;
  const isMember = !!membership && membership.status === "active" && membership.week_number >= currentWeekForMembership;

  const joinLadderLeague = async () => {
    setJoining(true);
    setJoinError(null);
    const { error } = await supabase.rpc("join_ladder_league");
    setJoining(false);
    if (error) {
      const fee = tier != null && maxTier != null ? ladderEntryFeeForTier(tier, maxTier) : null;
      setJoinError(/insufficient/i.test(error.message || "")
        ? <>You need {fee ? <NetsAmount amount={fee} /> : "more Nets"} to join.</>
        : (error.message || "Couldn't join the ladder."));
      return;
    }
    await load();
  };

  if (loading) {
    return <div className="p-6 text-center font-mono text-xs" style={{ color: c.textFaint, background: c.bg, fontFamily: c.font }}>Loading…</div>;
  }

  if (!displayWeek) {
    return (
      <div className="p-4" style={{ background: c.bg, fontFamily: c.font, minHeight: "100%" }}>
        <button onClick={onBack} className="flex items-center gap-1 font-mono text-xs mb-4" style={{ color: c.textFaint }}>
          <ArrowLeft size={14} /> Back
        </button>
        {!isMember && (
          <div className="mb-4">
            <JoinLadderLeagueBanner tier={tier} maxTier={maxTier} joining={joining} joinError={joinError} onJoin={joinLadderLeague} c={c} />
          </div>
        )}
        <div className="mb-4">
          <JoinedPlayersList members={members} profilesById={profilesById} session={session} c={c} />
        </div>
        <div className="text-center font-mono text-xs" style={{ color: c.textFaint }}>
          No fixtures yet — there's no fixed start date. Once this league has at least 2 players, matches generate right away and run through the Sunday 23:59 UTC cutoff.
        </div>
      </div>
    );
  }

  const isParticipant = (f) => session?.user?.id === f.home_user_id || session?.user?.id === f.away_user_id;

  // Ladder fixtures pair players directly (no team/club layer), so the
  // "opponent" for a pending fixture is just whichever of home/away user
  // isn't the signed-in player. Mirrors NextOpponentCard's WhatsAppCallLink
  // usage in normal leagues — same intent (line up the match), same
  // message shape, just addressed by username instead of club name since
  // ladder has no club concept.
  const opponentFor = (f) => {
    const opponentId = session?.user?.id === f.home_user_id ? f.away_user_id : f.home_user_id;
    return profilesById[opponentId];
  };

  // Regular players only see their own fixture(s) for the week, not the
  // whole tier's matchups — admins still see everything, since they need
  // the full list to moderate/oversee forfeits etc.
  const visibleFixtures = isAdmin ? (fixtures || []) : (fixtures || []).filter(isParticipant);

  // filteredFixtures — "Find my opponent" (below) filters visibleFixtures
  // by whichever side's username matches, client-side, same "type to
  // narrow the list" pattern LadderCupFindOpponent/Ladder.jsx's own
  // search already use elsewhere. Not a separate fetch — visibleFixtures
  // is already everyone (admin) or just the viewer's own matches (a
  // regular member's 5 opponents across the double round robin), so this
  // is just a narrowing view over what's already loaded.
  const oq = opponentQuery.trim().toLowerCase();
  const searchedFixtures = oq
    ? visibleFixtures.filter((f) => nameFor(f.home_user_id).toLowerCase().includes(oq) || nameFor(f.away_user_id).toLowerCase().includes(oq))
    : visibleFixtures;

  // Fixtures still needing action (pending) surface first so there's
  // nothing to scroll past to find what needs submitting; completed ones
  // (played or forfeited) sink to the bottom as a settled record. Plain
  // status-based partition, stable within each group — Array.prototype.sort
  // is spec-guaranteed stable, so this never reshuffles fixtures that were
  // already in the same bucket relative to each other.
  const isFixtureDone = (f) => f.status === "played" || f.status === "forfeited";
  const filteredFixtures = searchedFixtures
    .slice()
    .sort((a, b) => (isFixtureDone(a) === isFixtureDone(b) ? 0 : isFixtureDone(a) ? 1 : -1));

  // This fixture's full submission history (any status), and whichever
  // one (if any) is still awaiting a decision — a fixture can only ever
  // have one 'pending' submission at a time (submit_ladder_fixture_result
  // enforces that server-side), but keeping the full history around is
  // what priorRejectedCount/resultEscalationReason need to compute the
  // dispute-cap.
  const submissionsFor = (f) => submissions.filter((s) => s.fixture_id === f.id);
  const pendingSubmissionFor = (f) => submissionsFor(f).find((s) => s.status === "pending") || null;
  // ladder_fixtures itself carries no proof_url (see 20260887's header —
  // deliberately no new columns there); the approved submission row is
  // where a played fixture's proof photo actually lives.
  const approvedSubmissionFor = (f) => submissionsFor(f).find((s) => s.status === "approved") || null;
  // correctionsFor / latestCorrectionProofFor — a fixture's correction
  // history and, from it, the most recently attached proof photo (if an
  // admin has ever attached/replaced one via a correction, 20260908).
  // Falls back to the original approved submission's photo when no
  // correction ever attached its own — see proofUrlFor below, used
  // wherever the fixture list renders the "view proof" icon.
  const correctionsFor = (f) => corrections.filter((c) => c.fixture_id === f.id);
  const latestCorrectionProofFor = (f) => correctionsFor(f).find((c) => c.proof_url)?.proof_url || null;
  const proofUrlFor = (f) => latestCorrectionProofFor(f) || approvedSubmissionFor(f)?.proof_url || null;
  // Self-service cancel window — the player who submitted this fixture's
  // approved result can cancel/reverse it themselves within 30 minutes of
  // submitting, same as the admin-only cancel button but time-boxed and
  // scoped to their own result. Mirrors the RPC's own check
  // (cancel_ladder_fixture_result, 20260912) — this only decides when to
  // show the button; the RPC is the real gate. A forfeited fixture has no
  // submissions row (see that migration's header), so this never matches
  // one — only an admin can undo a forfeit.
  const SELF_CANCEL_WINDOW_MS = 30 * 60 * 1000;
  const canSelfCancel = (f) => {
    const sub = approvedSubmissionFor(f);
    return !!sub && sub.submitted_by === session?.user?.id &&
      (Date.now() - new Date(sub.created_at).getTime()) < SELF_CANCEL_WINDOW_MS;
  };

  // resultsFixtures / upcomingFixtures — the Fixtures list split by
  // status so Results and Fixtures can be separate lazy-loaded tabs
  // instead of one long combined list. Both reuse renderFixtureRow
  // below so the submit/confirm/dispute/correct/cancel workflow only
  // has to live in one place.
  const resultsFixtures = visibleFixtures.filter(isFixtureDone);
  const upcomingFixtures = filteredFixtures.filter((f) => !isFixtureDone(f));

  // renderFixtureRow — one fixture's row, exactly as before this tab
  // split, just pulled out to a function so both the Results tab
  // (played/forfeited fixtures) and the Fixtures tab (pending ones)
  // can call it via .map(renderFixtureRow) without duplicating the
  // ~300 lines of submit/confirm/dispute/correct/cancel logic inside.
  const renderFixtureRow = (f) => (
            <div key={f.id} className="rounded-lg border p-3 flex flex-col gap-1.5" style={{ borderColor: c.border }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono text-xs" style={{ color: c.text }}>
                {nameFor(f.home_user_id)} <span style={{ color: c.textFaint }}>vs</span> {nameFor(f.away_user_id)}
              </div>

              {(f.status === "played" || f.status === "forfeited") && (correctingId === f.id ? (
                <div className="flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto">
                  <input type="number" min="0" placeholder="0" className="w-12 text-center rounded font-mono text-xs p-1"
                    style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
                    value={correctionDraft.home}
                    onChange={(e) => setCorrectionDraft((d) => ({ ...d, home: e.target.value }))} />
                  <span style={{ color: c.textFaint }}>-</span>
                  <input type="number" min="0" placeholder="0" className="w-12 text-center rounded font-mono text-xs p-1"
                    style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
                    value={correctionDraft.away}
                    onChange={(e) => setCorrectionDraft((d) => ({ ...d, away: e.target.value }))} />
                  {/* Optional proof photo attach/replace (20260908) — same
                      camera-icon-behind-hidden-input pattern as the
                      player-facing submitResult photo control above, but
                      not required: an admin correcting just the score with
                      no new photo should be able to hit Save without
                      attaching anything. */}
                  <label title={correctionProofFile ? correctionProofFile.name : (proofUrlFor(f) ? "Replace proof photo" : "Attach proof photo")}
                    className="cursor-pointer flex items-center justify-center rounded p-1"
                    style={{ background: c.surface, color: correctionProofFile ? c.accent : c.textFaint, border: `1px solid ${c.border}` }}>
                    {correctionProofFile ? <Check size={12} /> : <Camera size={12} />}
                    <input type="file" accept="image/*" className="hidden"
                      onChange={(e) => setCorrectionProofFile(e.target.files?.[0] || null)} />
                  </label>
                  <button onClick={() => submitCorrection(f.id)} disabled={correctingSubmitting}
                    className="font-mono text-[10px] uppercase px-2 py-1 rounded"
                    style={{ background: c.accent, color: c.accentText }}>
                    {correctingSubmitting ? "…" : "Save"}
                  </button>
                  <button onClick={cancelCorrection} disabled={correctingSubmitting}
                    className="font-mono text-[10px] uppercase px-2 py-1 rounded"
                    style={{ background: "transparent", color: c.textFaint, border: `1px solid ${c.border}` }}>
                    Cancel
                  </button>
                </div>
              ) : cancelingId === f.id ? (
                <div className="flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto">
                  <span className="font-mono text-[10px]" style={{ color: c.red }}>Send back to unplayed?</span>
                  <button onClick={() => cancelResult(f.id)} disabled={cancelSubmitting}
                    className="font-mono text-[10px] uppercase px-2 py-1 rounded"
                    style={{ background: c.red, color: "#fff" }}>
                    {cancelSubmitting ? "…" : "Confirm"}
                  </button>
                  <button onClick={() => setCancelingId(null)} disabled={cancelSubmitting}
                    className="font-mono text-[10px] uppercase px-2 py-1 rounded"
                    style={{ background: "transparent", color: c.textFaint, border: `1px solid ${c.border}` }}>
                    Never mind
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="font-mono text-sm font-bold" style={{ color: c.text }}>{f.home_score} - {f.away_score}</div>
                  {f.status === "forfeited" && (
                    <span className="font-mono text-[9px] uppercase" style={{ color: c.red }}>{forfeitedLabelForWeek()}</span>
                  )}
                  {proofUrlFor(f) && (
                    <button onClick={() => viewProof(proofUrlFor(f))} title="View proof photo"
                      className="opacity-60 hover:opacity-100" style={{ color: c.textFaint }}>
                      <ImageIcon size={12} />
                    </button>
                  )}
                  {isAdmin && (
                    <button onClick={() => startCorrection(f)} title="Correct this result"
                      className="opacity-60 hover:opacity-100" style={{ color: c.textFaint }}>
                      <Pencil size={12} />
                    </button>
                  )}
                  {/* Admin: always. Non-admin: only the player who
                      submitted this result, within 30 minutes of
                      submitting (canSelfCancel). Fully cancels this
                      result, sending the fixture back to unplayed
                      (cancel_ladder_fixture_result, 20260910/20260912)
                      rather than just correcting its score. See that
                      migration's header for the Match Reward Nets
                      caveat. */}
                  {(isAdmin || canSelfCancel(f)) && (
                    <button onClick={() => setCancelingId(f.id)} title={isAdmin ? "Cancel this result — send back to unplayed" : "Cancel your result — you can undo this within 30 minutes of submitting"}
                      className="opacity-60 hover:opacity-100" style={{ color: c.textFaint }}>
                      <RotateCcw size={12} />
                    </button>
                  )}
                  {/* Admin-only, both sides — lets an admin reach either
                      player straight from a finished result (disputes,
                      forfeit follow-ups, etc.) the same way they can for
                      an in-progress fixture above. Not shown to players:
                      participants already know their opponent from playing
                      the match. */}
                  {isAdmin && (
                    <>
                      {profilesById[f.home_user_id]?.phone && (
                        <WhatsAppLink phone={profilesById[f.home_user_id].phone} iconOnly
                          title={`Message ${nameFor(f.home_user_id)} on WhatsApp`}
                          text={`Hi ${nameFor(f.home_user_id)}, this is the league admin — following up on your ${f.home_score}-${f.away_score} result vs ${nameFor(f.away_user_id)} ⚽`} c={c} />
                      )}
                      {profilesById[f.away_user_id]?.phone && (
                        <WhatsAppLink phone={profilesById[f.away_user_id].phone} iconOnly
                          title={`Message ${nameFor(f.away_user_id)} on WhatsApp`}
                          text={`Hi ${nameFor(f.away_user_id)}, this is the league admin — following up on your ${f.home_score}-${f.away_score} result vs ${nameFor(f.home_user_id)} ⚽`} c={c} />
                      )}
                    </>
                  )}
                  <FacebookHighlightsIcon c={c} size={12} iconOnly />
                </div>
              ))}
              {f.status === "pending" && (() => {
                const pending = pendingSubmissionFor(f);
                const escalation = pending ? resultEscalationReason(submissionsFor(f), pending) : null;
                const iSubmitted = pending && session?.user?.id === pending.submitted_by;

                // Sub-state 1: nobody's reported a score yet — the
                // original report form, unchanged from before this
                // migration.
                if (!pending && (isAdmin || isParticipant(f))) {
                  const countdownText = formatCountdown(f.countdown_expires_at);
                  return (
                    <div className="flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto">
                      {f.countdown_expires_at && (
                        <CountdownBadge expiresAt={f.countdown_expires_at} />
                      )}
                      {isParticipant(f) && opponentFor(f)?.phone && (
                        <WhatsAppCallLink phone={opponentFor(f).phone} iconOnly
                          text={buildOpponentChaseMessage(nameFor(session.user.id), countdownText, opponentFor(f), myTimezone)}
                          onClick={(e) => {
                            // Recompute at click time (not just at render
                            // time) and open the link ourselves — this is
                            // what actually guarantees a fresh random
                            // message on every send, rather than just
                            // whatever happened to be picked at the last
                            // render (typing in the score inputs, etc.).
                            e.preventDefault();
                            const freshText = buildOpponentChaseMessage(nameFor(session.user.id), formatCountdown(f.countdown_expires_at), opponentFor(f), myTimezone);
                            const href = waLink(opponentFor(f).phone, freshText);
                            if (href) window.open(href, "_blank", "noopener,noreferrer");
                          }} c={c} />
                      )}
                      {/* Admins watch over fixtures they aren't playing in
                          themselves, so opponentFor(f) (which is relative to
                          the signed-in player) doesn't apply — show one icon
                          per side instead, so an admin can reach either player
                          directly (e.g. to chase a no-show or settle a
                          dispute). Participants already get their single
                          "call my opponent" icon above, so this only kicks in
                          for the pure-admin, non-participant case. */}
                      {isAdmin && !isParticipant(f) && (
                        <>
                          {profilesById[f.home_user_id]?.phone && (
                            <WhatsAppCallLink phone={profilesById[f.home_user_id].phone} iconOnly
                              text={`Hi ${nameFor(f.home_user_id)}, this is the league admin — following up on your ladder fixture this week ⚽`} c={c} />
                          )}
                          {profilesById[f.away_user_id]?.phone && (
                            <WhatsAppCallLink phone={profilesById[f.away_user_id].phone} iconOnly
                              text={`Hi ${nameFor(f.away_user_id)}, this is the league admin — following up on your ladder fixture this week ⚽`} c={c} />
                          )}
                        </>
                      )}
                      <input type="number" min="0" placeholder="0" className="w-12 text-center rounded font-mono text-xs p-1"
                        style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
                        value={scoreDrafts[f.id]?.home ?? ""}
                        onChange={(e) => setScoreDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], home: e.target.value } }))} />
                      <span style={{ color: c.textFaint }}>-</span>
                      <input type="number" min="0" placeholder="0" className="w-12 text-center rounded font-mono text-xs p-1"
                        style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
                        value={scoreDrafts[f.id]?.away ?? ""}
                        onChange={(e) => setScoreDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], away: e.target.value } }))} />
                      {/* Mandatory scoreboard photo — same requirement and
                          upload path as Survivor Ladder Cup's result form.
                          Hidden native input behind a small camera-icon
                          label so this fits the same compact row as the
                          score boxes; label text flips to a checkmark once
                          a file's attached so there's a visible confirmation
                          before hitting Submit. */}
                      <label title={proofFiles[f.id] ? proofFiles[f.id].name : "Attach scoreboard photo"}
                        className="cursor-pointer flex items-center justify-center rounded p-1"
                        style={{ background: c.surface, color: proofFiles[f.id] ? c.accent : c.textFaint, border: `1px solid ${c.border}` }}>
                        {proofFiles[f.id] ? <Check size={12} /> : <Camera size={12} />}
                        <input type="file" accept="image/*" className="hidden"
                          onChange={(e) => {
                            setProofFiles((p) => ({ ...p, [f.id]: e.target.files?.[0] || undefined }));
                            setUploadFailedId((m) => ({ ...m, [f.id]: undefined }));
                          }} />
                      </label>
                      <button onClick={() => submitResult(f.id)}
                        disabled={submittingId === f.id || !proofFiles[f.id]}
                        title={!proofFiles[f.id] ? "Attach a scoreboard photo before submitting" : uploadFailedId[f.id] ? "Tap to try again with the same photo" : undefined}
                        className="font-mono text-[10px] uppercase px-2 py-1 rounded disabled:cursor-not-allowed"
                        style={{
                          background: proofFiles[f.id] ? c.accent : c.border,
                          color: proofFiles[f.id] ? c.accentText : c.textFaint,
                          opacity: proofFiles[f.id] ? 1 : 0.6,
                        }}>
                        {submittingId === f.id ? "…" : uploadFailedId[f.id] ? "Retry" : "Submit"}
                      </button>
                      <FacebookHighlightsIcon c={c} size={12} iconOnly />
                    </div>
                  );
                }

                // Sub-state 2: a result's been reported and is sitting
                // pending, and it hasn't escalated yet — either the
                // submitter's own "waiting on opponent" view, or the
                // opponent's confirm/dispute buttons. Admins don't get
                // action buttons here — a not-yet-escalated result is
                // still the players' to sort out between themselves.
                if (pending && !escalation) {
                  if (iSubmitted) {
                    const opponentUserId = session.user.id === f.home_user_id ? f.away_user_id : f.home_user_id;
                    return (
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                          You reported {pending.home_score}-{pending.away_score} — {confirmMinutesLeft(pending)}m for {nameFor(opponentUserId)} to confirm
                        </span>
                      </div>
                    );
                  }
                  if (isParticipant(f)) {
                    return (
                      <div className="flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto">
                        <span className="font-mono text-xs font-bold" style={{ color: c.text }}>
                          {pending.home_score} - {pending.away_score}
                        </span>
                        {pending.proof_url && (
                          <button onClick={() => viewProof(pending.proof_url)} title="View proof photo"
                            className="opacity-60 hover:opacity-100" style={{ color: c.textFaint }}>
                            <ImageIcon size={12} />
                          </button>
                        )}
                        <span className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                          reported — {confirmMinutesLeft(pending)}m left
                        </span>
                        <button onClick={() => respondToSubmission(pending.id, true)} disabled={respondingId === pending.id}
                          className="font-mono text-[10px] uppercase px-2 py-1 rounded flex items-center gap-1"
                          style={{ background: c.accent, color: c.accentText }}>
                          <Check size={10} /> Confirm
                        </button>
                        <button onClick={() => respondToSubmission(pending.id, false)} disabled={respondingId === pending.id}
                          className="font-mono text-[10px] uppercase px-2 py-1 rounded flex items-center gap-1"
                          style={{ background: "transparent", color: c.red, border: `1px solid ${c.red}` }}>
                          <X size={10} /> Dispute
                        </button>
                      </div>
                    );
                  }
                  if (isAdmin) {
                    return (
                      <span className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                        {pending.home_score}-{pending.away_score} reported, awaiting opponent ({confirmMinutesLeft(pending)}m)
                      </span>
                    );
                  }
                }

                // Sub-state 3: escalated — the opponent either disputed
                // twice or let the 30-minute window lapse. Admins get
                // Approve/Reject here; everyone else just sees it's
                // awaiting the admin, plus how long until the 1-hour
                // auto-approve sweep would resolve it on its own.
                if (pending && escalation) {
                  const autoApproveMins = autoApproveMinutesLeft(submissionsFor(f), pending);
                  if (isAdmin) {
                    return (
                      <div className="flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto">
                        <ShieldAlert size={12} style={{ color: c.red }} />
                        <span className="font-mono text-xs font-bold" style={{ color: c.text }}>
                          {pending.home_score} - {pending.away_score}
                        </span>
                        {pending.proof_url && (
                          <button onClick={() => viewProof(pending.proof_url)} title="View proof photo"
                            className="opacity-60 hover:opacity-100" style={{ color: c.textFaint }}>
                            <ImageIcon size={12} />
                          </button>
                        )}
                        <span className="font-mono text-[10px] uppercase" style={{ color: c.red }}>
                          {escalation === "dispute-cap" ? "disputed twice" : "timed out"} · auto-approves in {autoApproveMins}m
                        </span>
                        <button onClick={() => adminApprove(pending.id)} disabled={adminActingId === pending.id}
                          className="font-mono text-[10px] uppercase px-2 py-1 rounded"
                          style={{ background: c.accent, color: c.accentText }}>
                          {adminActingId === pending.id ? "…" : "Approve"}
                        </button>
                        <button onClick={() => adminReject(pending.id)} disabled={adminActingId === pending.id}
                          className="font-mono text-[10px] uppercase px-2 py-1 rounded"
                          style={{ background: "transparent", color: c.red, border: `1px solid ${c.red}` }}>
                          Reject
                        </button>
                      </div>
                    );
                  }
                  return (
                    <span className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                      Awaiting admin review (auto-approves in {autoApproveMins}m)
                    </span>
                  );
                }

                // Nobody's reported anything and the viewer is neither a
                // participant nor an admin — same read-only countdown as
                // before.
                return (
                  <div className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                    {f.countdown_expires_at ? <CountdownBadge expiresAt={f.countdown_expires_at} /> : "Pending"}
                  </div>
                );
              })()}
              </div>
              {isParticipant(f) && opponentFor(f) && (
                <OpponentTimezoneInfo theirLocation={opponentFor(f)} myTimezone={myTimezone} c={c} />
              )}
            </div>
  );

  return (
    <div className="p-4 flex flex-col gap-6" style={{ background: c.bg, fontFamily: c.font, minHeight: "100%" }}>
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1 font-mono text-xs" style={{ color: c.textFaint }}>
          <ArrowLeft size={14} /> Back
        </button>
        {tier != null && (
          <span className="font-mono text-[9px] uppercase tracking-widest px-2 py-1 rounded-full"
            style={{ color: c.accentText, background: c.accent }}>
            League {tier} · {c.name}
          </span>
        )}
      </div>

      {!isMember && (
        <JoinLadderLeagueBanner tier={tier} maxTier={maxTier} joining={joining} joinError={joinError} onJoin={joinLadderLeague} c={c} />
      )}

      {standings.length === 0 && (
        <JoinedPlayersList members={members} profilesById={profilesById} session={session} c={c} />
      )}

      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: c.textFaint }}>
          Week {displayWeek} {displayWeek > (cycle?.current_week ?? 0)
            ? "· scheduled"
            : cycle?.fixtures_locked ? "· locked" : "· in progress"}
        </div>
        <div className="flex items-center gap-2 mb-3">
          <Trophy size={16} style={{ color: c.accent }} />
          <span className="text-sm font-bold" style={{ color: c.text, fontFamily: c.font }}>Standings</span>
        </div>
        {/* overflow-x-auto (not overflow-hidden) on its own inner wrapper —
            Zone now sits after Pts (per request), so a phone that can't
            fit every column at once scrolls horizontally to reach it
            rather than the table clipping it. min-w-[560px] on the table
            keeps every column at a legible width so the scroll is always
            available instead of columns getting squeezed illegibly thin. */}
        <div className="rounded-xl overflow-hidden border" style={{ borderColor: c.border }}>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs font-mono">
            <thead>
              <tr style={{ background: c.surface, color: c.textFaint }}>
                <th className="text-left p-2">#</th>
                <th className="text-left p-2">Player</th>
                <th className="p-2">P</th>
                <th className="p-2">W</th>
                <th className="p-2">D</th>
                <th className="p-2">L</th>
                <th className="p-2">GD</th>
                <th className="p-2">Pts</th>
                <th className="text-left p-2 whitespace-nowrap">Zone</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((row, i) => {
                const zone = zones[row.user_id];
                const zoneColor = zone === "elite_safe" ? c.accent : zone === "danger_zone" ? c.red : zone === "checkpoint_safe" ? c.text : c.textFaint;
                return (
                  <tr key={row.user_id} style={{ borderTop: `1px solid ${c.border}`, color: c.text }}>
                    <td className="p-2">{i + 1}</td>
                    <td className="p-2 font-semibold whitespace-nowrap max-w-[110px] overflow-hidden text-ellipsis">
                      {nameFor(row.user_id)}
                      {/* Rank 1 in any non-top tier auto-promotes
                          (resolveLadderWeek) — named here so a player can
                          see exactly which league that lands them in
                          without having to know the tier numbering
                          convention. */}
                      {i === 0 && tier > 1 && (
                        <span className="inline-block mt-1 px-1.5 py-0.5 rounded-full font-mono text-[9px] uppercase font-bold whitespace-nowrap" style={{ background: `${c.accent}22`, color: c.accent, border: `1px solid ${c.accent}55` }}>
                          Promotion pace
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-center">{row.p}</td>
                    <td className="p-2 text-center">{row.w}</td>
                    <td className="p-2 text-center">{row.d}</td>
                    <td className="p-2 text-center">{row.l}</td>
                    <td className="p-2 text-center">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
                    <td className="p-2 text-center font-bold">{row.pts}</td>
                    {/* Highlighted pill (filled background, not just
                        colored text) so Elite Safety Zone / Danger Zone
                        actually stand out at the end of a long row of
                        numbers instead of blending in as one more
                        font-mono cell. */}
                    <td className="p-2 whitespace-nowrap">
                      {zone && (
                        <span className="px-1.5 py-0.5 rounded-full font-mono text-[9px] uppercase font-bold whitespace-nowrap" style={{ background: `${zoneColor}22`, color: zoneColor, border: `1px solid ${zoneColor}55` }}>
                          {ZONE_LABEL[zone]}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {standings.length === 0 && (
                <tr><td colSpan={9} className="p-3 text-center" style={{ color: c.textFaint }}>No fixtures yet.</td></tr>
              )}
            </tbody>
          </table>
          </div>

        </div>
      </div>

      {isAdmin && (
        <LadderMembersPanel leagueId={leagueId} tier={tier} members={members} profilesById={profilesById}
          standings={standings} fixtures={fixtures} session={session}
          reminders={memberReminders}
          onSent={(uid, sentAt) => setMemberReminders((prev) => ({ ...prev, [uid]: sentAt }))}
          onCleared={(uid) => setMemberReminders((prev) => ({ ...prev, [uid]: null }))}
          c={c} />
      )}

      {/* Ladder Pool used to be an inline card mounted right here — it's
          now its own screen (see LadderPoolAdminPanel.jsx's header), since
          the pool is a global singleton, not scoped to this league. This
          is just a link over to it. */}
      {isAdmin && (
        <button onClick={onOpenLadderPoolAdmin}
          className="rounded-xl border p-3 flex items-center justify-between gap-3 text-left"
          style={{ borderColor: c.border }}>
          <div className="flex items-center gap-2">
            <PiggyBank size={14} style={{ color: c.accent }} />
            <span className="text-sm font-bold" style={{ color: c.text, fontFamily: c.font }}>Ladder Pool (Admin)</span>
          </div>
          <ChevronRight size={14} style={{ color: c.textFaint }} />
        </button>
      )}

      {/* Results / Bids / Fixtures / Comments — four widgets sharing one
          spot below the Standings table. Only the active tab's content
          mounts, so LiveBidTicker (its own polling) and the comment
          thread (its own fetch) only load once a player actually opens
          that tab, instead of every widget fetching on every visit. */}
      <div>
        <div className="flex gap-1.5 mb-3 overflow-x-auto">
          {WIDGET_TABS.map((w) => (
            <button key={w.id} onClick={() => setActiveWidget(w.id)}
              className="shrink-0 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest px-3 py-2 rounded-lg"
              style={activeWidget === w.id
                ? { background: c.accent, color: c.accentText }
                : { background: c.surfaceHover, color: c.textFaint, border: `1px solid ${c.border}` }}>
              <w.Icon size={12} /> {w.label}
            </button>
          ))}
        </div>

        {activeWidget === "results" && (
          <div className="flex flex-col gap-2">
            {resultsFixtures.map(renderFixtureRow)}
            {resultsFixtures.length === 0 && (
              <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>
                No results yet this week.
              </div>
            )}
          </div>
        )}

        {activeWidget === "bids" && (
          <div className="flex flex-col gap-3">
      {/* PromotionBidBanner + embedded ticker — this league's OWN bid
          ticker (right below) is for bidding on THIS league's spot from
          below; this section is the opposite direction — a non-promoted,
          non-danger-zone active member of THIS league is eligible to bid
          their way into the league one tier up. Excludes danger_zone on
          top of the existing rank-1 exclusion: a player fighting to
          avoid the bottom 2 isn't in a position to also be chasing a
          promoted spot above them — that banner would just be noise (see
          myZone's own comment above for why the server doesn't need to
          enforce this too). The bid itself now happens right here inline
          (an embedded LiveBidTicker targeting the league above) instead
          of a "Go bid" button that navigated to League {tier - 1}'s own
          screen — the eligibility is identical either way (place_ladder_bid
          checks the bidder server-side against the TARGET league, not
          which screen they were on), so this is purely about not losing
          the moment: watching your own league's table next to the league
          above's live bid ticker, both open at once, is the suspense the
          request asked for that a navigate-away button couldn't give. */}
      {cycle?.bidding_open && displayWeek === cycle?.current_week && isMember
        && myRankPosition != null && myRankPosition !== 1 && myZone !== "danger_zone" && tier > 1 && biddingTargetLeagueId && (
        <div className="flex flex-col gap-2">
          <div className="rounded-xl border p-3" style={{ borderColor: c.accent, background: `${c.accent}14` }}>
            <div className="font-body text-xs" style={{ color: c.text }}>
              Bidding's open — you're eligible to bid for a promoted spot in <span className="font-bold">League {tier - 1}</span>.
            </div>
          </div>
          <LiveBidTicker leagueId={biddingTargetLeagueId} weekNumber={cycle.current_week} tier={tier - 1} maxTier={maxTier} session={session} c={c} />
        </div>
      )}

      {/* DangerZoneBanner — the symmetric case: a member currently sitting
          in the bottom-2 badge (myZone === 'danger_zone') isn't chasing
          promotion, they're one bad result from being relegated OUT of
          League {tier} altogether. They don't get a second embedded
          ticker here — the eligible pool for buying a fast return only
          ever includes players ALREADY relegated (last week) plus this
          league's own risers from League {tier + 1} (see
          20260861_ladder_bidding.sql's _ladder_bid_eligible_pool_internal);
          a still-active danger_zone player isn't in that pool yet, so an
          interactive bid box here would just be rejected server-side.
          What they get instead is the same "Aim For League {tier}" ticker
          already rendered just below, reframed for them specifically: if
          Sunday's standings drop them into the bottom 2, THIS is the exact
          battle — against League {tier + 1}'s own risers — they'll need to
          win to buy their way straight back in rather than sit out a full
          cycle down a tier. */}
      {myZone === "danger_zone" && (
        <div className="rounded-xl border p-3" style={{ borderColor: c.red, background: `${c.red}14` }}>
          <div className="font-body text-xs" style={{ color: c.text }}>
            ⚠️ You're in the <span className="font-bold">Danger Zone</span>. Finish Sunday in the bottom 2 and you're relegated — the ticker below is exactly the fight you'd face to buy your way straight back into <span className="font-bold">League {tier}</span>, against League {(tier ?? 0) + 1}'s own risers.
          </div>
        </div>
      )}

      {cycle?.bidding_open && displayWeek === cycle?.current_week && (
        tier === 1 ? (
          // League 1 has no league above it and isn't part of its own
          // ticker's bidder pool either way (that pool is previously-
          // relegated players + League 2 risers, never a currently-safe
          // League 1 member — see the DangerZoneBanner comment above), so
          // only the bottom-2 Danger Zone members — the ones actually at
          // risk and who WILL be in that pool the moment they're
          // relegated — see the ticker. Every other member (isMember
          // guards out non-members, who genuinely could be eligible
          // bidders) gets a Kit Room congratulations message instead.
          myZone === "danger_zone" ? (
            <LiveBidTicker leagueId={leagueId} weekNumber={cycle.current_week} tier={tier} maxTier={maxTier} session={session} c={c} />
          ) : isMember ? (
            <div className="rounded-xl border p-3" style={{ borderColor: c.accent, background: `${c.accent}14` }}>
              <div className="font-body text-xs font-semibold" style={{ color: c.text }}>
                {KIT_ROOM_MESSAGES[kitRoomMsgIndex](nameFor(session?.user?.id))}
              </div>
            </div>
          ) : (
            <LiveBidTicker leagueId={leagueId} weekNumber={cycle.current_week} tier={tier} maxTier={maxTier} session={session} c={c} />
          )
        ) : myRankPosition === 1 ? (
          // Rank 1 in a non-top tier auto-promotes regardless of who bids
          // what — this league's own bidding war is for everyone else's
          // seat, not theirs, so showing the ticker here would wrongly
          // suggest they might need to bid to stay. A congratulations
          // message instead, picked from RANK1_SAFE_MESSAGES.
          <div className="rounded-xl border p-3" style={{ borderColor: c.accent, background: `${c.accent}14` }}>
            <div className="font-body text-xs font-semibold" style={{ color: c.text }}>
              {RANK1_SAFE_MESSAGES[rank1MsgIndex](tier)}
            </div>
          </div>
        ) : (
          <LiveBidTicker leagueId={leagueId} weekNumber={cycle.current_week} tier={tier} maxTier={maxTier} session={session} c={c} />
        )
      )}
            {/* Nothing eligible to show — bidding's closed for this week
                and the viewer isn't in the Danger Zone (the one bid-related
                banner that doesn't depend on bidding being open). */}
            {!(cycle?.bidding_open && displayWeek === cycle?.current_week) && myZone !== "danger_zone" && (
              <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>
                No bidding activity right now — check back when bidding opens.
              </div>
            )}
          </div>
        )}

        {activeWidget === "fixtures" && (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: c.textFaint }} />
              <input type="text" value={opponentQuery} onChange={(e) => setOpponentQuery(e.target.value)}
                placeholder="Find my opponent…"
                className="w-full font-mono text-xs rounded-lg pl-8 pr-3 py-2 outline-none"
                style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            </div>
            <div className="flex flex-col gap-2">
              {upcomingFixtures.map(renderFixtureRow)}
              {upcomingFixtures.length === 0 && (
                <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>
                  {oq ? `No fixture matching "${opponentQuery}".` : isAdmin ? "No fixtures for this league yet." : "You have no fixture this week."}
                </div>
              )}
            </div>
          </div>
        )}

        {activeWidget === "comments" && (
          <LadderLeagueComments leagueId={leagueId} session={session} isAdmin={isAdmin} isMember={isMember} nameFor={nameFor} c={c} />
        )}
      </div>
    </div>
  );
}

// timeAgoShort — minimal relative timestamp for comment rows (just this
// widget's needs; the app's other comment threads have their own richer
// version in App.jsx, not exported for reuse here).
function timeAgoShort(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

// LadderLeagueComments — this League Ladder tier's own comment wall,
// backed by ladder_league_comments/ladder_league_comment_likes (separate
// from the regular-league `comments` table and from the OLD 1v1 challenge
// Ladder's single global `ladder_comments` — see the migration header for
// why this needed its own tables). Self-contained: fetches on its own
// mount, which — since it's only ever rendered while
// activeWidget === "comments" above — is exactly the lazy-load behavior
// the other three widgets get too.
function LadderLeagueComments({ leagueId, session, isAdmin, isMember, nameFor, c }) {
  const [comments, setComments] = useState(null); // null = loading
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState(null); // comment being replied to, or null
  const [posting, setPosting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("ladder_league_comments")
      .select("*, ladder_league_comment_likes(*)")
      .eq("league_id", leagueId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) { console.error("Couldn't load comments:", error.message); setComments([]); return; }
    setComments(data || []);
  }, [leagueId]);

  useEffect(() => { load(); }, [load]);

  const post = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setPosting(true);
    const { error } = await supabase.from("ladder_league_comments").insert({
      league_id: leagueId,
      user_id: session.user.id,
      username: nameFor(session.user.id),
      body: trimmed,
      parent_comment_id: replyTo?.id || null,
    });
    setPosting(false);
    if (error) { console.error("Couldn't post comment:", error.message); return; }
    setBody("");
    setReplyTo(null);
    await load();
  };

  const remove = async (comment) => {
    const { error } = await supabase.from("ladder_league_comments").delete().eq("id", comment.id);
    setDeletingId(null);
    if (error) { console.error("Couldn't delete comment:", error.message); return; }
    await load();
  };

  const toggleLike = async (comment) => {
    const mine = (comment.ladder_league_comment_likes || []).find((l) => l.user_id === session.user.id);
    if (mine) {
      const { error } = await supabase.from("ladder_league_comment_likes").delete().eq("id", mine.id);
      if (error) { console.error("Couldn't remove reaction:", error.message); return; }
    } else {
      const { error } = await supabase.from("ladder_league_comment_likes").insert({ comment_id: comment.id, user_id: session.user.id, reaction: "👍" });
      if (error) { console.error("Couldn't react:", error.message); return; }
    }
    await load();
  };

  if (comments === null) {
    return (
      <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>Loading comments…</div>
    );
  }

  const topLevel = comments.filter((cm) => !cm.parent_comment_id);
  const repliesOf = (id) => comments.filter((cm) => cm.parent_comment_id === id).slice().reverse();

  const canDelete = (cm) => isAdmin || cm.user_id === session?.user?.id;

  const CommentRow = ({ cm, isReply }) => {
    const mine = (cm.ladder_league_comment_likes || []).find((l) => l.user_id === session?.user?.id);
    const likeCount = (cm.ladder_league_comment_likes || []).length;
    return (
      <div className={isReply ? "ml-6 pt-2" : "pt-3"} style={!isReply ? { borderTop: `1px solid ${c.border}` } : undefined}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs font-bold" style={{ color: c.text }}>{cm.username}</span>
              <span className="font-mono text-[9px]" style={{ color: c.textFaint }}>{timeAgoShort(cm.created_at)}</span>
            </div>
            <div className="text-xs mt-0.5 whitespace-pre-wrap break-words" style={{ color: c.text, fontFamily: c.font }}>{cm.body}</div>
            <div className="flex items-center gap-3 mt-1">
              <button onClick={() => toggleLike(cm)} className="flex items-center gap-1 font-mono text-[9px]" style={{ color: mine ? c.accent : c.textFaint }}>
                <Heart size={10} fill={mine ? c.accent : "none"} /> {likeCount > 0 ? likeCount : ""}
              </button>
              {!isReply && isMember && (
                <button onClick={() => setReplyTo(cm)} className="font-mono text-[9px] uppercase" style={{ color: c.textFaint }}>Reply</button>
              )}
              {canDelete(cm) && (
                deletingId === cm.id ? (
                  <span className="flex items-center gap-2">
                    <button onClick={() => remove(cm)} className="font-mono text-[9px] uppercase" style={{ color: c.red }}>Confirm delete</button>
                    <button onClick={() => setDeletingId(null)} className="font-mono text-[9px] uppercase" style={{ color: c.textFaint }}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => setDeletingId(cm.id)} className="opacity-60 hover:opacity-100" style={{ color: c.textFaint }}>
                    <Trash2 size={10} />
                  </button>
                )
              )}
            </div>
          </div>
        </div>
        {repliesOf(cm.id).map((r) => <CommentRow key={r.id} cm={r} isReply />)}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {isMember ? (
        <div className="rounded-lg border p-2" style={{ borderColor: c.border }}>
          {replyTo && (
            <div className="flex items-center justify-between mb-1.5 font-mono text-[9px] uppercase" style={{ color: c.textFaint }}>
              <span>Replying to {replyTo.username}</span>
              <button onClick={() => setReplyTo(null)} style={{ color: c.textFaint }}>✕</button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2}
              placeholder="Say something to the league…"
              className="flex-1 font-mono text-xs rounded-lg p-2 outline-none resize-none"
              style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            <button onClick={post} disabled={posting || !body.trim()}
              className="font-mono text-[10px] uppercase px-3 py-2 rounded-lg flex items-center gap-1 shrink-0 disabled:opacity-50"
              style={{ background: c.accent, color: c.accentText }}>
              <Send size={12} /> {posting ? "…" : "Post"}
            </button>
          </div>
        </div>
      ) : (
        <div className="font-mono text-[10px] uppercase text-center py-2" style={{ color: c.textFaint }}>
          Join this league to post.
        </div>
      )}

      {topLevel.length === 0 ? (
        <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>No comments yet — be the first to say something.</div>
      ) : (
        topLevel.map((cm) => <CommentRow key={cm.id} cm={cm} isReply={false} />)
      )}
    </div>
  );
}
