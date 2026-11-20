# BEYOND AI – AI Video Editor (merged: Premium UI + backend)

## Quick start (one machine, no deploy)
Requirements: Node 20.3+ and FFmpeg (with libx264). No `npm install` needed (zero dependencies).
```bash
cd beyond-ai/backend
cp .env.example .env          # then edit .env: set ANTHROPIC_API_KEY and your own PREMIUM_DAILY_CODES / PREMIUM_UNLIMITED_CODES
node server.js                # or:  npm start
```
Open **http://localhost:8787/BEYOND-AI.html** (also served at `/`). The backend serves the page, `/config.js` and the API from the same origin, so no CORS setup is needed.
Check **http://localhost:8787/api/health**: it must show `"ai_planner": true`, `ffmpeg.libx264: true` and `premium.required`.
Docker alternative: from `beyond-ai/` run `docker build -f backend/Dockerfile -t beyond-ai . && docker run -p 8787:8787 -v beyond-data:/data --env-file backend/.env beyond-ai`.

## What the merge did
`public/BEYOND-AI.html` is your new Premium UI (gold/black Premium page, dashboard, code forms) as the single frontend file (`public/index.html` is an identical copy so Netlify/`/` serve it). It is a strict superset of the previous frontend: every old screen, control, upload/plan/job call and CSS rule is still there. The previous file is kept at `public/legacy/index-before-merge.html`.
The new UI needed backend features that did not exist, so they were added in `backend/premium.js` and wired into `backend/server.js`:
`GET /api/premium/status`, `POST /api/premium/activate`, the `x-premium-token` header, `request_id` de-duplication on `POST /api/jobs`, and the error codes `PREMIUM_REQUIRED`, `PREMIUM_EXPIRED`, `PREMIUM_REVOKED`, `DAILY_LIMIT_REACHED`.
Frontend backend URL: `BEYOND-AI.html` loads `config.js` (served by the backend, or generated on Netlify). Opened straight from disk (`file://`) it falls back to `http://localhost:8787` (then add `null` to `ALLOWED_ORIGINS`). Hosted anywhere with no backend URL it says "Backend not connected" instead of faking anything.

## Premium rules (enforced on the server)
* Codes live only in the backend environment (`PREMIUM_DAILY_CODES`, `PREMIUM_UNLIMITED_CODES`, optional `PREMIUM_CODES_FILE`). The browser sends a code once and keeps only an opaque session token (`localStorage`). `premium.json` stores hashes only.
* **Daily**: 24-hour window, 1 export (`PREMIUM_DAILY_HOURS`, `PREMIUM_DAILY_EXPORTS`). After the window ends the status is "expired"; entering the Daily code again opens a fresh window.
* **Unlimited**: no export limit for `PREMIUM_UNLIMITED_DAYS` (default 30) from activation.
* An export is reserved when a job is created and kept only if the render finishes. Failed, cancelled or interrupted jobs give it back. The same `request_id` (double click, retry) counts once; simultaneous requests cannot take the last export twice.
* Activation, expiry and counts are stored in `DATA_DIR/premium.json`, so a refresh or restart never resets them.
* `PREMIUM_REQUIRED=false` opens exports to everyone. If `PREMIUM_REQUIRED` is true and no codes are configured, nobody can export (the server prints a warning at startup).
* Wrong codes: 6 failures per IP in 10 minutes locks activation for that IP for the rest of the window.
* Known limit (no user accounts): a session is a browser token, so clearing site data gives a new session, and a shared Daily code can be used once per browser. Add login before selling Premium for real.

---
## Original project notes

## What was wrong
The uploaded project was a **frontend only**. `BRAIN_CONFIG.apiUrl` was an empty string and no backend existed, so Generate Video fell back to "open this page inside Claude" and failed everywhere else. The progress and result screens were also placeholders (steps stayed "Waiting", the result was just your original upload).

## What is in this project
```
public/BEYOND-AI.html    Final merged frontend (public/index.html is an identical copy)
public/config.js         Backend URL. Generated on Netlify from BEYOND_API_URL; served dynamically by the backend
backend/server.js        HTTP API: uploads, /api/plan, jobs, output streaming, CORS, rate limits, retention sweep
backend/planner.js       AI editing planner: server-side Anthropic Messages API call + validation + one repair retry
backend/planSchema.js    Plan schema, extracted verbatim from the frontend so both sides validate identically
backend/pipeline.js      Video engine: FFmpeg edit pass, captions, music, final render, progress, warnings
backend/captions.js      Speech-to-text client + SRT builder
backend/media.js         ffprobe/ffmpeg wrappers, silence detection
backend/Dockerfile       Node 20 + FFmpeg + Noto fonts (Hindi/English captions)
backend/test/e2e.mjs     End-to-end test (npm test in backend/)
scripts/make-config.js   Netlify build step: writes public/config.js, fails the build if BEYOND_API_URL is missing
netlify.toml, render.yaml
docs/test-run/           Screenshots from the test runs
```
The backend has **zero npm dependencies** (Node 20.3+ and FFmpeg only).

Flow: browser uploads the file (`POST /api/uploads`) -> Generate Video calls `POST /api/plan` (Anthropic API, key stays on the server) -> Continue calls `POST /api/jobs` -> frontend polls `GET /api/jobs/:id` -> result streams from `GET /api/jobs/:id/output`.

## Deploy the backend (Render, Docker)
1. Push this folder to a GitHub repo.
2. Render: **New > Blueprint**, pick the repo (it reads `render.yaml`). Use a plan with real CPU/RAM (Standard or higher). Keep the 20 GB disk mounted at `/data`.
3. Fill the environment variables below, deploy, then open `https://<your-service>.onrender.com/api/health`. You should see `"ai_planner": true` and `ffmpeg.ffmpeg/libx264/subtitles: true`.

Any Docker host works the same way (Railway, Fly.io, a VPS): build with `docker build -f backend/Dockerfile -t beyond-ai .` from the project root, run with a persistent volume on `/data`, and put it behind HTTPS.

### Environment variables (backend)
| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | AI editing planner. Without it `/api/plan` returns a clear 503 (no fake plan). |
| `ALLOWED_ORIGINS` | yes | Your Netlify origin(s), comma separated, e.g. `https://my-site.netlify.app,https://*.netlify.app`. |
| `TRUST_PROXY` | on PaaS | `true` behind Render/Railway/Fly so client IPs and https are detected. |
| `PUBLIC_URL` | recommended | Public https URL of the backend. |
| `DATA_DIR` | recommended | Uploads and renders. Use a persistent disk (`/data` in Docker). |
| `SERVE_FRONTEND` | optional | `false` if the frontend lives only on Netlify. |
| `OPENAI_API_KEY` (+ `STT_MODEL`, default `whisper-1`) | for captions | Speech-to-text (OpenAI-compatible endpoint). Without it, captions are skipped and the UI shows a warning. |
| `MUSIC_DIR` | for music | Folder of royalty-free audio files; names are matched to the plan's music mood. Empty = music skipped with a warning. |
| `ANTHROPIC_MODEL` | optional | Default `claude-sonnet-5-5`. |
| `MAX_UPLOAD_MB` (1024), `MAX_VIDEO_SECONDS` (3600), `MAX_CONCURRENT_JOBS` (1), `RETENTION_HOURS` (24), `PLANNER_TIMEOUT_MS` (20000), `PORT` (8787) | optional | Limits. |

## Deploy the frontend (Netlify)
1. New site from the same repo. Netlify reads `netlify.toml` (build `node scripts/make-config.js`, publish `public`).
2. Site configuration > Environment variables: `BEYOND_API_URL` = `https://<your-backend-host>` (https, no trailing slash).
3. Deploy. The build **fails on purpose** if `BEYOND_API_URL` is missing, so you never ship a frontend with no backend.
4. Put the resulting Netlify URL into the backend's `ALLOWED_ORIGINS` and redeploy the backend.

Drag-and-drop deploys skip the build step: edit `public/config.js` yourself (`window.BEYOND_CONFIG={apiUrl:"https://your-backend"};`).

Run everything on one machine instead: see Quick start above.

## Troubleshooting
- "The BEYOND AI backend is not configured": `config.js` has an empty `apiUrl` (set `BEYOND_API_URL` on Netlify and redeploy).
- "Could not reach ... ALLOWED_ORIGINS": backend URL wrong, backend down, or your site's origin is not in `ALLOWED_ORIGINS`.
- 503 `NOT_CONFIGURED` on plan: `ANTHROPIC_API_KEY` missing. `AI_AUTH` / `AI_UPSTREAM`: key rejected or model name wrong (`ANTHROPIC_MODEL`).
- Upload fails on big files: check the host/proxy body limits (Cloudflare in front caps at 100 MB on lower plans) and `MAX_UPLOAD_MB`.
- Job "interrupted": the server restarted mid-render (jobs are not resumed).

## What the engine really does (and does not)
Applied with FFmpeg: aspect ratio reframe (centered crop), 720p/1080p scaling, silence removal, max duration, color enhancement, cinematic grade, stabilization (deshake), noise reduction, sound enhancement (high-pass, denoise, loudness), slow motion (0.5x, no frame interpolation), zoom effect, glitch, captions burned in (needs `OPENAI_API_KEY`), background music (needs files in `MUSIC_DIR`), fade in/out, MP4/MOV/WebM output.

Reported in the UI as "not applied" instead of being faked: `speed_ramp`, `text_overlays`, `highlight_detection`, scene-to-scene transitions (only fade in/out is applied), subject-tracking reframe. This is an editor driven by an AI plan, not a generative video model.

## Security note
The API has no user login. `ALLOWED_ORIGINS` only restricts browsers; anyone who knows the backend URL can call it with curl and spend your Anthropic/OpenAI credits and CPU. Per-IP rate limits and size limits are built in, but add authentication (for example your Stage 1 login) before opening the site to the public.

## Tests that were run
See the final message of the build for exactly what was and was not verified. Run `cd backend && npm test` (needs ffmpeg/ffprobe) to repeat the backend end-to-end test. It replaces only the two external services (Anthropic, speech-to-text) with local test doubles; the shipped backend never fakes AI.

## Tests
`cd backend && npm test` runs `test/e2e.mjs` (26 checks: upload, planner, FFmpeg render, captions, CORS) and `test/premium.mjs` (27 checks: codes, windows, limits, refunds, persistence, revocation, lockout). Both start the real backend and need ffmpeg/ffprobe.
`browser-test/run.cjs` drives the real page in Chromium (Playwright) against the real backend, desktop and mobile (49 checks). It needs `playwright` with a Chromium build; it answers the React/htm CDN scripts from local test shims and replaces only the Anthropic API with a local double.


## Automated tests

### Backend tests (Node.js)

Requires Node.js 20+, FFmpeg and FFprobe:

```bash
cd backend
npm test
```

This runs the backend end-to-end suite and Premium suite against real local backend processes. The external AI and speech-to-text services are replaced by local protocol-compatible test doubles in the tests; production code still requires valid provider keys.

### Deno smoke test

The production API server remains a Node.js application. A Deno-native smoke test is included to launch the Node server as a child process and verify `/api/health` and `/api/premium/status` using Deno's test runner:

```bash
deno task test
```

Run the complete suite (Deno smoke test plus Node backend suites):

```bash
deno task test:all
```

The Deno runtime must be installed separately. The Deno smoke test was added but could not be executed in the build environment because Deno was unavailable.

### Browser tests

```bash
cd browser-test
npm install
npx playwright install chromium
npm test
```

The browser test requires Playwright and a Chromium browser. The test was not run in the build environment because Playwright was unavailable.

### Cancellation behaviour

Running FFmpeg jobs now check cancellation before starting each processing stage. The FFmpeg wrapper refuses to start a new process for an already-cancelled job and always settles its promise once. The Premium cancellation regression test verifies that cancelling a running render reaches `cancelled` and refunds the reserved export.
