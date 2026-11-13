// Star ratings and comments for a shop product.
//
// The comments are a copy of Matchday's challenge-board comments (threaded
// replies, emoji reactions, delete by the author or an admin), pointed at
// shop_product_comments instead. Anyone can read; rating, commenting and
// reacting need a signed-in account (guests get the sign-in prompt).
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Star, CornerDownRight, Trash2, X, Send } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";
const MAX_INDENT_DEPTH = 3;

const REACTIONS = [
  { key: "like", emoji: "👍" },
  { key: "love", emoji: "❤️" },
  { key: "laugh", emoji: "😂" },
  { key: "fire", emoji: "🔥" },
  { key: "wow", emoji: "😮" },
  { key: "skull", emoji: "💀" },
];
const REACTION_EMOJI = Object.fromEntries(REACTIONS.map((r) => [r.key, r.emoji]));

const AVATAR_HUES = [142, 168, 25, 45, 200, 280, 340, 10];
function avatarColor(seed) {
  const s = seed || "?";
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length]}, 42%, 38%)`;
}

function timeAgo(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}

// Read-only or tappable row of five stars. `value` can be fractional (4.5).
export function StarRow({ value = 0, size = 14, onPick, label }) {
  return (
    <span className="inline-flex items-center gap-0.5" role={onPick ? "radiogroup" : "img"} aria-label={label || `${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = Math.max(0, Math.min(1, value - (n - 1)));
        const star = (
          <span className="relative inline-block" style={{ width: size, height: size }}>
            <Star size={size} style={{ color: GOLD, opacity: 0.35 }} />
            {fill > 0 && (
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                <Star size={size} fill={GOLD} style={{ color: GOLD }} />
              </span>
            )}
          </span>
        );
        return onPick ? (
          <button key={n} type="button" onClick={() => onPick(n)} aria-label={`${n} star${n === 1 ? "" : "s"}`} role="radio" aria-checked={Math.round(value) === n}
            className="p-0.5 -m-0.5">{star}</button>
        ) : <span key={n}>{star}</span>;
      })}
    </span>
  );
}

function buildTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  byId.forEach((node) => {
    const parent = node.parent_comment_id && byId.get(node.parent_comment_id);
    if (parent) parent.children.push(node); else roots.push(node);
  });
  return roots.reverse(); // newest thread first; replies stay oldest-first
}

function CommentNode({ comment: cm, session, isAdmin, onReply, onDelete, onReact, c, depth }) {
  const isOwn = session && cm.user_id === session.user.id;
  const reactions = cm.shop_product_comment_likes || [];
  const myReaction = session ? (reactions.find((l) => l.user_id === session.user.id)?.reaction || null) : null;
  const summary = useMemo(() => {
    const counts = new Map();
    reactions.forEach((r) => counts.set(r.reaction, (counts.get(r.reaction) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [reactions]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesShown, setRepliesShown] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);
  const pickerRef = useRef(null);
  const indent = Math.min(depth, MAX_INDENT_DEPTH) * 22;

  useEffect(() => {
    if (!pickerOpen) return;
    const onOutside = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [pickerOpen]);

  const mainClick = () => {
    if (!session) { onReact(cm, "like"); return; } // prompts sign-in
    if (myReaction) onReact(cm, null); else setPickerOpen((v) => !v);
  };
  const sendReply = async () => {
    const text = replyText.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onReply(cm, text);
    setBusy(false);
    if (ok) { setReplyText(""); setReplyOpen(false); setRepliesShown(true); }
  };

  return (
    <div>
      <div className="flex items-start gap-2 group" style={{ marginLeft: indent }}>
        <div className="rounded-full flex items-center justify-center font-body font-bold shrink-0"
          style={{ background: avatarColor(cm.username), color: "#fff", width: 26, height: 26, fontSize: 11 }}>
          {cm.username?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="flex-1 min-w-0 rounded-xl px-3 py-2" style={{ background: c.surface }}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-body font-semibold text-xs truncate">{cm.username}</span>
            <span className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{timeAgo(cm.created_at)}</span>
              {(isOwn || isAdmin) && (
                <button onClick={() => onDelete(cm)} title="Delete" aria-label="Delete comment" style={{ color: c.textFaint }}><Trash2 size={11} /></button>
              )}
            </span>
          </div>
          <div className="font-body text-sm mt-0.5 whitespace-pre-wrap break-words">{cm.body}</div>
          <div className="flex items-center gap-3 mt-1.5">
            <div className="relative" ref={pickerRef}>
              <button onClick={mainClick} className="flex items-center gap-1 font-mono text-[10px]" style={{ color: myReaction ? GOLD : c.textFaint }} aria-label="React">
                <span style={{ fontSize: 12, lineHeight: 1 }}>{myReaction ? REACTION_EMOJI[myReaction] : "🤍"}</span>
                {reactions.length > 0 && <span>{summary.slice(0, 3).map(([k]) => REACTION_EMOJI[k]).join("")} {reactions.length}</span>}
              </button>
              {pickerOpen && (
                <div className="absolute top-full left-0 mt-1.5 flex items-center gap-0.5 rounded-full px-1.5 py-1 shadow-lg z-10"
                  style={{ background: c.surfaceHover, border: `1px solid ${c.borderStrong}` }}>
                  {REACTIONS.map((r) => (
                    <button key={r.key} onClick={() => { setPickerOpen(false); onReact(cm, r.key); }} title={r.key} className="px-1" style={{ fontSize: 16, lineHeight: 1 }}>{r.emoji}</button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => (session ? setReplyOpen((v) => !v) : onReply(cm, null))} className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Reply</button>
          </div>
        </div>
      </div>

      {cm.children.length > 0 && (
        <button onClick={() => setRepliesShown((v) => !v)} className="mt-1 font-mono text-[10px] uppercase tracking-wider flex items-center gap-1"
          style={{ color: c.textFaint, marginLeft: indent + 34 }}>
          <CornerDownRight size={11} /> {repliesShown ? "Hide" : "Show"} {cm.children.length} repl{cm.children.length === 1 ? "y" : "ies"}
        </button>
      )}
      {repliesShown && (
        <div className="mt-2 space-y-2">
          {cm.children.map((r) => (
            <CommentNode key={r.id} comment={r} session={session} isAdmin={isAdmin} onReply={onReply} onDelete={onDelete} onReact={onReact} c={c} depth={depth + 1} />
          ))}
        </div>
      )}
      {replyOpen && (
        <div className="mt-2" style={{ marginLeft: indent + 34 }}>
          <div className="flex items-center gap-1.5 mb-1.5 font-mono text-[10px]" style={{ color: c.textFaint }}>
            <CornerDownRight size={11} /> Replying to {cm.username}
            <button onClick={() => { setReplyOpen(false); setReplyText(""); }} aria-label="Cancel reply"><X size={11} /></button>
          </div>
          <div className="flex items-end gap-2">
            <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={1} maxLength={1000} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
              placeholder={`Reply to ${cm.username}…`}
              className="flex-1 font-body text-sm rounded-xl px-3 py-2 resize-none outline-none border" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
            <button onClick={sendReply} disabled={!replyText.trim() || busy} aria-label="Send reply"
              className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: GOLD, color: "#1a1200", opacity: !replyText.trim() || busy ? 0.5 : 1 }}>
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProductReviews({ product, session, profile, isAdmin, onRequireAuth, showToast, onRatingsChanged, c }) {
  const productId = product.id;
  const [ratings, setRatings] = useState(null); // [{user_id, rating}]
  const [comments, setComments] = useState(null);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);

  const userId = session?.user?.id || null;
  const username = profile?.efootball_username
    || session?.user?.user_metadata?.full_name?.split(" ")[0]
    || session?.user?.email?.split("@")[0]
    || "Shopper";
  const needSignIn = (msg) => { onRequireAuth ? onRequireAuth(msg) : showToast(msg); };

  const loadRatings = useCallback(async () => {
    const { data, error } = await supabase.from("shop_product_ratings").select("user_id, rating").eq("product_id", productId);
    if (!error) setRatings(data || []);
  }, [productId]);
  const loadComments = useCallback(async () => {
    const { data, error } = await supabase.from("shop_product_comments")
      .select("*, shop_product_comment_likes(*)").eq("product_id", productId).order("created_at", { ascending: true });
    if (!error) setComments(data || []);
  }, [productId]);
  useEffect(() => { loadRatings(); loadComments(); }, [loadRatings, loadComments]);

  const count = ratings?.length || 0;
  const avg = count ? ratings.reduce((n, r) => n + r.rating, 0) / count : 0;
  const mine = userId ? ratings?.find((r) => r.user_id === userId)?.rating || 0 : 0;

  const rate = async (n) => {
    if (!userId) { needSignIn("Sign in to rate this product."); return; }
    const { error } = await supabase.from("shop_product_ratings")
      .upsert({ product_id: productId, user_id: userId, rating: n, updated_at: new Date().toISOString() }, { onConflict: "product_id,user_id" });
    if (error) { showToast(`Couldn't save your rating: ${error.message}`); return; }
    showToast("Thanks for rating!");
    await loadRatings();
    onRatingsChanged && onRatingsChanged();
  };

  const post = async (body, parent) => {
    if (!userId) { needSignIn("Sign in to comment."); return false; }
    const { error } = await supabase.from("shop_product_comments")
      .insert({ product_id: productId, user_id: userId, username, body, parent_comment_id: parent?.id || null });
    if (error) { showToast(`Couldn't post: ${error.message}`); return false; }
    await loadComments();
    return true;
  };
  const submitTop = async () => {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    const ok = await post(body, null);
    setPosting(false);
    if (ok) setText("");
  };
  const onReply = async (cm, body) => (body === null ? (needSignIn("Sign in to reply."), false) : post(body, cm));
  const onDelete = async (cm) => {
    if (!window.confirm("Delete this comment?")) return;
    const { error } = await supabase.from("shop_product_comments").delete().eq("id", cm.id);
    if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
    await loadComments();
  };
  const onReact = async (cm, reaction) => {
    if (!userId) { needSignIn("Sign in to react."); return false; }
    const mineLike = (cm.shop_product_comment_likes || []).find((l) => l.user_id === userId);
    let error;
    if (reaction === null || (mineLike && mineLike.reaction === reaction)) {
      if (mineLike) ({ error } = await supabase.from("shop_product_comment_likes").delete().eq("id", mineLike.id));
    } else if (mineLike) {
      ({ error } = await supabase.from("shop_product_comment_likes").update({ reaction }).eq("id", mineLike.id));
    } else {
      ({ error } = await supabase.from("shop_product_comment_likes").insert({ comment_id: cm.id, user_id: userId, reaction }));
    }
    if (error) { showToast(`Couldn't react: ${error.message}`); return false; }
    await loadComments();
    return true;
  };

  const tree = useMemo(() => buildTree(comments || []), [comments]);

  return (
    <div className="mt-5 pt-4 border-t" style={{ borderColor: c.border }} data-testid="reviews">
      <div className="font-extrabold uppercase tracking-tight text-sm mb-2">Ratings</div>
      <div className="flex items-center gap-2 mb-1">
        <StarRow value={avg} size={16} />
        <span className="font-body text-xs" style={{ color: c.textDim }}>
          {count ? `${avg.toFixed(1)} · ${count} rating${count === 1 ? "" : "s"}` : "No ratings yet"}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-5">
        <span className="font-body text-xs" style={{ color: c.textDim }}>{mine ? "Your rating:" : "Rate this product:"}</span>
        <StarRow value={mine} size={22} onPick={rate} label="Your rating" />
      </div>

      <div className="font-extrabold uppercase tracking-tight text-sm mb-2">Comments{comments ? ` (${comments.length})` : ""}</div>
      <div className="flex items-end gap-2 mb-3">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} aria-label="Write a comment"
          onFocus={() => { if (!userId) needSignIn("Sign in to comment."); }}
          placeholder={userId ? "Write a comment…" : "Sign in to comment…"}
          className="flex-1 font-body text-sm rounded-xl px-3 py-2 resize-none outline-none border" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={submitTop} disabled={!text.trim() || posting} aria-label="Post comment"
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: GOLD, color: "#1a1200", opacity: !text.trim() || posting ? 0.5 : 1 }}>
          <Send size={14} />
        </button>
      </div>
      {comments === null ? (
        <div className="font-body text-xs" style={{ color: c.textFaint }}>Loading comments…</div>
      ) : tree.length === 0 ? (
        <div className="font-body text-xs" style={{ color: c.textFaint }}>No comments yet. Be the first.</div>
      ) : (
        <div className="space-y-2.5">
          {tree.map((cm) => (
            <CommentNode key={cm.id} comment={cm} session={session} isAdmin={isAdmin} onReply={onReply} onDelete={onDelete} onReact={onReact} c={c} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
