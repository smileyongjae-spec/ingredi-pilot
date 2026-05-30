<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ingredi · 내 영양제 조합 점검</title>
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
  <style>
    :root {
      --green-deep: #1B3A2E; --green-primary: #2D5F3F; --green-mid: #4A7C5A;
      --green-light: #E8F1EA; --green-bg: #F5F9F6;
      --paper: #FAF8F3; --ink: #1A1F1B; --ink-soft: #4F564E;
      --ink-faint: #8B928A; --line: #D9DDD7; --line-soft: #ECEFEA;
      --blue: #2563EB; --blue-light: #EFF6FF;
      --warn-bg: #FEF3F2; --warn: #C9533D; --warn-deep: #991B1B;
      --caution-bg: #FFF7ED; --caution: #B07142;
      --safe-bg: #F0FDF4; --safe: #16A34A;
      --shadow-sm: 0 1px 2px rgba(27,58,46,0.06);
      --radius-sm: 8px; --radius-md: 14px; --radius-lg: 20px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body {
      font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--paper); color: var(--ink);
      font-size: 14px; line-height: 1.5; letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
    }
    .app { max-width: 480px; margin: 0 auto; min-height: 100vh; background: var(--paper); box-shadow: 0 0 40px rgba(27,58,46,0.05); }

    /* 헤더 */
    .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--line-soft); background: var(--paper); position: sticky; top: 0; z-index: 10; }
    .header-back { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ink-soft); border-radius: var(--radius-sm); text-decoration: none; }
    .header-back:hover { background: var(--green-light); }
    .header-back svg { width: 22px; height: 22px; }
    .header-title { font-size: 16px; font-weight: 700; color: var(--green-deep); }
    .header-spacer { width: 36px; }

    .screen { display: none; padding: 20px; }
    .screen.active { display: block; animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }

    /* ── 입력 화면 ── */
    .intro { background: linear-gradient(135deg, #EAF3DE 0%, white 100%); border: 1.5px solid #97C459; border-radius: var(--radius-md); padding: 16px; margin-bottom: 18px; }
    .intro-eyebrow { font-size: 11px; font-weight: 700; color: #3B6D11; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px; }
    .intro-title { font-size: 18px; font-weight: 800; color: var(--green-deep); letter-spacing: -0.02em; margin-bottom: 4px; }
    .intro-desc { font-size: 12px; color: var(--ink-soft); line-height: 1.5; }

    .section-block { margin-bottom: 22px; }
    .section-label { font-size: 13px; font-weight: 700; color: var(--green-deep); margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    .section-num { background: var(--green-primary); color: white; font-size: 10px; padding: 1px 6px; border-radius: 100px; }

    /* 영양제 체크박스 그리드 */
    .item-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 12px; }
    .item-chip {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: white; border: 1.5px solid var(--line-soft); border-radius: var(--radius-sm);
      cursor: pointer; transition: all 0.15s ease;
    }
    .item-chip:hover { border-color: var(--green-mid); }
    .item-chip.selected { background: var(--green-bg); border-color: var(--green-primary); }
    .item-chip-check {
      width: 18px; height: 18px; border: 2px solid var(--line);
      border-radius: 5px; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; background: white;
    }
    .item-chip.selected .item-chip-check { background: var(--green-primary); border-color: var(--green-primary); }
    .item-chip-check svg { width: 12px; height: 12px; stroke: white; opacity: 0; }
    .item-chip.selected .item-chip-check svg { opacity: 1; }
    .item-chip-label { font-size: 13px; color: var(--ink); font-weight: 500; }

    /* 자유 입력 */
    .free-add-wrap { position: relative; margin-top: 8px; }
    .free-add-input {
      width: 100%; padding: 11px 90px 11px 14px;
      background: white; border: 1.5px solid var(--line); border-radius: var(--radius-sm);
      font-family: inherit; font-size: 13px; color: var(--ink);
    }
    .free-add-input:focus { outline: none; border-color: var(--green-primary); }
    .free-add-input::placeholder { color: var(--ink-faint); }
    .free-add-btn {
      position: absolute; right: 4px; top: 4px; bottom: 4px;
      padding: 0 16px; background: var(--green-primary); color: white;
      border: none; border-radius: 6px; font-family: inherit;
      font-size: 12px; font-weight: 700; cursor: pointer;
    }
    .free-add-btn:hover { background: var(--green-deep); }

    /* 추가된 커스텀 영양제 표시 */
    .custom-items { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .custom-item-tag {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--green-bg); color: var(--green-deep);
      border: 1px solid var(--green-mid); border-radius: 100px;
      padding: 4px 8px 4px 12px; font-size: 12px; font-weight: 600;
    }
    .custom-item-remove {
      width: 16px; height: 16px; background: var(--green-primary);
      color: white; border-radius: 50%; display: flex;
      align-items: center; justify-content: center; cursor: pointer;
      font-size: 11px; font-weight: 700; border: none;
    }

    /* 컨텍스트 질문 (yes/no) */
    .yn-group { display: flex; flex-direction: column; gap: 10px; }
    .yn-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; background: white; border: 1px solid var(--line-soft); border-radius: var(--radius-sm); }
    .yn-row-label { font-size: 13px; font-weight: 600; color: var(--ink); }
    .yn-row-desc { font-size: 11px; color: var(--ink-faint); margin-top: 2px; }
    .yn-buttons { display: flex; gap: 6px; flex-shrink: 0; }
    .yn-btn {
      padding: 6px 14px; font-size: 12px; font-weight: 700;
      background: white; border: 1.5px solid var(--line); color: var(--ink-soft);
      border-radius: 100px; cursor: pointer; font-family: inherit;
      transition: all 0.15s ease;
    }
    .yn-btn:hover { border-color: var(--green-mid); }
    .yn-btn.active { background: var(--green-primary); color: white; border-color: var(--green-primary); }

    /* 약 입력 영역 */
    .med-input-wrap { display: none; margin-top: 8px; padding: 10px 12px; background: var(--paper); border-radius: var(--radius-sm); }
    .med-input-wrap.active { display: block; }
    .med-input { width: 100%; padding: 9px 12px; background: white; border: 1px solid var(--line); border-radius: 6px; font-family: inherit; font-size: 12px; }
    .med-input:focus { outline: none; border-color: var(--green-primary); }
    .med-input-hint { font-size: 11px; color: var(--ink-faint); margin-top: 6px; }

    /* 제출 버튼 */
    .submit-btn {
      width: 100%; padding: 14px; background: var(--green-primary); color: white;
      border: none; border-radius: var(--radius-sm); font-family: inherit;
      font-size: 14px; font-weight: 700; cursor: pointer;
      transition: all 0.15s ease; margin-top: 10px;
    }
    .submit-btn:hover:not(:disabled) { background: var(--green-deep); }
    .submit-btn:disabled { background: var(--line); color: var(--ink-faint); cursor: not-allowed; }

    /* 로딩 */
    .loading-screen { text-align: center; padding: 60px 20px; }
    .loading-spinner { display: inline-block; width: 32px; height: 32px; border: 3px solid var(--line); border-top-color: var(--green-primary); border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { font-size: 13px; color: var(--ink-soft); }

    /* ── 결과 화면 ── */
    .result-header {
      background: linear-gradient(135deg, var(--green-deep) 0%, var(--green-primary) 100%);
      color: white; padding: 18px 20px; margin: -20px -20px 16px;
    }
    .result-header-eyebrow { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; opacity: 0.7; text-transform: uppercase; margin-bottom: 4px; }
    .result-header-title { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 6px; }
    .result-header-items { display: flex; flex-wrap: wrap; gap: 5px; }
    .result-header-tag { font-size: 11px; background: rgba(255,255,255,0.15); padding: 3px 9px; border-radius: 100px; }
    .result-header-tag.med { background: rgba(255,255,255,0.25); }

    /* AI 요약 박스 */
    .ai-summary { background: white; border: 1.5px solid var(--green-mid); border-radius: var(--radius-md); padding: 14px 16px; margin-bottom: 16px; box-shadow: var(--shadow-sm); }
    .ai-summary-header { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 11px; font-weight: 700; color: var(--green-primary); letter-spacing: 0.04em; text-transform: uppercase; }
    .ai-summary-header svg { width: 14px; height: 14px; stroke: var(--green-primary); }
    .ai-summary-text { font-size: 13px; line-height: 1.7; color: var(--ink); white-space: pre-wrap; }

    /* 최고 심각도 배너 */
    .severity-banner { padding: 12px 14px; border-radius: var(--radius-sm); margin-bottom: 14px; display: flex; gap: 10px; align-items: flex-start; }
    .severity-banner.금기 { background: var(--warn-bg); border: 1.5px solid var(--warn); color: var(--warn-deep); }
    .severity-banner.경고 { background: var(--warn-bg); border: 1px solid var(--warn); color: var(--warn); }
    .severity-banner.주의 { background: var(--caution-bg); border: 1px solid var(--caution); color: var(--caution); }
    .severity-banner-icon { flex-shrink: 0; }
    .severity-banner-icon svg { width: 18px; height: 18px; }
    .severity-banner-text { font-size: 12px; line-height: 1.5; }
    .severity-banner-text strong { font-weight: 700; }

    /* 세션 카드 */
    .section { background: white; border: 1px solid var(--line-soft); border-radius: var(--radius-md); padding: 14px; margin-bottom: 12px; box-shadow: var(--shadow-sm); }
    .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .section-title-row { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--green-deep); }
    .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    .section-icon svg { width: 15px; height: 15px; }
    .section-icon.warn { background: var(--warn-bg); } .section-icon.warn svg { stroke: var(--warn); }
    .section-icon.caution { background: var(--caution-bg); } .section-icon.caution svg { stroke: var(--caution); }
    .section-icon.info { background: var(--blue-light); } .section-icon.info svg { stroke: var(--blue); }
    .section-icon.safe { background: var(--safe-bg); } .section-icon.safe svg { stroke: var(--safe); }
    .section-count { font-size: 11px; font-weight: 600; color: var(--ink-faint); background: var(--paper); padding: 2px 8px; border-radius: 100px; }

    .item-list { display: flex; flex-direction: column; gap: 10px; }
    .item-box { padding: 10px 12px; background: var(--paper); border-radius: var(--radius-sm); border-left: 3px solid var(--line); }
    .item-box.금기 { border-left-color: var(--warn-deep); background: var(--warn-bg); }
    .item-box.경고 { border-left-color: var(--warn); background: var(--warn-bg); }
    .item-box.주의 { border-left-color: var(--caution); background: var(--caution-bg); }
    .item-box.안전 { border-left-color: var(--safe); background: var(--safe-bg); }

    .item-pair { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 4px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .item-pair-sep { color: var(--ink-faint); font-weight: 400; }
    .item-badges { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
    .badge-sev { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.02em; }
    .badge-sev.금기 { background: var(--warn-deep); color: white; }
    .badge-sev.경고 { background: var(--warn); color: white; }
    .badge-sev.주의 { background: var(--caution); color: white; }
    .badge-sev.안전 { background: var(--safe); color: white; }
    .badge-ev { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: var(--line-soft); color: var(--ink-soft); }
    .badge-ev.강 { background: var(--green-primary); color: white; }
    .badge-ev.중 { background: var(--green-light); color: var(--green-deep); }

    .item-desc { font-size: 12px; line-height: 1.6; color: var(--ink-soft); margin-bottom: 6px; }
    .item-rec { font-size: 11px; line-height: 1.5; color: var(--ink); padding-top: 6px; border-top: 0.5px solid var(--line-soft); }
    .item-rec strong { color: var(--green-deep); font-weight: 700; }

    .empty-section { font-size: 12px; color: var(--ink-faint); text-align: center; padding: 16px; }

    .restart-btn { width: 100%; margin-top: 20px; padding: 12px; background: white; color: var(--green-primary); border: 1.5px solid var(--green-primary); border-radius: var(--radius-sm); font-family: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
    .restart-btn:hover { background: var(--green-light); }
    .disclaimer { margin-top: 20px; padding: 14px; font-size: 10px; color: var(--ink-faint); text-align: center; line-height: 1.6; border-top: 1px solid var(--line-soft); }

    .error-box { text-align: center; padding: 30px 20px; color: var(--warn); font-size: 13px; }
  </style>
</head>
<body>
<div class="app">
  <header class="header">
    <a class="header-back" href="/app.html" aria-label="뒤로">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 18l-6-6 6-6"/>
      </svg>
    </a>
    <div class="header-title">조합 점검</div>
    <div class="header-spacer"></div>
  </header>

  <!-- ── 입력 화면 ── -->
  <main class="screen active" id="screenInput">
    <div class="intro">
      <div class="intro-eyebrow">INGREDI FIT</div>
      <div class="intro-title">내 영양제 조합 점검</div>
      <div class="intro-desc">지금 드시는 걸 알려주시면<br>겹침·과잉·상호작용을 짚어드려요</div>
    </div>

    <!-- 1. 영양제 선택 -->
    <div class="section-block">
      <div class="section-label"><span class="section-num">1</span> 지금 드시는 영양제</div>

      <div class="item-grid" id="itemGrid">
        <!-- JS로 렌더 -->
      </div>

      <div class="free-add-wrap">
        <input type="text" class="free-add-input" id="freeAddInput" placeholder="목록에 없으면 직접 입력 (예: 코엔자임Q10)">
        <button class="free-add-btn" id="freeAddBtn">추가</button>
      </div>
      <div class="custom-items" id="customItems"></div>
    </div>

    <!-- 2. 컨텍스트 질문 -->
    <div class="section-block">
      <div class="section-label"><span class="section-num">2</span> 추가로 알려주세요</div>

      <div class="yn-group">
        <div class="yn-row">
          <div>
            <div class="yn-row-label">처방약을 복용 중이신가요?</div>
            <div class="yn-row-desc">혈압약·항응고제 등이 있으면 더 주의해서 봐드려요</div>
          </div>
          <div class="yn-buttons">
            <button class="yn-btn" data-q="meds" data-v="yes">예</button>
            <button class="yn-btn active" data-q="meds" data-v="no">아니요</button>
          </div>
        </div>
        <div class="med-input-wrap" id="medInputWrap">
          <input type="text" class="med-input" id="medInput" placeholder="예: 와파린, 아스피린, 갑상선약">
          <div class="med-input-hint">쉼표(,)로 구분해서 입력하세요</div>
        </div>

        <div class="yn-row">
          <div>
            <div class="yn-row-label">임신 중 또는 수유 중이신가요?</div>
          </div>
          <div class="yn-buttons">
            <button class="yn-btn" data-q="preg" data-v="yes">예</button>
            <button class="yn-btn active" data-q="preg" data-v="no">아니요</button>
          </div>
        </div>

        <div class="yn-row">
          <div>
            <div class="yn-row-label">2주 이내 수술 예정이 있으신가요?</div>
          </div>
          <div class="yn-buttons">
            <button class="yn-btn" data-q="surg" data-v="yes">예</button>
            <button class="yn-btn active" data-q="surg" data-v="no">아니요</button>
          </div>
        </div>
      </div>
    </div>

    <button class="submit-btn" id="submitBtn" disabled>영양제를 1개 이상 선택해주세요</button>
  </main>

  <!-- ── 로딩 ── -->
  <main class="screen loading-screen" id="screenLoading">
    <div class="loading-spinner"></div>
    <div class="loading-text">AI가 조합을 분석하고 있어요…</div>
  </main>

  <!-- ── 결과 화면 ── -->
  <main class="screen" id="screenResult">
    <div class="result-header">
      <div class="result-header-eyebrow">INGREDI FIT 분석</div>
      <div class="result-header-title">조합 점검 결과</div>
      <div class="result-header-items" id="resultItems"></div>
    </div>
    <div id="resultContent"></div>
    <button class="restart-btn" onclick="resetScreen()">다른 조합 점검하기</button>
    <div class="disclaimer" id="resultDisclaimer"></div>
  </main>
</div>

<script>
const API_BASE = window.location.origin;

const PRESET_ITEMS = [
  '오메가3', '종합비타민', '비타민D', '비타민C',
  '마그네슘', '칼슘', '철분', '아연',
  '프로바이오틱스', '루테인', '비타민B', '코엔자임Q10'
];

let state = {
  selectedItems: new Set(),
  customItems: [],
  meds: false,
  medList: '',
  preg: false,
  surg: false
};

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── 영양제 그리드 렌더 ──
function renderItemGrid() {
  const grid = document.getElementById('itemGrid');
  grid.innerHTML = PRESET_ITEMS.map(name => {
    const sel = state.selectedItems.has(name) ? 'selected' : '';
    return `
      <div class="item-chip ${sel}" onclick="toggleItem('${name}')">
        <div class="item-chip-check">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <span class="item-chip-label">${name}</span>
      </div>`;
  }).join('');
}

function toggleItem(name) {
  if (state.selectedItems.has(name)) state.selectedItems.delete(name);
  else state.selectedItems.add(name);
  renderItemGrid();
  updateSubmitBtn();
}
window.toggleItem = toggleItem;

// ── 커스텀 영양제 추가 ──
function renderCustomItems() {
  const el = document.getElementById('customItems');
  el.innerHTML = state.customItems.map((name, idx) => `
    <span class="custom-item-tag">
      ${escapeHtml(name)}
      <button class="custom-item-remove" onclick="removeCustom(${idx})">×</button>
    </span>
  `).join('');
}

document.getElementById('freeAddBtn').addEventListener('click', () => {
  const input = document.getElementById('freeAddInput');
  const val = input.value.trim();
  if (!val) return;
  if (state.customItems.includes(val) || state.selectedItems.has(val)) {
    input.value = '';
    return;
  }
  state.customItems.push(val);
  input.value = '';
  renderCustomItems();
  updateSubmitBtn();
});
document.getElementById('freeAddInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('freeAddBtn').click();
  }
});

function removeCustom(idx) {
  state.customItems.splice(idx, 1);
  renderCustomItems();
  updateSubmitBtn();
}
window.removeCustom = removeCustom;

// ── Yes/No 버튼 ──
document.querySelectorAll('.yn-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const q = btn.dataset.q;
    const v = btn.dataset.v;
    document.querySelectorAll(`.yn-btn[data-q="${q}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (q === 'meds') {
      state.meds = (v === 'yes');
      document.getElementById('medInputWrap').classList.toggle('active', state.meds);
      if (!state.meds) { state.medList = ''; document.getElementById('medInput').value = ''; }
    } else if (q === 'preg') state.preg = (v === 'yes');
    else if (q === 'surg') state.surg = (v === 'yes');
  });
});
document.getElementById('medInput').addEventListener('input', e => {
  state.medList = e.target.value.trim();
});

// ── 제출 버튼 상태 ──
function updateSubmitBtn() {
  const btn = document.getElementById('submitBtn');
  const total = state.selectedItems.size + state.customItems.length;
  if (total === 0) {
    btn.disabled = true;
    btn.textContent = '영양제를 1개 이상 선택해주세요';
  } else {
    btn.disabled = false;
    btn.textContent = `${total}개 영양제 조합 점검받기`;
  }
}

// ── 제출 ──
document.getElementById('submitBtn').addEventListener('click', async () => {
  const items = [...state.selectedItems, ...state.customItems];
  const medications = state.meds && state.medList ? state.medList.split(',').map(s => s.trim()).filter(Boolean) : [];

  showScreen('Loading');
  try {
    const params = new URLSearchParams();
    params.set('items', items.join(','));
    if (medications.length) params.set('meds', medications.join(','));
    if (state.preg) params.set('pregnancy', 'true');
    if (state.surg) params.set('surgery', 'true');
    const res = await fetch(`${API_BASE}/fit-api?${params.toString()}`);
    if (!res.ok) throw new Error('서버 오류: ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.message || data.error);
    renderResult(data);
    showScreen('Result');
  } catch (err) {
    document.getElementById('resultContent').innerHTML = `<div class="error-box">분석에 실패했어요: ${escapeHtml(err.message)}</div>`;
    showScreen('Result');
  }
});

// ── 결과 렌더 ──
function renderResult(data) {
  // 상단 태그
  const itemsHtml = data.input.items.map(i => `<span class="result-header-tag">${escapeHtml(i)}</span>`).join('') +
                    data.input.medications.map(m => `<span class="result-header-tag med">${escapeHtml(m)}</span>`).join('');
  document.getElementById('resultItems').innerHTML = itemsHtml;

  let html = '';

  // 최고 심각도 배너
  if (data.stats.highestSeverity && ['경고','금기'].includes(data.stats.highestSeverity)) {
    html += `<div class="severity-banner ${data.stats.highestSeverity}">
      <div class="severity-banner-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
      </div>
      <div class="severity-banner-text"><strong>${data.stats.highestSeverity} 수준 주의사항이 있어요.</strong> 의사·약사 상담을 권장합니다.</div>
    </div>`;
  }

  // AI 요약
  if (data.aiSummary) {
    html += `<div class="ai-summary">
      <div class="ai-summary-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        AI 종합 분석
      </div>
      <div class="ai-summary-text">${escapeHtml(data.aiSummary)}</div>
    </div>`;
  }

  // 섹션별 카드
  const sections = [
    { key: 'interactions',   title: '상호작용',     icon: 'warn',    iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l10-10M7 7h10v10"/></svg>', renderPair: true },
    { key: 'targetCautions', title: '대상별 주의',  icon: 'caution', iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>', renderPair: false },
    { key: 'overlaps',       title: '중복·과잉',    icon: 'caution', iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><rect x="7" y="7" width="14" height="14" rx="2"/></svg>', renderPair: false },
    { key: 'timing',         title: '복용 시간 가이드', icon: 'info', iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', renderPair: false },
    { key: 'synergies',      title: '시너지 조합',  icon: 'safe',    iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>', renderPair: true },
  ];

  for (const sec of sections) {
    const items = data.sections[sec.key] || [];
    if (items.length === 0) continue;

    html += `<div class="section">
      <div class="section-head">
        <div class="section-title-row">
          <div class="section-icon ${sec.icon}">${sec.iconSvg}</div>
          ${sec.title}
        </div>
        <div class="section-count">${items.length}건</div>
      </div>
      <div class="item-list">`;

    for (const m of items) {
      const sev = m.severity || '';
      const pair = sec.renderPair
        ? `${escapeHtml(m.a)} <span class="item-pair-sep">+</span> ${escapeHtml(m.b)}`
        : (m.b ? `${escapeHtml(m.a)} <span class="item-pair-sep">·</span> ${escapeHtml(m.b)}` : escapeHtml(m.a));

      const badges = [];
      if (sev) badges.push(`<span class="badge-sev ${sev}">${sev}</span>`);
      if (m.evidence) badges.push(`<span class="badge-ev ${m.evidence}">근거 ${m.evidence}</span>`);

      html += `<div class="item-box ${sev}">
        <div class="item-pair">${pair}<div class="item-badges">${badges.join('')}</div></div>
        <div class="item-desc">${escapeHtml(m.description)}</div>
        ${m.recommendation ? `<div class="item-rec"><strong>권고:</strong> ${escapeHtml(m.recommendation)}</div>` : ''}
      </div>`;
    }
    html += '</div></div>';
  }

  if (data.stats.totalMatches === 0) {
    html += `<div class="section">
      <div class="empty-section">선택하신 영양제 조합에 대한 특별한 주의사항이 ingredi DB에서 확인되지 않았어요.</div>
    </div>`;
  }

  document.getElementById('resultContent').innerHTML = html;
  document.getElementById('resultDisclaimer').textContent = data.disclaimer || '';
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen' + name).classList.add('active');
  window.scrollTo(0, 0);
}

function resetScreen() {
  showScreen('Input');
}
window.resetScreen = resetScreen;

// 초기 렌더
renderItemGrid();
updateSubmitBtn();
</script>
</body>
</html>
