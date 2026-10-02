// Glowveld online rooms — Supabase Realtime *broadcast + presence* only.
// No database tables, no migrations, no cost: rooms are just named channels.
//
// How it works: the human who has been in the room longest is the "host". Their browser runs the game
// (including the bots) and broadcasts small snapshots ~8x per second. Everyone else sends their
// controls to the host and draws what the host sends, predicting their own movement so it feels instant.
// If the host leaves, the next-longest human takes over automatically, using the last snapshot they received.
export const MAX_HUMANS = 4;       // per room — keeps us far below the free tier's 100 messages/second
export const ROOMS = 8;
const WAIT_MS = 3500;

export async function joinRoom(supabase, me, h) {
  for (let i = 1; i <= ROOMS; i++) {
    const r = await tryRoom(supabase, me, h, i);
    if (r) return r;
  }
  return null;
}

function tryRoom(supabase, me, h, n) {
  return new Promise((resolve) => {
    let settled = false, ready = false, hostId = null, known = new Set(), ch = null;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { if (!ready) { try { supabase.removeChannel(ch); } catch { /* */ } finish(null); } }, WAIT_MS + 3000);
    try {
      ch = supabase.channel('glowveld-room-' + n, { config: { presence: { key: String(me.id) }, broadcast: { self: false, ack: false } } });
    } catch { return finish(null); }

    const api = {
      room: n,
      send: (event, payload) => { try { ch.send({ type: 'broadcast', event, payload }); } catch { /* */ } },
      leave: () => { try { supabase.removeChannel(ch); } catch { /* */ } },
      isHost: () => hostId === String(me.id),
    };
    const onSync = () => {
      const st = ch.presenceState(); const ids = Object.keys(st);
      if (!ready) {
        if (ids.length > MAX_HUMANS) { try { supabase.removeChannel(ch); } catch { /* */ } return finish(null); }
        ready = true; finish(api);
      }
      const metas = ids.map((id) => ({ id, ...(st[id][0] || {}) })).sort((a, b) => (a.t - b.t) || (a.id < b.id ? -1 : 1));
      const newHost = metas.length ? String(metas[0].id) : String(me.id);
      const now = new Set(ids);
      const joined = metas.filter((m) => !known.has(m.id)), left = [...known].filter((id) => !now.has(id));
      known = now;
      if (newHost !== hostId) { hostId = newHost; h.onHost && h.onHost(hostId === String(me.id), hostId); }
      joined.forEach((m) => h.onJoin && h.onJoin({ id: m.id, name: m.name, color: m.color, hat: m.hat }));
      left.forEach((id) => h.onLeave && h.onLeave(id));
      h.onCount && h.onCount(ids.length);
    };
    ch.on('presence', { event: 'sync' }, onSync);
    ch.on('broadcast', { event: 'snap' }, ({ payload }) => h.onSnap && h.onSnap(payload));
    ch.on('broadcast', { event: 'inp' }, ({ payload }) => h.onInput && h.onInput(payload));
    ch.on('broadcast', { event: 'ros' }, ({ payload }) => h.onRoster && h.onRoster(payload));
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try { await ch.track({ name: me.name, color: me.color, hat: me.hat, t: Date.now() }); } catch { finish(null); }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (!ready) finish(null); else h.onDisconnect && h.onDisconnect();
      } else if (status === 'CLOSED' && ready) {
        h.onDisconnect && h.onDisconnect();
      }
    });
  });
}
