// functions/changelog.js
// 개선 소식(공개) 읽기 전용 엔드포인트.
// Airtable '개선소식' 테이블에서 공개여부=true 글을 날짜 최신순으로 반환.
import { getRecords } from "./_lib/airtable.js";

const TABLE = "개선소식";

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
    // 개선 소식은 자주 안 바뀌므로 5분 캐시(KV 바인딩 시). Airtable에서 수정 후 최대 5분 내 반영.
    const records = await getRecords(env, TABLE, { ttl: 300 });
    const items = records
      .map(r => r.fields || {})
      .filter(f => isPublic(f["공개여부"]))
      .map(f => ({
        date: String(f["날짜"] || ""),
        title: String(f["제목"] || ""),
        content: String(f["내용"] || "")
      }))
      .filter(it => it.title || it.content)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 최신순

    return new Response(JSON.stringify({ items }), { headers });
  } catch (e) {
    // 실패해도 화면이 깨지지 않도록 빈 목록 + 에러메모 반환(200)
    return new Response(
      JSON.stringify({ items: [], error: String((e && e.message) || e) }),
      { headers }
    );
  }
}
