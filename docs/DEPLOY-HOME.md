# Self-hosting behind a Cloudflare Tunnel

Run OpenMuse on an always-on Linux machine and reach it from anywhere at `https://open.example.com`, with no open router ports. `infra/compose.home.yaml` runs:

| Service | Role |
| --- | --- |
| `api` | API and durable task worker (live mode, PostgreSQL) |
| `web` | Caddy serving the web UI and proxying `/api` on the same origin |
| `postgres` | Database |
| `browser-worker` | Chromium sessions for the agent |
| `cloudflared` | Outbound tunnel to Cloudflare |

Only the UI is published on the machine itself, at `127.0.0.1:8080`. The Linux computer (Docker sandbox) is disabled because the API container would need the host's Docker socket.

Budget about 4 GB RAM and 40 GB disk; no GPU is needed because models run at your provider.

## 1. Install Docker (CachyOS / Arch)

```sh
sudo pacman -S --needed docker docker-compose docker-buildx git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in
```

Turn off automatic suspend on this machine; background work only runs while it is awake.

## 2. Create the tunnel and protect it

In the Cloudflare dashboard (**Zero Trust**):

1. **Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Copy the tunnel token.
2. In the tunnel, add a **Public hostname**: `open.example.com` → service `HTTP`, URL `web:80`.
3. **Access → Applications → Add → Self-hosted** for `open.example.com`, with a policy that allows only your email address.

OpenMuse's own access key stays on as a second lock behind Access.

## 3. Configure

```sh
git clone -b no-intelligence https://github.com/capt-marbles/openmuse.git
cd openmuse
cp .env.example .env
sudo install -d -o 1000 -g 1000 -m 700 /srv/openmuse   # the API runs as uid 1000
```

Set these in `.env`:

```dotenv
PUBLIC_API_URL=https://open.example.com
ALLOWED_ORIGINS=https://open.example.com
OPENMUSE_DATA_DIR=/srv/openmuse
MODEL=anthropic/your-model-id   # or chatgpt/<model> and Sign in with ChatGPT in Apps
ANTHROPIC_API_KEY=...
OPENMUSE_ACCESS_KEY=...        # openssl rand -hex 24
TOKEN_ENCRYPTION_KEY=...       # openssl rand -base64 32
WORKER_TOKEN=...               # openssl rand -hex 24
POSTGRES_PASSWORD=...          # openssl rand -hex 16
CLOUDFLARE_TUNNEL_TOKEN=...    # from step 2
```

The web UI is built for `PUBLIC_API_URL`, so use that address from every device, including this one. For bots, copy `bots.example.json` to `/srv/openmuse/bots.json` and add its variables to `.env`. For Google, register `https://open.example.com/api/google/callback` as the OAuth redirect URI.

## 4. Start

```sh
docker compose --env-file .env -f infra/compose.home.yaml up -d --build
docker compose --env-file .env -f infra/compose.home.yaml ps
```

Every service restarts with Docker after a reboot. Open `https://open.example.com`, pass Cloudflare Access, then enter the OpenMuse access key.

## Operating it

- **Update:** `git pull`, then run the `up -d --build` command again.
- **Logs:** `docker compose --env-file .env -f infra/compose.home.yaml logs -f api`
- **Back up** both the database and the data directory (signing key, PDFs, `bots.json`):

  ```sh
  docker compose --env-file .env -f infra/compose.home.yaml exec -T postgres \
    pg_dump -U openmuse openmuse > openmuse-$(date +%F).sql
  sudo tar czf openmuse-data-$(date +%F).tgz /srv/openmuse
  ```

- **Phones:** the web UI works in any mobile browser. The native iOS/Android app cannot complete a Cloudflare Access login; it needs Cloudflare WARP enrolled in your Zero Trust organization, or an Access service token.
- Run one `api` instance. Conversation threads are served from an in-process index.
