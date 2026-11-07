/* =============================================================================
 * live2d_win.js —— 桌面小窗控件（界面层）
 *
 * 分工：本文件只管“界面”（小窗 DOM、菜单栏、模型/服装列表、拖动、置底穿透、日志），
 *      模型的导入和交互在同目录的 live2d_model.js 里（全局对象 window.L2D，必须早于本文件执行）。
 * 谁来载入这两个文件：同目录的 live2d_win.loader.js（插入式启动器，手机浏览器访问时它整个跳过）。
 *
 * 结构（DOM 由本文件注入，样式在 ../css/live2d_win.css 里，同样由 loader 插入）：
 *   #App                 左下角小窗，边长随屏幕缩放（面积 ≈ 视口的 CONFIG.sizeRatio，默认 1/10 屏）
 *     ├ .app__body       本体，里面是 .app__canvas（PIXI 画布）+ Live2D 模型，和 div 一样大
 *     └ .app__panel      顶部悬浮面板（平时隐藏；只有鼠标靠近“这一条”才出现，停在立绘上不会展开）
 *         ├ .app__list   列表区（点“模型”出模型列表、点“服装”出同目录的服装列表，两份内容都是
 *         │              现场向 OpenList 分享目录列出来的，见【6.3】）
 *         └ .app__menu   菜单栏：模型 / 服装 / 声音 / 显示可点击区域 / 移动 / 关闭
 *                        每个按钮 = 一个 .app__icon 图标 + 一句提示文字
 *                        提示走页面自己的 tooltip（#AppTip，见【4.1】）：鼠标一停上去就出现，圆角可控
 *   #AppGhostClose       穿透模式下的“关闭”按钮（同样只有图标 + tooltip，靠近才出现，见【6.2】）
 *   #AppTip              上面那些提示文字用的那一个小盒子，全局只有一个，位置由 JS 算
 *                        （日志只显示在浏览器控制台，页面上不再有日志面板）
 *
 * 想调手感/时间/尺寸   → 只看【1. 配置区】（默认模型改 CONFIG.modelPath，换模型目录改 CONFIG.modelRoot）
 * 想增删模型/服装      → 不用改代码：文件放进服务器目录就行，点小窗“模型”会现扫（同一页面里想立刻看到新增：live2dWin.loadModelList(true)）
 * 想调模型贴合/滑动幅度/动作优先级 → 改 live2d_model.js 的 CONFIG
 * 想加/删菜单按钮      → 改【2. 菜单定义】的 ICON + MENU_ITEMS +【6. 按钮行为分发】加一个 case
 * 想改外观（配色/圆角/按钮和图标大小）→ 改 live2d_win.css
 * 想加/删日志调用点    → 全文搜 “日志调用点”，每处都是一行 log(...)，整行删掉即可
 * ============================================================================= */
(function () {
  'use strict';

  /* ============================ 1. 配置区 ============================ */
  var CONFIG = {
    sizeRatio: 0.11,        // 小窗面积占视口面积的比例（0.1 = 十分之一屏），窗口缩放自动跟着变大变小
    modelRoot: 'http://192.168.1.20:5244/@s/38nasKch/live2d-win/live2d', // 模型根目录在 OpenList 上的分享地址（@s = 浏览器点进去能看到文件夹那一层）。
                             // 文件地址由它换出来：路径里的 @s 换成 sd → …/sd/38nasKch/live2d/菊理千姬/model3.json。
                             // ★ 换服务器、换分享只改这一处；留空就按 modelSub 自动推断（见【6.3】autoModelRoot）。
    modelSub: 'live2d',      // 只在 modelRoot 留空时用：从页面/脚本地址推出分享根（…/@s/<token>）后，接在它后面的模型目录名
    modelScanDepth: 3,       // “模型”列表从 modelRoot 往下最多钻几层（1 = 只看这一层）：誓约/朱诺 就在第 3 层
    modelScanMax: 6,         // 扫描时同时开几个列目录请求（扫到几个就先显示几个，不用等全部扫完）
    modelPath: '菊理千姬/model3.json', // 打开页面时先加载这个；之后点“模型”按钮换。
                             // ★ 写的是 modelRoot 后面那一段：…/@s/38nasKch/live2d/菊理千姬/model3.json
    modelTryMax: 4,          // “模型”列表选文件夹时，同目录多个 modelN.json 从编号大的开始试，最多试几个
    modelListMax: '40vh',    // 模型列表最多占多高，超出就内部滚动（免得顶出屏幕）
    nearDistance: 72,        // 鼠标距菜单栏（顶部那块面板）多少像素内 → 展开；停在立绘里不算
                             // 离开这个范围立刻收起，没有延时（CSS 那边也去掉了淡出）
    dblClickWindow: 350,     // “关闭”按钮判定为双击的时间窗口（毫秒）
    normalZ: 2147483000,     // 正常模式层级（置顶）
    passThroughZ: -1,        // 穿透模式层级（真正压到页面内容下面）。发现小窗看不见就改成 0
    ghostZ: 2147483646,      // 穿透模式下“关闭”按钮的层级（保证仍可点）
  };

  /* ============================ 2. 菜单定义 ============================ */
  /* 增删按钮只改这个数组。
   * key   唯一标识，对应【6. 按钮行为分发】里的 case 分支
   * label 按钮名字：写进 data-tip（鼠标停在按钮上时立即冒出来的那句提示），同时作为 aria-label
   * icon  按钮图标，内联 SVG 字符串
   *
   * 图标来自 Tabler Icons（https://tabler.io/icons，MIT 授权），
   * 由 Iconify API 取回：https://api.iconify.design/tabler/<名字>.svg
   * 都是 fill=none + stroke=currentColor 的 24×24 图标，
   * 所以颜色跟 CSS 的 color 走、大小跟 font-size 走（见 live2d_win.css 的 --app-icon-size）。 */
  var ICON = {
    model: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0-8 0M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>',
    cloth: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4l6 2v5h-3v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-8H3V6l6-2a3 3 0 0 0 6 0"/></svg>',
    voice: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8a5 5 0 0 1 0 8m2.7-11a9 9 0 0 1 0 14M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5A.8.8 0 0 1 11 5v14a.8.8 0 0 1-1.5.5z"/></svg>',
    hit: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3m6-9v3M7.8 7.8L5.6 5.6m10.6 2.2l2.2-2.2M7.8 16.2l-2.2 2.2M12 12l9 3l-4 2l-2 4z"/></svg>',
    move: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 9l3 3l-3 3m-3-3h6M6 9l-3 3l3 3m-3-3h6m0 6l3 3l3-3m-3-3v6m3-15l-3-3l-3 3m3-3v6"/></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  };

  var MENU_ITEMS = [
    { key: 'model', label: '模型', icon: ICON.model },
    { key: 'cloth', label: '服装', icon: ICON.cloth }, // 列出当前模型那个目录里的 model*.json（一套 = 一件服装），点一下换装
    { key: 'voice', label: '声音', icon: ICON.voice },
    { key: 'hit', label: '显示可点击区域', icon: ICON.hit }, // 一键在立绘上画出所有命中区域的边框
    { key: 'move', label: '移动', icon: ICON.move },  // 按住这个按钮可直接拖动小窗
    { key: 'close', label: '关闭', icon: ICON.close }, // 单击置底穿透 / 再点恢复 / 快速双击销毁
  ];

  /* ============================ 3. 样式变量 ============================ */
  /* 样式本体在 ../css/live2d_win.css 里（由 loader 插进页面，index.html 不用写 <link>）。
   * 这里只把 CONFIG 里那几个和 CSS 共用的数值写到 :root 的 CSS 变量上，
   * 这样改 CONFIG 就够了，不会出现 JS 和 CSS 各写一套数字对不上。
   * 想调外观（圆角、配色、按钮大小、图标大小）直接改 live2d_win.css。 */

  /**
   * 小窗边长（px）：让这块方框的“面积”≈ 视口面积 × CONFIG.sizeRatio，
   * 所以 1/10 屏就是方框占掉屏幕十分之一（1920×1080 下约 455px），窗口缩放时实时重算。
   * 想按“屏幕高度的 1/10”那种小尺寸，把下面换成 `Math.min(vw, vh) * CONFIG.sizeRatio` 即可。
   * 刚打开的窗口/自动化浏览器里视口可能是 0，先用常见桌面尺寸兜底，第一次 resize 就换成真实值。
   * @returns {number} 边长
   */
  function appSize() {
    var vw = window.innerWidth || 1920;
    var vh = window.innerHeight || 1080;
    return Math.round(Math.sqrt(vw * vh * CONFIG.sizeRatio));
  }

  function applyCssVars() {
    var root = document.documentElement;
    root.style.setProperty('--app-size', appSize() + 'px');
    root.style.setProperty('--app-list-max', CONFIG.modelListMax);
    root.style.setProperty('--app-z', String(CONFIG.normalZ));
    root.style.setProperty('--app-pt-z', String(CONFIG.passThroughZ));
    root.style.setProperty('--ghost-z', String(CONFIG.ghostZ));
  }
  applyCssVars();

  /* ============================ 4. 建 DOM ============================ */
  var app = document.createElement('div');
  app.id = 'App';

  var body = document.createElement('div');
  body.className = 'app__body';
  var label = document.createElement('span');
  label.className = 'app__label';
  label.textContent = 'L2D';
  body.appendChild(label); // 模型加载成功后这行占位文字会被隐藏

  var panel = document.createElement('div');
  panel.className = 'app__panel';

  var menu = document.createElement('div');
  menu.className = 'app__menu';
  menu.setAttribute('role', 'menubar');

  /* 列表区：点“模型”显示模型列表、点“服装”显示当前模型同目录的服装列表，
   * 都排在菜单栏的上面（面板是底部对齐的，所以它只会往上长，
   * 菜单栏的位置和小窗都不会被挤动）。见【6.3】。 */
  var modelList = document.createElement('div');
  modelList.className = 'app__list';
  var listHead = document.createElement('div');
  listHead.className = 'app__list__head';
  var listBox = document.createElement('div');
  listBox.className = 'app__list__body';
  modelList.appendChild(listHead);
  modelList.appendChild(listBox);

  /**
   * 按钮里只放图标，名字写进 data-tip，由下面那个 #AppTip 小盒子显示（见【4.1】）。
   * 不用浏览器原生 title：它要等约 1 秒才出来，圆角/配色也完全不受页面控制。
   * aria-label 还是要写：读屏软件认它，不认 data-tip。
   * @param {HTMLButtonElement} btn 目标按钮
   * @param {string} icon 内联 SVG 字符串
   * @param {string} name 提示文字
   * @returns {void}
   */
  function fillButton(btn, icon, name) {
    var box = document.createElement('span');
    box.className = 'app__icon';
    box.innerHTML = icon;                 // 图标是这里内置的固定 SVG 常量，不是用户输入
    btn.appendChild(box);
    btn.dataset.tip = name;
    btn.setAttribute('aria-label', name);
    btn.addEventListener('pointerenter', function () { showTip(btn); });
    btn.addEventListener('pointerleave', hideTip);
    btn.addEventListener('pointerup', hideTip);   // 穿透模式的 ghost 键：点完就把提示收掉
    btn.addEventListener('pointercancel', hideTip);
  }

  /* ---------- 4.1 悬浮提示：鼠标一停上去就出现，圆角/配色都在 live2d_win.css 里改 ---------- */
  /* 整个页面只用这一个 #AppTip 盒子：文字和位置在 showTip() 里现算。
   * 它挂 body 而不是塞进 .app__menu，原因和 ghost“关闭”键一样 ——
   * #App 是 position:fixed，自成层叠上下文，穿透模式下整块沉到底层，里面的东西浮不上来。 */
  var tip = document.createElement('div');
  tip.id = 'AppTip';
  tip.setAttribute('aria-hidden', 'true'); // 纯装饰，读屏有 aria-label 就够了
  document.body.appendChild(tip);

  /**
   * 把提示框显示在指定元素旁边（默认下方，下面顶到屏幕边就翻到上方；左右夹在视口内）。
   * @param {HTMLElement} el 带 data-tip 的元素
   * @returns {void}
   */
  function showTip(el) {
    var text = el.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    // 收着的时候只是 visibility:hidden，仍占布局，所以这一步量得到宽高，能先把位置摆好再显示
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var r = el.getBoundingClientRect();
    var left = clamp(r.left + r.width / 2 - w / 2, 4, Math.max(4, window.innerWidth - w - 4));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 6);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add('is-show');
  }

  /**
   * 收起提示框（鼠标离开、开始拖动、点完 ghost“关闭”键、小窗被销毁时都走这里）。
   * @returns {void}
   */
  function hideTip() {
    tip.classList.remove('is-show');
  }

  MENU_ITEMS.forEach(function (item) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app__item is-' + item.key;
    fillButton(btn, item.icon, item.label); // data-tip + aria-label 都在这里一起写
    btn.dataset.key = item.key;
    btn.dataset.name = item.label;          // 日志里用（按钮里只剩图标，没有文字可取）
    btn.setAttribute('role', 'menuitem');
    menu.appendChild(btn);
  });

  panel.appendChild(modelList); // 先列表后菜单：列表显示在菜单栏上方
  panel.appendChild(menu);
  app.appendChild(panel);
  app.appendChild(body);

  /* 穿透模式专用“关闭”按钮：必须挂在 body 下、不能放在 #App 里。
   * 原因：position:fixed 会让 #App 自成层叠上下文，#App 一旦降到底层，
   * 它内部的按钮就再也浮不上来，会被画布盖住点不到。 */
  var ghostClose = document.createElement('button');
  ghostClose.id = 'AppGhostClose';
  ghostClose.type = 'button';
  fillButton(ghostClose, ICON.close, '关闭'); // tooltip 和 aria-label 同为“关闭”

  document.body.appendChild(app);
  document.body.appendChild(ghostClose);

  /* ============================ 5. 靠近检测 ============================ */
  /* 两种模式各有一套“靠近才显示”的浮层，判定共用下面这几个函数：
   *   正常模式   → #App 顶部菜单栏（.app__panel）
   *   穿透模式   → 挂在 body 上的 ghost“关闭”键（#AppGhostClose）
   * 判定只认“浮层自己”的矩形：鼠标停在人物模型（小窗本体）里一律算“远”，
   * 所以只有把鼠标移到菜单栏那一横条附近，菜单栏才会展开。
   * （菜单栏是 visibility:hidden 不是 display:none，收着的时候照样量得到矩形，
   *   所以“靠近一个还没出现的菜单栏”是能判定的。） */
  var state = {
    drag: null,         // 按住“移动”按钮拖动中：{ id, dx, dy, moved }
    passthrough: false, // 是否已置底 + 鼠标穿透
    lastCloseAt: 0,     // 上次点“关闭”的时间戳（判断双击用）
    near: false,        // 当前模式的那套浮层是否正处于“已靠近显示”状态
    mx: -9999,          // 最近一次鼠标位置（切换模式后立刻按它重算靠近状态用）
    my: -9999,
    ghostDx: 0,         // ghost“关闭”键相对 #App 左上角的偏移，见 rememberGhostAnchor
    ghostDy: -44,
    modelPath: '',      // 当前模型的完整取文件地址（…/sd/<token>/live2d/菊理千姬/model3.json）
    modelName: '',      // 显示名：换模型时是文件夹名，换服装时是「文件夹 · 服装 N」
    switching: false,   // 正在换模型（连点时只处理第一次）
  };
  var closed = false;   // 小窗已被彻底关闭

  /** 点在这个矩形里面吗（用来把“鼠标停在立绘上”挡在靠近判定之外） */
  function inRect(r, x, y) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** 点到矩形的最短距离：在框里是 0，在框外就是到最近那条边的距离 */
  function rectDistance(r, x, y) {
    var dx = Math.max(r.left - x, 0, x - r.right);
    var dy = Math.max(r.top - y, 0, y - r.bottom);
    return Math.hypot(dx, dy);
  }

  /**
   * 鼠标到“当前该出现的那块浮层”的距离：正常模式是顶部面板（菜单栏 + 列表），
   * 穿透模式是 ghost“关闭”键。小窗本体（人物模型）不参与判定，
   * 鼠标只要还在立绘里就直接算“远”，这样就不会出现“一摸人物菜单栏就弹出来”。
   * @param {number} x 鼠标横坐标（视口）
   * @param {number} y 鼠标纵坐标（视口）
   * @returns {number} 距离（px）；停在模型里时是 Infinity
   */
  function distanceToPanel(x, y) {
    if (inRect(app.getBoundingClientRect(), x, y)) return Infinity;
    var r = state.passthrough
      ? ghostClose.getBoundingClientRect()
      : panel.getBoundingClientRect();
    return rectDistance(r, x, y);
  }

  /** 靠近状态同时驱动两块浮层：正常模式的菜单栏 / 穿透模式的 ghost 关闭键 */
  function applyNear(on) {
    state.near = on;
    app.classList.toggle('is-near', on && !state.passthrough);
    ghostClose.classList.toggle('is-near', on && state.passthrough);
  }

  function onPointerMove(e) {
    if (closed) return;
    state.mx = e.clientX;
    state.my = e.clientY;
    /* 靠近就展开、离开立刻收起，中间没有任何延时 */
    applyNear(distanceToPanel(state.mx, state.my) <= CONFIG.nearDistance);
  }

  /* ============================ 6. 按钮行为分发 ============================ */
  menu.addEventListener('click', function (e) {
    var btn = e.target.closest('.app__item');
    if (btn) handleAction(btn.dataset.key, btn);
  });

  /**
   * 菜单按钮的统一入口。新增功能 = MENU_ITEMS 加一项 + 这里加一个 case。
   * @param {string} key 菜单项的 key
   * @param {HTMLButtonElement} btn 对应的按钮元素（取 dataset.name 用于日志）
   * @returns {void}
   */
  function handleAction(key, btn) {
    switch (key) {
      case 'move':
        /* ▼ 日志调用点 */
        log('「移动」：按住按钮直接拖动小窗', null, 'action');
        break;
      case 'close':
        onCloseClick(); // 关闭有自己的一套单击/双击逻辑
        break;
      case 'model':
        toggleModelList(); // 弹出/收起模型列表，见【6.3】
        break;
      case 'cloth':
        toggleClothList(); // 弹出/收起当前模型同目录的服装列表，见【6.3】
        break;
      case 'hit':
        toggleHitAreas(); // 让引擎层把所有命中区域的描边框显示出来/收回去，见【6.4】
        break;
      case 'voice':
        /* ▼ 日志调用点：占位提示，功能实现后这一行可以删掉 */
        log('菜单「' + btn.dataset.name + '」功能还没实现', { key: key }, 'warn');
        break;
      default:
        break;
    }
  }

  /* ---------- 6.1 移动：按住“移动”按钮直接拖动小窗 ---------- */
  /* 菜单面板是跟着 #App 定位的，所以按下时记下“鼠标 - 小窗左上角”的偏移，
   * 之后每帧都用同一个偏移反算位置：小窗不会跳，按钮也始终压在鼠标底下。 */
  app.addEventListener('pointerdown', function (e) {
    if (state.passthrough) return;
    if (!e.target.closest('.app__item.is-move')) return; // 只有“移动”按钮能拖
    var r = app.getBoundingClientRect();
    state.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    e.preventDefault(); // 免得拖动时选中文字或触发浏览器原生拖拽
    hideTip();          // 拖动中提示框会留在原地，先收掉
    /* ▼ 日志调用点 */
    log('按住“移动”开始拖动', { left: Math.round(r.left), top: Math.round(r.top) });
  });

  /**
   * 小窗能贴到的最小 top。菜单栏在窗口上方 6px，而现在是“鼠标靠近菜单栏才展开”，
   * 真把窗口顶到浏览器外面，菜单栏就再也够不着了（关闭、换模型全都点不到），
   * 所以拖动和窗口缩放都给它留这么一条底线；屏幕太矮放不下时优先保证小窗可见。
   * @returns {number} 最小的 top（px）
   */
  function minAppTop() {
    var menuH = menu.getBoundingClientRect().height || 38; // 菜单栏平时收着也量得到高度
    return Math.min(menuH + 6, Math.max(0, window.innerHeight - appSize()));
  }

  function onDragMove(e) {
    if (!state.drag || e.pointerId !== state.drag.id) return;
    var r = app.getBoundingClientRect();
    state.drag.moved = true;
    placeApp(clamp(e.clientX - state.drag.dx, 0, Math.max(0, window.innerWidth - r.width)),
             clamp(e.clientY - state.drag.dy, minAppTop(), Math.max(0, window.innerHeight - r.height)));
  }

  function onDragEnd(e) {
    if (!state.drag || (e && e.pointerId !== state.drag.id)) return;
    var moved = state.drag.moved;
    state.drag = null;
    var r = app.getBoundingClientRect();
    /* ▼ 日志调用点 */
    log(moved ? '拖动结束' : '“移动”按下没挪动', { left: Math.round(r.left), top: Math.round(r.top) }, 'action');
  }

  /**
   * 把小窗放到指定的 left/top（穿透模式下同步“关闭”按钮位置）。
   * @param {number} left 相对视口左边距（px）
   * @param {number} top 相对视口上边距（px）
   * @returns {void}
   */
  function placeApp(left, top) {
    app.style.left = left + 'px';
    app.style.top = top + 'px';
    app.style.bottom = 'auto'; // 一旦手动定位就取消左下角吸附
    positionGhostClose();
  }

  /* ghost“关闭”键的定位：贴着菜单栏里那个“关闭”按钮原来的位置，不能跳。
   * 做法是进穿透前记下“关闭”按钮相对 #App 左上角的偏移（dx/dy），
   * 之后每次都用 #App 当前矩形 + 这个偏移还原，所以拖动、resize 都跟得上。
   * 记不到（面板当时不可测）就退回默认值：菜单栏右端、窗口上方 6px 处。 */
  function rememberGhostAnchor() {
    var btn = menu.querySelector('.app__item.is-close');
    if (!btn) return;
    var br = btn.getBoundingClientRect();
    var ar = app.getBoundingClientRect();
    if (!br.width || !br.height) return; // 面板没展开时量到的是 0
    state.ghostDx = br.left - ar.left;
    state.ghostDy = br.top - ar.top;
  }

  function positionGhostClose() {
    if (!ghostClose.classList.contains('is-show')) return;
    var r = app.getBoundingClientRect();
    ghostClose.style.left = Math.max(0, Math.min(r.left + state.ghostDx, window.innerWidth - ghostClose.offsetWidth)) + 'px';
    ghostClose.style.top = Math.max(0, r.top + state.ghostDy) + 'px';
  }

  /* 视口变化：小窗边长重新按 CONFIG.sizeRatio 算，div、画布、模型一起跟着缩放；
   * 顺便把小窗拉回可视区（并且别让菜单栏顶出屏幕外），免得窗口变小后跑到屏幕外面找不回来。 */
  function onResize() {
    applyCssVars();    // 新的 --app-size → #App 先变
    resizeCanvas();    // 画布 + 模型跟着新的内容区变
    var r = app.getBoundingClientRect();
    var left = clamp(r.left, 0, Math.max(0, window.innerWidth - r.width));
    var top = clamp(r.top, minAppTop(), Math.max(0, window.innerHeight - r.height));
    // 只有真跑出屏幕才改成固定 left/top；否则保留 CSS 的左下角吸附（窗口缩放时它会自己贴回去）
    if (left !== r.left || top !== r.top) placeApp(left, top);
    else positionGhostClose();
  }

  /**
   * 把 PIXI 画布和模型重新贴到 #App 当前的内容区（窗口缩放、模型刚加载时用）。
   * @returns {{ w: number, h: number }} 实际套用的尺寸
   */
  function resizeCanvas() {
    var cs = contentSize();
    if (!L2D || !L2D.app) return cs; // 渲染器还没建：initModel 会按当时的尺寸来
    L2D.resize(cs.w, cs.h);         // 画布 + 模型跟着新的内容区变（贴合规则在引擎层的 CONFIG.fit）
    return cs;
  }

  /* ---------- 全局事件绑定 ---------- */
  window.addEventListener('pointermove', onPointerMove); // 靠近检测
  window.addEventListener('pointermove', onDragMove);    // 拖动（挂 window：鼠标滑出小窗也不断）
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerleave', function () { applyNear(false); });

  /* ---------- 6.2 关闭：单击穿透 / 再击恢复 / 双击销毁 ---------- */
  function onCloseClick() {
    var now = Date.now();
    if (now - state.lastCloseAt <= CONFIG.dblClickWindow) {
      closeApp(); // 短时间内连点两下 → 直接关闭整个小窗
      return;
    }
    state.lastCloseAt = now;
    setPassthrough(!state.passthrough);
  }
  ghostClose.addEventListener('click', onCloseClick);

  /**
   * 置底 + 鼠标穿透：#App 降到最底层且不再接收鼠标事件，
   * 这时菜单栏换成 ghost“关闭”键，它和菜单栏一样平时不显示，只有鼠标靠近它自己才浮出来。
   * @param {boolean} on true=进入穿透，false=恢复正常
   * @returns {void}
   */
  function setPassthrough(on) {
    if (on) rememberGhostAnchor(); // 必须赶在加 is-passthrough 之前量，那时面板还在布局里
    state.passthrough = on;
    app.classList.toggle('is-passthrough', on);
    ghostClose.classList.toggle('is-show', on);
    if (on) state.drag = null; // 进穿透顺手放开没结束的拖动
    positionGhostClose();
    // 按最后一次鼠标位置立刻重判靠近：刚点完“关闭”时鼠标就停在按钮上，
    // ghost 键要能马上出现，后面的“快速双击销毁”才点得到。
    applyNear(distanceToPanel(state.mx, state.my) <= CONFIG.nearDistance);
    /* ▼ 日志调用点 */
    log(on ? '关闭(单击)：已置底 + 鼠标穿透，“关闭”键换成 ghost，只有鼠标靠近它自己才出现' : '关闭(再击)：恢复正常', null, 'action');
  }

  /**
   * 彻底关闭：移除小窗和它带出来的所有节点、解绑全局监听。
   * @returns {void}
   */
  function closeApp() {
    if (closed) return;
    closed = true;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    window.removeEventListener('resize', onResize);
    if (L2D) L2D.destroy(); // 模型 + 渲染器 + 交互一起在引擎层销毁
    app.remove();
    ghostClose.remove();
    tip.remove();
    /* ▼ 日志调用点 */
    log('双击关闭：小窗已移除（刷新页面可恢复）', null, 'warn');
  }

  /* ---------- 6.3 模型 / 服装列表：现场向 OpenList 的分享目录列，点一下就换 ---------- */
  /* 同一个分享有两种地址，token 一样、只有中间那一节不一样（@s ↔ sd，下面 swapShare 负责换算）：
   *   列目录（分享页）  http://host:5244/@s/38nasKch/live2d/菊理千姬   ← CONFIG.modelRoot 写的就是这一种
   *   取文件（真下载）  http://host:5244/sd/38nasKch/live2d/菊理千姬/model3.json
   * 列目录发 POST <站点>/api/fs/list，body 里 path 用第一种的路径部分。两个坑，改的时候别踩：
   *   1) path 必须是解码后的原文：写成 %E8%8F%8A… 会报 “object not found”，而 location.pathname 恰恰是编码过的，所以要 decodePath；
   *   2) 分享目录匿名就能列，但整站关了“游客”后，不带 /@s/<token> 的普通路径一律 401 —— 所以 path 一直带着分享前缀。
   * 扫描规则和项目根 tools/scan-live2d.mjs 一一对应（改一边记得改另一边）：
   *   1) 从 modelRoot 往下最多钻 CONFIG.modelScanDepth 层，哪个目录里有 model*.json 就把它当成一个模型目录，不再往深里找；
   *   2) 点“模型”时先试哪些 modelN.json：有同名 Moc_N.moc3 的优先（从大到小），一个都对不上就全按编号从大到小试（官方样例那种走这条）；
   *   3) 点“服装”看到的是该目录下所有 model*.json（编号从小到大），没对应 moc 的标一句提示，照样能点；
   *   4) 列表按中文拼音排（localeCompare + zh-Hans-CN）。
   * 列过的目录缓存在 dirCache：扫过的角色再点“服装”不会重新请求；服务器上新放了模型，用 live2dWin.loadModelList(true) 作废缓存重扫。
   * 列表框是同一个（.app__list），用 listMode 区分现在显示的是模型还是服装，所以两个按钮各点一次会互相替换。 */
  var modelRoot = parseModelRoot();      // 模型根目录换算出来的那几种地址，字段说明见 parseModelRoot
  var dirCache = {};                // 分享内的目录路径（末尾不带 /）→ Promise<列好的目录信息>
  var list = {                      // “模型”列表的扫描状态
    models: [],                               // models[] 一条 = { label, path, files, cloths }；path 是能直接取文件的目录地址（末尾带 /）
    running: false, done: false, error: '', promise: null,
    scanned: 0, queued: 0,          // 已列了几个目录 / 还有几个排在队列里（列表末尾那句进度用）
  };
  var cloth = {                     // “服装”列表当前显示的那几条（按当前模型所在目录现列）
    dir: '', entries: [], loading: false, error: '',
  };
  var listMode = 'model';           // 列表框当前显示的模式：'model' | 'cloth'

  /**
   * 把 CONFIG.modelRoot（留空时是 autoModelRoot 推出来的那条）拆成后面所有地方要用的地址。
   * @returns {{raw:string, origin:string, share:string, filePath:string, fileBase:string, api:string, name:string}}
   *   raw      配置里原来那条地址（日志里好认）
   *   origin   站点根，如 http://192.168.1.20:5244
   *   share    模型根在分享里的路径，如 /@s/38nasKch/live2d（解码过的原文，末尾不带 /）→ 列目录就用它
   *   filePath share 的取文件写法，如 /sd/38nasKch/live2d
   *   fileBase origin + filePath + '/'，模型 json/moc/贴图全部拼在这个后面
   *   api      列目录接口，如 http://192.168.1.20:5244/api/fs/list
   *   name     最后一节的名字（如 live2d），模型根自己也是一条模型时列表里显示它
   */
  function parseModelRoot() {
    var raw = (CONFIG.modelRoot || '').trim() || autoModelRoot();
    var a = document.createElement('a');              // 借浏览器拆地址：绝对/相对/带中文的都能吃
    a.href = raw || location.href;
    var share = decodePath(a.pathname).replace(/\/+$/, '');
    var origin = a.origin || (a.protocol + '//' + a.host);
    var filePath = swapShare(share, '@s', 'sd');
    var base = (window.OPENLIST_CONFIG && window.OPENLIST_CONFIG.base_path) || '';
    return {
      raw: raw,
      origin: origin,
      share: share,
      filePath: filePath,
      fileBase: origin + filePath + '/',
      api: origin + (base === '/' ? '' : base) + '/api/fs/list',
      name: share.split('/').pop() || '模型',
    };
  }

  /**
   * CONFIG.modelRoot 留空时的兜底：从当前页面地址或本脚本自己的地址里认出分享 token，再接上 CONFIG.modelSub。
   * @returns {string} 形如 http://192.168.1.20:5244/@s/38nasKch/live2d；认不出分享就回空串
   */
  function autoModelRoot() {
    var share = shareRootOf(location.pathname) || shareRootOf(scriptPath());
    if (!share) return '';
    return location.origin + share + (CONFIG.modelSub ? '/' + CONFIG.modelSub : '');
  }

  /**
   * 从一条路径里截出「分享根」那两节（/@s/<token>）；sd 写法一律换成 @s。
   * @param {string} pathname 如 /sd/38nasKch/openlist/js/live2d_win.js
   * @returns {string} 如 /@s/38nasKch；不是分享地址就回空串
   */
  function shareRootOf(pathname) {
    var parts = decodePath(pathname || '').split('/');
    for (var i = 1; i < parts.length; i++) {
      if (parts[i] === '@s' || parts[i] === 'sd') {
        parts[i] = '@s';
        return parts.slice(0, i + 2).join('/');       // @s + 后面那一节 token
      }
    }
    return '';
  }

  /** 本脚本（live2d_win.js）自己在服务器上的路径，页面地址不是分享时用它兜底 */
  function scriptPath() {
    var tags = document.getElementsByTagName('script');
    for (var i = 0; i < tags.length; i++) {
      if (/live2d_win\.js(\?|$)/.test(tags[i].src || '')) {
        var a = document.createElement('a');
        a.href = tags[i].src;
        return a.pathname;
      }
    }
    return '';
  }

  /** @s（列目录）和 sd（取文件）是同一个 token 的两种写法，这里按段换掉第一个碰到的 */
  function swapShare(path, from, to) {
    var parts = (path || '').split('/');
    for (var i = 1; i < parts.length; i++) {
      if (parts[i] === from) { parts[i] = to; break; }
    }
    return parts.join('/');
  }

  /** location.pathname 那种是 %E8%8F%8A… 编码过的，fs/list 只认原文；半截 % 会让 decode 抛错，那就原样返回 */
  function decodePath(path) {
    try { return decodeURIComponent(path); } catch (e) { return path; }
  }

  /** 分享目录路径 → 能直接取文件的目录地址（末尾带 /） */
  function fileBaseOf(share) {
    return modelRoot.origin + swapShare((share || '').replace(/\/+$/, ''), '@s', 'sd') + '/';
  }

  /**
   * 取文件用的目录地址 → 分享路径（fileBaseOf 的反向），好让“服装”能单列当前这一个目录。
   * @param {string} fileUrl 如 …/sd/38nasKch/live2d/菊理千姬/
   * @returns {string} 如 /@s/38nasKch/live2d/菊理千姬；不在模型根下面回空串
   */
  function shareOfFilePath(fileUrl) {
    if (!fileUrl) return '';
    var a = document.createElement('a');
    a.href = fileUrl;
    var path = decodePath(a.pathname).replace(/\/+$/, '');
    if (path.indexOf(modelRoot.filePath) === 0) return swapShare(path, 'sd', '@s');
    if (path.indexOf(modelRoot.share) === 0) return path;   // 有人直接拿 @s 地址来换模型也认
    return '';
  }

  /**
   * 列一个分享目录（同一个目录只发一次请求，结果留在 dirCache 里）。
   * @param {string} share 分享内的目录路径，如 /@s/38nasKch/live2d/菊理千姬（解码后的原文，末尾 / 有没有都行）
   * @param {boolean} [force] true = 不看缓存，并让服务器也别用它的目录缓存（refresh=true）
   * @returns {Promise<object>} parseDirItems 的结果：{ share, fileBase, files, cloths, dirs }
   */
  function listShareDir(share, force) {
    var key = (share || '').replace(/\/+$/, '');
    if (!force && dirCache[key]) return dirCache[key];
    var p = fetch(modelRoot.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: key, page: 1, per_page: 0, refresh: !!force,   // per_page=0 = 一次拿全，488 个文件的目录也是这样
        password: '', sign: '', sort: '', order: 'asc',
      }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; });   // 回来的不是 json（比如被换成页面）→ 当成失败，下面按 code 报错
    }, function (err) {
      throw new Error('请求没发出去：' + err.message);
    }).then(function (j) {
      if (j.code !== 200) throw new Error('code ' + (j.code || '?') + '：' + (j.message || '列目录失败'));
      return parseDirItems(key, (j.data && j.data.content) || []);   // 空目录回来 content 是 null
    });
    /* 列砸了的不留在缓存里，下次点还能重试（这句 catch 只是清理，不影响调用方拿到的 p） */
    p.catch(function () { delete dirCache[key]; });
    dirCache[key] = p;
    return p;
  }

  /**
   * 把一个目录里的文件名分成“model 编号 / moc 编号 / 子目录”，并按 scan-live2d.mjs 的规则排好序。
   * @param {string} share 这个目录的分享路径（末尾不带 /）
   * @param {Array} items fs/list 返回的 data.content
   * @returns {{share:string, fileBase:string, files:Array, cloths:Array, dirs:Array}}
   */
  function parseDirItems(share, items) {
    var nums = [], mocs = [], dirs = [];
    items.forEach(function (it) {
      var m;
      if (it.is_dir) { dirs.push(it.name); return; }
      m = /^model(\d*)\.json$/i.exec(it.name);
      if (m) { nums.push(m[1]); return; }                   // '' = 文件名就叫 model.json
      m = /^moc[_-]?(\d+).*\.moc3?$/i.exec(it.name);
      if (m) mocs.push(m[1]);
    });
    var hasMoc = {};
    mocs.forEach(function (n) { hasMoc[n] = true; });
    var files = nums.filter(function (n) { return n && hasMoc[n]; });   // 先试有同名 moc 的
    if (!files.length) files = nums.slice();                            // 一个都对不上就全试
    files.sort(function (a, b) { return (b | 0) - (a | 0); });
    var base = fileBaseOf(share);
    var cloths = nums.slice().sort(function (a, b) { return (a | 0) - (b | 0); }).map(function (n) {
      var ok = n === '' || !!hasMoc[n];
      return {
        n: n,
        moc: ok,
        path: base + 'model' + n + '.json',
        label: '服装 ' + (n === '' ? '（无编号）' : n) + (ok ? '' : '（没有对应 moc）'),
      };
    });
    return { share: share, fileBase: base, files: files, cloths: cloths, dirs: dirs };
  }

  /** 目录信息 → “模型”列表里的一条：label 用相对模型根的那段（和原来静态清单里的 name 一样） */
  function entryOf(info, rel) {
    return { label: rel ? rel.replace(/\/+$/, '') : modelRoot.name, path: info.fileBase, files: info.files, cloths: info.cloths };
  }

  /** 列表按中文拼音排（和 scan-live2d.mjs 一致） */
  function byName(a, b) { return String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'); }

  var renderTimer = null;   // 扫描过程中重画列表的节流计时器

  /** 边扫边显示：最多每 150ms 重画一次，省得几十个目录各刷一遍 */
  function renderSoon() {
    if (listMode !== 'model' || renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      renderModelList();
    }, 150);
  }

  /**
   * 从模型根往下扫一遍，把带 model*.json 的目录收成“模型”列表。
   * 只有点“模型”按钮时才会跑到这儿，页面打开不预先扫描（顺带扫一次是几十个请求）。
   * @param {boolean} [force] true = 连目录缓存一起作废重扫（服务器上新放了模型时用）
   * @returns {Promise<Array>} list.models
   */
  function scanModelList(force) {
    if (list.running) return list.promise;
    if (list.done && !force) return Promise.resolve(list.models);
    if (force) dirCache = {};
    list.running = true;
    list.error = '';
    list.scanned = 0;
    list.queued = 0;
    list.models = [];

    if (!shareRootOf(modelRoot.share)) {
      list.error = 'CONFIG.modelRoot 没填，也没从页面地址里认出分享目录（…/@s/<token>/…）';
      list.running = false;
      list.done = true;
      /* ▼ 日志调用点 */
      log('扫描模型目录：' + list.error, null, 'error');
      return Promise.resolve(list.models);
    }

    var queue = [{ share: modelRoot.share, rel: '', depth: 1 }];
    var found = [];

    /* 一格的活：列一个目录 → 有 model*.json 就收进列表（不再往深里找），否则把子目录排进队列继续钻 */
    function work(job) {
      return listShareDir(job.share, force).then(function (info) {
        list.scanned++;
        if (info.files.length) {
          found.push(entryOf(info, job.rel));
          found.sort(byName);
          list.models = found;
          renderSoon();
        } else if (job.depth < CONFIG.modelScanDepth && info.dirs.length) {
          info.dirs.forEach(function (name) {
            queue.push({ share: job.share + '/' + name, rel: job.rel + name + '/', depth: job.depth + 1 });
          });
        }
        return pump();
      }, function (err) {
        list.scanned++;
        if (!list.error) list.error = job.share + ' → ' + err.message;   // 单个目录列不开就跳过它，记下第一条错误别断整轮
        return pump();
      });
    }

    /* 从队列头取一个接着列，取空收工 —— 靠这个递归把 CONFIG.modelScanMax 条流水线跑满 */
    function pump() {
      var job = queue.shift();
      if (!job) return Promise.resolve();
      list.queued = queue.length;
      return work(job);
    }

    var pool = [];
    for (var i = 0; i < Math.max(1, CONFIG.modelScanMax); i++) pool.push(pump());

    list.promise = Promise.all(pool).then(function () {
      list.models = found.sort(byName);
    }, function (err) {
      list.error = list.error || err.message;
    }).then(function () {
      list.running = false;
      list.done = true;
      list.promise = null;
      list.queued = 0;
      pickClothDir(state.modelPath || defaultModelPath()); // 扫完了把服装那条对齐一下
      renderModelList();
      /* ▼ 日志调用点 */
      log('扫描 ' + modelRoot.share + '（往下 ' + CONFIG.modelScanDepth + ' 层）：列了 ' + list.scanned
        + ' 个目录 → ' + list.models.length + ' 个模型'
        + (list.error ? '（有目录没列开：' + list.error + '）' : ''),
        list.models, list.error ? 'warn' : 'action');
      return list.models;
    });
    return list.promise;
  }

  /**
   * 按“当前模型在哪个目录”准备服装列表：扫过的直接用，没扫过就单列这一个目录（不用等整棵树扫完）。
   * @param {string} path 模型文件地址（model*.json）；传目录也行
   * @returns {void}
   */
  function pickClothDir(path) {
    var dir = path ? path.replace(/model[^/]*\.json$/i, '') : '';
    var changed = cloth.dir !== dir;
    cloth.dir = dir;
    cloth.error = '';
    if (!changed) return;

    var hit = null;
    for (var i = 0; i < list.models.length; i++) {
      if (list.models[i].path === dir) { hit = list.models[i]; break; }
    }
    if (hit) {
      cloth.loading = false;
      cloth.entries = hit.cloths;
      /* ▼ 日志调用点 */
      log('服装列表：' + dir + ' → ' + cloth.entries.length + ' 套（扫描时已列过）', cloth.entries, 'action');
      renderModelList();
      return;
    }

    cloth.entries = [];
    var share = shareOfFilePath(dir);
    if (!share) {
      cloth.loading = false;
      cloth.error = '这个目录不在模型根（' + modelRoot.share + '）下面，列不出来：' + (dir || '（还不知道当前模型在哪个目录）');
      /* ▼ 日志调用点 */
      log('服装列表：' + cloth.error, null, 'warn');
      renderModelList();
      return;
    }

    cloth.loading = true;
    renderModelList();
    listShareDir(share).then(function (info) {
      cloth.loading = false;
      if (cloth.dir !== dir) return;                 // 期间又换过模型，这份结果已经没用了
      cloth.entries = info.cloths;
      /* ▼ 日志调用点 */
      log('服装列表：现列 ' + share + ' → ' + cloth.entries.length + ' 套', cloth.entries, 'action');
      renderModelList();
    }, function (err) {
      cloth.loading = false;
      if (cloth.dir !== dir) return;
      cloth.error = share + ' → ' + err.message;
      /* ▼ 日志调用点 */
      log('服装列表：列目录失败：' + cloth.error, null, 'error');
      renderModelList();
    });
  }

  /** 点“模型”按钮：展开/收起模型列表（在菜单栏上方）；第一次展开时才开始扫服务器目录 */
  function toggleModelList() {
    var open = !(modelList.classList.contains('is-open') && listMode === 'model');
    listMode = 'model';
    modelList.classList.toggle('is-open', open);
    /* ▼ 日志调用点 */
    log('菜单「模型」：' + (open ? '展开模型列表（在菜单栏上方，不挤模型）' : '收起模型列表'), null, 'action');
    if (!open) return;
    scanModelList();
    renderModelList();                               // 再画一次，马上能看到“正在列目录…”
  }

  /** 按当前模式重画列表：标题是在用的模型（换过服装会带“· 服装 N”），下面是要点选的条目 */
  function renderModelList() {
    listHead.textContent = '当前：' + (state.modelName || '（还没加载模型）');
    listBox.textContent = '';
    if (listMode === 'cloth') {
      if (cloth.loading) { listBox.appendChild(msg('正在列 ' + cloth.dir + ' …')); return; }
      if (!cloth.entries.length) {
        listBox.appendChild(msg(cloth.error
          ? '列服装失败：' + cloth.error
          : cloth.dir ? '这个目录里没有 model*.json：' + cloth.dir
          : '还不知道当前模型在哪个目录'));
        return;
      }
      cloth.entries.forEach(function (c, i) { listBox.appendChild(opt(c.label, c.path, i)); });
      return;
    }
    if (list.models.length) {   // 边扫边显示：扫到一个就先列一个，不用等整棵树扫完
      list.models.forEach(function (m, i) { listBox.appendChild(opt(m.label, m.path, i)); });
      if (list.running) listBox.appendChild(msg('还在扫：已列 ' + list.scanned + ' 个目录，还有 ' + list.queued + ' 个在排队…'));
      return;
    }
    if (list.running) { listBox.appendChild(msg('正在列 ' + modelRoot.share + ' …')); return; }
    if (list.done) {
      listBox.appendChild(msg('没扫到模型：' + (list.error || modelRoot.share + ' 往下 ' + CONFIG.modelScanDepth + ' 层里没有 model*.json')));
      return;
    }
    listBox.appendChild(msg('点一下就开始列 ' + modelRoot.share + '（扫到哪个显示哪个，只等第一次）'));
  }

  /**
   * 列表里的一个可点条目：显示文字是 label，完整路径只放进 aria-label。
   * 这里不给 title —— 菜单按钮才有 tooltip，列表条目一长串路径弹出来反而挡视线。
   * @param {string} text 条目上显示的文字
   * @param {string} path 这一项对应的完整路径（只给读屏/调试用）
   * @param {number} idx 在当前列表里的下标（点击时按它找回条目）
   * @returns {HTMLButtonElement} 按钮
   */
  function opt(text, path, idx) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app__opt';
    btn.textContent = text;
    btn.dataset.idx = String(idx);
    btn.setAttribute('aria-label', path);
    return btn;
  }

  /** 列表里的一行提示文字 */
  function msg(text) {
    var p = document.createElement('div');
    p.className = 'app__list__msg';
    p.textContent = text;
    return p;
  }

  listBox.addEventListener('click', function (e) {
    var btn = e.target.closest('.app__opt');
    if (!btn) return;
    var i = Number(btn.dataset.idx);
    if (listMode === 'cloth') pickCloth(cloth.entries[i]);
    else pickModel(list.models[i]);
  });

  /**
   * 换成选中的文件夹：按候选编号从大到小依次试，成功就替换旧模型并收起列表。
   * @param {object} entry scanModelList() 结果里的一项
   * @returns {void}
   */
  function pickModel(entry) {
    if (!entry || state.switching) return;
    state.switching = true;
    (function attempt(i) {
      if (i >= entry.files.length || i >= CONFIG.modelTryMax) {
        state.switching = false;
        /* ▼ 日志调用点 */
        log('「' + entry.label + '」试了 ' + i + ' 个 model*.json 都加载失败 → 保留原来的模型', null, 'error');
        return;
      }
      switchModel(entry.path + 'model' + entry.files[i] + '.json', entry.label).then(function (ok) {
        if (ok) {
          state.switching = false;
          modelList.classList.remove('is-open'); // 换好了就收起，把位置让回立绘
        } else {
          attempt(i + 1);
        }
      });
    })(0);
  }

  /* ---------- 服装：拿“当前模型所在目录”的 cloths（扫过就用缓存，没扫过单列那一个目录） ---------- */

  /**
   * 打开页面时该加载哪个模型：CONFIG.modelPath 写的是 CONFIG.modelRoot 后面那一段。
   * @returns {string} 完整地址（…/sd/<token>/live2d/菊理千姬/model3.json）
   */
  function defaultModelPath() {
    return modelRoot.fileBase + CONFIG.modelPath;
  }

  /** 点“服装”按钮：展开/收起服装列表；内容是当前模型那个目录里的 model*.json */
  function toggleClothList() {
    var open = !(modelList.classList.contains('is-open') && listMode === 'cloth');
    listMode = 'cloth';
    modelList.classList.toggle('is-open', open);
    /* ▼ 日志调用点 */
    log('菜单「服装」：' + (open ? '展开服装列表（当前模型同目录）' : '收起服装列表'), null, 'action');
    if (!open) return;

    pickClothDir(state.modelPath || defaultModelPath()); // 这个目录没列过就会去列一次（一个请求，不用扫整棵树）
    renderModelList();
  }

  /**
   * 换成选中的那套服装：走和换模型同一条路（新模型加载成功才销毁旧的，失败就保留当前这套）。
   * @param {object} entry 当前目录 cloths[] 的一项
   * @returns {void}
   */
  function pickCloth(entry) {
    if (!entry || state.switching) return;
    state.switching = true;
    switchModel(entry.path, labelOfModel(entry.path) + ' · 服装 ' + (entry.n === '' ? '（无编号）' : entry.n))
      .then(function (ok) {
        state.switching = false;
        if (ok) modelList.classList.remove('is-open'); // 换好了就收起，把位置让回立绘
      });
  }

  /* ---------- 6.4 显示可点击区域：按钮只翻引擎层的那个开关 ---------- */
  /**
   * 一键显示/隐藏立绘上所有命中区域的描边框。
   * 真正的绘制在 live2d_model.js 里（结果日志也由它那条「可点击区域：…」给出，这里不重复写一条）。
   * @returns {void}
   */
  function toggleHitAreas() {
    if (!L2D) {
      /* ▼ 日志调用点 */
      log('菜单「显示可点击区域」：找不到引擎层 window.L2D（index.html 里没引 live2d_model.js？）', null, 'error');
      return;
    }
    L2D.toggleHitAreas();
  }

  /* ============================ 7. 模型：接线到引擎层 ============================ */
  /* 界面层只管三件事：量内容区、往 .app__body 里塞那块 canvas、维护占位文字和列表标题；
   * 渲染器、模型导入、点击/滑动交互、可点击区域显示全在 window.L2D（live2d_model.js）里。 */
  var L2D = window.L2D;

  /**
   * 真正能画图的尺寸：量 .app__body（#App 现在没有边框，所以它等于整个 --app-size）。
   * 量的是实际盒子，以后谁再给 #App 加回边框/内边距，画布尺寸会自动跟着变小，
   * 不会被 .app__body 的 overflow:hidden 裁掉一圈。
   * 拿不到（还没进 DOM 等）就退回当前算出来的边长。
   * @returns {{ w: number, h: number }} 内容区宽高（CSS 像素）
   */
  function contentSize() {
    var fallback = appSize();
    return { w: body.clientWidth || fallback, h: body.clientHeight || fallback };
  }

  /**
   * 在 #App 本体里开一块和它内容区同尺寸的透明画布，交给引擎建渲染器，再把默认模型导进来。
   * 画布是 .app__body 的子节点，所以拖动、置底、销毁都自动带着模型一起走。
   * @returns {void}
   */
  function initModel() {
    if (!L2D) {
      /* ▼ 日志调用点 */
      log('页面里没有 window.L2D（index.html 少引了 live2d_model.js？），模型不加载，小窗只留占位文字', null, 'warn');
      return;
    }
    L2D.log = log; // 引擎层的日志也走这份 log，控制台里前缀统一成一个

    var canvas = document.createElement('canvas');
    canvas.className = 'app__canvas';
    body.appendChild(canvas);

    var cs = contentSize(); // 按实际能画图的尺寸建画布
    if (!L2D.attach(canvas, cs.w, cs.h)) return; // 渲染器没起来就别白白发模型请求

    /* 默认模型的地址是 CONFIG.modelRoot 直接换算出来的，不用先问服务器 → 开页面就加载。
     * “模型/服装”列表等你点那两个按钮时才去列目录（整棵树扫一次是几十个请求，不该压在页面打开上）。 */
    switchModel(defaultModelPath(), labelOfModel(defaultModelPath()));
  }

  /**
   * 从 model*.json 的路径推出一个好读的名字：取它所在的文件夹名。
   * @param {string} path 模型文件路径
   * @returns {string} 显示名
   */
  function labelOfModel(path) {
    var parts = path.replace(/\/+$/, '').split('/');
    parts.pop();                        // 去掉文件名
    return parts.pop() || path;         // 文件夹名；直接在根目录就退回整条路径
  }

  /**
   * 换成指定路径的模型：导入交给引擎，只有真成功了界面才跟着改。
   * 加载失败时引擎自己会留一条错误日志，界面这边保持原样（立绘、标题都不动）。
   * @param {string} path model*.json 的相对路径
   * @param {string} [name] 列表标题和日志里显示的名字，不传就取模型所在的文件夹名
   * @returns {Promise<boolean>} 是否切换成功
   */
  function switchModel(path, name) {
    if (!L2D) return Promise.resolve(false);
    var shown = name || labelOfModel(path);
    return L2D.load(path, shown).then(function (ok) {
      if (!ok) return false;
      // 以“加载完成时”的实际尺寸再贴一次：建画布那一刻视口可能还没定下来（量到过 0×0）
      resizeCanvas();
      label.remove();                 // 有立绘了，占位文字去掉（已经去过就是空操作）
      body.classList.add('is-model'); // 本体背景改透明
      state.modelPath = path;
      state.modelName = shown;
      pickClothDir(path);             // 服装列表跟着换到新模型那个目录（没列过会顺手去列一次）
      renderModelList();
      return true;
    });
  }

  /* 暴露给其它脚本/控制台调用；不需要的话连【8. 日志模块】一起删掉即可 */
  window.live2dWin = {
    app: app,
    CONFIG: CONFIG,
    state: state,      // 运行时状态：passthrough / near / mx,my / drag / lastCloseAt / modelPath
    log: log,
    close: closeApp,
    switchModel: switchModel,    // live2dWin.switchModel('http://192.168.1.20:5244/sd/38nasKch/live2d/誓约/朱诺/model2.json') 可直接换（要写完整地址）
    toggleHitAreas: toggleHitAreas, // 和菜单按钮同一个入口：显示/隐藏可点击区域
    loadModelList: scanModelList,   // 扫模型目录（扫过了直接用缓存；live2dWin.loadModelList(true) = 连目录缓存一起作废重扫）
    listDir: listShareDir,          // live2dWin.listDir('/@s/38nasKch/live2d/菊理千姬') 单列一个分享目录，看服务器上到底有什么文件
    get modelRoot() { return modelRoot; },   // CONFIG.modelRoot 换算出来的那几种地址（share/fileBase/api）
    get modelEntries() { return list.models; },  // 扫出来的模型条目（path 已经是能取文件的目录地址）
    get clothEntries() { return cloth.entries; }, // 当前这个目录列出来的那几套服装
    get listMode() { return listMode; },          // 列表框现在显示的是 model 还是 cloth
    get L2D() { return L2D; },     // 引擎层整体：L2D.model / L2D.app / L2D.state / L2D.hitAreas()
  };

  /* ============================ 8. 日志模块 ============================ */

  /**
   * ─────────────────────── 日志函数（只输出到浏览器控制台） ───────────────────────
   * 把一条操作日志写到控制台；页面上没有日志面板，想看得打开 F12。
   *
   * 用法：
   *   log('点了移动按钮')                       → 普通信息（console.log）
   *   log('移动模式：开', { left: 10, top: 20 })  → 附带数据（控制台原样带上，可以展开看）
   *   log('功能未实现', null, 'warn')            → 指定级别（决定用哪个 console 方法）
   *
   * 后期维护：
   *   · 删某条日志 → 删掉那行的 log(...) 调用（源码搜“日志调用点”能一次找全）
   *   · 加新日志   → 在新功能处照抄一行 log('文案', 数据, 'action')
   *   · 想在页面上也显示 → 自己建一个 div，在这个函数里按 level 拼一行 textContent 追加进去
   *   · 不想留任何痕迹 → 删掉整个【8. 日志模块】，再删各处 log(...) 调用
   *
   * @param {string} message 主文案，建议写成“动作 + 结果”，例如「移动模式：开」
   * @param {*} [detail] 可选附加数据（对象/数字/字符串均可）
   * @param {"info"|"action"|"warn"|"error"} [level] 级别：
   *        info=普通操作(console.log)，action=开关类重要动作(console.info)，
   *        warn=警告或未实现(console.warn)，error=错误(console.error)
   * @returns {void}
   * @example
   *   log('点击菜单', { key: 'move' }, 'action');
   */
  function log(message, detail, level) {
    var tag = '[live2dWin]';
    if (level === 'error') console.error(tag, message, detail);
    else if (level === 'warn') console.warn(tag, message, detail);
    else if (level === 'action') console.info(tag, message, detail);
    else console.log(tag, message, detail);
  }

  /**
   * 把数值限制在 [min, max] 区间内。
   * @param {number} v 原值
   * @param {number} min 下限
   * @param {number} max 上限
   * @returns {number} 限制后的值
   */
  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  /* ▼ 日志调用点：初始化完成 */
  log('小窗已启动（左下角 ' + appSize() + '×' + appSize() + '，约占屏幕 '
      + Math.round(CONFIG.sizeRatio * 100) + '% 面积，鼠标靠近窗口上方那一横条才展开菜单栏）', null, 'action');

  initModel(); // 把 Live2D 模型画进 #App，尺寸与 div 的内容区一致
})();
