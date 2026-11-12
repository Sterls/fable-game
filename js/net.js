// Transport layer. The host is authoritative; clients send actions and receive state.
// Two implementations share one interface:
//   PeerTransport  - WebRTC via PeerJS (works across devices, static hosting friendly)
//   LocalTransport - BroadcastChannel (same browser, multiple tabs; for testing: add ?local=1)
//
// Host API:   createHost(code, { onOpen, onMessage(connId, msg), onLeave(connId), onError })
//             -> { send(connId, msg), broadcast(msg), close() }
// Client API: createClient(code, { onOpen, onMessage(msg), onClose, onError })
//             -> { send(msg), close() }

const PREFIX = 'commonground-v1-';

export function useLocal() {
  return new URLSearchParams(location.search).has('local');
}

/* ---------------- PeerJS ---------------- */

function peerHost(code, h) {
  const conns = new Map();
  let closed = false;
  let attempts = 0;
  let peer;

  function start() {
    peer = new window.Peer(PREFIX + code, { debug: 0 });
    peer.on('open', () => { attempts = 0; h.onOpen && h.onOpen(); });
    peer.on('connection', (conn) => {
      conn.on('open', () => conns.set(conn.connectionId, conn));
      conn.on('data', (msg) => h.onMessage(conn.connectionId, msg));
      const drop = () => {
        if (conns.delete(conn.connectionId)) h.onLeave(conn.connectionId);
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('disconnected', () => {
      // Lost the signaling server only; existing player connections keep working.
      if (!closed) setTimeout(() => { if (!closed && !peer.destroyed) peer.reconnect(); }, 1500);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempts < 8) {
        // Usually our own previous session (page reload) that the server hasn't expired yet.
        attempts++;
        peer.destroy();
        setTimeout(() => !closed && start(), 2500);
        h.onError && h.onError({ type: 'retrying', message: 'Reclaiming room…' });
        return;
      }
      if (err.type === 'peer-unavailable') return;
      h.onError && h.onError(err);
    });
  }
  start();

  return {
    send(id, msg) {
      const c = conns.get(id);
      if (c && c.open) c.send(msg);
    },
    broadcast(msg) {
      for (const c of conns.values()) if (c.open) c.send(msg);
    },
    close() {
      closed = true;
      peer && peer.destroy();
    },
  };
}

function peerClient(code, h) {
  let closed = false;
  const peer = new window.Peer({ debug: 0 });
  let conn = null;
  let opened = false;
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    const timer = setTimeout(() => {
      if (!opened) h.onError && h.onError({ type: 'timeout', message: 'Could not reach that room.' });
    }, 12000);
    conn.on('open', () => { opened = true; clearTimeout(timer); h.onOpen && h.onOpen(); });
    conn.on('data', (msg) => h.onMessage(msg));
    conn.on('close', () => { if (!closed) h.onClose && h.onClose(); });
    conn.on('error', () => { if (!closed) h.onClose && h.onClose(); });
  });
  peer.on('error', (err) => {
    if (closed) return;
    if (err.type === 'peer-unavailable') {
      h.onError && h.onError({ type: 'no-room', message: 'No room with that code is open.' });
    } else if (opened) {
      h.onClose && h.onClose();
    } else {
      h.onError && h.onError(err);
    }
  });
  return {
    send(msg) { if (conn && conn.open) conn.send(msg); },
    close() { closed = true; peer.destroy(); },
  };
}

/* ---------------- BroadcastChannel (local testing) ---------------- */

function localHost(code, h) {
  const ch = new BroadcastChannel(PREFIX + code);
  const seen = new Map(); // connId -> last heard
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
    broadcast(msg) { for (const id of seen.keys()) ch.postMessage({ to: id, type: 'msg', msg }); },
    close() { ch.close(); },
  };
}

function localClient(code, h) {
  const me = 'c' + Math.random().toString(36).slice(2, 10);
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
  return useLocal() ? localHost(code, handlers) : peerHost(code, handlers);
}

export function createClient(code, handlers) {
  return useLocal() ? localClient(code, handlers) : peerClient(code, handlers);
}
