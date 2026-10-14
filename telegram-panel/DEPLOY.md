# Deploy — Telegram Panel (Ubuntu 24.04 VPS)

Run as root unless noted. Replace `panel.fansflow.eu` if the client picks another host.

## 1. DNS
`A` record `panel.fansflow.eu` → the VPS IP. Wait until it resolves before step 5 (Caddy needs it for the certificate).

## 2. Packages, user, folders
```bash
apt update && apt install -y python3.12-venv git sqlite3 ffmpeg caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
timedatectl set-ntp true            # portal signatures must be within ±5 min
useradd --system --home /var/lib/tgpanel --shell /usr/sbin/nologin tgpanel
install -d -o tgpanel -g tgpanel -m 700 /var/lib/tgpanel
install -d -m 755 /opt/tgpanel && install -d -m 750 -g tgpanel /etc/tgpanel
```

## 3. Code
```bash
cd /opt/tgpanel && git clone <repo-url> . && cd telegram-panel
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd frontend && npm ci && npm run build && cd ..
```
`/opt/tgpanel` is owned by root: the service can read the code but not change it.

## 4. Secrets
```bash
cp .env.example /etc/tgpanel/env && chmod 640 /etc/tgpanel/env && chgrp tgpanel /etc/tgpanel/env
.venv/bin/python -m panel gen-key    # → PANEL_ENC_KEY
.venv/bin/python -m panel gen-key    # → PANEL_SECRET
nano /etc/tgpanel/env                # paste both; DATA_DIR=/var/lib/tgpanel; PUBLIC_ORIGIN=https://panel.fansflow.eu
```
Keep a copy of `PANEL_ENC_KEY` somewhere safe and **separate from backups**. Without it the stored sessions can't be decrypted.

Set the panel password (as the service user, so the DB is owned by it):
```bash
sudo -u tgpanel bash -c 'set -a; . /etc/tgpanel/env; set +a; cd /opt/tgpanel/telegram-panel && .venv/bin/python -m panel set-password'
```

## 5. Service + HTTPS
```bash
cp deploy/tgpanel.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now tgpanel
cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
```
Check: `systemctl status tgpanel`, `curl -s https://panel.fansflow.eu/healthz`, then log in from a phone.

## Update
```bash
cd /opt/tgpanel && git pull && cd telegram-panel
.venv/bin/pip install -r requirements.txt
(cd frontend && npm ci && npm run build)
systemctl restart tgpanel
```

## Logs
`journalctl -u tgpanel -f`
