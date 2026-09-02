// Sources to monitor. Each entry defines where to look and how to extract
// meaningful content (selector) so we diff signal, not boilerplate/nav HTML.
//
// SOURCE VERIFICATION HISTORY: every URL below returned HTTP 403 when
// tested from the local development sandbox, but 200 once deployed on
// Railway (verified via the /api/test-candidates diagnostic endpoint,
// tested in two batches — 16 core sources, then 29 more across status,
// pricing, jobs, and CLI-release channels). The 403s were specific to the
// sandbox's IP/ASN, not the sites — Railway's outbound network has had no
// reachability issues on any developer-platform domain tried so far.
//
// CHANNEL NOTES (signal-quality expectations, not just reachability):
// - changelog / blog / docs: highest signal, lowest noise. Purpose-built
//   to be read as "what changed."
// - status: low noise expected — most run on templated status providers
//   (Statuspage.io-style) with structured incident/component sections.
// - pricing: real competitive signal, but pages often carry dynamic
//   elements (currency/region toggles, embedded calculators) that can
//   produce false-positive diffs unrelated to an actual price change.
//   summarize.js's significance rating is the main defense against noise
//   here — watch actual detected "changes" for a few cycles before fully
//   trusting this channel.
// - jobs: expected to be the noisiest channel by far. Postings open and
//   close constantly, so hash-diffing the full page will likely fire
//   often on churn that has nothing to do with hiring *strategy*. Kept in
//   because it was requested, but if it turns out to mostly produce LOW-
//   significance noise, the fix is diffing role titles/count specifically
//   rather than full-page text — not attempted yet.
// - cli_releases: solid secondary signal (shipped features, sometimes
//   ahead of the changelog), low noise (append-only release lists).
//
// NOT included: X/Twitter (returns 200, but real post content needs
// auth/JS rendering a plain fetch won't get — would just diff on
// login-wall noise) and HN/Reddit mentions (structurally not a "diff a
// page" problem — needs the HN Algolia API filtering by post creation
// time, not page-content hashing; not implemented).
// Homepage URL for each company tracked in SOURCES, keyed by the same
// "company" string the dashboard derives from source names (the first
// word/token). Kept as an explicit map rather than derived from source
// URLs because several sources point at subdomains (status.render.com,
// github.com/...) that aren't the company's actual homepage.
export const COMPANY_HOMEPAGES = {
  Render: "https://render.com",
  Vercel: "https://vercel.com",
  "Fly.io": "https://fly.io",
  Heroku: "https://www.heroku.com",
  Netlify: "https://www.netlify.com",
  Cloudflare: "https://www.cloudflare.com",
  Supabase: "https://supabase.com",
  Northflank: "https://northflank.com",
};

export const SOURCES = [
  // ============================== RENDER ==============================
  { name: "Render Changelog", url: "https://render.com/changelog", selector: "main" },
  { name: "Render Blog", url: "https://render.com/blog", selector: "main" },
  { name: "Render Docs", url: "https://render.com/docs", selector: "main" },
  { name: "Render Status", url: "https://status.render.com", selector: "main, body" },
  { name: "Render Pricing", url: "https://render.com/pricing", selector: "main" },
  { name: "Render Careers", url: "https://render.com/careers", selector: "main" },
  {
    name: "Render CLI Releases",
    url: "https://github.com/render-oss/cli/releases",
    selector: ".repository-content, main",
  },

  // ============================== VERCEL ===============================
  { name: "Vercel Changelog", url: "https://vercel.com/changelog", selector: "main" },
  { name: "Vercel Blog", url: "https://vercel.com/blog", selector: "main" },
  { name: "Vercel Docs (What's New)", url: "https://vercel.com/docs", selector: "main" },
  { name: "Vercel Status", url: "https://www.vercel-status.com", selector: "main, body" },
  { name: "Vercel Pricing", url: "https://vercel.com/pricing", selector: "main" },
  { name: "Vercel Careers", url: "https://vercel.com/careers", selector: "main" },
  {
    name: "Vercel CLI Releases",
    url: "https://github.com/vercel/vercel/releases",
    selector: ".repository-content, main",
  },

  // ============================== FLY.IO ================================
  { name: "Fly.io Blog", url: "https://fly.io/blog/", selector: "main, article, body" },
  { name: "Fly.io Docs", url: "https://fly.io/docs/", selector: "main" },
  { name: "Fly.io Status", url: "https://status.flyio.net", selector: "main, body" },
  { name: "Fly.io Pricing", url: "https://fly.io/docs/about/pricing/", selector: "main" },
  { name: "Fly.io Jobs", url: "https://fly.io/jobs", selector: "main" },
  {
    name: "Fly.io CLI Releases (flyctl)",
    url: "https://github.com/superfly/flyctl/releases",
    selector: ".repository-content, main",
  },

  // ============================== HEROKU ================================
  { name: "Heroku Blog", url: "https://blog.heroku.com/", selector: "main, body" },
  { name: "Heroku Status", url: "https://status.heroku.com", selector: "main, body" },

  // ============================== NETLIFY ===============================
  { name: "Netlify Changelog", url: "https://www.netlify.com/changelog/", selector: "main" },
  { name: "Netlify Blog", url: "https://www.netlify.com/blog/", selector: "main" },
  { name: "Netlify Status", url: "https://www.netlifystatus.com", selector: "main, body" },
  { name: "Netlify Pricing", url: "https://www.netlify.com/pricing/", selector: "main" },
  { name: "Netlify Careers", url: "https://www.netlify.com/careers/", selector: "main" },

  // ============================ CLOUDFLARE ==============================
  {
    name: "Cloudflare Pages Changelog",
    url: "https://developers.cloudflare.com/changelog/product/pages/",
    selector: "main, article",
  },
  { name: "Cloudflare Blog", url: "https://blog.cloudflare.com/", selector: "main" },
  { name: "Cloudflare Status", url: "https://www.cloudflarestatus.com", selector: "main, body" },
  { name: "Cloudflare Careers", url: "https://www.cloudflare.com/careers/", selector: "main" },

  // ============================== SUPABASE ===============================
  { name: "Supabase Changelog", url: "https://supabase.com/changelog", selector: "main" },
  { name: "Supabase Blog", url: "https://supabase.com/blog", selector: "main" },
  { name: "Supabase Status", url: "https://status.supabase.com", selector: "main, body" },
  { name: "Supabase Careers", url: "https://supabase.com/careers", selector: "main" },

  // ============================= NORTHFLANK ===============================
  { name: "Northflank Changelog", url: "https://northflank.com/changelog", selector: "main" },
  { name: "Northflank Pricing", url: "https://northflank.com/pricing", selector: "main" },
  { name: "Northflank Careers", url: "https://northflank.com/careers", selector: "main" },
];

// Not promoted — either unreliable for this pattern (social, needs auth/JS)
// or needs a different mechanism entirely (community mentions, needs an
// API rather than a page diff). See the long comment above SOURCES for why.
export const CANDIDATE_SOURCES = {
  social: [
    { name: "Render (X/Twitter)", url: "https://x.com/render", selector: "main, body" },
    { name: "Vercel (X/Twitter)", url: "https://x.com/vercel", selector: "main, body" },
  ],
  community_note:
    "HN/Reddit mentions need the HN Algolia API (new-items-since-timestamp), not a page diff — not implemented yet.",
};
