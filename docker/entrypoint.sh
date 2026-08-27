#!/bin/sh
set -eu

escape_js() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ -z "${VITE_SUPABASE_URL:-}" ] || [ -z "${VITE_SUPABASE_ANON_KEY:-}" ]; then
  echo "error: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в Environment Dokploy" >&2
  exit 1
fi

url="$(escape_js "$VITE_SUPABASE_URL")"
key="$(escape_js "$VITE_SUPABASE_ANON_KEY")"

cat > /usr/share/nginx/html/config.js <<EOF
window.__MEDTECH_CONFIG__ = {
  VITE_SUPABASE_URL: "${url}",
  VITE_SUPABASE_ANON_KEY: "${key}"
};
EOF

exec nginx -g "daemon off;"
