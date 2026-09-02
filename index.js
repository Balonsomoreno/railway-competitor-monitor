import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { pool, initSchema } from "./db.js";
import { checkAllSources, scanRecentAcrossSources, fetchSource, extractText } from "./monitor.js";
import { debugExtractRecentItems } from "./summarize.js";
import { SOURCES, CANDIDATE_SOURCES, COMPANY_HOMEPAGES } from "./sources.js";

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

// Combined action: runs the poll-based check (updates snapshots/changes in
// the DB, same as /api/check-now) AND the live content scan (same as
// /api/scan-recent) together, then merges both into one significance-
// sorted list. This exists because from a user's perspective "go check
// what's new" is one action — the poll-diff vs. content-scan distinction
// is an implementation detail (different mechanisms for catching
// different kinds of gaps), not something worth exposing as two separate
// buttons/results the person has to reconcile themselves.
app.get("/api/refresh-all", async (req, res) => {
  const windowDays = { "24h": 1, "7d": 7, "30d": 30 }[req.query.window] || 7;
  const [checkResults, scanResults] = await Promise.all([
    checkAllSources(),
    scanRecentAcrossSources(windowDays),
  ]);

  const sigRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const merged = [];

  for (const r of checkResults) {
    if (r.status === "change_detected") {
      merged.push({
        source: r.source,
        url: SOURCES.find((s) => s.name === r.source)?.url || "",
        summary: r.summary,
        significance: r.significance,
        dateLabel: "just now",
        origin: "poll", // this change was caught by diffing against the last stored snapshot
      });
    }
  }
  for (const r of scanResults) {
    for (const item of r.items || []) {
      merged.push({
        source: r.source,
        url: r.url,
        summary: item.summary,
        significance: item.significance,
        dateLabel: item.dateLabel,
        origin: "scan", // this item was found by reading the page's current content directly
      });
    }
  }

  merged.sort((a, b) => (sigRank[b.significance] || 0) - (sigRank[a.significance] || 0));

  res.json({ refreshedAt: new Date().toISOString(), windowDays, items: merged });
});

// Debug: show exactly what one source's extraction pipeline actually sees,
// step by step. Built specifically to answer "why did scan-recent come back
// empty" — rather than guess between (a) the page has no visible dates,
// (b) content got cut off by the 6000-char limit sent to Claude, (c) the
// selector is grabbing the wrong part of the page, or (d) something else,
// this shows the real extracted text so it can be read directly. Takes a
// `source` query param matching a name in SOURCES exactly (case-sensitive).
app.get("/api/debug-source", async (req, res) => {
  const source = SOURCES.find((s) => s.name === req.query.source);
  if (!source) {
    return res.status(404).json({
      error: "No source with that exact name.",
      hint: "Pass ?source=<exact name>, e.g. ?source=Render%20Changelog",
      availableNames: SOURCES.map((s) => s.name),
    });
  }
  try {
    const html = await fetchSource(source);
    const text = extractText(html, source.selector);
    const windowDays = { "24h": 1, "7d": 7, "30d": 30 }[req.query.window] || 7;
    // Also run the actual Claude extraction and return its RAW response, so
    // a parsing bug and "Claude genuinely found nothing" can be told apart.
    const claudeDebug = await debugExtractRecentItems({
      sourceName: source.name,
      content: text,
      windowDays,
    });
    res.json({
      source: source.name,
      url: source.url,
      selector: source.selector,
      rawHtmlLength: html.length,
      extractedTextLength: text.length,
      extractedTextFirst6000Chars: text.slice(0, 6000), // exactly what extractRecentItems() actually sees
      claudeDebug, // { todayUsedInPrompt, promptLength, rawClaudeResponse }
    });
  } catch (err) {
    res.status(500).json({ source: source.name, url: source.url, error: err.message });
  }
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
  // competitor" rather than a flat list of 38 unrelated rows.
  const companyOf = (sourceName) => sourceName.split(" ")[0];
  const companies = [...new Set(SOURCES.map((s) => companyOf(s.name)))];
  // The "channel" is what's left after the company name — e.g. "Render
  // Changelog" -> "Changelog". Shown separately from the company name in
  // the UI so two rows for the same company (Changelog vs. Blog vs. Docs)
  // are visually distinguishable at a glance, not just readable if you
  // parse the full string carefully.
  const channelOf = (sourceName, company) => sourceName.slice(company.length).trim() || "Page";

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
  <title>Competitor Watch</title>
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
    .subhead {
      font-size: 15px;
      font-weight: 600;
      color: var(--ink);
      margin: 0 0 6px;
    }
    .tagline {
      font-size: 13px;
      color: var(--ink-soft);
      margin: 0;
      max-width: 60ch;
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

    .sources-details {
      margin-bottom: 32px;
      border-bottom: 1px solid var(--rule);
      padding-bottom: 20px;
    }
    .sources-details summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--ink-soft);
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    .sources-details summary::-webkit-details-marker { display: none; }
    .sources-details summary:hover { color: var(--ink); }
    .chevron { font-size: 10px; transition: transform 0.15s ease; }
    .sources-details[open] .chevron { transform: rotate(180deg); }

    .coverage {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 10px;
    }
    .coverage-item {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--ink-faint);
      background: var(--paper-raised);
      border: 1px solid var(--rule);
      border-radius: 6px;
      padding: 8px 10px;
      min-width: 140px;
    }
    .coverage-item-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 4px;
    }
    .coverage-item-head b { color: var(--ink); font-weight: 700; }
    .coverage-company-link { color: var(--structure); text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 2px; }
    .coverage-company-link:hover { text-decoration-color: currentColor; }
    .coverage-item-channels {
      color: var(--ink-faint);
      font-size: 10.5px;
      line-height: 1.5;
    }

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

    .section-intro {
      font-size: 13px;
      color: var(--ink-soft);
      line-height: 1.6;
      margin-bottom: 16px;
      max-width: 62ch;
    }
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 4px;
    }

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
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-bottom: 3px;
    }
    .row-company {
      font-size: 13px;
      font-weight: 700;
      color: var(--ink);
    }
    .row-channel {
      font-family: var(--mono);
      font-size: 10.5px;
      font-weight: 600;
      color: var(--structure);
      background: var(--structure-soft);
      padding: 1px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .row-summary {
      font-size: 14px;
      color: var(--ink);
      line-height: 1.55;
    }
    .row-summary-link {
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid var(--rule);
    }
    .row-summary-link:hover { border-bottom-color: var(--structure); color: var(--structure); }
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

    .signal-section {
      background: var(--paper-raised);
      border: 1px solid var(--rule);
      border-radius: 10px;
      padding: 20px 22px;
      margin-bottom: 36px;
    }
    .signal-section .row { padding: 12px 0; }
    .signal-empty {
      color: var(--ink-faint);
      font-size: 13px;
      padding: 8px 0;
    }
    .sig-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 18px;
      font-size: 11.5px;
      color: var(--ink-faint);
      margin: 0;
    }
    .sig-legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .sig-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .signal-company-group { margin-bottom: 24px; }
    .signal-company-group:last-child { margin-bottom: 0; }
    .signal-company-heading {
      font-size: 13px;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 4px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--rule);
    }
    .origin-tag {
      font-family: var(--mono);
      font-size: 9.5px;
      color: var(--ink-faint);
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Competitor Watch</h1>
      <p class="subhead">Built to answer "what have our competitors done recently?"</p>
      <p class="tagline">Checks changelogs, blogs, docs, status pages, pricing, and job listings across eight competitive developer platforms, surfacing competitive moves for ongoing intelligence.</p>
    </div>
    <button class="refresh-btn" id="scanBtn" onclick="runRefresh()">Check for updates</button>
  </header>

  <div class="signal-section">
    <div class="section-title" style="margin-bottom:4px">Latest competitive signals</div>
    <p class="section-intro" style="margin-bottom:8px">Meaningful moves from the last 30 days across all ${SOURCES.length} sources, grouped by competitor — routine updates filtered out. Press "Check for updates" above to refresh.</p>
    <p class="sig-legend" style="margin-bottom:16px">
      <span class="sig-legend-item"><span class="sig-dot" style="background:#C77D2E"></span>High — pricing, breaking changes, or a major move</span>
      <span class="sig-legend-item"><span class="sig-dot" style="background:#8A6A3D"></span>Medium — a real launch or update worth a glance</span>
    </p>
    <div id="signalResults"><p class="signal-empty">Press "Check for updates" to pull the latest.</p></div>
  </div>

  <details class="sources-details">
    <summary>Tracking ${companies.length} competitors across ${SOURCES.length} sources <span class="chevron">▾</span></summary>
    <p class="section-intro" style="margin-top:12px; max-width:none"><em>Source counts differ because not every company publishes a public changelog, CLI, or careers page we can track.</em></p>
    <div class="coverage">
      ${companies
        .map((company) => {
          const companySources = SOURCES.filter((s) => companyOf(s.name) === company);
          const checked = companySources.filter((s) =>
            snapshotCounts.some((c) => c.source_name === s.name)
          ).length;
          const channelList = companySources.map((s) => channelOf(s.name, company)).join(" · ");
          const homepage = COMPANY_HOMEPAGES[company];
          const companyLabel = homepage
            ? `<a href="${homepage}" target="_blank" rel="noopener" class="coverage-company-link">${company}</a>`
            : company;
          return `<div class="coverage-item"><div class="coverage-item-head"><b>${companyLabel}</b><span>${checked}/${companySources.length} sources</span></div><div class="coverage-item-channels">${channelList}</div></div>`;
        })
        .join("")}
    </div>
  </details>

  <script>
    const COMPANY_HOMEPAGES = ${JSON.stringify(COMPANY_HOMEPAGES)};

    // Runs BOTH the poll-check (updates the stored change history) and the
    // live content scan, then renders one merged, significance-sorted
    // list. This replaced two separate buttons/results because the
    // poll-vs-scan distinction is a backend implementation detail, not
    // something a person evaluating competitors should have to reconcile
    // themselves across two different lists.
    async function runRefresh() {
      const btn = document.getElementById('scanBtn');
      const resultsEl = document.getElementById('signalResults');
      const windowParam = new URLSearchParams(location.search).get('window') || 'all';
      const scanWindow = ['24h', '7d', '30d'].includes(windowParam) ? windowParam : '30d';

      btn.disabled = true;
      btn.textContent = 'Checking ' + ${SOURCES.length} + ' sources…';

      try {
        const res = await fetch('/api/refresh-all?window=' + scanWindow);
        const data = await res.json();
        // Only HIGH/MEDIUM surface here — this section is meant to be a
        // short, meaningful list, not everything that technically
        // changed. LOW-significance items (routine status updates, minor
        // copy tweaks) still exist in "Full change history" below.
        const notable = data.items.filter(item => item.significance === 'HIGH' || item.significance === 'MEDIUM');

        if (notable.length === 0) {
          resultsEl.innerHTML = '<p class="signal-empty">Nothing notable in the last 30 days. Check "Full change history" below for the complete log, including routine updates.</p>';
        } else {
          const sigColors = { HIGH: '#C77D2E', MEDIUM: '#8A6A3D' };
          const sigLabels = { HIGH: 'High', MEDIUM: 'Medium' };
          const sigRank = { HIGH: 3, MEDIUM: 2 };

          const renderRow = (item) => {
            const company = item.source.split(' ')[0];
            const channel = item.source.slice(company.length).trim() || 'Page';
            const color = sigColors[item.significance] || sigColors.MEDIUM;
            const label = sigLabels[item.significance] || 'Medium';
            return '<div class="row"><div class="row-sig" style="color:' + color + '">' + label + '</div><div class="row-body"><div class="row-source"><span class="row-channel">' + channel + '</span></div><div class="row-summary"><a href="' + item.url + '" target="_blank" rel="noopener" class="row-summary-link">' + item.summary + '</a></div></div><div class="row-time">' + item.dateLabel + '</div></div>';
          };

          // Group by company so the signal reads as "here's what each
          // competitor did," not one flat list a person has to mentally
          // re-sort by company themselves.
          const byCompany = {};
          for (const item of notable) {
            const company = item.source.split(' ')[0];
            (byCompany[company] = byCompany[company] || []).push(item);
          }

          // Order companies by their single highest-significance item, so
          // a competitor with real HIGH-priority news leads the section.
          const companies = Object.keys(byCompany).sort((a, b) => {
            const maxA = Math.max(...byCompany[a].map(i => sigRank[i.significance] || 0));
            const maxB = Math.max(...byCompany[b].map(i => sigRank[i.significance] || 0));
            return maxB - maxA;
          });

          resultsEl.innerHTML = companies.map(company => {
            const items = byCompany[company].sort((a, b) => (sigRank[b.significance] || 0) - (sigRank[a.significance] || 0));
            const homepage = COMPANY_HOMEPAGES[company];
            const companyLabel = homepage
              ? '<a href="' + homepage + '" target="_blank" rel="noopener" class="coverage-company-link">' + company + '</a>'
              : company;
            return '<div class="signal-company-group"><div class="signal-company-heading">' + companyLabel + '</div>' + items.map(renderRow).join('') + '</div>';
          }).join('');
        }
      } catch (err) {
        resultsEl.innerHTML = '<p class="signal-empty">Check failed: ' + err.message + '</p>';
      }

      btn.disabled = false;
      btn.textContent = 'Check for updates';
    }
  </script>

  <div class="feed-header" style="margin-top:36px">
    <div class="section-title" style="margin-bottom:0">Full change history</div>
  </div>
  <p class="section-intro">Every change caught by the background checker, in order — same source as the signal above, just unsorted. Use the tabs to only look at a certain time range.</p>

  <div class="feed-header">
    <div class="window-tabs">
      <a href="/?window=24h" class="${activeWindow === "24h" ? "active" : ""}">24h (${counts.h24})</a>
      <a href="/?window=7d" class="${activeWindow === "7d" ? "active" : ""}">7d (${counts.d7})</a>
      <a href="/?window=30d" class="${activeWindow === "30d" ? "active" : ""}">30d (${counts.d30})</a>
      <a href="/" class="${activeWindow === "all" ? "active" : ""}">All (${counts.all_time})</a>
    </div>
  </div>

  ${
    changes.length === 0
      ? `<div class="empty-state"><b>${
          activeWindow === "all"
            ? "No changes recorded yet."
            : `No changes in the last ${{ "24h": "24 hours", "7d": "7 days", "30d": "30 days" }[activeWindow]}.`
        }</b><br>Baselines are being established for ${SOURCES.length} sources across ${companies.length} companies. Press "Check for updates" above to poll immediately instead of waiting for the next scheduled run.</div>`
      : changes
          .map((c) => {
            const sig = sigMeta[c.significance] || sigMeta.LOW;
            const company = companyOf(c.source_name);
            const channel = channelOf(c.source_name, company);
            const homepage = COMPANY_HOMEPAGES[company];
            const companyLabel = homepage
              ? `<a href="${homepage}" target="_blank" rel="noopener" class="coverage-company-link">${company}</a>`
              : company;
            return `
    <div class="row">
      <div class="row-sig" style="color:${sig.color}">${sig.label}</div>
      <div class="row-body">
        <div class="row-source"><span class="row-company">${companyLabel}</span><span class="row-channel">${channel}</span></div>
        <div class="row-summary"><a href="${c.url}" target="_blank" rel="noopener" class="row-summary-link">${c.summary}</a></div>
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
