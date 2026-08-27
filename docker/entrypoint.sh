#!/bin/sh
set -eu

HTML="/usr/share/nginx/html/index.html"
rm -f /usr/share/nginx/html/config.js

URL="${VITE_SUPABASE_URL:-${SUPABASE_URL:-}}"
KEY="${VITE_SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY:-}}"

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "error: в Environment Dokploy задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY" >&2
  exit 1
fi

escape_js() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/</\\u003c/g'
}

{
  printf '%s' '<script>window.__MEDTECH_CONFIG__={VITE_SUPABASE_URL:"'
  escape_js "$URL"
  printf '%s' '",VITE_SUPABASE_ANON_KEY:"'
  escape_js "$KEY"
  printf '%s' '"};</script>'
} > /tmp/medtech-env.snippet

tmp="$(mktemp)"
awk '
  /<!--medtech-env-->/ {
    while ((getline line < "/tmp/medtech-env.snippet") > 0) print line
    close("/tmp/medtech-env.snippet")
    next
  }
  { print }
' "$HTML" > "$tmp"
mv "$tmp" "$HTML"
rm -f /tmp/medtech-env.snippet

exec nginx -g "daemon off;"
