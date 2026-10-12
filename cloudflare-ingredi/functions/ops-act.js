// functions/ops-act.js  v1.0 (2026-10-13)
// Airtable "광고_실행요청"의 대기 행을 읽어 Meta API로 실행한다. GitHub Actions가 05:40·매시 호출.
//   GET /ops-act?key=<OPS_SECRET>[&dry=1]
// 실행 조건 (코드로 강제 — 규칙 문서 6-1과 같은 한도):
//   - 구분=자율 이고 유형이 광고끄기/예산이동 → 한도 안에서만 실행
//   - 그 밖의 모든 요청 → 승인 체크가 있어야 실행
//   - 자율 예산이동: 1건 ≤ ₩10,000, 같은 날(KST) 자율 이동 합계 ≤ ₩10,000
//   - 자율 광고끄기: 하루 1건, 끈 뒤 캠페인 활성 광고 2개 이상 남아야 함
//   - 예산이동 공통: 주는 세트의 남은 예산(기간예산-지출-이동액) ≥ 남은 일수 × ₩1,400 (Meta 최소)
// 결과는 같은 행의 상태·결과·실행시각에 기록.

import { json, checkSecret, kstDate, T, atList, atUpdate, meta, META_ACT } from './_lib/ops.js';

const AUTO_MOVE_CAP = 10000;
const MIN_DAILY = 1400;

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (!checkSecret(env, u.searchParams.get('key'))) return json({ ok: false, error: 'forbidden' }, 403);
  const dry = u.searchParams.get('dry') === '1';
  const today = kstDate(0);

  const all = await atList(env, T.req, null);
  const pending = all.filter((r) => (r.fields['상태'] || '대기') === '대기');
  const doneToday = all.filter((r) => r.fields['상태'] === '실행됨' && String(r.fields['실행시각'] || '').startsWith(today));
  let autoMoved = doneToday.filter((r) => r.fields['구분'] === '자율' && r.fields['유형'] === '예산이동')
    .reduce((s, r) => s + Number(r.fields['금액'] || 0), 0);
  let autoPaused = doneToday.filter((r) => r.fields['구분'] === '자율' && r.fields['유형'] === '광고끄기').length;

  const results = [];
  for (const r of pending) {
    const f = r.fields;
    const type = f['유형'];
    const auto = f['구분'] === '자율';
    const approved = !!f['승인'];
    let state = '대기', note = '';
    try {
      if (!auto && !approved) { results.push({ id: r.id, skip: '승인 대기' }); continue; }
      if (auto && !['광고끄기', '예산이동'].includes(type)) throw new Error('자율 실행이 허용되지 않은 유형');

      if (type === '광고끄기' || type === '광고켜기') {
        const adId = String(f['대상_ad_id'] || '').trim();
        if (!/^\d{6,}$/.test(adId)) throw new Error('대상_ad_id 없음');
        if (type === '광고끄기' && auto) {
          if (autoPaused >= 1) throw new Error('자율 광고끄기는 하루 1건까지');
          const ads = await meta(env, 'GET', `${META_ACT}/ads`, { fields: 'id,effective_status', limit: 200 });
          const active = (ads.data || []).filter((a) => a.effective_status === 'ACTIVE' && a.id !== adId);
          if (active.length < 2) throw new Error(`끄면 활성 광고가 ${active.length}개만 남음 → 승인 필요`);
        }
        if (!dry) await meta(env, 'POST', adId, { status: type === '광고끄기' ? 'PAUSED' : 'ACTIVE' });
        if (type === '광고끄기' && auto) autoPaused++;
        note = `${adId} → ${type === '광고끄기' ? 'PAUSED' : 'ACTIVE'}`;
      } else if (type === '예산이동') {
        const from = String(f['보내는_adset'] || '').trim(), to = String(f['받는_adset'] || '').trim();
        const amt = Math.round(Number(f['금액'] || 0));
        if (!/^\d{6,}$/.test(from) || !/^\d{6,}$/.test(to) || from === to) throw new Error('세트 ID 확인 필요');
        if (!(amt > 0)) throw new Error('금액 확인 필요');
        if (auto && amt > AUTO_MOVE_CAP) throw new Error(`자율 이동은 ₩${AUTO_MOVE_CAP.toLocaleString()} 이하`);
        if (auto && autoMoved + amt > AUTO_MOVE_CAP) throw new Error(`오늘 자율 이동 합계가 ₩${AUTO_MOVE_CAP.toLocaleString()}를 넘음 (이미 ₩${autoMoved.toLocaleString()})`);
        const [a, b] = await Promise.all([
          meta(env, 'GET', from, { fields: 'name,lifetime_budget,end_time' }),
          meta(env, 'GET', to, { fields: 'name,lifetime_budget,end_time' }),
        ]);
        if (!a.lifetime_budget || !b.lifetime_budget) throw new Error('기간예산 세트만 지원');
        const spentRes = await meta(env, 'GET', `${from}/insights`, { date_preset: 'maximum', fields: 'spend' });
        const spent = Math.round(Number((spentRes.data && spentRes.data[0] && spentRes.data[0].spend) || 0));
        const daysLeft = Math.max(1, Math.ceil((new Date(a.end_time) - Date.now()) / 86400e3));
        const remainAfter = Number(a.lifetime_budget) - spent - amt;
        if (remainAfter < daysLeft * MIN_DAILY) throw new Error(`보내는 세트 남은 예산 부족 (이동 후 ₩${remainAfter.toLocaleString()} < ${daysLeft}일×₩${MIN_DAILY})`);
        if (!dry) {
          await meta(env, 'POST', from, { lifetime_budget: Number(a.lifetime_budget) - amt });
          await meta(env, 'POST', to, { lifetime_budget: Number(b.lifetime_budget) + amt });
        }
        if (auto) autoMoved += amt;
        note = `${a.name} ₩${Number(a.lifetime_budget).toLocaleString()}→₩${(Number(a.lifetime_budget) - amt).toLocaleString()} / ${b.name} ₩${Number(b.lifetime_budget).toLocaleString()}→₩${(Number(b.lifetime_budget) + amt).toLocaleString()}`;
      } else {
        throw new Error('지원하지 않는 유형: ' + type + ' (수동 처리)');
      }
      state = '실행됨';
    } catch (e) {
      state = auto && /승인 필요|하루 1건|합계|이하/.test(e.message) ? '승인필요로전환' : '실패';
      note = e.message;
    }
    results.push({ id: r.id, type, state, note });
    if (!dry) {
      const fields = { 결과: note, 실행시각: new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) };
      if (state === '승인필요로전환') { fields['구분'] = '승인필요'; fields['상태'] = '대기'; }
      else fields['상태'] = state;
      await atUpdate(env, T.req, [{ id: r.id, fields }]);
    }
  }
  return json({ ok: true, dry, today, autoMoved, autoPaused, results });
}
