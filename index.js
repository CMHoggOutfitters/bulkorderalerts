// ── Re:amaze → Slack bulk-order alert poller ─────────────────────────────────
// Polls the Re:amaze API every POLL_INTERVAL_SECONDS for new customer messages.
// If a message body matches any BULK_KEYWORDS, fires a Slack alert.
// Confirmed against docs: https://www.reamaze.com/api/get_messages

const http = require("http");

// ── Config (from env vars) ───────────────────────────────────────────────────
const REAMAZE_BRAND          = process.env.REAMAZE_BRAND;          // e.g. "wholesale-hogg"
const REAMAZE_LOGIN_EMAIL    = process.env.REAMAZE_LOGIN_EMAIL;    // your login email
const REAMAZE_API_TOKEN      = process.env.REAMAZE_API_TOKEN;      // from Settings → Developer → API Token
const SLACK_WEBHOOK_URL      = process.env.SLACK_WEBHOOK_URL;      // Slack incoming webhook
const SLACK_MENTION_USER_ID  = process.env.SLACK_MENTION_USER_ID;  // Optional: Slack member ID(s) to @mention. Comma-separate for multiple.
const POLL_INTERVAL_SECONDS  = parseInt(process.env.POLL_INTERVAL_SECONDS || "60", 10);
const PORT                   = process.env.PORT || 3000;

const REQUIRED = { REAMAZE_BRAND, REAMAZE_LOGIN_EMAIL, REAMAZE_API_TOKEN, SLACK_WEBHOOK_URL };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) { console.error(`❌ Missing required env var: ${k}`); process.exit(1); }
}

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

// ── Exclusions: skip these messages even if keywords match ───────────────────
// Subjects (case-insensitive substring match — "matches" means contains)
const EXCLUDED_SUBJECTS = [
  "notification of payment received",
];

// Email domains (case-insensitive). Strip the @ — just the domain.
const EXCLUDED_DOMAINS = [
  "hoggoutfitters.com",
  "backinstock.org",
  "rangeme.com",
  "mg.postscriptapp.com",
];

// ── State: track seen message IDs so we don't alert twice ────────────────────
const seenMessageIds = new Set();
let isFirstPoll = true;

// ── Build the @mention prefix from SLACK_MENTION_USER_ID ─────────────────────
function buildMentionPrefix() {
  if (!SLACK_MENTION_USER_ID) return "";
  const ids = SLACK_MENTION_USER_ID.split(",").map(s => s.trim()).filter(Boolean);
  return ids.map(id => {
    if (id === "channel" || id === "here") return `<!${id}>`;
    return `<@${id}>`;
  }).join(" ") + " ";
}

// ── Re:amaze API: list recent customer messages ──────────────────────────────
async function fetchRecentMessages() {
  const url = `https://${REAMAZE_BRAND}.reamaze.io/api/v1/messages?filter=customer`;
  const auth = Buffer.from(`${REAMAZE_LOGIN_EMAIL}:${REAMAZE_API_TOKEN}`).toString("base64");

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Authorization": `Basic ${auth}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Re:amaze API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.messages || [];
}

// ── Check if message body has any bulk keyword ───────────────────────────────
function findKeywords(body) {
  if (!body) return [];
  const lower = body.toLowerCase();
  return BULK_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()));
}

// ── Check if message should be excluded based on subject or sender ───────────
// Returns the exclusion reason as a string, or null if not excluded.
function getExclusionReason(message) {
  const subject = (message.conversation?.subject || "").toLowerCase();
  for (const sub of EXCLUDED_SUBJECTS) {
    if (subject.includes(sub.toLowerCase())) {
      return `subject contains "${sub}"`;
    }
  }

  const email = (message.user?.email || "").toLowerCase();
  for (const domain of EXCLUDED_DOMAINS) {
    // Match if email ends with @domain (exact domain) or with .domain (subdomains)
    const d = domain.toLowerCase();
    if (email.endsWith("@" + d) || email.endsWith("." + d)) {
      return `sender domain "${d}"`;
    }
  }

  return null;
}

// ── Slack alert ──────────────────────────────────────────────────────────────
async function sendSlackAlert({ message, matchedKeywords }) {
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

  const payload = {
    text: `${mention}🚨 Bulk Order Inquiry Detected!`,
    blocks: [
      ...(mention ? [{
        type: "section",
        text: { type: "mrkdwn", text: `${mention.trim()} 👈 heads up!` },
      }] : []),
      { type: "header", text: { type: "plain_text", text: "🚨 Bulk Order Inquiry", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Customer:*\n${customerName}` },
          { type: "mrkdwn", text: `*Email:*\n${customerEmail}` },
          { type: "mrkdwn", text: `*Subject:*\n${subject}` },
          { type: "mrkdwn", text: `*Keywords:*\n${matchedKeywords.map(k => `\`${k}\``).join(", ")}` },
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
    let newCount = 0, matchedCount = 0, excludedCount = 0;

    for (const msg of messages) {
      const id = msg.origin_id || `${msg.created_at}::${(msg.body || "").slice(0, 50)}`;
      if (seenMessageIds.has(id)) continue;
      seenMessageIds.add(id);
      newCount++;

      if (isFirstPoll) continue;

      const matches = findKeywords(msg.body);
      if (matches.length === 0) continue;

      // Check exclusions BEFORE sending the alert
      const exclusionReason = getExclusionReason(msg);
      if (exclusionReason) {
        excludedCount++;
        console.log(`🛑 Excluded match (${exclusionReason}) — would have matched: ${matches.join(", ")}`);
        continue;
      }

      matchedCount++;
      console.log(`🚨 Match: ${matches.join(", ")} — from ${msg.user?.email || "?"}`);
      await sendSlackAlert({ message: msg, matchedKeywords: matches });
    }

    if (seenMessageIds.size > 5000) {
      const arr = Array.from(seenMessageIds);
      seenMessageIds.clear();
      arr.slice(-2500).forEach(id => seenMessageIds.add(id));
    }

    if (isFirstPoll) {
      console.log(`📋 First poll: recorded ${newCount} existing messages (no alerts sent)`);
      isFirstPoll = false;
    } else if (newCount > 0) {
      console.log(`📨 Poll: ${newCount} new, ${matchedCount} alerted, ${excludedCount} excluded`);
    }
  } catch (err) {
    console.error("❌ Poll error:", err.message);
  }
}

// ── Tiny health-check server ─────────────────────────────────────────────────
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    seenIds: seenMessageIds.size,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    mentionConfigured: !!SLACK_MENTION_USER_ID,
    excludedSubjects: EXCLUDED_SUBJECTS.length,
    excludedDomains: EXCLUDED_DOMAINS.length,
  }));
}).listen(PORT, () => {
  console.log(`🚀 Health server on port ${PORT}`);
});

// ── Start polling ────────────────────────────────────────────────────────────
console.log(`🔁 Polling Re:amaze brand "${REAMAZE_BRAND}" every ${POLL_INTERVAL_SECONDS}s`);
console.log(`   Watching for ${BULK_KEYWORDS.length} keywords`);
console.log(`   Excluding ${EXCLUDED_SUBJECTS.length} subject(s) and ${EXCLUDED_DOMAINS.length} domain(s)`);
if (SLACK_MENTION_USER_ID) console.log(`   Will @mention: ${SLACK_MENTION_USER_ID}`);
pollOnce();
setInterval(pollOnce, POLL_INTERVAL_SECONDS * 1000);
