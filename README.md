# MENA Daily Brief

A daily, AI-narrated audio briefing on **MENA (Middle East & North Africa) tech, data, and AI news** — delivered as your own private podcast feed.

**How it works:** every morning a GitHub Action wakes up, asks Claude (with web search) to find the day's most significant MENA tech/data/AI news and write a short spoken-word script, sends that script to ElevenLabs to narrate, saves the mp3, rebuilds an RSS feed, and publishes everything to GitHub Pages — for free. You subscribe once in any podcast app and new episodes just show up. It runs unattended forever once set up.

```
scripts/generate-episode.js   → research (Claude + web search) → narrate (ElevenLabs) → save mp3 + rebuild feed.xml
.github/workflows/daily-brief.yml → daily cron → commit episode → deploy to GitHub Pages
```

---

## One-time setup

### 1. Create the repo and push this code

```bash
cd mena-daily-brief
git init
git add .
git commit -m "Initial setup"
git branch -M main
git remote add origin https://github.com/<your-username>/mena-daily-brief.git
git push -u origin main
```

### 2. Enable GitHub Pages

Repo **Settings → Pages → Build and deployment → Source →** select **"GitHub Actions"**.

### 3. Add the secrets

Repo **Settings → Secrets and variables → Actions → Secrets tab → New repository secret**:

| Secret | Where to get it |
| --- | --- |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `ELEVENLABS_API_KEY` | ElevenLabs → Profile → API Keys |
| `ELEVENLABS_VOICE_ID` | ElevenLabs Voice Library (copy the voice's ID), or clone your own voice and use that ID |

### 4. Add the repo variable

Same page, **Variables tab → New repository variable**:

| Variable | Value |
| --- | --- |
| `PODCAST_BASE_URL` | `https://<your-username>.github.io/mena-daily-brief` (no trailing slash) |

> This is a **variable**, not a secret — it's a public URL and the workflow reads it from `vars.*`.

### 5. Trigger it once manually

**Actions tab → "Daily MENA Brief" → Run workflow.** This generates your first episode, builds `feed.xml`, and deploys to Pages. Give it a minute, then confirm `https://<your-username>.github.io/mena-daily-brief/feed.xml` loads.

After this, it runs itself every day at **05:30 UTC**. To change the time, edit the single `cron:` line in `.github/workflows/daily-brief.yml` (times are UTC).

---

## Subscribe in a podcast app

Add this URL in any app that supports "add by URL" (Overcast, Pocket Casts, Apple Podcasts → *Library → Add a Show by URL*, AntennaPod, etc.):

```
https://<your-username>.github.io/mena-daily-brief/feed.xml
```

New episodes appear automatically each morning.

---

## Local testing

```bash
npm install
cp .env.example .env     # fill in your keys + PODCAST_BASE_URL
node -r dotenv/config scripts/generate-episode.js dotenv_config_path=.env
```

Or export the variables in your shell first, then just `npm run generate`. A successful run writes `episodes/YYYY-MM-DD.mp3`, a `.json` sidecar, and a fresh `feed.xml` at the repo root.

> `dotenv` isn't a dependency of this project. For local runs either install it (`npm install --no-save dotenv`) and use the command above, or simply `export` the variables yourself.

---

## Cost control

Each daily run is **one Claude call** (with web search) plus **one ElevenLabs TTS call** of ~450–600 words. Small, but worth knowing the levers:

- **Character budget.** ElevenLabs bills by characters synthesized. ~600 words ≈ **3,500–4,000 characters/day**, roughly **100–120k characters/month**. The script naturally caps length, and the prompt tells Claude to keep quiet days *short* rather than pad — so light-news days cost less.
- **Swap to a cheaper/faster voice model.** Set the `ELEVENLABS_MODEL` env var (or edit the default in `scripts/generate-episode.js`):
  - `eleven_multilingual_v2` — best quality (default)
  - `eleven_turbo_v2_5` — cheaper, faster, still strong
  - `eleven_flash_v2_5` — cheapest/fastest, great for a daily briefing
- **Rolling window.** `ROLLING_WINDOW_DAYS` (default **45**) prunes episodes older than that many days, so the repo and Pages hosting never grow without bound.
- **Claude usage.** One Sonnet call per day with a handful of web searches is inexpensive; `max_uses` on the search tool is capped in the script.

---

## Tuning

Everything below is optional and lives in a single place:

- **Content scope / tone / length** — edit the `systemPrompt` and `userPrompt` in `generateScript()` (`scripts/generate-episode.js`).
- **Publish time** — the `cron:` line in `.github/workflows/daily-brief.yml`.
- **Voice** — `ELEVENLABS_VOICE_ID` (try a cloned voice of yourself).
- **Feed metadata** — `PODCAST_TITLE`, `PODCAST_AUTHOR`, `PODCAST_EMAIL` env vars.
- **Cover art** — replace `cover.png` (1400×1400 recommended) with your own.

---

## Security

All API keys are read from environment variables only — never hardcoded, never logged. `.env` is git-ignored; only `.env.example` (empty placeholders) is committed. In CI the keys come from GitHub Actions secrets and are masked in logs.
