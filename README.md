# Common Ground

A calm party game for a group of friends. Everyone answers the same prompt in secret, like *"A pizza topping"*. You score **1 point for each other player who wrote the same thing**.

- **Turn-based, so ping doesn't matter.** Nothing is time-critical. The round timer is off by default.
- **Low-key visuals.** Soft colors, no sound, no flashing. Dark mode follows the device setting, and the app honors reduced-motion settings.
- **Every player uses their own device.** Phones, tablets, and computers can all play together. Up to 12 players.
- **No server to run.** The site is plain static files. Players connect peer-to-peer (WebRTC via [PeerJS](https://peerjs.com)).

## How a game goes

1. One person taps **Create a new room** and shares the 4-letter code or the invite link.
2. Each round shows a prompt. Everyone types an answer and taps **Lock it in**. You can change your answer until the reveal.
3. When everyone is in, or the host taps **Reveal now**, matching answers are grouped and scored. Grouping ignores capitalization, punctuation, "a/the", and plurals.
4. The host can **merge** two answers that mean the same thing ("NYC" and "New York") by tapping both. Tapping a name **splits** that answer back out.
5. **Spotlight rounds** (every 3rd round, with 3+ players): try to match one chosen player. Matching them is worth 2 points, and they get 1 for each person who matched.
6. At the end you see the winner and the **most in-sync pair**.

The host can choose 5, 8 or 12 rounds, set an optional 45 or 90 second timer, and add custom prompts (inside jokes work well). Custom prompts are played first.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. To test multiplayer on one computer without the internet, open several tabs at `http://localhost:8000/?local=1`. Each tab acts as a separate player.

## Deploy

**GitHub Pages:** go to the repo's **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then pick the branch and `/ (root)`. The game will be at `https://<user>.github.io/<repo>/`.

**Cloudflare Pages:** create a project from this repo with no build command and `/` as the output directory.

Bump `VERSION` in `sw.js` whenever you deploy, so installed copies pick up the changes.

## App stores (PWABuilder)

The site is a full PWA: it has a manifest, a service worker, and 192px, 512px and maskable icons. Once it's deployed over HTTPS, enter the URL at https://www.pwabuilder.com to generate Android (Play Store), iOS, and Windows packages.

## How networking works

- The host's browser holds the game state and is the authority. Other players send actions to the host and get back their own view of the state. During a round, no one sees anyone else's answers.
- Connections use the free public PeerJS server for the initial handshake. Gameplay data then goes directly between devices, with PeerJS's TURN relay as a fallback.
- **Reconnecting:**
  - A player whose phone sleeps reconnects automatically and keeps their score.
  - A host who reloads the page can tap **Resume hosting room XXXX**.
- **Keeping the host alive:** the host's device must stay on the game. If the host closes it, the room ends. On phones, the host should keep the screen awake.
- **If you outgrow PeerJS:** if some networks (strict corporate or school Wi-Fi) block peer-to-peer connections, or you want rooms to survive the host leaving, `js/net.js` is the only file to change. A Cloudflare Worker with a Durable Object would make a good drop-in relay, since it fits the same small host/client interface.

## Crew stats & leaderboard (Supabase)

A **crew** is a friend group with a permanent, shared leaderboard. The host links a crew in the lobby, and every finished game is saved to it automatically.

**What's tracked:**
- **Each player:** wins, win rate, points per round, and "in sync" (the share of rounds where someone matched you).
- **Lone answers:** rounds where nobody matched you.
- **Spotlight:** how many people matched you, and how often you matched the spotlight player.
- **Pairs:** a sync rate for every pair of players.
- **Badges:** Hive mind, Wildcard, Open book and Mind reader, awarded after 2+ games.

**Setup (one time):**
1. In the Supabase dashboard, open the **SQL editor**, paste in `supabase/schema.sql` and run it.
2. Under **Project Settings → API Keys**, copy the **publishable** key (or the legacy `anon` key) into `SUPABASE_KEY` in `js/config.js`. This key is meant to be public.

**Using it:**
- In the lobby, the host taps **Create a crew** and picks a name and PIN. Players get a crew code like `game-night-k7qp`.
- Anyone with the code can view the leaderboard. They can open it from the home screen or a `?crew=<code>` link.
- Saving a game requires the PIN, and the host's device remembers it.
- Players are matched by name within a crew, ignoring case. Keep using the same name to keep your stats.

**Security:**
- The browser can't read or write the tables directly. Row-level security is on, there are no policies, and table grants are revoked.
- The browser can only call four functions: `create_crew`, `check_crew`, `submit_game` and `get_leaderboard`.
- PINs are stored as bcrypt hashes.
- Saving the same game twice is ignored.

## Files

| File | Purpose |
| --- | --- |
| `js/game.js` | Game rules: rounds, scoring, merging, and what each player can see |
| `js/net.js` | Transport: PeerJS, plus BroadcastChannel for `?local=1` testing |
| `js/app.js` | UI and session handling |
| `js/prompts.js` | Built-in prompts (~160) |
| `js/crew.js`, `js/config.js` | Supabase client and project settings |
| `js/board.js` | Crew leaderboard screen |
| `supabase/schema.sql` | Database tables and functions (paste into the Supabase SQL editor) |
| `vendor/peerjs.min.js` | PeerJS 1.5.4 (MIT), vendored so the app works offline and inside app wrappers |
