// POST /api/grade-skk1
//
// 1級建築施工管理技士 第二次検定 勉強会 (oisi/benkyokai-skk1) の答案を
// Copilot Studio 「1級施工管技 採点エージェント (cr746_agent)」へ
// Power Platform API 経由で投げて採点・添削コメントを返すプロキシ。
//
// 認証: ROPC (gemba-bot アカウント)。詳細は ./copilotAuth.js
//
// 流れ:
//   1. ROPC で Power Platform Access Token 取得 (キャッシュあり)
//   2. POST {base}/conversations?api-version=...     新規会話作成
//   3. POST {base}/conversations/{id}?api-version=...  メッセージ送信
//      (DynamicPlan型エージェントは初回応答に 47KB / 60秒前後で
//       採点結果メッセージを含む activities をまとめて返してくる)
//   4. レスポンス activities から bot 応答テキスト抽出
//      空なら GET /activities を polling (60秒・watermark付き)
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
// 新エージェント (cr746_agent) は DynamicPlan 方式で初回POSTに 47KB/～60s で
// まとめて返ってくる実測あり。fetch自体のタイムアウトは余裕を持たせる。
const SEND_TIMEOUT_MS = 120_000; // 初回 POST /conversations/{id} 用
const CREATE_TIMEOUT_MS = 30_000; // 会話作成 POST /conversations 用
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;
const POLL_FETCH_TIMEOUT_MS = 30_000;

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
  // 新エージェント(cr746_agent)は DynamicPlan event を多数返してくるが、
  // 採点本文は最後の type=message && from.role=bot && text!=空 の activity に入る。
  // 複数 message があれば登場順で全部 join (実測ではほぼ1件)。
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

/**
 * fetch with AbortSignal timeout. node18+ には AbortSignal.timeout があるが
 * 念のため自前で実装。
 */
async function fetchWithTimeout(url, options, timeoutMs, log, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      log?.error?.(
        `${label || 'fetch'} aborted after ${timeoutMs}ms`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function createConversation(base, accessToken, log) {
  const res = await fetchWithTimeout(
    `${base}/conversations?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
    CREATE_TIMEOUT_MS,
    log,
    'create-conversation',
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
  const res = await fetchWithTimeout(
    `${base}/conversations/${conversationId}?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ activity: { type: 'message', text } }),
    },
    SEND_TIMEOUT_MS,
    log,
    'send-message',
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
  let watermark = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const url = watermark
      ? `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}&watermark=${encodeURIComponent(watermark)}`
      : `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}`;
    let res;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        POLL_FETCH_TIMEOUT_MS,
        log,
        'poll-activities',
      );
    } catch (e) {
      log?.error?.(`Copilot poll activities fetch error: ${e?.message || e}`);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.error?.(
        `Copilot poll activities failed: status=${res.status} body=${txt.slice(0, 300)}`,
      );
      // 一時的失敗の可能性があるので継続
      continue;
    }
    const j = await res.json();
    if (j.watermark) watermark = j.watermark;
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
      const actCount = Array.isArray(sendResult?.activities)
        ? sendResult.activities.length
        : 0;
      context.log?.(
        `grade-skk1: send ok t+${Date.now() - t0}ms activities=${actCount} action=${sendResult?.action || 'n/a'}`,
      );
    } catch (e) {
      const status = e?.status || 502;
      return jsonResponse(
        status,
        { error: e?.message || 'Copilot 送信エラー' },
        origin,
      );
    }

    // 新エージェント (cr746_agent / DynamicPlan型) では即時レスポンスの
    // activities 配列に最後の type=message,role=bot,text!=空 が含まれてくる。
    // action: "waiting" でも text 付き message があれば成功扱い。
    let botMessages = extractBotMessages(sendResult?.activities);
    context.log?.(
      `grade-skk1: extracted bot messages from send response: count=${botMessages.length}`,
    );

    if (botMessages.length === 0) {
      // 念のため: 即時応答に bot message が含まれない場合のみ polling
      context.log?.(
        'grade-skk1: send returned no bot messages, polling activities...',
      );
      try {
        botMessages = await pollActivities(
          base,
          accessToken,
          conversationId,
          context,
        );
        context.log?.(
          `grade-skk1: poll done t+${Date.now() - t0}ms count=${botMessages.length}`,
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
