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
  const all = Object.entries(CANDIDATE_SOURCES).flatMap(([category, sources]) =>
    sources.map((s) => ({ ...s, category }))
  );

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
    `SELECT * FROM changes ORDER BY detected_at DESC LIMIT 30`
  );
  const { rows: snapshotCounts } = await pool.query(
    `SELECT source_name, COUNT(*) as checks, MAX(fetched_at) as last_checked
     FROM snapshots GROUP BY source_name`
  );

  const sigColor = { HIGH: "#e5484d", MEDIUM: "#f5a623", LOW: "#8f8f8f" };

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Competitor Monitor — Railway</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; background: #0b0d0e; color: #e8e8e8; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .sub { color: #999; font-size: 14px; margin-bottom: 24px; }
    .sources { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 32px; }
    .source-pill { background: #1a1d1f; padding: 8px 14px; border-radius: 8px; font-size: 13px; border: 1px solid #2a2d2f; }
    .source-pill b { color: #fff; }
    .change { background: #1a1d1f; border: 1px solid #2a2d2f; border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
    .change-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .change-source { font-weight: 600; color: #fff; }
    .sig { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 5px; color: #0b0d0e; }
    .time { color: #777; font-size: 12px; }
    .summary { font-size: 14px; line-height: 1.5; color: #d0d0d0; }
    button { background: #7c5cff; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-bottom: 24px; }
    .empty { color: #777; font-size: 14px; }
  </style>
</head>
<body>
  <h1>🚂 Competitor Content Monitor</h1>
  <div class="sub">Watching Render, Fly.io, Vercel &amp; Heroku for blog/changelog changes — checked every 6 hours via cron.</div>

  <button onclick="fetch('/api/check-now',{method:'POST'}).then(()=>location.reload())">Check now</button>

  <div class="sources">
    ${SOURCES.map((s) => {
      const stat = snapshotCounts.find((c) => c.source_name === s.name);
      return `<div class="source-pill"><b>${s.name}</b> — ${
        stat ? `${stat.checks} checks, last ${new Date(stat.last_checked).toLocaleString()}` : "not checked yet"
      }</div>`;
    }).join("")}
  </div>

  ${
    changes.length === 0
      ? `<div class="empty">No changes detected yet. Click "Check now" to run the first pass (this also establishes baselines).</div>`
      : changes
          .map(
            (c) => `
    <div class="change">
      <div class="change-head">
        <span class="change-source">${c.source_name}</span>
        <span class="sig" style="background:${sigColor[c.significance] || "#8f8f8f"}">${c.significance || "LOW"}</span>
      </div>
      <div class="summary">${c.summary}</div>
      <div class="time">${new Date(c.detected_at).toLocaleString()} · <a href="${c.url}" style="color:#7c5cff" target="_blank">source</a></div>
    </div>`
          )
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
