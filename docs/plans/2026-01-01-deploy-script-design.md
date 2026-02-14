# Deploy Script Design

## Overview

A single `deploy.sh` script that handles complete server deployment, working on both fresh VPS installations and existing setups like mycaller.xyz.

## Requirements

- Idempotent - safe to run multiple times
- Auto-detects environment (system Caddy vs Docker Caddy)
- Interactive prompts with sensible defaults
- Full health verification after deployment

## Script Flow

```
deploy.sh
├── Detect environment (fresh vs existing)
├── Interactive prompts for configuration
├── Docker setup (build & start containers)
├── PostgreSQL password configuration
├── Caddy configuration (system or Docker)
├── Full health verification
└── Summary with access URLs
```

## Environment Detection

Runs first without user input:
- Check Docker and docker-compose installed
- Check if system Caddy is installed (systemd service)
- Check if PostgreSQL volume exists (existing data)
- Check if app is currently running

## Interactive Prompts

### Domain Configuration
```
Enter domain name [mycaller.xyz]: _
```
Default: hostname or previous value from Caddyfile

### Existing Data Handling
```
Existing database found. What would you like to do?
  1) Keep existing data (default)
  2) Reset everything (WARNING: destroys data)
Choice [1]: _
```

### PostgreSQL Password
```
PostgreSQL password:
  1) Use default (postgres) - for development
  2) Enter custom password
  3) Generate random password
Choice [1]: _
```

Credentials stored in `.env` file (gitignored).

## Docker Deployment Sequence

1. Build the app image: `docker compose build app`
2. Start infrastructure: `docker compose up -d postgres redis minio`
3. Wait for health checks (60s timeout)
4. Fix PostgreSQL password: `ALTER USER postgres WITH PASSWORD '...'`
5. Start app: `docker compose up -d app`
6. Wait for app health (30s timeout)

If reset mode chosen, runs `docker compose down -v` first.

## Caddy Configuration

### System Caddy (when detected)
Updates `/etc/caddy/Caddyfile`:
```
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:3005
}

www.${DOMAIN} {
    redir https://${DOMAIN}{uri} permanent
}
```
Then: `sudo systemctl reload caddy`

### Docker Caddy (fallback)
- Adds Caddy service to docker-compose.yml
- Creates Caddyfile in project directory
- Handles SSL via Let's Encrypt

### Port Conflicts
If ports 80/443 in use by unknown process, warn and ask user to resolve manually.

## Health Verification

Tests after deployment:
1. `GET /health` - expect `{"status":"ok"}`
2. `GET /` - expect 200
3. `GET /v1/updates/?EIO=4` - expect valid Socket.io SID
4. `GET https://${DOMAIN}/health` - expect `{"status":"ok"}`

Output:
```
Verifying deployment...

  OK  Health endpoint
  OK  Root endpoint
  OK  Socket.io
  OK  HTTPS (mycaller.xyz)

Deployment successful!

Access URLs:
  API:     https://mycaller.xyz
  Health:  https://mycaller.xyz/health
```

## File Changes

- Creates `deploy.sh` in project root
- Creates/updates `.env` with credentials
- Updates `/etc/caddy/Caddyfile` (if system Caddy)
- `.env` added to `.gitignore`
