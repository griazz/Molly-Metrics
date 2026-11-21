import fs from "node:fs";

const APPS_SCRIPT_URL = (process.env.APPS_SCRIPT_URL || "").trim().replace(/^["']|["']$/g, "");
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

// 1. Discover recent media post IDs via FxTwitter API v2 + RSS feed
async function getRecentStatusIds(handle) {
  const ids = new Set();

  try {
    const apiRes = await fetch(
      `https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/media`
    );
    if (apiRes.ok) {
      const json = await apiRes.json();
      const rawStr = JSON.stringify(json);
      for (const m of rawStr.matchAll(/"(?:id|rest_id|status_id)"\s*:\s*"(\d{15,22})"/g)) {
        ids.add(m[1]);
      }
      for (const m of rawStr.matchAll(/\/status\/(\d{15,22})/g)) {
        ids.add(m[1]);
      }
    }
  } catch {}

  if (ids.size === 0) {
    try {
      const rssRes = await fetch(
        `https://fxtwitter.com/${encodeURIComponent(handle)}/media.xml?count=15`
      );
      if (rssRes.ok) {
        const xml = await rssRes.text();
        for (const m of xml.matchAll(/(?:x\.com|twitter\.com|fxtwitter\.com)\/[^\/?#\s"'<>]+\/status\/(\d+)/gi)) {
          ids.add(m[1]);
        }
      }
    } catch {}
  }

  console.log(`  @${handle}: found ${ids.size} media post(s)`);
  return Array.from(ids).slice(0, 10);
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
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

// Strict validator: must be a Clash OpenLayout link whose decoded `id=` starts with the required TH (e.g. "TH19:")
function isMatchingThLayoutUrl(rawUrl, targetTh) {
  let decoded = String(rawUrl || "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  if (!/link\.clashofclans\.com/i.test(decoded)) return false;
  if (!/[?&]action=OpenLayout(?:&|$)/i.test(decoded)) return false;

  const idMatch = decoded.match(/[?&]id=([^&#\s]+)/i);
  if (!idMatch) return false;
  return idMatch[1].toUpperCase().startsWith(`${targetTh}:`);
}

function extractValidLayoutLinksFromTweet(tweet, targetTh) {
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
    if (!isMatchingThLayoutUrl(clean, targetTh)) continue;
    const canon = extractCanonicalId(clean);
    if (canon && !seen.has(canon)) {
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

// 3. Only check self-replies by the SAME builder handle (ignores comments from other users)
async function fetchAuthorSelfReplyLinks(statusId, handle, targetTh) {
  try {
    const res = await fetch(`https://api.fxtwitter.com/2/thread/${encodeURIComponent(statusId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    const replies = Array.isArray(data?.replies)
      ? data.replies
      : Array.isArray(data?.thread)
      ? data.thread
      : [];

    const lowerHandle = handle.toLowerCase();
    const seen = new Set();
    const links = [];

    for (const item of replies) {
      const tw = item?.tweet || item;
      const author = String(tw?.author?.screen_name || "").toLowerCase();
      if (author && author !== lowerHandle) continue;

      for (const link of extractValidLayoutLinksFromTweet(tw, targetTh)) {
        if (!seen.has(link.canonicalId)) {
          seen.add(link.canonicalId);
          links.push({ ...link, id: `link_${links.length + 1}`, label: `Base #${links.length + 1}` });
        }
      }
    }
    return links;
  } catch {
    return [];
  }
}

function extractCcTroops(text) {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200D•\-–—|>]+/gu, "")
      .trim();
    if (!line) continue;

    let m = line.match(
      /^(?:cc(?:\s*(?:troops|comp(?:osition)?))?|clan\s*castle)\s*(?:[:\-–—=：]\s*|\s+)(.+)$/i
    );

    if (!m && /^🏰/.test(rawLine.trim())) {
      m = [null, line];
    }

    if (!m) {
      const paren = line.match(/\(([^()]{3,60})\)/);
      if (paren && /\b(?:ig|ice|furnace|witch|witches|hh|head\s*hunter|hound|lava|gob|goblin|arch|archer|loon|balloon|dragon|super|valk|minion|titan|yeti|druid)\b/i.test(paren[1])) {
        m = [null, paren[1]];
      }
    }

    if (m && m[1]) {
      const cleaned = m[1]
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
        .replace(/^[:\-–—=：\s]+|[:\-–—=：\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (cleaned && cleaned.length <= 80 && !/^link\b/i.test(cleaned)) {
        return cleaned;
      }
    }
  }
  return "";
}

function extractTags(text) {
  const hay = String(text || "");
  const rules = [
    { tag: "Progress",    rx: /\bprogr?ess(?:\s+base)?\b/i },
    { tag: "L1",          rx: /\b(?:l\s*[123]|legend\s*1)\b/i },
    { tag: "Legend",      rx: /\b(?:legend|legends|ll|l\s*[123])\b/i },
    { tag: "Ranked",      rx: /\b(?:ranked|all\s+ranks|any\s+league)\b/i },
    { tag: "War",         rx: /\b(?:war|cwl)\b/i },
    { tag: "Pro / ESL",   rx: /\b(?:esl|world\s*championship|worlds|tribe\s*gaming|pod\s*gear)\b/i },
    { tag: "Tested",      rx: /\b(?:tested|unburnt|no\s+triples)\b/i },
    { tag: "Untested",    rx: /\b(?:untested|fresh\s+custom)\b/i },
    { tag: "Anti-Bowler", rx: /\banti[\s-]?bowler\b/i },
    { tag: "Anti-LaLo",   rx: /\blalo\b/i },
    { tag: "Rage/Poison", rx: /\brage[\s\/-]?poison\b/i }
  ];
  const tags = ["Auto-X"];
  for (const r of rules) {
    if (r.rx.test(hay) && !tags.includes(r.tag)) tags.push(r.tag);
  }
  return tags;
}

async function main() {
  const todaysBuilders = getBuildersForRun(allBuilders);
  const thNumber = parseInt(requiredTh.replace(/\D/g, ""), 10) || 19;
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

      const images = (tweet.media?.photos || []).map((p) => p.url).filter(Boolean);
      const likes = Number(tweet.likes || 0);
      if (!images.length || likes < minLikes) {
        skipped++;
        continue;
      }

      let baseLinks = extractValidLayoutLinksFromTweet(tweet, requiredTh);
      if (baseLinks.length === 0) {
        baseLinks = await fetchAuthorSelfReplyLinks(id, handle, requiredTh);
      }

      if (!baseLinks.length) {
        skipped++;
        continue;
      }

      const combinedText = tweet.text || "";
      const payload = {
        action: "saveBase",
        base: {
          thLevel: thNumber,
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
          ccTroops: extractCcTroops(combinedText),
          tags: extractTags(combinedText),
          notes: combinedText.slice(0, 140),
          copies: 0
        }
      };

      const saveRes = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      const result = await saveRes.json();
      console.log(`  -> @${handle}/${id}: ${result.status || result.error}`);

      if (result.status === "success") saved++;
      else if (result.status === "duplicate_blocked") duplicates++;
    }

    await sleep(2000);
  }

  console.log(`Batch complete. Saved: ${saved}, Duplicates blocked: ${duplicates}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
