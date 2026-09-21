// functions/cache-refresh.js  (v3.1 — 개선소식 누락 수정 / v3 테이블명 중앙 설정 / v2 하위요청 예산 인식)
//
// [v3.1] 2026-09-20: 개선소식을 Airtable에서 고쳐도 사이트에 안 뜨는 문제 —
//   갱신 목록에 '개선소식'이 빠져 있어 전체 갱신을 돌려도 6시간 캐시가 그대로 남았다.
//   (?table=개선소식 로 단일 호출하면 되긴 했으나, 운영 중 매번 기억해야 하는 함정이라 목록에 넣는다)
//   1행짜리 테이블이라 예산(하위요청) 부담도 사실상 없다.
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
//   단일 테이블: https://ingredi.kr/cache-refresh?key=<SECRET>&table=오메가3_쿠팡업데이트_2026.09.10
//   ※ 파라미터 이름은 key (coupang-convert의 secret과 다름)

import { purge, getRecords } from './_lib/airtable.js';
import { TABLES as T, PRODUCT_TABLES } from './_lib/tables.js';   // [v3] 테이블명 중앙 설정

// [v3] 갱신 대상 = 제품 6 + 지식 2 + 리뷰 4. 옛 테이블(오메가3·눈·product_v2·*_쿠팡업데이트 무날짜)은 삭제됨.
const TABLES = [
  "개선소식",                              // [v3.1] 1행. 맨 앞에 둬 예산 소진 전에 반드시 갱신되게 한다.
  ...PRODUCT_TABLES,                       // 오메가3·눈·마이크로바이옴·비타민C·밀크씨슬·스포츠 (날짜 붙은 현행 이름)
  T.knowledge, T.FAQ,
  ...Object.values(T["리뷰"])              // 오메가_·눈_·비타민C_·밀크씨슬_·마이크로바이옴_·헬스제품_리뷰인사이트
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
