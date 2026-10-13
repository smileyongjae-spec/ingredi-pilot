// functions/coupang-convert.js  v4.0  (2026-10-01)
// Cloudflare Pages Function: Coupang Partners Deeplink 자동 전환
//
// [v4.0] 2026-10-01 — URL 변경분만 선별 변환 + 쿠팡 API 호출 최소화
//   1) 선별 변환: 딥링크를 만든 URL을 deeplink_source 에 기록하고, 현재 "쿠팡 URL"과 비교해
//      바뀐 행(상품번호·itemId·vendorItemId 기준)만 다시 변환한다. 검색어 등 트래킹 파라미터는 비교에서 무시.
//   2) 실패 영구 기록: 400(링크 생성 제한·판매중단 등)은 deeplink_status 에 "FAIL 400 날짜"로 남기고,
//      URL이 바뀌기 전까지 다시 시도하지 않는다(v3.5의 KV 7일 기억 폐지). ?retryFailed=1 로만 강제 재시도.
//   3) URL이 바뀌었는데 새 URL이 실패하면 옛 딥링크를 지운다(옛 옵션으로 가는 것보다 원본 URL 연결이 낫다).
//   4) 쿠팡 URL이 지워진 행의 딥링크도 지운다(API 호출 없음).
//   5) 묶음 거부(400) 시 1개씩 전부 재시도하던 방식 → 반씩 나눠 재시도(불량 URL 격리 호출 수 절감).
//   6) 응답-URL 매칭 수정: v3는 API가 일부 URL을 빼고 돌려줘도 순서(idx)로 짝지어, 옆 제품의 딥링크가
//      붙을 수 있었다. v4는 originalUrl 의 상품 키로만 짝짓고, 개수가 같을 때만 순서를 쓴다.
//   7) 상한 도달·속도 제한으로 못 돈 URL은 실패로 기록하지 않는다(다음 호출에서 이어서 처리).
//   8) ?backfill=1 — 이미 딥링크가 있고 deeplink_source 가 빈 행에 현재 URL을 기록만 한다(쿠팡 호출 0회).
//      딥링크가 없는 행은 이번 재변환 실패분으로 보고 "FAIL backfill"로 기록(다음 호출에서 재시도 안 함).
//      2026-10-01 전체 재변환 직후 1회 실행용 — 각 테이블 마지막 변환이 "전환 대상 없음"인 상태에서 실행.
//
// URL: /coupang-convert?secret=<CACHE_REFRESH_SECRET>&table=<전체 테이블명>
//      [&dryRun=1] 대상만 집계(쿠팡 호출·기록 없음)
//      [&backfill=1] deeplink_source 채우기(쿠팡 호출 없음)
//      [&retryFailed=1] FAIL 기록 행도 다시 시도(호출 많이 씀 — 꼭 필요할 때만)
//      [&limit=100] 호출 1회당 변환 대상 행 상한(기본 100, 최대 200)
//
// 필요 환경변수: COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, CACHE_REFRESH_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID
// 필요 Airtable 열(각 제품 테이블): coupang_deeplink, deeplink_source, deeplink_status (모두 텍스트)

import { PRODUCT_TABLES } from "./_lib/tables.js";

const COUPANG_DOMAIN = "https://api-gateway.coupang.com";
const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
const DEFAULT_TABLES = PRODUCT_TABLES;
const RAW_FIELDS = ["쿠팡 URL", "쿠팡URL", "쿠팡_URL", "쿠팡링크"];
const F_DEEP = "coupang_deeplink";
const F_SRC = "deeplink_source";
const F_STAT = "deeplink_status";
const CHUNK = 20;            // Deeplink API 1회 요청당 URL 수 (API 상한 20)
const AIRTABLE_BATCH = 10;   // Airtable PATCH 1회당 레코드 수(최대 10)
const SUBREQ_BUDGET = 45;    // Cloudflare 하위요청 한도(50) - 여유 5
const MAX_API_CALLS = 30;    // 호출 1회당 쿠팡 API 요청 상한 (분당 100회 제한 방어)
const API_INTERVAL_MS = 1200;

export async function onRequest(context) {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response("", { status: 200, headers });

  const ACCESS = env.COUPANG_ACCESS_KEY;
  const SECRET = env.COUPANG_SECRET_KEY;
  const TOKEN = env.AIRTABLE_TOKEN;
  const BASE_ID = env.AIRTABLE_BASE_ID;
  const GUARD = env.CACHE_REFRESH_SECRET;

  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  const dryRun = url.searchParams.get("dryRun") === "1";
  const backfill = url.searchParams.get("backfill") === "1";
  const retryFailed = url.searchParams.get("retryFailed") === "1";
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
  const tableParam = (url.searchParams.get("table") || "").trim();
  const tables = tableParam ? tableParam.split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_TABLES;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

  let subreq = 0;
  async function cfetch(u, opts) { subreq++; return fetch(u, opts); }
  const budgetLeft = () => SUBREQ_BUDGET - subreq;

  if (!GUARD || secret !== GUARD) {
    if (url.searchParams.get("debug") === "1") {
      return json({
        debug: true, guardConfigured: !!GUARD, guardLength: GUARD ? GUARD.length : 0,
        providedLength: secret.length, match: secret === GUARD,
        coupangKeysConfigured: !!ACCESS && !!SECRET, airtableConfigured: !!TOKEN && !!BASE_ID
      });
    }
    return json({ error: "unauthorized", message: "secret 파라미터가 필요합니다." }, 401);
  }
  if (!ACCESS || !SECRET) return json({ error: "config_missing", message: "COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 미설정" }, 500);
  if (!TOKEN || !BASE_ID) return json({ error: "config_missing", message: "AIRTABLE_TOKEN / AIRTABLE_BASE_ID 미설정" }, 500);

  // ── 헬퍼 ──
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const str = v => (Array.isArray(v) ? v[0] : v || "").toString().trim();
  function readRaw(f) {
    for (const k of RAW_FIELDS) { const v = str(f[k]); if (v) return v; }
    return "";
  }
  function today() {   // KST 날짜
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  // 상품 식별에 필요한 productId(경로)·itemId·vendorItemId 만 남긴 URL (트래킹 파라미터 제거)
  function cleanUrl(raw) {
    try {
      const u = new URL(raw);
      if (!(u.hostname === "coupang.com" || u.hostname.endsWith(".coupang.com"))) return raw;
      const keep = new URLSearchParams();
      const itemId = u.searchParams.get("itemId");
      const vendorItemId = u.searchParams.get("vendorItemId");
      if (itemId) keep.set("itemId", itemId);
      if (vendorItemId) keep.set("vendorItemId", vendorItemId);
      const qs = keep.toString();
      return "https://www.coupang.com" + u.pathname + (qs ? "?" + qs : "");
    } catch (_) { return raw; }
  }
  // 비교용 상품 키: 상품번호|itemId|vendorItemId (도메인·검색어 차이 무시)
  function keyOf(raw) {
    if (!raw) return "";
    try {
      const u = new URL(raw);
      const m = u.pathname.match(/\/products\/(\d+)/);
      if (!m) return raw.trim();
      return [m[1], u.searchParams.get("itemId") || "", u.searchParams.get("vendorItemId") || ""].join("|");
    } catch (_) { return raw.trim(); }
  }
  function signedDate() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    const yy = String(d.getUTCFullYear()).slice(2);
    return `${yy}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }
  async function hmacHex(message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function airtableGetAll(table) {
    let records = [], offset = null, guard = 0;
    do {
      let u = "https://api.airtable.com/v0/" + BASE_ID + "/" + encodeURIComponent(table) + "?pageSize=100";
      if (offset) u += "&offset=" + encodeURIComponent(offset);
      const r = await cfetch(u, { headers: { Authorization: "Bearer " + TOKEN } });
      if (!r.ok) throw new Error("read " + r.status + ": " + (await r.text()).slice(0, 200));
      const d = await r.json();
      records = records.concat(d.records || []);
      offset = d.offset; guard++;
    } while (offset && guard < 12);
    return records;
  }
  async function airtablePatch(table, recs) {
    const u = "https://api.airtable.com/v0/" + BASE_ID + "/" + encodeURIComponent(table);
    const r = await cfetch(u, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ records: recs })
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      if (/UNKNOWN_FIELD_NAME/.test(t)) throw new Error(`Airtable 열 없음 — '${table}' 테이블에 ${F_SRC}·${F_STAT} 열(텍스트)을 추가하세요. (${t.slice(0, 120)})`);
      throw new Error("patch " + r.status + ": " + t);
    }
    return r.json();
  }
  // 테이블별 쓰기 목록을 10개씩 PATCH. 예산이 부족하면 남은 수를 반환.
  async function flushWrites(writesByTable) {
    let written = 0, skipped = 0;
    for (const table of Object.keys(writesByTable)) {
      const w = writesByTable[table];
      for (let i = 0; i < w.length; i += AIRTABLE_BATCH) {
        if (budgetLeft() <= 0) { skipped += w.length - i; break; }
        const batch = w.slice(i, i + AIRTABLE_BATCH);
        await airtablePatch(table, batch);
        written += batch.length;
        await sleep(250);
      }
    }
    return { written, skipped };
  }

  // ── 쿠팡 API ──
  let apiCalls = 0, rateLimited = false;
  async function callDeeplink(urls) {
    apiCalls++;
    const datetime = signedDate();
    const signature = await hmacHex(datetime + "POST" + DEEPLINK_PATH);
    const auth = `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${datetime}, signature=${signature}`;
    const res = await cfetch(COUPANG_DOMAIN + DEEPLINK_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8", "Authorization": auth },
      body: JSON.stringify({ coupangUrls: urls })
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    if (res.status === 403 || (j && String(j.rCode) === "403") || /시간당 사용 횟수|초과했습니다/.test(text)) rateLimited = true;
    await sleep(API_INTERVAL_MS);
    return { status: res.status, json: j, text };
  }

  try {
    // ── [1] 테이블 읽기·분류 ──
    const DATE = today();
    const rows = [];   // {table, recId, name, raw, clean, key, deep, src, stat, kind}
    const counts = { scanned: 0, upToDate: 0, skippedFailed: 0, legacyNoSource: 0, noUrl: 0 };
    const readErrors = [];
    for (const table of tables) {
      let recs;
      try { recs = await airtableGetAll(table); }
      catch (e) { readErrors.push({ table, error: e.message }); continue; }
      counts.scanned += recs.length;
      for (const rec of recs) {
        const f = rec.fields || {};
        const raw = readRaw(f);
        const deep = str(f[F_DEEP]);
        const src = str(f[F_SRC]);
        const stat = str(f[F_STAT]);
        const name = str(f["제품명"]).slice(0, 60);
        const base = { table, recId: rec.id, name, raw, deep, src, stat };
        if (!raw) {
          if (deep || src || stat) rows.push({ ...base, kind: "clearNoUrl" });
          else counts.noUrl++;
          continue;
        }
        const clean = cleanUrl(raw), key = keyOf(clean);
        const r = { ...base, clean, key };
        if (src && keyOf(src) === key) {
          if (stat.startsWith("FAIL")) { if (retryFailed) rows.push({ ...r, kind: "retry" }); else counts.skippedFailed++; }
          else if (deep) counts.upToDate++;
          else rows.push({ ...r, kind: "empty" });           // 딥링크만 누가 지운 경우
        } else if (!src) {
          if (deep) { if (backfill) rows.push({ ...r, kind: "backfill" }); else counts.legacyNoSource++; }
          else rows.push({ ...r, kind: backfill ? "backfillFail" : "new" });   // backfill: 전체 재변환 뒤에도 딥링크가 없는 행 = 이번 재변환 실패분
        } else {
          rows.push({ ...r, kind: "changed" });              // URL이 바뀐 행
        }
      }
    }
    const byKind = k => rows.filter(r => r.kind === k);
    const clearRows = byKind("clearNoUrl");
    const backfillRows = byKind("backfill");
    const backfillFailRows = byKind("backfillFail");
    const order = { changed: 0, retry: 1, new: 2, empty: 3 };
    const allTargets = rows.filter(r => r.kind in order).sort((a, b) => order[a.kind] - order[b.kind]);
    const targets = allTargets.slice(0, limit);
    const summary = {
      ...counts,
      targetsChanged: byKind("changed").length, targetsNew: byKind("new").length,
      targetsEmpty: byKind("empty").length, targetsRetry: byKind("retry").length,
      clearNoUrl: clearRows.length, backfill: backfillRows.length, backfillMarkedFail: backfillFailRows.length
    };

    if (dryRun) {
      return json({
        ok: true, dryRun: true, tables, ...summary,
        willConvert: targets.length, overLimit: Math.max(0, allTargets.length - targets.length),
        sample: targets.slice(0, 5).map(t => ({ table: t.table, kind: t.kind, name: t.name, url: t.clean, before: t.src || null })),
        note: summary.legacyNoSource ? `deeplink_source 가 빈 기존 딥링크 ${summary.legacyNoSource}건 — &backfill=1 을 먼저 1회 실행하세요` : null,
        readErrors
      });
    }

    // ── [2] backfill 모드: 기록만, 쿠팡 호출 없음 ──
    if (backfill) {
      const wb = {};
      for (const r of backfillRows) (wb[r.table] = wb[r.table] || []).push({ id: r.recId, fields: { [F_SRC]: r.clean, [F_STAT]: `OK ${DATE} backfill` } });
      // 딥링크 없는 행은 이번 전체 재변환의 실패분으로 보고 FAIL 기록 → URL이 바뀌기 전까지 재시도 안 함
      for (const r of backfillFailRows) (wb[r.table] = wb[r.table] || []).push({ id: r.recId, fields: { [F_SRC]: r.clean, [F_STAT]: `FAIL backfill ${DATE}` } });
      const { written, skipped } = await flushWrites(wb);
      return json({
        ok: true, mode: "backfill", tables, ...summary, written, writeSkipped: skipped, apiCalls: 0,
        message: skipped ? "기록 예산 소진 — 같은 주소를 다시 호출하면 이어서 기록" : "완료", readErrors
      });
    }

    const writesByTable = {};
    const pushWrite = (table, recId, fields) => (writesByTable[table] = writesByTable[table] || []).push({ id: recId, fields });
    for (const r of clearRows) pushWrite(r.table, r.recId, { [F_DEEP]: "", [F_SRC]: "", [F_STAT]: "" });

    if (targets.length === 0) {
      const { written, skipped } = await flushWrites(writesByTable);
      return json({ ok: true, tables, ...summary, attempted: 0, apiCalls: 0, written, writeSkipped: skipped, message: "변환 대상 없음", readErrors });
    }

    // ── [3] 쿠팡 변환 (반씩 나눠 불량 URL 격리) ──
    // 기록 예산: 테이블별 ceil(행/10) + 여유 1
    const perTableCount = {};
    for (const t of targets) perTableCount[t.table] = (perTableCount[t.table] || 0) + 1;
    for (const r of clearRows) perTableCount[r.table] = (perTableCount[r.table] || 0) + 1;
    const reserve = Object.values(perTableCount).reduce((s, n) => s + Math.ceil(n / AIRTABLE_BATCH), 0) + 1;

    const cleans = [...new Set(targets.map(t => t.clean))];
    const cleanByKey = {}; for (const c of cleans) cleanByKey[keyOf(c)] = c;
    const cleanToDeep = {};          // clean → deeplink
    const failed = {};               // clean → {rCode, rMessage}  (400만 — 영구 기록)
    const deferred = new Set();      // 상한·속도 제한·일시 오류로 못 돈 것 — 기록 안 함, 다음 호출에서 이어서
    const apiErrors = [];

    function absorb(group, j) {
      const data = (j && j.data) || [];
      const inGroup = new Set(group);
      data.forEach((item, idx) => {
        const deep = item.shortenUrl || item.landingUrl || "";
        if (!deep) return;
        let c = null;
        if (item.originalUrl) {
          if (inGroup.has(item.originalUrl)) c = item.originalUrl;
          else { const k = cleanByKey[keyOf(item.originalUrl)]; if (k && inGroup.has(k)) c = k; }
        }
        if (!c && data.length === group.length) c = group[idx];   // 개수가 같을 때만 순서로 짝짓기
        if (c && !cleanToDeep[c]) cleanToDeep[c] = deep;
      });
    }
    const canCall = () => !rateLimited && apiCalls < MAX_API_CALLS && budgetLeft() > reserve;
    async function resolve(group) {
      if (!group.length) return;
      if (!canCall()) { group.forEach(c => deferred.add(c)); return; }
      const { status, json: j, text } = await callDeeplink(group);
      const ok = status === 200 && j && (!j.rCode || String(j.rCode) === "0");
      if (ok) {
        absorb(group, j);
        const missing = group.filter(c => !cleanToDeep[c]);
        if (!missing.length) return;
        if (group.length === 1) { failed[group[0]] = { rCode: "0", rMessage: "응답에 딥링크 없음" }; return; }
        return split(missing);
      }
      const rc = j && j.rCode != null ? String(j.rCode) : String(status);
      if (rateLimited || rc !== "400") {   // 400이 아니면 일시 오류로 보고 기록하지 않음
        apiErrors.push({ size: group.length, status, rCode: rc, rMessage: ((j && j.rMessage) || text || "").slice(0, 120) });
        group.forEach(c => deferred.add(c));
        return;
      }
      if (group.length === 1) { failed[group[0]] = { rCode: "400", rMessage: ((j && j.rMessage) || "").slice(0, 80) }; return; }
      return split(group);
    }
    async function split(g) {
      if (g.length === 1) return resolve(g);
      const mid = Math.ceil(g.length / 2);
      await resolve(g.slice(0, mid));
      await resolve(g.slice(mid));
    }
    for (let i = 0; i < cleans.length; i += CHUNK) await resolve(cleans.slice(i, i + CHUNK));

    // ── [4] 기록 ──
    let converted = 0, failedRows = 0, clearedOld = 0;
    const failedList = [];
    for (const t of targets) {
      const deep = cleanToDeep[t.clean];
      if (deep) {
        pushWrite(t.table, t.recId, { [F_DEEP]: deep, [F_SRC]: t.clean, [F_STAT]: `OK ${DATE}` });
        converted++;
      } else if (failed[t.clean]) {
        const f = failed[t.clean];
        // 실패: 옛 딥링크는 지운다(옛 URL·옛 옵션으로 가므로) — 2026-10-01 결정
        pushWrite(t.table, t.recId, { [F_DEEP]: "", [F_SRC]: t.clean, [F_STAT]: `FAIL ${f.rCode} ${DATE}` });
        failedRows++;
        if (t.deep) clearedOld++;
        if (failedList.length < 30) failedList.push({ table: t.table, kind: t.kind, name: t.name, url: t.clean, rCode: f.rCode, rMessage: f.rMessage });
      }
      // deferred: 기록하지 않음 → 다음 호출에서 그대로 대상
    }
    const { written, skipped } = await flushWrites(writesByTable);
    const deferredRows = targets.filter(t => deferred.has(t.clean)).length;
    const left = Math.max(0, allTargets.length - targets.length) + deferredRows;

    return json({
      ok: true, tables, ...summary,
      attempted: targets.length, uniqueUrls: cleans.length,
      converted, failed: failedRows, clearedOldDeeplink: clearedOld, deferred: deferredRows,
      apiCalls, rateLimited,
      warning: rateLimited ? "쿠팡 속도 제한(403) 감지 — 최소 1시간 뒤 재호출. 3회 초과 시 파트너스 이용 제한" : null,
      written, writeSkipped: skipped,
      next: left > 0 && !rateLimited ? `남은 대상 ${left}건 — 1분 뒤 같은 주소를 다시 호출` : (rateLimited ? "1시간 뒤 재호출" : "완료"),
      failedList, apiErrors, readErrors, subrequestsUsed: subreq,
      sampleDeeplinks: targets.filter(t => cleanToDeep[t.clean]).slice(0, 3).map(t => ({ name: t.name, from: t.clean, to: cleanToDeep[t.clean] }))
    });
  } catch (error) {
    return json({ error: "internal_error", message: error.message }, 500);
  }
}
