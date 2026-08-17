#!/usr/bin/env bash
# Creates a self-signed code-signing certificate so locally built copies of
# voicegoat keep a stable identity.
#
# Why this exists: macOS keys permissions to an app's code signature. An
# unsigned build's designated requirement is a bare hash of the binary, so every
# rebuild looks like a brand-new application — Screen Recording has to be
# granted again each time, and the app does not reliably appear in that list at
# all. Signing with any real certificate, self-signed included, makes the
# requirement name the certificate instead, and the grant survives rebuilds.
#
# This is not a substitute for a Developer ID certificate. It does nothing for
# distribution: another machine will still refuse a downloaded copy. It only
# fixes identity on the machine that built it.
#
#   ./scripts/make-signing-cert.sh          create it
#   ./scripts/make-signing-cert.sh --remove undo it
#
# Nothing here needs sudo, and nothing touches the system keychain.

set -euo pipefail

NAME="${VOICEGOAT_SIGN_IDENTITY:-voicegoat local signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ "${1:-}" = "--remove" ]; then
  echo "Removing \"$NAME\" from the login keychain…"
  security delete-identity -c "$NAME" "$KEYCHAIN" 2>/dev/null || true
  security delete-certificate -c "$NAME" "$KEYCHAIN" 2>/dev/null || true
  echo "Done. Rebuild to go back to an unsigned app."
  exit 0
fi

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "\"$NAME\" already exists — nothing to do."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
O = voicegoat
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/openssl.cnf" >/dev/null 2>&1

# macOS's Security framework cannot read the PKCS#12 defaults OpenSSL 3 writes
# (AES-256 with a SHA-256 MAC), so the bundle is written the old way on purpose.
PASS="voicegoat-local"
openssl pkcs12 -export -out "$WORK/bundle.p12" \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$PASS" >/dev/null 2>&1

# -A lets codesign use the key without a prompt on every build. The key never
# leaves this machine and signs nothing but local builds.
security import "$WORK/bundle.p12" -k "$KEYCHAIN" -P "$PASS" -A >/dev/null

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "Created \"$NAME\"."
  echo "Builds will now be signed with it automatically."
else
  echo "The certificate was imported but is not usable for signing." >&2
  exit 1
fi
