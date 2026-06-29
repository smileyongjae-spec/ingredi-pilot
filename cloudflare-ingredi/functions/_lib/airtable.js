// functions/_lib/airtable.js
// 공용 Airtable 페치 + KV 캐시 헬퍼.
// _lib 폴더는 밑줄(_)로 시작해서 Cloudflare 라우팅에서 제외됨(엔드포인트 아님).
// 다른 Function들이 import 해서 씀:  import { getRecords } from './_lib/airtable.js';
// 반환 형태는 Airtable 원형과 동일: [{ id, fields }, ...]  (기존 코드 호환)

const DEFAULT_TTL = 60 * 60 * 6; // 6시간(초). 데이터 수정은 최대 6시간 안에 반영, 즉시 반영은 /cache-refresh 사용.

// 환경변수 이름이 셋업마다 다를 수 있어 폴백으로 여러 개 지원.
function getToken(env) {
  return env.AIRTABLE_TOKEN || env.AIRTABLE_API_KEY || env.AIRTABLE_PAT || env.AIRTABLE_KEY;
}
function getBaseId(env) {
  return env.AIRTABLE_BASE_ID || env.BASE_ID || env.AIRTABLE_BASE;
}

// Airtable 테이블 전체 레코드를 페이지네이션으로 모두 가져옴.
async function fetchAll(env, table) {
  const base = getBaseId(env);
  const token = getToken(env);
  if (!base || !token) throw new Error('airtable env 미설정: BASE_ID 또는 TOKEN 없음');

  const root = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
  const out = [];
  let offset = null;
  do {
    const url = root + `?pageSize=100` + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
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
 * @param {object} opts  { ttl, force }
 */
export async function getRecords(env, table, opts = {}) {
  const ttl = opts.ttl || DEFAULT_TTL;
  const force = !!opts.force;
  const key = `at:${table}`;

  if (env.CACHE && !force) {
    try {
      const cached = await env.CACHE.get(key, 'json');
      if (cached && Array.isArray(cached)) return cached;
    } catch (_) { /* 캐시 읽기 실패 시 그냥 원본 페치로 */ }
  }

  const records = await fetchAll(env, table);

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
