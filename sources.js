// Sources to monitor. Each entry defines where to look and how to extract
// meaningful content (selector) so we diff signal, not boilerplate/nav HTML.
//
// NOTE ON SOURCE SELECTION: the "obvious" sources — render.com/changelog,
// vercel.com/changelog, blog.heroku.com — return HTTP 403 to server-side
// fetches from at least some IP ranges (verified while building this; likely
// bot/WAF protection, not necessarily true from Railway's network). Rather
// than ship unverified guesses, this config uses each competitor's public
// GitHub releases page as a reliable, scraper-friendly proxy for "what
// shipped recently" — verified working end-to-end during development.
// Swap in the marketing changelog URLs directly once deployed on Railway,
// if those turn out to be reachable from its network (worth testing first).
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

// Marketing-site sources to try once deployed on Railway's own network —
// these are the higher-signal pages (actual product/positioning changes,
// not just CLI version bumps) but were unreachable (403) from this
// development sandbox, so they're unverified rather than assumed broken.
export const CANDIDATE_SOURCES_TO_VERIFY_ON_DEPLOY = [
  { name: "Render Changelog", url: "https://render.com/changelog", selector: "main" },
  { name: "Vercel Changelog", url: "https://vercel.com/changelog", selector: "main" },
  { name: "Heroku Blog", url: "https://blog.heroku.com/", selector: "main, body" },
  { name: "Fly.io Blog", url: "https://fly.io/blog/", selector: "main, article, body" },
];
