// Transport layer. The host is authoritative; clients send actions and receive state.
// Two implementations share one interface:
//   Realtime - Supabase Realtime broadcast channels. Every device makes an ordinary
//              outbound WebSocket to Supabase, so it works on any Wi-Fi or cellular network.
//   Local    - BroadcastChannel (same browser, multiple tabs; for testing: add ?local=1)
//
// Host API:   createHost(code, { onOpen, onMessage(connId, msg), onLeave(connId), onError })
//             -> { send(connId, msg), close() }
// Client API: createClient(code, { onOpen, onMessage(msg), onClose, onError })
//             -> { send(msg), close() }
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const PREFIX = 'commonground-v2-';

export function useLocal() {
  return new URLSearchParams(location.search).has('local');
}

const rid = () => 'c' + Math.random().toString(36).slice(2, 12);

/* ---------------- Supabase Realtime ---------------- */

let sbClient = null;
function sb() {
  if (!sbClient) {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return sbClient;
}

function rtChannel(code, presenceKey) {
  return sb().channel(PREFIX + code, {
    config: { broadcast: { self: false, ack: false }, presence: { key: presenceKey } },
  });
}

function rtHost(code, h) {
  const ch = rtChannel(code, 'host');
  const conns = new Set();
  let closed = false;
  const out = (payload) => ch.send({ type: 'broadcast', event: 'h2c', payload });

  ch.on('broadcast', { event: 'c2h' }, ({ payload }) => {
    if (closed || !payload || typeof payload.from !== 'string') return;
    const { from, type } = payload;
    if (type === 'hello') {
      conns.add(from);
      out({ to: from, type: 'welcome' });
      h.onMessage(from, payload.msg);
      return;
    }
    if (type === 'bye') {
      if (conns.delete(from)) h.onLeave(from);
      return;
    }
    if (conns.has(from)) h.onMessage(from, payload.msg);
  });
  ch.on('presence', { event: 'leave' }, ({ key }) => {
    if (!closed && conns.delete(key)) h.onLeave(key);
  });
  ch.subscribe((status) => {
    if (closed) return;
    if (status === 'SUBSCRIBED') {
      ch.track({ role: 'host' });
      // Tell anyone already in the channel (e.g. after a host reload) to say hello again.
      out({ to: '*', type: 'host-up' });
      h.onOpen && h.onOpen();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      h.onError && h.onError({ type: 'retrying', message: 'Reconnecting…' });
    }
  });

  return {
    send(id, msg) { if (!closed) out({ to: id, type: 'msg', msg }); },
    close() { closed = true; sb().removeChannel(ch); },
  };
}

function rtClient(code, h) {
  const me = rid();
  const ch = rtChannel(code, me);
  let opened = false;
  let closed = false;
  let hello = null;
  let helloTimer = null;
  const out = (type, msg) => ch.send({ type: 'broadcast', event: 'c2h', payload: { from: me, type, msg } });
  const giveUp = setTimeout(() => {
    if (!opened && !closed) h.onError && h.onError({ type: 'no-room', message: `Couldn’t find room ${code}. Check the code, and make sure the host still has the game open.` });
  }, 10000);

  ch.on('broadcast', { event: 'h2c' }, ({ payload }) => {
    if (closed || !payload) return;
    if (payload.type === 'host-up') { if (hello) out('hello', hello); return; }
    if (payload.to !== me) return;
    if (payload.type === 'welcome') {
      if (!opened) { opened = true; clearTimeout(giveUp); clearInterval(helloTimer); h.onOpen && h.onOpen(); }
      return;
    }
    if (payload.type === 'msg') h.onMessage(payload.msg);
  });
  ch.on('presence', { event: 'leave' }, ({ key }) => {
    // Host's connection dropped. The app retries until the host is back.
    if (key === 'host' && opened && !closed && !(ch.presenceState().host || []).length) h.onClose && h.onClose();
  });
  ch.subscribe((status) => {
    if (closed) return;
    if (status === 'SUBSCRIBED') {
      ch.track({ role: 'player' });
      if (hello) out('hello', hello);
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      if (opened) h.onClose && h.onClose();
    }
  });

  return {
    // The first message is the app's hello; resend it until the host welcomes us.
    send(msg) {
      if (closed) return;
      if (!hello && msg && msg.t === 'hello') {
        hello = msg;
        out('hello', hello);
        helloTimer = setInterval(() => !opened && out('hello', hello), 2500);
        return;
      }
      out('msg', msg);
    },
    close() {
      if (closed) return;
      try { out('bye'); } catch {}
      closed = true;
      clearTimeout(giveUp);
      clearInterval(helloTimer);
      setTimeout(() => sb().removeChannel(ch), 100);
    },
    // The app sends hello from onOpen; Realtime needs it before we're "open", so we open early.
    wantsHelloFirst: true,
  };
}

/* ---------------- BroadcastChannel (local testing) ---------------- */

function localHost(code, h) {
  const ch = new BroadcastChannel(PREFIX + code);
  const seen = new Map();
  ch.onmessage = ({ data }) => {
    if (data.to !== 'host') return;
    if (data.type === 'bye') { if (seen.delete(data.from)) h.onLeave(data.from); return; }
    if (data.type === 'hello') {
      seen.set(data.from, Date.now());
      ch.postMessage({ to: data.from, type: 'welcome' });
      return;
    }
    seen.set(data.from, Date.now());
    h.onMessage(data.from, data.msg);
  };
  setTimeout(() => h.onOpen && h.onOpen(), 0);
  return {
    send(id, msg) { ch.postMessage({ to: id, type: 'msg', msg }); },
    close() { ch.close(); },
  };
}

function localClient(code, h) {
  const me = rid();
  const ch = new BroadcastChannel(PREFIX + code);
  let opened = false;
  ch.onmessage = ({ data }) => {
    if (data.to !== me) return;
    if (data.type === 'welcome') { if (!opened) { opened = true; h.onOpen && h.onOpen(); } return; }
    h.onMessage(data.msg);
  };
  ch.postMessage({ to: 'host', from: me, type: 'hello' });
  setTimeout(() => {
    if (!opened) h.onError && h.onError({ type: 'no-room', message: 'No room with that code is open.' });
  }, 1500);
  const bye = () => ch.postMessage({ to: 'host', from: me, type: 'bye' });
  addEventListener('pagehide', bye);
  return {
    send(msg) { ch.postMessage({ to: 'host', from: me, type: 'msg', msg }); },
    close() { bye(); removeEventListener('pagehide', bye); ch.close(); },
  };
}

export function createHost(code, handlers) {
  return useLocal() ? localHost(code, handlers) : rtHost(code, handlers);
}

export function createClient(code, handlers) {
  return useLocal() ? localClient(code, handlers) : rtClient(code, handlers);
}
