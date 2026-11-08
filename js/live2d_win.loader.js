/* =============================================================================
 * live2d_win.loader.js —— 插入式启动器（手机和管理后台完全不跑）
 *
 * 用法：网页里只留这一行就够了，别的那些 js/css 由本文件自己插进去。
 *   <script src="./js/live2d_win.loader.js"></script>
 *
 * 行为（四步，按顺序挡）：
 *   1) 先判手机：判定成立就直接 return，本文件除了自己这几行判断，
 *                不下载、不注入任何 js/css（小窗那套 WebGL 在手机上又重又用不上）。
 *   2) 再看页面地址：命中 CONFIG.skipPath（默认是 OpenList 的管理后台 /@manage）同样直接 return，
 *                连“等原网页 load”的监听都不注册；run() 里还会再看一次，站内跳过去也拦得住。
 *   3) 再等原网页显示完：默认等 window load（原页面自己的资源全到位）之后再多走
 *                CONFIG.paintFrames 帧，确认首帧真的画到屏幕上了才开始插。
 *   4) 最后才插：按 CONFIG.css → CONFIG.js 的顺序一个一个插进页面。
 *                JS 必须串行：live2d_model.js 要等 pixi / cubism 那几个到位，
 *                live2d_win.js 又必须在 live2d_model.js 后面（要用 window.L2D）。
 *
 * 不拖慢原网页：插进去的东西一律等原网页显示完才开始下载，本文件自己在 head 里
 *   只是同步执行几十行判断，不下载任何东西；样式还额外用 media="print" 的写法插，
 *   下载完了才改回 media="all"，这样它连“显示完之后再生效”的那一次渲染都不会挡住。
 *
 * 目录（CONFIG 里相对路径的基准 = 本文件自己所在的 js/）：
 *   页面.html                 ← 只写一行 <script src="./js/live2d_win.loader.js">
 *   js/live2d_win.loader.js   ← 本文件
 *   css/live2d_win.css        → CONFIG.css 里写 '../css/live2d_win.css'（css/ 和 js/ 并排，要回上一级）
 *   js/*.js                   → CONFIG.js 里只写文件名（都和本文件同一个目录）
 *   live2d_list.json、live2d/ ← 不归本文件管：live2d_win.js 用 fetch 读它们，基准是
 *                live2dWinLoader.repoBase（= 本文件所在 js/ 的上一层，即仓库根），见界面层 resourceBase()。
 *
 * 从 GitHub 动态获取（页面里只留一行，本地什么文件都不用留）：
 *   <script src="https://cdn.jsdelivr.net/gh/liangzhi007/live2d-win@main/js/live2d_win.loader.js"></script>
 *   本文件从哪加载，js/css/清单/模型就全部跟着从哪加载：BASE 和 repoBase 都是按本文件的
 *   实际下载地址算的，所以本地打开和 CDN 打开走同一套逻辑，清单里不用写任何硬编码网址。
 *
 * 想调什么：
 *   判定太严/太松 → 【1. 配置区】的 force / byUA / byPointer
 *   哪些页面不插   → CONFIG.skipPath（正则，命中就跳过；默认只认 /@manage，null = 关掉这道闸）
 *   想早点插小窗   → CONFIG.waitFor（'load' 最稳，'dom' 只等 DOM，'none' 立刻插）
 *   增删注入的文件 → CONFIG.css / CONFIG.js（顺序即加载顺序，都相对本文件所在的 js/）
 *   不想看提示     → CONFIG.log = false
 * 控制台里可以现场验：live2dWinLoader.isMobile() / live2dWinLoader.skipReason() / live2dWinLoader.state / live2dWinLoader.run()
 *   地址拼对没有 → live2dWinLoader.base（js/ 目录）和 live2dWinLoader.repoBase（仓库根）
 * ============================================================================= */
(function () {
  'use strict';

  /* ============================ 1. 配置区 ============================ */
  var CONFIG = {
    force: null,           // null=自动判断；'mobile'=当作手机（跳过不运行）；'desktop'=当作电脑（强制运行）
                           // 手机上想临时看一次效果就改成 'desktop'，改完刷新即可
    byUA: /android|iphone|ipod|ipad|ipados|harmonyos?|blackberry|bb10|symbian|windows phone|opera mini|ucbrowser|mobile/i,
                           // UA 里出现这些字样就当手机（用小写比对；'mobile' 已经能兜住绝大多数手机浏览器）
    byPointer: true,       // 主指针是“粗指针且不能悬停”（只有触摸屏）也算手机/平板；
                           // 带触屏的笔记本主指针仍是鼠标，不会被误判，嫌严可以改成 false
    skipPath: /(^|\/)@{1,2}manage(?:[/?#]|$)/i,
                           // 第二道闸：页面地址命中这个正则就什么都不插。默认只拦 OpenList 的管理后台 /@manage
                           // （它自己写的是一个 @，和 /@login、/@s/<token> 属于同一类地址；两个 @ 的手滑写法也一起认）。
                           // 登录页也不想看到小窗 → 改成 /(^|\/)@{1,2}(manage|login)(?:[/?#]|$)/i；改成 null = 这条判定整个关掉。
                           // 注意：force:'desktop' 时这道闸一并让路（方便在管理页里临时看一次小窗）。
    waitFor: 'load',       // 什么时候开始插：
                           //   'load' = 等原网页自己的资源全部到位（window load）再插，最不影响原页面；
                           //   'dom'  = 只等 DOM 就绪（DOMContentLoaded），小窗会和原页面抢带宽；
                           //   'none' = 立刻插（不推荐，只是留个口子方便调试）。
    loadTimeout: 10000,    // 选 'load' 时最多等多久（毫秒）。原网页要是有资源一直卡着，
                           // 超过这个时间就不再等，直接开始插，免得小窗永远出不来。
    paintFrames: 2,        // 等完之后再多走几帧 requestAnimationFrame，
                           // 保证首帧是真真切切画到屏幕上之后才开始插（1 帧有时还没提交）。
    cssMedia: 'print',     // 样式先用这个 media 插进去（print 不参与屏幕渲染，所以不挡显示），
                           // 下载完了再改回 'all'。改成 'all' 就是普通的阻塞式样式表。
    log: true,             // false 就一声不吭
    stopOnError: true,     // 某个文件插失败就停下不再插后面的（改 false 会尽量继续，但通常会连带报错）
    css: [
      '../css/live2d_win.css', // 小窗的全部样式（在和大目录并排的 css/ 里，所以要 ../）
    ],
    js: [
      'live2dcubismcore.min.js', // Cubism 4 运行时（.moc3）
      'live2d.min.js',           // Cubism 2 运行时（老模型）
      'pixi.min.js',             // PIXI 6
      'index.cp.js',             // pixi-live2d-display（Cubism 4 绑定）
      'extra.min.js',            // pixi-live2d-display 扩展：HitAreaFrames（显示可点击区域）
      'live2d_model.js',         // 引擎层：导入模型 + 点击/滑动交互
      'live2d_win.js',           // 界面层：左下角小窗（必须在引擎层后面）
    ],
  };

  var state = {
    started: false,   // run() 跑过了
    done: false,      // 全部插完了
    failed: false,    // 中途有文件插失败
    stage: '未启动',   // 现在卡在哪一步：未启动 / 等待原网页 / 插入中 / 完成 / 完成（有失败）/ 手机跳过 / 管理页跳过
    injected: [],     // 已经插进去的地址（浏览器算好的绝对地址）
    skipMsg: '',      // 命中 CONFIG.skipPath 时记一句原因，控制台里好看是哪条地址挡的
  };

  // 同一个页面里插两次本文件时只认第一次，否则会冒出两个小窗
  if (window.live2dWinLoader) {
    /* ▼ 日志调用点 */
    log('这个页面已经有一份了，本次忽略', null, 'warn');
    return;
  }

  /* 第一步：先判手机，再看页面地址（管理后台那几页）。命中任何一条，下面什么都不干，直接收工。 */
  var MOBILE = isMobile();
  var SKIP = skipReason();      // 命中 CONFIG.skipPath（默认是 /@manage）就是那句原因，否则空串
  state.mobile = MOBILE;
  state.skipMsg = SKIP;
  /* 本文件自己的目录（现在是 js/）：CONFIG 里的相对路径都以它为基准，页面放哪儿都不影响。
     这里只是看一眼当前 <script> 标签，不下载任何东西，所以手机上也先算好，
     万一之后从控制台手动 live2dWinLoader.run() 才有正确路径。 */
  var BASE = selfDir();
  /* 仓库根（js/ 的上一层）：界面层拿它当清单 live2d_list.json 和模型目录 pathBase 的基准。
     本文件从 CDN 加载时它也是同一个 CDN 地址，所以清单/模型跟着自动从 CDN 取，不用写死网址。 */
  var REPO_BASE = BASE ? new URL('../', BASE).href : new URL('.', document.baseURI).href;

  /* ============================ 2. 日志 ============================ */
  /**
   * 只写到浏览器控制台，页面上什么都不显示。
   * @param {string} msg 说明文字
   * @param {Object|string} [detail] 附加信息，没有就不写
   * @param {string} [level] 'info' / 'warn' / 'error'，其它按普通 log 输出
   * @returns {void}
   */
  function log(msg, detail, level) {
    if (!CONFIG.log) return;
    var fn = (level && console[level]) ? console[level] : console.log;
    fn.call(console, '[live2dWinLoader] ' + msg, detail === undefined ? '' : detail);
  }

  /* ============================ 3. 是不是手机 / 这页面要不要跳过 ============================ */
  /**
   * 判定顺序：配置强制 → UA-CH → UA 关键字 → 可触摸的 Mac（iPadOS）→ 只有粗指针。
   * @returns {boolean} true = 当作手机，什么都不插
   */
  function isMobile() {
    if (CONFIG.force === 'mobile') return true;
    if (CONFIG.force === 'desktop') return false;

    var ua = navigator.userAgent || '';
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
      return navigator.userAgentData.mobile; // Chromium 系的 UA-CH，比猜字符串可靠
    }
    if (CONFIG.byUA.test(ua)) return true;
    // iPadOS 13 以后 Safari 默认报成 Macintosh，只能靠“能触摸的 Mac”这条区分
    if (ua.indexOf('Macintosh') >= 0 && navigator.maxTouchPoints > 1) return true;
    if (CONFIG.byPointer && window.matchMedia) {
      return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    }
    return false;
  }

  /**
   * 第二道闸：这条页面地址要不要跳过不插（管理后台那种和立绘没关系的页面）。
   * @returns {string} 跳过的原因（命中的那一段地址）；'' = 照常插入
   */
  function skipReason() {
    if (CONFIG.force === 'desktop' || !CONFIG.skipPath) return '';   // 强制运行 / 关掉这道闸都不拦
    var m = (location.pathname + location.search + location.hash).match(CONFIG.skipPath);
    return m ? '地址里有 ' + m[0] : '';
  }

  /* ============================ 4. 等原网页显示完 ============================ */
  /**
   * 本文件自己所在的目录（当前 <script> 标签的 src 去掉文件名），也就是 js/。
   * CONFIG 里写的 '../css/xxx' 就是相对它算的，所以本文件搬到哪个目录都不用改清单。
   * @returns {string} 末尾带 / 的绝对地址
   */
  function selfDir() {
    var self = document.currentScript;
    if (!self) { // 老办法兜底：脚本标签里没有 currentScript 就自己找一个
      var tags = document.getElementsByTagName('script');
      for (var i = 0; i < tags.length; i++) {
        if ((tags[i].src || '').indexOf('live2d_win.loader') >= 0) { self = tags[i]; break; }
      }
    }
    return self && self.src ? self.src.replace(/[^/]*$/, '') : '';
  }

  /**
   * DOM 就绪（live2d_win.js 要往 body 里塞小窗，太早插会找不到 body）。
   * @returns {Promise<void>}
   */
  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(function (resolve) {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  /**
   * 原网页自己的资源全部到位（window load）。
   * 超过 CONFIG.loadTimeout 就没等到 load（页面里有资源卡住了），记一条 warn 照样往下走。
   * @returns {Promise<void>}
   */
  function pageLoaded() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        /* ▼ 日志调用点 */
        log('等原网页 load 超过 ' + CONFIG.loadTimeout + 'ms，不等了，直接开始插', { readyState: document.readyState }, 'warn');
        finish();
      }, CONFIG.loadTimeout);
      function finish() {
        clearTimeout(timer);
        window.removeEventListener('load', finish);
        resolve();
      }
      window.addEventListener('load', finish);
    });
  }

  /**
   * 多走 n 帧 requestAnimationFrame，给浏览器把首帧真正提交到屏幕留出时间。
   * @param {number} n 帧数
   * @returns {Promise<void>}
   */
  function afterPaint(n) {
    var chain = Promise.resolve();
    for (var i = 0; i < n; i++) {
      chain = chain.then(function () {
        return new Promise(function (resolve) {
          // 页面在后台标签里时 rAF 会被挂起，所以补一个 setTimeout 兜底，别一直卡着
          var timer = setTimeout(resolve, 200);
          requestAnimationFrame(function () { clearTimeout(timer); resolve(); });
        });
      });
    }
    return chain;
  }

  /**
   * 按 CONFIG.waitFor 决定等到什么时候才允许开始插；插之前一定已经显示过原网页。
   * @returns {Promise<void>}
   */
  function pageShown() {
    if (CONFIG.waitFor === 'none') return Promise.resolve();
    var base = CONFIG.waitFor === 'dom' ? domReady() : pageLoaded();
    return base.then(function () { return afterPaint(CONFIG.paintFrames); });
  }

  /* ============================ 5. 插文件 ============================ */
  /**
   * 插一个 <link rel="stylesheet">。
   * 先用 CONFIG.cssMedia（默认 print）的身份插：这种样式表不参与屏幕渲染，
   * 所以下载再慢也不会挡住页面显示；等它自己下载完了再改回 'all' 让它生效。
   * @param {string} href 地址（相对本文件所在的 js/）
   * @returns {Promise<string>} 成功 resolve 浏览器算好的绝对地址（'../' 已经折干净）
   */
  function addCss(href) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      el.media = CONFIG.cssMedia;
      el.onload = function () { el.media = 'all'; resolve(el.href); };
      el.onerror = function () { reject(new Error('样式加载失败 ' + href)); };
      (document.head || document.documentElement).appendChild(el);
    });
  }

  /**
   * 插一个 <script>（动态插入的脚本默认异步，onload 之后才轮到下一个，顺序就是这么保证的）。
   * @param {string} src 地址（相对本文件所在的 js/）
   * @returns {Promise<string>} 成功 resolve 浏览器算好的绝对地址
   */
  function addJs(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;      // 明确写成异步：只下载执行，绝不挡原网页解析和显示
      el.onload = function () { resolve(el.src); };
      el.onerror = function () { reject(new Error('脚本加载失败 ' + src)); };
      (document.head || document.documentElement).appendChild(el);
    });
  }

  /**
   * 把 CONFIG 里写的一条路径算成绝对地址（基准 = 本文件所在的 js/）。
   * 条目直接写 http(s) 绝对地址也认（new URL 对绝对地址原样返回），想混用本地/CDN 文件不用改代码。
   * @param {string} rel CONFIG.css / CONFIG.js 里的一条
   * @returns {string} 绝对地址（'../' 已经折干净）
   */
  function absUrl(rel) {
    return new URL(rel, BASE || document.baseURI).href;
  }

  /**
   * 串行插入一批路径，每条都以 BASE（本文件所在的 js/）为基准。
   * @param {string[]} list CONFIG.css 或 CONFIG.js
   * @param {function(string): Promise<string>} fn addCss / addJs
   * @returns {Promise<void>}
   */
  function injectEach(list, fn) {
    return list.reduce(function (chain, rel) {
      return chain.then(function () {
        if (state.failed && CONFIG.stopOnError) return; // 前面断了，后面不再插
        return fn(absUrl(rel)).then(function (url) {
          state.injected.push(url);
        }).catch(function (err) {
          state.failed = true;
          /* ▼ 日志调用点 */
          log(err.message, null, 'error');
        });
      });
    }, Promise.resolve());
  }

  /**
   * 开始插入：先等原网页显示完，再插 css，最后串行插 js。
   * run() 里只再看一遍 CONFIG.skipPath 那道闸（站内跳到管理后台不会重新加载页面）；
   * 手机判定只在入口处用，所以手机浏览器里手动 run() 照样能强制插一次。
   * @returns {Promise<void>}
   */
  function run() {
    if (state.started) return state.promise;
    state.started = true;
    state.stage = '等待原网页';
    state.promise = pageShown().then(function () {
      var why = skipReason();
      if (why) {
        state.skipMsg = why;
        state.stage = '管理页跳过';
        /* ▼ 日志调用点 */
        log('不插了：' + why, { pathname: location.pathname }, 'info');
        return;
      }
      state.stage = '插入中';
      return injectEach(CONFIG.css, addCss)
        .then(function () { return injectEach(CONFIG.js, addJs); })
        .then(function () {
          state.done = true;
          state.stage = state.failed ? '完成（有失败）' : '完成';
          /* ▼ 日志调用点 */
          log('已插入 ' + state.injected.length + ' 个文件', state.injected, state.failed ? 'warn' : 'info');
        });
    });
    return state.promise;
  }

  /* ============================ 6. 入口 ============================ */
  window.live2dWinLoader = {
    CONFIG: CONFIG,   // 想从控制台临时改判定/文件清单/等待方式，改这个就行（改完得重跑 run()）
    state: state,     // { started, done, failed, stage, injected, mobile, skipMsg }
    base: BASE,       // 本文件所在目录，CONFIG 里相对路径的基准（控制台里看一眼就知道拼对没有）
    repoBase: REPO_BASE, // 仓库根（js/ 的上一层）：界面层用它拼清单和模型地址，同样跟着本文件的来源走
    isMobile: isMobile,
    skipReason: skipReason,  // 看一眼当前地址会不会被 CONFIG.skipPath 拦掉（控制台里改完 CONFIG 再调它验）
    run: run,
  };

  if (MOBILE) {
    // 第一步就判完了：手机到这里收工，不注册监听、不下载、不插入任何东西。
    state.stage = '手机跳过';
    /* ▼ 日志调用点 */
    log('判定为手机浏览器，跳过：没有插入任何 js/css（想临时看一次就手动 live2dWinLoader.run()）',
      { ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }, 'info');
  } else if (SKIP) {
    // 第二道闸：管理后台这类页面同样收工，连“等原网页 load”的监听都不注册。
    state.stage = '管理页跳过';
    /* ▼ 日志调用点 */
    log('跳过：' + SKIP + '，没有插入任何 js/css（非要在这个页面看一次就 live2dWinLoader.CONFIG.force="desktop" 再 run()）',
      { pathname: location.pathname, skipPath: String(CONFIG.skipPath) }, 'info');
  } else {
    run();
  }
})();
