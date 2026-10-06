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

- **(a) Recommended — keep the non-root user.** Set `RAILWAY_RUN_UID=0` on the
  service so Railway fixes volume ownership for the container.

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
RAILWAY_RUN_UID=0                     # see section 2
# NVIDIA_API_KEY=...                  # rotate the leaked key before launch
# OPENAI_API_KEY=...                  # if you move off Edge TTS
```

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
- [ ] **Stripe subscription** — nothing is wired up. `/api/me` and
      `userStore.setPlan()` are the hooks the webhook will call.
- [ ] **`node-edge-tts` is not a licensed commercial API.** It calls
      Microsoft Edge's read-aloud websocket with no paid contract behind it. It
      can break or be blocked without notice. For a paid product, switch
      `OPENAI_API_KEY` on and use the OpenAI TTS path in `tts.service.js`.
- [ ] **Real Terms and Privacy pages** — `frontend/terms.html` and
      `privacy.html` are starter placeholder copy. They must describe paid
      plans, the 7-day retention, and Stripe as a processor before you take
      money from EU/UK customers.
- [ ] **`frontend/pricing.html` still says "Free, no card, no paid tier."**
      Update it when billing ships.
- [ ] **Watermark for the free tier** — `plans.js` sets `watermark: true` but
      nothing burns a watermark into the output yet.
