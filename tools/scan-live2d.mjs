#!/usr/bin/env node
/* =============================================================================
 * tools/scan-live2d.mjs —— 生成小窗“模型 / 服装”静态清单 live2d_list.json
 *
 * 干什么用：把原来在浏览器里“扫描服务器目录列表”的那套逻辑挪到本地跑一遍，
 *          结果写死进 json；页面上的界面层只读这个 json，不再依赖服务器的目录列表功能。
 *
 * 什么时候要重新跑：往 live2d/ 里加了新角色、或某个角色多了/少了 modelN.json（换装），
 *          刷新页面看不到新内容时，在本项目根目录跑一次：
 *              node tools/scan-live2d.mjs
 *          想扫别的目录或换输出文件名：
 *              node tools/scan-live2d.mjs live2d live2d_list.json
 *          清单最前面那个 pathBase（别人服务器上模型目录的位置）想直接写进文件：
 *              node tools/scan-live2d.mjs live2d live2d_list.json https://cdn.example.com/models/live2d/
 *
 * 判定规则和原来动态版一一对应，改这里等于改两边，尽量保持一致：
 *   1) 从根目录往下最多钻 3 层（depth 1/2/3），哪个目录里有 model*.json 就把它当成一个模型，不再往深里找；
 *   2) 模型列表点进去时先试哪个 modelN.json：编号带同名 Moc_N.moc3 的优先（从大到小），
 *      一个都对不上就全按编号从大到小试（官方样例那种 Moc 不叫 Moc_N 的走这条）；
 *   3) 服装列表 = 该目录下所有 model*.json，按编号从小到大；编号有对应 moc 的才算“正常”，
 *      对不上的标个“没有对应 moc”，只是提示，点了照样会去加载；
 *   4) 列表顺序按名字用中文拼音排（localeCompare + zh-Hans-CN），和浏览器里排出来的结果一致。
 * ============================================================================= */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* 和界面层 CONFIG.modelScanDepth 同一个含义：往下最多钻几层 */
const MAX_DEPTH = 3;

const root = process.argv[2] || 'live2d';
const out = process.argv[3] || 'live2d_list.json';
const pathBase = process.argv[4] || (root.replace(/\/+$/, '') + '/');

/** 列一个目录下的名字（目录带 / 结尾的记成 dir） */
function names(dir) {
  return readdirSync(dir, { withFileTypes: true }).map(function (it) {
    return { name: it.name, dir: it.isDirectory() || (it.isSymbolicLink() && safeIsDir(join(dir, it.name))) };
  });
}
function safeIsDir(p) {
  try { return statSync(p).isDirectory(); } catch (e) { return false; }
}
/** 目录里的 model*.json 编号（'' 表示文件就叫 model.json）和 Moc_N.moc3 编号 */
function read(dir) {
  const models = new Set();
  const mocs = new Set();
  for (const it of names(dir)) {
    if (it.dir) continue;
    let m = it.name.match(/^model(\d*)\.json$/i);
    if (m) { models.add(m[1]); continue; }
    m = it.name.match(/^moc[_-]?(\d+).*\.moc3?$/i);
    if (m) mocs.add(m[1]);
  }
  return { models: [...models], mocs };
}

/* 广度优先，遇到模型目录就收下来、不再往下钻 */
const found = [];
const queue = [{ dir: root, depth: 1 }];
while (queue.length) {
  const job = queue.shift();
  const r = read(job.dir);
  if (r.models.length) {
    const num = function (a, b) { return (a | 0) - (b | 0); };
    /* 先试有 moc 的，都对不上就全试；从大到小 */
    let picks = r.models.filter(function (n) { return n && r.mocs.has(n); });
    if (!picks.length) picks = r.models.slice();
    picks.sort(function (a, b) { return (b | 0) - (a | 0); });
    const rel = relDir(job.dir, root);          // 'live2d/誓约/朱诺' → '誓约/朱诺/'
    found.push({
      name: rel.replace(/\/$/, ''),             // 列表里显示的名字（原来动态版也是这一段）
      dir: rel,
      files: picks,
      cloths: r.models.slice().sort(num).map(function (n) {
        return { n: n, file: 'model' + n + '.json', moc: n === '' ? true : r.mocs.has(n) };
      }),
    });
    continue;
  }
  if (job.depth < MAX_DEPTH) {
    for (const it of names(job.dir)) if (it.dir) queue.push({ dir: join(job.dir, it.name), depth: job.depth + 1 });
  }
}
function relDir(dir, base) {
  const b = base.replace(/\/+$/, '');
  if (dir.replace(/\/+$/, '') === b) return '';            // 根目录本身就是模型目录
  return (dir.startsWith(b + '/') ? dir.slice(b.length + 1) : dir).replace(/\/+$/, '') + '/';
}
found.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });

const json = {
  _说明: [
    '这是小窗“模型/服装”两个列表的静态清单，由 node tools/scan-live2d.mjs 扫描生成，别手改（改完下次重扫就没了）。',
    '完整地址 = pathBase + dir + file。例：pathBase="live2d/"、dir="菊理千姬/"、file="model3.json" → live2d/菊理千姬/model3.json。',
    '换到别的服务器只改 pathBase 一处：可以写相对页面的路径，也可以写 https://xxx/live2d/ 这种绝对地址（末尾的 / 别丢）。',
    'files = 点“模型”时依次尝试的编号（从大到小，带同名 moc 的优先）；cloths = 点“服装”看到的列表（编号从小到大）。',
    'cloths[].moc=false 表示这个编号没有对应的 Moc_N.moc3，多半加载不了，列表里会标出来。',
  ],
  pathBase: pathBase,
  models: found,
};
writeFileSync(out, JSON.stringify(json, null, 2) + '\n', 'utf8');
console.log('已写入 ' + out + '：' + found.length + ' 个模型目录，共 '
  + found.reduce(function (s, m) { return s + m.cloths.length; }, 0) + ' 套服装');
