// functions/_lib/ops.js  v1.0 (2026-10-13)
// 그로스 운영 자동화 공용 헬퍼 — ops-collect(수집)·ops-act(실행)·ev(자체 이벤트)가 함께 쓴다.
// 노트북 Chrome 없이 API로 수집·실행하기 위한 것. 키는 모두 Cloudflare 환경변수에만 둔다.
//   META_TOKEN      Meta 시스템 사용자 토큰 (ads_read, ads_management)
//   CLARITY_TOKEN   Clarity Data Export API 토큰
//   COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY  (기존 딥링크용 키 재사용)
//   OPS_SECRET      ops-collect·ops-act 호출 비밀값
//   AIRTABLE_TOKEN  (기존)

import { buildAuth } from './coupang.js';

export const META_ACT = 'act_1587374745713907';
export const META_VER = 'v23.0';
export const BASE_ID_DEFAULT = 'app3wwrYkvQHXsYUn';

export const T = {
  daily: '광고_일별성과',
  creative: '광고_소재',
  site: '일별_사이트지표',
  evlog: '세션로그',
  req: '광고_실행요청',
};

/* ───────── 공통 ───────── */
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 비밀값 비교 (길이·내용, 짧은 시간차 노출 최소화)
export function checkSecret(env, given) {
  const want = String(env.OPS_SECRET || '');
  const got = String(given || '');
  if (!want || want.length < 16 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// KST 날짜 문자열
export function kstDate(offsetDays = 0, from = Date.now()) {
  const d = new Date(from + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}

/* ───────── Airtable REST ───────── */
function atToken(env) {
  return env.AIRTABLE_TOKEN || env.AIRTABLE_API_KEY || env.AIRTABLE_PAT || env.AIRTABLE_KEY;
}
function atBase(env) {
  return env.AIRTABLE_BASE_ID || BASE_ID_DEFAULT;
}
async function at(env, method, table, path = '', body) {
  const url = 'https://api.airtable.com/v0/' + atBase(env) + '/' + encodeURIComponent(table) + path;
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + atToken(env), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`Airtable ${method} ${table} ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// 전체 목록 (filterByFormula 선택)
export async function atList(env, table, formula, fields) {
  const out = [];
  let offset;
  do {
    const q = new URLSearchParams();
    q.set('pageSize', '100');
    if (formula) q.set('filterByFormula', formula);
    if (fields) fields.forEach((f) => q.append('fields[]', f));
    if (offset) q.set('offset', offset);
    const data = await at(env, 'GET', table, '?' + q.toString());
    out.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return out;
}

// 10개씩 나눠 처리
function chunks(arr, n = 10) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

export async function atUpsert(env, table, mergeOn, rows) {
  const done = [];
  for (const c of chunks(rows)) {
    const data = await at(env, 'PATCH', table, '', {
      performUpsert: { fieldsToMergeOn: mergeOn },
      records: c.map((fields) => ({ fields })),
      typecast: true,
    });
    done.push(...(data.records || []));
  }
  return done;
}

export async function atCreate(env, table, rows) {
  const done = [];
  for (const c of chunks(rows)) {
    const data = await at(env, 'POST', table, '', { records: c.map((fields) => ({ fields })), typecast: true });
    done.push(...(data.records || []));
  }
  return done;
}

export async function atUpdate(env, table, rows /* [{id, fields}] */) {
  for (const c of chunks(rows)) await at(env, 'PATCH', table, '', { records: c, typecast: true });
}

export async function atDelete(env, table, ids) {
  let n = 0;
  for (const c of chunks(ids)) {
    const q = c.map((id) => 'records[]=' + encodeURIComponent(id)).join('&');
    await at(env, 'DELETE', table, '?' + q);
    n += c.length;
  }
  return n;
}

/* ───────── Meta Marketing API ───────── */
export async function meta(env, method, path, params = {}) {
  if (!env.META_TOKEN) throw new Error('META_TOKEN 미설정');
  const url = new URL(`https://graph.facebook.com/${env.META_API_VERSION || META_VER}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (method === 'GET') url.searchParams.set(k, val); else body.set(k, val);
  }
  // 토큰은 헤더로 보낸다(URL·로그에 남지 않게)
  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: 'Bearer ' + env.META_TOKEN, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: method === 'GET' ? undefined : body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Meta ${method} ${path} ${res.status}: ${e.message || ''} (${e.type || ''} ${e.code || ''})`);
  }
  return data;
}

export async function metaAll(env, path, params) {
  const out = [];
  let data = await meta(env, 'GET', path, { limit: 200, ...params });
  out.push(...(data.data || []));
  let guard = 0;
  while (data.paging && data.paging.next && guard++ < 20) {
    const res = await fetch(data.paging.next, { headers: { Authorization: 'Bearer ' + env.META_TOKEN } });
    data = await res.json();
    out.push(...(data.data || []));
  }
  return out;
}

// 토큰 정보(만료일) — 사용자 토큰은 자기 자신으로 debug_token 조회 가능
export async function metaTokenInfo(env) {
  const d = await meta(env, 'GET', 'debug_token', { input_token: env.META_TOKEN });
  return d.data || {};
}

// 하루치 광고별 성과
export async function metaAdInsights(env, date) {
  const rows = await metaAll(env, `${META_ACT}/insights`, {
    level: 'ad',
    time_range: { since: date, until: date },
    fields: 'ad_id,ad_name,adset_id,adset_name,impressions,reach,spend,inline_link_clicks,actions',
  });
  return rows.map((r) => {
    const lpv = (r.actions || []).find((a) => a.action_type === 'landing_page_view');
    return {
      ad_id: r.ad_id,
      ad_name: r.ad_name,
      adset_id: r.adset_id,
      adset_name: r.adset_name,
      impressions: Number(r.impressions || 0),
      reach: Number(r.reach || 0),
      spend: Math.round(Number(r.spend || 0)),
      clicks: Number(r.inline_link_clicks || 0),
      lpv: lpv ? Number(lpv.value || 0) : 0,
    };
  });
}

/* ───────── 쿠팡 파트너스 리포트 ───────── */
const CP_HOST = 'https://api-gateway.coupang.com';
const CP_REPORT = '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/';

export async function coupangReport(env, kind /* clicks|orders|cancels|commission */, date) {
  const ymd = date.replace(/-/g, '');
  const query = `startDate=${ymd}&endDate=${ymd}`;
  const path = CP_REPORT + kind;
  const auth = await buildAuth('GET', path, query, env.COUPANG_ACCESS_KEY, env.COUPANG_SECRET_KEY);
  const res = await fetch(`${CP_HOST}${path}?${query}`, { headers: { Authorization: auth } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`Coupang ${kind} ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

// 응답 모양을 모를 때를 대비해, data 배열의 숫자 필드를 이름별로 합산
export function sumNumeric(data) {
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const sum = {};
  for (const row of arr) {
    for (const [k, v] of Object.entries(row || {})) {
      if (typeof v === 'number') sum[k] = (sum[k] || 0) + v;
    }
  }
  return { rows: arr.length, sum };
}

/* ───────── Clarity Data Export ───────── */
export async function clarityExport(env, dims = []) {
  if (!env.CLARITY_TOKEN) throw new Error('CLARITY_TOKEN 미설정');
  const q = new URLSearchParams({ numOfDays: '1' });
  dims.slice(0, 3).forEach((d, i) => q.set('dimension' + (i + 1), d));
  const res = await fetch('https://www.clarity.ms/export-data/api/v1/project-live-insights?' + q, {
    headers: { Authorization: 'Bearer ' + env.CLARITY_TOKEN, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Clarity ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
