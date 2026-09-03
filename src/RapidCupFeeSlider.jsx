import React from "react";

// Entry-fee slider — 0–400 Nets, per Section 3 of the build plan. Lives in
// its own file (not RapidCupBanner.jsx or RapidCupFeeDisplay.jsx) so those
// two files don't have to import from each other to both use it.
export function EntryFeeSlider({ value, onChange, min = 0, disabled }) {
  return (
    <div>
      <label style={{ fontSize: 13, opacity: 0.8 }}>Entry fee: {value} Nets</label>
      <input
        type="range"
        min={min}
        max={400}
        step={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}
