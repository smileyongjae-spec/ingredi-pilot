// functions/feedback.js
// 고객 피드백 수신 엔드포인트.  POST /feedback
// 요청 body(JSON): { 내용: string, 화면?: string, 카테고리?: string }
// Airtable '피드백' 테이블에 한 행 생성하고 { ok: true } 반환.
import { createRecord } from './_lib/airtable.js';

const TABLE = '피드백';
const MAX_LEN = 2000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  const 내용 = (body && typeof body.내용 === 'string') ? body.내용.trim() : '';
  if (!내용) return json({ ok: false, error: '내용이 비어 있습니다' }, 400);

  const fields = { 내용: 내용.slice(0, MAX_LEN) };
  if (body.화면 && typeof body.화면 === 'string') fields.화면 = body.화면.slice(0, 100);
  if (body.카테고리 && typeof body.카테고리 === 'string') fields.카테고리 = body.카테고리.slice(0, 100);

  try {
    const rec = await createRecord(env, TABLE, fields);
    return json({ ok: true, id: rec.id });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}
