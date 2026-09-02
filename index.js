import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { pool, initSchema } from "./db.js";
import { checkAllSources, scanRecentAcrossSources } from "./monitor.js";
import { SOURCES, CANDIDATE_SOURCES } from "./sources.js";

const app = express();
const PORT = process.env.PORT || 3000;

await initSchema();

// --- API ---

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/changes", async (req, res) => {
  const { window } = req.query; // "24h" | "7d" | "30d" | undefined (all time)
  const intervals = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

  const query = intervals[window]
    ? `SELECT * FROM changes WHERE detected_at >= now() - INTERVAL '${intervals[window]}' ORDER BY detected_at DESC LIMIT 200`
    : `SELECT * FROM changes ORDER BY detected_at DESC LIMIT 200`;

  const { rows } = await pool.query(query);
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

// Live scan: reads every source's CURRENT content right now and asks Claude
// to pull out anything the page itself dates within the requested window.
// This is the fix for the gap where checkAllSources() only ever reports
// "changed since the last poll" — with a 6-hour cron and companies that
// don't publish daily, that can mean days of silence even though real,
// recent, dated content already sits on the page. This endpoint answers
// "what does the page say happened recently" directly, independent of poll
// history. Slower and more expensive than /api/check-now (38 fetches + 38
// Claude calls), so it's a separate explicit action, not run on every page
// load.
app.get("/api/scan-recent", async (req, res) => {
  const windowDays = { "24h": 1, "7d": 7, "30d": 30 }[req.query.window] || 7;
  const results = await scanRecentAcrossSources(windowDays);
  res.json({ scannedAt: new Date().toISOString(), windowDays, results });
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
  const activeWindow = ["24h", "7d", "30d"].includes(req.query.window) ? req.query.window : "all";
  const intervals = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

  const changesQuery = intervals[activeWindow]
    ? `SELECT * FROM changes WHERE detected_at >= now() - INTERVAL '${intervals[activeWindow]}' ORDER BY detected_at DESC LIMIT 100`
    : `SELECT * FROM changes ORDER BY detected_at DESC LIMIT 100`;

  const { rows: changes } = await pool.query(changesQuery);
  const { rows: snapshotCounts } = await pool.query(
    `SELECT source_name, COUNT(*) as checks, MAX(fetched_at) as last_checked
     FROM snapshots GROUP BY source_name`
  );
  // Counts per window, independent of which tab is active, so every tab
  // label can show its own number at once (e.g. "24h (2)") rather than
  // only revealing counts after you click into a window.
  const { rows: windowCounts } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE detected_at >= now() - INTERVAL '24 hours') AS h24,
      COUNT(*) FILTER (WHERE detected_at >= now() - INTERVAL '7 days') AS d7,
      COUNT(*) FILTER (WHERE detected_at >= now() - INTERVAL '30 days') AS d30,
      COUNT(*) AS all_time
    FROM changes
  `);
  const counts = windowCounts[0];

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

    .feed-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .feed-label {
      font-size: 11px;
      font-weight: 650;
      color: var(--ink-faint);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .window-tabs {
      display: flex;
      gap: 2px;
      background: var(--paper-raised);
      border: 1px solid var(--rule);
      border-radius: 6px;
      padding: 2px;
    }
    .window-tabs a {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--ink-soft);
      text-decoration: none;
      padding: 5px 10px;
      border-radius: 4px;
    }
    .window-tabs a:hover { background: var(--structure-soft); }
    .window-tabs a.active {
      background: var(--ink);
      color: var(--paper);
    }

    .scan-note {
      font-size: 12.5px;
      color: var(--ink-soft);
      line-height: 1.6;
      background: var(--structure-soft);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 8px;
    }
    .scan-note b { color: var(--ink); }
    .scan-btn {
      display: block;
      margin-top: 10px;
      background: var(--structure);
      color: var(--paper);
      border: none;
      font-family: var(--sans);
      font-size: 12.5px;
      font-weight: 600;
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
    }
    .scan-btn:disabled { opacity: 0.6; cursor: default; }

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
      <p class="tagline">Tracking changelog, blog, docs, status, pricing, jobs &amp; CLI activity across ${companies.length} developer platforms — polled every 6 hours.</p>
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

  <div class="feed-header">
    <div class="feed-label">Changes</div>
    <div class="window-tabs">
      <a href="/?window=24h" class="${activeWindow === "24h" ? "active" : ""}">24h (${counts.h24})</a>
      <a href="/?window=7d" class="${activeWindow === "7d" ? "active" : ""}">7d (${counts.d7})</a>
      <a href="/?window=30d" class="${activeWindow === "30d" ? "active" : ""}">30d (${counts.d30})</a>
      <a href="/" class="${activeWindow === "all" ? "active" : ""}">All (${counts.all_time})</a>
    </div>
  </div>

  <div class="scan-note">
    <b>Note:</b> the tabs above show what this tool has <em>detected</em> since it started polling — not necessarily everything each company actually published in that window (6-hour poll cycle, started ${new Date().toDateString()}). To check pages directly for recent dated items regardless of poll history, use:
    <button class="scan-btn" id="scanBtn" onclick="runScan()">Scan pages now (~1–2 min)</button>
  </div>
  <div id="scanResults"></div>

  <script>
    async function runScan() {
      const btn = document.getElementById('scanBtn');
      const resultsEl = document.getElementById('scanResults');
      const windowParam = new URLSearchParams(location.search).get('window') || 'all';
      const scanWindow = ['24h', '7d', '30d'].includes(windowParam) ? windowParam : '7d';

      btn.disabled = true;
      btn.textContent = 'Scanning ' + ${SOURCES.length} + ' pages…';
      resultsEl.innerHTML = '';

      try {
        const res = await fetch('/api/scan-recent?window=' + scanWindow);
        const data = await res.json();
        const withItems = data.results.filter(r => r.items && r.items.length > 0);

        if (withItems.length === 0) {
          resultsEl.innerHTML = '<div class="empty-state"><b>No dated items found in the last ' + data.windowDays + ' days.</b><br>Either nothing was published in that window, or the pages do not show visible dates this tool could read.</div>';
        } else {
          resultsEl.innerHTML = withItems.map(r =>
            r.items.map(item => {
              const sigColors = { HIGH: '#C77D2E', MEDIUM: '#8A6A3D', LOW: '#8C8C88' };
              const sigLabels = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
              const color = sigColors[item.significance] || sigColors.LOW;
              const label = sigLabels[item.significance] || 'Low';
              return '<div class="row"><div class="row-sig" style="color:' + color + '">' + label + '</div><div class="row-body"><div class="row-source"><a href="' + r.url + '" target="_blank" rel="noopener">' + r.source + '</a></div><div class="row-summary">' + item.summary + '</div></div><div class="row-time">' + item.dateLabel + '</div></div>';
            }).join('')
          ).join('');
        }
      } catch (err) {
        resultsEl.innerHTML = '<div class="empty-state"><b>Scan failed.</b><br>' + err.message + '</div>';
      }

      btn.disabled = false;
      btn.textContent = 'Scan pages now (~1–2 min)';
    }
  </script>

  <div class="feed-label" style="margin-top:32px">Detected changes</div>

  ${
    changes.length === 0
      ? `<div class="empty-state"><b>${
          activeWindow === "all"
            ? "No changes recorded yet."
            : `No changes in the last ${{ "24h": "24 hours", "7d": "7 days", "30d": "30 days" }[activeWindow]}.`
        }</b><br>Baselines are being established for ${SOURCES.length} sources across ${companies.length} companies. Once a tracked page changes from its baseline, it'll appear here — press "Check now" to poll immediately instead of waiting for the next scheduled run.</div>`
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
