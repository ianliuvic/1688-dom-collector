# 1688 DOM Collector

A conservative, single-browser framework for archiving authorized 1688 product pages. It stores the browser profile and captures on persistent storage and keeps job state in PostgreSQL.

## Current scope

- Persistent Chromium profile at `/app/storage/browser-profile`
- Archived HTML and screenshots at `/app/storage/captures/<job-id>`
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

## API

```bash
curl https://your-domain.example/health

curl -X POST https://your-domain.example/api/jobs \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://detail.1688.com/offer/example.html"}'
```

`GET /api/jobs/:id` and `GET /api/session` use the same bearer token.

## Next phase

Add a protected human-login console, account/session notifications, capture policies, structured product extraction, and an API suitable for a Codex skill.
