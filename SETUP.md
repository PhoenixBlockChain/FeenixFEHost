# Feenix FE Host — Setup Guide

Serves every app on the Feenix network at `<app_name>.feenix.network`.
Polls the blockchain every 60 seconds for new apps and updates.

---

## 1. Lightsail Instance

### Create the instance

1. Go to **AWS Lightsail** → **Create instance**
2. Pick **Linux/Unix** → **OS Only** → **Ubuntu 22.04 LTS**
3. Choose a plan ($5/mo is fine to start — 1 GB RAM, 1 vCPU)
4. Name it something like `feenix-fe-host`
5. Click **Create instance**

### Open ports

1. Go to the instance → **Networking** tab
2. Under **IPv4 Firewall**, add these rules:
   - **HTTP** — TCP 80 (required)
   - **HTTPS** — TCP 443 (required)
   - **SSH** — TCP 22 (already open by default)
3. Save

### Note your static IP

1. In the **Networking** tab, click **Create static IP**
2. Attach it to your instance
3. Write down the IP — you'll need it for Cloudflare (e.g. `44.201.xxx.xxx`)

---

## 2. Cloudflare DNS

You need a wildcard record so that `*.feenix.network` points to your Lightsail server.

### Add the wildcard record

1. Log into **Cloudflare** → select **feenix.network**
2. Go to **DNS** → **Records**
3. Click **Add record**:
   - **Type:** `A`
   - **Name:** `*`
   - **IPv4 address:** your Lightsail static IP (e.g. `44.201.xxx.xxx`)
   - **Proxy status:** **Proxied** (orange cloud ON)
   - **TTL:** Auto
4. Click **Save**

### Verify existing records are safe

Make sure these specific records already exist and are untouched:
- `feenix.network` (root domain) — your main website
- `api.feenix.network` — blockchain API
- `middleware.feenix.network` — middleware service

Specific records always take priority over the wildcard, so those won't break.

### SSL settings

1. Go to **SSL/TLS** → **Overview**
2. Set encryption mode to **Flexible**
   - This means: Cloudflare handles HTTPS for visitors, talks to your server over HTTP on port 80
   - If you later add a cert to the server, switch to **Full**
3. Go to **SSL/TLS** → **Edge Certificates**
4. Make sure **Always Use HTTPS** is ON
5. Make sure **Automatic HTTPS Rewrites** is ON

After this step, any request to `anything.feenix.network` will:
- Resolve via Cloudflare (wildcard `*` record)
- Get automatic HTTPS from Cloudflare
- Forward to your Lightsail server on port 80

---

## 3. Server Setup

SSH into your Lightsail instance:

```bash
ssh ubuntu@YOUR_LIGHTSAIL_IP
```

### Install Docker

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sudo sh

# Add your user to the docker group (so you don't need sudo)
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
```

SSH back in:

```bash
ssh ubuntu@YOUR_LIGHTSAIL_IP
```

Verify Docker works:

```bash
docker --version
docker compose version
```

Both should print version numbers. If `docker compose` isn't found, install the plugin:

```bash
sudo apt install docker-compose-plugin -y
```

### Install Git

```bash
sudo apt install git -y
```

---

## 4. Clone and Start

```bash
# Clone the repo
git clone https://github.com/PhoenixBlockChain/FeenixFEHost.git
cd FeenixFEHost

# Start everything
./runner.sh start
```

This will:
1. Pull the latest code from the repo
2. Build the Docker images (Node.js poller + Nginx)
3. Start both containers in the background
4. Begin polling the blockchain every 60 seconds
5. Start writing logs to `feenix-fe-host.log`

### Verify it's working

```bash
# Check status
./runner.sh status

# Check logs
./runner.sh logs
```

You should see output like:
```
[poll] Fetching app metadata from blockchain...
[poll] Found 22 total APP_BE transaction(s)
[poll] 4 unique app author(s)
[poll] New app: "MusicApp" → musicapp.feenix.network
[poll] Deployed "MusicApp" at musicapp.feenix.network
...
```

### Test a subdomain

From your local machine, open a browser and go to:

```
https://musicapp.feenix.network
```

If you see the app's frontend, everything is working.

---

## 5. Runner Commands Reference

| Command | What it does |
|---|---|
| `./runner.sh start` | Pull latest code, build, start services |
| `./runner.sh stop` | Stop all services |
| `./runner.sh restart` | Pull latest, rebuild, restart |
| `./runner.sh logs` | Print last 1000 log lines |
| `./runner.sh status` | Show whether services are running |

---

## 6. Auto-Restart on Reboot

To make the FE Host start automatically when the server reboots:

```bash
# Open crontab
crontab -e
```

Add this line at the bottom:

```
@reboot cd /home/ubuntu/FeenixFEHost && ./runner.sh start >> /home/ubuntu/feenix-boot.log 2>&1
```

Save and exit.

---

## 7. Updating

When new code is pushed to the repo:

```bash
cd /home/ubuntu/FeenixFEHost
./runner.sh restart
```

This pulls the latest code, rebuilds containers, and restarts everything. The poller picks up all changes automatically.

---

## Troubleshooting

### "permission denied" on runner.sh

```bash
chmod +x runner.sh
```

### Docker says "permission denied"

You need to be in the `docker` group:

```bash
sudo usermod -aG docker $USER
# Then log out and back in
```

### Subdomain shows Cloudflare error page

- Check that the wildcard `*` A record exists in Cloudflare DNS
- Check that the IP matches your Lightsail static IP
- Check that ports 80 and 443 are open in Lightsail firewall
- Check that Nginx is running: `./runner.sh status`

### Poller can't reach the blockchain API

```bash
# Test from the server
curl -s http://api.feenix.network/api/v1/get?lastBlockHash=0 | head -c 200
```

If this times out, your Lightsail outbound networking may be blocked (unlikely but check security groups).

### Apps show 404

The app might have an empty `frontend_codebase` on the blockchain. Check logs:

```bash
./runner.sh logs | grep "No frontend_codebase"
```

### Need to wipe and start fresh

```bash
./runner.sh stop
docker volume rm feenixfehost_apps 2>/dev/null || true
rm -f state.json
./runner.sh start
```
