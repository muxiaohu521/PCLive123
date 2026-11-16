/**
 * webviewFillScreen — 网页版线路「视频铺满窗口」共享脚本
 *
 * 官网直播源（央视频/央视网/芒果TV/长江云等）以网页形式播放时，网页自带大量
 * 非播放器 UI（顶栏/侧栏/推荐区等），视频默认居中显示在播放器容器里。
 * 主窗口与副本悬浮窗都需要执行同一套「隐藏 UI + 视频铺满视口」的脚本，
 * 才能让副本悬浮窗显示与主窗口一致的、铺满窗口的视频画面。
 *
 * 提取自主窗口 YSP webview 的 hideUI 逻辑，保证两处行为完全一致。
 */

import { logger } from '@/utils/logger'

/** 构建「隐藏非播放器 UI」的 CSS（dom-ready 时注入） */
function buildWebviewHideCSS(isMgtvLive: boolean): string {
  return `
    html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;visibility:visible!important}
    ::-webkit-scrollbar{display:none!important}
    body{background:#000!important}
    /* 央视频 yangshipin.cn */
    .header,.tv-main-con-r,.tv-home-btm,.tv-zhan,.public,.footer,.max-footer{display:none!important}
    /* 央视网 tv.cctv.com */
    .video_right,#page_head_lt31,.bg_top_h_tile>.bg_top_owner>.bg_bottom_h_tile>.bg_bottom_owner>#page_head_lt31{display:none!important}
    /* 芒果TV mgtv.com 隐藏全部非播放元素 */
    ${isMgtvLive ? `
      header,aside,footer,.header-v2,.top-header,.nav,.side-bar,.top-header-v2,.mgtv-app-download-banner,.live-aside-room-list,.live-header,
      .guide-download,.float-download,.header-v2-wrap,.logo-wrap,.search-wrap,.user-wrap,.vip-entrance,.download-btn,
      .live-tab-nav,.recommend-live-room-wrap,.live-footer,.live-aside-recommend,.new-page-live-header,
      .mgtv-live-header,.mgtv-live-aside,.mgtv-live-footer
      { display:none !important; visibility:hidden !important; }
    ` : ''}
  `
}

/** 注入隐藏 UI 的 CSS；清理页（about:blank）无需注入 */
export function injectWebviewHideCSS(wv: any, url: string): void {
  if (!wv) return
  if (url === 'about:blank' || url === '') return
  const isMgtvLive = url.includes('mgtv.com/z/')
  try {
    wv.insertCSS(buildWebviewHideCSS(isMgtvLive))
  } catch (e) {
    logger.warn('[webview] insertCSS error: ' + ((e as any)?.message || e))
  }
}

/** 完整 hideUI 脚本：隐藏非播放器元素并让视频铺满视口 */
const WEBVIEW_HIDE_UI_SCRIPT = `
(function hideUI(){
  console.log('[hideUI] start');
  var keepTimer = null;

  // 站点已知的播放器容器（按优先级），兼容央视频与央视网，+ Video.js 的 .video-js
  // 央视频：优先 .tv-main-con-l-vid（纯视频显示区），而不是 .tv-main-con-l（含标题/控制条的外层容器）
  var HINTS = [
    '.tv-main-con-l-vid', '.tv-main-con-l',
    '#player', '.video_flash', '.video_left', '.playingVideo', '.video-js'
  ];

  function locatePlayer(v) {
    for (var i = 0; i < HINTS.length; i++) {
      var el = null;
      try { el = v.closest(HINTS[i]); } catch (e) {}
      if (el && el !== document.body && el !== document.documentElement) { return el; }
    }
    var p = v.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      if (p.offsetWidth >= 200 && p.offsetHeight >= 120) { return p; }
      p = p.parentElement;
    }
    return v.parentElement;
  }

  function fillScreen(player, v) {
    // 清除 video 所有祖先上的 transform/filter/contain/perspective：
    // 这些属性会使其成为 fixed/absolute 定位的包含块，导致 video 无法铺满视口
    // （央视网 .video_left 940x579 / .playingVideo 1200x579 等固定像素祖先同理）。
    var a = v.parentElement;
    while (a && a !== document.body && a !== document.documentElement) {
      a.style.setProperty('transform', 'none', 'important');
      a.style.setProperty('filter', 'none', 'important');
      a.style.setProperty('contain', 'none', 'important');
      a.style.setProperty('perspective', 'none', 'important');
      a = a.parentElement;
    }
    // 将 player 与 video 之间的中间容器改为 static 并铺满：
    // 长江云、福建等站点的播放器常把 video 包在多层带 position:relative 或
    // 固定像素的容器里，这些容器会成为 video 的 absolute 定位包含块，导致视频缩在角落无法全屏。
    var mid = v.parentElement;
    while (mid && mid !== player && mid !== document.body && mid !== document.documentElement) {
      mid.style.setProperty('position', 'static', 'important');
      mid.style.setProperty('width', '100%', 'important');
      mid.style.setProperty('height', '100%', 'important');
      mid.style.setProperty('overflow', 'visible', 'important');
      mid.style.setProperty('max-width', 'none', 'important');
      mid.style.setProperty('max-height', 'none', 'important');
      mid.style.setProperty('visibility', 'visible', 'important');
      mid = mid.parentElement;
    }
    player.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;margin:0!important;z-index:2147483646!important;max-width:none!important;max-height:none!important;transform:none!important;visibility:visible!important';
    v.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;object-fit:contain!important;z-index:2147483647!important;max-width:none!important;max-height:none!important;background:#000!important;visibility:visible!important;transform:none!important';
    document.body.style.setProperty('visibility', 'visible', 'important');
  }

  // 站点把播放器放在跨域 iframe 里时（如澳门莲花卫视 lotustv.mo 使用 quklive iframe），
  // 顶层 document 没有 video，但有一个承载播放器的 iframe，此时让 iframe 本身铺满视口。
  function findPlayerIframe() {
    var frames = document.querySelectorAll('iframe, object, embed');
    var best = null, bestScore = 0;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var r = f.getBoundingClientRect();
      if (r.width < 120 || r.height < 80) continue;
      var src = (f.src || '').toLowerCase();
      var score = r.width * r.height;
      if (/embed|live|play|stream|video|player|quklive/i.test(src)) score *= 100;
      if (f.id && /live|video|player|onlive/i.test(f.id)) score *= 100;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best;
  }

  function clearAncestors(el) {
    var a = el.parentElement;
    while (a && a !== document.body && a !== document.documentElement) {
      a.style.setProperty('transform', 'none', 'important');
      a.style.setProperty('filter', 'none', 'important');
      a.style.setProperty('contain', 'none', 'important');
      a.style.setProperty('perspective', 'none', 'important');
      a = a.parentElement;
    }
  }

  function revealSolo(el) {
    for (var ci = 0; ci < document.body.children.length; ci++) {
      document.body.children[ci].style.display = 'none';
    }
    var cur = el;
    var chain = [];
    while (cur && cur !== document.body && cur !== document.documentElement) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    for (var j = 0; j < chain.length; j++) {
      var node = chain[j];
      node.style.display = '';
      var parent2 = node.parentElement;
      if (parent2) {
        for (var k = 0; k < parent2.children.length; k++) {
          if (parent2.children[k] !== node) parent2.children[k].style.display = 'none';
        }
      }
    }
    document.body.style.display = '';
    document.body.style.background = '#000';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'relative';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
  }

  function fillIframe(ifr) {
    clearAncestors(ifr);
    revealSolo(ifr);
    ifr.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;margin:0!important;z-index:2147483646!important;max-width:none!important;max-height:none!important;transform:none!important;border:0!important;background:#000!important;visibility:visible!important';
    document.body.style.setProperty('visibility', 'visible', 'important');
  }

  // 浏览器 autoplay 策略：无用户手势时必须 muted 才允许自动播放。
  // 站点播放器（如澳门莲花卫视 quklive 播放器）默认 autoplay:false，需主动 muted + play()。
  function tryPlay(v) {
    if (!v) return false;
    try {
      v.muted = true;
      v.defaultMuted = true;
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
      var p = v.play();
      if (p && p.catch) { p.catch(function(){}) }
      // 静音自动播放成功后恢复声音：播放已启动，此时取消 muted 不会触发自动播放拦截。
      var unmuteApplied = false;
      var applyUnmute = function() {
        if (unmuteApplied) return;
        unmuteApplied = true;
        try {
          v.muted = false;
          v.defaultMuted = false;
          v.removeAttribute('muted');
          console.log('[hideUI] autoplay started, unmuted');
        } catch (e) {
          console.log('[hideUI] unmute error: ' + (e && e.message ? e.message : e));
        }
      };
      v.addEventListener('playing', applyUnmute, { once: true });
      // 兜底：部分流的 playing 事件可能不触发，播放开始（paused=false）后延迟取消静音
      setTimeout(function(){
        if (!v.paused && !v.ended) { applyUnmute(); }
      }, 2000);
      return true;
    } catch (e) {
      console.log('[hideUI] play error: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  // 铺满 iframe 内部页面：隐藏 iframe 页面的其它 DOM，仅保留 video 链并拉伸到 iframe 视口。
  // 长江云、福建等站点可能把播放器放在跨域 iframe 里，只铺满 iframe 本身不够，
  // iframe 内部仍会显示页头/侧栏以及居中的小视频，需要进一步清理 iframe 内部 DOM。
  function tameDoc(doc, depth) {
    if (!doc || depth > 3) return false;
    try {
      var v = doc.querySelector('video');
      if (v) {
        var body = doc.body;
        if (!body) return false;
        for (var ci = 0; ci < body.children.length; ci++) {
          body.children[ci].style.display = 'none';
        }
        var chain = [];
        var cur = v.parentElement;
        while (cur && cur !== body && cur !== doc.documentElement) {
          chain.push(cur);
          cur = cur.parentElement;
        }
        for (var j = 0; j < chain.length; j++) {
          var node = chain[j];
          node.style.display = '';
          node.style.setProperty('position', 'static', 'important');
          node.style.setProperty('transform', 'none', 'important');
          node.style.setProperty('filter', 'none', 'important');
          node.style.setProperty('contain', 'none', 'important');
          node.style.setProperty('perspective', 'none', 'important');
          node.style.setProperty('width', '100%', 'important');
          node.style.setProperty('height', '100%', 'important');
          node.style.setProperty('overflow', 'visible', 'important');
          node.style.setProperty('visibility', 'visible', 'important');
          var p2 = node.parentElement;
          if (p2) {
            for (var k = 0; k < p2.children.length; k++) {
              if (p2.children[k] !== node) p2.children[k].style.display = 'none';
            }
          }
        }
        body.style.display = '';
        body.style.background = '#000';
        body.style.margin = '0';
        body.style.overflow = 'hidden';
        body.style.width = '100%';
        body.style.height = '100%';
        v.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;object-fit:contain!important;z-index:2147483646!important;max-width:none!important;max-height:none!important;background:#000!important;visibility:visible!important';
        tryPlay(v);
        return true;
      }
    } catch (e) {}
    try {
      var nested = doc.querySelectorAll('iframe, object, embed');
      for (var n = 0; n < nested.length; n++) {
        var nd = null;
        try { nd = nested[n].contentDocument || nested[n].contentWindow.document; } catch (e2) {}
        if (nd && tameDoc(nd, depth + 1)) return true;
      }
    } catch (e3) {}
    return false;
  }

  function tameIframeVideo(ifr) {
    try {
      var doc = ifr.contentDocument || ifr.contentWindow.document;
      return tameDoc(doc, 0);
    } catch (e) {
      return false;
    }
  }

  // 揭示顶层 video：隐藏 body 其余子节点，仅保留播放器链并铺满视口
  function revealVideo(v) {
    // ========== 芒果TV 特殊处理：DOM 结构复杂，直接 video 全屏 ==========
    var isMgtv = new RegExp('mgtv\\.com/z/').test(window.location.href);
    if (isMgtv) {
      console.log('[revealVideo] mgtv site, direct video fullscreen');
      // 清除 video 祖先上的 transform/filter/contain，避免 fixed 定位被包含块劫持
      clearAncestors(v);
      // 隐藏 body 所有直接子元素中不包含 video 的（顶栏/侧栏/推荐区等）
      for (var ci = 0; ci < document.body.children.length; ci++) {
        var c = document.body.children[ci];
        if (!c.contains(v)) c.style.display = 'none';
      }
      // video 与 body 之间的所有中间容器统一清除定位/裁剪，避免 video 被包裹容器裁剪
      var mid2 = v.parentElement;
      while (mid2 && mid2 !== document.body && mid2 !== document.documentElement) {
        mid2.style.setProperty('position', 'static', 'important');
        mid2.style.setProperty('width', '100%', 'important');
        mid2.style.setProperty('height', '100%', 'important');
        mid2.style.setProperty('overflow', 'visible', 'important');
        mid2.style.setProperty('max-width', 'none', 'important');
        mid2.style.setProperty('max-height', 'none', 'important');
        mid2.style.setProperty('visibility', 'visible', 'important');
        mid2.style.setProperty('display', 'block', 'important');
        mid2 = mid2.parentElement;
      }
      document.body.style.display = '';
      document.body.style.background = '#000';
      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'relative';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
      document.body.style.setProperty('visibility', 'visible', 'important');
      // video 自身 fixed 铺满视口
      v.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;object-fit:contain!important;z-index:2147483647!important;max-width:none!important;max-height:none!important;background:#000!important;visibility:visible!important;transform:none!important;display:block!important';
      console.log('[revealVideo] mgtv video filled fullscreen');
      return true;
    }
    // ================================================================
    var player = locatePlayer(v);
    // 专门针对 Video.js：优先选中 video 外层的 .video-js 容器（gdtv.cn 必备）
    if (!player || player === document.body || player === document.documentElement) {
      var pVideoJs = v.closest('.video-js');
      if (pVideoJs) {
        console.log('[revealVideo] found Video.js container as player');
        player = pVideoJs;
      }
    }
    // 兜底：Video.js 站点初始化早期祖先尺寸不足时，直接允许从 body 开始铺满，
    // 不要因为 locatePlayer 没找到达标容器就卡住不清理 DOM（广东台 gdtv.cn 常见）
    if (!player || player === document.body || player === document.documentElement) {
      console.log('[revealVideo] locatePlayer no valid container, fallback to direct body fill');
      // 直接隐藏 body 所有其他子元素，把 video 设为 fixed 全屏
      for (var ci = 0; ci < document.body.children.length; ci++) {
        var c = document.body.children[ci];
        if (!c.contains(v)) c.style.display = 'none';
      }
      document.body.style.display = '';
      document.body.style.background = '#000';
      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'relative';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
      fillScreen(document.body, v);
      return true;
    }

    for (var ci = 0; ci < document.body.children.length; ci++) {
      document.body.children[ci].style.display = 'none';
    }

    var cur = player;
    var chain = [];
    while (cur && cur !== document.body && cur !== document.documentElement) {
      chain.push(cur);
      cur = cur.parentElement;
    }

    for (var j = 0; j < chain.length; j++) {
      var node = chain[j];
      node.style.display = '';
      var parent2 = node.parentElement;
      if (parent2) {
        for (var k = 0; k < parent2.children.length; k++) {
          if (parent2.children[k] !== node) parent2.children[k].style.display = 'none';
        }
      }
    }

    document.body.style.display = '';
    document.body.style.background = '#000';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'relative';
    document.body.style.width = '100%';
    document.body.style.height = '100%';

    fillScreen(player, v);
    return true;
  }

  // 判断视频是否被祖先容器隐藏（display:none / visibility:hidden）。
  // 关键：这些隐藏属性不会暂停视频播放、也不会静音，因此视频可能“有声音但黑屏”。
  function isVideoHidden(v) {
    var el = v;
    while (el && el !== document.body && el !== document.documentElement) {
      var cs = null;
      try { cs = getComputedStyle(el); } catch (e) { return true; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      el = el.parentElement;
    }
    return false;
  }

  function run() {
    var v = document.querySelector('video');
    if (!v) {
      var ifr = findPlayerIframe();
      if (ifr) {
        console.log('[hideUI] no video, but found player iframe src=' + (ifr.src||'').substring(0,80));
        fillIframe(ifr);
        console.log('[hideUI] iframe filled');
        if (!tameIframeVideo(ifr)) {
          var autoRetries = 0;
          var autoTimer = setInterval(function(){
            autoRetries++;
            if (autoRetries > 30) { clearInterval(autoTimer); return; }
            if (tameIframeVideo(ifr)) {
              console.log('[hideUI] iframe tamed at retry ' + autoRetries);
              clearInterval(autoTimer);
            }
          }, 1000);
        } else {
          console.log('[hideUI] iframe tamed');
        }
        return;
      }
      console.log('[hideUI] no video, will retry'); setTimeout(run, 500); return;
    }

    var isGdtvSite = new RegExp('gdtv\\.cn').test(window.location.hostname);
    // 广东台 gdtv.cn 使用 Video.js + MSE 播放器，页面初始化较慢（异步加载 m3u8、创建 video 元素）。
    // 先让页面播放器自由初始化 6 秒，期间不碰任何 DOM，避免干扰其内部 MSE 初始化。
    if (isGdtvSite) {
      if (!run.gdtvGrace) {
        console.log('[hideUI] gdtv.cn: grace period 6s, skip all DOM operations')
        run.gdtvGrace = 1
        setTimeout(run, 6000)
        return
      }
      console.log('[hideUI] gdtv.cn grace period done')
    }

    v.style.setProperty('visibility', 'visible', 'important');

    if (!run.waitCounter) run.waitCounter = 0;
    var forceProceed = isGdtvSite || run.waitCounter++ >= 20;

    if ((v.videoWidth <= 0 || v.videoHeight <= 0) && !forceProceed) {
      console.log('[hideUI] video found but not initialized yet (videoSize='+v.videoWidth+'x'+v.videoHeight+'), waiting... cnt='+run.waitCounter);
      setTimeout(run, 600);
      return;
    }

    if (forceProceed) console.log('[hideUI] force proceed even zero size, site='+window.location.hostname);
    run.waitCounter = 0;

    console.log('[hideUI] video ready id=' + v.id + ' src=' + (v.src||'').substring(0,60) + ' size=' + v.videoWidth + 'x' + v.videoHeight + ' paused='+v.paused+' readyState='+v.readyState);

    if (!revealVideo(v)) { console.log('[hideUI] no valid player found'); return; }
    console.log('[hideUI] done');

    // Video.js 站点（广东台 gdtv.cn）可能需要点击大播放按钮才能启动
    var bigPlayBtn = document.querySelector('.vjs-big-play-button');
    if (bigPlayBtn) {
      console.log('[hideUI] clicking vjs-big-play-button');
      bigPlayBtn.click();
    }

    // 监听 canplay：即使首次 force proceed 时尺寸为 0，视频元数据加载后也确保铺满校正
    v.addEventListener('canplay', function onCanplay() {
      console.log('[hideUI] video canplay, ensuring fill');
      var pp2 = locatePlayer(v);
      if (pp2 && pp2 !== document.body && pp2 !== document.documentElement) {
        fillScreen(pp2, v);
      }
      v.removeEventListener('canplay', onCanplay);
    });

    tryPlay(v);

    // 诊断：监听 error 事件，确认是解码(codec)错误还是网络错误（广东台 H.265 排查）
    if (!v.__wvtErrDiag) {
      v.__wvtErrDiag = 1;
      v.addEventListener('error', function onVErr() {
        var e = v.error;
        console.log('[hideUI] video ERROR code=' + (e && e.code) + ' msg=' + (e && e.message));
      });
    }
    // 诊断：3 秒后复查是否出帧
    setTimeout(function(){
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        console.log('[hideUI] frame OK after 3s: ' + v.videoWidth + 'x' + v.videoHeight + ' readyState=' + v.readyState);
      } else {
        console.log('[hideUI] STILL no frame after 3s: readyState=' + v.readyState + ' networkState=' + v.networkState + ' paused=' + v.paused + ' error=' + (v.error ? v.error.code : 'null') + ' src=' + (v.src||'').substring(0,60));
      }
    }, 3000);
  }

  run();

  // 持续看护，解决“切换线路/切换回来偶发黑屏有声音”：
  // 1) 顶层 video 可能在 did-finish-load 之后才异步创建（SPA 常见），
  //    此时 run() 可能已走 iframe 兜底分支、把顶层 video 的容器 display:none 隐藏，
  //    导致视频“有声音但被遮挡（黑屏）”。这里检测到被隐藏的顶层 video 后重新揭示。
  // 2) 央视网 liveplayer.js 会在异步初始化/窗口变化时重置播放器尺寸，周期性校正铺满。
  keepTimer = setInterval(function(){
    var vv = document.querySelector('video');
    if (vv) {
      // 视频存在但被隐藏、且确实在播放/已渲染，说明被此前 iframe 兜底误隐藏，重新揭示
      if (isVideoHidden(vv) && (!vv.paused || vv.videoWidth > 0)) {
        console.log('[hideUI] top-level video hidden, re-revealing');
        if (revealVideo(vv)) return;
      }

      var r = vv.getBoundingClientRect();
      var full = r.width >= (window.innerWidth - 4) && r.height >= (window.innerHeight - 4);
      if (!full) {
        var pp = locatePlayer(vv);
        if (pp && pp !== document.body && pp !== document.documentElement) fillScreen(pp, vv);
      }
    } else {
      // 无顶层 video：播放器可能在 iframe 内，周期性重新铺满并清理 iframe 内部 DOM，
      // 应对 iframe 内容异步加载/重渲染后视频重新缩小的情况（长江云、福建等站点）。
      var ifr2 = findPlayerIframe();
      if (ifr2) {
        fillIframe(ifr2);
        tameIframeVideo(ifr2);
      }
    }
  }, 1000);

  // ── 湖北长江云（news.hbtv.com.cn）自动播放兜底 ──
  // 该站点 Aliplayer 配置 autoplay=false，页面自身从不自动播放；且播放器在流地址
  // 请求返回后会 dispose 并重建 video 元素（initPlayer），单次 play() 极易落空，
  // 表现为“偶尔不能自动播放”。这里用看护定时器对“尚未开始播放”的 video 反复拉起，
  // 开始播放后取消静音；用户主动暂停时不干预（页内手势 2 秒内触发的暂停，
  // 以及客户端播放条暂停时由宿主写入的 window.__hbAppPaused）。
  if (/hbtv\\.com\\.cn|cjyun\\.org\\.cn/.test(window.location.hostname)) {
    var hbUserAt = 0;
    var hbMarkUser = function(){ hbUserAt = Date.now(); };
    var hbEvents = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
    for (var hbi = 0; hbi < hbEvents.length; hbi++) {
      try { document.addEventListener(hbEvents[hbi], hbMarkUser, true); } catch (e) {}
    }

    function hbAliPlayer() {
      try {
        var appEl = document.querySelector('#app');
        var vm = appEl && appEl.__vue__;
        if (vm && vm.player && typeof vm.player.play === 'function') return vm.player;
      } catch (e) {}
      return null;
    }

    function hbBind(v) {
      if (v.__hbBound) return;
      v.__hbBound = 1;
      v.addEventListener('playing', function(){
        v.__hbStarted = 1;
        if (v.__hbWeMuted) {
          v.__hbWeMuted = 0;
          try {
            v.muted = false;
            v.defaultMuted = false;
            v.removeAttribute('muted');
          } catch (e) {}
        }
        console.log('[hb] playing');
      });
      // 暂停事件紧跟在用户手势之后（如点击播放器暂停键/控制条）→ 判定为用户主动暂停，
      // 此后看护定时器不再干预；用户重新播放时 'play' 事件清除该标记。
      v.addEventListener('pause', function(){
        if (Date.now() - hbUserAt < 2000) v.__hbUserPaused = 1;
      });
      v.addEventListener('play', function(){ v.__hbUserPaused = 0; });
    }

    function hbKick(v) {
      var now = Date.now();
      if (v.__hbLastKick && now - v.__hbLastKick < 1500) return;
      v.__hbLastKick = now;
      try {
        v.setAttribute('playsinline', '');
        v.muted = true;
        v.defaultMuted = true;
        v.setAttribute('muted', '');
        v.__hbWeMuted = 1;
      } catch (e) {}
      var p = null;
      try { p = v.play(); } catch (e) { console.log('[hb] play error: ' + (e && e.message)); }
      if (p && p.catch) {
        p.catch(function(e){ console.log('[hb] play rejected: ' + (e && e.name)); });
      }
      try {
        var pl = hbAliPlayer();
        if (pl) pl.play();
      } catch (e) {}
      // Aliplayer 的大播放按钮是它自身“启动拉流”的入口，个别情况下 play() 调用无效，
      // 这里对同一个 video 只补点一次；延后 1.5 秒再判定，确认仍未播放才点击，
      // 避免按钮为“切换”语义时把刚启动的播放又暂停掉。
      if (!v.__hbClicked) {
        v.__hbClicked = 1;
        setTimeout(function(){
          try {
            if (!v.isConnected || !v.paused) return;
            var bigBtn = document.querySelector('.prism-big-play-btn');
            if (bigBtn) {
              bigBtn.click();
              console.log('[hb] click big play btn');
            }
          } catch (e) {}
        }, 1500);
      }
      console.log('[hb] kick play readyState=' + v.readyState + ' paused=' + v.paused);
    }

    // 看护不设时长上限：直播流的 m3u8 刷新/断流重连会让 Aliplayer 销毁并重建
    // video 元素（新元素默认是暂停态），只有持续看护才能保证任何时候都能自动播放。
    var hbTimer = setInterval(function(){
      var hv = document.querySelector('video');
      if (!hv) return;
      hbBind(hv);
      // 用户在客户端播放条主动暂停：window.__hbAppPaused 由宿主注入，优先尊重
      if (window.__hbAppPaused) return;
      if (hv.__hbUserPaused) return;
      if (!hv.paused) { hv.__hbStarted = 1; return; }
      hbKick(hv);
    }, 1000);
  }

  // 兜底：无论是否检测到 video，最终都恢复 body 显示，避免页面整体黑屏
  setTimeout(function(){
    document.body.style.setProperty('visibility', 'visible', 'important');
  }, 15000);
})()
`

/** 执行完整 hideUI 脚本，让网页视频铺满视口 */
export function runWebviewHideUI(wv: any): void {
  if (!wv) return
  wv.executeJavaScript(WEBVIEW_HIDE_UI_SCRIPT).catch((e: any) => {
    logger.error(`[webview] hideUI error: ${e?.message || e}`)
  })
}