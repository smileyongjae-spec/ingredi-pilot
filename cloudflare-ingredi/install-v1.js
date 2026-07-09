/* ingredi 홈 화면 설치 안내 (v1)
 * - 안드로이드: beforeinstallprompt로 실제 설치
 * - iOS: 설치 API가 없으므로 '안내 시트'를 띄운다 (배너를 눌러도 반응 없던 문제 수정)
 * 5개 페이지에서 공유. 갱신 시 파일명을 install-v2.js 로 올릴 것 (엣지 캐시 회피).
 */
(function () {
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var inAppRe = /KAKAOTALK|FBAN|FBAV|Instagram|Line\/|NAVER|DaumApps|Snapchat/i;
  var isInApp = inAppRe.test(ua) || (isAndroid && /;\s*wv\)/.test(ua));
  var isKakao = /KAKAOTALK/i.test(ua);
  var isIOSSafari = isIOS && /Safari/.test(ua) &&
                    !/CriOS|FxiOS|EdgiOS/.test(ua) && !inAppRe.test(ua);
  var isIOSOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS/.test(ua);
  var installed = (navigator.standalone === true) ||
                  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });
  window.addEventListener('appinstalled', function () {
    try { sessionStorage.setItem('ingredi_install_dismissed', '1'); } catch (e) {}
    hide();
  });

  if (installed) return;
  try { if (sessionStorage.getItem('ingredi_install_dismissed')) return; } catch (e) {}

  var state;
  if (isIOS) {
    if (isIOSSafari) state = 'ios-safari';
    else if (isKakao) state = 'ios-kakao';
    else if (isInApp) state = 'ios-inapp';
    else if (isIOSOtherBrowser) state = 'ios-browser';
    else state = 'ios-safari';
  }
  else if (isAndroid && isInApp) state = 'android-webview';
  else if (isAndroid) state = 'android-browser';
  else return;

  var wrap = null;
  function hide() {
    if (!wrap) return;
    wrap.style.transform = 'translateX(-50%) translateY(140%)';
    setTimeout(function () { if (wrap) { wrap.remove(); wrap = null; } }, 400);
  }
  function dismiss() {
    try { sessionStorage.setItem('ingredi_install_dismissed', '1'); } catch (e) {}
    hide();
  }
  function setSub(t) { var s = document.getElementById('ingredi-inst-sub'); if (s) s.textContent = t; }

  var UP = '<path d="M12 16V4M12 4l-4 4M12 4l4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>';
  var DL = '<path d="M12 3v12M8 11l4 4 4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>';
  function ic(path, color, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' +
      color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  function xBtn() {
    return '<button id="ingredi-inst-x" aria-label="닫기" style="width:26px;height:26px;flex-shrink:0;' +
      'background:transparent;border:none;color:rgba(250,248,243,.55);display:flex;align-items:center;' +
      'justify-content:center;cursor:pointer;padding:0"><svg width="18" height="18" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M18 6L6 18M6 6l12 12"/></svg></button>';
  }
  // iOS: 전체가 눌리는 배너 (누르면 안내 시트)
  function tapBannerHTML(title, sub) {
    return '<div style="background:#1B3A2E;border-radius:16px;padding:13px 14px;display:flex;align-items:center;' +
      'gap:11px;box-shadow:0 -2px 16px rgba(0,0,0,.18)">' +
      '<button id="ingredi-inst-go" style="flex:1;min-width:0;display:flex;align-items:center;gap:11px;' +
      'background:transparent;border:none;padding:0;cursor:pointer;text-align:left">' +
      '<span style="width:38px;height:38px;flex-shrink:0;background:#2D5F3F;border-radius:11px;display:flex;' +
      'align-items:center;justify-content:center">' + ic(UP, '#B8902F', 20) + '</span>' +
      '<span style="flex:1;min-width:0"><span style="display:block;font-size:13.5px;font-weight:700;color:#FAF8F3;line-height:1.35">' +
      title + '</span><span id="ingredi-inst-sub" style="display:block;font-size:12px;color:#D8BE7A;margin-top:2px;line-height:1.35">' +
      sub + '</span></span>' +
      '<span style="flex-shrink:0;color:#D8BE7A;font-size:13px;font-weight:700">보기 ›</span>' +
      '</button>' + xBtn() + '</div>';
  }
  function buttonHTML(gold, label, sub) {
    var bg = gold ? '#B8902F' : '#2D5F3F';
    var fg = gold ? '#1B3A2E' : '#FAF8F3';
    return '<div style="background:#1B3A2E;border-radius:16px;padding:10px 10px 8px;box-shadow:0 -2px 16px rgba(0,0,0,.18)">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<button id="ingredi-inst-go" style="flex:1;background:' + bg + ';border:none;border-radius:11px;padding:13px;' +
      'display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer">' + ic(DL, fg, 19) +
      '<span style="font-size:14.5px;font-weight:700;color:' + fg + '">' + label + '</span></button>' + xBtn() + '</div>' +
      '<div id="ingredi-inst-sub" style="font-size:11.5px;color:#D8BE7A;text-align:center;margin-top:7px">' + sub + '</div></div>';
  }
  function mount(html) {
    if (document.getElementById('ingredi-inst')) return;
    wrap = document.createElement('div');
    wrap.id = 'ingredi-inst';
    wrap.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%) translateY(140%);bottom:0;width:100%;' +
      'max-width:480px;z-index:9999;padding:0 10px max(10px,env(safe-area-inset-bottom));box-sizing:border-box;' +
      'transition:transform .35s cubic-bezier(.16,1,.3,1);font-family:"Pretendard",-apple-system,BlinkMacSystemFont,sans-serif';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.style.transform = 'translateX(-50%) translateY(0)'; });
    var x = document.getElementById('ingredi-inst-x');
    if (x) x.addEventListener('click', dismiss);
  }

  /* ───────── iOS 안내 시트 ───────── */
  function closeSheet() {
    var o = document.getElementById('ingredi-sheet-ov');
    var s = document.getElementById('ingredi-sheet');
    if (s) s.style.transform = 'translateX(-50%) translateY(100%)';
    if (o) o.style.opacity = '0';
    setTimeout(function () { if (o) o.remove(); if (s) s.remove(); }, 280);
  }
  function copyLink(btnId) {
    var url = location.origin + '/app.html';
    var done = function () {
      var b = document.getElementById(btnId);
      if (b) { b.textContent = '✓ 링크가 복사되었어요'; setTimeout(function(){ if(b) b.textContent = '링크 복사하기'; }, 2200); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt('아래 링크를 복사하세요', url); });
    } else { window.prompt('아래 링크를 복사하세요', url); }
  }
  function step(n, text) {
    return '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px">' +
      '<span style="width:22px;height:22px;flex-shrink:0;border-radius:50%;background:#2D5F3F;color:#fff;' +
      'font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">' + n + '</span>' +
      '<span style="font-size:14px;color:#4F564E;line-height:1.55">' + text + '</span></div>';
  }
  function openSheet(bodyHtml, title) {
    if (document.getElementById('ingredi-sheet')) return;
    var ov = document.createElement('div');
    ov.id = 'ingredi-sheet-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(27,58,46,.4);z-index:10000;opacity:0;transition:opacity .25s ease';
    ov.addEventListener('click', closeSheet);
    document.body.appendChild(ov);

    var sh = document.createElement('div');
    sh.id = 'ingredi-sheet';
    sh.style.cssText = 'position:fixed;left:50%;bottom:0;transform:translateX(-50%) translateY(100%);width:100%;' +
      'max-width:480px;background:#fff;border-radius:20px 20px 0 0;z-index:10001;box-shadow:0 -4px 24px rgba(0,0,0,.16);' +
      'padding:10px 22px max(24px,env(safe-area-inset-bottom));transition:transform .3s cubic-bezier(.16,1,.3,1);' +
      'font-family:"Pretendard",-apple-system,BlinkMacSystemFont,sans-serif';
    sh.innerHTML =
      '<div style="width:38px;height:4px;background:#D9DDD7;border-radius:2px;margin:0 auto 16px"></div>' +
      '<div style="font-size:18px;font-weight:800;color:#1B3A2E;margin-bottom:14px">' + title + '</div>' +
      bodyHtml +
      '<button id="ingredi-sheet-close" style="width:100%;margin-top:16px;padding:13px;background:#E8F1EA;color:#1B3A2E;' +
      'border:none;border-radius:10px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer">닫기</button>';
    document.body.appendChild(sh);
    requestAnimationFrame(function () {
      ov.style.opacity = '1';
      sh.style.transform = 'translateX(-50%) translateY(0)';
    });
    document.getElementById('ingredi-sheet-close').addEventListener('click', closeSheet);
    var cp = document.getElementById('ingredi-copy');
    if (cp) cp.addEventListener('click', function () { copyLink('ingredi-copy'); });
    var sf = document.getElementById('ingredi-safari');
    if (sf) sf.addEventListener('click', function () {
      // 카카오톡 공식 스킴: 기본 브라우저로 페이지를 넘긴다
      var target = encodeURIComponent(location.origin + '/app.html');
      try { location.href = 'kakaotalk://web/openExternal?url=' + target; } catch (e) {}
      // 3초 안에 이탈하지 않으면 안내를 바꾼다 (스킴 미지원 대비)
      setTimeout(function () {
        var b = document.getElementById('ingredi-safari');
        if (b && !document.hidden) b.textContent = '열리지 않으면 아래에서 링크를 복사하세요';
      }, 3000);
    });
  }
  var GHOST = 'width:100%;margin-top:8px;padding:13px;background:#fff;color:#2D5F3F;border:1.5px solid #2D5F3F;' +
              'border-radius:10px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer';
  var PRIMARY = 'width:100%;margin-top:8px;padding:13px;background:#2D5F3F;color:#fff;border:none;' +
              'border-radius:10px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer';

  function sheetSafari() {
    openSheet(
      step(1, '화면 <b>하단 가운데의 공유 버튼</b>(□↑)을 눌러주세요.') +
      step(2, '메뉴를 아래로 넘겨 <b>&ldquo;홈 화면에 추가&rdquo;</b>를 선택하세요.') +
      step(3, '오른쪽 위 <b>&ldquo;추가&rdquo;</b>를 누르면 끝이에요.') +
      '<div style="font-size:12.5px;color:#8B928A;line-height:1.5;margin-top:4px">iPad는 공유 버튼이 오른쪽 위에 있어요.</div>',
      '홈 화면에 추가하기'
    );
  }
  function sheetOtherBrowser() {
    openSheet(
      '<div style="font-size:14px;color:#4F564E;line-height:1.6;margin-bottom:14px">' +
      'iOS에서는 <b>Safari에서만</b> 홈 화면에 추가할 수 있어요. 아래에서 링크를 복사한 뒤 Safari 주소창에 붙여넣어 주세요.</div>' +
      step(1, '아래 <b>링크 복사하기</b>를 눌러주세요.') +
      step(2, '<b>Safari</b> 앱을 열고 주소창에 붙여넣기 하세요.') +
      step(3, '하단 공유 버튼(□↑) → <b>&ldquo;홈 화면에 추가&rdquo;</b>') +
      '<button id="ingredi-copy" style="' + GHOST + '">링크 복사하기</button>',
      'Safari에서 설치해주세요'
    );
  }
  // 카카오톡: 공식 스킴으로 기본 브라우저(대개 Safari)에 넘긴다
  function sheetKakao() {
    openSheet(
      '<div style="font-size:14px;color:#4F564E;line-height:1.6;margin-bottom:14px">' +
      '지금은 카카오톡 안의 브라우저예요. 홈 화면 추가는 <b>Safari</b>에서만 할 수 있어요.</div>' +
      step(1, '아래 <b>Safari로 열기</b>를 누르면 바로 이동해요.') +
      step(2, '하단 공유 버튼(□↑)을 눌러주세요.') +
      step(3, '<b>&ldquo;홈 화면에 추가&rdquo;</b> → 오른쪽 위 <b>&ldquo;추가&rdquo;</b>') +
      '<button id="ingredi-safari" style="' + PRIMARY + '">Safari로 열기</button>' +
      '<button id="ingredi-copy" style="' + GHOST + '">링크 복사하기</button>',
      'Safari에서 설치해주세요'
    );
  }
  // 그 외 인앱(인스타·라인·네이버 등): 공식 스킴이 없어 링크 복사로 안내
  function sheetInApp() {
    openSheet(
      '<div style="font-size:14px;color:#4F564E;line-height:1.6;margin-bottom:14px">' +
      '지금은 앱 안의 브라우저예요. 홈 화면 추가는 <b>Safari</b>에서만 할 수 있어요.</div>' +
      step(1, '아래 <b>링크 복사하기</b>를 눌러주세요.') +
      step(2, '<b>Safari</b> 앱을 열고 주소창에 붙여넣기 하세요.') +
      step(3, '하단 공유 버튼(□↑) → <b>&ldquo;홈 화면에 추가&rdquo;</b>') +
      '<button id="ingredi-copy" style="' + PRIMARY + '">링크 복사하기</button>',
      'Safari에서 설치해주세요'
    );
  }

  function render() {
    if (state === 'ios-safari') {
      mount(tapBannerHTML('홈 화면에 추가하고 앱처럼 쓰세요', '3단계면 끝나요'));
      var a = document.getElementById('ingredi-inst-go');
      if (a) a.addEventListener('click', sheetSafari);
    } else if (state === 'ios-browser') {
      mount(tapBannerHTML('홈 화면에 추가하고 앱처럼 쓰세요', 'Safari에서 설치할 수 있어요'));
      var c = document.getElementById('ingredi-inst-go');
      if (c) c.addEventListener('click', sheetOtherBrowser);
    } else if (state === 'ios-kakao') {
      mount(tapBannerHTML('홈 화면에 추가하고 앱처럼 쓰세요', 'Safari에서 바로 열어드려요'));
      var kk = document.getElementById('ingredi-inst-go');
      if (kk) kk.addEventListener('click', sheetKakao);
    } else if (state === 'ios-inapp') {
      mount(tapBannerHTML('홈 화면에 추가하고 앱처럼 쓰세요', 'Safari에서 설치할 수 있어요'));
      var k = document.getElementById('ingredi-inst-go');
      if (k) k.addEventListener('click', sheetInApp);
    } else if (state === 'android-webview') {
      mount(buttonHTML(false, '홈 화면 설치 (1/2)', '탭하면 크롬으로 이동해요'));
      var g = document.getElementById('ingredi-inst-go');
      if (g) g.addEventListener('click', function () {
        var clean = location.host + location.pathname + location.search;
        var intentUrl = 'intent://' + clean + '#Intent;scheme=https;package=com.android.chrome;end';
        var t = setTimeout(function () { setSub('안 열리면: 우측 상단 ⋮ → 다른 브라우저로 열기'); }, 1300);
        try { location.href = intentUrl; } catch (e) { clearTimeout(t); setSub('우측 상단 ⋮ → 다른 브라우저로 열기'); }
      });
    } else if (state === 'android-browser') {
      mount(buttonHTML(true, '홈 화면 설치', '앱처럼 바로 설치돼요'));
      var b = document.getElementById('ingredi-inst-go');
      if (b) b.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function (c) {
            if (c && c.outcome === 'accepted') hide();
            deferredPrompt = null;
          });
        } else {
          setSub('설치창이 안 뜨면: 우측 상단 ⋮ → 앱 설치');
        }
      });
    }
  }

  function boot() { setTimeout(render, 2000); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
