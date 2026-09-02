import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { pool, initSchema } from "./db.js";
import { checkAllSources } from "./monitor.js";
import { SOURCES, CANDIDATE_SOURCES } from "./sources.js";

const app = express();
const PORT = process.env.PORT || 3000;

await initSchema();

// --- API ---

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/changes", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM changes ORDER BY detected_at DESC LIMIT 50`
  );
  res.json(rows);
});

app.get("/api/sources", (req, res) => {
  res.json(SOURCES.map((s) => ({ name: s.name, url: s.url })));
});

// Manual trigger — useful for demos and for the initial baseline run.
app.post("/api/check-now", async (req, res) => {
  const results = await checkAllSources();
  res.json({ ranAt: new Date().toISOString(), results });
});

// Diagnostic: test reachability of every candidate marketing/docs/social
// source from wherever this app is actually deployed, without writing
// anything to the DB or adding them to the live monitor list. Use this to
// see which categories get through Railway's network before promoting any
// of them into sources.js's SOURCES array.
app.get("/api/test-candidates", async (req, res) => {
  const all = Object.entries(CANDIDATE_SOURCES)
    .filter(([, sources]) => Array.isArray(sources)) // skip community_note (a string, not a source list)
    .flatMap(([category, sources]) => sources.map((s) => ({ ...s, category })));

  const results = await Promise.all(
    all.map(async (source) => {
      try {
        const res = await fetch(source.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; RailwayCompetitorMonitor/1.0)",
          },
          signal: AbortSignal.timeout(10000),
        });
        return {
          category: source.category,
          name: source.name,
          url: source.url,
          status: res.status,
          reachable: res.ok,
        };
      } catch (err) {
        return {
          category: source.category,
          name: source.name,
          url: source.url,
          status: null,
          reachable: false,
          error: err.message,
        };
      }
    })
  );

  res.json({ testedAt: new Date().toISOString(), results });
});

// --- Dashboard (server-rendered, zero build step) ---

app.get("/", async (req, res) => {
  const { rows: changes } = await pool.query(
    `SELECT * FROM changes ORDER BY detected_at DESC LIMIT 40`
  );
  const { rows: snapshotCounts } = await pool.query(
    `SELECT source_name, COUNT(*) as checks, MAX(fetched_at) as last_checked
     FROM snapshots GROUP BY source_name`
  );

  // Group sources by company (text before the first space-dash or the
  // first word of the name) so the dashboard reads as "one lane per
  // competitor" rather than a flat list of 16 unrelated rows.
  const companyOf = (sourceName) => sourceName.split(" ")[0];
  const companies = [...new Set(SOURCES.map((s) => companyOf(s.name)))];

  const sigMeta = {
    HIGH: { label: "High", color: "#C77D2E", weight: 700 },
    MEDIUM: { label: "Medium", color: "#8A6A3D", weight: 600 },
    LOW: { label: "Low", color: "#8C8C88", weight: 500 },
  };

  const timeAgo = (date) => {
    const diffMs = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Signal — Competitor Monitor</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --paper: #F7F7F4;
      --paper-raised: #FFFFFF;
      --ink: #1A1D1F;
      --ink-soft: #5B5D5A;
      --ink-faint: #9A9C97;
      --rule: #E4E3DD;
      --structure: #2B4C7E;
      --structure-soft: #EEF1F6;
      --signal: #C77D2E;
      --mono: "SF Mono", "IBM Plex Mono", ui-monospace, "Courier New", monospace;
      --sans: -apple-system, "Inter", "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--sans);
      background: var(--paper);
      color: var(--ink);
      max-width: 760px;
      margin: 0 auto;
      padding: 48px 24px 80px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 1px solid var(--rule);
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    h1 {
      font-size: 20px;
      font-weight: 650;
      letter-spacing: -0.01em;
      margin: 0 0 4px;
    }
    .tagline {
      font-size: 13px;
      color: var(--ink-soft);
      margin: 0;
      max-width: 46ch;
    }
    .refresh-btn {
      background: var(--ink);
      color: var(--paper);
      border: none;
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 550;
      padding: 9px 16px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: 20px;
    }
    .refresh-btn:hover { background: #333; }

    .coverage {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 10px;
      margin-bottom: 40px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--rule);
    }
    .coverage-item {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--ink-faint);
      background: var(--paper-raised);
      border: 1px solid var(--rule);
      border-radius: 5px;
      padding: 5px 10px;
    }
    .coverage-item b { color: var(--ink-soft); font-weight: 600; }

    .feed-label {
      font-size: 11px;
      font-weight: 650;
      color: var(--ink-faint);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 16px;
    }

    .empty-state {
      border: 1px dashed var(--rule);
      border-radius: 8px;
      padding: 28px 20px;
      color: var(--ink-soft);
      font-size: 13.5px;
      text-align: left;
      line-height: 1.6;
    }
    .empty-state b { color: var(--ink); }

    .row {
      display: grid;
      grid-template-columns: 88px 1fr auto;
      gap: 16px;
      align-items: baseline;
      padding: 14px 0;
      border-bottom: 1px solid var(--rule);
    }
    .row:last-child { border-bottom: none; }

    .row-sig {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding-top: 2px;
    }

    .row-body { min-width: 0; }
    .row-source {
      font-size: 13px;
      font-weight: 650;
      color: var(--structure);
      margin-bottom: 3px;
    }
    .row-summary {
      font-size: 14px;
      color: var(--ink);
      line-height: 1.55;
    }
    .row-source a { color: inherit; text-decoration: none; }
    .row-source a:hover { text-decoration: underline; }

    .row-time {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ink-faint);
      white-space: nowrap;
      padding-top: 2px;
    }

    @media (max-width: 520px) {
      .row { grid-template-columns: 60px 1fr; }
      .row-time { grid-column: 2; padding-top: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Signal</h1>
      <p class="tagline">Tracking changelog, blog &amp; docs activity across ${companies.length} developer platforms — polled every 6 hours.</p>
    </div>
    <button class="refresh-btn" onclick="this.textContent='Checking…'; this.disabled=true; fetch('/api/check-now',{method:'POST'}).then(()=>location.reload())">Check now</button>
  </header>

  <div class="coverage">
    ${companies
      .map((company) => {
        const companySources = SOURCES.filter((s) => companyOf(s.name) === company);
        const checked = companySources.filter((s) =>
          snapshotCounts.some((c) => c.source_name === s.name)
        ).length;
        return `<span class="coverage-item"><b>${company}</b> · ${checked}/${companySources.length}</span>`;
      })
      .join("")}
  </div>

  <div class="feed-label">Recent changes</div>

  ${
    changes.length === 0
      ? `<div class="empty-state"><b>No changes recorded yet.</b><br>Baselines are being established for ${SOURCES.length} sources across ${companies.length} companies. Once a tracked page changes from its baseline, it'll appear here — press "Check now" to poll immediately instead of waiting for the next scheduled run.</div>`
      : changes
          .map((c) => {
            const sig = sigMeta[c.significance] || sigMeta.LOW;
            return `
    <div class="row">
      <div class="row-sig" style="color:${sig.color}">${sig.label}</div>
      <div class="row-body">
        <div class="row-source"><a href="${c.url}" target="_blank" rel="noopener">${c.source_name}</a></div>
        <div class="row-summary">${c.summary}</div>
      </div>
      <div class="row-time">${timeAgo(c.detected_at)}</div>
    </div>`;
          })
          .join("")
  }
</body>
</html>`);
});

// --- Cron: check every 6 hours ---
cron.schedule("0 */6 * * *", async () => {
  console.log(`[cron] Running scheduled check at ${new Date().toISOString()}`);
  const results = await checkAllSources();
  console.log(`[cron] Done:`, results.map((r) => `${r.source}:${r.status}`).join(", "));
});

app.listen(PORT, () => {
  console.log(`Competitor monitor running on port ${PORT}`);
});
