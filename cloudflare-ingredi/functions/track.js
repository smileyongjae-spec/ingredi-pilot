// functions/track.js  v1.0 (2026-10-13)
// 자체 방문·이벤트 기록 → Airtable "세션로그" (3일치만 보관, ops-collect가 일별 집계 후 지움)
// 클라이언트: /t.js 가 sendBeacon으로 보냄. 본문은 text/plain JSON.
//   { e: 'pv'|'act'|<이벤트명>, sid, vid, src, path, v(숫자: act=활성 초) }
// 응답은 즉시 204, Airtable 쓰기는 waitUntil.

import { atCreate, T } from './_lib/ops.js';

const ALLOWED = /^[a-z0-9_]{2,40}$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return new Response(null, { status: 204 });
    const b = JSON.parse(raw || '{}');
    const e = String(b.e || '');
    if (!ALLOWED.test(e)) return new Response(null, { status: 204 });
    // 봇·미리보기 거르기: UA에 bot/crawler/facebookexternalhit 등
    const ua = request.headers.get('user-agent') || '';
    if (/bot|crawler|spider|facebookexternalhit|Headless/i.test(ua)) return new Response(null, { status: 204 });

    const fields = {
      이벤트: e,
      sid: String(b.sid || '').slice(0, 24),
      vid: String(b.vid || '').slice(0, 24),
      src: String(b.src || '').slice(0, 40),
      경로: String(b.path || '').slice(0, 120),
    };
    const v = Number(b.v);
    if (Number.isFinite(v) && v >= 0 && v < 86400) fields['값'] = Math.round(v);
    context.waitUntil(atCreate(env, T.evlog, [fields]).catch(() => {}));
  } catch (_) {}
  return new Response(null, { status: 204 });
}
