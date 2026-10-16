// In-app chat between the two players on a League Ladder fixture.
//
// Backed by public.ladder_fixture_messages (supabase/migrations/
// 20260953_ladder_fixture_messages.sql), whose RLS only lets the fixture's
// home/away players read or send. History loads once on open; a Supabase
// Realtime subscription carries anything sent after that. Modelled on
// ChallengeChatModal in App.jsx so the two chats look and behave the same.

import React, { useState, useEffect, useRef } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import { supabase } from "./supabaseClient";
import { Loader } from "./App.jsx";

export default function FixtureChatModal({ fixtureId, myId, counterpartUsername, onClose, showToast, c }) {
  const [messages, setMessages] = useState(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase.from("ladder_fixture_messages")
        .select("id, sender_id, body, created_at")
        .eq("fixture_id", fixtureId)
        .order("created_at", { ascending: true });
      if (!active) return;
      if (error) {
        console.error("Couldn't load fixture chat:", error.message);
        showToast?.(`Couldn't load chat: ${error.message}`);
        setMessages([]);
        return;
      }
      setMessages(data || []);
    })();

    const channel = supabase.channel(`ladder-fixture-chat-${fixtureId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ladder_fixture_messages", filter: `fixture_id=eq.${fixtureId}` },
        (payload) => {
          setMessages((prev) => ((prev || []).some((m) => m.id === payload.new.id) ? prev : [...(prev || []), payload.new]));
        })
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Fixture chat realtime subscription failed:", status, err?.message);
          showToast?.("Live chat updates aren't connecting — try reopening the chat.");
        }
      });

    return () => { active = false; supabase.removeChannel(channel); };
  }, [fixtureId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setBody("");
    const { error } = await supabase.from("ladder_fixture_messages").insert({
      fixture_id: fixtureId, sender_id: myId, body: text,
    });
    setSending(false);
    if (error) {
      console.error("Couldn't send fixture message:", error.message);
      showToast?.(`Couldn't send: ${error.message}`);
      setBody(text); // send failed — put the draft back rather than lose it
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{ background: c.bg, border: `1px solid ${c.border}`, height: "min(80vh, 640px)" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: c.border }}>
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle size={18} style={{ color: c.accent }} />
            <h2 className="text-lg font-extrabold uppercase tracking-tight truncate">{counterpartUsername || "Chat"}</h2>
          </div>
          <button aria-label="Close chat" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0"
            style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
          {messages === null ? (
            <Loader c={c} />
          ) : messages.length === 0 ? (
            <div className="font-body text-xs text-center mt-6" style={{ color: c.textFaint }}>
              Arrange your match here — agree a time, share your eFootball ID, anything.
            </div>
          ) : (
            messages.map((m) => {
              const mine = m.sender_id === myId;
              return (
                <div key={m.id} className="max-w-[80%] px-3 py-2 rounded-2xl font-body text-sm break-words"
                  style={mine
                    ? { background: c.accent, color: c.accentText, alignSelf: "flex-end" }
                    : { background: c.surface, color: c.text, alignSelf: "flex-start" }}>
                  {m.body}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t shrink-0" style={{ borderColor: c.border }}>
          <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder="Message…" maxLength={1000}
            className="flex-1 min-w-0 border rounded-full px-4 py-2 font-body text-sm outline-none"
            style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
          <button onClick={send} disabled={!body.trim() || sending} title="Send"
            className="w-9 h-9 flex items-center justify-center rounded-full shrink-0"
            style={body.trim() ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
