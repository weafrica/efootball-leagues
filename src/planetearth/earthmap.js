// Planet Earth — a small hand-made world map ([longitude, latitude] outlines) and a globe renderer. No image files:
// the continents are just numbers, drawn with canvas code. (Simplified outlines, good enough to find your way around!)
import { CITIES } from './sky.js';
export const LAND = {
  africa: [[-17,21],[-13,27],[-9,32],[-5.5,35.8],[3,37],[10,37],[11,33],[20,31],[25,32],[32,31],[34,28],[38,21],[43,12],[51,12],[48,5],[41,-2],[39,-8],[40,-15],[35,-20],[35,-24],[32,-29],[28,-33],[20,-35],[18,-32],[14,-23],[12,-17],[13,-10],[9,-1],[9,4],[4,6],[-4,5],[-8,4.5],[-13,8],[-17,14.7]],
  samerica: [[-77,8],[-72,12],[-62,10.5],[-52,5],[-50,0],[-44,-2.5],[-35,-5.5],[-38,-13],[-41,-22],[-48,-26],[-53,-34],[-58,-38],[-65,-41],[-65,-47],[-69,-51],[-68,-55],[-72,-53],[-75,-47],[-73,-40],[-71,-30],[-70,-18],[-76,-14],[-81,-6],[-80,-1],[-78,3]],
  namerica: [[-168,66],[-160,70],[-141,70],[-128,70],[-115,68],[-95,72],[-85,70],[-80,63],[-94,58],[-92,57],[-80,52],[-78,60],[-66,60],[-60,55],[-56,52],[-66,45],[-70,42],[-76,35],[-81,31],[-80,25.5],[-83,29],[-90,29],[-97,27],[-97,22],[-96,19],[-91,18.5],[-87,21],[-88,16],[-84,15.5],[-83,10],[-78,9],[-80,7.5],[-86,11],[-92,14.5],[-97,16],[-105,20],[-109,26],[-114,31],[-117,32.5],[-121,35],[-124,40],[-124,47],[-130,54],[-137,59],[-148,60],[-158,57],[-165,55],[-160,59],[-165,62]],
  eurasia: [[-9,37],[-9,43],[-2,43.5],[-1.5,46],[-4.5,48.5],[-1.5,49.7],[2,51],[4,52],[5,53.5],[8,54],[8.5,57],[10.5,57.5],[10.5,54.5],[14,54.2],[19,54.4],[21,57],[24,57.5],[24.5,59.4],[29,60],[22,60],[21,63],[25,65.5],[22,65.8],[17.5,62.5],[17,60.5],[19,59.5],[16,56.5],[12.5,56],[11,59],[7,58],[5,60],[6,62.5],[12,66],[16,69],[22,70.5],[29,71],[33,69.5],[41,67],[35,65.5],[40,64.5],[44,66],[53,68.5],[60,69],[68,68.5],[70,73],[80,73.5],[88,75.5],[100,77],[112,75],[128,72],[140,72.5],[150,71],[160,69.5],[170,70],[180,68.5],[180,65],[170,64.5],[163,60],[160,54],[156,51],[155,56],[150,59.5],[142,59],[138,54],[141,52.5],[140,48],[135,43.5],[131,42.5],[129,40],[128,35],[126,34.5],[126,37.5],[125,39.5],[121.5,39],[122,40.8],[118,39],[119,37],[122.5,37],[120.5,36],[119.5,34],[122,31.5],[121.5,28],[119,25],[114,22.2],[110,21],[108,21.5],[106,19],[109,15],[109,12],[105,8.8],[103,10.5],[100,13.5],[100,9],[103,5],[104,1.5],[101,2.8],[98,8],[98,16],[94.5,16],[94,19],[91,22.5],[87,21.5],[84,19],[80,15.5],[80,10],[77.5,8],[76,10.5],[73,17.5],[72.5,21],[70,21],[67,24.5],[62,25],[57,25.8],[56.5,27],[51,28],[48.5,30],[50,26.5],[51.5,24.5],[56,26],[57,23.5],[59.5,22.5],[56,17.5],[52,16],[45,12.8],[43,12.7],[42.5,16],[39,21.5],[35,28],[34.5,31],[35,33],[36,36.5],[32,36.2],[28,36.8],[26.5,39.5],[26,40.3],[29,41],[31,41.2],[36,41.7],[41,41],[41.5,42.5],[37.5,45],[38,47],[35,46.5],[33.5,44.5],[30.5,46.5],[29.5,45.2],[28.5,43],[28,41.8],[26.5,40.9],[24,40.9],[23,40],[24,38],[22,36.5],[21,38.5],[19.5,41.5],[13.5,45.5],[12.3,45],[16,41.5],[18.5,40],[16,38],[15.7,38],[12,41.5],[10,44],[7,43.5],[3,43],[3,42],[0,39],[-0.5,38],[-2,36.7],[-5.5,36]],
  australia: [[114,-22],[113.5,-26],[115,-34],[118,-35],[123,-34],[129,-31.5],[135,-35],[138,-35],[140,-38],[146,-39],[150,-37],[153,-31],[153,-25],[149,-20],[146,-19],[145,-15],[142.5,-10.5],[141,-17],[136,-15],[137,-12],[132,-11.5],[129,-15],[126,-14],[122,-17],[118,-20.5]],
  greenland: [[-73,78],[-60,82],[-30,83.5],[-18,80],[-20,70],[-25,68],[-40,65],[-44,60],[-50,62],[-54,67],[-58,75]],
  uk: [[-5,50],[1.5,51],[1.7,53],[-0.5,54.5],[-2,57.5],[-3,58.6],[-5.5,58.5],[-6,56],[-5,55],[-3,54.5],[-4.5,53.5],[-3,51.5]],
  ireland: [[-10,52],[-6,52],[-6,55],[-8,55],[-10,54]],
  japan: [[130,31],[132,34],[135,34],[140,35],[141,38],[142,40],[141.5,42],[140,41],[139.5,38],[136.5,36.5],[133,35.5],[130,33.5]],
  madagascar: [[44,-25],[47,-25],[50,-15],[49,-12],[44,-16]],
  sumatra: [[95,5.5],[98,4],[104,-1],[106,-5.5],[102,-4],[96,2]],
  borneo: [[109,1],[111,-3],[116,-4],[118,1],[117,7],[113,3]],
  java: [[105.5,-6.3],[109,-6.7],[114.5,-7.7],[114,-8.7],[106,-7.8]],
  newguinea: [[131,-1],[141,-2.5],[148,-6],[150,-10],[142,-9],[138,-8],[135,-4]],
  nzn: [[172.7,-34.5],[178.5,-37.5],[175,-41.5],[174.5,-39]],
  nzs: [[172.5,-40.5],[174.3,-41.8],[171,-45],[166.5,-46],[168,-44.5]],
  antarctica: [[-180,-72],[-120,-74],[-60,-68],[-30,-72],[0,-70],[60,-67],[120,-66],[180,-72],[180,-90],[-180,-90]],
};
const ICY = new Set(['greenland', 'antarctica']);
function densify(poly, step = 4) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
const DENSE = Object.fromEntries(Object.entries(LAND).map(([k, v]) => [k, densify(v)]));
const RAD = Math.PI / 180;
// Orthographic projection: (lon,lat) seen from above (lon0,lat0). x right, y up, z toward the viewer (visible if z > 0).
export function project(lon, lat, lon0, lat0) {
  const p = lat * RAD, dl = (lon - lon0) * RAD, p0 = lat0 * RAD, cp = Math.cos(p), cd = Math.cos(dl);
  return { x: cp * Math.sin(dl), y: Math.cos(p0) * Math.sin(p) - Math.sin(p0) * cp * cd, z: Math.sin(p0) * Math.sin(p) + Math.cos(p0) * cp * cd };
}
// Which city is under which pixel etc. is up to the caller; this finds a city's screen position on a drawn globe.
export function cityScreen(c, cx, cy, R, lon0, lat0) { const q = project(c.lon, c.lat, lon0, lat0); return { x: cx + q.x * R, y: cy - q.y * R, visible: q.z > 0.02, z: q.z }; }

// ---- night shadow, painted per pixel once per sun position and cached ----
const nightCache = [];
function nightLayer(R, sv) {
  const key = R + '|' + sv.x.toFixed(3) + '|' + sv.y.toFixed(3) + '|' + sv.z.toFixed(3);
  const hit = nightCache.find((e) => e.key === key); if (hit) return hit.canvas;
  const n = Math.ceil(R * 2) + 2, cv = document.createElement('canvas'); cv.width = n; cv.height = n;
  const g = cv.getContext('2d'), img = g.createImageData(n, n), d = img.data, c = n / 2;
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    const nx = (px + 0.5 - c) / R, ny = -(py + 0.5 - c) / R, r2 = nx * nx + ny * ny; if (r2 > 1) continue;
    const light = nx * sv.x + ny * sv.y + Math.sqrt(1 - r2) * sv.z;
    let t = (light + 0.1) / 0.22; t = t < 0 ? 0 : t > 1 ? 1 : t; const night = 1 - t * t * (3 - 2 * t), i = (py * n + px) * 4;
    d[i] = 8; d[i + 1] = 12; d[i + 2] = 48; d[i + 3] = Math.round(night * 175);
  }
  g.putImageData(img, 0, 0); nightCache.push({ key, canvas: cv }); if (nightCache.length > 3) nightCache.shift(); return cv;
}
// Draw the planet. opts: { sun: {lon,lat} | null, cities: [...] | false, labels: bool, grid: bool }
export function drawGlobe(ctx, cx, cy, R, lon0, lat0, opts = {}) {
  const halo = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.25); halo.addColorStop(0, 'rgba(120,180,255,0.45)'); halo.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, 6.3); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.clip();
  const sea = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R); sea.addColorStop(0, '#3a86e8'); sea.addColorStop(1, '#14378a');
  ctx.fillStyle = sea; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  if (opts.grid !== false) {
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
    for (let la = -60; la <= 60; la += 30) { ctx.beginPath(); let pen = false; for (let lo = -180; lo <= 180; lo += 6) { const q = project(lo, la, lon0, lat0); if (q.z > 0) { const X = cx + q.x * R, Y = cy - q.y * R; pen ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); pen = true; } else pen = false; } ctx.stroke(); }
    for (let lo = -180; lo < 180; lo += 30) { ctx.beginPath(); let pen = false; for (let la = -90; la <= 90; la += 6) { const q = project(lo, la, lon0, lat0); if (q.z > 0) { const X = cx + q.x * R, Y = cy - q.y * R; pen ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); pen = true; } else pen = false; } ctx.stroke(); }
  }
  for (const [name, pts] of Object.entries(DENSE)) {
    ctx.beginPath();
    pts.forEach(([lo, la], i) => { const q = project(lo, la, lon0, lat0); let x = q.x, y = q.y; if (q.z < 0) { const m = Math.hypot(x, y) || 1; x /= m; y /= m; } const X = cx + x * R, Y = cy - y * R; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.closePath(); ctx.fillStyle = ICY.has(name) ? '#eef5ff' : '#5cba6a'; ctx.fill(); ctx.strokeStyle = 'rgba(15,70,40,0.55)'; ctx.lineWidth = 1; ctx.stroke();
  }
  if (opts.sun) { const sv = project(opts.sun.lon, opts.sun.lat, lon0, lat0); ctx.drawImage(nightLayer(Math.round(R), sv), cx - Math.round(R) - 1, cy - Math.round(R) - 1); }
  ctx.restore();
  ctx.strokeStyle = 'rgba(190,225,255,0.55)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.stroke();
  if (opts.cities) for (const c of opts.cities) {
    const s = cityScreen(c, cx, cy, R, lon0, lat0); if (!s.visible) continue;
    const sel = opts.selected === c.id; ctx.fillStyle = sel ? '#ffe27a' : '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, sel ? 6 : 4.5, 0, 6.3); ctx.stroke(); ctx.fill();
    if (opts.labels) { ctx.font = 'bold 11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.fillStyle = '#fff'; ctx.strokeText(c.name, s.x, s.y - 9); ctx.fillText(c.name, s.x, s.y - 9); }
  }
}
export { CITIES };
