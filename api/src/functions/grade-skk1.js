// POST /api/grade-skk1        — 会話作成 + メッセージ送信開始 (即時 202 で conversationId 返却)
// POST /api/grade-skk1-poll   — 指定 conversationId の activities を polling して bot 応答抽出
//
// 1級建築施工管理技士 第二次検定 勉強会 (oisi/benkyokai-skk1) の答案を
// Copilot Studio 「1級施工管技 採点エージェント (cr746_agent)」へ
// Power Platform API 経由で投げて採点・添削コメントを返すプロキシ。
//
// 認証: ROPC (gemba-bot アカウント)。詳細は ./copilotAuth.js
//
// なぜ2段階か:
//   SWA managed Functions の HTTP 応答ハードリミットが 45 秒。
//   一方 Copilot Studio 新エージェント (cr746_agent / DynamicPlan型) は
//   POST /conversations/{id} に対し 60 秒前後 / 47KB を一括返却するケースがあり、
//   1リクエストで完結させると SWA フロントが 500 "Backend call failure" を返す。
//   そこで:
//     1. /api/grade-skk1       会話作成 + sendMessage を発火 (発火後の完走は待たない)
//     2. /api/grade-skk1-poll  GET /activities で bot 応答を polling 取得
//   と分け、各レスポンスを 45 秒以内に収める。
//
// 流れ:
//   1. ROPC で Power Platform Access Token 取得 (warm キャッシュ)
//   2. POST /conversations  会話作成
//   3. POST /conversations/{id}  メッセージ送信開始 (35秒上限で打ち切り、本体側で継続)
//      - 35秒以内に bot 応答 activity が拾えれば 200 で verdict を直接返す
//      - 拾えなければ 202 + { conversationId, status:"pending" } を返す
//   4. クライアントは pending なら /api/grade-skk1-poll を投げ続ける
//      - Functions は GET /activities を最大 35秒 polling
//      - 取れたら 200、未取得なら 202 + status:"pending" で繰り返し誘導
//
// Request body (POST /api/grade-skk1):
//   {
//     "questionId": "q1" | "q2-1" | "q2-2" | "q2-3"
//                 | "q4-1" | "q4-2" | "q4-3" | "q4-4",
//     "answer":    string  // q1 以外
//     "answers":   { overview, q1a, q1b, q2 }  // q1 用
//   }
//
// Response (POST /api/grade-skk1):
//   200 { "questionId": "...", "verdict": string, "raw": string, "conversationId": "..." }
//   202 { "questionId": "...", "conversationId": "...", "status": "pending" }
//
// Request body (POST /api/grade-skk1-poll):
//   { "questionId": "...", "conversationId": "...", "watermark": "..." (任意) }
//
// Response (POST /api/grade-skk1-poll):
//   200 { "questionId": "...", "verdict": string, "raw": string, "watermark": "..." }
//   202 { "questionId": "...", "conversationId": "...", "watermark": "...", "status": "pending" }
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

// SWA managed Functions の応答上限が 45 秒。各レスポンスは 40 秒で打ち切る。
const SWA_HARD_LIMIT_MS = 45_000;
// 初回 POST /conversations/{id} sendMessage の自前打ち切り (これ以内に応答あれば直接返す)
const SEND_RESPONSE_BUDGET_MS = 35_000;
// /grade-skk1-poll 1呼び出しあたりの polling 全体タイムアウト
const POLL_TOTAL_BUDGET_MS = 35_000;
// /grade-skk1 ハンドラ全体の最大滞在時間 (会話作成 + sendMessage 待機 + polling 1回分)
const ENDPOINT_BUDGET_MS = 40_000;
// /grade-skk1 内の send 後 in-flight polling 用バジェット
// (sendがブロックして帰ってきた時点で残り時間を全部割り当てる)
const POLL_INTERVAL_MS = 1500;
// Activities 1回 GET の fetch タイムアウト
const POLL_FETCH_TIMEOUT_MS = 10_000;
// 会話作成 fetch タイムアウト
const CREATE_TIMEOUT_MS = 15_000;

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

/**
 * 新エージェント(cr746_agent)は DynamicPlan event を多数返してくるが、
 * 採点本文は最後の type=message && from.role=bot && text!=空 の activity に入る。
 * 複数 message があれば登場順で全部 join (実測ではほぼ1件)。
 */
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

/**
 * fetch with AbortSignal timeout.
 */
async function fetchWithTimeout(url, options, timeoutMs, log, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      log?.warn?.(
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

/**
 * sendMessage を発行。timeoutMs 以内にレスポンスが返ってくれば
 * activities を返す。タイムアウトしたら null を返す（fire-and-forget扱い）。
 * Power Platform 側は HTTP接続が切れても会話処理は継続するため、
 * subsequent GET /activities で bot 応答を拾える。
 */
async function sendMessageWithBudget(
  base,
  accessToken,
  conversationId,
  text,
  timeoutMs,
  log,
) {
  try {
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
      timeoutMs,
      log,
      'send-message',
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.error?.(
        `Copilot send message failed: status=${res.status} body=${txt.slice(0, 300)}`,
      );
      // ネットワーク的に応答は来たが業務エラー。pending扱いで polling に賭ける。
      return { ok: false, status: res.status };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (e) {
    if (e?.name === 'AbortError') {
      log?.warn?.(
        `send-message aborted after ${timeoutMs}ms (Copilot側は処理継続している想定)`,
      );
      return { ok: false, aborted: true };
    }
    log?.error?.(`send-message unexpected: ${e?.stack || e}`);
    return { ok: false, error: e };
  }
}

/**
 * GET /activities を deadline (絶対時刻ms) まで polling。
 * 取れたら { messages, watermark } を返す。
 * 取れずに deadline 超えたら { messages: [], watermark } を返す。
 */
async function pollActivitiesUntil(
  base,
  accessToken,
  conversationId,
  initialWatermark,
  deadlineEpochMs,
  log,
) {
  let watermark = initialWatermark || null;
  while (Date.now() < deadlineEpochMs) {
    const remain = deadlineEpochMs - Date.now();
    if (remain <= 0) break;
    const url = watermark
      ? `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}&watermark=${encodeURIComponent(watermark)}`
      : `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}`;
    const fetchBudget = Math.min(POLL_FETCH_TIMEOUT_MS, remain);
    let res;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        fetchBudget,
        log,
        'poll-activities',
      );
    } catch (e) {
      log?.warn?.(`poll-activities fetch error: ${e?.message || e}`);
      // 一時的失敗・aborted: ループ継続
      const sleep = Math.min(
        POLL_INTERVAL_MS,
        Math.max(0, deadlineEpochMs - Date.now()),
      );
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.error?.(
        `poll-activities failed: status=${res.status} body=${txt.slice(0, 300)}`,
      );
      const sleep = Math.min(
        POLL_INTERVAL_MS,
        Math.max(0, deadlineEpochMs - Date.now()),
      );
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
      continue;
    }
    const j = await res.json();
    if (j.watermark) watermark = j.watermark;
    const msgs = extractBotMessages(j.activities);
    if (msgs.length > 0) {
      return { messages: msgs, watermark };
    }
    // インターバル待機 (deadlineを超えない範囲で)
    const sleep = Math.min(
      POLL_INTERVAL_MS,
      Math.max(0, deadlineEpochMs - Date.now()),
    );
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  }
  return { messages: [], watermark };
}

/**
 * 答案 payload バリデーション。
 * 戻り値: { ok:true, prompt } または { ok:false, status, error }
 */
function validateAndBuildPrompt(payload) {
  const questionId = payload?.questionId;
  if (typeof questionId !== 'string' || !questionId) {
    return { ok: false, status: 400, error: 'questionId is required' };
  }
  const question = getQuestion(questionId);
  if (!question) {
    return {
      ok: false,
      status: 400,
      error: `Unknown questionId: ${questionId}`,
    };
  }
  if (question.parts) {
    const ans = payload.answers || {};
    const filled = question.parts.some(
      (p) => typeof ans[p.key] === 'string' && ans[p.key].trim().length > 0,
    );
    if (!filled) {
      return {
        ok: false,
        status: 400,
        error: '少なくとも1つの欄に解答を入力してください。',
      };
    }
  } else {
    if (
      typeof payload.answer !== 'string' ||
      payload.answer.trim().length === 0
    ) {
      return {
        ok: false,
        status: 400,
        error: '解答が空です。記入してから採点を依頼してください。',
      };
    }
  }
  return { ok: true, questionId, question, prompt: buildPrompt(question, payload) };
}

// ============================================================================
// POST /api/grade-skk1
//   会話作成 + メッセージ送信を開始。
//   35秒以内にbot応答が拾えれば 200 で直接返す。
//   拾えなければ 202 + conversationId を返してクライアント polling に任せる。
// ============================================================================
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

    const v = validateAndBuildPrompt(payload);
    if (!v.ok) {
      return jsonResponse(v.status, { error: v.error }, origin);
    }
    const { questionId, prompt } = v;

    const t0 = Date.now();
    const deadline = t0 + ENDPOINT_BUDGET_MS;
    context.log?.(
      `grade-skk1: start questionId=${questionId} promptLen=${prompt.length}`,
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
      return jsonResponse(503, { error: 'Copilot 認証情報設定エラー' }, origin);
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

    // sendMessage を Promise として走らせ、bot text 拾えるかを並行判定する。
    // 残り時間を SEND_RESPONSE_BUDGET_MS と比較して短い方を fetch budget にする。
    const sendBudget = Math.max(
      5000,
      Math.min(SEND_RESPONSE_BUDGET_MS, deadline - Date.now() - 2000),
    );
    const sendPromise = sendMessageWithBudget(
      base,
      accessToken,
      conversationId,
      prompt,
      sendBudget,
      context,
    );

    // sendMessage 応答 or polling のどちらか先に bot text を取れた方を採用。
    let botMessages = [];
    let watermark = null;

    try {
      const sendResult = await sendPromise;
      const elapsed = Date.now() - t0;
      if (sendResult?.ok && sendResult.json) {
        const actCount = Array.isArray(sendResult.json.activities)
          ? sendResult.json.activities.length
          : 0;
        context.log?.(
          `grade-skk1: send ok t+${elapsed}ms activities=${actCount} action=${sendResult.json.action || 'n/a'}`,
        );
        botMessages = extractBotMessages(sendResult.json.activities);
        if (sendResult.json.watermark) watermark = sendResult.json.watermark;
      } else if (sendResult?.aborted) {
        context.log?.(
          `grade-skk1: send aborted t+${elapsed}ms (budget=${sendBudget}ms)・polling fallbackで継続`,
        );
      } else {
        context.log?.(
          `grade-skk1: send not ok t+${elapsed}ms status=${sendResult?.status} ・polling fallbackで継続`,
        );
      }
    } catch (e) {
      context.error?.(`grade-skk1 send unexpected: ${e?.stack || e}`);
    }

    // bot text がまだ取れていなければ、deadline まで polling
    if (botMessages.length === 0) {
      const pollDeadline = Math.min(
        deadline,
        Date.now() + POLL_TOTAL_BUDGET_MS,
      );
      const remainBudget = pollDeadline - Date.now();
      if (remainBudget > 1000) {
        context.log?.(
          `grade-skk1: polling fallback t+${Date.now() - t0}ms remain=${remainBudget}ms`,
        );
        const pollResult = await pollActivitiesUntil(
          base,
          accessToken,
          conversationId,
          watermark,
          pollDeadline,
          context,
        );
        botMessages = pollResult.messages;
        watermark = pollResult.watermark;
        context.log?.(
          `grade-skk1: poll done t+${Date.now() - t0}ms count=${botMessages.length}`,
        );
      }
    }

    if (botMessages.length > 0) {
      const text = botMessages.join('\n\n').trim();
      return jsonResponse(
        200,
        {
          questionId,
          verdict: text,
          raw: text,
          conversationId,
          watermark: watermark || undefined,
        },
        origin,
      );
    }

    // 取れなかったので pending 返却。クライアントは /api/grade-skk1-poll を投げ続ける。
    context.log?.(
      `grade-skk1: pending t+${Date.now() - t0}ms conversationId=${conversationId}`,
    );
    return jsonResponse(
      202,
      {
        questionId,
        conversationId,
        watermark: watermark || undefined,
        status: 'pending',
        message: '採点処理中。/api/grade-skk1-poll で結果を取得してください。',
      },
      origin,
    );
  },
});

// ============================================================================
// POST /api/grade-skk1-poll
//   conversationId を指定して activities polling。
//   35秒polling して bot text 取れたら 200、取れなければ 202+pending。
// ============================================================================
app.http('grade-skk1-poll', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'grade-skk1-poll',
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
    const questionId =
      typeof payload?.questionId === 'string' ? payload.questionId : null;
    const conversationId =
      typeof payload?.conversationId === 'string'
        ? payload.conversationId
        : null;
    const inWatermark =
      typeof payload?.watermark === 'string' ? payload.watermark : null;
    if (!conversationId) {
      return jsonResponse(
        400,
        { error: 'conversationId is required' },
        origin,
      );
    }

    const t0 = Date.now();
    context.log?.(
      `grade-skk1-poll: start conversationId=${conversationId} watermark=${inWatermark || 'n/a'}`,
    );

    let accessToken;
    try {
      accessToken = await getAccessToken(context);
    } catch (e) {
      if (e instanceof CopilotAuthError) {
        context.error?.(`grade-skk1-poll auth error: ${e.message}`);
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`grade-skk1-poll auth unexpected: ${e?.stack || e}`);
      return jsonResponse(503, { error: 'Copilot 認証情報設定エラー' }, origin);
    }

    const base = getCopilotBase();
    const deadline = Math.min(
      t0 + POLL_TOTAL_BUDGET_MS,
      t0 + (SWA_HARD_LIMIT_MS - 5000),
    );
    const result = await pollActivitiesUntil(
      base,
      accessToken,
      conversationId,
      inWatermark,
      deadline,
      context,
    );
    const elapsed = Date.now() - t0;
    context.log?.(
      `grade-skk1-poll: done t+${elapsed}ms count=${result.messages.length}`,
    );

    if (result.messages.length > 0) {
      const text = result.messages.join('\n\n').trim();
      return jsonResponse(
        200,
        {
          questionId,
          verdict: text,
          raw: text,
          conversationId,
          watermark: result.watermark || undefined,
        },
        origin,
      );
    }

    return jsonResponse(
      202,
      {
        questionId,
        conversationId,
        watermark: result.watermark || undefined,
        status: 'pending',
      },
      origin,
    );
  },
});
