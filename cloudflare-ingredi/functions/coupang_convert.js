// 배포 위치: functions/coupang-convert.js
// 쿠팡 딥링크 일괄 사전변환 엔드포인트 (cache-refresh.js 패턴)
//
// 사용:
//   /coupang-convert?key=<CACHE_REFRESH_SECRET>&table=product_v2
// 옵션:
//   &force=1      이미 딥링크가 있는 레코드도 재변환
//   &limit=20     이번 호출에서 변환할 최대 개수 (테스트용)
//
// 동작: Airtable 에서 원본 쿠팡 URL을 읽어 deeplink 로 변환 → coupang_deeplink 컬럼에 저장 → 캐시 purge

import { convertDeeplinks } from "./_lib/coupang.js";
import { purge } from "./_lib/airtable.js";

// ─── 확인 필요: Airtable 컬럼명 ──────────────────────────────────
const CONFIG = {
  SOURCE_URL_FIELD: "coupang_url",     // ★ 원본 쿠팡 상품 URL 컬럼명 — 실제 컬럼명으로 맞춰줘
  DEEPLINK_FIELD: "coupang_deeplink",  // 변환된 shortenUrl 저장 컬럼명
  SUB_ID: "ingredi",                    // 채널 추적용 subId ('' 로 두면 미사용)
  BATCH_SIZE: 20,                       // deeplink 1회 호출당 URL 개수
  THROTTLE_MS: 1200,                    // 호출 간 대기(ms) — 레이트리밋(초당 10회) 안전장치
};
// ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllRecords(env, table) {
  const records = [];
  let offset;
  do {
    const u = new URL(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`
    );
    u.searchParams.set("pageSize", "100");
    if (offset) u.searchParams.set("offset", offset);
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
    });
    if (!res.ok)
      throw new Error(`Airtable 읽기 실패 ${res.status}: ${await res.text()}`);
    const j = await res.json();
    records.push(...j.records);
    offset = j.offset;
  } while (offset);
  return records;
}

async function patchRecords(env, table, updates) {
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10);
    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: chunk }),
      }
    );
    if (!res.ok)
      throw new Error(`Airtable 쓰기 실패 ${res.status}: ${await res.text()}`);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 인증 (cache-refresh 와 동일한 시크릿 재사용)
  if (url.searchParams.get("key") !== env.CACHE_REFRESH_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const table = url.searchParams.get("table") || "product_v2";
  const force = url.searchParams.get("force") === "1";
  const limit = parseInt(url.searchParams.get("limit") || "0", 10);

  try {
    const records = await fetchAllRecords(env, table);

    // 변환 대상: 원본 URL 있고, (force거나) 아직 딥링크 없는 것
    let targets = records.filter((r) => {
      const src = r.fields[CONFIG.SOURCE_URL_FIELD];
      const done = r.fields[CONFIG.DEEPLINK_FIELD];
      return src && (force || !done);
    });
    if (limit > 0) targets = targets.slice(0, limit);

    // URL → 레코드ID 매핑 (같은 URL을 쓰는 레코드가 여럿일 수 있음)
    const byUrl = new Map();
    for (const r of targets) {
      const src = String(r.fields[CONFIG.SOURCE_URL_FIELD]).trim();
      if (!byUrl.has(src)) byUrl.set(src, []);
      byUrl.get(src).push(r.id);
    }
    const uniqueUrls = [...byUrl.keys()];

    // 배치 변환
    const resultMap = new Map(); // originalUrl -> shortenUrl
    for (let i = 0; i < uniqueUrls.length; i += CONFIG.BATCH_SIZE) {
      const batch = uniqueUrls.slice(i, i + CONFIG.BATCH_SIZE);
      const out = await convertDeeplinks(env, batch, CONFIG.SUB_ID);

      if (out.ok) {
        for (const [orig, v] of out.map) resultMap.set(orig, v.shortenUrl);
      } else {
        // 배치 거절 → 1개씩 재시도해서 불량 URL만 골라냄
        for (const one of batch) {
          await sleep(CONFIG.THROTTLE_MS);
          try {
            const single = await convertDeeplinks(env, [one], CONFIG.SUB_ID);
            if (single.ok && single.map.has(one)) {
              resultMap.set(one, single.map.get(one).shortenUrl);
            }
          } catch (_) {
            // 개별 실패는 무시하고 failed 로 분류됨
          }
        }
      }

      if (i + CONFIG.BATCH_SIZE < uniqueUrls.length)
        await sleep(CONFIG.THROTTLE_MS);
    }

    // Airtable 업데이트 페이로드 구성
    const updates = [];
    const failed = [];
    for (const [src, ids] of byUrl) {
      const shorten = resultMap.get(src);
      if (shorten) {
        for (const id of ids)
          updates.push({ id, fields: { [CONFIG.DEEPLINK_FIELD]: shorten } });
      } else {
        failed.push(src); // 변환 불가(예: 400204) → 대체 상품 필요
      }
    }

    if (updates.length) await patchRecords(env, table, updates);

    // 라이브 서비스가 새 딥링크를 바로 반영하도록 캐시 무효화
    try {
      await purge(env, table);
    } catch (_) {
      /* purge 실패는 치명적이지 않음 (TTL 만료 시 자동 갱신) */
    }

    return json({
      table,
      scanned: records.length,       // 테이블 전체 레코드 수
      eligible: targets.length,      // 변환 대상 레코드 수
      uniqueUrls: uniqueUrls.length, // 중복 제거 후 변환 시도한 URL 수
      converted: updates.length,     // 딥링크 저장 성공한 레코드 수
      failedCount: failed.length,    // 변환 불가 URL 수
      failed: failed.slice(0, 50),   // 변환 불가 URL 목록(최대 50개)
    });
  } catch (e) {
    return json({ error: String(e.message || e), table }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
