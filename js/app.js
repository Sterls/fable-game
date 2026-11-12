import { createHost, createClient, useLocal } from './net.js';
import { newGame, reduce, viewFor, tick, setConnected, cleanName, results, MAX_PLAYERS } from './game.js';
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
};

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
        return sync();
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
  const net = createClient(code, {
    onOpen() {
      S.status = 'ok';
      S.lostAt = 0;
      if (!net.wantsHelloFirst) net.send({ t: 'hello', id: myId, name });
      render();
    },
    onMessage(msg) {
      if (msg.t === 'view') receive(msg.v);
      else if (msg.t === 'full') leave(`That room is full (${MAX_PLAYERS} players max).`);
      else if (msg.t === 'kicked') leave('The host removed you from the room.');
      else if (msg.t === 'replaced') leave('You rejoined this room from another device or browser.');
      else if (msg.t === 'taken') {
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
    if (v.phase === 'answer' && (!prev || prev.round !== v.round)) { ui.draft = v.mine || ''; ui.editing = !v.mine; }
  }
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
  <section class="card stack">
    <h2>Settings</h2>
    <div class="setting"><span>Rounds</span>${seg('rounds', [5, 8, 12], v.settings.rounds, (o) => o)}</div>
    <div class="setting"><span>Timer</span>${seg('timer', [0, 45, 90], v.settings.timer, (o) => (o ? o + 's' : 'Off'))}</div>
    ${host ? `
      <button class="link" id="b-custom">${ui.showCustom ? 'Hide' : 'Add'} your own prompts ${v.settings.customCount ? `(${v.settings.customCount})` : ''}</button>
      ${ui.showCustom ? `<textarea id="custom" data-keep rows="5" placeholder="One per line, e.g.&#10;A place we've all been together&#10;Something Jamie always says"></textarea>
      <p class="muted small">Your prompts are played first.</p>` : ''}
      <button class="primary" id="b-start" ${enough ? '' : 'disabled'}>${enough ? 'Start game' : 'Need at least 2 players'}</button>`
    : `<p class="muted center small">The host will start the game when everyone's here.${v.settings.customCount ? ` ${v.settings.customCount} custom prompt(s) added.` : ''}</p>`}
  </section>
  ${crewSection(v)}`;
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

function myStatsCard(v) {
  const st = v.mystats;
  if (!st || !st.answered) return '';
  const lines = [`You matched someone in <b>${st.matched} of ${st.answered}</b> rounds.`];
  if (st.spotTurns) lines.push(`In the spotlight, ${st.spotMatchers} ${st.spotMatchers === 1 ? 'person' : 'people'} matched you.`);
  if (st.spotTries) lines.push(`You matched the spotlight player in ${st.spotHits} of ${st.spotTries} tries.`);
  return `<section class="card"><h2>Your game</h2>${lines.map((l) => `<p class="tight">${l}</p>`).join('')}</section>`;
}

function roundHeader(v) {
  const spot = v.type === 'spotlight';
  return `
  <div class="roundinfo">
    <span>Round ${v.round} of ${v.settings.rounds}</span>
    <span id="timer" class="timer"></span>
  </div>
  ${spot ? `<div class="spot-banner" style="--c:${player(v.spotlight)?.color || '#999'}">
      ${v.spotlight === myId
        ? '<b>You’re in the spotlight.</b> Everyone is trying to match you, so give your most natural answer.'
        : `<b>Spotlight on ${esc(pname(v.spotlight))}.</b> Match their answer for 2 points.`}
    </div>` : ''}
  <h1 class="prompt">${esc(v.prompt)}</h1>`;
}

function answerScreen(v) {
  const locked = v.mine && !ui.editing;
  const waiting = v.players.filter((p) => p.connected && !v.submitted.includes(p.id));
  return `
  ${roundHeader(v)}
  <section class="card">
    ${locked ? `
      <p class="muted small">Your answer</p>
      <p class="locked">${esc(v.mine)}</p>
      <button id="b-edit" class="ghost">Change answer</button>`
    : `<form id="f-answer" class="stack" autocomplete="off">
      <input id="answer" data-keep maxlength="40" placeholder="Type your answer" enterkeyhint="done" autocapitalize="sentences">
      <button class="primary" type="submit">Lock it in</button>
    </form>`}
  </section>
  <section class="card">
    <ul class="plist inline">${v.players.map((p) => `<li>${chip(p, v.submitted.includes(p.id) ? 'done' : '')}</li>`).join('')}</ul>
    <p class="muted small">${waiting.length ? `Waiting on ${waiting.map((p) => esc(p.name)).join(', ')}` : 'Everyone is in.'}</p>
    ${isHost() ? `<button id="b-reveal" class="ghost" ${v.submitted.length ? '' : 'disabled'}>Reveal now</button>` : ''}
  </section>`;
}

function revealScreen(v) {
  const host = isHost();
  const spotG = v.type === 'spotlight' ? v.groups.find((g) => g.members.some((m) => m.id === v.spotlight)) : null;
  const groups = v.groups.map((g) => {
    const n = g.members.length;
    const isSpot = spotG && g.id === spotG.id;
    return `
    <li class="group ${n > 1 ? 'match' : ''} ${isSpot ? 'spotg' : ''} ${ui.selected === g.id ? 'sel' : ''}" ${host ? `data-group="${g.id}" tabindex="0" role="button"` : ''}>
      <div class="gtop"><span class="glabel">${esc(g.label)}</span>${n > 1 ? `<span class="gcount">×${n}</span>` : ''}</div>
      <div class="gmem">${g.members.map((m) => {
        const p = player(m.id);
        if (!p) return '';
        const pts = v.points[m.id] || 0;
        return `<span class="mem" ${host && n > 1 ? `data-split="${esc(m.id)}"` : ''}>${chip(p)}${m.text.trim().toLowerCase() !== g.label.trim().toLowerCase() ? `<em>“${esc(m.text)}”</em>` : ''}${pts ? `<b class="pts">+${pts}</b>` : ''}</span>`;
      }).join('')}</div>
    </li>`;
  }).join('');
  const none = v.noAnswer.map(player).filter(Boolean);
  const final = v.round >= v.settings.rounds;
  return `
  ${roundHeader(v)}
  ${host ? `<p class="hint">${ui.selected ? 'Now tap another answer to merge them.' : 'Tap two answers to merge them if they mean the same thing. Tap a name to split it out.'}</p>` : ''}
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
  ${isHost() ? '<button id="b-again" class="primary wide">Play again</button>' : '<p class="muted center small">Waiting for the host to start another game…</p>'}`;
}

/* ---------------- render ---------------- */

function render() {
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
      if (!o) screen.append(n);
      else if (o.outerHTML !== n.outerHTML) o.replaceWith(n);
    });
    prev.slice(next.length).forEach((o) => o.remove());
  }

  // Fill fresh inputs: keep what was typed, otherwise use initial values.
  const initial = { answer: ui.draft, custom: v && v.custom ? v.custom : '' };
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
    if (!text) return;
    ui.draft = text;
    ui.editing = false;
    act({ t: 'answer', text });
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
  if (e.target.id === 'custom') act({ t: 'settings', custom: e.target.value });
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'custom') return;
  clearTimeout(customTimer);
  customTimer = setTimeout(() => act({ t: 'settings', custom: e.target.value }), 600);
});

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
