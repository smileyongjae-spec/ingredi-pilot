// functions/cache-refresh.js
// Airtable 데이터를 고친 뒤, 캐시를 즉시 새로고침하는 엔드포인트.
// 호출:  https://ingredi-pilot.pages.dev/cache-refresh?key=<CACHE_REFRESH_SECRET>
// 비밀키(CACHE_REFRESH_SECRET)는 Cloudflare 환경변수로 설정. 키 없으면 403.
import { purge, getRecords } from './_lib/airtable.js';
const TABLES = [
  '오메가3', '눈', '마이크로바이옴', '비타민C', 'product_v2',
  // recommend2 가 딥링크/링크를 읽는 _쿠팡업데이트 테이블 (딥링크 변환 후 갱신 필요)
  '오메가3_쿠팡업데이트', '눈_쿠팡업데이트', '마이크로바이옴_쿠팡업데이트', '비타민C_쿠팡업데이트',
  // RAG 카운슬링이 읽는 knowledge / FAQ 테이블 (2026-07 FAQ 4종 → FAQ_전체상품 통합)
  'knowledge', 'FAQ_전체상품',
  // 카드 리뷰 인사이트 테이블
  '오메가_리뷰인사이트', '눈_리뷰인사이트', '비타민C_리뷰인사이트'
];
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.CACHE_REFRESH_SECRET || key !== env.CACHE_REFRESH_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!env.CACHE) {
    return Response.json({ ok: false, error: 'KV(CACHE)가 바인딩되지 않았습니다' }, { status: 500 });
  }
  const result = {};
  for (const t of TABLES) {
    try {
      await purge(env, t);
      const recs = await getRecords(env, t, { force: true });
      result[t] = recs.length;
    } catch (e) {
      result[t] = `error: ${e.message}`;
    }
  }
  return Response.json({ ok: true, refreshed: result });
}
