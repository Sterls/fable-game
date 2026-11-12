// Crew leaderboard screen. Pure rendering from the get_leaderboard() payload.

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const ratio = (n, d) => (d ? n / d : 0);

export const SORTS = {
  wins: { label: 'Wins', value: (p) => p.wins, show: (p) => `${p.wins}`, unit: (p) => (p.wins === 1 ? 'win' : 'wins') },
  winrate: { label: 'Win %', value: (p) => ratio(p.wins, p.games), show: (p) => `${pct(p.wins, p.games)}%`, unit: () => 'win rate' },
  sync: { label: 'In sync', value: (p) => ratio(p.matched, p.answered), show: (p) => `${pct(p.matched, p.answered)}%`, unit: () => 'in sync' },
  ppr: { label: 'Pts/round', value: (p) => ratio(p.points, p.rounds), show: (p) => ratio(p.points, p.rounds).toFixed(1), unit: () => 'pts / round' },
};

// Small, friendly titles. Only awarded once someone has played enough to mean something.
function badges(players) {
  const out = {};
  const give = (name, label) => { (out[name] ||= []).push(label); };
  const eligible = players.filter((p) => p.games >= 2);
  const pool = eligible.length >= 2 ? eligible : [];
  const best = (list, f) => {
    if (!list.length) return null;
    const top = Math.max(...list.map(f));
    if (top <= 0) return null;
    const winners = list.filter((p) => f(p) === top);
    return winners.length === 1 ? winners[0] : null;
  };
  const hive = best(pool, (p) => ratio(p.matched, p.answered));
  if (hive) give(hive.name, 'Hive mind');
  const wild = best(pool, (p) => ratio(p.lone, p.answered));
  if (wild) give(wild.name, 'Wildcard');
  const star = best(pool.filter((p) => p.spot_turns >= 1), (p) => ratio(p.spot_matchers, p.spot_turns));
  if (star) give(star.name, 'Open book');
  const reader = best(pool.filter((p) => p.spot_tries >= 2), (p) => ratio(p.spot_hits, p.spot_tries));
  if (reader) give(reader.name, 'Mind reader');
  return out;
}

function bestMatch(name, pairs) {
  let best = null;
  for (const q of pairs) {
    if (q.a !== name && q.b !== name) continue;
    if (!q.shared) continue;
    const rate = q.matches / q.shared;
    if (!best || rate > best.rate) best = { other: q.a === name ? q.b : q.a, rate, q };
  }
  return best;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function boardScreen(b) {
  const back = '<button class="link" id="b-board-back">← Back</button>';
  if (b.err) return `${back}<section class="card"><p>${esc(b.err)}</p><button id="b-board-retry" class="ghost">Try again</button></section>`;
  if (!b.data) return `${back}<section class="card center"><p class="muted">Loading leaderboard…</p></section>`;

  const { crew, players, pairs, recent } = b.data;
  const sort = SORTS[b.sort] || SORTS.wins;
  const ranked = players
    .slice()
    .sort((x, y) => sort.value(y) - sort.value(x) || y.games - x.games || x.name.localeCompare(y.name));
  const tags = badges(players);

  let rank = 0;
  let prev = null;
  const rows = ranked.map((p, i) => {
    const val = sort.value(p);
    if (val !== prev) { rank = i + 1; prev = val; }
    const open = b.open === p.name;
    const bm = bestMatch(p.name, pairs);
    return `
    <li class="lb-row ${open ? 'open' : ''}" data-lb="${esc(p.name)}" tabindex="0" role="button" aria-expanded="${open}">
      <div class="lb-main">
        <span class="lb-rank">${rank}</span>
        <span class="lb-name">${esc(p.name)}${(tags[p.name] || []).map((t) => `<span class="badge">${t}</span>`).join('')}</span>
        <span class="lb-val">${sort.show(p)}<small>${sort.unit(p)}</small></span>
      </div>
      <div class="lb-sub muted">${p.games} game${p.games === 1 ? '' : 's'} · ${p.wins} win${p.wins === 1 ? '' : 's'} · ${pct(p.matched, p.answered)}% in sync</div>
      ${open ? `
      <dl class="lb-detail">
        <div><dt>Points per round</dt><dd>${ratio(p.points, p.rounds).toFixed(2)}</dd></div>
        <div><dt>Rounds matched</dt><dd>${p.matched} of ${p.answered}</dd></div>
        <div><dt>Lone answers</dt><dd>${pct(p.lone, p.answered)}%</dd></div>
        <div><dt>In the spotlight</dt><dd>${p.spot_turns ? `${ratio(p.spot_matchers, p.spot_turns).toFixed(1)} matched them on average` : 'Not yet'}</dd></div>
        <div><dt>Matching the spotlight</dt><dd>${p.spot_tries ? `${p.spot_hits} of ${p.spot_tries}` : 'Not yet'}</dd></div>
        <div><dt>Best match</dt><dd>${bm ? `${esc(bm.other)} (${Math.round(bm.rate * 100)}%)` : '—'}</dd></div>
        <div><dt>Last played</dt><dd>${fmtDate(p.last_played)}</dd></div>
      </dl>` : ''}
    </li>`;
  }).join('');

  const syncPairs = pairs
    .filter((q) => q.shared >= 3)
    .map((q) => ({ ...q, rate: q.matches / q.shared }))
    .sort((x, y) => y.rate - x.rate || y.matches - x.matches)
    .slice(0, 5);

  return `
  ${back}
  <section class="card center">
    <p class="muted small">Crew leaderboard</p>
    <h1>${esc(crew.name)}</h1>
    <p class="muted small">${crew.games} game${crew.games === 1 ? '' : 's'} played · code <b class="mono">${esc(crew.slug)}</b></p>
    <button id="b-board-share" class="ghost">Share leaderboard</button>
  </section>
  ${players.length ? `
  <div class="seg seg-wide" role="group" aria-label="Sort by">
    ${Object.entries(SORTS).map(([k, s]) => `<button data-sort="${k}" class="${(b.sort || 'wins') === k ? 'on' : ''}">${s.label}</button>`).join('')}
  </div>
  <ol class="lb">${rows}</ol>
  <p class="muted small center">Tap a name for details.</p>` : `
  <section class="card center"><p class="muted">No games saved yet. Finish a game with this crew linked and the results show up here.</p></section>`}
  ${syncPairs.length ? `
  <section class="card">
    <h2>Most in sync</h2>
    <ol class="pairs">${syncPairs.map((q) => `
      <li><span>${esc(q.a)} &amp; ${esc(q.b)}</span><span class="muted small">${Math.round(q.rate * 100)}% · ${q.matches} of ${q.shared} rounds</span></li>`).join('')}
    </ol>
  </section>` : ''}
  ${recent.length ? `
  <section class="card">
    <h2>Recent games</h2>
    <ol class="pairs">${recent.map((g) => `
      <li><span>${g.winners.length ? esc(g.winners.join(' & ')) + (g.winners.length > 1 ? ' tied' : ' won') : 'No winner'}</span>
          <span class="muted small">${fmtDate(g.played_at)} · ${g.player_count} players · ${g.rounds} rounds</span></li>`).join('')}
    </ol>
  </section>` : ''}`;
}
