// Sources to monitor. Each entry defines where to look and how to extract
// meaningful content (selector) so we diff signal, not boilerplate/nav HTML.
//
// SOURCE VERIFICATION HISTORY: every URL on vercel.com, render.com, fly.io
// returned HTTP 403 when tested from the local development sandbox — but
// once deployed on Railway, the same URLs all returned 200 (verified via
// the /api/test-candidates diagnostic endpoint). The 403s were specific to
// the sandbox's IP/ASN, not the sites themselves — worth remembering as a
// real data point about scraper accessibility varying by network origin.
//
// This list uses each competitor's official changelog + blog + docs — the
// highest-signal pages for tracking real product and positioning changes,
// as opposed to CLI release notes (see CANDIDATE_SOURCES below for those
// and social, which is still unused).
export const SOURCES = [
  // -- Render --
  { name: "Render Changelog", url: "https://render.com/changelog", selector: "main" },
  { name: "Render Blog", url: "https://render.com/blog", selector: "main" },
  { name: "Render Docs", url: "https://render.com/docs", selector: "main" },

  // -- Vercel --
  { name: "Vercel Changelog", url: "https://vercel.com/changelog", selector: "main" },
  { name: "Vercel Blog", url: "https://vercel.com/blog", selector: "main" },
  { name: "Vercel Docs (What's New)", url: "https://vercel.com/docs", selector: "main" },

  // -- Fly.io --
  { name: "Fly.io Blog", url: "https://fly.io/blog/", selector: "main, article, body" },
  { name: "Fly.io Docs", url: "https://fly.io/docs/", selector: "main" },

  // -- Heroku --
  { name: "Heroku Blog", url: "https://blog.heroku.com/", selector: "main, body" },

  // -- Netlify (new) --
  { name: "Netlify Changelog", url: "https://www.netlify.com/changelog/", selector: "main" },
  { name: "Netlify Blog", url: "https://www.netlify.com/blog/", selector: "main" },

  // -- Cloudflare Pages (new) --
  { name: "Cloudflare Pages Changelog", url: "https://developers.cloudflare.com/changelog/product/pages/", selector: "main, article" },
  { name: "Cloudflare Blog", url: "https://blog.cloudflare.com/", selector: "main" },

  // -- Supabase (new, adjacent dev-infra platform) --
  { name: "Supabase Changelog", url: "https://supabase.com/changelog", selector: "main" },
  { name: "Supabase Blog", url: "https://supabase.com/blog", selector: "main" },

  // -- Northflank (new, direct competitor) --
  { name: "Northflank Changelog", url: "https://northflank.com/changelog", selector: "main" },
];

// Verified reachable (200) from Railway's network via /api/test-candidates,
// but not yet promoted into SOURCES above.
export const CANDIDATE_SOURCES = {
  cli_releases: [
    {
      name: "Vercel (vercel CLI releases)",
      url: "https://github.com/vercel/vercel/releases",
      selector: ".repository-content, main",
    },
    {
      name: "Fly.io (flyctl releases)",
      url: "https://github.com/superfly/flyctl/releases",
      selector: ".repository-content, main",
    },
    {
      name: "Render (render-cli releases)",
      url: "https://github.com/render-oss/cli/releases",
      selector: ".repository-content, main",
    },
  ],
  social: [
    // These return HTTP 200, but X/Twitter requires auth/JS rendering to
    // surface real post content — a plain fetch likely just diffs on
    // layout/login-wall noise, not actual tweets. Not promoted for that
    // reason; would need a different approach (e.g. Nitter mirror, or an
    // official API) to be genuinely useful.
    { name: "Render (X/Twitter)", url: "https://x.com/render", selector: "main, body" },
    { name: "Vercel (X/Twitter)", url: "https://x.com/vercel", selector: "main, body" },
  ],

  // -- Status pages -----------------------------------------------------
  // Verified real via search (not yet fetch-tested from Railway). Most run
  // on Atlassian Statuspage or a similar templated service, which tends to
  // be scraper-friendly and low-noise (structured incident/component
  // lists) — a good fit for the same diff-and-summarize pattern.
  status: [
    { name: "Render Status", url: "https://status.render.com", selector: "main, body" },
    { name: "Vercel Status", url: "https://www.vercel-status.com", selector: "main, body" },
    { name: "Fly.io Status", url: "https://status.flyio.net", selector: "main, body" },
    { name: "Heroku Status", url: "https://status.heroku.com", selector: "main, body" },
    { name: "Netlify Status", url: "https://www.netlifystatus.com", selector: "main, body" },
    { name: "Cloudflare Status", url: "https://www.cloudflarestatus.com", selector: "main, body" },
    { name: "Supabase Status", url: "https://status.supabase.com", selector: "main, body" },
  ],

  // -- Pricing pages ------------------------------------------------------
  // High AEO/competitive value (direct $ and plan-structure signal) but
  // genuinely the noisiest fit for a plain diff: pricing pages often embed
  // dynamic elements (region/currency toggles, usage calculators, A/B
  // tests) that can cause false-positive "changes" unrelated to actual
  // price moves. Worth trying, but summarize.js's significance rating is
  // doing real work here to filter noise — worth watching closely before
  // fully trusting this channel's signal quality.
  pricing: [
    { name: "Render Pricing", url: "https://render.com/pricing", selector: "main" },
    { name: "Vercel Pricing", url: "https://vercel.com/pricing", selector: "main" },
    { name: "Fly.io Pricing", url: "https://fly.io/docs/about/pricing/", selector: "main" },
    { name: "Netlify Pricing", url: "https://www.netlify.com/pricing/", selector: "main" },
    { name: "Northflank Pricing", url: "https://northflank.com/pricing", selector: "main" },
  ],

  // -- Job postings -------------------------------------------------------
  // Genuinely the worst fit for "diff a page and summarize the change" —
  // careers pages churn constantly (postings open/close) so hash-diffing
  // will fire very frequently with mostly low-signal noise (one req
  // closing, one opening) rather than meaningful hiring-strategy shifts.
  // Included because you asked for the channel, but this is the one most
  // likely to need custom logic (e.g. diffing role titles/count instead of
  // full-page text) rather than the shared pattern, if it turns out noisy
  // in practice.
  jobs: [
    { name: "Render Careers", url: "https://render.com/careers", selector: "main" },
    { name: "Vercel Careers", url: "https://vercel.com/careers", selector: "main" },
    { name: "Fly.io Jobs", url: "https://fly.io/jobs", selector: "main" },
    { name: "Netlify Careers", url: "https://www.netlify.com/careers/", selector: "main" },
    { name: "Cloudflare Careers", url: "https://www.cloudflare.com/careers/", selector: "main" },
    { name: "Supabase Careers", url: "https://supabase.com/careers", selector: "main" },
    { name: "Northflank Careers", url: "https://northflank.com/careers", selector: "main" },
  ],

  // -- Community mentions (HN/Reddit) --------------------------------------
  // Structurally different from every other channel: these aren't
  // company-owned pages to diff, they're third-party discussion. A
  // hash-diff approach doesn't fit at all — HN/Reddit search results
  // change on every page load (sorting, vote counts) independent of any
  // real new mention. This genuinely needs different logic: e.g. HN's
  // Algolia search API (https://hn.algolia.com/api) filtered by
  // numericFilters=created_at_i>{last_check_timestamp}, checking only for
  // *new* items rather than diffing page content. Not attempted here —
  // flagging honestly rather than shipping something that looks like it
  // works but mostly reports noise.
  community_note:
    "HN/Reddit mentions need the HN Algolia API (new-items-since-timestamp), not a page diff — not implemented yet.",
};
