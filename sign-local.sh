#!/bin/bash
#
# TallyBridge — signed + notarized Mac build (local, for Developer ID distribution).
#
# Requires:
#   1. 'Developer ID Application' cert in Keychain (via Xcode → Settings →
#      Accounts → Manage Certificates → + Developer ID Application)
#   2. ~/.tallybridge-sign.env with APPLE_ID + APPLE_TEAM_ID +
#      APPLE_APP_SPECIFIC_PASSWORD (see error message below if missing)
#
# Output: dist/TallyBridge-X.Y.Z-{x64,arm64}.dmg — signed, notarized, stapled.

set -e

SIGN_ENV="$HOME/.tallybridge-sign.env"

# Load signing credentials (gitignored, per-machine)
if [ -f "$SIGN_ENV" ]; then
  source "$SIGN_ENV"
fi

# Validate env vars
MISSING=()
[ -z "$APPLE_ID" ] && MISSING+=("APPLE_ID")
[ -z "$APPLE_TEAM_ID" ] && MISSING+=("APPLE_TEAM_ID")
[ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] && MISSING+=("APPLE_APP_SPECIFIC_PASSWORD")

if [ ${#MISSING[@]} -ne 0 ]; then
  echo ""
  echo "✗ Missing signing credentials: ${MISSING[@]}"
  echo ""
  echo "Setup (one time) — create $SIGN_ENV with:"
  echo ""
  echo "    export APPLE_ID=\"your-apple-id@example.com\""
  echo "    export APPLE_TEAM_ID=\"8922S5NL5T\""
  echo "    export APPLE_APP_SPECIFIC_PASSWORD=\"xxxx-xxxx-xxxx-xxxx\""
  echo ""
  echo "The app-specific password comes from:"
  echo "    appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate"
  echo ""
  echo "Then: chmod 600 $SIGN_ENV   (readable only by you)"
  echo ""
  exit 1
fi

# Verify Developer ID cert is in Keychain
echo "▸ Checking Developer ID Application cert in Keychain..."
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo ""
  echo "✗ 'Developer ID Application' cert not found in login Keychain."
  echo "  Generate via: Xcode → Settings → Accounts → Manage Certificates →"
  echo "    + (bottom-left) → Developer ID Application"
  echo ""
  exit 1
fi
echo "  ✓ Cert present"
echo ""

# Show which cert will be used (first matching one; electron-builder picks it)
IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/^[[:space:]]*[0-9]*)[[:space:]]*//')
echo "▸ Will sign with: $IDENTITY"
echo ""

echo "▸ Building + signing + notarizing DMG (x64 + arm64)..."
echo "  (notarization adds 1-3 min to build time — Apple scanning the binary)"
echo ""

npm run build:mac

# electron-builder notariza + staplea el .app interno, pero crea el DMG DESPUÉS
# de la notarización → el DMG container queda sin ticket (Apple no lo vio).
# Notarizamos + stapleamos cada DMG para que Gatekeeper pueda verificar offline
# desde el primer mount. Sin esto, el primer open requiere conexión a Apple.
echo ""
echo "▸ Post-build: notarizing + stapling DMG containers..."
echo ""
for dmg in dist/*.dmg; do
  [ -f "$dmg" ] || continue
  echo "  → $dmg"
  xcrun notarytool submit "$dmg" \
    --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait 2>&1 | tail -3 | sed 's/^/    /'
  xcrun stapler staple "$dmg" 2>&1 | tail -1 | sed 's/^/    /'
done

echo ""
echo "✅ Build complete. Signed + notarized + stapled artifacts:"
echo ""
ls -lh dist/*.dmg 2>/dev/null | awk '{printf "  %s  (%s)\n", $NF, $5}'
echo ""
echo "Upload to tallycomm.com/bridge when ready."
