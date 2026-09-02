// functions/_lib/airtable.js  (v6 — SWR + 비동기 캐시 쓰기)
// 공용 Airtable 페치 + KV 캐시 헬퍼.
// _lib 폴더는 밑줄(_)로 시작해서 Cloudflare 라우팅에서 제외됨(엔드포인트 아님).
// 다른 Function들이 import 해서 씀:  import { getRecords } from './_lib/airtable.js';
// 반환 형태는 Airtable 원형과 동일: [{ id, fields }, ...]  (기존 코드 호환)
//
// v3 (2026-07 장애): FAQ_전체상품 5,001행=51페이지가 하위요청 한도(50) 단독 초과 → 상담 장애.
//   해결 1) TABLE_FILTER: 분류 완료 행만 서버측(filterByFormula)에서 받아옴.
//   해결 2) TABLE_FIELDS: 서비스가 읽는 컬럼만 요청해 행당 페이로드 축소.
//
// v4 (제품명 직접 조회): opts.variant 로 캐시 키 분리(같은 테이블 다른 필드셋 충돌 방지).
//
// v5 (첫 화면 지연 진단): opts.timing 계측 훅.
//
// v6 변경 배경 (2026-09 실측):
//   /changelog 가 16초 걸린 사례를 추적한 결과, 코드 버그가 아니라
//   "Airtable 응답이 가끔 크게 튄다 + TTL이 짧아 미스가 잦다"의 결합이었다.
//   (개선소식 테이블은 1행. 페이지네이션·데이터량 문제가 아님이 실측으로 확인됨)
//   → 근본 방어는 "사용자가 Airtable을 기다리지 않게 하는 것" 하나뿐이다.
//
//   [SWR] 캐시를 소프트 만료(ttl)와 하드 만료(ttl+STALE_WINDOW)로 이중화한다.
//         소프트 만료가 지나도 옛 값을 즉시 반환하고, 갱신은 백그라운드에서 한다.
//         → 만료 순간의 첫 사용자가 미스 비용을 지불하는 구조가 사라진다.
//         → Airtable이 느리거나 잠시 죽어도 화면은 옛 데이터로 계속 동작한다.
//   [비동기 쓰기] KV put 을 waitUntil 로 빼서 응답 경로에서 제거(실측 ~1초 단축).
//   [sort/maxRecords] 서버측 정렬·개수 제한을 Airtable에 위임할 수 있게 함.
//
//   *** 호환성 ***
//   - opts.ctx 를 안 넘기는 기존 호출(counsel2 등)은 v5와 동일하게 동작한다.
//     (SWR·비동기 쓰기는 waitUntil이 필요하므로 ctx가 있을 때만 켜진다)
//   - 캐시에 남아 있는 v5 이전 형식(순수 배열)도 그대로 읽는다.
//   - 캐시 키는 바꾸지 않았다 → 배포 시 전면 무효화 없음.

const DEFAULT_TTL = 60 * 60 * 6;       // 소프트 만료 6시간. 즉시 반영은 /cache-refresh.
const STALE_WINDOW = 60 * 60 * 24 * 7; // 소프트 만료 후 7일간은 "옛 값이라도 준다"

const TABLE_FIELDS = {
  'FAQ_전체상품': [
    'question', 'answer', 'keywords', '소분류',
    '임상근거', '제품카테고리', '건강도메인', '검수상태'
  ],
  // [v6] 개선소식은 화면에 쓰는 4개 컬럼만. 지금은 1행이지만 늘어나도 안전하게.
  '개선소식': ['날짜', '제목', '내용', '공개여부']
};

const TABLE_FILTER = {
  'FAQ_전체상품': "AND({제품카테고리}!='',{건강도메인}!='')",
  'knowledge':    "AND({제품카테고리}!='',{건강도메인}!='')",
  // [v6] 비공개 글은 애초에 받아오지 않는다
  '개선소식':      "{공개여부}"
};

function getToken(env) {
  return env.AIRTABLE_TOKEN || env.AIRTABLE_API_KEY || env.AIRTABLE_PAT || env.AIRTABLE_KEY;
}
function getBaseId(env) {
  return env.AIRTABLE_BASE_ID || env.BASE_ID || env.AIRTABLE_BASE;
}

// 계측 기록 헬퍼. t가 없으면 아무것도 하지 않는다.
function mark(t, entry) { if (t) t.push(entry); }

async function fetchAll(env, table, fields, filter, t, sort, maxRecords) {
  const base = getBaseId(env);
  const token = getToken(env);
  if (!base || !token) throw new Error('airtable env 미설정: BASE_ID 또는 TOKEN 없음');

  const root = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
  const fieldsQS = (fields && fields.length)
    ? fields.map(f => `&fields%5B%5D=${encodeURIComponent(f)}`).join('')
    : '';
  const filterQS = filter ? `&filterByFormula=${encodeURIComponent(filter)}` : '';
  // [v6] 서버측 정렬: [{ field: '날짜', direction: 'desc' }, ...]
  const sortQS = (sort && sort.length)
    ? sort.map((s, i) =>
        `&sort%5B${i}%5D%5Bfield%5D=${encodeURIComponent(s.field)}` +
        `&sort%5B${i}%5D%5Bdirection%5D=${encodeURIComponent(s.direction || 'asc')}`
      ).join('')
    : '';
  const maxQS = (maxRecords > 0) ? `&maxRecords=${maxRecords}` : '';
  const pageSize = (maxRecords > 0 && maxRecords < 100) ? maxRecords : 100;

  const out = [];
  let offset = null;
  let page = 0;
  do {
    page++;
    const url = root + `?pageSize=${pageSize}` + fieldsQS + filterQS + sortQS + maxQS +
                (offset ? `&offset=${encodeURIComponent(offset)}` : '');

    const tFetch = Date.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const msFetch = Date.now() - tFetch;

    if (!res.ok) {
      const body = await res.text();
      // 429(rate limit)·5xx 를 계측에 남긴다
      mark(t, { step: 'airtable.page', table, page, ms: msFetch, status: res.status, error: true });
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

// 캐시에 담는 형태: { v: records, t: 저장시각(ms) }
// v5 이전에 저장된 순수 배열도 읽을 수 있게 정규화한다(savedAt=0 → 항상 stale 취급).
function unwrap(cached) {
  if (!cached) return null;
  if (Array.isArray(cached)) return { records: cached, savedAt: 0 };
  if (cached && Array.isArray(cached.v)) return { records: cached.v, savedAt: Number(cached.t) || 0 };
  return null;
}

/**
 * 테이블 레코드를 캐시 우선으로 반환.
 * @param {object} env  Pages Functions env
 * @param {string} table  Airtable 테이블명
 * @param {object} opts  { ttl, force, fields, filter, variant, timing, ctx, sort, maxRecords }
 *   - ttl:        소프트 만료(초). 지나면 백그라운드 갱신하되 옛 값을 즉시 반환.
 *   - variant:    같은 테이블을 다른 필드셋으로 읽을 때 캐시를 분리하는 태그(예: 'idx').
 *   - timing:     배열을 넘기면 단계별 계측을 push 한다(진단용).
 *   - ctx:        Pages Functions의 context. 넘기면 SWR·비동기 캐시 쓰기가 켜진다.
 *   - sort:       [{ field, direction }] 서버측 정렬.
 *   - maxRecords: 서버측 개수 제한.
 */
export async function getRecords(env, table, opts = {}) {
  const t = opts.timing || null;
  const T0 = Date.now();

  const ttl = opts.ttl || DEFAULT_TTL;
  const force = !!opts.force;
  const fields = opts.fields || TABLE_FIELDS[table] || null;
  const filter = opts.filter !== undefined ? opts.filter : (TABLE_FILTER[table] || null);
  const sort = opts.sort || null;
  const maxRecords = opts.maxRecords || 0;
  const key = opts.variant ? `at:${table}:${opts.variant}` : `at:${table}`;
  const ctx = opts.ctx || null;
  const canDefer = !!(ctx && typeof ctx.waitUntil === 'function');

  // 원본 페치 + 캐시 저장을 한 덩어리로 (백그라운드 갱신에서도 재사용)
  async function loadAndCache(timing) {
    const records = await fetchAll(env, table, fields, filter, timing, sort, maxRecords);
    if (env.CACHE) {
      const body = JSON.stringify({ v: records, t: Date.now() });
      mark(timing, { step: 'payload', table, records: records.length, bytes: body.length, ttl });
      const p0 = Date.now();
      const put = env.CACHE
        .put(key, body, { expirationTtl: ttl + STALE_WINDOW })
        .then(function () { mark(timing, { step: 'kv.put', table, key, ms: Date.now() - p0, ok: true }); })
        .catch(function () { mark(timing, { step: 'kv.put', table, key, ms: Date.now() - p0, ok: false }); });
      // [v6] ctx가 있으면 쓰기를 응답 경로에서 뺀다
      if (canDefer) ctx.waitUntil(put); else await put;
    }
    return records;
  }

  if (env.CACHE && !force) {
    const c0 = Date.now();
    let raw = null;
    try {
      raw = await env.CACHE.get(key, 'json');
    } catch (_) { /* 캐시 읽기 실패 시 그냥 원본 페치로 */ }
    const msGet = Date.now() - c0;
    const hit = unwrap(raw);

    if (hit) {
      const ageSec = (Date.now() - hit.savedAt) / 1000;
      const fresh = hit.savedAt > 0 && ageSec < ttl;

      mark(t, {
        step: 'kv.get', table, key, ms: msGet, hit: true,
        records: hit.records.length, ageSec: Math.round(ageSec), fresh
      });

      if (fresh) {
        mark(t, { step: 'getRecords.total', table, ms: Date.now() - T0, source: 'cache' });
        return hit.records;
      }

      // ── SWR: 소프트 만료를 넘겼지만 옛 값이 남아 있다 ──
      if (canDefer) {
        // 옛 값을 즉시 주고, 갱신은 응답 이후 백그라운드에서. 사용자 대기 0.
        ctx.waitUntil(loadAndCache(null).catch(function () {}));
        mark(t, { step: 'getRecords.total', table, ms: Date.now() - T0, source: 'cache-stale-swr' });
        return hit.records;
      }
      // ctx가 없으면(구형 호출) 아래로 내려가 기존과 동일하게 동기 재로드
    } else {
      mark(t, { step: 'kv.get', table, key, ms: msGet, hit: false });
    }
  }

  const records = await loadAndCache(t);
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
