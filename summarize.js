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
