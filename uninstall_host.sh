#!/usr/bin/env bash
set -e

TARGET_DIR1="$HOME/.mozilla/native-messaging-hosts/altpan_host.json"
TARGET_DIR2="$HOME/.config/mozilla/native-messaging-hosts/altpan_host.json"

echo "============================================"
echo " AltPan Native Messaging Bridge Uninstaller "
echo "============================================"

for TARGET in "$TARGET_DIR1" "$TARGET_DIR2"; do
  if [ -f "$TARGET" ]; then
    rm -f "$TARGET"
    echo "✓ Removed $TARGET"
  fi
done

echo "Uninstallation complete."
echo "============================================"
