// functions/health.js  v1.1  (2026-09-27)
// 운영 헬스체크 — 상담이 "조용히" 죽는 경로(크레딧 소진·릴레이 장애·BYOK 차단)를 밖에서 감지한다.
//   GET /health            → 가벼운 점검(KV·Airtable 캐시). 200 {"ok":true,...}
//   GET /health?deep=1     → LLM 경로 실호출(경로당 토큰 ~10개).
//   GET /health?last=1     → 최근 점검 결과(KV health:last)
// [v1.1] 판정 기준을 "상담이 실제로 답할 수 있는가"로 변경.
//   - LLM 점검을 counsel2 v17.29와 같은 호출 방식으로 맞춤(릴레이는 RELAY_BASE 루트로 POST — v1.0은 /v1/messages를 붙여 counsel2와 달랐음).
//   - 릴레이·BYOK를 각각 독립 점검. 둘 다 실패하면 직접 호출까지 시도.
//   - ok(503 여부) = KV·Airtable 정상 + LLM 경로 중 하나라도 200.
//   - degraded = 릴레이 실패(상담은 BYOK로 답하지만, 릴레이 재시도만큼 느려지고 BYOK 간헐 차단 위험이 있음). 200 유지.
//   - 별도 GET 도달성 점검은 제거(POST 점검이 대신함).

import { getRecords } from "./_lib/airtable.js";
import { PRODUCT_TABLES } from "./_lib/tables.js";

const PING = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "ping" }] });

async function probe(url, headers) {
  const t1 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: PING });
    const txt = r.status === 200 ? "" : await r.text().catch(() => "");
    const creditLow = /credit balance is too low/i.test(txt);
    return {
      ok: r.status === 200, status: r.status, ms: Date.now() - t1, creditLow,
      hint: r.status === 200 ? null : creditLow ? "Anthropic 크레딧 소진 — Plans & Billing" : r.status === 401 ? "키/토큰 무효·만료" : txt.slice(0, 100)
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t1, error: String(e.message || e).slice(0, 100) };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";
  const t0 = Date.now();
  const checks = {};

  if (url.searchParams.get("last") === "1" && env.CACHE) {
    const last = await env.CACHE.get("health:last", "json").catch(() => null);
    return Response.json(last || { ok: null, note: "기록 없음" });
  }

  // 1) KV
  try { await env.CACHE.put("health:ping", String(Date.now()), { expirationTtl: 60 }); const v = await env.CACHE.get("health:ping"); checks.kv = { ok: !!v }; }
  catch (e) { checks.kv = { ok: false, error: String(e.message || e).slice(0, 80) }; }

  // 2) Airtable — 제품 테이블 하나(캐시 우선, 미스면 실호출). 0행이면 테이블명 불일치로 본다.
  try {
    const t1 = Date.now(); const rows = await getRecords(env, PRODUCT_TABLES[0], { ctx: context });
    checks.airtable = { ok: rows.length > 0, table: PRODUCT_TABLES[0], rows: rows.length, ms: Date.now() - t1 };
  } catch (e) { checks.airtable = { ok: false, error: String(e.message || e).slice(0, 120) }; }

  let degraded = false;
  if (deep) {
    // 3) LLM 경로 — counsel2와 같은 호출 방식. 경로마다 1회만(재시도 없음).
    const paths = {};
    if (env.RELAY_BASE && env.RELAY_SECRET) {
      paths.relay = await probe(env.RELAY_BASE, { "x-relay-secret": env.RELAY_SECRET });
    } else paths.relay = { ok: null, note: "RELAY_BASE/RELAY_SECRET 미설정" };

    if (env.CF_AIG_TOKEN && env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY) {
      paths.byok = await probe(`https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic/v1/messages`,
        { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`, "anthropic-version": "2023-06-01" });
    } else paths.byok = { ok: null, note: "CF_AIG_TOKEN/CF_ACCOUNT_ID/CF_AI_GATEWAY 미설정" };

    // 릴레이·BYOK가 모두 실패했을 때만 직접 호출(counsel2의 마지막 폴백)
    if (paths.relay.ok !== true && paths.byok.ok !== true) {
      paths.direct = await probe("https://api.anthropic.com/v1/messages",
        { "x-api-key": env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" });
    }

    const served = ["relay", "byok", "direct"].find(k => paths[k] && paths[k].ok === true) || null;
    degraded = paths.relay.ok === false;
    checks.llm = { ok: !!served, servedBy: served, paths };
  }

  const ok = Object.values(checks).every(c => c.ok !== false);
  const out = { ok, degraded, deep, checkedAt: new Date().toISOString(), ms: Date.now() - t0, checks };
  if (env.CACHE) context.waitUntil(env.CACHE.put("health:last", JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 3 }).catch(() => {}));
  return Response.json(out, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
