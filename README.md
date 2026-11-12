# Delaware

A first-person shooter in a rainy neon city, played in the browser. Kill enemies and other players to earn mana, then spend it by asking the Architect (an AI) to bend the rules for a while: fly, change your gun, reshape the enemies.

## Stack

- **Game** — TypeScript + Three.js, built with Vite (`src/`).
- **Server** — Node 22 + Express + `ws` (`server/`). One process serves the built game, answers the Architect (`POST /api/mod`, calls the Claude API), and runs the multiplayer game (`/game` WebSocket).
- **CI/CD** — GitHub Actions: Docker → Cloud Run on push to `main`.

## Local development

```bash
task setup
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
task start                   # http://localhost:5173
```

In development the Vite server also runs the Architect and the multiplayer game, so one command is enough. Open the page in two browser windows to play against yourself. Add `?solo` to the address to stay out of multiplayer.

`task start:prod` builds everything and runs the production server on http://localhost:8080.

## How multiplayer works

There is one shared game and anyone who opens the page joins it (up to 16 players). The server relays positions and shots, referees kills, and owns the mana left on the ground when someone dies: 20% of their mana, which anyone can pick up for 60 seconds. A kill also pays the killer 10 mana.

Each player's own game decides what hit it and how much health it has left, and reports that to the server. That is fine among friends but is not cheat-proof.

## Deploy (Cloud Run)

`.github/workflows/delaware-deploy.yml` builds the image and deploys the `delaware` service to Cloud Run in `us-central1` on every push to `main`. Configure these repository secrets:

| Secret                    | Used for                          |
| ------------------------- | --------------------------------- |
| `GCP_SERVICE_ACCOUNT_KEY` | GCP auth + image registry         |
| `PROJECT_ID`              | GCP project                       |
| `ANTHROPIC_API_KEY`       | the Architect's calls to Claude   |

The service runs as **exactly one instance** (`--min-instances=1 --max-instances=1`), because the game lives in that process's memory and every player has to reach it. Cloud Run closes a connection after an hour at most; the game reconnects by itself.

Every Architect request costs money on the API key. Two settings limit that: `MOD_MIN_GAP_SECONDS` (how often one visitor may ask, default 8) and `MOD_DAILY_LIMIT` (requests per day across everyone, default 2000).

## Assets

- `public/models/soldier/Soldier.glb` — from the three.js examples repository. No licence is stated there for this file; check its terms before a public release.
- `public/models/arms/` — "PSX First Person Arms" by Drillimpact, CC0.
