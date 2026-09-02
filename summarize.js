import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Whether a real API key is configured. Checked once at startup rather than
// per-call so a missing/invalid key fails fast and predictably instead of
// firing 38 individual API calls that each 401. Note: this only confirms a
// key is *present* — an invalid key (wrong/revoked) still won't be caught
// until the first real call, which summarizeChange/extractRecentItems
// handle by falling back to the rule-based path on any API error, not just
// a missing key. That fallback-on-error behavior is what actually made
// this tool keep working through the invalid-key incident during
// development, before the key was diagnosed and swapped for the
// no-credits fallback below.
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
if (!hasApiKey) {
  console.warn(
    "[summarize] No ANTHROPIC_API_KEY set — using rule-based fallback summaries instead of Claude. " +
      "Set the env var to enable AI-generated summaries and significance ratings."
  );
}

// ---------------------------------------------------------------------
// Rule-based fallbacks (no API cost). Used when hasApiKey is false, or
// when a live API call fails for any reason (auth, rate limit, network).
// These are deliberately simple and conservative — they don't try to
// imitate what Claude would say, they just surface the raw signal (what
// text is new, what dates are visible) so the tool stays useful without
// spending API credits, and it's honest about the tradeoff rather than
// hiding it.
// ---------------------------------------------------------------------

// Crude significance heuristic: longer diffs and diffs containing
// price/plan-shaped tokens are more likely to be real changes than short
// copy tweaks. This is intentionally rough — it exists to give the UI
// *some* signal to color-code by, not to match Claude's judgment.
function ruleBasedSignificance(addedText) {
  const lower = addedText.toLowerCase();
  const hasPriceSignal = /\$\d|\bpricing\b|\bplan\b|\bfree tier\b|\bGB\b|\bCPU\b/.test(lower);
  if (addedText.length > 400 || hasPriceSignal) return "MEDIUM";
  if (addedText.length > 1500) return "HIGH";
  return "LOW";
}

// Status pages repeat a small set of boilerplate phrases constantly — "No
// incidents reported [date]" for every day nothing happened, "Monitoring",
// "Update — we are continuing to..." at every stage of one ongoing
// incident. Each is a technically-real, differently-dated line, but a
// stream of them is routine operational noise, not competitive signal.
// This is a real, explicit filter (not a dedup trick) because the
// underlying problem isn't duplication — it's that "no incidents" is not
// informative regardless of how many different dates it's stamped with.
//
// Also filters generic marketing/nav chrome that shows up as "new" text
// purely because a promo banner rotated or A/B-tested — e.g. Render's
// careers page briefly diffed as a "MEDIUM significance change" because a
// migration-credits promo banner sitting inside <main> changed wording
// between polls, and the crude fallback diff had no way to know that
// wasn't a real content change. These patterns catch the most common
// forms of that (generic CTAs, nav labels) without needing to know every
// site's specific promo copy in advance.
const ROUTINE_NOISE_PATTERNS = [
  /^no incidents reported/i,
  /^all systems operational/i,
  /^\s*update\s*[-—]\s*(we are continuing|we're continuing)/i,
  /^\s*monitoring\s*[-—]/i,
  /^\s*investigating\s*[-—]/i,
  /^(sign in|get started|apply now|learn more|log ?in|sign ?up)\b/i,
  /\bmigrat(e|ion) (to|credits)\b/i,
  /^(migrating|evolve the cloud|elevate your craft)/i,
];

function isRoutineNoise(text) {
  const trimmed = text.trim();
  return ROUTINE_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Rough "what's new" extraction using a real contiguous-block diff instead
// of a bag-of-words filter. The previous version filtered `after` down to
// individual words not present in `before` and concatenated them in
// order — which produces garbled, out-of-context text when the "new"
// words are scattered across unrelated parts of the page (e.g. one word
// from a blog title here, one from a nav element there, stitched
// together into nonsense). This version finds actual contiguous runs of
// new text by walking both strings and only starting a new "run" when
// the word sequence actually diverges, which keeps real phrases intact.
function crudeAddedText(before, after) {
  if (!before) return after.slice(0, 300).trim();

  const beforeWords = before.split(/\s+/);
  const afterWords = after.split(/\s+/);
  const beforeSet = new Set(beforeWords);

  // Find contiguous runs of consecutive afterWords that are all "new"
  // (not merely present-somewhere-in-before, but part of an unbroken
  // stretch of unfamiliar text) — this is still not a true diff
  // algorithm, but requiring runs of 4+ consecutive new words rather than
  // any single new word sharply cuts down on stitching together
  // unrelated fragments.
  const runs = [];
  let current = [];
  for (const word of afterWords) {
    if (!beforeSet.has(word)) {
      current.push(word);
    } else {
      if (current.length >= 4) runs.push(current.join(" "));
      current = [];
    }
  }
  if (current.length >= 4) runs.push(current.join(" "));

  // Drop runs that are just marketing/nav chrome (promo banners, generic
  // CTAs) before picking one — otherwise a rotating banner can outrank a
  // genuinely smaller but real content change just by being longer text.
  const meaningfulRuns = runs.filter((run) => !isRoutineNoise(run));

  if (meaningfulRuns.length === 0) {
    // Nothing survived the noise filter — either the whole diff was
    // chrome, or there were no 4+ word runs at all. Returning empty
    // string (not raw after-text) signals "no real content change found"
    // to the caller, rather than silently falling back to unfiltered text.
    return "";
  }

  // Return the longest surviving run — most likely to be one real new
  // sentence/entry rather than a scattered fragment.
  return meaningfulRuns.sort((a, b) => b.length - a.length)[0];
}

function ruleBasedSummarizeChange({ before, after }) {
  const added = crudeAddedText(before, after);
  if (!added) {
    // The diff was real (hash changed) but everything new was filtered as
    // marketing/nav chrome — most likely a rotating promo banner, not an
    // actual content change. Reported as LOW rather than hidden entirely:
    // the page DID change, which is still worth a low-priority record,
    // just not worth surfacing as meaningful.
    return {
      summary: "Page content changed, but the difference looks like site chrome (nav, promo banner) rather than real content — no meaningful excerpt to show.",
      significance: "LOW",
    };
  }
  const trimmed = added.length > 220 ? `${added.slice(0, 220)}…` : added;
  return {
    summary: `Content changed (AI summary unavailable — no API credits). Excerpt of new text: "${trimmed}"`,
    significance: ruleBasedSignificance(added),
  };
}

// Regex-based date + nearby-text extraction, as a fallback for
// extractRecentItems(). Looks for common date formats (e.g. "September 01,
// 2026", "Sep 1, 2026") in the raw text and pulls a short excerpt following
// each match as a stand-in "summary." Cannot judge whether a date is
// actually within windowDays with the same nuance an LLM reading full
// context can — this checks the date against `today` directly, so it's
// mechanically accurate for dates it successfully parses, but it can't
// infer relative dates ("last week") the way the AI path could, and it
// will miss items whose dates are in a format this regex doesn't cover.
const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const DATE_RE = new RegExp(`(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "gi");
// Separate non-global instance for one-off strip operations (e.g. in
// dedup below) so it never shares/depends on DATE_RE's lastIndex state,
// which the main extraction loop relies on.
const DATE_RE_STRIP = new RegExp(`(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "gi");
const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function ruleBasedExtractRecentItems(content, windowDays) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const items = [];

  // Now that extractText() preserves element boundaries as newlines,
  // operate line-by-line instead of slicing raw character offsets across
  // the whole blob. This is the actual fix for excerpts that used to
  // mash unrelated page elements together (e.g. a name from one card
  // running into the next card's text) — each line here corresponds to
  // one real block-level element on the page, so an excerpt drawn from a
  // date's own line (or the very next line) can't cross into unrelated
  // content the way raw character-slicing could.
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    DATE_RE.lastIndex = 0;
    const match = DATE_RE.exec(line);
    if (!match) continue;

    const [full, monthStr, dayStr, yearStr] = match;
    const monthKey = monthStr.slice(0, 3).toLowerCase();
    const monthIdx = MONTH_INDEX[monthKey];
    if (monthIdx === undefined) continue;
    const parsedDate = new Date(Number(yearStr), monthIdx, Number(dayStr));
    if (parsedDate < cutoff || parsedDate > now) continue;

    // The headline text can appear either before or after the date on the
    // same line, depending on the site's markup (e.g. "No incidents
    // reported. Sep 1, 2026" vs. "Sep 1, 2026 — New feature launched").
    // Try same-line-before first (usually the more complete phrase when
    // present), then same-line-after, then fall back to the next line.
    const beforeDate = line.slice(0, match.index).trim();
    const afterDate = line.slice(match.index + full.length).trim();
    const excerpt =
      beforeDate.length > 3 ? beforeDate : afterDate.length > 3 ? afterDate : (lines[i + 1] || "").trim();

    if (!excerpt || isRoutineNoise(excerpt)) continue;

    items.push({
      dateLabel: full,
      summary: excerpt.slice(0, 220),
      significance: ruleBasedSignificance(excerpt),
    });
  }

  // Status pages in particular tend to show the same incident restated at
  // each update (e.g. "Investigating" -> "Monitoring" -> "Resolved" for one
  // incident produces 2-3 near-identical entries with different dates).
  // Each is a technically-real distinct dated mention, but showing all of
  // them reads as noise rather than 2-3 separate events. Collapse entries
  // whose first ~60 characters match to just the most recent one.
  const seen = new Map(); // key: normalized first ~60 chars, value: kept
  const deduped = [];
  for (const item of items) {
    // Strip a possible leading date (some excerpts start with the *next*
    // entry's date bleeding in from truncation) before comparing, so
    // "Aug 28, 2026 Projects failing..." and "Projects failing..." are
    // recognized as the same underlying text.
    const normalized = item.summary.replace(DATE_RE_STRIP, "").trim().slice(0, 60).toLowerCase();
    if (seen.has(normalized)) continue;
    seen.set(normalized, true);
    deduped.push(item);
  }
  return deduped;
}

// Ask Claude to describe what changed and why a growth/content marketer
// would care, rather than just returning a raw text diff. Falls back to a
// rule-based summary (no API cost) if no key is configured or the call
// fails for any reason (e.g. invalid key, rate limit).
export async function summarizeChange({ sourceName, before, after }) {
  if (!hasApiKey) return ruleBasedSummarizeChange({ before, after });

  const prompt = `You are a competitive intelligence analyst for Railway (a cloud deployment platform).
A page from a competitor ("${sourceName}") has changed. Compare the two snapshots below and:
1. Summarize what changed in 1-3 sentences, in plain language.
2. Rate significance as LOW, MEDIUM, or HIGH based on whether this looks like a real product/pricing/positioning change vs. minor copy edits or noise.

Respond ONLY in this exact format, no preamble:
SUMMARY: <your summary>
SIGNIFICANCE: <LOW|MEDIUM|HIGH>

--- BEFORE ---
${before?.slice(0, 3000) || "(no prior content)"}

--- AFTER ---
${after.slice(0, 3000)}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.find((b) => b.type === "text")?.text || "";
    const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=\nSIGNIFICANCE:|$)/s);
    const sigMatch = text.match(/SIGNIFICANCE:\s*(LOW|MEDIUM|HIGH)/i);

    return {
      summary: summaryMatch ? summaryMatch[1].trim() : text.trim() || "Change detected (summary unavailable).",
      significance: sigMatch ? sigMatch[1].toUpperCase() : "LOW",
    };
  } catch (err) {
    console.warn(`[summarize] Claude call failed for "${sourceName}" (${err.message}) — using rule-based fallback.`);
    return ruleBasedSummarizeChange({ before, after });
  }
}

// Reads a single page's CURRENT content and extracts items the page itself
// dates within the requested window — independent of whether this tool has
// ever polled the page before. This exists because change-detection (the
// function above) is blind to history: with 6-hour polling, if a company's
// last real update was 3 days ago, checkSource() will correctly report
// "unchanged" every single run, even though a real, recent, dated update
// exists on the page right now. This function answers "what does the page
// say happened recently" using dates visible in the page's own content
// (e.g. "Aug 28, 2026" on a changelog entry), not this tool's poll history.
//
// Honest limitation: this depends on the page actually showing legible
// dates in the fetched HTML/text. Pages that render dates via client-side
// JS (not present in server-rendered HTML) or that don't date entries at
// all will come back empty — that's a real gap, not a silent failure, and
// the caller should treat an empty result as "couldn't find dated items,"
// not "confirmed nothing happened." Falls back to regex-based date
// scanning (no API cost) if no key is configured or the call fails.
export async function extractRecentItems({ sourceName, content, windowDays }) {
  if (!hasApiKey) return ruleBasedExtractRecentItems(content, windowDays);

  const prompt = `You are a competitive intelligence analyst for Railway (a cloud deployment platform).
Below is the current content of a page from a competitor ("${sourceName}"). The page may list changelog entries, blog posts, or other dated items.

Find any items that appear to be dated within the last ${windowDays} days (relative to today, ${new Date().toISOString().slice(0, 10)}). For each one you find, output one line in this exact format:
ITEM: <date if visible, else "undated"> | <1-sentence summary> | <LOW|MEDIUM|HIGH significance>

If the page has no visible dates at all, or nothing appears to fall within the last ${windowDays} days, respond with exactly:
NONE

Do not guess dates that aren't actually visible in the content. Do not include items you're not reasonably confident are within the window.

--- PAGE CONTENT ---
${content.slice(0, 6000)}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.find((b) => b.type === "text")?.text || "";
    if (/^\s*NONE\s*$/i.test(text.trim())) return [];

    const items = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^ITEM:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(LOW|MEDIUM|HIGH)\s*$/i);
      if (match) {
        items.push({
          dateLabel: match[1].trim(),
          summary: match[2].trim(),
          significance: match[3].toUpperCase(),
        });
      }
    }
    return items;
  } catch (err) {
    console.warn(`[summarize] Claude call failed for "${sourceName}" (${err.message}) — using rule-based fallback.`);
    return ruleBasedExtractRecentItems(content, windowDays);
  }
}

// Debug: run extractRecentItems on already-known content and show the RAW
// Claude response before any parsing, so a parsing bug and a "Claude found
// nothing" outcome can be told apart on sight. Does NOT fall back silently
// — surfaces the raw error or the rule-based result explicitly, since this
// endpoint exists specifically to diagnose problems, not paper over them.
export async function debugExtractRecentItems({ sourceName, content, windowDays }) {
  const todayStr = new Date().toISOString().slice(0, 10);

  if (!hasApiKey) {
    return {
      hasApiKey: false,
      todayUsedInPrompt: todayStr,
      note: "No ANTHROPIC_API_KEY configured — showing rule-based fallback result instead of a Claude call.",
      ruleBasedResult: ruleBasedExtractRecentItems(content, windowDays),
    };
  }

  const prompt = `You are a competitive intelligence analyst for Railway (a cloud deployment platform).
Below is the current content of a page from a competitor ("${sourceName}"). The page may list changelog entries, blog posts, or other dated items.

Find any items that appear to be dated within the last ${windowDays} days (relative to today, ${todayStr}). For each one you find, output one line in this exact format:
ITEM: <date if visible, else "undated"> | <1-sentence summary> | <LOW|MEDIUM|HIGH significance>

If the page has no visible dates at all, or nothing appears to fall within the last ${windowDays} days, respond with exactly:
NONE

Do not guess dates that aren't actually visible in the content. Do not include items you're not reasonably confident are within the window.

--- PAGE CONTENT ---
${content.slice(0, 6000)}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const rawText = response.content.find((b) => b.type === "text")?.text || "";
    return { hasApiKey: true, todayUsedInPrompt: todayStr, promptLength: prompt.length, rawClaudeResponse: rawText };
  } catch (err) {
    return {
      hasApiKey: true,
      todayUsedInPrompt: todayStr,
      apiError: err.message,
      note: "API key is configured but the call failed (see apiError). Showing rule-based fallback result too.",
      ruleBasedResult: ruleBasedExtractRecentItems(content, windowDays),
    };
  }
}
