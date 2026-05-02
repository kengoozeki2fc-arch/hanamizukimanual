// Direct Line API thin client for the Copilot Studio "建設サポート" bot.
//
// Flow:
//   1. POST /v3/directline/tokens/generate    (Bearer = Direct Line secret)
//   2. POST /v3/directline/conversations      (Bearer = ephemeral token)
//   3. POST /v3/directline/conversations/{id}/activities  (send user message)
//   4. GET  /v3/directline/conversations/{id}/activities?watermark=...
//      (poll for bot reply)
//
// Secrets are read from env (COPILOT_DIRECTLINE_SECRET). They MUST NOT be
// logged or returned to the client.

const DIRECT_LINE_BASE = 'https://directline.botframework.com/v3/directline';
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

function maskBearer(token) {
  if (!token || typeof token !== 'string') return '****';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function generateToken(secret, log) {
  const res = await fetch(`${DIRECT_LINE_BASE}/tokens/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log?.error?.(
      `Direct Line tokens/generate failed: status=${res.status} body=${txt.slice(0, 200)}`,
    );
    throw new HttpUpstreamError(502, 'Direct Line token generation failed');
  }
  const j = await res.json();
  if (!j.token) {
    throw new HttpUpstreamError(502, 'Direct Line token generation returned empty token');
  }
  return j.token;
}

async function startConversation(token, log) {
  const res = await fetch(`${DIRECT_LINE_BASE}/conversations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log?.error?.(
      `Direct Line conversations POST failed: status=${res.status} body=${txt.slice(0, 200)}`,
    );
    throw new HttpUpstreamError(502, 'Direct Line conversation start failed');
  }
  const j = await res.json();
  if (!j.conversationId) {
    throw new HttpUpstreamError(502, 'Direct Line conversation returned empty id');
  }
  return j.conversationId;
}

async function sendUserMessage(token, conversationId, text, fromId, log) {
  const res = await fetch(
    `${DIRECT_LINE_BASE}/conversations/${conversationId}/activities`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'message',
        from: { id: fromId },
        text,
      }),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log?.error?.(
      `Direct Line send activity failed: status=${res.status} body=${txt.slice(0, 200)}`,
    );
    throw new HttpUpstreamError(502, 'Direct Line send activity failed');
  }
  return res.json();
}

async function pollBotReply(token, conversationId, fromId, log) {
  const start = Date.now();
  let watermark = null;
  const collected = [];

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const url =
      `${DIRECT_LINE_BASE}/conversations/${conversationId}/activities` +
      (watermark ? `?watermark=${encodeURIComponent(watermark)}` : '');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.error?.(
        `Direct Line poll failed: status=${res.status} body=${txt.slice(0, 200)}`,
      );
      throw new HttpUpstreamError(502, 'Direct Line poll failed');
    }
    const j = await res.json();
    watermark = j.watermark ?? watermark;
    const botMsgs = (j.activities || []).filter(
      (a) =>
        a.type === 'message' &&
        a.from?.id !== fromId &&
        // skip empty / typing
        (typeof a.text === 'string' ? a.text.trim().length > 0 : true),
    );
    if (botMsgs.length > 0) {
      collected.push(...botMsgs);
      // Most Copilot bots send a single message activity per turn.
      return collected;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new HttpUpstreamError(504, 'Direct Line bot reply timed out');
}

class HttpUpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * High-level helper: send `text` to the bot, get the first text reply.
 * @returns {Promise<{text: string, raw: object[]}>}
 */
async function askBot(secret, text, fromId, log) {
  log?.info?.(
    `directLine: secret=${maskBearer(secret)} sending text len=${text.length}`,
  );
  const token = await generateToken(secret, log);
  log?.info?.(`directLine: got ephemeral token (masked=${maskBearer(token)})`);
  const conversationId = await startConversation(token, log);
  log?.info?.(`directLine: conversation started id=${conversationId}`);
  await sendUserMessage(token, conversationId, text, fromId, log);
  const replies = await pollBotReply(token, conversationId, fromId, log);
  // concat text of all bot messages this turn
  const reply = replies
    .map((a) => (typeof a.text === 'string' ? a.text : ''))
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
    .trim();
  return { text: reply, raw: replies };
}

module.exports = { askBot, HttpUpstreamError };
