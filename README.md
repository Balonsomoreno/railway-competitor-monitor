# Competitor Content Monitor

A small service that watches Railway's competitors (Render, Fly.io, Vercel, Heroku) for
changes to their public blogs and changelogs, and uses Claude to summarize *what* changed
and *how significant* it looks.

Built as a hands-on exercise while prepping a brand-side competitive monitor tool,
and as a real personal tool: this is a lightweight, portable version of a competitive
monitoring workflow I run day-to-day.

## How it works

1. **Fetch** — pulls each competitor's blog/changelog page.
2. **Extract** — strips nav/scripts/footers with Cheerio, keeps just the meaningful content.
3. **Hash & compare** — SHA-256 hash of the cleaned text vs. the last stored snapshot.
4. **Summarize** — if the hash changed, sends before/after excerpts to Claude
   (`claude-sonnet-4-6`) and asks for a plain-language summary + LOW/MEDIUM/HIGH
   significance rating.
5. **Store & display** — everything lands in Postgres; a zero-build dashboard shows
   recent changes ranked by significance.
6. **Schedule** — `node-cron` re-runs the check every 6 hours automatically.

## Stack

- Node.js + Express
- PostgreSQL (Railway's managed Postgres, via `DATABASE_URL` reference variable)
- Cheerio (HTML parsing/diffing)
- Claude API (`@anthropic-ai/sdk`) for change summarization
- node-cron for scheduling

## Deploying on Railway

1. `railway init` in this directory, or connect the GitHub repo via the dashboard.
2. Add a Postgres service: **+ Create → Database → Add PostgreSQL**. Railway
   auto-provisions `DATABASE_URL` and makes it available as a reference variable.
3. In the app service's Variables tab, add:
   - `DATABASE_URL` → reference `${{Postgres.DATABASE_URL}}`
   - `ANTHROPIC_API_KEY` → your key
4. Deploy. On first boot the app creates its own schema (`initSchema()` in `db.js`).
5. Hit **Generate Domain** under Networking to get a public URL, then visit `/` and
   click "Check now" to establish baselines for all four sources.

## Notes / honest scope

This is a demo-scale build, not the production competitive-intelligence agent I run
at organizations (which is tied into internal analytics, CRM tooling, etc, via MCP). It's
built to be small enough to explain in five minutes and real enough to actually run.
