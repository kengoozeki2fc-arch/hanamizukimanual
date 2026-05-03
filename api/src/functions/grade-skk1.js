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
//     1. /api/grade-skk1       会話作成 + sendMessage を発火 (Promise.race で先勝ち)
//     2. /api/grade-skk1-poll  send Promise (引継) と GET /activities polling 並走
//   と分け、各レスポンスを 45 秒以内に収める。
//
// 重要な実装ポイント:
//   - sendMessage の fetch を AbortController で打ち切ると Power Platform 側の
//     bot 処理も中断される (実測)。よって abort せず Promise を生かしたまま race。
//   - Step1 の sendMessage Promise を module-level Map (inflightSends) に登録、
//     Step2 が同一 Functions プロセス内なら同じ Promise を引き継いで await することで、
//     bot 処理の完走を確実に待ち受ける。
//
// 流れ:
//   1. ROPC で Power Platform Access Token 取得 (warm キャッシュ)
//   2. POST /conversations  会話作成
//   3. POST /conversations/{id}  メッセージ送信開始
//      - Promise.race(sendPromise, pollPromise, deadline 40s)
//      - 40秒以内に bot 応答 activity が拾えれば 200 で verdict を直接返す
//      - 拾えなければ 202 + { conversationId, status:"pending" } を返す
//        (sendPromise は inflightSends に登録された状態で background 継続)
//   4. クライアントは pending なら /api/grade-skk1-poll を 1.5秒間隔で投げる
//      - Functions は inflightSends から sendPromise 引継 + GET /activities polling
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
 * sendMessage を発行。
 *  - timeoutMs 以内にレスポンスが返ってきたら activities を含む json を返す
 *  - timeoutMs 経過したら abort せず、Promise を捨てて { ok:false, deferred:true }
 *    を返す。fetch Promise は background で走り続け、Power Platform 側の bot 処理を
 *    完走させる。返却された Promise (deferredPromise) を呼び出し側が握って参照する
 *    ことで、Functions ホストが background promise を維持し続ける確率を上げる。
 * 重要: AbortController で切ると Power Platform 側の bot 処理も中断されるため、
 *       deadline に到達した場合は abort せず race で先勝ちさせる方式にする。
 */
function startSendMessage(base, accessToken, conversationId, text, log) {
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const res = await fetch(
        `${base}/conversations/${conversationId}?api-version=${API_VERSION}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ activity: { type: 'message', text } }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        log?.error?.(
          `Copilot send message failed: status=${res.status} body=${txt.slice(0, 300)}`,
        );
        return { ok: false, status: res.status };
      }
      const json = await res.json();
      return { ok: true, json };
    } catch (e) {
      if (e?.name === 'AbortError') {
        // 通常 race の loser として呼ばれた時に発生。Functions が落とされなければ
        // ここまで到達するが Power Platform 側は既に応答済みなので問題なし。
        log?.warn?.(`send-message aborted (loser of race)`);
        return { ok: false, aborted: true };
      }
      log?.error?.(`send-message unexpected: ${e?.stack || e}`);
      return { ok: false, error: e };
    }
  })();
  return { promise, controller };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// In-flight send Promise を Functions プロセススコープで共有するためのレジストリ。
// /grade-skk1 が起動した sendMessage POST を /grade-skk1-poll でも引き継いで
// await できるようにすることで、Power Platform 側の bot 処理が完走するまで
// HTTP コネクションを維持する。Functions ホストプロセスが warm な間のみ有効
// (cold start で消える前提)。
// ============================================================================
const inflightSends = new Map(); // conversationId -> { promise, startedAt, accessToken }
const INFLIGHT_TTL_MS = 5 * 60 * 1000;

function registerInflightSend(conversationId, promise, accessToken) {
  inflightSends.set(conversationId, {
    promise,
    startedAt: Date.now(),
    accessToken,
  });
  // 完了したら自動掃除（成功失敗どちらでも）
  promise.finally(() => {
    setTimeout(() => {
      const cur = inflightSends.get(conversationId);
      if (cur && cur.promise === promise) inflightSends.delete(conversationId);
    }, 30_000); // 完了後30秒は残してpoll側のlast-chanceに使えるようにする
  });
  // 安全弁: 5分でTTL強制削除
  setTimeout(() => {
    const cur = inflightSends.get(conversationId);
    if (cur && cur.promise === promise) inflightSends.delete(conversationId);
  }, INFLIGHT_TTL_MS);
}

function getInflightSend(conversationId) {
  return inflightSends.get(conversationId);
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

    // sendMessage を background で開始（abort せず最後まで走らせる）
    // Power Platform 側は HTTPコネクションが生きている間 bot 処理を継続するため、
    // クライアント (=Functions) 側で abort してしまうと処理が中断される実測。
    const send = startSendMessage(
      base,
      accessToken,
      conversationId,
      prompt,
      context,
    );
    // module-level レジストリに登録: /grade-skk1-poll が同一プロセス内で
    // この Promise を await できるようにする (warm な間のみ有効)。
    registerInflightSend(conversationId, send.promise, accessToken);

    // どれが先に決着するか:
    //  (a) sendMessage の HTTP レスポンス (activities含む) が返る  → 直接 verdict
    //  (b) GET /activities polling が bot text を拾う          → 直接 verdict
    //  (c) endpoint deadline が先に来る                          → 202 pending
    let botMessages = [];
    let watermark = null;

    const pollDeadline = deadline - 1000; // 1秒余裕を残す
    const sendWrapped = send.promise.then((r) => ({ kind: 'send', value: r }));
    const pollPromise = pollActivitiesUntil(
      base,
      accessToken,
      conversationId,
      null,
      pollDeadline,
      context,
    ).then((r) => ({ kind: 'poll', value: r }));
    const deadlinePromise = delay(Math.max(0, deadline - Date.now())).then(
      () => ({ kind: 'deadline' }),
    );

    // 早い者勝ち。bot text を拾ったほうの結果を採用。
    let timedOut = false;
    while (!timedOut && botMessages.length === 0) {
      const winner = await Promise.race([
        sendWrapped,
        pollPromise,
        deadlinePromise,
      ]);
      if (winner.kind === 'deadline') {
        timedOut = true;
        break;
      }
      if (winner.kind === 'send') {
        const v = winner.value;
        const elapsed = Date.now() - t0;
        if (v?.ok && v.json) {
          const actCount = Array.isArray(v.json.activities)
            ? v.json.activities.length
            : 0;
          context.log?.(
            `grade-skk1: send ok t+${elapsed}ms activities=${actCount} action=${v.json.action || 'n/a'}`,
          );
          botMessages = extractBotMessages(v.json.activities);
          if (v.json.watermark) watermark = v.json.watermark;
          if (botMessages.length > 0) break;
        } else {
          context.log?.(
            `grade-skk1: send returned without bot text t+${elapsed}ms ok=${v?.ok}`,
          );
        }
        // send が空応答だった場合は pollPromise / deadline の決着を待つ
        // ただし sendWrapped は完了済みなので race から外す → 単に poll/deadline を継続
        const next = await Promise.race([pollPromise, deadlinePromise]);
        if (next.kind === 'deadline') {
          timedOut = true;
          break;
        }
        // poll
        botMessages = next.value.messages;
        if (next.value.watermark) watermark = next.value.watermark;
        break;
      }
      if (winner.kind === 'poll') {
        botMessages = winner.value.messages;
        if (winner.value.watermark) watermark = winner.value.watermark;
        break;
      }
    }

    if (botMessages.length > 0) {
      const text = botMessages.join('\n\n').trim();
      // send promise が走り続けている可能性あるが、Power Platform側は応答済みなので
      // 落としても影響なし。HTTPレスポンス送信後 Promise が放置されると Functions
      // が unhandled rejection 警告を出すので catch を attach しておく。
      send.promise.catch(() => {});
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

    // deadline 到達: send / poll Promise は捨てて 202 pending 返却。
    // クライアントは /api/grade-skk1-poll を繰り返す。
    // send promise は abort しない (Power Platform 側の bot 処理を続行させる)
    send.promise.catch(() => {});
    pollPromise.catch(() => {});
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

    // 同一 Functions プロセス内に走っている send Promise があれば、それも race に
    // 組み込む。送信完走時の sendResponse.activities にbot text が入っているケースを
    // 拾えるようにする。
    const inflight = getInflightSend(conversationId);
    let botMessages = [];
    let watermark = inWatermark || null;

    if (inflight) {
      context.log?.(
        `grade-skk1-poll: inflight send found (startedAt=t-${Date.now() - inflight.startedAt}ms)`,
      );
      const sendWrapped = inflight.promise.then((r) => ({
        kind: 'send',
        value: r,
      }));
      const pollWrapped = pollActivitiesUntil(
        base,
        accessToken,
        conversationId,
        watermark,
        deadline,
        context,
      ).then((r) => ({ kind: 'poll', value: r }));
      const deadlineWrapped = delay(Math.max(0, deadline - Date.now())).then(
        () => ({ kind: 'deadline' }),
      );
      // 順次先勝ち取り
      while (Date.now() < deadline && botMessages.length === 0) {
        const winner = await Promise.race([
          sendWrapped,
          pollWrapped,
          deadlineWrapped,
        ]);
        if (winner.kind === 'deadline') break;
        if (winner.kind === 'send') {
          const v = winner.value;
          if (v?.ok && v.json) {
            botMessages = extractBotMessages(v.json.activities);
            if (v.json.watermark) watermark = v.json.watermark;
            context.log?.(
              `grade-skk1-poll: send completed in poll-handler activities=${(v.json.activities || []).length} bot-text=${botMessages.length}`,
            );
            if (botMessages.length > 0) break;
          } else {
            context.log?.(
              `grade-skk1-poll: send completed but no bot text ok=${v?.ok}`,
            );
          }
          // send 完走したが bot text 無し → poll 待ちで継続
          const next = await Promise.race([pollWrapped, deadlineWrapped]);
          if (next.kind === 'deadline') break;
          botMessages = next.value.messages;
          if (next.value.watermark) watermark = next.value.watermark;
          break;
        }
        if (winner.kind === 'poll') {
          botMessages = winner.value.messages;
          if (winner.value.watermark) watermark = winner.value.watermark;
          break;
        }
      }
    } else {
      // inflight なし: 通常の polling のみ
      context.log?.(
        `grade-skk1-poll: no inflight send (cold-start可能性あり)・polling only`,
      );
      const result = await pollActivitiesUntil(
        base,
        accessToken,
        conversationId,
        watermark,
        deadline,
        context,
      );
      botMessages = result.messages;
      if (result.watermark) watermark = result.watermark;
    }

    const elapsed = Date.now() - t0;
    context.log?.(
      `grade-skk1-poll: done t+${elapsed}ms count=${botMessages.length}`,
    );

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

    return jsonResponse(
      202,
      {
        questionId,
        conversationId,
        watermark: watermark || undefined,
        status: 'pending',
      },
      origin,
    );
  },
});
