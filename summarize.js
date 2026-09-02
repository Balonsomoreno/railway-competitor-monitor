import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Ask Claude to describe what changed and why a growth/content marketer
// would care, rather than just returning a raw text diff.
export async function summarizeChange({ sourceName, before, after }) {
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
// not "confirmed nothing happened."
export async function extractRecentItems({ sourceName, content, windowDays }) {
  const prompt = `You are a competitive intelligence analyst for Railway (a cloud deployment platform).
Below is the current content of a page from a competitor ("${sourceName}"). The page may list changelog entries, blog posts, or other dated items.

Find any items that appear to be dated within the last ${windowDays} days (relative to today, ${new Date().toISOString().slice(0, 10)}). For each one you find, output one line in this exact format:
ITEM: <date if visible, else "undated"> | <1-sentence summary> | <LOW|MEDIUM|HIGH significance>

If the page has no visible dates at all, or nothing appears to fall within the last ${windowDays} days, respond with exactly:
NONE

Do not guess dates that aren't actually visible in the content. Do not include items you're not reasonably confident are within the window.

--- PAGE CONTENT ---
${content.slice(0, 6000)}`;

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
}
