// gradeStore.js
// ----------------------------------------------------------------------------
// 採点結果の「conversationId キー一時ストア」。
//
// 背景 (案A):
//   採点 bot cr746_agent は POST /conversations/{id} (sendMessage) の
//   レスポンス本体に採点結果を同期返却する型 (46〜54 秒)。GET /activities には
//   一切蓄積されない (常に count=0)。さらに send 1回が SWA の 45 秒 HTTP
//   ハードリミットを超え、かつ grade-skk1 と grade-skk1-poll が別インスタンスに
//   振られると module-level の inflightSends Map が共有されず結果を取りこぼす。
//
//   そこで send の同期返却本文を「インスタンスを跨いで読める永続ストア」に
//   conversationId キーで保存し、poll は (どのインスタンスからでも) そのストアを
//   読むことで結果を確実に拾う。
//
// ストア実体: Azure Table Storage。
//   接続文字列は App Settings の AzureWebJobsStorage を使う
//   (SWA managed Functions / Azure Functions ランタイムの動作に必須なので
//    存在が保証される)。GRADE_STORE_CONNECTION で明示上書きも可。
//
// degrade 設計:
//   接続文字列が取得できない / data-tables が読めない環境では、ストアを無効化し
//   呼び出し側 (grade-skk1.js) の module-level inflightSends Map fallback のみで
//   動作する。ストア無効でも例外を投げず、null/false を返して握りつぶす。
//
// レコード shape (Table entity):
//   partitionKey: "grade"
//   rowKey:       conversationId
//   status:       "pending" | "done" | "error"
//   verdict:      string (status=done のとき採点本文)
//   errorMessage: string (status=error のとき)
//   questionId:   string
//   createdAt:    ISO string
//   updatedAt:    ISO string
// ----------------------------------------------------------------------------

const PARTITION_KEY = 'grade';
const TABLE_NAME = 'gradeResults';
// 古いレコードの目安 TTL (ストアには自動削除は無いが、poll 側で stale 判定に使う)
const RECORD_TTL_MS = 10 * 60 * 1000;

let _clientPromise; // Promise<TableClient | null> をメモ化
let _storeDisabledReason = null;

function _resolveConnectionString() {
  return (
    process.env.GRADE_STORE_CONNECTION ||
    process.env.AzureWebJobsStorage ||
    process.env.AZURE_STORAGE_CONNECTION_STRING ||
    null
  );
}

/**
 * TableClient を 1度だけ生成してメモ化。
 * 接続不能なら null を返し、以降ストア無効として振る舞う。
 */
async function _getClient(log) {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const conn = _resolveConnectionString();
    if (!conn) {
      _storeDisabledReason = 'no connection string (AzureWebJobsStorage 等が未設定)';
      log?.warn?.(`gradeStore disabled: ${_storeDisabledReason}`);
      return null;
    }
    // identity ベース接続 (AzureWebJobsStorage__accountName 形式) には
    // fromConnectionString が使えない。その場合は素直に degrade する。
    if (!/AccountKey=|SharedAccessSignature=|UseDevelopmentStorage=/.test(conn)) {
      _storeDisabledReason =
        'connection string is identity-based (no AccountKey/SAS) — data-tables fromConnectionString 非対応のため degrade';
      log?.warn?.(`gradeStore disabled: ${_storeDisabledReason}`);
      return null;
    }
    try {
      const { TableClient } = require('@azure/data-tables');
      const client = TableClient.fromConnectionString(conn, TABLE_NAME, {
        allowInsecureConnection: /UseDevelopmentStorage=true/.test(conn),
      });
      // テーブルが無ければ作る (既存なら 409 を握りつぶす)
      try {
        await client.createTable();
      } catch (e) {
        if (e?.statusCode !== 409) {
          // 作成権限が無い等。読めるかは別なので致命ではないが警告。
          log?.warn?.(`gradeStore createTable warn: ${e?.message || e}`);
        }
      }
      log?.(`gradeStore enabled: table=${TABLE_NAME}`);
      return client;
    } catch (e) {
      _storeDisabledReason = `client init failed: ${e?.message || e}`;
      log?.warn?.(`gradeStore disabled: ${_storeDisabledReason}`);
      return null;
    }
  })();
  return _clientPromise;
}

function isEnabled() {
  // _clientPromise 解決前は楽観的に true。呼び出し側は戻り値で都度判定する。
  return _storeDisabledReason === null;
}

/**
 * pending レコードを作成 (既存があれば上書き)。
 * @returns true=書けた / false=ストア無効 or 失敗
 */
async function putPending(conversationId, questionId, log) {
  const client = await _getClient(log);
  if (!client) return false;
  const now = new Date().toISOString();
  try {
    await client.upsertEntity(
      {
        partitionKey: PARTITION_KEY,
        rowKey: conversationId,
        status: 'pending',
        verdict: '',
        errorMessage: '',
        questionId: questionId || '',
        createdAt: now,
        updatedAt: now,
      },
      'Replace',
    );
    return true;
  } catch (e) {
    log?.warn?.(`gradeStore putPending failed: ${e?.message || e}`);
    return false;
  }
}

/**
 * 採点完了結果を保存。pending を done に更新 (merge)。
 * @returns true=書けた / false=ストア無効 or 失敗
 */
async function putDone(conversationId, questionId, verdict, log) {
  const client = await _getClient(log);
  if (!client) return false;
  const now = new Date().toISOString();
  try {
    await client.upsertEntity(
      {
        partitionKey: PARTITION_KEY,
        rowKey: conversationId,
        status: 'done',
        verdict: verdict || '',
        errorMessage: '',
        questionId: questionId || '',
        updatedAt: now,
      },
      'Merge',
    );
    return true;
  } catch (e) {
    log?.warn?.(`gradeStore putDone failed: ${e?.message || e}`);
    return false;
  }
}

/**
 * 採点エラーを保存。
 */
async function putError(conversationId, questionId, errorMessage, log) {
  const client = await _getClient(log);
  if (!client) return false;
  const now = new Date().toISOString();
  try {
    await client.upsertEntity(
      {
        partitionKey: PARTITION_KEY,
        rowKey: conversationId,
        status: 'error',
        verdict: '',
        errorMessage: (errorMessage || '').slice(0, 1000),
        questionId: questionId || '',
        updatedAt: now,
      },
      'Merge',
    );
    return true;
  } catch (e) {
    log?.warn?.(`gradeStore putError failed: ${e?.message || e}`);
    return false;
  }
}

/**
 * conversationId キーでレコードを取得。
 * @returns { status, verdict, errorMessage, questionId, ageMs } | null
 *          ストア無効 / 未登録 / 失敗時は null。
 */
async function get(conversationId, log) {
  const client = await _getClient(log);
  if (!client) return null;
  try {
    const e = await client.getEntity(PARTITION_KEY, conversationId);
    const updatedAt = e.updatedAt || e.createdAt;
    const ageMs = updatedAt ? Date.now() - Date.parse(updatedAt) : null;
    return {
      status: e.status || 'pending',
      verdict: e.verdict || '',
      errorMessage: e.errorMessage || '',
      questionId: e.questionId || '',
      ageMs,
    };
  } catch (e) {
    if (e?.statusCode === 404) return null; // 未登録
    log?.warn?.(`gradeStore get failed: ${e?.message || e}`);
    return null;
  }
}

module.exports = {
  isEnabled,
  putPending,
  putDone,
  putError,
  get,
  RECORD_TTL_MS,
};
