// Sources to monitor. Each entry defines where to look and how to extract
// meaningful content (selector) so we diff signal, not boilerplate/nav HTML.
//
// NOTE ON SOURCE SELECTION: every URL on vercel.com, render.com, fly.io, and
// x.com/twitter.com returned HTTP 403 when tested from the development
// sandbox — docs, blog, changelog, RSS feeds, and social profiles alike,
// uniformly, regardless of path. That pattern (blocked everywhere on a
// domain, not just one page) points to the sandbox's IP/ASN being blocked
// by a WAF (e.g. Cloudflare), not those specific pages being protected.
// Railway's outbound IP is a different network, so these are worth
// re-testing live — see CANDIDATE_SOURCES below for the higher-signal pages
// to try swapping in once deployed.
//
// GitHub release pages were the one category verified reachable from the
// sandbox, so they're the confirmed baseline tier.
export const SOURCES = [
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
];

// Higher-signal marketing/docs/social sources — unverified from the sandbox
// (all 403'd there), untested against Railway's network. Grouped by category
// so it's easy to try one category at a time rather than guessing blind.
// To activate: move entries into SOURCES above, redeploy, check the
// dashboard's source pills — a pill with a real "checks" count and no
// "error" status means it got through.
export const CANDIDATE_SOURCES = {
  changelog: [
    { name: "Render Changelog", url: "https://render.com/changelog", selector: "main" },
    { name: "Vercel Changelog", url: "https://vercel.com/changelog", selector: "main" },
  ],
  blog: [
    { name: "Render Blog", url: "https://render.com/blog", selector: "main" },
    { name: "Vercel Blog", url: "https://vercel.com/blog", selector: "main" },
    { name: "Fly.io Blog", url: "https://fly.io/blog/", selector: "main, article, body" },
    { name: "Heroku Blog", url: "https://blog.heroku.com/", selector: "main, body" },
  ],
  docs: [
    { name: "Vercel Docs (What's New)", url: "https://vercel.com/docs", selector: "main" },
    { name: "Render Docs", url: "https://render.com/docs", selector: "main" },
    { name: "Fly.io Docs", url: "https://fly.io/docs/", selector: "main" },
  ],
  social: [
    // Twitter/X almost never allows unauthenticated server-side scraping
    // (separate from the WAF issue — it requires login for most content).
    // Nitter mirrors are a common workaround but are unreliable/frequently
    // down; listed here as a known-fragile option, not a first choice.
    { name: "Render (X/Twitter)", url: "https://x.com/render", selector: "main, body" },
    { name: "Vercel (X/Twitter)", url: "https://x.com/vercel", selector: "main, body" },
  ],
};
