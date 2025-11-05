// scraperClient.mjs
const BASE = (process.env.SCRAPER_BASE || 'http://127.0.0.1:8787').replace(/\/+$/,'');
const KEY  = process.env.SCRAPER_KEY || '';

async function fetchJSON(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      ...(KEY ? { 'x-api-key': KEY } : {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`Scraper HTTP ${res.status} ${res.statusText} for ${url}\n${txt}`);
  }
  return res.json();
}

export async function fetchScraperDetail(accountId) {
  return fetchJSON(`/detail/${encodeURIComponent(accountId)}`);
}

export async function searchScraper(q, limit = 5) {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return fetchJSON(`/search?${params.toString()}`);
}

// Optional: massage the scraper detail to something close to your API shape.
export function normalizeScrapedDetail(d) {
  return d; // keep as-is unless you want to reshape fields here
}
