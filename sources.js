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
  {
    name: "Cloudflare Pages Changelog",
    url: "https://developers.cloudflare.com/changelog/product/pages/",
    selector: "main, article",
  },
  { name: "Cloudflare Blog", url: "https://blog.cloudflare.com/", selector: "main" },
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
};
