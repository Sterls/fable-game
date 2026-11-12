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

## Files

| File | Purpose |
| --- | --- |
| `js/game.js` | Game rules: rounds, scoring, merging, and what each player can see |
| `js/net.js` | Transport: PeerJS, plus BroadcastChannel for `?local=1` testing |
| `js/app.js` | UI and session handling |
| `js/prompts.js` | Built-in prompts (~160) |
| `vendor/peerjs.min.js` | PeerJS 1.5.4 (MIT), vendored so the app works offline and inside app wrappers |
