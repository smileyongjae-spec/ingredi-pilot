// functions/health.js  v1.0  (2026-09-18)
// 운영 헬스체크 — 상담이 "조용히" 죽는 두 경로(크레딧 소진·릴레이 장애)를 밖에서 감지하기 위한 엔드포인트.
//   GET https://ingredi.kr/health            → 가벼운 점검(KV·Airtable 캐시). 200 {"ok":true,...}
//   GET https://ingredi.kr/health?deep=1     → 릴레이·LLM까지 실호출(토큰 ~10개). 어느 하나라도 실패면 503.
// UptimeRobot 등 무료 모니터에 ?deep=1 을 15분 간격으로 등록하고 키워드 '"ok":true' 로 감시한다.
// 결과는 KV(health:last)에 저장해 /health?last=1 로 최근 상태를 볼 수 있다.

import { getRecords } from "./_lib/airtable.js";
import { PRODUCT_TABLES } from "./_lib/tables.js";

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

  if (deep) {
    // 3) 릴레이 도달성 — RELAY_BASE 루트 GET (Deno 릴레이는 GET에 200/404를 주면 살아 있는 것)
    if (env.RELAY_BASE) {
      try { const t1 = Date.now(); const r = await fetch(env.RELAY_BASE, { method: "GET" }); checks.relay = { ok: r.status < 500, status: r.status, ms: Date.now() - t1 }; }
      catch (e) { checks.relay = { ok: false, error: String(e.message || e).slice(0, 80) }; }
    } else checks.relay = { ok: null, note: "RELAY_BASE 미설정 — 직접 호출 모드" };

    // 4) LLM — 최소 호출로 크레딧·키·릴레이 경로를 실검증 (max_tokens 5)
    try {
      const t1 = Date.now();
      const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "ping" }] });
      let r;
      if (env.RELAY_BASE && env.RELAY_SECRET) {
        r = await fetch(env.RELAY_BASE.replace(/\/$/, "") + "/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-relay-secret": env.RELAY_SECRET }, body });
      } else {
        r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" }, body });
      }
      const txt = await r.text();
      const creditLow = /credit balance is too low/i.test(txt);
      checks.llm = { ok: r.status === 200, status: r.status, ms: Date.now() - t1, creditLow, hint: creditLow ? "Anthropic 크레딧 소진 — Plans & Billing" : (r.status === 401 ? "API 키 무효/만료" : (r.status === 200 ? null : txt.slice(0, 100))) };
    } catch (e) { checks.llm = { ok: false, error: String(e.message || e).slice(0, 100) }; }
  }

  const ok = Object.values(checks).every(c => c.ok !== false);
  const out = { ok, deep, checkedAt: new Date().toISOString(), ms: Date.now() - t0, checks };
  if (env.CACHE) context.waitUntil(env.CACHE.put("health:last", JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 3 }).catch(() => {}));
  return Response.json(out, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
