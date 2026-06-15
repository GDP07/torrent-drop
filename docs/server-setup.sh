#!/usr/bin/env bash
# One-shot server setup for TorrentDrop on an Oracle Cloud (Ubuntu) VM.
# Run this ON THE SERVER, inside the ~/torrentdrop folder, after copying the files up:
#     bash server-setup.sh
# It opens the OS firewall, installs Node, installs deps, and runs the app on boot.
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8080}"
TORRENT_PORT="${TORRENT_PORT:-6881}"
MAX_CONNS="${MAX_CONNS:-500}"

# Password: from $1, or $TD_PASSWORD, or prompt. No spaces (keeps the service file simple).
PASS="${1:-${TD_PASSWORD:-}}"
if [ -z "$PASS" ]; then
  read -rsp "Choose a login password for TorrentDrop (no spaces): " PASS; echo
fi
if [ -z "$PASS" ]; then echo "A password is required. Aborting."; exit 1; fi

echo "==> [1/4] Opening OS firewall ports ($PORT tcp, $TORRENT_PORT tcp+udp)..."
sudo iptables -I INPUT -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT
sudo iptables -I INPUT -m state --state NEW -p tcp --dport "$TORRENT_PORT" -j ACCEPT
sudo iptables -I INPUT -m state --state NEW -p udp --dport "$TORRENT_PORT" -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo bash -c 'iptables-save > /etc/iptables/rules.v4' 2>/dev/null || true

echo "==> [2/4] Installing Node.js (if missing)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node $(node -v)"

echo "==> [3/4] Installing app dependencies..."
cd "$APP_DIR"
npm install --no-audit --no-fund

echo "==> [4/4] Creating + starting the service (auto-restart, starts on boot)..."
sudo tee /etc/systemd/system/torrentdrop.service >/dev/null <<EOF
[Unit]
Description=TorrentDrop
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=TORRENT_PORT=$TORRENT_PORT
Environment=MAX_CONNS=$MAX_CONNS
Environment=UV_THREADPOOL_SIZE=64
Environment="TD_PASSWORD=$PASS"
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now torrentdrop
sleep 2
sudo systemctl --no-pager status torrentdrop || true

IP="$(curl -s --max-time 5 ifconfig.me || echo YOUR_SERVER_IP)"
echo ""
echo "============================================================"
echo "  Done.  Open:  http://$IP:$PORT"
echo "  Log in with the password you just set."
echo "  Live logs:    journalctl -u torrentdrop -f"
echo "============================================================"
echo "  Reminder: also open ports $PORT (TCP) and $TORRENT_PORT (TCP+UDP)"
echo "  in the Oracle Console Security List, or it won't be reachable."
echo "============================================================"
