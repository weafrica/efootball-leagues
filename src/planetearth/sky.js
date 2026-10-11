// Planet Earth — real astronomy formulas (pure functions, no DOM). Used by the Day & Night and Seasons levels.
export const TILT = 23.44;                 // Earth's axial tilt in degrees
const R = Math.PI / 180, D = 180 / Math.PI;
export const norm360 = (a) => ((a % 360) + 360) % 360;
export const norm180 = (a) => norm360(a + 180) - 180;

// Real cities: latitude, longitude, standard time-zone offset from UTC (no daylight saving).
export const CITIES = [
  { id: 'jhb', name: 'Johannesburg', lat: -26.2, lon: 28.05, tz: 2 },
  { id: 'cpt', name: 'Cape Town', lat: -33.9, lon: 18.4, tz: 2 },
  { id: 'cai', name: 'Cairo', lat: 30.0, lon: 31.2, tz: 2 },
  { id: 'lon', name: 'London', lat: 51.5, lon: -0.1, tz: 0 },
  { id: 'nyc', name: 'New York', lat: 40.7, lon: -74.0, tz: -5 },
  { id: 'rio', name: 'Rio', lat: -22.9, lon: -43.2, tz: -3 },
  { id: 'bom', name: 'Mumbai', lat: 19.1, lon: 72.9, tz: 5.5 },
  { id: 'tyo', name: 'Tokyo', lat: 35.7, lon: 139.7, tz: 9 },
  { id: 'syd', name: 'Sydney', lat: -33.9, lon: 151.2, tz: 10 },
  { id: 'tos', name: 'Tromsø', lat: 69.7, lon: 19.0, tz: 1 },
];
export const city = (id) => CITIES.find((c) => c.id === id);

// Sun's declination (how far north/south of the equator the Sun is overhead) for day-of-year 0..364 (0 = 1 Jan).
export function declination(day, tilt = TILT) {
  const lam = (2 * Math.PI * (day - 79)) / 365.25;          // 0 at the March equinox
  return D * Math.asin(Math.sin(tilt * R) * Math.sin(lam));
}
// Hours of daylight at a latitude for a given declination (0 = polar night, 24 = midnight sun).
export function dayLength(lat, dec) {
  const x = -Math.tan(lat * R) * Math.tan(dec * R);
  if (x >= 1) return 0; if (x <= -1) return 24;
  return (24 / Math.PI) * Math.acos(x);
}
// Sun height above the horizon (degrees) at a latitude, for declination and hour angle H (0 = solar noon).
export function sunElevation(lat, dec, H) {
  const s = Math.sin(lat * R) * Math.sin(dec * R) + Math.cos(lat * R) * Math.cos(dec * R) * Math.cos(H * R);
  return D * Math.asin(Math.max(-1, Math.min(1, s)));
}
export const subsolarLon = (utc) => norm180(-(utc - 12) * 15);          // longitude where the Sun is straight overhead
export const hourAngle = (lon, utc) => norm180(lon - subsolarLon(utc)); // degrees east of the sub-solar point
export const elevationAt = (c, utc, dec) => sunElevation(c.lat, dec, hourAngle(c.lon, utc));
export const solarTime = (c, utc) => (((utc + c.lon / 15) % 24) + 24) % 24;   // "sun time": 12 = Sun highest
export const clockTime = (c, utc) => (((utc + c.tz) % 24) + 24) % 24;         // what the clock on the wall says
export const isMorning = (c, utc) => hourAngle(c.lon, utc) < 0;
export function fmtTime(h) { const t = ((h % 24) + 24) % 24, hh = Math.floor(t), mm = Math.floor((t - hh) * 60 + 1e-6); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], ML = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function fmtDay(day) { let d = Math.floor(((day % 365) + 365) % 365); for (let m = 0; m < 12; m++) { if (d < ML[m]) return d + 1 + ' ' + MONTHS[m]; d -= ML[m]; } return '31 Dec'; }
// Where Earth is on its orbit: angle from the Sun, in radians (0 = the March-equinox position).
export const orbitAngle = (day) => (2 * Math.PI * (day - 79)) / 365.25 + Math.PI;
