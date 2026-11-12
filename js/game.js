// Pure game rules. The host owns a `state` object and feeds actions through `reduce`.
import { PROMPTS, shuffle } from './prompts.js';

export const COLORS = ['#7c9a92', '#c28f6b', '#8a8fbf', '#b5838d', '#6d9dc5', '#a3a86b', '#c9a227', '#9c7bb0', '#5f9e7a', '#c47a7a', '#6b8fa3', '#a68a64'];
export const MAX_PLAYERS = 12;

export function newGame(code, hostId, hostName) {
  const s = {
    code,
    hostId,
    phase: 'lobby',
    players: [],
    settings: { rounds: 8, timer: 0, custom: '' },
    deck: [],
    round: 0,
    prompt: '',
    type: 'crowd',
    spotlight: null,
    answers: {},
    groups: [],
    points: {},
    sync: {},
    deadline: 0,
    nextGroupId: 1,
    updated: Date.now(),
  };
  addPlayer(s, hostId, hostName);
  return s;
}

function addPlayer(s, id, name) {
  name = cleanName(name);
  const existing = s.players.find((p) => p.id === id);
  if (existing) {
    existing.name = name || existing.name;
    existing.connected = true;
    return true;
  }
  if (s.players.length >= MAX_PLAYERS) return false;
  const used = new Set(s.players.map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length];
  s.players.push({ id, name: name || 'Player', score: 0, connected: true, color, spot: 0 });
  return true;
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

function startRound(s) {
  if (!s.deck.length) s.deck = buildDeck(s);
  s.round += 1;
  s.prompt = s.deck.pop();
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
  s.deadline = s.settings.timer ? Date.now() + s.settings.timer * 1000 : 0;
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
  s.phase = 'reveal';
  s.deadline = 0;
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
  for (const p of s.players) p.score += s.points[p.id] || 0;
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
  s.sync = {};
  s.answers = {};
  s.groups = [];
  s.points = {};
  s.players = s.players.filter((p) => p.connected);
  for (const p of s.players) { p.score = 0; p.spot = 0; }
}

// Returns true if state changed.
export function reduce(s, from, a) {
  const isHost = from === s.hostId;
  const me = s.players.find((p) => p.id === from);
  switch (a.t) {
    case 'join':
      return addPlayer(s, from, a.name);
    case 'leave':
      if (!me) return false;
      if (s.phase === 'lobby') s.players = s.players.filter((p) => p.id !== from);
      else me.connected = false;
      return maybeAutoReveal(s) || true;
    case 'answer': {
      if (s.phase !== 'answer' || !me) return false;
      const text = String(a.text || '').trim().slice(0, 40);
      if (text) s.answers[from] = text;
      else delete s.answers[from];
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
      return true;
    case 'kick':
      if (a.id === s.hostId) return false;
      s.players = s.players.filter((p) => p.id !== a.id);
      delete s.answers[a.id];
      if (s.phase === 'reveal') {
        for (const g of s.groups) g.members = g.members.filter((m) => m !== a.id);
        s.groups = s.groups.filter((g) => g.members.length);
        score(s);
      }
      maybeAutoReveal(s);
      return true;
    case 'start':
      if (s.phase !== 'lobby' || connectedPlayers(s).length < 2) return false;
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
    case 'next':
      if (s.phase !== 'reveal') return false;
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
  };
  if (pid === s.hostId) v.custom = s.settings.custom;
  if (s.phase === 'answer') {
    v.submitted = Object.keys(s.answers);
    v.mine = s.answers[pid] || '';
  }
  if (s.phase === 'reveal') {
    v.groups = s.groups.map((g) => ({ id: g.id, label: g.label, members: g.members.map((m) => ({ id: m, text: s.answers[m] })) }));
    v.points = s.points;
    v.noAnswer = s.players.filter((p) => !s.answers[p.id]).map((p) => p.id);
  }
  if (s.phase === 'final') {
    let best = null;
    for (const [k, n] of Object.entries(s.sync)) if (!best || n > best.n) best = { ids: k.split('|'), n };
    v.best = best;
  }
  return v;
}
