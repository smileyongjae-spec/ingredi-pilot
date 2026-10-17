// functions/_middleware.js  v1.1  (2026-10-18)
// v1.1: 진단 헤더 x-site-stats (applied / skip:이유) — /app 기준일 미반영 원인 확인용(Oliver 승인 10/18)
// 사이트 설명 숫자 자동 반영(_lib/site-stats.js). 아래 6개 주소의 응답만 손대고, 나머지 요청(API·상담 스트리밍 등)은 그대로 통과.
// KV(site_stats_v1)가 비었거나 오류가 나면 정적 파일 그대로 보낸다.

import { applyHtml, applyLlms, readSiteStats } from './_lib/site-stats.js';

const PATHS = new Set(['/', '/app', '/about', '/consult', '/sports', '/llms.txt']);
let memo = null, memoAt = 0;

export async function onRequest(ctx) {
  const { request, env } = ctx;
  let path = '';
  try { path = new URL(request.url).pathname; } catch (_) {}
  if (request.method !== 'GET' || !PATHS.has(path)) return ctx.next();

  // 브라우저가 옛 숫자를 304로 재사용하지 않게 조건부 요청 헤더를 뺀다
  let req = request;
  try {
    const h = new Headers(request.headers);
    h.delete('if-none-match'); h.delete('if-modified-since');
    req = new Request(request, { headers: h });
  } catch (_) {}
  const res = await ctx.next(req);
  const tag = (r, v) => { try { const h = new Headers(r.headers); h.set('x-site-stats', v); return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h }); } catch (_) { return r; } };
  if (res.status !== 200) return tag(res, 'skip:status-' + res.status);

  let saved = null;
  try {
    const now = Date.now();
    if (!memo || now - memoAt > 300000) { memo = await readSiteStats(env); memoAt = now; }
    saved = memo;
  } catch (_) { saved = null; }
  if (!saved || !saved.data || !saved.asof) return tag(res, 'skip:no-kv');

  const ct = res.headers.get('content-type') || '';
  if (!(ct.includes('text/html') || (path === '/llms.txt' && ct.includes('text/plain')))) return tag(res, 'skip:ct-' + ct);

  const body = await res.text();
  let out = body;
  let state = 'applied ' + saved.asof;
  try { out = path === '/llms.txt' ? applyLlms(body, saved) : applyHtml(body, saved); } catch (e) { out = body; state = 'skip:error ' + String(e && e.message || e).slice(0, 80); }
  if (out === body && state.startsWith('applied')) state = 'unchanged ' + saved.asof + ' len' + body.length;
  const headers = new Headers(res.headers);
  headers.delete('content-length'); headers.delete('etag');
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.set('x-site-stats', state);
  return new Response(out, { status: 200, headers });
}
