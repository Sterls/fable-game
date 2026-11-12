import { createHost, createClient, useLocal } from './net.js';
import { newGame, reduce, viewFor, tick, setConnected, cleanName, results, artFor, recapArt, MAX_PLAYERS } from './game.js';
import { PALETTE, encode, attachPad, paint, paintAll } from './sketch.js';
import { crewEnabled, createCrew, checkCrew, submitGame, getLeaderboard, cleanSlug } from './crew.js';
import { boardScreen } from './board.js';

const $app = document.getElementById('app');
const $bar = document.getElementById('bar-right');
const $toast = document.getElementById('toast');

/* ---------------- storage ---------------- */

const store = {
  get(k, d = null) { try { const v = localStorage.getItem('cg-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cg-' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('cg-' + k); } catch {} },
};

// In ?local test mode every tab is its own player, so keep the id per-tab.
const idStore = useLocal() ? sessionStorage : localStorage;
let myId = idStore.getItem('cg-pid');
if (!myId) { myId = 'p' + Math.random().toString(36).slice(2, 12); try { idStore.setItem('cg-pid', myId); } catch {} }

/* ---------------- session ---------------- */

// role: null | 'host' | 'client'
let S = { role: null, code: null, view: null, net: null, state: null, conns: new Map(), status: 'ok', joinErr: '' };
const ui = {
  draft: '', editing: false, selected: null, deadlineAt: 0, showHelp: false, showCustom: false,
  crewForm: null, crewBusy: false, crewErr: '',
  board: null, // { slug, data, loading, err, sort, open }
  pad: { strokes: [], color: 0, width: 0 }, // my drawing for the current sketch round
  arts: {}, // round -> { pid: drawing }, received from the host after each sketch reveal
  recapOpen: new Set(), // rounds expanded in the end-of-game recap
};

// key is a player id (current round) or "r<round>:<player id>" (recap).
function getArt(key) {
  const m = /^r(\d+):(.+)$/.exec(key);
  const round = m ? Number(m[1]) : S.view && S.view.round;
  const pid = m ? m[2] : key;
  if (!m && pid === myId && ui.pad.strokes.length && S.view && S.view.phase === 'answer') return encode(ui.pad.strokes);
  if (S.role === 'host' && S.state) return (m ? (S.state.historyArt || {})[round] || {} : S.state.art)[pid] || '';
  return (ui.arts[round] || {})[pid] || '';
}

const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
function newCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return c;
}

function hostRoom(name, resume) {
  const state = resume || newGame(newCode(), myId, name);
  if (resume) {
    for (const p of state.players) p.connected = p.id === myId;
    if (state.save === 'saving') state.save = 'error';
    state.settings.modes ||= { words: true, sketch: true, pick: true, rather: true }; // rooms saved by older versions
    state.prompts ||= {};
    if (state.settings.custom) {
      const old = state.settings.custom.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20);
      state.prompts[state.hostId] = (state.prompts[state.hostId] || []).concat(old).slice(0, 20);
      state.settings.custom = '';
    }
    state.art ||= {};
    state.gallery ||= [];
  } else {
    const crew = store.get('crew');
    if (crewEnabled() && crew && crew.slug) state.crew = { slug: crew.slug, name: crew.name };
  }
  S = { role: 'host', code: state.code, view: null, state, conns: new Map(), status: 'connecting', joinErr: '' };
  S.net = createHost(state.code, {
    onOpen() { S.status = 'ok'; render(); },
    onMessage(connId, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        const pid = String(msg.id || '').slice(0, 20);
        if (!pid || pid === myId) return;
        const r = reduce(S.state, pid, { t: 'join', name: msg.name, takeover: !!msg.takeover });
        if (!r) return S.net.send(connId, { t: 'full' });
        if (r.taken) return S.net.send(connId, { t: 'taken', name: cleanName(msg.name) });
        if (r.replaced) {
          // Their old device is still attached: send it home.
          for (const [c, p] of S.conns) if (p === r.replaced) { S.net.send(c, { t: 'replaced' }); S.conns.delete(c); }
        }
        S.conns.set(connId, pid);
        sync();
        const art = artFor(S.state);
        if (art) S.net.send(connId, { t: 'art', ...art });
        for (const a of recapArt(S.state)) S.net.send(connId, { t: 'art', ...a }); // late/reloaded players at the end
        return;
      }
      const pid = S.conns.get(connId);
      if (!pid) return;
      if (reduce(S.state, pid, msg)) sync();
    },
    onLeave(connId) {
      const pid = S.conns.get(connId);
      S.conns.delete(connId);
      if (pid && ![...S.conns.values()].includes(pid) && setConnected(S.state, pid, false)) sync();
    },
    onError(err) {
      if (err.type === 'retrying') { S.status = 'connecting'; render(); return; }
      S.status = 'error';
      toast(err.message || 'Connection problem. Players may not be able to join.');
      render();
    },
  });
  sync();
}

function sync() {
  const s = S.state;
  s.updated = Date.now();
  store.set('host', s);
  // Drawings go out once per sketch round, to everyone at the same time.
  const art = artFor(s);
  const artKey = art && `${s.gameId}:${s.round}`;
  if (art && S.artSent !== artKey) {
    S.artSent = artKey;
    if (S.net.broadcast) S.net.broadcast({ t: 'art', ...art });
  }
  for (const [connId, pid] of S.conns) S.net.send(connId, { t: 'view', v: viewFor(s, pid) });
  receive(viewFor(s, myId));
  if (s.phase === 'final' && s.crew && !s.save) saveResults();
}

// Host only: push the finished game to the crew leaderboard. Safe to retry (idempotent).
function saveResults() {
  const s = S.state;
  const crew = store.get('crew');
  const payload = results(s);
  if (!payload || !crew || crew.slug !== s.crew.slug) {
    s.save = payload ? 'error' : 'skipped';
    S.saveErr = payload ? 'This device doesn’t have the crew PIN. Link the crew again.' : '';
    return sync();
  }
  s.save = 'saving';
  sync();
  submitGame(crew.slug, crew.pin, payload)
    .then(() => { s.save = 'saved'; })
    .catch((e) => { s.save = 'error'; S.saveErr = e.message; })
    .finally(() => { if (S.state === s) sync(); });
}

function act(a) {
  if (S.role === 'host') {
    if (reduce(S.state, myId, a)) sync();
    if (a.t === 'kick') {
      for (const [connId, pid] of S.conns) if (pid === a.id) { S.net.send(connId, { t: 'kicked' }); S.conns.delete(connId); }
    }
  } else if (S.net) {
    S.net.send(a);
  }
}

let retryTimer = null;
function joinRoom(code, name, isRetry) {
  clearTimeout(retryTimer);
  if (S.net && S.role === 'client') S.net.close();
  const wasIn = isRetry && S.view;
  S = { ...S, role: 'client', code, net: null, state: null, status: wasIn ? 'reconnecting' : 'connecting', joinErr: '' };
  if (!wasIn) S.view = null;
  store.set('last', { code, t: Date.now() });
  const since = isRetry ? S.lostAt || Date.now() : Date.now();
  S.lostAt = since;
  render();
  let askedTakeover = false;
  const net = createClient(code, {
    onOpen() {
      S.status = 'ok';
      S.lostAt = 0;
      if (!net.wantsHelloFirst) net.send({ t: 'hello', id: myId, name });
      render();
    },
    onMessage(msg) {
      if (msg.t === 'view') receive(msg.v);
      else if (msg.t === 'art') { ui.arts[msg.round] = msg.art || {}; render(); }
      else if (msg.t === 'full') leave(`That room is full (${MAX_PLAYERS} players max).`);
      else if (msg.t === 'kicked') leave('The host removed you from the room.');
      else if (msg.t === 'replaced') leave('You rejoined this room from another device or browser.');
      else if (msg.t === 'taken') {
        if (askedTakeover) return; // a repeated hello can trigger a second reply; ask only once
        askedTakeover = true;
        const yes = confirm(`Someone named ${msg.name} is already in this room.\n\nIs that you on another device or browser? Choose OK to continue as ${msg.name} (your score comes with you), or Cancel to pick a different name.`);
        if (yes) net.send({ t: 'hello', id: myId, name, takeover: true });
        else leave(`Someone named ${msg.name} is already in this room. Pick a different name.`);
      }
    },
    onClose() { if (S.net === net) retry(); },
    onError(err) {
      if (S.net !== net) return;
      if (S.view) return retry();
      leave(err.message || 'Could not connect.');
    },
  });
  S.net = net;
  if (net.wantsHelloFirst) net.send({ t: 'hello', id: myId, name });
  function retry() {
    if (Date.now() - since > 90000) return leave('Lost connection to the room.');
    S.status = 'reconnecting';
    render();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => joinRoom(code, name, true), 2000);
  }
}

function leave(message) {
  clearTimeout(retryTimer);
  if (S.net) {
    if (S.role === 'client') S.net.send({ t: 'leave' });
    const n = S.net;
    setTimeout(() => n.close(), 150);
  }
  if (S.role === 'host') store.del('host');
  if (S.role === 'client') store.del('last');
  S = { role: null, code: null, view: null, net: null, state: null, conns: new Map(), status: 'ok', joinErr: message || '' };
  ui.draft = ''; ui.editing = false; ui.selected = null;
  history.replaceState(null, '', location.pathname + (new URLSearchParams(location.search).has('local') ? '?local=1' : ''));
  render();
}

function receive(v) {
  const prev = S.view;
  if (!prev || prev.round !== v.round || prev.phase !== v.phase) {
    ui.selected = null;
    if (v.phase === 'answer' && (!prev || prev.round !== v.round)) {
      ui.draft = v.mine || '';
      ui.editing = !v.mine;
      ui.pad = { strokes: [], color: ui.pad.color, width: ui.pad.width };
    }
  }
  if (v.phase === 'lobby' || (v.round === 1 && (!prev || prev.round !== 1))) { ui.arts = {}; ui.recapOpen = new Set(); }
  if (v.phase === 'answer' && v.round === 1 && (!prev || prev.phase === 'lobby')) ui.showCustom = false;
  ui.deadlineAt = v.remaining ? Date.now() + v.remaining : 0;
  S.view = v;
  render();
}

/* ---------------- helpers ---------------- */

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const player = (id) => S.view.players.find((p) => p.id === id);
const pname = (id) => (player(id) ? player(id).name : 'Someone');
const isHost = () => S.role === 'host';
const shareUrl = () => {
  const q = new URLSearchParams();
  q.set('room', S.code);
  if (new URLSearchParams(location.search).has('local')) q.set('local', '1');
  return location.origin + location.pathname + '?' + q;
};
function chip(p, extra = '') {
  return `<span class="chip ${p.connected ? '' : 'away'} ${extra}" style="--c:${p.color}"><i></i>${esc(p.name)}</span>`;
}
let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}

/* ---------------- screens ---------------- */

function homeScreen() {
  const params = new URLSearchParams(location.search);
  const invite = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const name = store.get('name', '');
  const hosted = store.get('host');
  const canResume = hosted && Date.now() - hosted.updated < 6 * 3600e3 && hosted.hostId === myId;
  const last = store.get('last');
  const canRejoin = !invite && last && Date.now() - last.t < 6 * 3600e3;
  return `
  <section class="card hero">
    <h1>Think alike.</h1>
    <p class="muted">Everyone answers the same prompt in secret. Score a point for every friend who wrote the same thing.</p>
  </section>
  ${S.joinErr ? `<p class="notice">${esc(S.joinErr)}</p>` : ''}
  <form class="card stack" id="f-home" autocomplete="off">
    <label>Your name
      <input id="name" data-keep maxlength="16" required placeholder="e.g. Sam" value="${esc(name)}" autocapitalize="words" enterkeyhint="go">
    </label>
    <label>Room code
      <input id="code" data-keep maxlength="4" placeholder="ABCD" value="${esc(invite || (canRejoin ? last.code : ''))}" autocapitalize="characters" class="code-input">
    </label>
    <div class="row">
      <button type="submit" name="join" class="primary grow">Join room</button>
    </div>
    <div class="or"><span>or</span></div>
    <button type="button" id="b-create" class="${invite ? '' : 'primary-soft'}">Create a new room</button>
    ${canResume ? `<button type="button" id="b-resume" class="ghost">Resume hosting room ${esc(hosted.code)}</button>` : ''}
  </form>
  ${crewEnabled() ? `
  <section class="card stack">
    <h2>Crew leaderboard</h2>
    <p class="muted small" style="margin:-6px 0 0">See how your friend group stacks up across every game.</p>
    <form id="f-board" class="row" autocomplete="off">
      <input id="board-code" data-keep class="grow" placeholder="Crew code" aria-label="Crew code" value="${esc((store.get('crew') || {}).slug || store.get('board', ''))}" autocapitalize="none" spellcheck="false">
      <button type="submit">View</button>
    </form>
  </section>` : ''}
  <section class="card">
    <button class="link" id="b-help" aria-expanded="${ui.showHelp}">How to play ${ui.showHelp ? '−' : '+'}</button>
    ${ui.showHelp ? `
    <ol class="help">
      <li>One person creates a room and shares the code or link. Everyone joins on their own phone or computer.</li>
      <li>Each round shows a prompt like <em>“A pizza topping”</em>. Type an answer nobody else can see. Take your time.</li>
      <li>When everyone's in, answers are revealed. You score <b>1 point for each other player</b> who wrote the same thing.</li>
      <li>The host can merge answers that mean the same thing (“NYC” and “New York”), so feel free to argue your case.</li>
      <li><b>Spotlight rounds:</b> try to match one chosen player. Matching them is worth 2 points, and they get 1 for each person who matched.</li>
      <li><b>Custom prompts:</b> anyone in the lobby can add their own. They stay secret until they come up.</li>
      <li><b>Sketch rounds:</b> draw your answer and add a hidden label. Everyone sees the drawings first, then the labels are revealed and scored.</li>
      <li><b>Quick pick:</b> tap one of four options. Pick what you think most people will pick.</li>
      <li><b>Would you rather:</b> a spicy dilemma. Everyone on the majority side scores 2.</li>
    </ol>` : ''}
  </section>`;
}

function lobbyScreen(v) {
  const host = isHost();
  const players = v.players.map((p) => `
    <li>${chip(p)}${p.id === v.hostId ? '<span class="tag">host</span>' : ''}
      ${host && p.id !== v.hostId ? `<button class="x" data-kick="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}
    </li>`).join('');
  const seg = (key, opts, cur, fmt) => `<div class="seg" role="group">${opts.map((o) => `<button data-set="${key}" data-val="${o}" class="${o === cur ? 'on' : ''}" ${host ? '' : 'disabled'}>${fmt(o)}</button>`).join('')}</div>`;
  const enough = v.players.filter((p) => p.connected).length >= 2;
  return `
  <section class="card center">
    <p class="muted small">Room code</p>
    <div class="bigcode">${esc(v.code)}</div>
    <button id="b-share" class="ghost">Share invite link</button>
  </section>
  <section class="card">
    <h2>Players <span class="muted">${v.players.length}</span></h2>
    <ul class="plist">${players}</ul>
    ${v.players.length < 2 ? '<p class="muted small">Waiting for friends to join…</p>' : ''}
  </section>
  ${promptsCard(v)}
  <section class="card stack">
    <h2>Settings</h2>
    <div class="setting"><span>Rounds</span>${seg('rounds', [5, 8, 12], v.settings.rounds, (o) => o)}</div>
    <div class="setting"><span>Timer</span>${seg('timer', [0, 45, 90], v.settings.timer, (o) => (o ? o + 's' : 'Off'))}</div>
    <div class="setting setting-col"><span>Round types</span>
      <div class="chips" role="group" aria-label="Round types">
        ${[['words', 'Words'], ['sketch', 'Sketch'], ['pick', 'Quick pick'], ['rather', 'Would you rather 🌶️']].map(([k, label]) => {
          const on = (v.settings.modes || {})[k];
          return `<button class="tchip ${on ? 'on' : ''}" data-mode="${k}" aria-pressed="${!!on}" ${host ? '' : 'disabled'}>${label}</button>`;
        }).join('')}
      </div>
    </div>
    ${host
      ? `<button class="primary" id="b-start" ${enough ? '' : 'disabled'}>${enough ? 'Start game' : 'Need at least 2 players'}</button>`
      : '<p class="muted center small">The host will start the game when everyone’s here.</p>'}
  </section>
  ${crewSection(v)}`;
}

function promptsCard(v) {
  const mine = (v.myPrompts || '').split('\n').filter(Boolean).length;
  const counts = (v.promptCounts || []).filter((c) => player(c.id));
  const total = counts.reduce((n, c) => n + c.n, 0);
  const wordsOff = !(v.settings.modes || {}).words;
  return `<section class="card stack">
    <h2>Custom prompts${total ? ` <span class="muted">${total}</span>` : ''}</h2>
    <p class="muted small" style="margin:-6px 0 0">Everyone can add prompts. They’re kept secret until they come up, and they’re played first in word rounds.</p>
    ${counts.length ? `<p class="small" style="margin:0">${counts.map((c) => `${esc(pname(c.id))} <b>${c.n}</b>`).join(' · ')}</p>` : ''}
    <button class="ghost" id="b-custom" aria-expanded="${ui.showCustom}">${ui.showCustom ? 'Done' : mine ? `Edit your prompts (${mine})` : 'Add your own prompts'}</button>
    ${ui.showCustom ? `<textarea id="custom" data-keep rows="5" maxlength="1800" placeholder="One per line, e.g.&#10;A place we've all been together&#10;Something Jamie always says"></textarea>
    <p class="muted small" style="margin:0">Up to 20, one per line. They save as you type.</p>` : ''}
    ${wordsOff && total ? '<p class="notice small" style="margin:0">Word rounds are off, so custom prompts won’t come up.</p>' : ''}
  </section>`;
}

function crewSection(v) {
  if (!crewEnabled()) return '';
  const view = v.crew ? `<button class="ghost" data-board="${esc(v.crew.slug)}">View leaderboard</button>` : '';
  if (!isHost()) {
    return v.crew ? `<section class="card stack"><h2>Crew stats</h2>
      <p class="muted small" style="margin:-6px 0 0">Results from this game save to the <b>${esc(v.crew.name)}</b> leaderboard.</p>${view}</section>` : '';
  }
  const err = ui.crewErr ? `<p class="notice small">${esc(ui.crewErr)}</p>` : '';
  const busy = ui.crewBusy ? 'disabled' : '';
  let body;
  if (ui.crewForm === 'link') {
    body = `<form id="f-crew-link" class="stack" autocomplete="off">
      <label>Crew code<input id="crew-code" data-keep required placeholder="e.g. game-night-k7qp" autocapitalize="none" spellcheck="false"></label>
      <label>Crew PIN<input id="crew-pin" data-keep required type="password" minlength="4" maxlength="32" autocomplete="off"></label>
      ${err}
      <div class="row"><button type="button" id="b-crew-cancel" class="ghost grow">Cancel</button><button class="primary grow" ${busy}>${ui.crewBusy ? 'Checking…' : 'Link crew'}</button></div>
    </form>`;
  } else if (ui.crewForm === 'create') {
    body = `<form id="f-crew-create" class="stack" autocomplete="off">
      <label>Crew name<input id="crew-name" data-keep required maxlength="40" placeholder="e.g. Game Night"></label>
      <label>Choose a PIN<input id="crew-pin" data-keep required type="password" minlength="4" maxlength="32" autocomplete="new-password"></label>
      <p class="muted small" style="margin:0">Anyone with the crew code can view the leaderboard. Only people with the PIN can save games to it, so share the PIN with whoever hosts.</p>
      ${err}
      <div class="row"><button type="button" id="b-crew-cancel" class="ghost grow">Cancel</button><button class="primary grow" ${busy}>${ui.crewBusy ? 'Creating…' : 'Create crew'}</button></div>
    </form>`;
  } else if (v.crew) {
    body = `<p class="muted small" style="margin:-6px 0 0">Results save to <b>${esc(v.crew.name)}</b> <span class="mono">(${esc(v.crew.slug)})</span>.</p>
      ${view}
      <div class="row"><button id="b-crew-link" class="link">Switch crew</button><button id="b-crew-unlink" class="link" style="margin-left:auto">Don’t save this game</button></div>`;
  } else {
    body = `<p class="muted small" style="margin:-6px 0 0">Save results to a shared leaderboard so your group can compare stats over time.</p>
      <div class="row"><button id="b-crew-link" class="ghost grow">Link a crew</button><button id="b-crew-create" class="ghost grow">Create a crew</button></div>`;
  }
  return `<section class="card stack"><h2>Crew stats</h2>${body}</section>`;
}

function saveLine(v) {
  if (!v.crew || !v.save || v.save === 'skipped') return '';
  const name = `<b>${esc(v.crew.name)}</b>`;
  if (v.save === 'saving') return `<p class="muted small">Saving to ${name}…</p>`;
  if (v.save === 'saved') return `<p class="small">Saved to ${name} ✓</p><button class="ghost" data-board="${esc(v.crew.slug)}">View crew leaderboard</button>`;
  return isHost()
    ? `<p class="notice small">Couldn’t save to the crew leaderboard. ${esc(S.saveErr || '')}</p><button id="b-save-retry" class="ghost">Try again</button>`
    : '<p class="muted small">The results couldn’t be saved to the crew leaderboard.</p>';
}

function recapCard(v) {
  const hist = v.history || [];
  if (!hist.length) return '';
  const name = (id) => (player(id) ? player(id).name : 'Someone');
  const items = hist.map((h) => {
    const info = MODE_INFO[h.mode] || MODE_INFO.words;
    const filled = h.groups.filter((g) => g.members.length);
    const digest = filled.slice(0, 3).map((g) => `${esc(g.label)}${g.members.length > 1 ? ` ×${g.members.length}` : ''}`).join(' · ') + (filled.length > 3 ? ' · …' : '');
    const mine = h.groups.find((g) => g.members.some((m) => m.id === myId));
    const myPts = mine ? mine.members.find((m) => m.id === myId).pts : 0;
    const groups = h.groups.map((g) => `
      <li class="${g.members.length > 1 ? 'match' : ''}">
        <div class="rc-label">${esc(g.label)} <span class="muted">${g.members.length || 'nobody'}</span></div>
        <div class="gmem">${g.members.map((m) => {
          const p = player(m.id);
          const art = h.mode === 'sketch' ? `<canvas class="art art-thumb" data-art="r${h.round}:${esc(m.id)}"></canvas>` : '';
          const variant = m.text && m.text.trim().toLowerCase() !== g.label.trim().toLowerCase() ? ` <em>“${esc(m.text)}”</em>` : '';
          return `<span class="mem ${art ? 'mem-art' : ''}">${art}<span>${p ? chip(p) : esc(name(m.id))}${variant}${m.pts ? ` <b class="pts">+${m.pts}</b>` : ''}</span></span>`;
        }).join('')}</div>
      </li>`).join('');
    const open = ui.recapOpen.has(h.round);
    return `
    <li>
      <details data-recap="${h.round}" ${open ? 'open' : ''}>
        <summary>
          <span class="rc-head muted small">Round ${h.round}${info.label ? ` · ${info.label}` : ''}${h.type === 'spotlight' ? ` · Spotlight on ${esc(name(h.spotlight))}` : ''}${myPts ? ` · <b class="pts">you +${myPts}</b>` : ''}</span>
          <span class="rc-prompt">${esc(h.prompt)}${h.by ? ` <span class="muted small rc-by">from ${esc(name(h.by))}</span>` : ''}</span>
          ${h.mode === 'rather' && h.options
            ? (open ? '' : `<span class="rc-digest small">${h.options.map((o) => {
                const g = h.groups.find((x) => x.label === o);
                return `${esc(o)} <b>(${g ? g.members.length : 0})</b>`;
              }).join(' <i class="muted">or</i> ')}</span>`)
            : open ? '' : `<span class="rc-digest small">${digest || '<span class="muted">No answers</span>'}</span>`}
        </summary>
        <ul class="rc-groups">${groups || '<li class="muted small">No answers this round.</li>'}</ul>
      </details>
    </li>`;
  }).join('');
  return `<section class="card">
    <h2>Round by round</h2>
    <p class="muted small" style="margin:-6px 0 8px">Tap a round to see everyone’s answers.</p>
    <ol class="recap">${items}</ol>
  </section>`;
}

function myStatsCard(v) {
  const st = v.mystats;
  if (!st || !st.answered) return '';
  const lines = [`You matched someone in <b>${st.matched} of ${st.answered}</b> rounds.`];
  if (st.spotTurns) lines.push(`In the spotlight, ${st.spotMatchers} ${st.spotMatchers === 1 ? 'person' : 'people'} matched you.`);
  if (st.spotTries) lines.push(`You matched the spotlight player in ${st.spotHits} of ${st.spotTries} tries.`);
  return `<section class="card"><h2>Your game</h2>${lines.map((l) => `<p class="tight">${l}</p>`).join('')}</section>`;
}

const MODE_INFO = {
  words: { label: '', how: '' },
  sketch: { label: 'Sketch round', how: 'Draw your answer, then give it a short label only the reveal will show.' },
  pick: { label: 'Quick pick', how: 'Tap the one you think most people will pick.' },
  rather: { label: 'Would you rather', how: 'Pick a side. Everyone on the majority side scores 2.' },
};

function roundHeader(v) {
  const spot = v.type === 'spotlight';
  const info = MODE_INFO[v.mode] || MODE_INFO.words;
  return `
  <div class="roundinfo">
    <span>Round ${v.round} of ${v.settings.rounds}${info.label ? ` · <b class="mode-tag">${info.label}</b>` : ''}</span>
    <span id="timer" class="timer"></span>
  </div>
  ${spot ? `<div class="spot-banner" style="--c:${player(v.spotlight)?.color || '#999'}">
      ${v.spotlight === myId
        ? '<b>You’re in the spotlight.</b> Everyone is trying to match you, so give your most natural answer.'
        : `<b>Spotlight on ${esc(pname(v.spotlight))}.</b> Match their answer for 2 points.`}
    </div>` : ''}
  <h1 class="prompt">${esc(v.prompt)}</h1>
  ${v.promptBy ? `<p class="by muted small">Prompt from ${esc(pname(v.promptBy))}</p>` : ''}`;
}

function answerInput(v) {
  const locked = v.mine && !ui.editing;
  if (v.mode === 'pick' || v.mode === 'rather') {
    const opts = v.options.map((o, i) => `
      <button class="opt ${v.mine === o ? 'on' : ''}" data-opt="${i}" aria-pressed="${v.mine === o}">${esc(o)}</button>`);
    return `<section class="card stack">
      ${v.mode === 'rather' ? `${opts[0]}<div class="or"><span>or</span></div>${opts[1]}` : `<div class="opts">${opts.join('')}</div>`}
      <p class="muted small center" style="margin:0">${v.mine ? 'Locked in. Tap another to change your mind.' : MODE_INFO[v.mode].how}</p>
    </section>`;
  }
  if (v.mode === 'sketch') {
    if (locked) {
      return `<section class="card center">
        <canvas class="art art-mid" data-art="${esc(myId)}"></canvas>
        <p class="locked">${esc(v.mine)}</p>
        <button id="b-edit" class="ghost">Change drawing</button>
      </section>`;
    }
    const tools = `<div class="tools">
      ${PALETTE.map((c, i) => `<button class="swatch ${ui.pad.color === i ? 'on' : ''}" data-color="${i}" style="--c:${c}" aria-label="Color ${i + 1}"></button>`).join('')}
      <span class="tool-gap"></span>
      <button class="tool ${ui.pad.width === 0 ? 'on' : ''}" data-width="0" aria-label="Thin brush"><i class="dotsz s"></i></button>
      <button class="tool ${ui.pad.width === 1 ? 'on' : ''}" data-width="1" aria-label="Thick brush"><i class="dotsz l"></i></button>
      <button class="tool" id="b-undo" aria-label="Undo">↶</button>
      <button class="tool" id="b-clear" aria-label="Clear">✕</button>
    </div>`;
    return `<section class="card stack sketch-card">
      <canvas id="pad" class="art pad"></canvas>
      ${tools}
      <form id="f-answer" class="stack" autocomplete="off">
        <input id="answer" data-keep maxlength="40" placeholder="Label it (only shown at the reveal)" enterkeyhint="done" autocapitalize="sentences">
        <button class="primary" type="submit">Lock it in</button>
      </form>
    </section>`;
  }
  return `<section class="card">
    ${locked ? `
      <p class="muted small">Your answer</p>
      <p class="locked">${esc(v.mine)}</p>
      <button id="b-edit" class="ghost">Change answer</button>`
    : `<form id="f-answer" class="stack" autocomplete="off">
      <input id="answer" data-keep maxlength="40" placeholder="Type your answer" enterkeyhint="done" autocapitalize="sentences">
      <button class="primary" type="submit">Lock it in</button>
    </form>`}
  </section>`;
}

function answerScreen(v) {
  const waiting = v.players.filter((p) => p.connected && !v.submitted.includes(p.id));
  return `
  ${roundHeader(v)}
  ${answerInput(v)}
  <section class="card">
    <ul class="plist inline">${v.players.map((p) => `<li>${chip(p, v.submitted.includes(p.id) ? 'done' : '')}</li>`).join('')}</ul>
    <p class="muted small">${waiting.length ? `Waiting on ${waiting.map((p) => esc(p.name)).join(', ')}` : 'Everyone is in.'}</p>
    ${isHost() ? `<button id="b-reveal" class="ghost" ${v.submitted.length ? '' : 'disabled'}>Reveal now</button>` : ''}
  </section>`;
}

function galleryScreen(v) {
  const tiles = v.gallery.map((id) => `<li><canvas class="art" data-art="${esc(id)}"></canvas></li>`).join('');
  return `
  ${roundHeader(v)}
  <p class="hint">Who drew what? Have a look, then the host shows the answers.</p>
  <ul class="gallery">${tiles || '<li class="muted">Nobody drew anything this round.</li>'}</ul>
  ${isHost() ? '<button id="b-unveil" class="primary wide">Show answers</button>' : '<p class="muted center small">Waiting for the host to show the answers…</p>'}`;
}

function revealScreen(v) {
  if (!v.unveiled) return galleryScreen(v);
  const host = isHost();
  const choice = v.mode === 'pick' || v.mode === 'rather';
  const canMerge = host && !choice;
  const spotG = v.type === 'spotlight' ? v.groups.find((g) => g.members.some((m) => m.id === v.spotlight)) : null;
  const groups = v.groups.map((g) => {
    const n = g.members.length;
    const isSpot = spotG && g.id === spotG.id;
    const scored = g.members.some((m) => v.points[m.id]);
    return `
    <li class="group ${n > 1 || (choice && scored) ? 'match' : ''} ${isSpot ? 'spotg' : ''} ${ui.selected === g.id ? 'sel' : ''}" ${canMerge ? `data-group="${g.id}" tabindex="0" role="button"` : ''}>
      <div class="gtop"><span class="glabel">${esc(g.label)}</span>${n > 1 || choice ? `<span class="gcount">${choice ? n : '×' + n}</span>` : ''}</div>
      <div class="gmem">${n ? g.members.map((m) => {
        const p = player(m.id);
        if (!p) return '';
        const pts = v.points[m.id] || 0;
        const art = v.mode === 'sketch' ? `<canvas class="art art-thumb" data-art="${esc(m.id)}"></canvas>` : '';
        return `<span class="mem ${art ? 'mem-art' : ''}" ${canMerge && n > 1 ? `data-split="${esc(m.id)}"` : ''}>${art}<span>${chip(p)}${m.text.trim().toLowerCase() !== g.label.trim().toLowerCase() ? `<em>“${esc(m.text)}”</em>` : ''}${pts ? `<b class="pts">+${pts}</b>` : ''}</span></span>`;
      }).join('') : '<span class="muted small">Nobody</span>'}</div>
    </li>`;
  }).join('');
  const none = v.noAnswer.map(player).filter(Boolean);
  const final = v.round >= v.settings.rounds;
  let hint = '';
  if (canMerge) hint = ui.selected ? 'Now tap another answer to merge them.' : 'Tap two answers to merge them if they mean the same thing. Tap a name to split it out.';
  else if (v.mode === 'rather' && v.type !== 'spotlight') hint = 'The majority side scores 2 each. A tie means nobody scores.';
  return `
  ${roundHeader(v)}
  ${hint ? `<p class="hint">${hint}</p>` : ''}
  <ul class="groups">${groups || '<li class="muted">No answers this round.</li>'}</ul>
  ${none.length ? `<p class="muted small">No answer: ${none.map((p) => esc(p.name)).join(', ')}</p>` : ''}
  ${scoreboard(v, v.points)}
  ${host ? `<button id="b-next" class="primary wide">${final ? 'See final scores' : 'Next round'}</button>
            ${final ? '' : '<button id="b-end" class="link center-block">End game early</button>'}`
    : '<p class="muted center small">The host will move on when everyone’s ready.</p>'}`;
}

function scoreboard(v, delta = {}) {
  const rows = v.players
    .map((p) => ({ p, total: p.score + (delta[p.id] || 0), d: delta[p.id] || 0 }))
    .sort((a, b) => b.total - a.total);
  return `<section class="card">
    <h2>Scores</h2>
    <ol class="scores">${rows.map((r) => `<li>${chip(r.p)}<span class="score">${r.d ? `<small>+${r.d}</small>` : ''}${r.total}</span></li>`).join('')}</ol>
  </section>`;
}

function finalScreen(v) {
  const rows = v.players.slice().sort((a, b) => b.score - a.score);
  const top = rows.length ? rows[0].score : 0;
  const winners = rows.filter((r) => r.score === top);
  const best = v.best && v.best.ids.every((id) => player(id)) ? v.best : null;
  return `
  <section class="card center">
    <p class="muted small">Game over</p>
    <h1>${winners.map((w) => esc(w.name)).join(' & ')} ${winners.length > 1 ? 'tie' : 'wins'}</h1>
    <p class="muted">${top} point${top === 1 ? '' : 's'}</p>
    ${best ? `<p class="sync">Most in sync: <b>${esc(pname(best.ids[0]))}</b> &amp; <b>${esc(pname(best.ids[1]))}</b>, who matched ${best.n} time${best.n === 1 ? '' : 's'}</p>` : ''}
    ${saveLine(v)}
  </section>
  ${scoreboard(v)}
  ${myStatsCard(v)}
  ${recapCard(v)}
  ${isHost() ? '<button id="b-again" class="primary wide">Play again</button>' : '<p class="muted center small">Waiting for the host to start another game…</p>'}`;
}

/* ---------------- render ---------------- */

// Removing a focused field fires blur/change, which can save and re-render while we're
// still patching the page. Defer any such nested render until this one has finished.
let rendering = false;
let renderAgain = false;
function render() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    renderNow();
  } finally {
    rendering = false;
  }
  if (renderAgain) { renderAgain = false; render(); }
}

function renderNow() {
  const v = S.view;
  let html;
  if (ui.board) html = boardScreen(ui.board);
  else if (!S.role) html = homeScreen();
  else if (!v) html = `<section class="card center"><p class="muted">${S.status === 'error' ? 'Having trouble connecting…' : 'Connecting…'}</p></section>`;
  else html = { lobby: lobbyScreen, answer: answerScreen, reveal: revealScreen, final: finalScreen }[v.phase](v);
  const key = ui.board ? 'board' : S.role ? (v ? v.phase + v.round : 'wait') : 'home';

  // Patch only the top-level blocks that changed, so a focused input (and the
  // phone keyboard) survives other players' updates.
  const active = document.activeElement;
  const focusId = active && active.id && active.hasAttribute('data-keep') ? active.id : null;
  const sel = focusId ? [active.selectionStart, active.selectionEnd] : null;
  const keep = {};
  document.querySelectorAll('[data-keep]').forEach((el) => { keep[el.id] = el.value; });

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  let screen = $app.firstElementChild;
  if (!screen || screen.dataset.screen !== key) {
    screen = document.createElement('div');
    screen.className = 'screen';
    screen.dataset.screen = key;
    screen.append(...tmp.childNodes);
    $app.replaceChildren(screen);
  } else {
    const next = [...tmp.children];
    const prev = [...screen.children];
    next.forEach((n, i) => {
      const o = prev[i];
      if (!o || o.parentNode !== screen) screen.append(n);
      // Canvases gain width/height once painted; ignore that so a drawing isn't torn down mid-stroke.
      else if (o.outerHTML.replace(/ (width|height)="\d+"/g, '') !== n.outerHTML) o.replaceWith(n);
    });
    prev.slice(next.length).forEach((o) => o.remove());
  }

  // Fill fresh inputs: keep what was typed, otherwise use initial values.
  const initial = { answer: ui.draft, custom: v && v.myPrompts ? v.myPrompts : '' };
  document.querySelectorAll('[data-keep]').forEach((el) => {
    if (el._ready) return;
    el._ready = true;
    if (el.id in keep) el.value = keep[el.id];
    else if (el.id in initial) el.value = initial[el.id];
  });
  if (focusId && document.activeElement !== document.getElementById(focusId)) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
  }

  const statusText = { connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Offline' }[S.status];
  const bar = S.role
    ? `${statusText ? `<span class="status">${statusText}</span>` : ''}<span class="room">${esc(S.code || '')}</span><button id="b-leave" class="link">Leave</button>`
    : '';
  if ($bar.innerHTML !== bar) $bar.innerHTML = bar;
  const pad = document.getElementById('pad');
  if (pad) attachPad(pad, ui.pad, null, () => toast('That drawing is full. Undo or clear to keep going.'));
  paintAll($app, getArt);
  updateTimer();
}

function updateTimer() {
  const el = document.getElementById('timer');
  if (!el) return;
  if (!ui.deadlineAt || S.view?.phase !== 'answer') { el.textContent = ''; return; }
  const s = Math.max(0, Math.ceil((ui.deadlineAt - Date.now()) / 1000));
  el.textContent = `${s}s`;
  el.classList.toggle('low', s <= 10);
}

setInterval(() => {
  updateTimer();
  if (S.role === 'host' && S.state && tick(S.state)) sync();
}, 500);

/* ---------------- events ---------------- */

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'f-home') {
    const name = cleanName(document.getElementById('name').value);
    const code = document.getElementById('code').value.toUpperCase().replace(/[^A-Z]/g, '');
    if (!name) return toast('Enter your name first.');
    if (code.length !== 4) return toast('Room codes are 4 letters.');
    store.set('name', name);
    joinRoom(code, name);
  }
  if (e.target.id === 'f-answer') {
    const text = document.getElementById('answer').value.trim();
    const sketch = S.view && S.view.mode === 'sketch';
    if (sketch && !ui.pad.strokes.length) return toast('Draw something first.');
    if (!text) return toast(sketch ? 'Give your drawing a short label.' : 'Type an answer first.');
    ui.draft = text;
    ui.editing = false;
    act(sketch ? { t: 'answer', text, art: encode(ui.pad.strokes) } : { t: 'answer', text });
  }
  if (e.target.id === 'f-board') {
    const slug = cleanSlug(document.getElementById('board-code').value);
    if (slug.length < 3) return toast('Enter a crew code.');
    openBoard(slug);
  }
  if (e.target.id === 'f-crew-link' || e.target.id === 'f-crew-create') {
    if (ui.crewBusy) return;
    const creating = e.target.id === 'f-crew-create';
    const pin = document.getElementById('crew-pin').value;
    const arg = creating ? document.getElementById('crew-name').value.trim() : cleanSlug(document.getElementById('crew-code').value);
    ui.crewBusy = true;
    ui.crewErr = '';
    render();
    (creating ? createCrew(arg, pin) : checkCrew(arg, pin))
      .then((crew) => {
        store.set('crew', { slug: crew.slug, name: crew.name, pin });
        ui.crewForm = null;
        act({ t: 'crew', crew: { slug: crew.slug, name: crew.name } });
        toast(creating ? `Crew created. Code: ${crew.slug}` : `Linked to ${crew.name}`);
      })
      .catch((err) => { ui.crewErr = err.message; })
      .finally(() => { ui.crewBusy = false; render(); });
  }
});

function openBoard(slug) {
  ui.board = { slug, data: null, err: '', sort: store.get('sort', 'wins'), open: null };
  store.set('board', slug);
  window.scrollTo(0, 0);
  render();
  getLeaderboard(slug)
    .then((data) => { if (ui.board && ui.board.slug === slug) { ui.board.data = data; render(); } })
    .catch((err) => { if (ui.board && ui.board.slug === slug) { ui.board.err = err.message; render(); } });
}

function boardUrl(slug) {
  const q = new URLSearchParams();
  q.set('crew', slug);
  return location.origin + location.pathname + '?' + q;
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'answer') ui.draft = e.target.value;
  if (e.target.id === 'code') {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
    try { e.target.setSelectionRange(pos, pos); } catch {}
  }
});

let customTimer;
document.addEventListener('change', (e) => {
  if (e.target.id === 'custom') act({ t: 'prompts', text: e.target.value });
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'custom') return;
  clearTimeout(customTimer);
  customTimer = setTimeout(() => act({ t: 'prompts', text: e.target.value }), 600);
});

// Recap rounds: remember which are expanded so re-renders keep them open.
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.dataset || !d.dataset.recap) return;
  const r = Number(d.dataset.recap);
  if (d.open === ui.recapOpen.has(r)) return;
  if (d.open) ui.recapOpen.add(r);
  else ui.recapOpen.delete(r);
  render();
}, true);

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && (e.target.dataset.group || e.target.dataset.lb)) {
    e.preventDefault();
    e.target.click();
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-group], [data-lb]');
  if (!t) return;
  const id = t.id;

  // Leaderboard
  if (t.dataset.board) return openBoard(t.dataset.board);
  if (id === 'b-board-back') {
    ui.board = null;
    if (new URLSearchParams(location.search).has('crew')) history.replaceState(null, '', S.role ? shareUrl() : location.pathname);
    return render();
  }
  if (id === 'b-board-retry') return openBoard(ui.board.slug);
  if (t.dataset.sort) { ui.board.sort = t.dataset.sort; store.set('sort', t.dataset.sort); return render(); }
  if (t.dataset.lb) { ui.board.open = ui.board.open === t.dataset.lb ? null : t.dataset.lb; return render(); }
  if (id === 'b-board-share') {
    const url = boardUrl(ui.board.slug);
    if (navigator.share) {
      try { await navigator.share({ title: 'Common Ground leaderboard', text: `Our Common Ground leaderboard (crew code ${ui.board.slug})`, url }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(url); toast('Leaderboard link copied'); } catch { prompt('Copy this link', url); }
    }
    return;
  }

  // Crew linking (host, lobby)
  if (id === 'b-crew-link' || id === 'b-crew-create') { ui.crewForm = id === 'b-crew-link' ? 'link' : 'create'; ui.crewErr = ''; return render(); }
  if (id === 'b-crew-cancel') { ui.crewForm = null; ui.crewErr = ''; return render(); }
  if (id === 'b-crew-unlink') return act({ t: 'crew', crew: null });
  if (id === 'b-save-retry' && S.role === 'host') { S.state.save = null; return sync(); }

  if (id === 'b-create' || id === 'b-resume') {
    const nameEl = document.getElementById('name');
    const name = cleanName(nameEl ? nameEl.value : '');
    if (id === 'b-create') {
      if (!name) { toast('Enter your name first.'); nameEl && nameEl.focus(); return; }
      store.set('name', name);
      hostRoom(name);
    } else {
      hostRoom(null, store.get('host'));
    }
    history.replaceState(null, '', shareUrl());
    return;
  }
  if (id === 'b-help') { ui.showHelp = !ui.showHelp; return render(); }
  if (id === 'b-custom') { ui.showCustom = !ui.showCustom; return render(); }
  if (id === 'b-leave') {
    if (S.role === 'host' && S.view && S.view.players.length > 1 && !confirm('Leave and close this room for everyone?')) return;
    return leave();
  }
  if (id === 'b-share') {
    const url = shareUrl();
    if (navigator.share) {
      try { await navigator.share({ title: 'Common Ground', text: `Join my Common Ground room: ${S.code}`, url }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { prompt('Copy this link', url); }
    }
    return;
  }
  if (t.dataset.set) return act({ t: 'settings', [t.dataset.set]: Number(t.dataset.val) });
  if (t.dataset.mode) return act({ t: 'settings', mode: t.dataset.mode });
  if (t.dataset.kick) {
    const p = player(t.dataset.kick);
    if (p && confirm(`Remove ${p.name} from the room?`)) act({ t: 'kick', id: t.dataset.kick });
    return;
  }
  if (id === 'b-start') return act({ t: 'start' });
  if (id === 'b-edit') { ui.editing = true; render(); document.getElementById('answer')?.focus(); return; }
  if (id === 'b-reveal') return act({ t: 'reveal' });
  if (id === 'b-next') return act({ t: 'next' });
  if (id === 'b-end') { if (confirm('End the game now and show final scores?')) act({ t: 'end' }); return; }
  if (id === 'b-again') return act({ t: 'again' });
  if (id === 'b-unveil') return act({ t: 'unveil' });

  // Quick pick / would you rather: tapping an option is the answer.
  if (t.dataset.opt != null && S.view?.phase === 'answer' && S.view.options) {
    const text = S.view.options[Number(t.dataset.opt)];
    ui.draft = text;
    return act({ t: 'answer', text });
  }

  // Drawing tools.
  if (t.dataset.color != null) { ui.pad.color = Number(t.dataset.color); return render(); }
  if (t.dataset.width != null) { ui.pad.width = Number(t.dataset.width); return render(); }
  if (id === 'b-undo' || id === 'b-clear') {
    if (id === 'b-undo') ui.pad.strokes.pop();
    else if (ui.pad.strokes.length && !confirm('Clear your drawing?')) return;
    else ui.pad.strokes.length = 0;
    const pad = document.getElementById('pad');
    if (pad) paint(pad, ui.pad.strokes);
    return;
  }

  // Host merge / split on the reveal screen.
  if (isHost() && S.view?.phase === 'reveal') {
    const split = e.target.closest('[data-split]');
    if (split) { e.stopPropagation(); ui.selected = null; return act({ t: 'split', id: split.dataset.split }); }
    if (t.dataset.group) {
      const g = Number(t.dataset.group);
      if (ui.selected == null) { ui.selected = g; return render(); }
      if (ui.selected === g) { ui.selected = null; return render(); }
      const a = ui.selected;
      ui.selected = null;
      return act({ t: 'merge', a, b: g });
    }
  }
});

// Phones suspend tabs; nudge a reconnect as soon as we're visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.role === 'client' && S.status === 'reconnecting') {
    joinRoom(S.code, store.get('name', 'Player'), true);
  }
});

window.addEventListener('pagehide', () => {
  if (S.role === 'client' && S.net) S.net.send({ t: 'leave' });
});

{
  const crewParam = cleanSlug(new URLSearchParams(location.search).get('crew'));
  if (crewEnabled() && crewParam.length >= 3) openBoard(crewParam);
  else render();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
