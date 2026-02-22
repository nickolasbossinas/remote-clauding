#!/bin/bash
set -e

APP_DIR="/var/www/remote-clauding"

echo "==> Installing server dependencies..."
cd "$APP_DIR/server"
npm install --omit=dev

echo "==> Restarting remote-clauding service..."
systemctl restart remote-clauding

echo "==> Done. Service status:"
systemctl status remote-clauding --no-pager -l
