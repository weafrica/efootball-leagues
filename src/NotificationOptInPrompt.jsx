// The explanatory card shown BEFORE we ever trigger the real browser
// permission prompt — see notificationOptIn.js's header comment for why.
// Rendered once, near the app's other top-level modals, driven by a
// `reason` key (or null to render nothing).

import React, { useState } from "react";
import { Bell, X, ChevronDown } from "lucide-react";
import { REASONS, NOTIFICATION_DETAILS, getNotificationPermissionState } from "./utils/notificationOptIn";

export default function NotificationOptInPrompt({ reason, onEnable, onDismiss, c }) {
  const [showDetails, setShowDetails] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [blockedNote, setBlockedNote] = useState(false);

  if (!reason) return null;
  const copy = REASONS[reason] || REASONS.generic;

  const handleEnable = async () => {
    if (enabling) return;
    setEnabling(true);
    await onEnable();
    setEnabling(false);
    // If the browser itself came back "denied" (person dismissed the native
    // dialog rather than allowing it), there's nothing left our own UI can
    // do to re-trigger it — only their own browser/phone settings can now.
    // Say so plainly instead of silently closing as if nothing happened.
    if (getNotificationPermissionState() === "denied") {
      setBlockedNote(true);
      return;
    }
    onDismiss();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onDismiss}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: c.accent + "22" }}>
              <Bell size={18} style={{ color: c.accent }} />
            </div>
            <h2 className="text-lg font-extrabold tracking-tight">{copy.headline}</h2>
          </div>
          <button aria-label="Not now" onClick={onDismiss} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>

        {blockedNote ? (
          <div className="font-body text-sm" style={{ color: c.textDim }}>
            Looks like notifications are blocked for this site. You can turn
            them back on from your browser or phone's site settings for this
            app, then come back — we'll pick it up automatically.
            <button type="button" onClick={onDismiss}
              className="mt-4 w-full font-body text-sm font-semibold px-4 py-2.5 rounded-full"
              style={{ background: c.surface, color: c.text }}>
              Got it
            </button>
          </div>
        ) : (
          <>
            <p className="font-body text-sm mb-3" style={{ color: c.textDim }}>{copy.body}</p>

            <ul className="space-y-1.5 mb-3">
              {copy.benefits.map((b) => (
                <li key={b} className="font-body text-sm flex items-start gap-2" style={{ color: c.text }}>
                  <span className="mt-1.5 w-1 h-1 rounded-full shrink-0" style={{ background: c.accent }} />
                  {b}
                </li>
              ))}
            </ul>

            <button type="button" onClick={() => setShowDetails((v) => !v)}
              className="w-full flex items-center justify-between font-body text-xs font-semibold uppercase tracking-wide py-1.5 mb-2"
              style={{ color: c.textFaint }}>
              Why enable notifications?
              <ChevronDown size={14} style={{ transform: showDetails ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            </button>
            {showDetails && (
              <p className="font-body text-xs mb-3" style={{ color: c.textFaint }}>{NOTIFICATION_DETAILS}</p>
            )}

            <div className="flex items-center gap-2 mt-2">
              <button type="button" onClick={onDismiss}
                className="flex-1 font-body text-sm font-semibold px-4 py-2.5 rounded-full"
                style={{ background: c.surface, color: c.textDim }}>
                Not now
              </button>
              <button type="button" onClick={handleEnable} disabled={enabling}
                className="flex-1 inline-flex items-center justify-center gap-1.5 font-body text-sm font-semibold px-4 py-2.5 rounded-full disabled:opacity-60"
                style={{ background: c.accent, color: c.accentText }}>
                <Bell size={14} /> {enabling ? "Turning on…" : "Turn on"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
