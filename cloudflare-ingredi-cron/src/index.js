// ingredi-cron v1.0 (2026-10-15)
// GitHub 예약 실행이 자주 빠져서, 수집기(ops-collect)·실행기(ops-act)를 Cloudflare Cron Trigger로 깨운다.
// 크론은 10분마다 한 번 깨어나고, 한국 시간(KST)을 보고 할 일을 정한다.
//   04:30 · 05:00 · 05:20 · 06:00  → ops-collect (어제 데이터. 같은 날짜는 덮어쓰기, Clarity는 하루 1회만)
//   05:40, 08:10~22:10 매시 10분      → ops-act (광고_실행요청 처리)
// 비밀값 OPS_SECRET은 이 Worker의 secret(wrangler secret)으로만 둔다. 공개 URL 없음(workers_dev=false).

const COLLECT = new Set(['04:30', '05:00', '05:20', '06:00']);

function slotKST(ts) {
  const d = new Date(ts + 9 * 3600e3);
  const h = d.getUTCHours();
  const m = Math.floor(d.getUTCMinutes() / 10) * 10; // 크론이 몇십 초 늦게 깨도 같은 칸으로
  return { h, m, hm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

export function jobFor(ts) {
  const { h, m, hm } = slotKST(ts);
  if (COLLECT.has(hm)) return 'collect';
  if (hm === '05:40' || (m === 10 && h >= 8 && h <= 22)) return 'act';
  return null;
}

async function call(env, job) {
  const path = job === 'collect' ? 'ops-collect' : 'ops-act';
  const url = `https://ingredi.kr/${path}?key=${encodeURIComponent(env.OPS_SECRET)}`;
  const res = await fetch(url, { headers: { 'user-agent': 'ingredi-cron/1.0' } });
  const text = await res.text();
  let ok = false;
  try { ok = !!JSON.parse(text).ok; } catch (_) {}
  // 로그에는 결과 요약만(비밀값 없음)
  console.log(JSON.stringify({ job, http: res.status, ok, head: text.slice(0, 400) }));
  if (!ok) throw new Error(`${job} 실패: HTTP ${res.status}`);
}

export default {
  async scheduled(event, env, ctx) {
    const job = jobFor(event.scheduledTime);
    if (!job) return;
    if (!env.OPS_SECRET) { console.log('OPS_SECRET 미설정'); return; }
    ctx.waitUntil(call(env, job));
  },
};
