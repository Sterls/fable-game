// Thin client for the Supabase functions in supabase/schema.sql (no SDK needed).
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const crewEnabled = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  // Legacy anon keys are JWTs and also go in Authorization; new sb_publishable_ keys don't.
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY;
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  } catch {
    throw new Error('Could not reach the stats server. Check your connection.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.message) || `Stats server error (${res.status}).`);
  return body;
}

export const createCrew = (name, pin) => rpc('cg_create_crew', { p_name: name, p_pin: pin });
export const checkCrew = (slug, pin) => rpc('cg_check_crew', { p_slug: slug, p_pin: pin });
export const submitGame = (slug, pin, game) => rpc('cg_submit_game', { p_slug: slug, p_pin: pin, p_game: game });
export const getLeaderboard = (slug) => rpc('cg_get_leaderboard', { p_slug: slug });

export function cleanSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}
