// functions/_lib/airtable.js  (v5 — 계측 훅 추가)
// 공용 Airtable 페치 + KV 캐시 헬퍼.
// _lib 폴더는 밑줄(_)로 시작해서 Cloudflare 라우팅에서 제외됨(엔드포인트 아님).
// 다른 Function들이 import 해서 씀:  import { getRecords } from './_lib/airtable.js';
// 반환 형태는 Airtable 원형과 동일: [{ id, fields }, ...]  (기존 코드 호환)
//
// v3 변경 배경 (2026-07 장애):
//   파트너가 FAQ_전체상품에 미분류 행 4,307개를 머지 → 5,001행 = 51페이지
//   → 이 테이블 하나가 Cloudflare 하위요청 한도(50)를 단독 초과 → 상담 전면 장애.
//   해결 1) TABLE_FILTER: 분류 완료 행만 서버측(filterByFormula)에서 받아옴.
//   해결 2) TABLE_FIELDS: 서비스가 읽는 컬럼만 요청해 행당 페이로드 축소.
//
// v4 변경 배경 (제품명 직접 조회):
//   같은 테이블을 서로 다른 필드셋으로 읽는 호출이 생김 —
//   recommend2/counsel2는 제품 테이블 전체(30여 컬럼)를, counsel2 제품명 인덱스는
//   3컬럼만 읽는다. 캐시 키가 테이블명뿐이면 둘이 충돌(먼저 캐싱한 쪽이 이겨
//   recommend2가 3컬럼짜리를 받아 깨질 수 있음). → opts.variant 로 캐시 키를 분리.
//   variant 없는 기존 호출은 캐시 키가 그대로(at:${table})라 무효화·cache-refresh 호환.
//
// v5 변경 배경 (첫 화면 20초 간헐 지연 진단):
//   캐시 미스 경로의 어느 구간이 20초를 만드는지 실측하기 위한 계측 훅만 추가.
//   opts.timing 에 배열을 넘기면 단계별 소요(ms)·페이로드 크기를 기록한다.
//   *** 동작·캐시 키·반환값은 v4와 완전히 동일. timing 미지정 시 오버헤드 0. ***
//
//   [주의] Cloudflare Workers는 보안상 Date.now()가 I/O 발생 전까지 진행하지 않는다.
//          따라서 네트워크·KV 구간은 정확히 측정되지만, 순수 CPU 구간(매핑·정렬·
//          파레토 계산)은 0ms로 찍힌다. 이건 오류가 아니라 플랫폼 특성이다.

const DEFAULT_TTL = 60 * 60 * 6; // 6시간(초). 즉시 반영은 /cache-refresh 사용.

const TABLE_FIELDS = {
  'FAQ_전체상품': [
    'question', 'answer', 'keywords', '소분류',
    '임상근거', '제품카테고리', '건강도메인', '검수상태'
  ]
};

const TABLE_FILTER = {
  'FAQ_전체상품': "AND({제품카테고리}!='',{건강도메인}!='')",
  'knowledge':    "AND({제품카테고리}!='',{건강도메인}!='')"
};

function getToken(env) {
  return env.AIRTABLE_TOKEN || env.AIRTABLE_API_KEY || env.AIRTABLE_PAT || env.AIRTABLE_KEY;
}
function getBaseId(env) {
  return env.AIRTABLE_BASE_ID || env.BASE_ID || env.AIRTABLE_BASE;
}

// 계측 기록 헬퍼. t가 없으면 아무것도 하지 않는다.
function mark(t, entry) { if (t) t.push(entry); }

async function fetchAll(env, table, fields, filter, t) {
  const base = getBaseId(env);
  const token = getToken(env);
  if (!base || !token) throw new Error('airtable env 미설정: BASE_ID 또는 TOKEN 없음');

  const root = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
  const fieldsQS = (fields && fields.length)
    ? fields.map(f => `&fields%5B%5D=${encodeURIComponent(f)}`).join('')
    : '';
  const filterQS = filter ? `&filterByFormula=${encodeURIComponent(filter)}` : '';
  const out = [];
  let offset = null;
  let page = 0;
  do {
    page++;
    const url = root + `?pageSize=100` + fieldsQS + filterQS + (offset ? `&offset=${encodeURIComponent(offset)}` : '');

    const tFetch = Date.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const msFetch = Date.now() - tFetch;

    if (!res.ok) {
      const body = await res.text();
      // 429(rate limit)·5xx 를 계측에 남긴다 — 20초 원인 후보 판별용
      mark(t, { step: `airtable.page`, table, page, ms: msFetch, status: res.status, error: true });
      throw new Error(`airtable ${res.status}: ${body}`);
    }

    const tParse = Date.now();
    const data = await res.json();
    const msParse = Date.now() - tParse;

    for (const r of data.records) out.push({ id: r.id, fields: r.fields });
    offset = data.offset || null;

    mark(t, {
      step: 'airtable.page', table, page,
      msFetch, msParse, ms: msFetch + msParse,
      status: res.status, records: data.records.length, hasMore: !!offset
    });
  } while (offset);
  return out;
}

/**
 * 테이블 레코드를 캐시 우선으로 반환.
 * @param {object} env  Pages Functions env
 * @param {string} table  Airtable 테이블명
 * @param {object} opts  { ttl, force, fields, filter, variant, timing }
 *   - variant: 같은 테이블을 다른 필드셋으로 읽을 때 캐시를 분리하는 태그(예: 'idx').
 *              미지정 시 기존 키(at:${table}) 그대로 — cache-refresh·기존 호출 호환.
 *   - timing:  배열을 넘기면 단계별 계측을 push 한다(진단용). 미지정 시 계측 없음.
 */
export async function getRecords(env, table, opts = {}) {
  const t = opts.timing || null;
  const T0 = Date.now();

  const ttl = opts.ttl || DEFAULT_TTL;
  const force = !!opts.force;
  const fields = opts.fields || TABLE_FIELDS[table] || null;
  const filter = opts.filter !== undefined ? opts.filter : (TABLE_FILTER[table] || null);
  const key = opts.variant ? `at:${table}:${opts.variant}` : `at:${table}`;

  if (env.CACHE && !force) {
    const c0 = Date.now();
    let cached = null;
    try {
      cached = await env.CACHE.get(key, 'json');
    } catch (_) { /* 캐시 읽기 실패 시 그냥 원본 페치로 */ }
    const msGet = Date.now() - c0;

    if (cached && Array.isArray(cached)) {
      mark(t, { step: 'kv.get', table, key, ms: msGet, hit: true, records: cached.length });
      mark(t, { step: 'getRecords.total', table, ms: Date.now() - T0, source: 'cache' });
      return cached;
    }
    mark(t, { step: 'kv.get', table, key, ms: msGet, hit: false });
  }

  const records = await fetchAll(env, table, fields, filter, t);

  if (env.CACHE) {
    const body = JSON.stringify(records);
    mark(t, { step: 'payload', table, records: records.length, bytes: body.length, ttl });

    const p0 = Date.now();
    let putOk = true;
    try {
      await env.CACHE.put(key, body, { expirationTtl: ttl });
    } catch (_) { putOk = false; /* 캐시 쓰기 실패는 무시 */ }
    mark(t, { step: 'kv.put', table, key, ms: Date.now() - p0, ok: putOk });
  }

  mark(t, { step: 'getRecords.total', table, ms: Date.now() - T0, source: 'airtable' });
  return records;
}

// 특정 테이블 캐시 삭제(수동 새로고침용). variant 캐시(idx)도 함께 지운다.
export async function purge(env, table) {
  if (env.CACHE) {
    for (const k of [`at:${table}`, `at:${table}:idx`]) {
      try { await env.CACHE.delete(k); } catch (_) {}
    }
  }
}

/**
 * 단일 레코드 생성(쓰기). 피드백 등 사용자 입력 저장용.
 */
export async function createRecord(env, table, fields) {
  const base = getBaseId(env);
  const token = getToken(env);
  if (!base || !token) throw new Error('airtable env 미설정: BASE_ID 또는 TOKEN 없음');

  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields, typecast: true })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`airtable ${res.status}: ${body}`);
  }
  const data = await res.json();
  return { id: data.id, fields: data.fields };
}
