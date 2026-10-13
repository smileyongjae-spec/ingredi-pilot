// functions/log-search.js  v1.1  (2026-10-12) — [v1.1] 결과수: 값이 없으면(null) 비워 둠(기존엔 0으로 기록되던 버그) / 유입 경로 src 기록(검색로그 테이블 src 열)
// 검색어 · 카운슬링 질문 로깅 → Airtable "검색로그" 테이블
// 응답 속도에 영향을 주지 않도록 Airtable 쓰기는 waitUntil로 백그라운드 처리.

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json().catch(() => ({}));
    let { type, content, category, resultCount, src } = body;

    // 내용 정리 + 상한
    content = (content == null ? '' : String(content)).trim().slice(0, 2000);
    if (!content) return json({ ok: false, skipped: 'empty' });

    const fields = {
      '타입': type === '검색' ? '검색' : '질문',
      '내용': content,
      '카테고리': (category == null ? '미상' : String(category)).slice(0, 100),
    };
    // [v1.1] null·빈 값은 Number()가 0이 되므로 먼저 걸러낸다
    if (resultCount !== null && resultCount !== undefined && resultCount !== '') {
      const rc = Number(resultCount);
      if (Number.isFinite(rc)) fields['결과수'] = rc;
    }
    if (src) fields['src'] = String(src).slice(0, 40);

    // 토큰 환경변수 이름 자동 탐색 (기존 /feedback 과 동일한 것을 사용)
    const TOKEN =
      env.AIRTABLE_TOKEN ||
      env.AIRTABLE_API_KEY ||
      env.AIRTABLE_PAT ||
      env.AIRTABLE_KEY;
    const BASE_ID = env.AIRTABLE_BASE_ID || 'app3wwrYkvQHXsYUn';

    if (!TOKEN) return json({ ok: false, error: 'no_token' });

    const url =
      'https://api.airtable.com/v0/' + BASE_ID + '/' + encodeURIComponent('검색로그');

    // 응답을 기다리지 않고 즉시 200 반환 (로깅이 UX를 막지 않도록)
    context.waitUntil(
      fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields, typecast: true }),
      }).catch(() => {})
    );

    return json({ ok: true });
  } catch (e) {
    // 로깅 실패는 조용히 무시
    return json({ ok: false, error: 'exception' });
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
