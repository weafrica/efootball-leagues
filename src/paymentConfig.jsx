// Shared payment constants — pulled out of App.jsx so anything that needs
// them (PaymentModal for cash leagues, BuyNetsModal for Nets top-ups)
// doesn't have to import App.jsx itself to get them. That matters because
// NetsBadge is mounted directly in the header (always in the initial
// bundle) while TransferMarket/BuyNetsModal (Buy Nets only lives in The
// Kit Room now) are lazy-loaded specifically to keep that initial bundle
// small — if they pulled their payment details from App.jsx, that import
// would drag App.jsx's ~700KB source back into the "lazy" chunk and
// defeat the point of lazy-loading it.

import React from "react";

// Cash league entry fees: members choose their own amount in this range when they join.
export const ENTRY_FEE_MIN = 10;
export const ENTRY_FEE_MAX = 200;
export const ENTRY_FEE_STEP = 10;
export const ENTRY_FEE_PRESETS = [10, 20, 50, 100, 150, 200];
export const formatRand = (n) => `R${Number(n).toLocaleString("en-ZA")}`;
export const clampFee = (n) => Math.min(ENTRY_FEE_MAX, Math.max(ENTRY_FEE_MIN, Math.round(Number(n) || 0)));

// "Cards accepted" indicator for the card payment option — renders the
// Mastercard/Visa logo image the site owner supplies at
// /public/card-brands.png (drop the real file in yourself; nothing here
// reproduces the artwork).
export function CardBrandsBadge() {
  return <img src="/card-brands.png" alt="Mastercard, Visa" className="h-5 w-auto object-contain" />;
}

// WeAfrica's payment details, shown wherever someone is about to pay
// real money in — a cash league entry fee, or a Nets top-up.
export const BANK_DETAILS = {
  bank: "Capitec Business",
  accountName: "We Africa",
  accountNumber: "1054081743",
  accountType: "Transact",
};

export const MUKURU_DETAILS = {
  receiverName: "Saul",
  receiverPhone: "+27694362789",
};

// iKhokha Pay-by-Link — a hosted checkout page someone can pay into with a
// card, no bank app or reference number needed.
// TODO: replace payLink with your real iKhokha Pay-by-Link URL if this
// ever needs to fall back to a static link instead of the create-*-payment
// edge functions.
export const IKHOKHA_DETAILS = {
  payLink: "https://pay.ikhokha.com/weafrica/mpr/weafrica",
};
