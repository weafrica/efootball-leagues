// Planet Earth — a real (simple) climate model: energy in = energy out, with a "grey" greenhouse layer and ice-albedo feedback.
// Numbers: solar constant 1361 W/m², today's reflectivity 0.30, Stefan–Boltzmann law. Pure JS (no DOM).
export const S = 1361, SIGMA = 5.670374e-8, BASE_PPM = 280;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Greenhouse "thickness" (optical depth) as a function of CO₂-equivalent ppm: 0.836 at 280 ppm, +0.0904 per doubling (≈ +3 °C per doubling).
export const tau = (ppm) => (ppm <= 0 ? 0 : 0.836 + 0.0904 * Math.log2(Math.max(ppm, 10) / BASE_PPM));
// Temperature (kelvin) an Earth with this much greenhouse gas and reflectivity settles at.
export function eqTemp(ppm, albedo) { const te4 = (S * (1 - albedo)) / 4 / SIGMA; return Math.pow(te4 * (1 + 0.75 * tau(ppm)), 0.25); }
export const noAtmosphereTemp = (albedo = 0.3) => Math.pow((S * (1 - albedo)) / 4 / SIGMA, 0.25);
// Ice reflects sunlight: below 0 °C more of the planet turns white, which makes it colder still.
export const effAlbedo = (base, T) => { const ice = clamp((273.15 - T) / 25, 0, 1); return Math.min(0.85, base + 0.35 * ice * (1 - base)); };
export const toC = (K) => K - 273.15;
export function createClimate() { const c = { ppm: 280, base: 0.3, T: 0, years: 0 }; c.T = eqTemp(c.ppm, c.base); return c; }
export const target = (c) => eqTemp(c.ppm, effAlbedo(c.base, c.T));
export function stepClimate(c, dtYears) { c.T += (target(c) - c.T) * Math.min(1, dtYears / 6); c.years += dtYears; }   // the oceans take ~6 years to catch up
export const isStable = (c) => Math.abs(target(c) - c.T) < 0.25;
export const warmingVsBase = (c) => c.T - eqTemp(BASE_PPM, c.base);
