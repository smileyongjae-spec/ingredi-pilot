// functions/cache-refresh.js  (v2 — 하위요청 예산 인식)
//
// 문제: 테이블이 늘면서(현재 14개) 한 번의 호출로 전부 갱신하면
//       Cloudflare 하위요청 한도(50)에 걸려 뒤쪽 테이블(FAQ_전체상품, 리뷰 3종)이
//       영원히 캐시에 못 들어가는 문제가 있었음.
// 해결:
//   1) ?table=테이블명  → 그 테이블 하나만 갱신 (가장 확실)
//   2) 파라미터 없이 호출 → 예산을 세면서 순차 갱신, 한도 전에 멈추고
//      remaining 목록을 반환. remaining이 빌 때까지 다시 호출하면 됨.
//
// 호출:
//   전체(배치):  https://ingredi.kr/cache-refresh?key=<SECRET>
//   단일 테이블: https://ingredi.kr/cache-refresh?key=<SECRET>&table=FAQ_전체상품

import { purge, getRecords } from './_lib/airtable.js';

const TABLES = [
  '오메가3', '눈', '마이크로바이옴', '비타민C', 'product_v2',
  '오메가3_쿠팡업데이트', '눈_쿠팡업데이트', '마이크로바이옴_쿠팡업데이트', '비타민C_쿠팡업데이트',
  'knowledge', 'FAQ_전체상품',
  '오메가_리뷰인사이트', '눈_리뷰인사이트', '비타민C_리뷰인사이트'
];

// 하위요청 예산. 실제 한도는 50이지만 여유를 둠.
// 테이블 1개 비용 ≈ KV삭제(1) + 페이지수(행수/100 올림) + KV저장(1)
const BUDGET = 38;

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

  const only = (url.searchParams.get('table') || '').trim();
  const targets = only ? only.split(',').map(s => s.trim()).filter(Boolean) : TABLES;

  const refreshed = {};
  const remaining = [];
  let spent = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // 남은 예산으로 이 테이블을 안전하게 처리할 수 있는지 사전 판단이 어려우므로
    // (행 수를 미리 모름) 보수적으로: 예산의 70%를 넘겼으면 다음 호출로 미룸.
    if (!only && spent >= BUDGET * 0.7) {
      remaining.push(...targets.slice(i));
      break;
    }
    try {
      await purge(env, t); spent += 1;
      const recs = await getRecords(env, t, { force: true });
      // fetchAll 페이지 수 + KV put
      spent += Math.max(1, Math.ceil(recs.length / 100)) + 1;
      refreshed[t] = recs.length;
    } catch (e) {
      refreshed[t] = `error: ${String(e.message || e).slice(0, 120)}`;
      // 한도 초과 계열 에러면 즉시 중단하고 나머지를 remaining으로
      if (/subrequest/i.test(String(e.message || ''))) {
        remaining.push(...targets.slice(i + 1));
        break;
      }
    }
  }

  return Response.json({
    ok: true,
    refreshed,
    remaining,
    hint: remaining.length
      ? `남은 테이블: ?table=${remaining.join(',')} 로 이어서 갱신하세요. (파라미터 없이 재호출하면 처음부터 다시 돌아 같은 지점에서 멈춥니다)`
      : '모든 테이블 갱신 완료.'
  });
}
