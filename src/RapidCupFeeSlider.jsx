import React from "react";

// Entry-fee slider — 0–400 Nets, per Section 3 of the build plan, further
// capped by `max` (the caller passes 20% of the player's Nets balance,
// floored at 400) — the join_rapid_cup_lobby/raise_rapid_cup_entry_fee RPCs
// enforce this same 20%-of-balance cap server-side regardless, but letting
// the slider itself stop at the real max (instead of 400 every time) means
// a player doesn't drag to a value the server is just going to reject.
// Lives in its own file (not RapidCupBanner.jsx or RapidCupFeeDisplay.jsx)
// so those two files don't have to import from each other to both use it.
export function EntryFeeSlider({ value, onChange, min = 0, max = 400, disabled }) {
  return (
    <div>
      <label style={{ fontSize: 13, opacity: 0.8 }}>Entry fee: {value} Nets</label>
      <input
        type="range"
        min={min}
        max={max}
        step={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}
