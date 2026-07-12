// functions/_lib/airtable.js  (v2 — 테이블별 필드 화이트리스트)
// 공용 Airtable 페치 + KV 캐시 헬퍼.
// _lib 폴더는 밑줄(_)로 시작해서 Cloudflare 라우팅에서 제외됨(엔드포인트 아님).
// 다른 Function들이 import 해서 씀:  import { getRecords } from './_lib/airtable.js';
// 반환 형태는 Airtable 원형과 동일: [{ id, fields }, ...]  (기존 코드 호환)
//
// v2 변경: TABLE_FIELDS — 행이 무거운 테이블은 필요한 컬럼만 요청.
//   Airtable은 pageSize=100을 요청해도 응답 크기가 크면 페이지당 행 수를 줄여서
//   1,000행이 40~50페이지로 쪼개질 수 있고, 그러면 Cloudflare 하위요청 한도(50)에
//   걸린다. 필드를 제한하면 행이 가벼워져 페이지가 다시 100행씩 담긴다.
//   ⚠ 필드명이 테이블 실제 컬럼명과 다르면 Airtable이 422(UNKNOWN_FIELD_NAME)로
//   거절하며, 에러 본문에 어떤 필드가 틀렸는지 나온다 → 그 이름만 고치면 됨.

const DEFAULT_TTL = 60 * 60 * 6; // 6시간(초). 데이터 수정은 최대 6시간 안에 반영, 즉시 반영은 /cache-refresh 사용.

// 필요한 컬럼만 받아올 테이블 목록. counsel-api.js가 읽는 컬럼과 일치해야 함.
const TABLE_FIELDS = {
  'FAQ_전체상품': [
    'faq_id', 'question', 'answer', 'keywords', '소분류',
    '임상근거', '제품카테고리', '건강도메인', '검수상태'
  ],
  'knowledge': [
    '지식ID', '카테고리', '한줄정의', '답변예시', '키워드',
    '관련성분키워드', '임상근거', '제품카테고리', '건강도메인'
  ]
};

// 환경변수 이름이 셋업마다 다를 수 있어 폴백으로 여러 개 지원.
function getToken(env) {
  return env.AIRTABLE_TOKEN || env.AIRTABLE_API_KEY || env.AIRTABLE_PAT || env.AIRTABLE_KEY;
}
function getBaseId(env) {
  return env.AIRTABLE_BASE_ID || env.BASE_ID || env.AIRTABLE_BASE;
}

// Airtable 테이블 전체 레코드를 페이지네이션으로 모두 가져옴.
async function fetchAll(env, table, fields) {
  const base = getBaseId(env);
  const token = getToken(env);
  if (!base || !token) throw new Error('airtable env 미설정: BASE_ID 또는 TOKEN 없음');

  const root = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
  const fieldsQS = (fields && fields.length)
    ? fields.map(f => `&fields%5B%5D=${encodeURIComponent(f)}`).join('')
    : '';
  const out = [];
  let offset = null;
  do {
    const url = root + `?pageSize=100` + fieldsQS + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
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
 * - KV(env.CACHE)가 바인딩돼 있으면: 캐시 히트 시 그대로 반환, 미스/만료 시 Airtable에서 가져와 캐시에 저장.
 * - KV가 없으면: 그냥 매번 Airtable 직접 호출(= 캐시 도입 전 동작). 그래서 바인딩 전에 배포해도 안전.
 * @param {object} env  Pages Functions env
 * @param {string} table  Airtable 테이블명 (예: '오메가3')
 * @param {object} opts  { ttl, force, fields }  fields 미지정 시 TABLE_FIELDS의 기본값 사용
 */
export async function getRecords(env, table, opts = {}) {
  const ttl = opts.ttl || DEFAULT_TTL;
  const force = !!opts.force;
  const fields = opts.fields || TABLE_FIELDS[table] || null;
  const key = `at:${table}`;

  if (env.CACHE && !force) {
    try {
      const cached = await env.CACHE.get(key, 'json');
      if (cached && Array.isArray(cached)) return cached;
    } catch (_) { /* 캐시 읽기 실패 시 그냥 원본 페치로 */ }
  }

  const records = await fetchAll(env, table, fields);

  if (env.CACHE) {
    try {
      await env.CACHE.put(key, JSON.stringify(records), { expirationTtl: ttl });
    } catch (_) { /* 캐시 쓰기 실패는 무시(데이터는 이미 확보) */ }
  }
  return records;
}

// 특정 테이블 캐시 삭제(수동 새로고침용).
export async function purge(env, table) {
  if (env.CACHE) {
    try { await env.CACHE.delete(`at:${table}`); } catch (_) {}
  }
}

/**
 * 단일 레코드 생성(쓰기). 피드백 등 사용자 입력 저장용.
 * 읽기 캐시(getRecords)와 무관 — 쓰기는 항상 Airtable로 직접 POST.
 * @param {object} env  Pages Functions env
 * @param {string} table  Airtable 테이블명 (예: '피드백')
 * @param {object} fields  { 필드명: 값 }
 * @returns {Promise<{id: string, fields: object}>}
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
