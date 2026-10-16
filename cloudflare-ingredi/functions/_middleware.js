// functions/_middleware.js  v1.0  (2026-10-17)
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
  if (res.status !== 200) return res;

  let saved = null;
  try {
    const now = Date.now();
    if (!memo || now - memoAt > 300000) { memo = await readSiteStats(env); memoAt = now; }
    saved = memo;
  } catch (_) { saved = null; }
  if (!saved || !saved.data || !saved.asof) return res;

  const ct = res.headers.get('content-type') || '';
  if (!(ct.includes('text/html') || (path === '/llms.txt' && ct.includes('text/plain')))) return res;

  const body = await res.text();
  let out = body;
  try { out = path === '/llms.txt' ? applyLlms(body, saved) : applyHtml(body, saved); } catch (_) { out = body; }
  const headers = new Headers(res.headers);
  headers.delete('content-length'); headers.delete('etag');
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return new Response(out, { status: 200, headers });
}
