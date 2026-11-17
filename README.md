# THE GENESIS

Created by **DEV ZIKKY TECH**.

THE GENESIS is an anime catalogue and video-link resolver built with Node.js and Express.

## Vercel deployment

1. Import this repository into Vercel.
2. Use the **Other** framework preset if Vercel does not detect the Express application automatically.
3. Configure the five application variables listed below, preserving the values from your existing Render deployment.
4. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from the existing ZANIMECARD Upstash database. You can make these available through a shared Vercel Environment Group. No new Redis database is required.
5. Deploy. `vercel.json` sets a 180-second Function maximum; the application request deadline is 165 seconds.

### Application environment variables

| Variable | Purpose |
|---|---|
| `API_URL` | Public application URL; defaults to `https://zgenesis.vercel.app` |
| `BASE_URL` | Main upstream catalogue URL |
| `SEARCH_URL` | Upstream search URL |
| `SUPPORTED_DOMAINS` | Comma-separated supported video hostnames |
| `VIDEO_URL` | Upstream video-page URL prefix |

No `HOST_REWRITES` variable is required. The existing `txnhh.com` to `ccxx.com` alias remains a built-in default in the code. Do not add or change it unless the upstream host behavior itself changes.

### Shared Upstash database and isolation

THE GENESIS uses the same Upstash database URL and token as ZANIMECARD, but it never uses ZCard's key namespace. THE GENESIS rate-limit keys begin with `the-genesis:ratelimit:v1:` and ZCard retains its own `zcard:rate-limit:` namespace. The projects therefore have independent counters and cooldown data. THE GENESIS does not read, overwrite, or delete ZCard keys.

Only the `/api/v1/*` endpoints are rate-limited: **40 requests per minute** and **2,500 requests per hour per IP**. Website endpoints such as `/api/home` and `/api/search` are not included. Shared Redis counters keep the limits consistent across Vercel instances.

**Redis failure policy: fail-open.** If Redis credentials are missing or Redis is temporarily unavailable, API requests continue instead of returning HTTP 503. Rate-limit enforcement is temporarily unavailable during that period. A warning is logged, and normal shared enforcement resumes when Redis recovers. This is an availability trade-off, not a guarantee of rate limiting during Redis outages.

## Runtime behaviour

- Cache entries expire after 60 seconds. Expired entries are removed lazily when requests arrive; no background interval or Cron job is used.
- Each incoming request has a shared 165-second deadline. Upstream Axios requests and retries are cancellation-aware.
- `vercel.json` sets the Function maximum to 180 seconds.
- Static frontend assets are in `public/`; Vercel serves them as static assets.
- The in-memory response cache is per function instance and intentionally disposable.

## Local development

```bash
npm install
npm start
```

For local development, copy `.env.example` to `.env`. Redis credentials are optional; without them, rate limiting uses a process-local in-memory fallback.
