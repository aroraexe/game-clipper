# Deploying StoryPlay (Railway) — durable storage & subscriptions

Read this before the next deploy. Two of these steps are mandatory for a paid
product and one of them will fail silently if you skip it.

---

## 1. Attach a Railway volume (REQUIRED before taking payments)

Without a volume, `storage/` lives on the container's ephemeral disk. **Every
redeploy deletes every finished video, the job history, and the subscriber
list.** If a customer pays and you deploy a fix, their video is gone.

Volumes cannot be declared in `railway.json` — they are attached out-of-band:

```bash
railway link                       # once
railway volume add --mount-path /data
railway volume attach --volume data --service <your-service-name>
```

Or: right-click the project canvas in the Railway dashboard → Add Volume →
mount path `/data`.

Then set the environment variable:

```
STORAGE_ROOT=/data
```

You do not have to set it — `backend/utils/storage.util.js` now prefers
Railway's own `RAILWAY_VOLUME_MOUNT_PATH` automatically. Setting it explicitly
is still recommended so the intent is obvious.

Verify it worked:

```bash
railway volume files --volume data list /
```

You should see `outputs/`, `temp/`, `gameplay/`, `jobStore.json`.

---

## 2. Fix the volume permission conflict (REQUIRED — silent failure)

The Dockerfile runs the app as the non-root `node` user (`USER node`). Railway's
docs are explicit about the consequence:

> Docker images that run as a non-root UID by default will have permissions
> issues when performing operations within an attached volume. If you are
> affected by this, you can set `RAILWAY_RUN_UID=0` environment variable in
> your service.

Pick **one** of these — do not do neither:

- **(a) Recommended — keep the non-root user.** The `Dockerfile` now sets
  `ENV RAILWAY_RUN_UID=0` (see the bottom of the file), so Railway fixes volume
  ownership for the container and this works out of the box. Setting it again on
  the service is harmless.

- **(b) Drop back to root.** Remove the `USER node` line and the `chown` from
  the `Dockerfile`. Simpler, but loses the hardening.

**How it fails if you do nothing:** `initStorage()` throws `EACCES` on
`mkdirSync`, the process crashes on boot, and every render 500s. It looks like
an app bug, not a permissions bug — check `railway logs` for `EACCES` first.

---

## 3. Environment variables

```bash
NODE_ENV=production
FIREBASE_SERVICE_ACCOUNT_BASE64=...   # REQUIRED - auth 503s without it
OUTPUT_URL_SECRET=...                 # REQUIRED - server refuses to boot without it
STORAGE_ROOT=/data
RAILWAY_RUN_UID=0                     # optional - already set in the Dockerfile
TRUST_PROXY_HOPS=1                    # REQUIRED on Railway - see below
# CORS_ORIGINS=                        # leave unset unless the frontend is on Vercel
# NVIDIA_API_KEY=...                  # rotate the leaked key before launch
# OPENAI_API_KEY=...                  # if you move off Edge TTS
```

### `TRUST_PROXY_HOPS` — do not skip this

Set it to the number of reverse proxies between the browser and the app.
**Railway: 1. Render: 1. Cloudflare in front of either: 2.**

It is a security setting. Express derives the client IP from `X-Forwarded-For`
right-to-left and trusts exactly this many entries. Get it wrong in the unsafe
direction — the real chain is longer than the number you set — and the entries
being skipped were chosen by the caller, so anyone can pick their own rate-limit
identity with one header. Every rate limiter on the API (30 POST/min, 300
GET/min) then stops applying, and the per-account job caps are the only thing
left between an attacker and the render queue. Unset defaults to `0`, which is
correct locally and means X-Forwarded-For is ignored entirely.

---

## 3b. Railway Hobby capacity (~100 concurrent users)

Hobby is fine for **~100 people browsing / polling at once**. It is **not** fine
for 100 encodes at once.

| Knob | Hobby default | Why |
|------|---------------|-----|
| `MAX_CONCURRENT_RENDERS` | `1` | One libx264 job; more OOMs the container |
| Output | `720×1280` | Kept — do not drop resolution for speed |
| `X264_PRESET` / `X264_CRF` | `veryfast` / `23` | Real Short quality; override only if you must |
| Queue | deep FIFO + Pro `high` lane | Everyone waits fairly; Pro jumps ahead |
| Daily caps | Free 10 / Pro 100 | Stops free accounts looping cost |

Expect queue wait when many people hit Create together. `/api/health` reports
`queue.active` and `queue.queued`. If wait times stay high, scale the service —
do not raise concurrency above 1 on Hobby without measuring RAM.

### `CORS_ORIGINS`

Leave it unset when Express also serves the frontend (the normal Railway setup) —
no CORS headers are needed for same-origin. Set it **only** for a split
deployment, to the exact origin of the static frontend. Never `*`: the session
lives in a cookie, so a wildcard origin lets any website read signed-in API
responses out of a logged-in visitor's browser. `PUBLIC_BASE_URL` is allowed
automatically when set.

---

## 4. Watch the 5 GB volume limit

Railway **Hobby volumes are 5 GB**. At roughly 12 MB per finished video that is
about **400 videos** of headroom.

With free-tier videos expiring after 1 hour and subscriber videos after 7 days,
the long-lived subscriber videos are what accumulate. A full disk means FFmpeg
cannot write its output and every render fails.

Check usage:

```bash
railway volume metrics --volume data
```

Before you grow past this, add either a total-retention sweep for subscribers
or object storage (Railway S3 buckets, or R2/Cloudflare) for finished videos.
Do not let the disk hit 100% — it takes renders down, not just downloads.

---

## 5. Plan configuration

Plans live in **`backend/config/plans.js`** — one file, no other edits needed to
change retention, limits, or story caps:

| | Free | Pro (monthly) |
|---|---|---|
| Video retention | 1 hour | 7 days |
| Concurrent jobs | 2 | 6 |
| Max story length | 1500 chars | 3000 chars |
| Watermark | yes | no |

Subscriber status lives in `storage/userStore.json`. Only `active` and
`trialing` grant the paid plan; `past_due`, `canceled`, and `unpaid` fall back
to free immediately, which also shortens their retention to 1 hour.

---

## 6. What is still missing before you can charge anyone

- [ ] **Rotate the leaked NVIDIA key** (`2a25bd9`, `0fa225f` in git history).
      It is still readable with `git log -p -S nvapi-`. Removing it from the
      working tree does not remove it from history.
- [ ] **Set `TRUST_PROXY_HOPS=1`** on Railway (section 3). Unset means the API's
      rate limits are trivially bypassable.
- [ ] **Stripe subscription** — nothing is wired up. `/api/me` and
      `userStore.setPlan()` are the hooks the webhook will call.
- [ ] **`node-edge-tts` is not a licensed commercial API.** It calls
      Microsoft Edge's read-aloud websocket with no paid contract behind it. It
      can break or be blocked without notice. For a paid product, switch
      `OPENAI_API_KEY` on and use the OpenAI TTS path in `tts.service.js`.
- [ ] **Real Terms and Privacy pages** — `frontend/terms.html` and
      `privacy.html` describe the current behaviour and the processors, but have
      not been reviewed by a lawyer and need a named legal entity and contact
      address before you take money from EU/UK customers.
- [ ] **`frontend/pricing.html` shows a placeholder GBP 9/month price.** Replace
      it with the real Stripe price and confirm the currency.
- [ ] **The free-tier watermark is re-resolved at render time**, so a render that
      sat in the queue while a subscription lapsed now gets watermarked. Verify
      `drawtext` finds a font on the target image (`fonts-liberation` is
      installed in the Dockerfile) — an unavailable font makes FFmpeg fail the
      whole composite, not just skip the watermark.
- [ ] **CSP still allows `'unsafe-inline'`** for `script-src` and `style-src`,
      because all three pages carry inline `<script>` blocks. There is no current
      injection point, but any HTML injection becomes script execution.
      Externalising those blocks removes it.
