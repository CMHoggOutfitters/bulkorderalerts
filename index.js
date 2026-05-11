// ── Re:amaze → Slack bulk-order alert poller ─────────────────────────────────
// Polls the Re:amaze API every POLL_INTERVAL_SECONDS for new customer messages.
// Alerts Slack when:
//   (a) a NEW customer message matches a bulk keyword, OR
//   (b) any customer message comes in on a conversation tagged "confirmed-bulk"
//       (so once you confirm a lead is real, every follow-up reply pings Slack)
// Confirmed against docs: https://www.reamaze.com/api/get_messages

const http = require("http");

// ── Config (from env vars) ───────────────────────────────────────────────────
const REAMAZE_BRAND          = process.env.REAMAZE_BRAND;
const REAMAZE_LOGIN_EMAIL    = process.env.REAMAZE_LOGIN_EMAIL;
const REAMAZE_API_TOKEN      = process.env.REAMAZE_API_TOKEN;
const SLACK_WEBHOOK_URL      = process.env.SLACK_WEBHOOK_URL;
const SLACK_MENTION_USER_ID  = process.env.SLACK_MENTION_USER_ID;
const POLL_INTERVAL_SECONDS  = parseInt(process.env.POLL_INTERVAL_SECONDS || "60", 10);
const PORT                   = process.env.PORT || 3000;

const REQUIRED = { REAMAZE_BRAND, REAMAZE_LOGIN_EMAIL, REAMAZE_API_TOKEN, SLACK_WEBHOOK_URL };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) { console.error(`❌ Missing required env var: ${k}`); process.exit(1); }
}

// ── Tag that flags a conversation as a confirmed bulk lead ───────────────────
// Add this tag in Re:amaze to any conversation you've verified as a legit bulk
// inquiry. Every subsequent customer reply on that conversation will alert
// Slack, even without bulk keywords.
const CONFIRMED_BULK_TAG = "confirmed-bulk";

// ── Bulk keywords (case-insensitive substring match) ─────────────────────────
const BULK_KEYWORDS = [
  "bulk", "wholesale", "large order", "big order", "mass order",
  "volume order", "volume discount", "large quantity", "large quantities",
  "bulk order", "bulk purchase", "bulk pricing", "bulk price",
  "100 units", "200 units", "500 units", "1000 units",
  "dozen", "gross", "pallet", "pallets", "case of", "cases of",
  "corporate order", "company order", "business order",
  "reseller", "distributor", "distributor pricing",
  "for my business", "for our business", "for our company",
  "for my store", "for our store", "for resale",
  "can you accommodate", "can you handle",
  "hundreds", "thousands", "multiple cases",
];

// ── Exclusions ───────────────────────────────────────────────────────────────
const EXCLUDED_SUBJECTS = [
  "notification of payment received",
];

const EXCLUDED_DOMAINS = [
  "hoggoutfitters.com",
  "backinstock.org",
  "rangeme.com",
  "mg.postscriptapp.com",
  "email.factorydirectcraft.com",
  "arbusa.com",
  "marketplace.amazon.com",
];

// ── State ────────────────────────────────────────────────────────────────────
const seenMessageIds = new Set();
let isFirstPoll = true;

// Cache: conversation slug → { tags: [...], cachedAt: timestamp }
// Short TTL so newly added tags get picked up quickly.
const conversationTagsCache = new Map();
const TAG_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// ── Helpers ──────────────────────────────────────────────────────────────────
function buildMentionPrefix() {
  if (!SLACK_MENTION_USER_ID) return "";
  const ids = SLACK_MENTION_USER_ID.split(",").map(s => s.trim()).filter(Boolean);
  return ids.map(id => {
    if (id === "channel" || id === "here") return `<!${id}>`;
    return `<@${id}>`;
  }).join(" ") + " ";
}

function authHeader() {
  return "Basic " + Buffer.from(`${REAMAZE_LOGIN_EMAIL}:${REAMAZE_API_TOKEN}`).toString("base64");
}

async function fetchRecentMessages() {
  const url = `https://${REAMAZE_BRAND}.reamaze.io/api/v1/messages?filter=customer`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "Authorization": authHeader() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Re:amaze API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.messages || [];
}

// Fetch a conversation by slug to get its current tags. Uses a short TTL cache
// to avoid hammering the API on busy conversations.
async function fetchConversationTags(slug) {
  if (!slug) return [];
  const cached = conversationTagsCache.get(slug);
  if (cached && Date.now() - cached.cachedAt < TAG_CACHE_TTL_MS) {
    return cached.tags;
  }
  try {
    const url = `https://${REAMAZE_BRAND}.reamaze.io/api/v1/conversations/${encodeURIComponent(slug)}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "Authorization": authHeader() },
    });
    if (!res.ok) {
      console.error(`⚠️  Could not fetch conversation ${slug}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const tags = Array.isArray(data.tag_list) ? data.tag_list : [];
    conversationTagsCache.set(slug, { tags, cachedAt: Date.now() });
    return tags;
  } catch (err) {
    console.error(`⚠️  Error fetching conversation ${slug}:`, err.message);
    return [];
  }
}

function findKeywords(body) {
  if (!body) return [];
  const lower = body.toLowerCase();
  return BULK_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()));
}

function getExclusionReason(message) {
  const subject = (message.conversation?.subject || "").toLowerCase();
  for (const sub of EXCLUDED_SUBJECTS) {
    if (subject.includes(sub.toLowerCase())) return `subject contains "${sub}"`;
  }
  const email = (message.user?.email || "").toLowerCase();
  for (const domain of EXCLUDED_DOMAINS) {
    const d = domain.toLowerCase();
    if (email.endsWith("@" + d) || email.endsWith("." + d)) {
      return `sender domain "${d}"`;
    }
  }
  return null;
}

// ── Slack alert ──────────────────────────────────────────────────────────────
async function sendSlackAlert({ message, matchedKeywords, reason }) {
  const conv = message.conversation || {};
  const user = message.user || {};
  const subject = conv.subject || "(no subject)";
  const customerName = user.name || "Unknown";
  const customerEmail = user.email || "—";
  const slug = conv.slug || "";
  const conversationUrl = slug
    ? `https://${REAMAZE_BRAND}.reamaze.com/admin/conversations/${slug}`
    : `https://${REAMAZE_BRAND}.reamaze.com`;
  const body = (message.body || "").replace(/<[^>]+>/g, "");
  const preview = body.length > 400 ? body.slice(0, 397) + "..." : body;

  const mention = buildMentionPrefix();
  const isConfirmed = reason === "confirmed-bulk-tag";
  const headerText = isConfirmed ? "⭐ Confirmed Bulk Lead — New Reply" : "🚨 Bulk Order Inquiry";
  const triggerLine = isConfirmed
    ? `*Trigger:*\nConversation tagged \`${CONFIRMED_BULK_TAG}\` — every reply now alerts`
    : `*Keywords:*\n${(matchedKeywords || []).map(k => `\`${k}\``).join(", ")}`;

  const payload = {
    text: `${mention}${isConfirmed ? "⭐" : "🚨"} ${headerText}`,
    blocks: [
      ...(mention ? [{
        type: "section",
        text: { type: "mrkdwn", text: `${mention.trim()} 👈 heads up!` },
      }] : []),
      { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Customer:*\n${customerName}` },
          { type: "mrkdwn", text: `*Email:*\n${customerEmail}` },
          { type: "mrkdwn", text: `*Subject:*\n${subject}` },
          { type: "mrkdwn", text: triggerLine },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Message preview:*\n>${preview.replace(/\n/g, "\n>")}` },
      },
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "Open in Re:amaze →", emoji: true },
          url: conversationUrl,
          style: "primary",
        }],
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`❌ Slack webhook ${res.status}:`, await res.text());
  } else {
    console.log("✅ Slack alert sent");
  }
}

// ── Main poll loop ───────────────────────────────────────────────────────────
async function pollOnce() {
  try {
    const messages = await fetchRecentMessages();
    let newCount = 0, alertedCount = 0, excludedCount = 0, confirmedCount = 0;

    for (const msg of messages) {
      const id = msg.origin_id || `${msg.created_at}::${(msg.body || "").slice(0, 50)}`;
      if (seenMessageIds.has(id)) continue;
      seenMessageIds.add(id);
      newCount++;

      if (isFirstPoll) continue;

      // (1) Check exclusions FIRST — applies to both keyword & confirmed-tag paths
      const exclusionReason = getExclusionReason(msg);
      if (exclusionReason) {
        excludedCount++;
        console.log(`🛑 Excluded (${exclusionReason})`);
        continue;
      }

      // (2) Keyword match → alert
      const matches = findKeywords(msg.body);
      if (matches.length > 0) {
        alertedCount++;
        console.log(`🚨 Keyword match: ${matches.join(", ")} — from ${msg.user?.email || "?"}`);
        await sendSlackAlert({ message: msg, matchedKeywords: matches, reason: "keyword" });
        continue;
      }

      // (3) No keyword — check if conversation is tagged "confirmed-bulk"
      const slug = msg.conversation?.slug;
      if (slug) {
        const tags = await fetchConversationTags(slug);
        if (tags.some(t => t.toLowerCase() === CONFIRMED_BULK_TAG)) {
          confirmedCount++;
          console.log(`⭐ Confirmed bulk reply on ${slug} — from ${msg.user?.email || "?"}`);
          await sendSlackAlert({ message: msg, reason: "confirmed-bulk-tag" });
        }
      }
    }

    // Cap seen-id memory
    if (seenMessageIds.size > 5000) {
      const arr = Array.from(seenMessageIds);
      seenMessageIds.clear();
      arr.slice(-2500).forEach(id => seenMessageIds.add(id));
    }

    // Prune tag cache
    const now = Date.now();
    for (const [slug, entry] of conversationTagsCache.entries()) {
      if (now - entry.cachedAt > TAG_CACHE_TTL_MS * 5) {
        conversationTagsCache.delete(slug);
      }
    }

    if (isFirstPoll) {
      console.log(`📋 First poll: recorded ${newCount} existing messages (no alerts sent)`);
      isFirstPoll = false;
    } else if (newCount > 0) {
      console.log(`📨 Poll: ${newCount} new, ${alertedCount} keyword alerts, ${confirmedCount} confirmed-bulk alerts, ${excludedCount} excluded`);
    }
  } catch (err) {
    console.error("❌ Poll error:", err.message);
  }
}

// ── Health-check server ──────────────────────────────────────────────────────
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    seenIds: seenMessageIds.size,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    mentionConfigured: !!SLACK_MENTION_USER_ID,
    excludedSubjects: EXCLUDED_SUBJECTS.length,
    excludedDomains: EXCLUDED_DOMAINS.length,
    confirmedBulkTag: CONFIRMED_BULK_TAG,
  }));
}).listen(PORT, () => {
  console.log(`🚀 Health server on port ${PORT}`);
});

// ── Start polling ────────────────────────────────────────────────────────────
console.log(`🔁 Polling Re:amaze brand "${REAMAZE_BRAND}" every ${POLL_INTERVAL_SECONDS}s`);
console.log(`   Watching for ${BULK_KEYWORDS.length} keywords`);
console.log(`   Excluding ${EXCLUDED_SUBJECTS.length} subject(s) and ${EXCLUDED_DOMAINS.length} domain(s)`);
console.log(`   Confirmed-bulk tag: "${CONFIRMED_BULK_TAG}"`);
if (SLACK_MENTION_USER_ID) console.log(`   Will @mention: ${SLACK_MENTION_USER_ID}`);
pollOnce();
setInterval(pollOnce, POLL_INTERVAL_SECONDS * 1000);
