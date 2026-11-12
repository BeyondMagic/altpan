#!/usr/bin/env bash
set -e

# AltPan Native Host Installer for Firefox
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$DIR/native/altpan_host.py"
TARGET_DIR1="$HOME/.mozilla/native-messaging-hosts"
TARGET_DIR2="$HOME/.config/mozilla/native-messaging-hosts"

echo "=========================================="
echo " AltPan Native Messaging Bridge Installer "
echo "=========================================="

if [ ! -f "$HOST_SCRIPT" ]; then
  echo "Error: Could not locate $HOST_SCRIPT"
  exit 1
fi

chmod +x "$HOST_SCRIPT"
mkdir -p "$TARGET_DIR1"
mkdir -p "$TARGET_DIR2"

for TARGET_DIR in "$TARGET_DIR1" "$TARGET_DIR2"; do
  cat << EOF > "$TARGET_DIR/altpan_host.json"
{
  "name": "altpan_host",
  "description": "AltPan Native Messaging Input Bridge",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_extensions": [
    "altpan@terra.local"
  ]
}
EOF
  echo "✓ Registered manifest at:"
  echo "  $TARGET_DIR/altpan_host.json"
done
echo ""

# Check uinput accessibility
if [ -w /dev/uinput ]; then
  echo "✓ /dev/uinput is writable by current user ($USER)."
else
  echo "ℹ Note: If /dev/uinput requires permissions, you can grant them with:"
  echo "  sudo usermod -aG input $USER"
  echo "  (or install an appropriate udev rule for /dev/uinput)"
fi

echo ""
echo "Installation complete! Reload AltPan in Firefox (about:debugging)."
echo "=========================================="
