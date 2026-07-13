// functions/_lib/airtable.js  (v4 — 캐시 키 variant 분리)
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

async function fetchAll(env, table, fields, filter) {
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
  do {
    const url = root + `?pageSize=100` + fieldsQS + filterQS + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`airtable ${res.status}: ${body}`);
    }
    const data = await res.json();
    for (const r of data.records) out.push({ id: r.id, fields: r.fields });
    offset = data.offset || null;
  } while (offset);
  return out;
}

/**
 * 테이블 레코드를 캐시 우선으로 반환.
 * @param {object} env  Pages Functions env
 * @param {string} table  Airtable 테이블명
 * @param {object} opts  { ttl, force, fields, filter, variant }
 *   - variant: 같은 테이블을 다른 필드셋으로 읽을 때 캐시를 분리하는 태그(예: 'idx').
 *              미지정 시 기존 키(at:${table}) 그대로 — cache-refresh·기존 호출 호환.
 */
export async function getRecords(env, table, opts = {}) {
  const ttl = opts.ttl || DEFAULT_TTL;
  const force = !!opts.force;
  const fields = opts.fields || TABLE_FIELDS[table] || null;
  const filter = opts.filter !== undefined ? opts.filter : (TABLE_FILTER[table] || null);
  const key = opts.variant ? `at:${table}:${opts.variant}` : `at:${table}`;

  if (env.CACHE && !force) {
    try {
      const cached = await env.CACHE.get(key, 'json');
      if (cached && Array.isArray(cached)) return cached;
    } catch (_) { /* 캐시 읽기 실패 시 그냥 원본 페치로 */ }
  }

  const records = await fetchAll(env, table, fields, filter);

  if (env.CACHE) {
    try {
      await env.CACHE.put(key, JSON.stringify(records), { expirationTtl: ttl });
    } catch (_) { /* 캐시 쓰기 실패는 무시 */ }
  }
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
