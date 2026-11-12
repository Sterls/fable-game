# Common Ground

A calm party game for a group of friends. Everyone answers the same prompt in secret, like *"A pizza topping"*. You score **1 point for each other player who wrote the same thing**.

- **Turn-based, so ping doesn't matter.** Nothing is time-critical. The round timer is off by default.
- **Low-key visuals.** Soft colors, no sound, no flashing. Dark mode follows the device setting, and the app honors reduced-motion settings.
- **Every player uses their own device.** Phones, tablets, and computers can all play together. Up to 12 players.
- **No server to run.** The site is plain static files. Game messages are relayed through Supabase Realtime, so it works on any Wi-Fi or cellular network.

## How a game goes

1. One person taps **Create a new room** and shares the 4-letter code or the invite link.
2. Each round shows a prompt. Everyone types an answer and taps **Lock it in**. You can change your answer until the reveal.
3. When everyone is in, or the host taps **Reveal now**, matching answers are grouped and scored. Grouping ignores capitalization, punctuation, "a/the", and plurals.
4. The host can **merge** two answers that mean the same thing ("NYC" and "New York") by tapping both. Tapping a name **splits** that answer back out.
5. **Spotlight rounds** (every 3rd round, with 3+ players): try to match one chosen player. Matching them is worth 2 points, and they get 1 for each person who matched.
6. **Round types** mix through the game (the host can turn each on or off in the lobby):
   - **Words:** type an answer (the classic round).
   - **Sketch:** draw your answer and add a short hidden label. The reveal opens on an anonymous gallery, then the host shows who drew what; scoring uses the labels.
   - **Quick pick:** tap one of four options.
   - **Would you rather 🌶️:** a spicy (not explicit) two-way dilemma. Everyone on the majority side scores 2; a tie scores nothing.
7. At the end you see the winner and the **most in-sync pair**.

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
- Each room is a Supabase Realtime broadcast channel (`commonground-v2-<CODE>`). Every device makes an ordinary outbound WebSocket to Supabase, so home routers, carrier networks and firewalls don't get in the way. (An earlier version used direct peer-to-peer WebRTC, which failed between phones on different networks.)
- Realtime needs no database tables and no extra setup beyond the publishable key in `js/config.js`. The free tier allows 200 simultaneous connections and 2 million messages a month. A game uses a few hundred messages.
- **Reconnecting:**
  - A player whose phone sleeps reconnects automatically and keeps their score.
  - Joining again with the same name from another device or browser offers to take over your old spot, score included.
  - A host who reloads the page can tap **Resume hosting room XXXX**, and players reattach on their own.
- **Keeping the host alive:** the host's device holds the game. If the host closes it, the room ends, though the host can resume within a few hours. On phones, the host should keep the screen awake.
- **Privacy:** messages aren't encrypted end to end between players. Someone using browser developer tools could see other players' answers before the reveal. That's fine for friends, but don't use it for anything secret.

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
| `js/net.js` | Transport: Supabase Realtime, plus BroadcastChannel for `?local=1` testing |
| `js/app.js` | UI and session handling |
| `js/prompts.js` | Built-in prompts: ~160 word prompts, 42 sketch prompts, 40 quick picks, 40 would-you-rathers |
| `js/sketch.js` | Drawing pad and compact stroke encoding |
| `js/crew.js`, `js/config.js` | Supabase client and project settings |
| `js/board.js` | Crew leaderboard screen |
| `supabase/schema.sql` | Database tables and functions (paste into the Supabase SQL editor) |
| `vendor/supabase.js` | supabase-js 2.45.4 (MIT), vendored so the app works inside app wrappers |
