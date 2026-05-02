// POST /api/grade-skk1
//
// 1級建築施工管理技士 第二次検定 勉強会 (oisi/benkyokai-skk1) の答案を
// Copilot Studio 「1級建築施工管理試験マスター」 bot (cr746_1) へ
// Power Platform API 経由で投げて採点・添削コメントを返すプロキシ。
//
// 認証: ROPC (gemba-bot アカウント)。詳細は ./copilotAuth.js
//
// 流れ:
//   1. ROPC で Power Platform Access Token 取得 (キャッシュあり)
//   2. POST {base}/conversations?api-version=...     新規会話作成
//   3. POST {base}/conversations/{id}?api-version=...  メッセージ送信
//   4. レスポンス activities から bot 応答テキスト抽出
//      空なら GET /activities を short polling
//
// Request body:
//   {
//     "questionId": "q1" | "q2-1" | "q2-2" | "q2-3"
//                 | "q4-1" | "q4-2" | "q4-3" | "q4-4",
//     "answer":    string  // q1 以外
//     "answers":   { overview, q1a, q1b, q2 }  // q1 用
//   }
//
// Response (200):
//   { "questionId": "...", "verdict": string, "raw": string }
//
// 環境変数:
//   SPO_TENANT_ID / SPO_CLIENT_ID / SPO_CLIENT_SECRET
//   COPILOT_BOT_USERNAME / COPILOT_BOT_PASSWORD
//   COPILOT_ENDPOINT

const { app } = require('@azure/functions');
const { getQuestion } = require('./questions');
const {
  getAccessToken,
  getCopilotBase,
  CopilotAuthError,
} = require('./copilotAuth');

const ALLOWED_ORIGIN = 'https://manual.kensetsu-total.support';
const FALLBACK_ORIGIN = 'http://localhost:4280'; // SWA CLI emulator
const API_VERSION = '2022-03-01-preview';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 20_000;

function corsHeaders(origin) {
  const allow =
    origin === ALLOWED_ORIGIN || origin === FALLBACK_ORIGIN
      ? origin
      : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function jsonResponse(status, body, origin) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
    body: JSON.stringify(body),
  };
}

function buildPrompt(question, payload) {
  const lines = [];
  lines.push('【採点依頼】');
  lines.push(`問題：${question.title}`);
  lines.push(question.body);
  lines.push('');
  lines.push('受験者の解答：');
  if (question.parts) {
    const ans = payload.answers || {};
    for (const part of question.parts) {
      const v = (ans[part.key] || '').trim();
      lines.push(`■ ${part.label}`);
      lines.push(v.length > 0 ? v : '（未記入）');
      lines.push('');
    }
  } else {
    const v = (payload.answer || '').trim();
    lines.push(v.length > 0 ? v : '（未記入）');
    lines.push('');
  }
  lines.push(
    '上記解答について、1級建築施工管理技士 第二次検定の採点者として' +
      '採点・○×評価・改善点を具体的に教えてください。',
  );
  return lines.join('\n');
}

function extractBotMessages(activities) {
  if (!Array.isArray(activities)) return [];
  return activities
    .filter(
      (a) =>
        a &&
        a.type === 'message' &&
        a.from?.role === 'bot' &&
        typeof a.text === 'string' &&
        a.text.trim().length > 0,
    )
    .map((a) => a.text);
}

async function createConversation(base, accessToken, log) {
  const res = await fetch(
    `${base}/conversations?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log?.error?.(
      `Copilot conversation create failed: status=${res.status} body=${txt.slice(0, 300)}`,
    );
    const err = new Error('Copilot 会話作成に失敗しました');
    err.status = 502;
    throw err;
  }
  const j = await res.json();
  if (!j.conversationId) {
    const err = new Error('Copilot 会話 ID が取得できません');
    err.status = 502;
    throw err;
  }
  return j.conversationId;
}

async function sendMessage(base, accessToken, conversationId, text, log) {
  const res = await fetch(
    `${base}/conversations/${conversationId}?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ activity: { type: 'message', text } }),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log?.error?.(
      `Copilot send message failed: status=${res.status} body=${txt.slice(0, 300)}`,
    );
    const err = new Error('Copilot メッセージ送信に失敗しました');
    err.status = 502;
    throw err;
  }
  return res.json();
}

async function pollActivities(base, accessToken, conversationId, log) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(
      `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.error?.(
        `Copilot poll activities failed: status=${res.status} body=${txt.slice(0, 300)}`,
      );
      // 一時的失敗の可能性があるので継続
      continue;
    }
    const j = await res.json();
    const msgs = extractBotMessages(j.activities);
    if (msgs.length > 0) return msgs;
  }
  return [];
}

app.http('grade-skk1', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'grade-skk1',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin) };
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
    }

    const questionId = payload?.questionId;
    if (typeof questionId !== 'string' || !questionId) {
      return jsonResponse(400, { error: 'questionId is required' }, origin);
    }
    const question = getQuestion(questionId);
    if (!question) {
      return jsonResponse(
        400,
        { error: `Unknown questionId: ${questionId}` },
        origin,
      );
    }

    // 答案存在チェック
    if (question.parts) {
      const ans = payload.answers || {};
      const filled = question.parts.some(
        (p) => typeof ans[p.key] === 'string' && ans[p.key].trim().length > 0,
      );
      if (!filled) {
        return jsonResponse(
          400,
          { error: '少なくとも1つの欄に解答を入力してください。' },
          origin,
        );
      }
    } else {
      if (
        typeof payload.answer !== 'string' ||
        payload.answer.trim().length === 0
      ) {
        return jsonResponse(
          400,
          { error: '解答が空です。記入してから採点を依頼してください。' },
          origin,
        );
      }
    }

    const prompt = buildPrompt(question, payload);
    const t0 = Date.now();
    context.log?.(
      `grade-skk1: questionId=${questionId} promptLen=${prompt.length}`,
    );

    let accessToken;
    try {
      accessToken = await getAccessToken(context);
      context.log?.(`grade-skk1: token ok t+${Date.now() - t0}ms`);
    } catch (e) {
      if (e instanceof CopilotAuthError) {
        context.error?.(`grade-skk1 auth error: ${e.message}`);
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`grade-skk1 auth unexpected: ${e?.stack || e}`);
      return jsonResponse(
        503,
        { error: 'Copilot 認証情報設定エラー' },
        origin,
      );
    }

    const base = getCopilotBase();

    let conversationId;
    try {
      conversationId = await createConversation(base, accessToken, context);
      context.log?.(
        `grade-skk1: conversation created id=${conversationId} t+${Date.now() - t0}ms`,
      );
    } catch (e) {
      const status = e?.status || 502;
      return jsonResponse(
        status,
        { error: e?.message || 'Copilot 接続エラー' },
        origin,
      );
    }

    let sendResult;
    try {
      sendResult = await sendMessage(
        base,
        accessToken,
        conversationId,
        prompt,
        context,
      );
      context.log?.(`grade-skk1: send ok t+${Date.now() - t0}ms`);
    } catch (e) {
      const status = e?.status || 502;
      return jsonResponse(
        status,
        { error: e?.message || 'Copilot 送信エラー' },
        origin,
      );
    }

    let botMessages = extractBotMessages(sendResult?.activities);

    if (botMessages.length === 0) {
      // 同期応答が空のケースに備えて short polling
      context.log?.('grade-skk1: send returned no bot messages, polling...');
      try {
        botMessages = await pollActivities(
          base,
          accessToken,
          conversationId,
          context,
        );
      } catch (e) {
        context.error?.(`grade-skk1 poll error: ${e?.stack || e}`);
      }
    }

    if (botMessages.length === 0) {
      return jsonResponse(
        504,
        { error: 'Bot 応答が取得できませんでした (timeout)' },
        origin,
      );
    }

    const text = botMessages.join('\n\n').trim();
    return jsonResponse(
      200,
      { questionId, verdict: text, raw: text },
      origin,
    );
  },
});
