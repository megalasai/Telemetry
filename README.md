# Fleetel Telemetry

Standalone GPS ingest for **Fleetel-Switchride**. Deploy this repo on a **droplet or VM with a public IP**. Do **not** `docker build` from [Digi-Switchride](https://github.com/megalasai/Digi-Switchride) — that workspace install OOMs on a small droplet.

Admin and API stay on App Platform. This process writes GPS into the **same MongoDB**.

**WanWay / GT06 TCP:** `21100`, `5001`, `8821`  
**HTTP health / JSON ingest:** `4200`  
**JSON/CSV TCP:** `4210`

## Minimum droplet

- **2 GB RAM / 1 vCPU** (`s-1vcpu-2gb`), **Ubuntu 24.04**, **BLR1**, public IPv4
- Cloud Firewall: SSH 22 (your IP); TCP 4200, 4210, 21100, 5001, 8821
- Mongo **Trusted sources**: add this droplet

## Deploy

On a 2 GB droplet, add swap **before** Docker build (otherwise npm is killed and you see `Exit handler never called`):

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab
```

Then:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/megalasai/Telemetry.git
cd Telemetry
cp .env.example .env
nano .env
```

Set `MONGODB_URI` to the real `switchride_app` password (same cluster as the API). Then:

```bash
docker compose up -d --build
curl -s http://127.0.0.1:4200/health
docker compose logs -f
```

Point WanWay devices at the droplet public IP, port **21100** (or 5001 / 8821). Register the IMEI in admin IoT Devices as vendor WanWay.

## Update later

```bash
cd Telemetry
git pull
docker compose up -d --build
```

## Local

```bash
npm install
cp .env.example .env
npm run dev
```

Health: `http://localhost:4200/health`.
