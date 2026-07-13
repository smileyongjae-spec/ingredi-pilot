// Cloudflare Pages Function: Coupang Partners Deeplink 자동 전환 (Method B, v3.1)
// File path: functions/coupang-convert.js
// URL: /coupang-convert?secret=<CACHE_REFRESH_SECRET>[&dryRun=1][&limit=200][&table=비타민C_쿠팡업데이트]
//
// 동작:
//   1) 대상 테이블에서 "쿠팡 URL"(raw 쿠팡 링크)이 있고 coupang_deeplink 가 비어있는 레코드 수집
//   2) URL을 청크(기본 20개)로 묶어 쿠팡 파트너스 Deeplink API 호출 (HMAC-SHA256 서명)
//   3) [v3] 청크가 통째로 거부되거나(rCode 400 — 묶음에 불량 URL이 하나라도 있으면 전체 거부)
//      성공 응답에서 일부 URL이 누락되면, 실패분을 1개씩 개별 재시도해 불량 URL만 격리한다.
//      끝까지 실패한 URL은 failedUrls 로 사유와 함께 반환 → 상품 URL 교체 판단용.
//   4) [v3.1] Cloudflare 하위요청 한도(호출당 50) 대응 — 모든 외부 요청을 실측 카운트하고
//      예산(45) 안에서만 진행. 예산이 차면 그 시점까지 확보한 딥링크를 Airtable에 기록하고
//      remaining 으로 반환 → 같은 URL을 다시 호출하면 이어서 처리된다(멱등).
//   5) 반환된 딥링크(shortenUrl)를 coupang_deeplink 컬럼에 기록 (원본 "쿠팡 URL"·제품링크는 보존)
//   ※ 쿠팡 URL 이 비어 있는 제품은 건너뜀 → recommend2 에서 자동으로 네이버(제품링크)로 폴백
//
// 기본 대상 테이블: 4개 _쿠팡업데이트 테이블. ?table= 로 단일/복수(쉼표) 지정 가능.
// 대량 처리 팁: ?table=오메가3_쿠팡업데이트 처럼 테이블 하나씩 부르면 예산 여유가 커져 한 번에 더 많이 처리.
//
// 필요 환경변수 (Cloudflare):
//   COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, CACHE_REFRESH_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID
//   + 각 대상 테이블에 coupang_deeplink (Long text) 컬럼 추가 필요

const COUPANG_DOMAIN = "https://api-gateway.coupang.com";
const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
const DEFAULT_TABLES = ["오메가3_쿠팡업데이트", "눈_쿠팡업데이트", "마이크로바이옴_쿠팡업데이트", "비타민C_쿠팡업데이트"];
const RAW_FIELDS = ["쿠팡 URL", "쿠팡URL", "쿠팡_URL", "쿠팡링크"]; // raw 쿠팡 링크 컬럼 후보(공백 표기 차이 흡수)
const F_DEEP = "coupang_deeplink";
const CHUNK = 20;           // Deeplink API 1회 요청당 URL 수 (API 상한: 20)
const AIRTABLE_BATCH = 10;   // Airtable PATCH 1회당 레코드 수(최대 10)
const SUBREQ_BUDGET = 45;    // Cloudflare 하위요청 한도(50)에서 여유 5를 뺀 실행 예산

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
  const limit = Math.max(1, Math.min(2000, parseInt(url.searchParams.get("limit") || "500", 10) || 500));
  const tableParam = (url.searchParams.get("table") || "").trim();
  const tables = tableParam ? tableParam.split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_TABLES;

  // [v3.1] 하위요청 실측 카운터 — 모든 외부 fetch 는 cfetch 로만 호출한다.
  let subreq = 0;
  async function cfetch(u, opts) { subreq++; return fetch(u, opts); }
  const budgetLeft = () => SUBREQ_BUDGET - subreq;

  if (!GUARD || secret !== GUARD) {
    // 안전 진단: ?debug=1 이면 값은 숨기고 길이/일치 여부만 반환 (원인 추적용)
    if (url.searchParams.get("debug") === "1") {
      return new Response(JSON.stringify({
        debug: true,
        guardConfigured: !!GUARD,
        guardLength: GUARD ? GUARD.length : 0,
        providedLength: secret.length,
        match: secret === GUARD,
        coupangKeysConfigured: !!ACCESS && !!SECRET,
        airtableConfigured: !!TOKEN && !!BASE_ID
      }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: "unauthorized", message: "secret 파라미터가 필요합니다." }), { status: 401, headers });
  }
  if (!ACCESS || !SECRET) {
    return new Response(JSON.stringify({ error: "config_missing", message: "COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 미설정" }), { status: 500, headers });
  }
  if (!TOKEN || !BASE_ID) {
    return new Response(JSON.stringify({ error: "config_missing", message: "AIRTABLE_TOKEN / AIRTABLE_BASE_ID 미설정" }), { status: 500, headers });
  }

  // ── 헬퍼 ──
  function readRaw(f) {
    for (const k of RAW_FIELDS) {
      let v = f[k];
      if (Array.isArray(v)) v = v[0];
      v = (v || "").toString().trim();
      if (v) return v;
    }
    return "";
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
  async function callDeeplink(urls) {
    const datetime = signedDate();
    const message = datetime + "POST" + DEEPLINK_PATH; // query 없음
    const signature = await hmacHex(message);
    const auth = `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${datetime}, signature=${signature}`;
    const res = await cfetch(COUPANG_DOMAIN + DEEPLINK_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8", "Authorization": auth },
      body: JSON.stringify({ coupangUrls: urls })
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text };
  }
  // 응답 data 를 urlToDeep 에 흡수. 성공적으로 매핑된 URL 수를 반환.
  function absorb(urlToDeep, urls, json) {
    const data = (json && json.data) || [];
    let n = 0;
    data.forEach((item, idx) => {
      const deep = item.shortenUrl || item.landingUrl || "";
      if (!deep) return;
      const orig = item.originalUrl || urls[idx];
      if (orig && !urlToDeep[orig]) { urlToDeep[orig] = deep; n++; }
      if (urls[idx] && !urlToDeep[urls[idx]]) { urlToDeep[urls[idx]] = deep; n++; }
    });
    return n;
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
    if (!r.ok) throw new Error("patch " + r.status + ": " + (await r.text()).slice(0, 200));
    return r.json();
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    // ── [1] 대상 수집 (테이블별) ──
    const perTable = {};   // table → [{recId, url}]
    let scanned = 0, pendingTotal = 0;
    const readErrors = [];
    for (const table of tables) {
      let recs;
      try { recs = await airtableGetAll(table); }
      catch (e) { readErrors.push({ table, error: e.message }); continue; }
      scanned += recs.length;
      const pend = [];
      for (const rec of recs) {
        const f = rec.fields || {};
        const raw = readRaw(f);
        const deep = (f[F_DEEP] || "").toString().trim();
        if (raw && !deep) pend.push({ recId: rec.id, url: raw });
      }
      perTable[table] = pend;
      pendingTotal += pend.length;
    }

    // limit 적용(테이블 순서대로)
    let remaining = limit;
    const targets = []; // {table, recId, url}
    for (const table of tables) {
      for (const t of (perTable[table] || [])) {
        if (remaining <= 0) break;
        targets.push({ table, recId: t.recId, url: t.url });
        remaining--;
      }
      if (remaining <= 0) break;
    }

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true, dryRun: true, tables, scanned, pending: pendingTotal,
        pendingByTable: Object.fromEntries(tables.map(t => [t, (perTable[t] || []).length])),
        willConvert: targets.length, sample: targets.slice(0, 5), readErrors
      }), { status: 200, headers });
    }
    if (targets.length === 0) {
      return new Response(JSON.stringify({ ok: true, tables, scanned, pending: 0, converted: 0, message: "전환 대상 없음", readErrors }), { status: 200, headers });
    }

    // ── [2] Deeplink 변환: 1차 청크 호출 ──
    const uniqUrls = [...new Set(targets.map(t => t.url))];
    const urlToDeep = {};
    const apiErrors = [];
    // 기록(PATCH) 몫을 남겨둔다: 확보할 딥링크를 쓰려면 최소 ceil(대상/10)회 필요. 보수적으로 8 예약.
    const RESERVE_FOR_WRITE = 8;
    for (let i = 0; i < uniqUrls.length; i += CHUNK) {
      if (budgetLeft() <= RESERVE_FOR_WRITE) break;
      const urls = uniqUrls.slice(i, i + CHUNK);
      const { status, json, text } = await callDeeplink(urls);
      if (status !== 200 || !json || (json.rCode && json.rCode !== "0")) {
        // 청크 통째 거부 — 이 청크의 URL들은 [2.5] 개별 재시도로 넘어간다.
        apiErrors.push({ chunk: i / CHUNK, status, rCode: json && json.rCode, rMessage: (json && json.rMessage) || text.slice(0, 200) });
        continue;
      }
      absorb(urlToDeep, urls, json);
      await sleep(400);
    }

    // ── [2.5] 개별 재시도 (v3) ──
    // 청크 거부분 + 성공 응답에서 누락된 URL을 1개씩 호출해 불량 URL만 격리한다.
    // [v3.1] 하위요청 예산 안에서만 진행 — 남으면 remaining 으로 반환, 재호출 시 이어서 처리(멱등).
    const missed = uniqUrls.filter(u => !urlToDeep[u]);
    const failedUrls = [];   // {url, rCode, rMessage}
    let retried = 0, retryConverted = 0;
    for (const u of missed) {
      if (budgetLeft() <= RESERVE_FOR_WRITE) break;
      retried++;
      const { status, json, text } = await callDeeplink([u]);
      if (status === 200 && json && (!json.rCode || json.rCode === "0")) {
        const n = absorb(urlToDeep, [u], json);
        if (n > 0) { retryConverted++; }
        else failedUrls.push({ url: u, rCode: json.rCode || "0", rMessage: "응답에 딥링크 없음(shortenUrl 누락)" });
      } else {
        failedUrls.push({ url: u, rCode: json && json.rCode, rMessage: ((json && json.rMessage) || text || "").slice(0, 160) });
      }
      await sleep(300);
    }
    const retrySkipped = Math.max(0, missed.length - retried); // 예산 소진으로 이번에 못 돈 수 — 재호출 시 이어서 처리

    // ── [3] Airtable 기록 (테이블별 batch) ──
    let written = 0, noMatch = 0, writeSkipped = 0;
    for (const table of tables) {
      const writes = [];
      for (const t of targets.filter(x => x.table === table)) {
        const deep = urlToDeep[t.url];
        if (deep) writes.push({ id: t.recId, fields: { [F_DEEP]: deep } });
        else noMatch++;
      }
      for (let i = 0; i < writes.length; i += AIRTABLE_BATCH) {
        if (budgetLeft() <= 1) { writeSkipped += writes.length - i; break; }
        const batch = writes.slice(i, i + AIRTABLE_BATCH);
        await airtablePatch(table, batch);
        written += batch.length;
        await sleep(250);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      tables,
      scanned,
      pending: pendingTotal,
      attempted: targets.length,
      uniqueUrls: uniqUrls.length,
      converted: Object.keys(urlToDeep).length,
      retried,
      retryConverted,
      retrySkipped,           // 하위요청 예산 소진으로 이번 호출에서 재시도 못 한 수 — 다시 호출하면 이어서 처리
      written,
      writeSkipped,           // 예산 소진으로 기록 못 한 수(변환은 됐으나 미기록 — 재호출 시 재변환·기록됨)
      failedToConvert: noMatch,
      failedUrls: failedUrls.slice(0, 30),   // 개별 재시도까지 실패한 URL과 사유 — 상품 URL 교체 판단용
      subrequestsUsed: subreq, // 이번 호출이 쓴 하위요청 수 (예산 45)
      apiErrors,
      readErrors,
      sampleDeeplinks: Object.entries(urlToDeep).slice(0, 3).map(([u, d]) => ({ from: u, to: d }))
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
