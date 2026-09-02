import * as cheerio from "cheerio";
import crypto from "crypto";
import { pool } from "./db.js";
import { SOURCES } from "./sources.js";
import { summarizeChange, extractRecentItems } from "./summarize.js";

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Strip tags, but preserve boundaries between block-level elements as a
// newline before collapsing whitespace -> text where separate page
// elements (a nav link, a blog title, a byline) don't run directly into
// each other with no boundary at all. This matters a lot for downstream
// text processing (regex date-matching, excerpt extraction) — without a
// boundary marker, "...Snell, Shaheen Fattoe" from one card and the next
// card's opening text can concatenate into nonsense that reads like one
// garbled sentence. Cheerio's plain .text() on a whole subtree does not
// insert any separator between sibling/nested block elements, which was
// the actual root cause of that garbling — not the excerpt-selection
// logic downstream, which was just faithfully slicing already-corrupted
// text.
const BLOCK_TAGS = "p,div,li,h1,h2,h3,h4,h5,h6,article,section,tr,br,dt,dd";

export function extractText(html, selector) {
  const $ = cheerio.load(html);
  const selectors = selector.split(",").map((s) => s.trim());
  let node = null;
  for (const sel of selectors) {
    if ($(sel).length) {
      node = $(sel).first();
      break;
    }
  }
  const target = node || $("body");
  target.find("script, style, noscript, nav, footer").remove();

  // Insert a newline marker after every block-level element so text()
  // can't silently fuse unrelated elements together.
  target.find(BLOCK_TAGS).after("\n");

  const raw = target.text();
  // Collapse runs of horizontal whitespace, but keep the newline
  // boundaries intact; then collapse 3+ consecutive newlines (empty
  // elements, nested blocks) down to a single one.
  return raw
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function fetchSource(source) {
  const res = await fetch(source.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; RailwayCompetitorMonitor/1.0; +https://railway.com)",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed for ${source.name}: ${res.status}`);
  }
  return res.text();
}

async function getLatestSnapshot(sourceName) {
  const { rows } = await pool.query(
    `SELECT * FROM snapshots WHERE source_name = $1 ORDER BY fetched_at DESC LIMIT 1`,
    [sourceName]
  );
  return rows[0] || null;
}

async function saveSnapshot(source, text) {
  const { rows } = await pool.query(
    `INSERT INTO snapshots (source_name, url, content_hash, raw_excerpt)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [source.name, source.url, hash(text), text.slice(0, 5000)]
  );
  return rows[0].id;
}

async function saveChange({ source, summary, significance, prevId, newId }) {
  await pool.query(
    `INSERT INTO changes (source_name, url, summary, significance, previous_snapshot_id, new_snapshot_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [source.name, source.url, summary, significance, prevId, newId]
  );
}

export async function checkSource(source) {
  const html = await fetchSource(source);
  const text = extractText(html, source.selector);
  const newHash = hash(text);

  const latest = await getLatestSnapshot(source.name);

  if (!latest) {
    // First time seeing this source — establish baseline, no diff to report.
    const id = await saveSnapshot(source, text);
    return { source: source.name, status: "baseline_created", snapshotId: id };
  }

  if (latest.content_hash === newHash) {
    return { source: source.name, status: "unchanged" };
  }

  const newId = await saveSnapshot(source, text);
  const { summary, significance } = await summarizeChange({
    sourceName: source.name,
    before: latest.raw_excerpt,
    after: text.slice(0, 5000),
  });

  await saveChange({
    source,
    summary,
    significance,
    prevId: latest.id,
    newId,
  });

  return { source: source.name, status: "change_detected", summary, significance };
}

export async function checkAllSources() {
  const results = [];
  for (const source of SOURCES) {
    try {
      const result = await checkSource(source);
      results.push(result);
    } catch (err) {
      results.push({ source: source.name, status: "error", error: err.message });
    }
  }
  return results;
}

// Scans every source's CURRENT content for items the page itself dates
// within `windowDays` — independent of this tool's poll/change history. See
// the long comment on extractRecentItems() in summarize.js for why this
// exists as a separate path from checkAllSources()/checkSource() above:
// hash-diffing only ever reports "changed since last poll," which is blind
// to real, recent updates on pages this tool hasn't polled through yet, or
// pages that update less often than the poll interval.
//
// This does NOT write to the snapshots/changes tables — it's a read-only
// scan for display purposes, so it can't corrupt the change-detection
// history, and can safely be run as often as wanted without side effects.
export async function scanRecentAcrossSources(windowDays) {
  const results = [];
  for (const source of SOURCES) {
    try {
      const html = await fetchSource(source);
      const text = extractText(html, source.selector);
      const items = await extractRecentItems({ sourceName: source.name, content: text, windowDays });
      results.push({
        source: source.name,
        url: source.url,
        items,
      });
    } catch (err) {
      results.push({ source: source.name, url: source.url, items: [], error: err.message });
    }
  }
  return results;
}
