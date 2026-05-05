const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Keywords that trigger a bulk/large order alert ──────────────────────────
const BULK_KEYWORDS = [
  // quantity signals
  "bulk", "wholesale", "large order", "big order", "mass order",
  "volume order", "volume discount", "large quantity", "large quantities",
  "bulk order", "bulk purchase", "bulk pricing", "bulk price",
  // number signals  
  "100 units", "200 units", "500 units", "1000 units",
  "dozen", "gross", "pallet", "pallets", "case of", "cases of",
  // intent signals
  "corporate order", "company order", "business order",
  "reseller", "distributor", "distributor pricing",
  "for my business", "for our business", "for our company",
  "for my store", "for our store", "for resale",
  "can you accommodate", "can you handle",
  // quantity words
  "hundreds", "thousands", "multiple cases",
];

// ── Raw body needed for signature verification ───────────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", service: "reamaze-bulk-alert" }));

// ── Webhook endpoint ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // 1. Verify Re:amaze signature (optional but recommended)
  const secret = process.env.REAMAZE_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers["x-reamaze-signature"] || req.headers["x-hub-signature-256"] || "";
    const expected = "sha256=" + crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");
    if (sig !== expected) {
      console.warn("⚠️  Signature mismatch — ignoring webhook");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const payload = req.body;

  // 2. Extract the message text from Re:amaze's payload structure
  const messageBody = extractMessageText(payload);
  const conversationUrl = extractConversationUrl(payload);
  const customerName = extractCustomerName(payload);
  const customerEmail = extractCustomerEmail(payload);
  const subject = payload?.conversation?.subject || payload?.message?.subject || "(no subject)";

  if (!messageBody) {
    return res.json({ status: "ignored", reason: "no message body found" });
  }

  // 3. Check for bulk keywords
  const lowerBody = messageBody.toLowerCase();
  const matched = BULK_KEYWORDS.filter(kw => lowerBody.includes(kw.toLowerCase()));

  if (matched.length === 0) {
    console.log(`📨 Message received — no bulk keywords found`);
    return res.json({ status: "ignored", reason: "no bulk keywords" });
  }

  console.log(`🚨 Bulk keywords detected: ${matched.join(", ")}`);

  // 4. Fire Slack alert
  await sendSlackAlert({
    customerName,
    customerEmail,
    subject,
    messageBody,
    conversationUrl,
    matchedKeywords: matched,
  });

  res.json({ status: "alerted", keywords: matched });
});

// ── Extract helpers ───────────────────────────────────────────────────────────
function extractMessageText(payload) {
  return (
    payload?.message?.body ||
    payload?.message?.body_text ||
    payload?.conversation?.last_message?.body ||
    payload?.note?.body ||
    ""
  );
}

function extractConversationUrl(payload) {
  const slug = process.env.REAMAZE_BRAND_SLUG || "your-brand";
  const convId = payload?.conversation?.slug || payload?.conversation?.id || "";
  return convId
    ? `https://${slug}.reamaze.com/conversations/${convId}`
    : "https://app.reamaze.com";
}

function extractCustomerName(payload) {
  return (
    payload?.conversation?.customer?.name ||
    payload?.message?.customer?.name ||
    payload?.customer?.name ||
    "Unknown Customer"
  );
}

function extractCustomerEmail(payload) {
  return (
    payload?.conversation?.customer?.email ||
    payload?.message?.customer?.email ||
    payload?.customer?.email ||
    ""
  );
}

// ── Slack alert ───────────────────────────────────────────────────────────────
async function sendSlackAlert({ customerName, customerEmail, subject, messageBody, conversationUrl, matchedKeywords }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("❌ SLACK_WEBHOOK_URL not set");
    return;
  }

  // Trim message preview to ~300 chars
  const preview = messageBody.length > 300
    ? messageBody.slice(0, 297) + "..."
    : messageBody;

  const payload = {
    text: `🚨 *Bulk Order Inquiry Detected!*`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 Bulk Order Inquiry",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Customer:*\n${customerName}` },
          { type: "mrkdwn", text: `*Email:*\n${customerEmail || "—"}` },
          { type: "mrkdwn", text: `*Subject:*\n${subject}` },
          { type: "mrkdwn", text: `*Keywords found:*\n${matchedKeywords.map(k => `\`${k}\``).join(", ")}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Message preview:*\n>${preview.replace(/\n/g, "\n>")}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in Re:amaze →", emoji: true },
            url: conversationUrl,
            style: "primary",
          },
        ],
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("❌ Slack webhook failed:", response.status, await response.text());
  } else {
    console.log("✅ Slack alert sent!");
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Re:amaze bulk alert server running on port ${PORT}`);
  console.log(`   Watching for ${BULK_KEYWORDS.length} bulk/order keywords`);
});
