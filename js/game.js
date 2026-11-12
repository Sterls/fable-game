// Pure game rules. The host owns a `state` object and feeds actions through `reduce`.
import { PROMPTS, SKETCHES, PICKS, RATHERS, shuffle } from './prompts.js';

// Round modes. "words" = type an answer, "sketch" = draw it (with a hidden label),
// "pick" = choose one of four, "rather" = would-you-rather, scored by siding with the majority.
export const MODES = ['words', 'sketch', 'pick', 'rather'];
const MAX_ART = 12000; // base64 chars, ~4000 points

export const COLORS = ['#7c9a92', '#c28f6b', '#8a8fbf', '#b5838d', '#6d9dc5', '#a3a86b', '#c9a227', '#9c7bb0', '#5f9e7a', '#c47a7a', '#6b8fa3', '#a68a64'];
export const MAX_PLAYERS = 12;

export function newGame(code, hostId, hostName) {
  const s = {
    code,
    hostId,
    phase: 'lobby',
    players: [],
    settings: { rounds: 8, timer: 0, custom: '', modes: { words: true, sketch: true, pick: true, rather: true } },
    deck: [],
    decks: {},
    plan: [],
    round: 0,
    prompt: '',
    mode: 'words',
    options: null,
    art: {},
    unveiled: true,
    gallery: [],
    type: 'crowd',
    spotlight: null,
    answers: {},
    groups: [],
    points: {},
    sync: {},
    deadline: 0,
    nextGroupId: 1,
    stats: {},
    played: 0,
    gameId: null,
    crew: null, // { slug, name } when results are saved to a Supabase crew
    save: null, // null | 'saving' | 'saved' | 'error'
    updated: Date.now(),
  };
  addPlayer(s, hostId, hostName);
  return s;
}

// Returns true (joined), false (room full) or { taken: oldId } when the name belongs to someone
// who still looks connected; the joiner can confirm it's them and retry with takeover.
function addPlayer(s, id, name, takeover) {
  name = cleanName(name) || 'Player';
  // Same name as an existing seat = probably the same person on another device or browser.
  if (!s.players.some((p) => p.id === id)) {
    const seat = s.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (seat && seat.id !== s.hostId) {
      if (seat.connected && !takeover) return { taken: seat.id };
      const old = seat.id;
      rekey(s, old, id);
      s.players.find((p) => p.id === id).connected = true;
      return { replaced: old };
    }
  }
  name = uniqueName(s, id, name);
  const existing = s.players.find((p) => p.id === id);
  if (existing) {
    existing.name = name;
    existing.connected = true;
    return true;
  }
  if (s.players.length >= MAX_PLAYERS) return false;
  const used = new Set(s.players.map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length];
  s.players.push({ id, name, score: 0, connected: true, color, spot: 0 });
  return true;
}

function rekey(s, from, to) {
  const move = (obj) => { if (obj && from in obj) { obj[to] = obj[from]; delete obj[from]; } };
  s.players.find((p) => p.id === from).id = to;
  move(s.answers);
  move(s.art);
  s.gallery = (s.gallery || []).map((m) => (m === from ? to : m));
  move(s.points);
  move(s.stats);
  for (const g of s.groups) g.members = g.members.map((m) => (m === from ? to : m));
  if (s.spotlight === from) s.spotlight = to;
  for (const k of Object.keys(s.sync)) {
    const ids = k.split('|');
    if (!ids.includes(from)) continue;
    const nk = ids.map((x) => (x === from ? to : x)).sort().join('|');
    s.sync[nk] = (s.sync[nk] || 0) + s.sync[k];
    delete s.sync[k];
  }
}

// Names identify people on the crew leaderboard, so two players can't share one.
function uniqueName(s, id, name) {
  const taken = new Set(s.players.filter((p) => p.id !== id).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name.slice(0, 13)} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

export function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

// "The Pancakes!" -> "pancake", "ice-cream" -> "icecream"
export function normalize(text) {
  let t = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the|some) /, '');
  t = t
    .split(' ')
    .map((w) => {
      if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
      if (w.length > 4 && /(ches|shes|xes|oes)$/.test(w)) return w.slice(0, -2);
      if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
      return w;
    })
    .join('');
  return t;
}

function connectedPlayers(s) {
  return s.players.filter((p) => p.connected);
}

export function enabledModes(settings) {
  const m = (settings && settings.modes) || {};
  const on = MODES.filter((k) => m[k]);
  return on.length ? on : ['words'];
}

// Mix of round types for the whole game: words twice as common, no special type twice in a row.
function buildPlan(s) {
  const on = enabledModes(s.settings);
  const bag = on.flatMap((m) => (m === 'words' && on.length > 1 ? [m, m] : [m]));
  const plan = [];
  let guard = 0;
  while (plan.length < s.settings.rounds && guard++ < 200) {
    for (const m of shuffle(bag)) {
      const prev = plan[plan.length - 1];
      if (m !== 'words' && m === prev && on.length > 1) continue;
      plan.push(m);
    }
  }
  plan.length = s.settings.rounds;
  // Start gently with a plain word round when it's available.
  const w = plan.indexOf('words');
  if (w > 0) [plan[0], plan[w]] = [plan[w], plan[0]];
  return plan;
}

function draw(s, mode) {
  s.decks ||= {};
  if (mode === 'words') {
    if (!s.deck.length) s.deck = buildDeck(s);
    return { prompt: s.deck.pop(), options: null };
  }
  const src = { sketch: SKETCHES, pick: PICKS, rather: RATHERS }[mode];
  if (!s.decks[mode] || !s.decks[mode].length) s.decks[mode] = shuffle(src.map((_, i) => i));
  const item = src[s.decks[mode].pop()];
  if (mode === 'sketch') return { prompt: item, options: null };
  if (mode === 'pick') return { prompt: item.q, options: item.o.slice() };
  return { prompt: 'Would you rather…', options: item.slice() };
}

function startRound(s) {
  s.round += 1;
  s.mode = (s.plan && s.plan[s.round - 1]) || 'words';
  const d = draw(s, s.mode);
  s.prompt = d.prompt;
  s.options = d.options;
  s.art = {};
  s.gallery = [];
  s.unveiled = true;
  s.answers = {};
  s.groups = [];
  s.points = {};
  s.phase = 'answer';
  const active = connectedPlayers(s);
  if (s.round % 3 === 0 && active.length >= 3) {
    s.type = 'spotlight';
    const min = Math.min(...active.map((p) => p.spot));
    const pool = active.filter((p) => p.spot === min);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pick.spot += 1;
    s.spotlight = pick.id;
  } else {
    s.type = 'crowd';
    s.spotlight = null;
  }
  const secs = s.settings.timer * (s.mode === 'sketch' ? 2 : 1);
  s.deadline = secs ? Date.now() + secs * 1000 : 0;
}

function buildDeck(s) {
  const custom = s.settings.custom
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 100);
  // Custom prompts go on top (end of array = drawn first), in shuffled order.
  return shuffle(PROMPTS).concat(shuffle(custom));
}

function reveal(s) {
  const byKey = new Map();
  for (const [id, raw] of Object.entries(s.answers)) {
    const key = normalize(raw);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { id: s.nextGroupId++, label: raw.trim(), members: [] });
    byKey.get(key).members.push(id);
  }
  s.groups = [...byKey.values()];
  // Choice rounds: show every option, even ones nobody picked.
  if (s.options) {
    for (const o of s.options) if (!byKey.has(normalize(o))) s.groups.push({ id: s.nextGroupId++, label: o, members: [] });
  }
  s.phase = 'reveal';
  s.deadline = 0;
  // Sketch rounds open on an anonymous gallery; the host then shows the answers.
  s.unveiled = s.mode !== 'sketch';
  s.gallery = shuffle(Object.keys(s.art).filter((id) => s.answers[id]));
  score(s);
}

// Points for the current round, derived from groups so merges/splits rescore instantly.
export function score(s) {
  const pts = {};
  for (const p of s.players) pts[p.id] = 0;
  const spotGroup = s.type === 'spotlight' && s.groups.find((g) => g.members.includes(s.spotlight));
  if (spotGroup) {
    for (const id of spotGroup.members) {
      if (id === s.spotlight) pts[id] = spotGroup.members.length - 1;
      else pts[id] = 2;
    }
  } else if (s.mode === 'rather') {
    // Read the room: 2 points for everyone on the (strict) majority side.
    const sizes = s.groups.map((g) => g.members.length).sort((a, b) => b - a);
    const top = s.groups.find((g) => g.members.length === sizes[0]);
    if (top && sizes[0] > (sizes[1] || 0) && sizes[0] > 1) for (const id of top.members) pts[id] = 2;
  } else {
    for (const g of s.groups) {
      if (g.members.length < 2) continue;
      for (const id of g.members) pts[id] = g.members.length - 1;
    }
  }
  s.points = pts;
  s.groups.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
}

function bank(s) {
  s.played += 1;
  const spotG = s.type === 'spotlight' && s.groups.find((g) => g.members.includes(s.spotlight));
  for (const p of s.players) {
    p.score += s.points[p.id] || 0;
    const g = s.groups.find((x) => x.members.includes(p.id));
    if (!g && !p.connected) continue;
    const st = (s.stats[p.id] ||= { rounds: 0, answered: 0, matched: 0, lone: 0, spotTurns: 0, spotMatchers: 0, spotTries: 0, spotHits: 0 });
    st.rounds++;
    if (!g) continue;
    st.answered++;
    if (g.members.length > 1) st.matched++;
    else st.lone++;
    if (spotG) {
      if (p.id === s.spotlight) {
        st.spotTurns++;
        st.spotMatchers += spotG.members.length - 1;
      } else {
        st.spotTries++;
        if (g === spotG) st.spotHits++;
      }
    }
  }
  for (const g of s.groups) {
    const m = g.members;
    for (let i = 0; i < m.length; i++)
      for (let j = i + 1; j < m.length; j++) {
        const k = [m[i], m[j]].sort().join('|');
        s.sync[k] = (s.sync[k] || 0) + 1;
      }
  }
  s.points = {};
}

function resetToLobby(s) {
  s.phase = 'lobby';
  s.round = 0;
  s.deck = [];
  s.plan = [];
  s.art = {};
  s.gallery = [];
  s.options = null;
  s.mode = 'words';
  s.unveiled = true;
  s.sync = {};
  s.answers = {};
  s.groups = [];
  s.points = {};
  s.stats = {};
  s.played = 0;
  s.gameId = null;
  s.save = null;
  s.players = s.players.filter((p) => p.connected);
  for (const p of s.players) { p.score = 0; p.spot = 0; }
}

function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

// Payload for Supabase submit_game(); null if there's nothing worth saving.
export function results(s) {
  const ps = s.players.filter((p) => s.stats[p.id] && s.stats[p.id].rounds);
  if (ps.length < 2 || !s.played || !s.gameId) return null;
  const top = Math.max(...ps.map((p) => p.score));
  const players = ps.map((p) => ({
    name: p.name,
    score: p.score,
    place: 1 + ps.filter((q) => q.score > p.score).length,
    won: top > 0 && p.score === top,
    ...s.stats[p.id],
  }));
  const pairs = [];
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const k = [ps[i].id, ps[j].id].sort().join('|');
      pairs.push({ a: ps[i].name, b: ps[j].name, n: s.sync[k] || 0 });
    }
  return { id: s.gameId, rounds: s.played, players, pairs };
}

// Returns true if state changed.
export function reduce(s, from, a) {
  const isHost = from === s.hostId;
  const me = s.players.find((p) => p.id === from);
  switch (a.t) {
    case 'join':
      return addPlayer(s, from, a.name, a.takeover);
    case 'leave':
      if (!me) return false;
      if (s.phase === 'lobby') s.players = s.players.filter((p) => p.id !== from);
      else me.connected = false;
      return maybeAutoReveal(s) || true;
    case 'answer': {
      if (s.phase !== 'answer' || !me) return false;
      let text = String(a.text || '').trim().slice(0, 40);
      if (s.options && text) {
        text = s.options.find((o) => o === String(a.text)) || '';
        if (!text) return false;
      }
      if (s.mode === 'sketch' && text) {
        const art = typeof a.art === 'string' && a.art.length <= MAX_ART && /^[A-Za-z0-9+/=]+$/.test(a.art) ? a.art : '';
        if (!art) return false;
        s.art[from] = art;
      }
      if (text) s.answers[from] = text;
      else { delete s.answers[from]; delete s.art[from]; }
      maybeAutoReveal(s);
      return true;
    }
  }
  if (!isHost) return false;
  switch (a.t) {
    case 'settings':
      if (s.phase !== 'lobby') return false;
      if ([5, 8, 12].includes(a.rounds)) s.settings.rounds = a.rounds;
      if ([0, 45, 90].includes(a.timer)) s.settings.timer = a.timer;
      if (typeof a.custom === 'string') s.settings.custom = a.custom.slice(0, 4000);
      if (MODES.includes(a.mode)) {
        const next = { ...s.settings.modes, [a.mode]: !s.settings.modes[a.mode] };
        if (MODES.some((k) => next[k])) s.settings.modes = next; // keep at least one on
      }
      return true;
    case 'kick':
      if (a.id === s.hostId) return false;
      s.players = s.players.filter((p) => p.id !== a.id);
      delete s.answers[a.id];
      if (s.phase === 'reveal') {
        for (const g of s.groups) g.members = g.members.filter((m) => m !== a.id);
        s.groups = s.groups.filter((g) => g.members.length || s.options);
        s.gallery = s.gallery.filter((m) => m !== a.id);
        score(s);
      }
      maybeAutoReveal(s);
      return true;
    case 'start':
      if (s.phase !== 'lobby' || connectedPlayers(s).length < 2) return false;
      s.gameId = newId();
      s.plan = buildPlan(s);
      startRound(s);
      return true;
    case 'reveal':
      if (s.phase !== 'answer') return false;
      reveal(s);
      return true;
    case 'merge': {
      if (s.phase !== 'reveal') return false;
      const ga = s.groups.find((g) => g.id === a.a);
      const gb = s.groups.find((g) => g.id === a.b);
      if (!ga || !gb || ga === gb) return false;
      const [keep, drop] = ga.members.length >= gb.members.length ? [ga, gb] : [gb, ga];
      keep.members.push(...drop.members);
      s.groups = s.groups.filter((g) => g !== drop);
      score(s);
      return true;
    }
    case 'split': {
      if (s.phase !== 'reveal') return false;
      const g = s.groups.find((x) => x.members.includes(a.id));
      if (!g || g.members.length < 2) return false;
      g.members = g.members.filter((m) => m !== a.id);
      s.groups.push({ id: s.nextGroupId++, label: s.answers[a.id], members: [a.id] });
      score(s);
      return true;
    }
    case 'unveil':
      if (s.phase !== 'reveal' || s.unveiled) return false;
      s.unveiled = true;
      return true;
    case 'next':
      if (s.phase !== 'reveal' || !s.unveiled) return false;
      bank(s);
      if (s.round >= s.settings.rounds) s.phase = 'final';
      else startRound(s);
      return true;
    case 'end':
      if (s.phase === 'reveal') bank(s);
      if (s.phase === 'lobby') return false;
      s.phase = 'final';
      return true;
    case 'again':
      resetToLobby(s);
      return true;
    case 'crew':
      // The host app verifies the code + PIN with Supabase before sending this.
      s.crew = a.crew && a.crew.slug ? { slug: String(a.crew.slug), name: String(a.crew.name || a.crew.slug) } : null;
      return true;
  }
  return false;
}

function maybeAutoReveal(s) {
  if (s.phase !== 'answer') return false;
  const active = connectedPlayers(s);
  if (active.length && active.every((p) => s.answers[p.id])) {
    reveal(s);
    return true;
  }
  return false;
}

export function tick(s) {
  if (s.phase === 'answer' && s.deadline && Date.now() >= s.deadline) {
    reveal(s);
    return true;
  }
  return false;
}

export function setConnected(s, id, on) {
  const p = s.players.find((x) => x.id === id);
  if (!p || p.connected === on) return false;
  p.connected = on;
  if (!on) maybeAutoReveal(s);
  return true;
}

// All drawings for the current sketch round, once they may be seen (after the reveal).
export function artFor(s) {
  if (s.mode !== 'sketch' || s.phase !== 'reveal') return null;
  return { round: s.round, art: { ...s.art } };
}

// What a given player is allowed to see.
export function viewFor(s, pid) {
  const v = {
    code: s.code,
    hostId: s.hostId,
    phase: s.phase,
    players: s.players.map(({ id, name, score, connected, color }) => ({ id, name, score, connected, color })),
    settings: { rounds: s.settings.rounds, timer: s.settings.timer, customCount: s.settings.custom.split('\n').filter((l) => l.trim()).length },
    round: s.round,
    prompt: s.prompt,
    type: s.type,
    spotlight: s.spotlight,
    remaining: s.deadline ? Math.max(0, s.deadline - Date.now()) : 0,
    crew: s.crew,
    save: s.save,
  };
  if (pid === s.hostId) v.custom = s.settings.custom;
  v.settings.modes = { ...s.settings.modes };
  v.mode = s.mode;
  v.options = s.options;
  if (s.phase === 'answer') {
    v.submitted = Object.keys(s.answers);
    v.mine = s.answers[pid] || '';
  }
  // Drawings travel separately (see artFor) so they aren't repeated in every player's view.
  if (s.phase === 'reveal' && !s.unveiled) {
    v.unveiled = false;
    v.gallery = s.gallery;
    v.noAnswer = [];
    v.points = {};
  } else if (s.phase === 'reveal') {
    v.unveiled = true;
    v.groups = s.groups.map((g) => ({ id: g.id, label: g.label, members: g.members.map((m) => ({ id: m, text: s.answers[m] })) }));
    v.points = s.points;
    v.noAnswer = s.players.filter((p) => !s.answers[p.id]).map((p) => p.id);
  }
  if (s.phase === 'final') {
    let best = null;
    for (const [k, n] of Object.entries(s.sync)) if (!best || n > best.n) best = { ids: k.split('|'), n };
    v.best = best;
    v.mystats = s.stats[pid] || null;
  }
  return v;
}
