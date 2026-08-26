#!/usr/bin/env bash
set -euo pipefail

: "${NOVNC_USERNAME:?NOVNC_USERNAME is required}"
: "${NOVNC_PASSWORD:?NOVNC_PASSWORD is required}"

install -d -o pwuser -g pwuser "$PROFILE_PATH" "$XDG_RUNTIME_DIR"
chown -R pwuser:pwuser /app/storage "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

printf '%s\n' "$NOVNC_PASSWORD" | htpasswd -i -c /etc/nginx/.htpasswd "$NOVNC_USERNAME" >/dev/null
chmod 0640 /etc/nginx/.htpasswd
chown root:pwuser /etc/nginx/.htpasswd

# The collector is stopped before this service starts. Remove only stale
# Chromium process locks; profile data remains untouched.
rm -f \
  "$PROFILE_PATH/SingletonCookie" \
  "$PROFILE_PATH/SingletonLock" \
  "$PROFILE_PATH/SingletonSocket"

runuser -u pwuser -- env DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp &

sleep 1
runuser -u pwuser -- env DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" fluxbox &
runuser -u pwuser -- env DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw &
runuser -u pwuser -- websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 &

sleep 2
runuser -u pwuser -- env \
  DISPLAY="$DISPLAY" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  PROFILE_PATH="$PROFILE_PATH" \
  PROXY_SERVER="${PROXY_SERVER:-}" \
  PROXY_USERNAME="${PROXY_USERNAME:-}" \
  PROXY_PASSWORD="${PROXY_PASSWORD:-}" \
  node /opt/login/launch-login.cjs &

exec nginx -g 'daemon off;'
