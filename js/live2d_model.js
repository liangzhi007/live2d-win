/* =============================================================================
 * live2d_model.js —— Live2D 引擎层：模型导入 + 鼠标交互 + 可点击区域显示
 *
 * 和 live2d_win.js 的分工（两个文件都只认这一个边界）：
 *   live2d_win.js    只管“界面”：左下角小窗 DOM、菜单栏、模型/服装列表、拖动、置底穿透
 *   live2d_model.js  只管“模型”：建渲染器、导入模型、贴合尺寸、点击/滑动交互、显示可点击区域、定时播放
 * 载入顺序必须是本文件在前、live2d_win.js 在后（由 live2d_win.loader.js 按 CONFIG.js 的顺序串行插入）。
 *
 * 对外只暴露一个全局对象 window.L2D：
 *   L2D.attach(canvas)            在这块 canvas 上建 PIXI 渲染器       → 是否成功
 *   L2D.resize(w, h)              渲染器和模型跟着新尺寸走
 *   L2D.load(path, name)          导入/更换模型                        → Promise<boolean>
 *   L2D.toggleHitAreas([force])   一键显示/隐藏可点击区域              → 现在的开关状态
 *   L2D.playIdle()                立刻播一个"定时播放"的动作           → 是否真播了
 *   L2D.stopIdle()/L2D.restartIdle()  暂停/重新开始定时播放
 *   L2D.destroy()                 销毁模型和渲染器
 *   L2D.model / L2D.app / L2D.state / L2D.CONFIG                       调试用
 *   L2D.log = fn                  界面层可以把自己的日志函数塞进来（不塞就用 console）
 *
 * 功能来自隔壁 live2dv3 的 `js/live2d copy.js`，只搬了这四件：
 *   【3】导入模型（顺带读同目录的 model*.json 配置，交互全靠它）
 *   【4】点击命中区域播放动作
 *   【5】鼠标上下/左右滑动播放动作（读模型 json 里的 InteractionConfig）
 *   【6】显示可点击区域（HitAreaFrames）
 * copy.js 里剩下的表情按钮、预设动作按钮、模型框架、拖动模型、摸头长按、showRunStep 都没搬。
 * 【7】定时播放动作是本文件自己加的，copy.js 里没有（间隔见 CONFIG.idleEvery）。
 * ============================================================================= */
(function (global) {
  'use strict';

  /* ============================ 1. 配置区 ============================ */
  var CONFIG = {
    fit: 'contain',        // contain=完整塞进画布(竖版会左右留白) cover=铺满(头脚被裁掉)
    alignX: 'left',        // 横向贴哪边：left=人物尽量靠左 / center=居中 / right=靠右
    alignY: 'center',      // 纵向贴哪边：top=尽量靠上 / center=居中 / bottom=靠下
    alignByPixels: true,   // 贴边按“真正画出来的像素”算，而不是按模型画布尺寸：
                           // 模型画布四周常留一圈空白（比如 401×401 的画布里人物只占 x 27~343），
                           // 关掉这条就变成只贴画布边，人物看着基本没动
    edgePad: 0,            // 贴边时再让开几像素（不想让人物真的碰到窗口边就调大）
    boxSamples: 24,        // 量人物包围盒时采几帧取并集：人物一直在轻微动，只量一帧会切掉手或头发
                           // 设成 1 就退化成"加载完量一次"
    boxSampleEvery: 3,     // 每隔几帧采一次（1=每帧都采，量得快但那一秒会比较卡）
    maxResolution: 2,      // 画布分辨率上限：实际取 min(这个值, devicePixelRatio)
    hitPriority: 2,        // 点击命中区域播动作的优先级（1=闲置 2=普通 3=强制）
    cursorOnHit: true,     // 鼠标停在"点了有反应"的命中区域上时变小手（头部的「摸头」就在其中）
    cursorHand: 'pointer', // 悬停时用的光标，就是小手；想换别的样式改这里（grab / move / zoom-in …）
    cursorPressed: 'grabbing', // 按下不放时换的光标（松手就变回上面那个）；填 '' = 按住也不换
    cursorAreas: null,     // 填了就只有这几个区域名显示小手，比如 ['摸头'] = 只有头会变；
                           // 这里不要求"点了有反应"，所以裙子那种只能上下滑的也能列进来；
                           // null = 配了交互的区域都变（判据见 areaHand：能点播动作的、写过 Motion 的、
                           // InteractionConfig 里配过的都算，范围比"点击真的会播"宽一点）
    dragPriority: 3,       // 上下/左右滑动时播动作的优先级
    dragStep: 0.01,        // 鼠标每移动 1px 参数变化多少（和 copy.js 一致，嫌反应慢就调大）
    dragMin: 0,            // 滑动参数的下限
    dragMax: 1,            // 滑动参数的上限
    faceOn: '脸红',        // 开始滑动时切的表情；模型没定义这个表情就跳过
    faceOff: '正常',       // 松手后切的表情；同上
    idleEvery: 10000,      // ★★★ 每隔多少毫秒自动播一个动作，10000 = 10 秒。
                           //     改这一行就行；填 0（或负数）= 不要定时播放，只在控制台手动 L2D.playIdle()
    idleGroups: null,      // 自动播时只从这些动作组里挑，比如 ['Idle', '1', '2']；
                           // null = 这个模型 json 里所有动作组都算（组内哪一条是随机取的）
    idleWeights: { Leave10_20_30: 4 , 掀裙子后: 0},
                           // ★★★ 谁多播谁少播就看这里：组名 = 权重，数字越大越容易挑中。
                           //     没列进来的组一律按下面的 idleWeight 算，所以这条里是
                           //     Leave10_20_30 占 4、其它组各占 1（菊理千姬 18 个组的话，
                           //     平均大约 4/21 ≈ 每五次里有一次是它）。
                           //     想再偏心就调大数字，想少播就调小（1 比 4 就是它的四分之一），
                           //     写 0 = 这个组永远不自动播（掀裙子那种不想让它乱播就填 0）。
    idleWeight: 1,         // 没写进 idleWeights 的组的默认权重（只有比例有意义，整体放大缩小都一样）
    idlePriority: 2,       // 到点时先用这个优先级把动作起起来：2=普通，能盖掉一直在循环的闲置动作；
                           //     用户正在点击(2)/滑动(3)播的动作会把它挡在后面，不会插一脚
    idleHold: 1,           // 起好之后马上把这个动作的优先级改成 1（闲置级）——
                           //     这样用户一点一滑立刻能把它换掉；要填回 2 就等于"定时动作播完前点击不让路"，
                           //     实测点击会有几秒没反应，一般别改
    idleAvoidRepeat: 2,    // 连续几次内不重复播同一个动作组（1=只避开上一次，0=完全随机可能连着重复）
  };

  /* ============================ 2. 运行时状态 ============================ */
  var st = {
    canvas: null,
    app: null,            // PIXI.Application
    model: null,          // 当前的 Live2DModel
    json: null,           // 当前模型 model*.json 解析出来的内容（HitAreas/Motions/InteractionConfig 都在里面）
    path: '',
    name: '',
    w: 0, h: 0,           // 界面层给的实际可画尺寸
    contentBox: null,     // 人物真正画出来的那块，归一化成模型画布的 0~1（量一次，窗口缩放照用）
    boxTried: false,      // 这个模型是否已经试过读像素量包围盒（失败不反复试，退回按画布贴）
    boxRun: 0,            // 采样任务编号：换模型或销毁时 +1，正在跑的采样发现自己过期就收摊
    boxMeasuring: false,  // 正在采样：这段时间把模型钉在 (0,0)，免得人物被贴边切掉、量不准
    frames: null,         // HitAreaFrames（可点击区域的描边框）
    frameTexts: [],       // 它初始化时生成的全部区域标签，切换显示时从这里挑
    hitAreasOn: false,    // 可点击区域当前是否显示
    idleTimer: 0,         // 定时播放的 setInterval 编号，0 = 没在跑
    idleRecent: [],       // 最近播过的动作组（用来别连着重复同一个）
  };

  /* 整块模型画布（0~1）：没量到人物包围盒时就用它贴边 */
  var FULL_BOX = { l: 0, r: 1, t: 0, b: 1 };

  /* ============================ 3. 模型导入 ============================ */

  /**
   * 在界面层给的那块 canvas 上建一个透明背景的 PIXI 渲染器。
   * @param {HTMLCanvasElement} canvas 已经在 #App 里排好版的画布
   * @param {number} [w] 初始宽度（CSS 像素），不传就从 canvas 自己的尺寸量
   * @param {number} [h] 初始高度（CSS 像素）
   * @returns {boolean} 是否成功（页面里没有 PIXI.live2d 就返回 false）
   */
  function attach(canvas, w, h) {
    if (!global.PIXI || !global.PIXI.live2d || !global.PIXI.live2d.Live2DModel) {
      log('页面里没有 PIXI.live2d，模型功能不可用', null, 'error');
      return false;
    }
    if (!canvas) { log('attach 没拿到 canvas', null, 'error'); return false; }

    st.canvas = canvas;
    st.w = w || canvas.clientWidth || 300;
    st.h = h || canvas.clientHeight || 300;
    st.app = new global.PIXI.Application({
      view: canvas,
      width: st.w,
      height: st.h,
      backgroundAlpha: 0,   // 只要立绘，不要底色
      antialias: true,
      resolution: Math.min(CONFIG.maxResolution, global.devicePixelRatio || 1),
      autoDensity: true,    // 让 canvas 的 CSS 尺寸 = 逻辑尺寸，鼠标坐标才对得上
    });
    /* ▼ 日志调用点 */
    log('渲染器已就绪', { 尺寸: st.w + '×' + st.h, 分辨率: st.app.renderer.resolution }, 'action');
    return true;
  }

  /**
   * 界面层改了尺寸（窗口缩放、边框增删）时调它：渲染器 + 模型一起跟着变。
   * @param {number} w 新的可画宽度（CSS 像素）
   * @param {number} h 新的可画高度（CSS 像素）
   * @returns {void}
   */
  function resize(w, h) {
    if (!st.app || !w || !h) return;
    st.w = w;
    st.h = h;
    st.app.renderer.resize(w, h);
    if (st.model) fit();
  }

  /**
   * 导入模型：先读 model*.json（交互配置在里面），再建 Live2DModel，成功后才销毁旧模型。
   * 顺序是“新的加载出来 → 加进舞台 → 销毁旧的”，万一中途失败，窗口里还是原来那个，不会变空白。
   * @param {string} path model*.json 的相对路径
   * @param {string} [name] 日志里显示的名字，不传就用路径
   * @returns {Promise<boolean>} 是否切换成功
   */
  function load(path, name) {
    if (!st.app) return Promise.resolve(false);
    /* ▼ 日志调用点 */
    log('开始导入模型', { path: path });

    return readJson(path).then(function (json) {
      return global.PIXI.live2d.Live2DModel.from(path).then(function (model) {
        var old = st.model;
        st.model = model;
        st.json = json;
        st.path = path;
        st.name = name || path;
        st.app.stage.addChild(model);

        model.interactive = true; // 打开 PIXI 的鼠标事件，hit/pointerdown 这些才有
        setupHitAreaMotions(model, json);
        setupHitAreaCursor(model, json);
        setupDragMotions(model, json);
        setupHitAreaFrames(model);

        st.idleRecent = [];   // 换模型了，"最近播过哪些组"重新记
        restartIdle();        // 定时播放重新开始计时（间隔每次都现读 CONFIG.idleEvery）

        setCursor('');           // 换模型了，先收回小手，等新模型上真 hovered 到区域再变

        st.contentBox = null;  // 换模型了，人物在画布里的位置要重量
        st.boxTried = false;
        st.boxRun++;           // 上一个模型还没量完的采样，作废
        st.boxMeasuring = false;
        if (old) {
          st.app.stage.removeChild(old);
          old.destroy(); // 连内部模型/动效/描边框一起释放；纹理留在 PIXI 缓存里，换回去不用重下
        }
        fit();
        /* ▼ 日志调用点 */
        log('已导入模型 → ' + st.name + '（' + path + '）', {
          画布: st.w + '×' + st.h,
          贴合: Math.round(model.width) + '×' + Math.round(model.height),
          命中区域: (json.HitAreas || []).length,
          动作组: Object.keys(motionNames(json)).length,
          滑动配置: json.InteractionConfig ? '有' : '无',
          舞台子节点: st.app.stage.children.length,
        }, 'action');
        return true;
      });
    }).catch(function (err) {
      /* ▼ 日志调用点 */
      log('模型导入失败：' + err.message + ' → ' + path + (st.model ? '（保留原来的模型）' : ''), null, 'error');
      return false;
    });
  }

  /**
   * 销毁模型 + 渲染器（小窗被关掉时用）。
   * @returns {void}
   */
  function destroy() {
    stopIdle(); // 小窗都没了，定时器也要跟着停，不然会一直空转
    if (st.model) { st.model.destroy(); st.model = null; }
    if (st.app) { st.app.destroy(true); st.app = null; } // 连同 canvas 一起清
    st.json = null;
    st.frames = null;
    st.frameTexts = [];
    st.hitAreasOn = false;
    st.contentBox = null;
    st.boxTried = false;
    st.boxRun++;
    st.boxMeasuring = false;
  }

  /**
   * 把模型缩放到刚好贴合画布（scale 必须先归一：model.width 里含着上一次的缩放），
   * 再按 CONFIG.alignX / alignY 摆到指定的边上。
   * @returns {void}
   */
  function fit() {
    var model = st.model;
    if (!model || !st.w || !st.h) return;
    model.scale.set(1);
    var s = CONFIG.fit === 'cover'
      ? Math.max(st.w / model.width, st.h / model.height)
      : Math.min(st.w / model.width, st.h / model.height);
    model.scale.set(s);
    place();          // 改完 scale，model.width/height 才是缩放后的实际尺寸
    measureOnce();    // 换了模型还没量过包围盒：量一次，量到了再按人物本身摆一遍
  }

  /**
   * 只摆位置（不动缩放）。贴边用的是 st.contentBox —— 人物实际画出来的那圈像素，
   * 因为模型画布普遍比人物大一圈，按画布贴边等于白贴。量不到就退回整块画布。
   * @returns {void}
   */
  function place() {
    var model = st.model;
    if (!model || !st.w || !st.h) return;
    /* 采样期间钉在左上角：contain 贴合后模型画布正好铺满画布，
     * 这个位置一幅都不切，量到的包围盒才是人物本来的大小。 */
    if (st.boxMeasuring) { model.x = 0; model.y = 0; return; }
    var bx = boxFor(CONFIG.alignX), by = boxFor(CONFIG.alignY);
    model.x = alignPos(CONFIG.alignX, st.w, model.width, bx.l, bx.r, CONFIG.edgePad);
    model.y = alignPos(CONFIG.alignY, st.h, model.height, by.t, by.b, CONFIG.edgePad);
  }

  /**
   * 这条轴要不要用“人物包围盒”来贴。贴边（left/right/top/bottom）才用，
   * 居中仍旧按模型画布算 —— 不然一改 alignX，上下位置也会被顺手挪走。
   * @param {string} mode CONFIG.alignX / CONFIG.alignY 的值
   * @returns {Object} {l,r} 或 {t,b} 用的 0~1 比例
   */
  function boxFor(mode) {
    var edge = mode === 'left' || mode === 'right' || mode === 'top' || mode === 'bottom';
    return edge && CONFIG.alignByPixels && st.contentBox ? st.contentBox : FULL_BOX;
  }

  /**
   * 一维对齐：人物占着模型画布里 from~to 这一段（0~1 比例），要把它贴到 len 长的画布哪一头。
   * @param {string} mode left/top、right/bottom 或其它（=居中）
   * @param {number} len 画布这条轴的长度（CSS px）
   * @param {number} size 缩放后的模型画布这条轴的长度（CSS px）
   * @param {number} from 人物起点（占模型画布的比例）
   * @param {number} to 人物终点（占模型画布的比例）
   * @param {number} pad 贴边时额外让开的像素
   * @returns {number} 模型该放的坐标（CSS px，可以是负数 = 让人物压出去一点）
   */
  function alignPos(mode, len, size, from, to, pad) {
    if (mode === 'left' || mode === 'top') return pad - from * size;
    if (mode === 'right' || mode === 'bottom') return len - pad - to * size;
    return (len - size) / 2;
  }

  /**
   * 读一次当前帧的像素，量出人物在模型画布里的位置（存成不随缩放变的 0~1 比例）。
   * 注意 extract.pixels() 不能传对象：传了就变成“按对象自己的包围盒重画一份”，
   * 量出来和人物在画布里的实际位置无关；只有不带参数才是真在读这块画布的帧缓冲。
   * @returns {(Object|boolean|null)} {l,t,r,b}；这一帧还是全透明返回 null（可能还没画出来）；
   *                                   这个环境读不了帧缓冲返回 false（别再重试了）
   */
  function measureContentBox() {
    var model = st.model, app = st.app;
    if (!model || !app) return false;
    var px, rw, rh, res;
    try {
      app.render();   // 先真把这一帧画进 framebuffer，紧接着读才读得到内容
      res = app.renderer.resolution || 1;
      rw = app.renderer.width;
      rh = app.renderer.height;
      px = app.renderer.plugins.extract.pixels();
    } catch (err) {
      /* ▼ 日志调用点 */
      log('贴边对齐：这个环境读不了画布像素（' + err.message + '），只能按模型画布贴', null, 'warn');
      return false;
    }
    if (!px || px.length < rw * rh * 4) return null;
    var minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (var y = 0; y < rh; y++) {
      var row = y * rw * 4;
      for (var x = 0; x < rw; x++) {
        if (px[row + x * 4 + 3] > 8) { // alpha>8 才算真画上去了，忽略一圈快看不见的抗锯齿边
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;   // 整幅全透明：多半是模型还没画出来
    return {
      l: (minX / res - model.x) / model.width,
      r: (maxX / res - model.x) / model.width,
      // readPixels 的原点在左下角，纵向要翻回从上往下
      t: ((rh - 1 - maxY) / res - model.y) / model.height,
      b: ((rh - 1 - minY) / res - model.y) / model.height,
    };
  }

  /**
   * 把两帧量到的包围盒并成一块（取最外面那圈）：只要有一帧人物伸得更远，最终就按更远的算，
   * 这样贴边时任何姿势都不会被切掉。
   * @param {?Object} cur 已经累计的结果，第一帧传 null
   * @param {?Object} one 这一帧量到的，读不到传 null（原样返回 cur）
   * @returns {?Object} 合并后的 {l,t,r,b}
   */
  function unionBox(cur, one) {
    if (!one) return cur;
    if (!cur) return one;
    return {
      l: Math.min(cur.l, one.l), r: Math.max(cur.r, one.r),
      t: Math.min(cur.t, one.t), b: Math.max(cur.b, one.b),
    };
  }

  /**
   * 每个模型只量一次包围盒，但一次要连着采好几帧再取并集（人物一直在轻微动）。
   * 采样的这一秒模型钉在 (0,0) 展示，采完立刻按人物本身贴边；量不到就退回按画布贴。
   * @returns {void}
   */
  function measureOnce() {
    if (!CONFIG.alignByPixels || st.boxTried) return;
    st.boxTried = true;
    var run = ++st.boxRun;
    var remain = Math.max(1, CONFIG.boxSamples);
    var every = Math.max(1, CONFIG.boxSampleEvery);
    var tick = 0, box = null;
    st.boxMeasuring = true;
    place(); // 先钉住，第一次 fit() 之后的那一帧开始就是可量状态

    /**
     * 收摊：存结果（量不到就是 null，退回按画布贴）并按正常规则摆一次。
     * @returns {void}
     */
    function finish() {
      st.boxMeasuring = false;
      st.contentBox = box;
      place();
      if (!box) return;
      /* ▼ 日志调用点 */
      log('量好人物的位置了', {
        画布: st.w + '×' + st.h,
        采样: CONFIG.boxSamples + ' 帧 / 每 ' + CONFIG.boxSampleEvery + ' 帧一次',
        横向: Math.round(box.l * st.model.width) + '~' + Math.round(box.r * st.model.width),
        纵向: Math.round(box.t * st.model.height) + '~' + Math.round(box.b * st.model.height),
      });
    }

    /** @returns {void} */
    function step() {
      if (run !== st.boxRun) return;        // 过期了（换模型/销毁），本次作废
      if (!st.model || !st.app) { st.boxMeasuring = false; return; }
      if (tick % every === 0 && remain > 0) {
        var one = measureContentBox();
        if (one === false) { st.boxMeasuring = false; place(); return; } // 这环境压根读不了像素
        box = unionBox(box, one);
        remain--;
      }
      tick++;
      if (remain > 0) { global.requestAnimationFrame(step); return; }
      finish();
    }
    global.requestAnimationFrame(step);
  }

  /** 读模型 json（HitAreas / FileReferences.Motions / InteractionConfig 都在这里） */
  function readJson(path) {
    return fetch(path).then(function (res) {
      if (!res.ok) throw new Error('读不到模型配置：HTTP ' + res.status + '（' + path + '）');
      return res.json();
    });
  }

  /** 这个模型有哪些动作组（组名 → 动作文件列表） */
  function motionNames(json) {
    return (json.FileReferences && json.FileReferences.Motions) || {};
  }

  /** 这个模型有哪些表情名；没有 Expressions 就返回空数组 */
  function expressionNames(json) {
    return ((json.FileReferences && json.FileReferences.Expressions) || [])
      .map(function (e) { return e && e.Name; })
      .filter(Boolean);
  }

  /**
   * 切表情：只在这个模型真的定义了这个表情时才切。
   * copy.js 里是硬写 model.expression('脸红')，换成没配表情的模型就会白白报一条警告。
   * @param {object} model Live2DModel
   * @param {string} name 表情名
   * @returns {void}
   */
  function setFace(model, name) {
    if (!name || !st.json) return;
    if (expressionNames(st.json).indexOf(name) < 0) return;
    model.expression(name);
  }

  /* ============================ 4. 点击命中区域播放动作 ============================ */
  /* pixi-live2d-display 在鼠标点中模型上的命中区域时会 emit('hit', [区域名...])，
   * 区域名取自 model*.json 的 HitAreas[].Name。用哪个动作组只认「区域名」和「动作组名」这两个，
   * json 里 HitAreas[].Motion 写的是什么一概不看，两轮都对上才算能点：
   *   1) 区域名本身就是一个动作组名 —— 「嘴」→组「嘴」、「肚子」→组「肚子」；
   *   2) 区域名去掉第一个字之后**整个等于**组名 —— 「左胸」→「胸」 ✓、「1月亮」→「月亮」 ✓；
   *      「左胸1」去掉第一个字是「胸1」，和组「胸」差一个 1，就不算 ✓（这是和旧写法的区别）。
   * 两轮都没有就当这个区域不能点，不再猜别的。 */
  function setupHitAreaMotions(model, json) {
    var idx = hitAreaIndex(json);

    model.on('hit', function (areas) {
      var group = pickGroup(areas, idx.groups);
      if (!group) {
        /* 挑不到组分两种：区域本来就没打算能点（裙子这种只能滑的、或纯装饰），点了没反应是设计如此，
         * 不值得记日志；json 里给它写过 Motion 的要说一句——那个字段现在不参与匹配了，
         * 免得以后看见「内裙1 配的是 内裙，点了怎么没反应」以为哪儿坏了。 */
        var written = areas.filter(function (n) { return idx.byArea[n]; });
        if (written.length) {
          /* ▼ 日志调用点 */
          log('点中「' + areas.join('、') + '」和动作组对不上，不播（json 的 Motion 写的「' +
            written.map(function (n) { return idx.byArea[n]; }).join('、') + '」现在不作数）', null, 'warn');
        }
        return;
      }
      model.motion(group, undefined, CONFIG.hitPriority);
      /* ▼ 日志调用点 */
      log('点击命中区域 ' + areas.join('、') + ' → 播放动作「' + group + '」', null, 'action');
    });
  }

  /**
   * 这个模型的匹配材料：全部动作组名（真正用来对账的）、HitAreas 里写的 区域名→Motion
   * （不参与点击匹配，只用来认"这个部位是配了交互的"和日志那句话）、
   * 以及 InteractionConfig 里出现过的区域名（头部/能滑的那些）。
   * @param {Object} json model*.json 解析出来的内容
   * @returns {Object} {groups, byArea, inConfig}
   */
  function hitAreaIndex(json) {
    var byArea = {};
    (json.HitAreas || []).forEach(function (area) {
      if (area && area.Name && area.Motion) byArea[area.Name] = area.Motion;
    });
    var ic = json.InteractionConfig || {};
    var inConfig = {};
    [].concat(ic.headArea || []).forEach(function (n) { if (n) inConfig[n] = true; });
    eachArea(ic['上下'], function (n) { inConfig[n] = true; });
    eachArea(ic['左右'], function (n) { inConfig[n] = true; });
    return { groups: Object.keys(motionNames(json)), byArea: byArea, inConfig: inConfig };
  }

  /**
   * 按上面那两轮挑出动作组名，两轮都挑不到就返回空字符串（不再往下猜，也绝不看 Motion 字段）。
   * @param {Array<string>} areas 点中的区域名（按 model*.json 里的先后顺序）
   * @param {Array<string>} groups 这个模型的全部动作组名
   * @returns {string} 动作组名，挑不到是 ''
   */
  function pickGroup(areas, groups) {
    var round, i, name;
    for (round = 0; round < 2; round++) {          // 第一轮原样，第二轮去掉第一个字
      for (i = 0; i < areas.length; i++) {
        name = round ? areas[i].slice(1) : areas[i];
        if (name && groups.indexOf(name) >= 0) return name;
      }
    }
    return '';
  }

  /* ------------------- 【4.5】鼠标停在能点的区域上变小手，按住再换一个样式 ------------------- */
  /* copy.js 那边（setupHeadCursor）只认 INTERACTION_CONFIG.headArea 一个区域，
   * 这里改成"碰了有反应的区域都变小手"（判据见 areaHand）：点击会播动作的、HitAreas 里写过
   * Motion 的（如「内裙1」）、InteractionConfig 里配了的（头部的「摸头」、能滑的「裙子」）都算。
   * 也就是说小手的范围比"点击真的会播"宽一点：像「内裙1」点了不播，但照样给小手。
   * 想只让某几个区域变小手，就填 CONFIG.cursorAreas —— 那是白名单，填了就只认名单。 */
  function setupHitAreaCursor(model, json) {
    var idx = hitAreaIndex(json);
    var pressed = false; // 按住状态：不盯着它的话，按住拖动时一动就从小手变回悬停样式

    /**
     * 画布上这个坐标是不是该给特殊光标的命中区域。
     * CONFIG 都是那一刻现读的，控制台里改完马上就能试效果。
     * @param {Object} p 画布坐标 {x,y}
     * @returns {boolean}
     */
    function handAt(p) {
      var allowed = CONFIG.cursorAreas && CONFIG.cursorAreas.length ? CONFIG.cursorAreas : null;
      return showHand(model.hitTest(p.x, p.y), idx, allowed);
    }

    /**
     * 按指针现在的位置重算光标（按着不放时用 cursorPressed）。
     * @param {Object} e PIXI 事件，只用它的 e.data.global（画布坐标）
     * @returns {void}
     */
    function update(e) {
      if (!CONFIG.cursorOnHit) { setCursor(''); return; }
      if (!handAt(e.data.global)) { setCursor(''); return; }
      setCursor(pressed && CONFIG.cursorPressed ? CONFIG.cursorPressed : CONFIG.cursorHand);
    }

    /** 彻底收回：松手、移出人物都走这里。 */
    function reset() {
      pressed = false;
      setCursor('');
    }

    model.on('pointermove', update);
    model.on('pointerdown', function (e) {
      pressed = !!CONFIG.cursorOnHit && handAt(e.data.global); // 按在不是小手的部位上就别装成能按的样子
      update(e);
    });
    model.on('pointerup', function (e) { pressed = false; update(e); }); // 松手：立刻按悬停规则重算
    model.on('pointerleave', reset);      // PIXI 在松手时也会补发一个 pointerleave，所以 pointerup 要先重算
    model.on('pointerupoutside', reset);  // 在人物外面松手
  }

  /**
   * 鼠标落在这些区域名上要不要显示小手。
   * @param {Array<string>} areas model.hitTest 的结果
   * @param {Object} idx hitAreaIndex 的结果
   * @param {?Array<string]} allowed 白名单（CONFIG.cursorAreas），null=不限
   * @returns {boolean}
   */
  function showHand(areas, idx, allowed) {
    for (var i = 0; i < areas.length; i++) {
      if (allowed) {
        if (allowed.indexOf(areas[i]) >= 0) return true;  // 写了白名单就只认名单，不再管能不能点
        continue;
      }
      if (areaHand(areas[i], idx)) return true;
    }
    return false;
  }

  /**
   * 这个区域算不算"碰了有反应"，小手提示按这条来，比点击能不能播动作宽一点：
   *   1) 两轮名字规则挑得到动作组（点了真会播，如「左胸」「1头发」「嘴」）；
   *   2) HitAreas 里给它写过 Motion —— 点击虽然不播了，但它本来就是个配了交互的部位，
   *      比如「内裙1」（写的是 内裙）；
   *   3) InteractionConfig 里出现过 —— 头部的「摸头」、按住能滑的「裙子」。
   * 三条都不占就当它不能碰，鼠标过去不变小手。
   * @param {string} name 区域名
   * @param {Object} idx hitAreaIndex 的结果
   * @returns {boolean}
   */
  function areaHand(name, idx) {
    return !!pickGroup([name], idx.groups) || !!idx.byArea[name] || !!idx.inConfig[name];
  }

  /** 小手是加在 canvas 元素自己的 style 上：传空字符串就交还给 CSS，变回普通箭头。 */
  function setCursor(v) {
    if (st.canvas && st.canvas.style.cursor !== v) st.canvas.style.cursor = v;
  }

  /* ============================ 5. 鼠标上下/左右滑动播放动作 ============================ */
  /* 这两个功能都由模型 json 里的 InteractionConfig 决定（没有就整个跳过）：
   *   "上下": [{ "裙子": ["PARAM_WEIQUN_XIAN", "掀裙子时", "掀裙子后"] }]
   *   "左右": [{ "左腿": ["PARAM_CHEWAZI_02", "", "腿"] }]
   * 每项是 { 命中区域名: [参数ID, 按住时播的动作, 松手后播的动作] }，动作名可以是空字符串。
   * 上下和左右的区别只有两点：滑动方向（上为正 / 横向取绝对值）、以及松手后要不要继续顶住参数。 */
  function setupDragMotions(model, json) {
    var ic = json.InteractionConfig;
    if (!ic) return;

    var freezes = []; // 松手后仍要持续写回的参数：[{ parameterId, value }]
    model.internalModel.on('afterModelUpdate', function () {
      for (var i = 0; i < freezes.length; i++) {
        setParam(model, freezes[i].parameterId, freezes[i].value);
      }
    });

    eachArea(ic['上下'], function (areaName, cfg) {
      setupAxisDrag(model, areaName, cfg, 'y', true);
    });
    eachArea(ic['左右'], function (areaName, cfg) {
      setupAxisDrag(model, areaName, cfg, 'x', false);
    });
    /* ▼ 日志调用点 */
    log('已装好滑动交互', {
      上下: countAreas(ic['上下']),
      左右: countAreas(ic['左右']),
    }, 'action');
  }

  /** InteractionConfig 的上下/左右是「数组套一个对象」，这里摊平成 (区域名, [参数,按下动作,松开动作]) 回调 */
  function eachArea(list, cb) {
    (list || []).forEach(function (item) {
      Object.keys(item || {}).forEach(function (areaName) { cb(areaName, item[areaName]); });
    });
  }

  /** 数一下配置里有几个区域（只为日志好看） */
  function countAreas(list) {
    var n = 0;
    eachArea(list, function () { n++; });
    return n;
  }

  /**
   * 装一个方向的滑动交互。
   * @param {object} model Live2DModel
   * @param {string} areaName 触发它的命中区域名
   * @param {Array} cfg [参数ID, 按住时播的动作, 松手后播的动作]
   * @param {'x'|'y'} axis 用鼠标哪个方向的位移驱动参数
   * @param {boolean} keep 松手后是否继续把这个参数顶在最后的值上（掀裙子这类需要）
   * @returns {void}
   */
  function setupAxisDrag(model, areaName, cfg, axis, keep) {
    var parameterId = cfg && cfg[0];
    if (!parameterId) return;
    var downMotion = cfg[1] || '';
    var upMotion = cfg[2] || '';
    var drag = null;   // { startX, startY, startValue }
    var freeze = null; // { parameterId, value }

    model.on('pointerdown', function (e) {
      var p = e.data.global;
      if (model.hitTest(p.x, p.y).indexOf(areaName) < 0) return;

      setFace(model, CONFIG.faceOn);
      if (downMotion) model.motion(downMotion, undefined, CONFIG.dragPriority);
      drag = { startX: p.x, startY: p.y, startValue: getParam(model, parameterId) };
      freeze = { parameterId: parameterId, value: drag.startValue };
      /* ▼ 日志调用点 */
      log('按住「' + areaName + '」开始' + (axis === 'y' ? '上下' : '左右') + '滑动', { 参数: parameterId, 起始值: drag.startValue });
    });

    model.on('pointermove', function (e) {
      if (!drag) return;
      var p = e.data.global;
      // 上下：往上拖为正；左右：左右都算（取绝对值），和 copy.js 保持一致
      var distance = axis === 'y' ? drag.startY - p.y : Math.abs(p.x - drag.startX);
      var value = clamp(drag.startValue + distance * CONFIG.dragStep, CONFIG.dragMin, CONFIG.dragMax);
      setParam(model, parameterId, value);
      if (freeze) freeze.value = value; // 松手后 keep 的话就靠这个值继续顶住动作
    });

    function finish() {
      if (!drag) return;
      var last = freeze ? freeze.value : 0;
      drag = null;
      setFace(model, CONFIG.faceOff);
      if (upMotion) model.motion(upMotion, undefined, CONFIG.dragPriority);

      if (keep) {
        // 掀裙子这类松手后要维持合上的状态，而且动作还会每帧把这个参数写回去，所以留个常驻的 freeze
        freeze = { parameterId: parameterId, value: CONFIG.dragMin };
        setParam(model, parameterId, CONFIG.dragMin);
      } else {
        freeze = null;
        setParam(model, parameterId, 0);
      }
      /* ▼ 日志调用点 */
      log('「' + areaName + '」滑动结束' + (keep ? '，参数顶回 ' + CONFIG.dragMin : '，参数复位'), { 结束值: last, 动作: upMotion || '（没配）' }, 'action');
    }

    model.on('pointerup', finish);
    model.on('pointerupoutside', finish);
  }

  /** 读/写模型的参数（moc 里没这个 ID 时返回 0 / 直接忽略，不让它把交互打断） */
  function getParam(model, id) {
    try {
      return model.internalModel.coreModel.getParameterValueById(id) || 0;
    } catch (e) {
      log('读参数失败：' + id, { 原因: e.message }, 'warn');
      return 0;
    }
  }

  /** @returns {void} */
  function setParam(model, id, value) {
    try {
      model.internalModel.coreModel.setParameterValueById(id, value);
    } catch (e) {
      log('写参数失败：' + id, { 原因: e.message }, 'warn');
    }
  }

  /* ============================ 6. 显示可点击区域 ============================ */
  /* HitAreaFrames 是 extra.min.js 提供的描边控件：把它挂成模型的子节点，
   * 它就会按 model*.json 的 HitAreas 在每个区域上画一个框。
   * 它的绘制只认自己的 texts 数组（复制.js 里就是这么筛的），所以：
   *   显示 → texts = 全部标签；隐藏 → texts = []（一个都不画）。
   * 平时标签是收着的，鼠标指到哪个区域才亮出那一个的名字。 */
  function setupHitAreaFrames(model) {
    st.frames = null;
    st.frameTexts = [];
    if (!global.PIXI.live2d.HitAreaFrames) {
      /* ▼ 日志调用点 */
      log('这个 PIXI.live2d 里没有 HitAreaFrames，可点击区域显示不了', null, 'warn');
      return;
    }
    var frames = new global.PIXI.live2d.HitAreaFrames();
    model.addChild(frames);            // 必须等模型已经进了舞台，它才会在 added 里把 texts 建出来
    st.frameTexts = frames.texts.slice();
    frames.texts = st.hitAreasOn ? st.frameTexts.slice() : []; // 换模型时保留上次的开关状态
    st.frames = frames;
  }

  /**
   * 一键显示/隐藏可点击区域。
   * @param {boolean} [force] 指定必须是显示(true)或隐藏(false)，不传就在当前状态上取反
   * @returns {boolean} 现在的状态（true=正在显示）
   */
  function toggleHitAreas(force) {
    if (!st.frames) {
      /* ▼ 日志调用点 */
      log('现在没有可显示的可点击区域（模型还没导入，或这个模型没有 HitAreas）', null, 'warn');
      return false;
    }
    st.hitAreasOn = (typeof force === 'boolean') ? force : !st.hitAreasOn;
    st.frames.texts = st.hitAreasOn ? st.frameTexts.slice() : [];
    /* ▼ 日志调用点 */
    log('可点击区域：' + (st.hitAreasOn ? '显示（共 ' + st.frameTexts.length + ' 个）' : '隐藏'), null, 'action');
    return st.hitAreasOn;
  }

  /* ============================ 7. 定时播放动作 ============================ */
  /* 没人操作时也别一直杵着：每隔一段时间自己挑一个动作播一次。
   *   ★★ 间隔是多少秒，就改【1. 配置区】里 idleEvery 那一行（10000 = 10 秒）。
   *   ★★ 哪个动作多播、哪个少播，改同一区的 idleWeights（组名=权重，没写的按 idleWeight=1 算）。
   * 到点的时候用户正好在点模型或滑动（那两个优先级不低于它），这一轮就整个跳过，
   * 等下一个间隔再试 —— 定时播放只填空闲，不跟人抢动作。
   * 播起来以后还会把它的优先级降到 CONFIG.idleHold（闲置级），所以用户随后一点一滑马上能盖掉它。
   * 想临时看一眼：控制台里 L2D.playIdle() 立刻播一个；L2D.stopIdle() 暂停；L2D.restartIdle() 继续。 */

  /**
   * 重新起定时器：模型导入完会自动调（换模型也重新计时）。
   * 间隔每次都现读 CONFIG.idleEvery，所以控制台里改了 CONFIG 再调一次本函数就生效。
   * @returns {void}
   */
  function restartIdle() {
    stopIdle();
    if (!CONFIG.idleEvery || CONFIG.idleEvery <= 0) {
      /* ▼ 日志调用点 */
      log('定时播放没开（CONFIG.idleEvery = ' + CONFIG.idleEvery + '）', null, 'warn');
      return;
    }
    st.idleTimer = setInterval(playIdle, CONFIG.idleEvery);
    /* ▼ 日志调用点 */
    log('定时播放已开启：每 ' + Math.round(CONFIG.idleEvery / 1000) + ' 秒播一个动作', null, 'action');
  }

  /**
   * 停掉定时器（小窗销毁时自动调，控制台想临时暂停就 L2D.stopIdle()）。
   * @returns {void}
   */
  function stopIdle() {
    if (st.idleTimer) clearInterval(st.idleTimer);
    st.idleTimer = 0;
  }

  /**
   * 播一个动作：先看有没有轮到它，再挑组、挑组里第几条。
   * @returns {boolean} 真的播了才 true（被用户操作挤掉、或这个模型没动作，都是 false）
   */
  function playIdle() {
    var model = st.model;
    if (!model || !st.json) return false;

    var mm = model.internalModel.motionManager;
    var busy = mm && mm.state ? mm.state.currentPriority : 0;
    if (busy >= CONFIG.idlePriority) {
      /* ▼ 日志调用点 */
      log('这一轮跳过：正在播「' + mm.state.currentGroup + '」，优先级不低于定时播放',
        { 当前优先级: busy, 定时播放优先级: CONFIG.idlePriority });
      return false;
    }

    var group = pickIdleGroup();
    if (!group) {
      /* ▼ 日志调用点 */
      log('这一轮跳过：这个模型没有可以自动播的动作组', { CONFIG: CONFIG.idleGroups }, 'warn');
      return false;
    }

    var list = motionNames(st.json)[group] || [];
    var index = list.length > 1 ? Math.floor(Math.random() * list.length) : 0;
    var start = model.motion(group, index, CONFIG.idlePriority);
    if (start && start.then) {
      start.then(function (started) { if (started) yieldIdle(group, index); });
    }
    /* ▼ 日志调用点 */
    log('定时播放「' + group + '」第 ' + (index + 1) + '/' + list.length + ' 条', null, 'action');
    return true;
  }

  /**
   * 把刚播起来的定时动作降到 CONFIG.idleHold 级：
   * 库里的规矩是"优先级不高于正在播的动作者播不进去"，不降级的话点击要等这条动作播完才有反应。
   * 只在"正在播的确实就是刚起的这一条"时降，中途用户已经抢播了别的不去动它。
   * @param {string} group 刚播的组名
   * @param {number} index 刚播的是组里第几条
   * @returns {void}
   */
  function yieldIdle(group, index) {
    var mm = st.model && st.model.internalModel.motionManager;
    var ms = mm && mm.state;
    if (!ms || CONFIG.idleHold === CONFIG.idlePriority) return;
    if (ms.currentGroup !== group || ms.currentIndex !== index) return;
    ms.currentPriority = CONFIG.idleHold;
  }

  /**
   * 挑一个动作组：范围照 CONFIG.idleGroups，权重照 CONFIG.idleWeights / idleWeight，
   * 最近播过的那些先避开（别连着几下同一个）。
   * @returns {string} 组名，这个模型一个都没有（或全被调成 0 权重）就返回 ''
   */
  function pickIdleGroup() {
    var all = Object.keys(motionNames(st.json));
    var groups = (CONFIG.idleGroups && CONFIG.idleGroups.length)
      ? CONFIG.idleGroups.filter(function (g) { return all.indexOf(g) >= 0; })  // 填了不存在的组名就当没有
      : all;
    groups = groups.filter(function (g) { return idleWeightOf(g) > 0; });        // 权重 0 的直接出局
    if (!groups.length) return '';

    var keep = clamp(CONFIG.idleAvoidRepeat || 0, 0, groups.length - 1);
    var recent = keep ? st.idleRecent.slice(-keep) : [];   // 0 就是完全随机；写成 slice(-0) 会把整段历史都算进去
    var pool = groups.filter(function (g) { return recent.indexOf(g) < 0; });
    if (!pool.length) pool = groups;          // 全被"最近播过"排掉了（比如就配了一个组），那就随它重复

    var pick = weightedPick(pool);
    st.idleRecent.push(pick);
    while (st.idleRecent.length > 8) st.idleRecent.shift();
    return pick;
  }

  /**
   * 这个动作组的权重：idleWeights 里写了就用写的数字，没写用 idleWeight；负数/乱填一律当 0。
   * @param {string} group 动作组名
   * @returns {number} 权重，0 = 不参与自动播
   */
  function idleWeightOf(group) {
    var w = (CONFIG.idleWeights && CONFIG.idleWeights[group] !== undefined)
      ? CONFIG.idleWeights[group] : CONFIG.idleWeight;
    return (typeof w === 'number' && w > 0) ? w : 0;
  }

  /**
   * 按权重挑一个：把各组权重接成一根总长，随机扔个点，落在哪一段就是那一组。
   * 权重全为 0 时退回平均随机，不至于挑不出东西。
   * @param {Array<string>} pool 候选动作组（已经筛过范围、权重和"最近播过"）
   * @returns {string} 挑中的组名
   */
  function weightedPick(pool) {
    var total = 0;
    var weights = pool.map(function (g) {
      var w = idleWeightOf(g);
      total += w;
      return w;
    });
    if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];

    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r < 0) return pool[i];
    }
    return pool[pool.length - 1];               // 兜底：浮点误差落到最后一格之外
  }

  /* ============================ 8. 日志 ============================ */
  /**
   * 引擎自己不建日志面板：优先用界面层塞进来的 log 函数（L2D.log = log），
   * 没有就直接走控制台。级别含义和 live2d_win.js 里那份 log() 完全一致。
   * @param {string} message 文案
   * @param {*} [detail] 附加数据
   * @param {string} [level] info / action / warn / error
   * @returns {void}
   */
  function log(message, detail, level) {
    if (typeof API.log === 'function') { API.log(message, detail, level); return; }
    if (level === 'error') console.error('[live2dModel]', message, detail);
    else if (level === 'warn') console.warn('[live2dModel]', message, detail);
    else console.log('[live2dModel]', message, detail);
  }

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  /* ============================ 9. 对外接口 ============================ */
  var API = {
    CONFIG: CONFIG,
    get state() { return st; },      // { path, name, hitAreasOn, idleTimer, 命中区域数... } 调试用
    get model() { return st.model; },
    get app() { return st.app; },
    log: null,                       // 界面层把自己的日志函数赋值进来：L2D.log = log
    attach: attach,
    resize: resize,
    load: load,
    destroy: destroy,
    toggleHitAreas: toggleHitAreas,
    hitAreas: function () { return (st.json && st.json.HitAreas) || []; }, // 当前模型的命中区域原样给你
    playIdle: playIdle,              // 立刻播一个定时播放的动作（调试用）
    stopIdle: stopIdle,              // 暂停定时播放
    restartIdle: restartIdle,        // 重新开始定时播放（改完 CONFIG.idleEvery 调它就生效）
  };
  global.L2D = API;
})(window);
