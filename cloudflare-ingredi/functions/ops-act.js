// functions/ops-act.js  v1.1 (2026-10-26) — [v1.1] 유형 '광고생성'(승인 필요): 본보기 광고의 페이지·인스타 계정·개선 기능 설정(degrees_of_freedom_spec)을 복사해
//   새 이미지/영상 광고를 받는_adset에 만든다. 소재_JSON = {name, image_url | video_url+thumb_url, message, title, link}.
//   영상은 업로드 후 처리 완료까지 상태 '대기'로 두고 다음 실행에서 이어 간다(결과 칸에 video_id 기록).
// v1.0 (2026-10-13)
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

export async function onRequestGet(ctx) {
  try { return await run(ctx); } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
}

async function run({ request, env }) {
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
      } else if (type === '광고생성') {
        if (auto) throw new Error('광고생성은 승인 필요');
        const r2 = await createAd(env, f, dry);
        note = r2.note;
        if (r2.pending) { results.push({ id: r.id, type, state: '대기', note });
          if (!dry) await atUpdate(env, T.req, [{ id: r.id, fields: { 결과: note } }]);
          continue; }
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

// ───────── 광고생성 (v1.1) ─────────
function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function createAd(env, f, dry) {
  let spec;
  try { spec = JSON.parse(f['소재_JSON'] || '{}'); } catch (e) { throw new Error('소재_JSON 형식 오류'); }
  const tmpl = String(f['대상_ad_id'] || '').trim(), adset = String(f['받는_adset'] || '').trim();
  if (!/^\d{6,}$/.test(tmpl) || !/^\d{6,}$/.test(adset)) throw new Error('대상_ad_id(본보기 광고)·받는_adset 필요');
  for (const k of ['name', 'message', 'title', 'link']) if (!spec[k]) throw new Error('소재_JSON에 ' + k + ' 없음');
  if (!spec.image_url && !(spec.video_url && spec.thumb_url)) throw new Error('image_url 또는 video_url+thumb_url 필요');

  // 같은 이름 광고가 이미 있으면 다시 만들지 않는다(중복 방지)
  const ex = await meta(env, 'GET', `${adset}/ads`, { fields: 'id,name', limit: 100 });
  const dup = (ex.data || []).find((a) => a.name === spec.name);
  if (dup) return { note: `이미 있음: ${spec.name} (ad ${dup.id})` };

  const t = await meta(env, 'GET', tmpl, { fields: 'creative{id}' });
  const cr = await meta(env, 'GET', t.creative.id, { fields: 'object_story_spec,degrees_of_freedom_spec' });
  const oss = cr.object_story_spec || {};
  if (!oss.page_id) throw new Error('본보기 광고에서 page_id를 찾지 못함');
  if (!cr.degrees_of_freedom_spec) throw new Error('본보기 광고에 개선 기능 설정(degrees_of_freedom_spec)이 없음 → 수동 확인');
  const base = { page_id: oss.page_id };
  if (oss.instagram_user_id) base.instagram_user_id = oss.instagram_user_id;
  if (oss.instagram_actor_id) base.instagram_actor_id = oss.instagram_actor_id;
  const tc = (oss.link_data && oss.link_data.call_to_action) || (oss.video_data && oss.video_data.call_to_action) || {};
  const cta = { type: tc.type || 'LEARN_MORE', value: { link: spec.link } };

  let story;
  if (spec.video_url) {
    const prev = String(f['결과'] || '').match(/video_id=(\d+)/);
    let vid = prev && prev[1];
    if (!vid) {
      if (dry) return { note: 'dry: 영상 업로드 예정', pending: true };
      const up = await meta(env, 'POST', `${META_ACT}/advideos`, { file_url: spec.video_url, name: spec.name });
      vid = up.id;
    }
    const st = await meta(env, 'GET', vid, { fields: 'status' });
    const vs = st.status && st.status.video_status;
    if (vs === 'error') throw new Error(`영상 처리 오류 (video_id=${vid})`);
    if (vs !== 'ready') return { note: `video_id=${vid} 처리 중(${vs || '?'}) — 다음 실행에서 광고 생성`, pending: true };
    story = { ...base, video_data: { video_id: vid, image_url: spec.thumb_url, message: spec.message, title: spec.title, call_to_action: cta } };
  } else {
    const res = await fetch(spec.image_url);
    if (!res.ok) throw new Error('이미지 받기 실패 ' + res.status);
    const buf = await res.arrayBuffer();
    if (dry) return { note: `dry: 이미지 ${buf.byteLength}B 확인, 광고 생성 예정` };
    const up = await meta(env, 'POST', `${META_ACT}/adimages`, { bytes: b64(buf) });
    const img = Object.values(up.images || {})[0];
    if (!img || !img.hash) throw new Error('이미지 업로드 결과에 hash 없음');
    story = { ...base, link_data: { image_hash: img.hash, link: spec.link, message: spec.message, name: spec.title, call_to_action: cta } };
  }
  if (dry) return { note: 'dry: 광고 생성 예정' };
  const c = await meta(env, 'POST', `${META_ACT}/adcreatives`, { name: spec.name, object_story_spec: story, degrees_of_freedom_spec: cr.degrees_of_freedom_spec });
  const ad = await meta(env, 'POST', `${META_ACT}/ads`, { name: spec.name, adset_id: adset, creative: { creative_id: c.id }, status: 'ACTIVE' });
  return { note: `광고 생성: ${spec.name} ad ${ad.id} · creative ${c.id} (세트 ${adset}, 게재 상태는 Meta 검토 후 ACTIVE)` };
}
