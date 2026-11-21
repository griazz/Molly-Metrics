import fs from "node:fs";

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
// Example X_FEED_SOURCE: "https://rsshub.app/twitter/user/{handle}" or any RSS/Atom feed URL template
const X_FEED_SOURCE = process.env.X_FEED_SOURCE || "";

if (!APPS_SCRIPT_URL) {
  console.error("Missing APPS_SCRIPT_URL secret.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("scripts/watchlist.json", "utf8"));
const minLikes = Number(config.minLikes ?? 25);
const requiredTh = String(config.requiredTh || "TH19").toUpperCase();
const builders = Array.isArray(config.builders) ? config.builders : [];

// 1. Pull recent tweet IDs for a builder handle from your RSS/feed bridge
async function getRecentStatusIds(handle) {
  if (!X_FEED_SOURCE) {
    console.warn("No X_FEED_SOURCE set — skipping feed lookup.");
    return [];
  }
  const feedUrl = X_FEED_SOURCE.replace("{handle}", encodeURIComponent(handle));
  const res = await fetch(feedUrl, { headers: { "User-Agent": "MollyMetricsBot/1.0" } });
  if (!res.ok) {
    console.warn(`Feed fetch failed for @${handle}: HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const matches = xml.matchAll(/(?:x\.com|twitter\.com)\/[^\/?#\s"'<>]+\/status\/(\d+)/gi);
  const ids = new Set();
  for (const m of matches) ids.add(m[1]);
  return Array.from(ids).slice(0, 10); // Check the 10 most recent posts per builder
}

// 2. Fetch full tweet details via fxtwitter (same endpoint used in bases.html & Code.js)
async function fetchTweet(handle, statusId) {
  const res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}/status/${statusId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.tweet || null;
}

function extractCanonicalId(url) {
  const m = String(url).match(/[?&]id=([^&#\s]+)/i);
  if (!m) return url.trim();
  try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
}

function extractClashLinks(tweet) {
  const chunks = [tweet.text || ""];
  for (const f of tweet.raw_text?.facets || []) {
    if (f.replacement) chunks.push(f.replacement);
    if (f.original?.startsWith("http")) chunks.push(f.original);
  }
  const rawMatches = chunks.join("\n").match(/https?:\/\/(?:www\.)?link\.clashofclans\.com\/[^\s<>"')\]\}]+/gi) || [];
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
  try { decoded = decodeURIComponent(primaryUrl); } catch {}
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
  let saved = 0, skipped = 0;

  for (const rawHandle of builders) {
    const handle = rawHandle.replace(/^@/, "");
    const statusIds = await getRecentStatusIds(handle);

    for (const id of statusIds) {
      const tweet = await fetchTweet(handle, id);
      if (!tweet) continue;

      const baseLinks = extractClashLinks(tweet);
      const images = (tweet.media?.photos || []).map(p => p.url).filter(Boolean);
      const likes = Number(tweet.likes || 0);
      const thNum = baseLinks[0] ? extractThNumber(baseLinks[0].url, tweet.text || "") : 0;

      // Filter: must have a Clash base link, at least 1 screenshot, enough likes, and matching TH
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
          postTimestamp: tweet.created_timestamp ? Number(tweet.created_timestamp) * 1000 : Date.now(),
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
    }
  }

  console.log(`Done. Saved: ${saved}, Skipped: ${skipped}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
