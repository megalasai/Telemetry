# Fleetel Telemetry

Standalone GPS ingest for **Fleetel-Switchride**. Run this on a **DigitalOcean droplet or any VM with a public IP**. Do not put it on App Platform — App Platform only publishes HTTP.

This repo is separate from [Digi-Switchride](https://github.com/megalasai/Digi-Switchride). The admin/API stay there. This process writes GPS into the **same MongoDB**.

**WanWay / GT06** TCP: `21100`, `5001`, `8821`  
**HTTP health / JSON ingest:** `4200`  
**JSON/CSV TCP:** `4210`

Register the tracker IMEI in the Switchride admin (vendor **WanWay**) and link a vehicle. Positions then show in the application.

## DigitalOcean droplet

1. Create a droplet (Ubuntu 22.04+, 1 GB is enough). Give it a public IPv4.
2. Open firewall TCP: **4200, 4210, 21100, 5001, 8821** (and 22 for SSH).
3. Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

4. Clone this repo and create `.env` (do not commit it):

```bash
git clone https://github.com/megalasai/Fleetel-Telemetry.git
cd Fleetel-Telemetry
cp .env.example .env
nano .env
```

Set at least:

```
MONGODB_URI=mongodb+srv://USER:PASS@HOST/switchride
LOCATION_API_URL=https://fleetel-switchride-pmxt5.ondigitalocean.app/geo
PLATFORM_API_URL=https://fleetel-switchride-pmxt5.ondigitalocean.app
WANWAY_TCP_PORTS=21100,5001,8821
```

Use the **same** MongoDB URI as the Switchride API (public SRV if the droplet is not on the DB VPC).

5. Start:

```bash
docker compose up -d --build
curl http://127.0.0.1:4200/health
```

6. On the WanWay device, set server IP to the **droplet public IP** and port **21100** (or 5001 / 8821).

## Local

```bash
npm install
cp .env.example .env
npm run dev
```

Health: `http://localhost:4200/health` (includes WanWay listen status).
