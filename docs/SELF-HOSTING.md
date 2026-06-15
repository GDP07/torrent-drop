# Deploy TorrentDrop on Oracle Cloud Always Free

Runs the full BitTorrent engine on a free-forever Oracle ARM VM (4 cores / 24 GB RAM /
up to 200 GB disk / 10 TB egress per month), reachable by you + friends with a password.

> Heads-up you already accepted: downloading copyrighted content violates Oracle's AUP and
> can get the account terminated. Login over plain HTTP also sends the password unencrypted —
> see **Step 7** to add HTTPS or use Tailscale.

---

## 1. Create the VM

Oracle Console → **Compute → Instances → Create instance**:

- **Image:** Canonical Ubuntu 22.04 (or 24.04).
- **Shape:** *Ampere* → `VM.Standard.A1.Flex` → set **2 OCPU / 12 GB** (or up to 4 / 24).
  - If you get **"Out of host capacity"** (common on free ARM): try another Availability Domain,
    another home region, retry later, or fall back to `VM.Standard.E2.1.Micro` (AMD, also free).
- **Boot volume:** bump the size to **100–200 GB** (free up to 200 GB total) so downloads fit.
- **SSH keys:** upload your public key. Generate one on your Mac if needed:
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/oracle_td   # then upload ~/.ssh/oracle_td.pub
  ```
- Create it, then copy the **Public IPv4 address** (call it `SERVER_IP` below).

---

## 2. Open ports — LAYER 1: Oracle Security List

Networking → **Virtual Cloud Networks → (your VCN) → Security Lists → Default Security List →
Add Ingress Rules**. Add three (Source CIDR `0.0.0.0/0`):

| Protocol | Destination port | Purpose |
|---|---|---|
| TCP | 8080 | Web UI |
| TCP | 6881 | BitTorrent peers |
| UDP | 6881 | BitTorrent peers / DHT |

---

## 3. Open ports — LAYER 2: the OS firewall (the #1 Oracle gotcha)

Oracle's Ubuntu images ship an **iptables rule that drops everything except SSH**. You must
open the ports inside the VM too. SSH in:

```bash
ssh -i ~/.ssh/oracle_td ubuntu@SERVER_IP
```

Then:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8080 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 6881 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 6881 -j ACCEPT
sudo netfilter-persistent save
```

Verify the ACCEPTs sit **above** the final REJECT line:
```bash
sudo iptables -L INPUT --line-numbers
```
(If they ended up below the `REJECT all`, re-run with a lower number, e.g. `-I INPUT 5`.)

---

## 4. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v22.x
```

---

## 5. Copy the app up (only the 3 source files — let the server install its own deps)

Run these **on your Mac**:

```bash
ssh -i ~/.ssh/oracle_td ubuntu@SERVER_IP 'mkdir -p ~/torrentdrop/public'
scp -i ~/.ssh/oracle_td server.js package.json ubuntu@SERVER_IP:~/torrentdrop/
scp -i ~/.ssh/oracle_td public/index.html ubuntu@SERVER_IP:~/torrentdrop/public/
ssh -i ~/.ssh/oracle_td ubuntu@SERVER_IP 'cd ~/torrentdrop && npm install'
```

(Don't copy `node_modules` from your Mac — it's the wrong CPU architecture. `npm install`
on the server builds the right one.)

---

## 6. Run it as a service (auto-restart + start on boot, with your password)

On the server, create the service — **edit `TD_PASSWORD` to a strong password first**:

```bash
sudo tee /etc/systemd/system/torrentdrop.service > /dev/null <<'EOF'
[Unit]
Description=TorrentDrop
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/torrentdrop
Environment=PORT=8080
Environment=TORRENT_PORT=6881
Environment=MAX_CONNS=500
Environment=UV_THREADPOOL_SIZE=64
Environment=TD_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now torrentdrop
sudo systemctl status torrentdrop --no-pager
```

- Logs:  `journalctl -u torrentdrop -f`
- Restart after editing the password: `sudo systemctl restart torrentdrop`

**Open it:** `http://SERVER_IP:8080` → log in with `TD_PASSWORD`. Share that URL + password with
your friends. Done.

---

## 7. (Strongly recommended) Add HTTPS, or skip public exposure entirely

Plain `http://SERVER_IP:8080` sends your password and cookie unencrypted. Two fixes:

**A — HTTPS with a free domain (Caddy auto-TLS).** Point a domain (e.g. a free DuckDNS
subdomain) at `SERVER_IP`, open TCP 80 + 443 in **both** firewall layers, then:
```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" | sudo tee /etc/apt/sources.list.d/caddy.list
sudo apt-get update && sudo apt-get install -y caddy
echo 'yourdomain.duckdns.org { reverse_proxy localhost:8080 }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
Then use `https://yourdomain.duckdns.org` (you can also remove the public 8080 rule and the app
stays reachable only through Caddy).

**B — Tailscale (private, no public ports).** Put the VM and your friends on a private tailnet
(free up to 3 users), remove the public 8080 rule, and reach it at `http://<tailscale-ip>:8080`.
Encrypted, nothing exposed to the internet:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

---

## Maintenance

- **Disk filling?** `df -h` to check. Remove torrents from the UI (deletes their files), or
  expand the boot volume in the console (free up to 200 GB total) and run
  `sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1`.
- **Update the app:** re-run the `scp` commands from Step 5, then
  `sudo systemctl restart torrentdrop`.
- **Stop / start:** `sudo systemctl stop torrentdrop` / `start`.
