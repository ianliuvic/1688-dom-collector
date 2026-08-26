# 1688 DOM Collector

A conservative, single-browser framework for archiving authorized 1688 product pages. It stores the browser profile and captures on persistent storage and keeps job state in PostgreSQL.

## Current scope

- Persistent Chromium profile at `/app/storage/browser-profile`
- Archived HTML and normalized `product.json` at `/app/storage/captures/<job-id>`
- Screenshots for failed/auth-challenged jobs by default
- Structured 1688 product fields in PostgreSQL `extracted_data` JSONB
- PostgreSQL-backed queue with one active capture at a time
- Login/challenge detection; affected jobs stop as `requires_auth`
- Bearer-token protected API
- HTTPS-only allowlist for `1688.com` hosts

This framework does not bypass CAPTCHAs, signatures, access controls, or platform limits. Only collect pages you are authorized to access and follow applicable terms and laws.

## Environment

| Variable | Required | Default |
|---|---:|---|
| `DATABASE_URL` | yes | - |
| `ADMIN_API_KEY` | yes | - |
| `PORT` | no | `3000` |
| `STORAGE_PATH` | no | `/app/storage` |
| `MIN_CAPTURE_INTERVAL_MS` | no | `15000` |
| `NAVIGATION_TIMEOUT_MS` | no | `45000` |
| `PROXY_SERVER` | no | - |
| `PROXY_USERNAME` | no | - |
| `PROXY_PASSWORD` | no | - |
| `BROWSER_HEADLESS` | no | `false` |
| `SCREENSHOT_MODE` | no | `errors` (`never`, `errors`, or `always`) |
| `CLEAR_STALE_BROWSER_LOCKS` | no | `false`; one-shot recovery only while all profile users are stopped |

## API

```bash
curl https://your-domain.example/health

curl -X POST https://your-domain.example/api/jobs \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://detail.1688.com/offer/example.html"}'
```

`GET /api/jobs/:id` and `GET /api/session` use the same bearer token.
`GET /api/jobs/:id/dom` downloads the archived HTML and is also bearer-token protected.

## Next phase

The `login/` image provides a temporary, Basic-Auth-protected noVNC console. It
must share the collector's Docker volume and must never run at the same time as
the collector. Stop the collector, start the login app, sign in manually, close
Chromium, stop the login app, and then start the collector again.

When a fixed proxy is used, configure the same `PROXY_SERVER`,
`PROXY_USERNAME`, and `PROXY_PASSWORD` values on both Coolify applications.
`PROXY_SERVER` includes the scheme and port, for example
`http://proxy.example:1234` or `socks5://proxy.example:1080`.

Further work can add account/session notifications, capture policies,
structured product extraction, and an API suitable for a Codex skill.
