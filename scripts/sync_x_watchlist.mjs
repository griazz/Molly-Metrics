import fs from "node:fs";

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const BATCH_MODE = (process.env.BATCH_MODE || "auto").toLowerCase();

if (!APPS_SCRIPT_URL) {
  console.error("Missing APPS_SCRIPT_URL secret in GitHub repository settings.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("scripts/watchlist.json", "utf8"));
const minLikes = Number(config.minLikes ?? 25);
const requiredTh = String(config.requiredTh || "TH19").toUpperCase();
const allBuilders = Array.isArray(config.builders) ? config.builders : [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getBuildersForRun(list) {
  if (BATCH_MODE === "all") {
    console.log(`Running ALL ${list.length} builders.`);
    return list;
  }
  const batchIndex = ["0", "1", "2", "3"].includes(BATCH_MODE)
    ? Number(BATCH_MODE)
    : Math.floor(new Date().getUTCHours() / 6);

  const batchSize = Math.ceil(list.length / 4);
  const start = batchIndex * batchSize;
  const slice = list.slice(start, start + batchSize);
  console.log(`Running Batch ${batchIndex + 1}/4 (${slice.length} of ${list.length} builders).`);
  return slice;
}

// 1. Discover recent Clash base post IDs via public search index (bypasses X syndication 429s)
async function getRecentStatusIds(handle) {
  const query = encodeURIComponent(`site:x.com/${handle}/status "link.clashofclans.com"`);
  const urls = [
    `https://www.bing.com/search?q=${query}&format=rss`,
    `https://html.duckduckgo.com/html/?q=${query}`
  ];

  const ids = new Set();
  for (const searchUrl of urls) {
    try {
      const res = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
      if (!res.ok) continue;
      const body = await res.text();
      const rx = new RegExp(`(?:x\\.com|twitter\\.com)\\/${handle}\\/status\\/(\\d+)`, "gi");
      for (const m of body.matchAll(rx)) {
        ids.add(m[1]);
      }
      if (ids.size > 0) break;
    } catch {}
  }

  return Array.from(ids).slice(0, 8);
}

// 2. Fetch full post data via fxtwitter
async function fetchTweet(handle, statusId) {
  try {
    const res = await fetch(
      `https://api.fxtwitter.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(statusId)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.tweet || null;
  } catch {
    return null;
  }
}

function extractCanonicalId(url) {
  const m = String(url).match(/[?&]id=([^&#\s]+)/i);
  if (!m) return url.trim();
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

function extractClashLinks(tweet) {
  const chunks = [tweet.text || ""];
  for (const f of tweet.raw_text?.facets || []) {
    if (f.replacement) chunks.push(f.replacement);
    if (f.original?.startsWith("http")) chunks.push(f.original);
  }
  const rawMatches =
    chunks.join("\n").match(/https?:\/\/(?:www\.)?link\.clashofclans\.com\/[^\s<>"')\]\}]+/gi) || [];

  const seen = new Set();
  const links = [];
  for (const raw of rawMatches) {
    const clean = raw.replace(/[.,;!?]+$/, "");
    const canon = extractCanonicalId(clean);
    if (!seen.has(canon)) {
      seen.add(canon);
      links.push({
        id: `link_${links.length + 1}`,
        label: `Base #${links.length + 1}`,
        url: clean,
        canonicalId: canon
      });
    }
  }
  return links;
}

function extractThNumber(primaryUrl, text) {
  let decoded = primaryUrl;
  try {
    decoded = decodeURIComponent(primaryUrl);
  } catch {}
  const m = `${decoded} ${text}`.match(/\bTH\s*(\d{1,2})\b/i);
  return m ? parseInt(m[1], 10) : 19;
}

function extractCcTroops(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:cc|clan\s*castle)(?:\s*[:\-–—]\s*|\s+)(.+)$/i);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  }
  return "";
}

function extractTags(text) {
  const tags = ["Auto-X"];
  if (/\branked\b/i.test(text)) tags.push("Ranked");
  if (/\b(?:legend|legends|ll)\b/i.test(text)) tags.push("Legend");
  if (/\b(?:war|cwl)\b/i.test(text)) tags.push("War");
  if (tags.length === 1) tags.push("Legend");
  return tags;
}

async function main() {
  const todaysBuilders = getBuildersForRun(allBuilders);
  let saved = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const rawHandle of todaysBuilders) {
    const handle = String(rawHandle).trim().replace(/^@/, "");
    if (!handle) continue;

    const statusIds = await getRecentStatusIds(handle);

    for (const id of statusIds) {
      const tweet = await fetchTweet(handle, id);
      if (!tweet) continue;

      const baseLinks = extractClashLinks(tweet);
      const images = (tweet.media?.photos || []).map((p) => p.url).filter(Boolean);
      const likes = Number(tweet.likes || 0);
      const thNum = baseLinks[0] ? extractThNumber(baseLinks[0].url, tweet.text || "") : 0;

      if (!baseLinks.length || !images.length || likes < minLikes || `TH${thNum}` !== requiredTh) {
        skipped++;
        continue;
      }

      const payload = {
        action: "saveBase",
        base: {
          thLevel: thNum,
          baseLink: baseLinks[0].url,
          canonicalId: baseLinks[0].canonicalId,
          baseLinks,
          imageUrl: images[0],
          images,
          creatorHandle: `@${tweet.author?.screen_name || handle}`,
          postUrl: tweet.url || `https://x.com/${handle}/status/${id}`,
          postTimestamp: tweet.created_timestamp
            ? Number(tweet.created_timestamp) * 1000
            : Date.now(),
          likes,
          ccTroops: extractCcTroops(tweet.text),
          tags: extractTags(tweet.text || ""),
          notes: (tweet.text || "").slice(0, 140),
          copies: 0
        }
      };

      const saveRes = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      const result = await saveRes.json();
      console.log(`@${handle}/${id} -> ${result.status || result.error}`);

      if (result.status === "success") saved++;
      else if (result.status === "duplicate_blocked") duplicates++;
    }

    await sleep(3000);
  }

  console.log(`Batch complete. Saved: ${saved}, Duplicates blocked: ${duplicates}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
