#!/bin/bash
set -e

REMOTE="root@192.168.2.4"
REMOTE_DIR="/var/www/remote-clauding"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Building PWA..."
(cd "$LOCAL_DIR/web" && npm run build)

echo "==> Uploading and deploying (single connection)..."
tar -cf - \
    -C "$LOCAL_DIR" server/src server/package.json server/package-lock.json \
    -C "$LOCAL_DIR" web/dist \
    -C "$LOCAL_DIR" deploy-remote.sh \
| ssh "$REMOTE" "tar -xf - -C $REMOTE_DIR && bash $REMOTE_DIR/deploy-remote.sh"

echo "==> Deploy complete!"
