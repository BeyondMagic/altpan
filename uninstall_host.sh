#!/usr/bin/env bash
set -e

TARGET_JSON="$HOME/.mozilla/native-messaging-hosts/altpan_host.json"

echo "============================================"
echo " AltPan Native Messaging Bridge Uninstaller "
echo "============================================"

if [ -f "$TARGET_JSON" ]; then
  rm -f "$TARGET_JSON"
  echo "✓ Removed $TARGET_JSON"
else
  echo "ℹ No native host registration found at $TARGET_JSON"
fi

echo "Uninstallation complete."
echo "============================================"
