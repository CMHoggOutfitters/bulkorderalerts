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

// Optional: a bot token + channel enables threaded "show more" replies.
// Incoming webhooks don't return a message timestamp, so threading is impossible
// with SLACK_WEBHOOK_URL alone — without these two the alert just truncates and
// points at Re:amaze for the rest.
const SLACK_BOT_TOKEN        = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID       = process.env.SLACK_CHANNEL_ID;
const CAN_THREAD             = !!(SLACK_BOT_TOKEN && SLACK_CHANNEL_ID);

const REQUIRED = { REAMAZE_BRAND, REAMAZE_LOGIN_EMAIL, REAMAZE_API_TOKEN };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) { console.error(`❌ Missing required env var: ${k}`); process.exit(1); }
}
if (!SLACK_WEBHOOK_URL && !CAN_THREAD) {
  console.error("❌ Need SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN + SLACK_CHANNEL_ID");
  process.exit(1);
}

// ── Tag that flags a conversation as a confirmed bulk lead ───────────────────
// Add this tag in Re:amaze to any conversation you've verified as a legit bulk
// inquiry. Every subsequent customer reply on that conversation will alert
// Slack, even without bulk keywords.
const CONFIRMED_BULK_TAG = "confirmed-bulk";

// ── Message display limits ───────────────────────────────────────────────────
// The channel message shows the first few lines; the rest goes to the thread.
const PREVIEW_MAX_LINES = 3;
const PREVIEW_MAX_CHARS = 280;
const SLACK_TEXT_LIMIT  = 2900; // Slack section limit is 3000 — leave headroom

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

// ── Message formatting ───────────────────────────────────────────────────────
// Strip HTML, decode the entities Re:amaze commonly emits, and collapse the
// runs of blank lines that email signatures leave behind.
function cleanBody(raw) {
  return String(raw || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// First few lines only, with a hard character cap as a backstop for long
// single-line messages. Returns whether anything was cut.
function truncateForSlack(text) {
  const lines = text.split("\n");

  // Blank lines don't count toward the limit — a paragraph break shouldn't eat
  // one of the three lines we're showing.
  let kept = 0, cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) kept++;
    if (kept >= PREVIEW_MAX_LINES) { cut = i + 1; break; }
  }

  let out = lines.slice(0, cut).join("\n");
  let truncated = cut < lines.length && lines.slice(cut).some(l => l.trim());

  if (out.length > PREVIEW_MAX_CHARS) {
    out = out.slice(0, PREVIEW_MAX_CHARS).replace(/\s+\S*$/, "");
    truncated = true;
  }
  return { preview: out.trimEnd(), truncated };
}

function blockquote(text) {
  return text.split("\n").map(l => `>${l}`).join("\n");
}

// ── Slack transport ──────────────────────────────────────────────────────────
// With a bot token we use chat.postMessage, which returns the message `ts` we
// need to thread the full text under it. With an incoming webhook we can only
// fire and forget — no ts, so no thread.
async function postToSlack(payload, { threadTs } = {}) {
  if (CAN_THREAD) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL_ID,
        ...payload,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.error(`❌ Slack chat.postMessage failed: ${data.error || res.status}`);
      return null;
    }
    return data.ts || null;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`❌ Slack webhook ${res.status}:`, await res.text());
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

  const body = cleanBody(message.body);
  const { preview, truncated } = truncateForSlack(body);

  const mention = buildMentionPrefix();
  const isConfirmed = reason === "confirmed-bulk-tag";
  const headerText = isConfirmed ? "⭐ Confirmed Bulk Lead — New Reply" : "🚨 Bulk Order Inquiry";

  const blocks = [];

  if (mention) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${mention.trim()} 👈 heads up!` },
    });
  }

  blocks.push({ type: "header", text: { type: "plain_text", text: headerText, emoji: true } });

  // Subject sits directly above the message it belongs to.
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Subject:* ${subject}` },
  });

  // Then the message itself — first few lines, rest in thread.
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: blockquote(preview || "_(no message text)_") },
  });

  if (truncated) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: CAN_THREAD
          ? "_Show more ↓ — full message in thread_"
          : "_Show more — open in Re:amaze for the full message_",
      }],
    });
  }

  // Who it's from sits below the message.
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Customer:*\n${customerName}` },
      { type: "mrkdwn", text: `*Email:*\n${customerEmail}` },
    ],
  });

  if (isConfirmed) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Tagged \`${CONFIRMED_BULK_TAG}\` — every reply on this conversation alerts`,
      }],
    });
  }

  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Open in Re:amaze →", emoji: true },
      url: conversationUrl,
      style: "primary",
    }],
  });

  const ts = await postToSlack({
    text: `${mention}${headerText} — ${customerName}`,
    blocks,
  });

  // Threaded full message. Only possible on the bot-token path.
  if (ts && truncated) {
    const full = body.length > SLACK_TEXT_LIMIT
      ? body.slice(0, SLACK_TEXT_LIMIT) + "\n… (trimmed — open in Re:amaze for the rest)"
      : body;
    await postToSlack({
      text: "Full message",
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text: `*Full message*\n${blockquote(full)}` },
      }],
    }, { threadTs: ts });
  }

  if (ts || !CAN_THREAD) console.log("✅ Slack alert sent");
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
    threadedFullMessage: CAN_THREAD,
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
console.log(CAN_THREAD
  ? `   Posting via chat.postMessage to ${SLACK_CHANNEL_ID} — full message goes in thread`
  : `   Posting via incoming webhook — no thread, long messages truncate`);
if (SLACK_MENTION_USER_ID) console.log(`   Will @mention: ${SLACK_MENTION_USER_ID}`);
pollOnce();
setInterval(pollOnce, POLL_INTERVAL_SECONDS * 1000);
