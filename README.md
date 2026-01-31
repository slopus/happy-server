# Happy Server (Lite)

A slimmed-down fork of [Happy Server](https://github.com/anthropics/happy-server) - the synchronization backend for end-to-end encrypted Claude Code clients.

This version removes external dependencies (PostgreSQL, Redis, MinIO) in favor of a single SQLite database file, making it trivial to self-host.

## What Changed

| Original | This Fork |
|----------|-----------|
| PostgreSQL | SQLite |
| Redis | Removed (unused) |
| MinIO/S3 | Removed (uses GitHub avatar URLs directly) |
| Multiple containers | Single process + file |

## Features

- **Zero Knowledge** - Server stores encrypted data it cannot decrypt
- **Single File Database** - Just SQLite, no external dependencies
- **Easy Self-Hosting** - Deploy anywhere that runs Node.js
- **Real-time Sync** - WebSocket-based sync across devices
- **Cryptographic Auth** - Public key signatures, no passwords

## Requirements

- Node.js 20+
- Yarn

## Local Development

```bash
# Install dependencies
yarn install

# Create database and start server
yarn db:push
yarn dev
```

Server runs at `http://localhost:3005`

## Self-Hosting

### Option 1: Fly.io (Recommended)

**Cost estimate:** ~$1.50/month (8 hours/day usage) or ~$3.15/month (always on)

| Resource | Always On | 8 hrs/day |
|----------|-----------|-----------|
| VM (shared-cpu-1x, 512MB) | $2.68/mo | ~$1.35/mo |
| Volume (1GB) | $0.15/mo | $0.15/mo |
| **Total** | **~$3/mo** | **~$1.50/mo** |

The server auto-scales to zero when no clients are connected. Note: WebSocket connections (mobile app, CLI daemons) keep the server running. It only scales down when all clients disconnect.

**Deployment:**

```bash
# Install Fly CLI and authenticate
brew install flyctl
fly auth login

# Launch app
fly launch --no-deploy
```

When prompted:
- **App name:** Choose a name (e.g., `happy-server`)
- **Region:** Pick one close to you (e.g., `lhr` for London)
- **PostgreSQL/Redis:** No (we use SQLite)

```bash
# Create persistent volume for SQLite database
fly volumes create happy_data --region lhr --size 1

# Set your master secret (used for internal encryption)
fly secrets set HANDY_MASTER_SECRET="$(openssl rand -base64 32)"

# Deploy
fly deploy
```

**Custom domain (optional):**

```bash
fly certs add your-domain.com
```

Then add a DNS record:
- **CNAME:** `your-domain.com` → `your-app.fly.dev`

### Option 2: Any VPS / Docker

```bash
# Build
docker build -t happy-server .

# Run with persistent volume
docker run -d \
  -p 3000:3000 \
  -v happy_data:/data \
  -e DATABASE_URL="file:/data/happy.db" \
  -e HANDY_MASTER_SECRET="your-secret-here" \
  happy-server
```

### Option 3: Coolify / Railway / etc.

Set these environment variables:
- `DATABASE_URL=file:/data/happy.db`
- `HANDY_MASTER_SECRET=<random-secret>`
- `PORT=3000`

Mount a persistent volume at `/data`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | SQLite path, e.g. `file:/data/happy.db` |
| `HANDY_MASTER_SECRET` | Yes | Secret for internal encryption (OAuth tokens, etc.) |
| `PORT` | No | Server port (default: 3000) |
| `METRICS_ENABLED` | No | Enable Prometheus metrics (default: false) |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Mobile App    │     │   CLI Daemon    │
│  (has master    │     │  (encrypts all  │
│   keypair)      │     │   data locally) │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │  encrypted blobs      │
         ▼                       ▼
┌─────────────────────────────────────────┐
│            Happy Server                 │
│                                         │
│  • Stores encrypted data it can't read  │
│  • Syncs between devices via WebSocket  │
│  • Single SQLite file                   │
└─────────────────────────────────────────┘
```

## License

MIT
