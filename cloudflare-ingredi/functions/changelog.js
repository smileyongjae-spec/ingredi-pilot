// functions/changelog.js  (v2)
// 개선 소식(공개) 읽기 전용 엔드포인트.
// Airtable '개선소식' 테이블에서 공개여부=true 글을 날짜 최신순으로 반환.
//
// v2 변경 배경 (2026-09 실측):
//   이 엔드포인트가 16초 걸린 사례 발견. 원인 추적 결과 —
//   테이블은 1행뿐이었고(데이터량 문제 아님), Airtable 응답이 그 순간 튄 것이었다.
//   문제는 ttl:300(5분) 탓에 하루 288번 만료돼 미스를 밟을 확률이 매우 높았다는 점.
//   → 1) TTL 5분 → 기본값(6시간)
//     2) ctx 전달로 SWR 활성화 — 만료돼도 옛 값을 즉시 주고 갱신은 백그라운드에서.
//        즉 사용자가 Airtable을 기다리는 경로가 사라진다.
//     3) 필터·정렬·개수 제한을 Airtable 서버에 위임 (airtable.js v6 지원)
//   즉시 반영이 필요하면 /cache-refresh 를 쓰면 되므로 짧은 TTL의 이유가 없다.

import { getRecords } from "./_lib/airtable.js";

const TABLE = "개선소식";
const MAX_ITEMS = 30;   // 화면은 3개 + 더보기. 30개면 충분하고도 남는다.

function isPublic(v) {
  return v === true || v === 1 || v === "true" || v === "TRUE" || v === "공개";
}

export async function onRequest(context) {
  const { env } = context;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  try {
    const records = await getRecords(env, TABLE, {
      ctx: context,                                    // ← SWR·비동기 캐시 쓰기 활성화
      sort: [{ field: "날짜", direction: "desc" }],     // 서버측 정렬
      maxRecords: MAX_ITEMS
      // ttl 미지정 → 기본 6시간
      // fields·filter 는 airtable.js v6 의 TABLE_FIELDS/TABLE_FILTER 가 적용
    });

    const items = records
      .map(r => r.fields || {})
      .filter(f => isPublic(f["공개여부"]))   // 서버측 필터의 이중 안전장치
      .map(f => ({
        date: String(f["날짜"] || ""),
        title: String(f["제목"] || ""),
        content: String(f["내용"] || "")
      }))
      .filter(it => it.title || it.content)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 최신순(방어적 재정렬)

    return new Response(JSON.stringify({ items }), { headers });
  } catch (e) {
    // 실패해도 화면이 깨지지 않도록 빈 목록 + 에러메모 반환(200)
    return new Response(
      JSON.stringify({ items: [], error: String((e && e.message) || e) }),
      { headers }
    );
  }
}
