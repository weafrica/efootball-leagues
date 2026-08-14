import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";
import {
  ArrowLeft, Tag, Send, X, Check, XCircle, Clock, Trash2, ChevronDown, ChevronUp,
  ShieldCheck, Handshake, Gavel,
} from "lucide-react";

// Split out the same way Shop/Leaderboard/Ladder are: lazy-loaded from
// App.jsx, only mounted once someone actually opens the Transfer Market.
//
// A "club" here means a `teams` row a member currently owns (their
// `members` row's team_id) inside a league — the same thing the rest of
// the app calls a club. Listing one for sale, and a buyer's offer being
// accepted, is a real ownership handover: accept_transfer_offer() (see
// supabase/migrations/20260823_transfer_market.sql) reassigns the
// underlying `members` row to the buyer, so they're the one playing as
// that club everywhere else in the app from that point on.

const CURRENCY_PREFIX = "R"; // South African Rand — matches the Shop
const formatMoney = (n) => `${CURRENCY_PREFIX}${Number(n).toLocaleString("en-ZA")}`;

function Spinner({ c }) {
  return (
    <div className="flex items-center justify-center h-40">
      <div className="w-7 h-7 rounded-full animate-spin" style={{ border: `2px solid ${c.green}`, borderTopColor: "transparent" }} />
    </div>
  );
}

function EmptyState({ icon: Icon, title, sub, c }) {
  return (
    <div className="flex flex-col items-center text-center py-16 px-6">
      <Icon size={28} style={{ color: c.textFaint }} className="mb-3" />
      <p className="font-body font-semibold text-sm" style={{ color: c.text }}>{title}</p>
      {sub && <p className="font-body text-xs mt-1 max-w-xs" style={{ color: c.textDim }}>{sub}</p>}
    </div>
  );
}

const STATUS_META = {
  active: { label: "Listed", color: "#2D6A4F" },
  sold: { label: "Sold", color: "#B4802E" },
  cancelled: { label: "Cancelled", color: "#888" },
  pending: { label: "Pending", color: "#B8860B" },
  accepted: { label: "Accepted", color: "#2D6A4F" },
  declined: { label: "Declined", color: "#C4293A" },
  withdrawn: { label: "Withdrawn", color: "#888" },
};
function StatusPill({ status, c }) {
  const meta = STATUS_META[status] || { label: status, color: c.textDim };
  return (
    <span className="inline-flex items-center font-mono text-[10px] font-semibold px-2 py-0.5 rounded-full"
      style={{ background: `${meta.color}22`, color: meta.color }}>
      {meta.label}
    </span>
  );
}

export default function TransferMarket({ c, session, profile, leagues, onBack, showToast: showToastProp }) {
  const [tab, setTab] = useState("browse"); // browse | mine | offers | sell
  const [listings, setListings] = useState(null);
  const [myOffers, setMyOffers] = useState(null);
  const [offersByListing, setOffersByListing] = useState({}); // listing_id -> offers[] (for "My listings")
  const [expandedListing, setExpandedListing] = useState(null);
  const [offerModal, setOfferModal] = useState(null); // listing being offered on
  const [localToast, setLocalToast] = useState(null);
  const showToast = showToastProp || ((msg) => { setLocalToast(msg); setTimeout(() => setLocalToast((t) => (t === msg ? null : t)), 3000); });

  const myId = session?.user?.id;

  const loadListings = async () => {
    const { data, error } = await supabase.from("transfer_listings").select("*").order("created_at", { ascending: false });
    if (!error) setListings(data || []);
  };
  useEffect(() => { loadListings(); }, []);

  const loadMyOffers = async () => {
    if (!myId) return;
    const { data, error } = await supabase.from("transfer_offers").select("*").eq("buyer_id", myId).order("created_at", { ascending: false });
    if (!error) setMyOffers(data || []);
  };
  useEffect(() => { if (tab === "offers") loadMyOffers(); }, [tab]);

  const loadOffersFor = async (listingId) => {
    const { data, error } = await supabase.from("transfer_offers").select("*").eq("listing_id", listingId).order("created_at", { ascending: false });
    if (!error) setOffersByListing((prev) => ({ ...prev, [listingId]: data || [] }));
  };

  // Every club I currently own, across every league — pulled straight from
  // the `leagues` prop the app already has loaded, no extra fetch needed.
  const myClubs = useMemo(() => {
    if (!myId) return [];
    const out = [];
    (leagues || []).forEach((l) => {
      (l.members || []).forEach((m) => {
        if (m.user_id === myId && m.team_id) {
          const team = (l.teams || []).find((t) => t.id === m.team_id);
          if (team) out.push({ league_id: l.id, league_name: l.name, team_id: team.id, team_name: team.name });
        }
      });
    });
    return out;
  }, [leagues, myId]);

  const leagueName = (id) => (leagues || []).find((l) => l.id === id)?.name || "Unknown league";
  const clubName = (leagueId, teamId) => (leagues || []).find((l) => l.id === leagueId)?.teams?.find((t) => t.id === teamId)?.name || "Unknown club";

  const activeListings = (listings || []).filter((l) => l.status === "active");
  const myListedTeamIds = new Set((listings || []).filter((l) => l.status === "active" && l.seller_id === myId).map((l) => l.team_id));
  const sellableClubs = myClubs.filter((cl) => !myListedTeamIds.has(cl.team_id));
  const myListings = (listings || []).filter((l) => l.seller_id === myId);

  const submitListing = async ({ league_id, team_id, asking_price, description }) => {
    const { error } = await supabase.from("transfer_listings").insert({
      league_id, team_id, seller_id: myId,
      asking_price: asking_price ? Number(asking_price) : null,
      description: description || null,
    });
    if (error) { showToast(`Couldn't list your club: ${error.message}`); return false; }
    showToast("Club listed on the Transfer Market.");
    await loadListings();
    setTab("mine");
    return true;
  };

  const submitOffer = async (listing, amount, message) => {
    const { error } = await supabase.from("transfer_offers").insert({
      listing_id: listing.id, buyer_id: myId, amount: Number(amount), message: message || null,
    });
    if (error) { showToast(`Couldn't send offer: ${error.message}`); return false; }
    showToast("Offer sent.");
    setOfferModal(null);
    return true;
  };

  const withdrawOffer = async (offer) => {
    const { error } = await supabase.from("transfer_offers").update({ status: "withdrawn" }).eq("id", offer.id);
    if (error) { showToast(`Couldn't withdraw: ${error.message}`); return; }
    showToast("Offer withdrawn.");
    loadMyOffers();
  };

  const acceptOffer = async (offer) => {
    const { error } = await supabase.rpc("accept_transfer_offer", { p_offer_id: offer.id });
    if (error) { showToast(`Couldn't accept offer: ${error.message}`); return; }
    showToast("Deal done — the club has been transferred.");
    await loadListings();
    if (offer.listing_id) loadOffersFor(offer.listing_id);
  };

  const declineOffer = async (offer) => {
    const { error } = await supabase.rpc("decline_transfer_offer", { p_offer_id: offer.id });
    if (error) { showToast(`Couldn't decline offer: ${error.message}`); return; }
    if (offer.listing_id) loadOffersFor(offer.listing_id);
  };

  const cancelListing = async (listing) => {
    const { error } = await supabase.rpc("cancel_transfer_listing", { p_listing_id: listing.id });
    if (error) { showToast(`Couldn't cancel listing: ${error.message}`); return; }
    showToast("Listing cancelled.");
    loadListings();
  };

  if (!session) {
    return (
      <div className="max-w-md mx-auto px-4 pt-6 pb-16">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
        <EmptyState icon={ShieldCheck} title="Sign in to use the Transfer Market" sub="You'll need an account to list a club or make offers." c={c} />
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-16">
      <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>

      <div className="flex items-center gap-2 mb-1">
        <Handshake size={20} style={{ color: c.accent }} />
        <h1 className="font-display text-xl font-bold" style={{ color: c.text }}>Transfer Market</h1>
      </div>
      <p className="font-body text-xs mb-5" style={{ color: c.textDim }}>Buy and sell clubs with other members. Accepting an offer hands the club over for real.</p>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl mb-5" style={{ background: c.surface }}>
        {[
          { id: "browse", label: "Browse" },
          { id: "sell", label: "Sell" },
          { id: "mine", label: "My listings" },
          { id: "offers", label: "My offers" },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className="flex-1 font-body text-xs font-semibold py-2 rounded-lg transition-colors"
            style={{ background: tab === t.id ? c.accent : "transparent", color: tab === t.id ? c.accentText : c.textDim }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "browse" && (
        listings === null ? <Spinner c={c} /> :
        activeListings.length === 0 ? <EmptyState icon={Tag} title="No clubs listed right now" sub="Check back later, or list your own from the Sell tab." c={c} /> :
        <div className="space-y-3">
          {activeListings.map((l) => (
            <div key={l.id} className="rounded-2xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-body font-semibold text-sm" style={{ color: c.text }}>{clubName(l.league_id, l.team_id)}</p>
                  <p className="font-body text-[11px] mt-0.5" style={{ color: c.textDim }}>{leagueName(l.league_id)}</p>
                </div>
                <p className="font-mono font-bold text-sm shrink-0" style={{ color: c.accent }}>
                  {l.asking_price ? formatMoney(l.asking_price) : "Offers only"}
                </p>
              </div>
              {l.description && <p className="font-body text-xs mt-2" style={{ color: c.textDim }}>{l.description}</p>}
              {l.seller_id === myId ? (
                <p className="font-body text-[11px] mt-3" style={{ color: c.textFaint }}>This is your own listing.</p>
              ) : (
                <button onClick={() => setOfferModal(l)}
                  className="mt-3 w-full font-body text-xs font-semibold py-2 rounded-lg flex items-center justify-center gap-1.5"
                  style={{ background: c.accent, color: c.accentText }}>
                  <Send size={13} /> Make an offer
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "sell" && (
        <SellForm clubs={sellableClubs} onSubmit={submitListing} c={c} showToast={showToast} />
      )}

      {tab === "mine" && (
        myListings.length === 0 ? <EmptyState icon={Gavel} title="You haven't listed a club yet" sub="Switch to the Sell tab to put one on the market." c={c} /> :
        <div className="space-y-3">
          {myListings.map((l) => {
            const isOpen = expandedListing === l.id;
            const offers = offersByListing[l.id];
            return (
              <div key={l.id} className="rounded-2xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-body font-semibold text-sm" style={{ color: c.text }}>{clubName(l.league_id, l.team_id)}</p>
                    <p className="font-body text-[11px] mt-0.5" style={{ color: c.textDim }}>{leagueName(l.league_id)}</p>
                  </div>
                  <StatusPill status={l.status} c={c} />
                </div>
                <p className="font-mono font-bold text-sm mt-2" style={{ color: c.accent }}>
                  {l.status === "sold" ? `Sold for ${formatMoney(l.sold_price)}` : (l.asking_price ? formatMoney(l.asking_price) : "Offers only")}
                </p>
                {l.status === "active" && (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => { const next = isOpen ? null : l.id; setExpandedListing(next); if (next) loadOffersFor(l.id); }}
                      className="flex-1 font-body text-xs font-semibold py-2 rounded-lg flex items-center justify-center gap-1"
                      style={{ background: c.surfaceHover, color: c.text }}>
                      {isOpen ? "Hide offers" : "View offers"} {isOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                    <button onClick={() => cancelListing(l)}
                      className="font-body text-xs font-semibold py-2 px-3 rounded-lg flex items-center gap-1"
                      style={{ background: c.redSoft, color: c.red }}>
                      <Trash2 size={13} /> Cancel
                    </button>
                  </div>
                )}
                {isOpen && (
                  <div className="mt-3 space-y-2 pt-3 border-t" style={{ borderColor: c.border }}>
                    {offers === undefined ? <Spinner c={c} /> : offers.length === 0 ? (
                      <p className="font-body text-xs" style={{ color: c.textDim }}>No offers yet.</p>
                    ) : offers.map((o) => (
                      <div key={o.id} className="rounded-xl p-3" style={{ background: c.surfaceHover }}>
                        <div className="flex items-center justify-between">
                          <p className="font-mono font-bold text-sm" style={{ color: c.text }}>{formatMoney(o.amount)}</p>
                          <StatusPill status={o.status} c={c} />
                        </div>
                        {o.message && <p className="font-body text-xs mt-1" style={{ color: c.textDim }}>"{o.message}"</p>}
                        {o.status === "pending" && (
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => acceptOffer(o)}
                              className="flex-1 font-body text-[11px] font-semibold py-1.5 rounded-lg flex items-center justify-center gap-1"
                              style={{ background: c.green, color: "#fff" }}>
                              <Check size={12} /> Accept
                            </button>
                            <button onClick={() => declineOffer(o)}
                              className="flex-1 font-body text-[11px] font-semibold py-1.5 rounded-lg flex items-center justify-center gap-1"
                              style={{ background: c.redSoft, color: c.red }}>
                              <XCircle size={12} /> Decline
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "offers" && (
        myOffers === null ? <Spinner c={c} /> :
        myOffers.length === 0 ? <EmptyState icon={Send} title="You haven't made any offers" sub="Browse listings and make an offer on a club you want." c={c} /> :
        <div className="space-y-3">
          {myOffers.map((o) => {
            const listing = (listings || []).find((l) => l.id === o.listing_id);
            return (
              <div key={o.id} className="rounded-2xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-body font-semibold text-sm" style={{ color: c.text }}>
                      {listing ? clubName(listing.league_id, listing.team_id) : "Listing"}
                    </p>
                    {listing && <p className="font-body text-[11px] mt-0.5" style={{ color: c.textDim }}>{leagueName(listing.league_id)}</p>}
                  </div>
                  <StatusPill status={o.status} c={c} />
                </div>
                <p className="font-mono font-bold text-sm mt-2" style={{ color: c.accent }}>Your offer: {formatMoney(o.amount)}</p>
                {o.status === "pending" && (
                  <button onClick={() => withdrawOffer(o)}
                    className="mt-3 w-full font-body text-xs font-semibold py-2 rounded-lg flex items-center justify-center gap-1.5"
                    style={{ background: c.redSoft, color: c.red }}>
                    <X size={13} /> Withdraw offer
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {offerModal && (
        <OfferModal listing={offerModal} clubName={clubName(offerModal.league_id, offerModal.team_id)}
          onClose={() => setOfferModal(null)} onSubmit={submitOffer} c={c} />
      )}

      {!showToastProp && localToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl font-body text-sm font-semibold shadow-lg z-50"
          style={{ background: c.toastBg, color: c.toastText }}>
          {localToast}
        </div>
      )}
    </div>
  );
}

function SellForm({ clubs, onSubmit, c, showToast }) {
  const [selected, setSelected] = useState(clubs[0] || null);
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!selected && clubs.length) setSelected(clubs[0]); }, [clubs]);

  if (clubs.length === 0) {
    return <EmptyState icon={Tag} title="No clubs available to list" sub="Every club you own is either already listed, or you haven't registered a club in a league yet." c={c} />;
  }

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    await onSubmit({ league_id: selected.league_id, team_id: selected.team_id, asking_price: price, description });
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Club to sell</label>
        <select value={selected ? `${selected.league_id}:${selected.team_id}` : ""}
          onChange={(e) => { const [league_id, team_id] = e.target.value.split(":"); setSelected(clubs.find((cl) => cl.league_id === league_id && cl.team_id === team_id)); }}
          className="w-full font-body text-sm rounded-xl px-3 py-2.5 border outline-none"
          style={{ background: c.surface, borderColor: c.border, color: c.text }}>
          {clubs.map((cl) => (
            <option key={`${cl.league_id}:${cl.team_id}`} value={`${cl.league_id}:${cl.team_id}`}>{cl.team_name} — {cl.league_name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Asking price (optional)</label>
        <input type="number" min="0" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)}
          placeholder="Leave blank to accept offers only"
          className="w-full font-body text-sm rounded-xl px-3 py-2.5 border outline-none"
          style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>
      <div>
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Description (optional)</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          placeholder="Record, squad quality, why you're selling…"
          className="w-full font-body text-sm rounded-xl px-3 py-2.5 border outline-none resize-none"
          style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>
      <button onClick={submit} disabled={busy || !selected}
        className="w-full font-body text-sm font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
        style={{ background: c.accent, color: c.accentText }}>
        <Tag size={15} /> {busy ? "Listing…" : "List on the Transfer Market"}
      </button>
    </div>
  );
}

function OfferModal({ listing, clubName, onClose, onSubmit, c }) {
  const [amount, setAmount] = useState(listing.asking_price || "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!amount || Number(amount) < 0) return;
    setBusy(true);
    await onSubmit(listing, amount, message);
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-bold text-base" style={{ color: c.text }}>Offer for {clubName}</h3>
          <button onClick={onClose}><X size={18} style={{ color: c.textDim }} /></button>
        </div>
        {listing.asking_price && (
          <p className="font-body text-xs mb-3" style={{ color: c.textDim }}>Asking price: {formatMoney(listing.asking_price)}</p>
        )}
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Your offer</label>
        <input type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus
          className="w-full font-body text-sm rounded-xl px-3 py-2.5 border outline-none mb-3"
          style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Message (optional)</label>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2}
          className="w-full font-body text-sm rounded-xl px-3 py-2.5 border outline-none resize-none mb-4"
          style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={submit} disabled={busy || !amount}
          className="w-full font-body text-sm font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: c.accent, color: c.accentText }}>
          <Send size={15} /> {busy ? "Sending…" : "Send offer"}
        </button>
      </div>
    </div>
  );
}
