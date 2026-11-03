#!/usr/bin/env node
/**
 * gate/scripts/write-frozen.mjs —— 生成 `slices/gate/frozen.<round>`（逐文件哈希）。
 *
 * 范围（**只冻交付物，不冻运行期产物**）：
 *   - gate/SPEC.md、gate/gate.mjs、gate/lib/*.mjs、gate/adapters/*.mjs、gate/tasks/*.json、gate/scripts/*.mjs
 *   - gate/_recon/INVENTORY.md
 *   - slices/gate/*.md（TASK / PLAN / HANDOFF / REPRO）
 * 明确排除：`gate/evidence/**`（每次都变的运行期产物，用 GATES.log 索引，不冻）。
 *
 * 用法：node gate/scripts/write-frozen.mjs <round> <generatedAt>
 *
 * ★ 为什么时间戳要**当参数传进来**：第一版把 `new Date()` 写进表头，于是"重算一遍"永远
 *   得到不同的文件哈希 —— 一份**能读但不可复算**的冻结清单，正是本 slice 要消灭的那种东西。
 *   现在同一对参数 ⟹ 逐字节相同的输出。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const round = process.argv[2] || '1';
const generatedAt = process.argv[3] || 'UNSPECIFIED';

/**
 * ★ **扫描面 = 唯一事实来源**（R4.6 重构）。
 *
 * WHY 重构：**"清单与声明不一致"已经犯了三次** ——
 *   R1.1 范围行漏 `gate/.scratch/**`；R4.1 漏 `guards/gate-guard/**`；R4.6 漏 `slices/gate/lead/**`。
 * 三次都是同一病根：**范围行是手写的散文，与真正决定扫描面的 `GLOBS`/`EXCLUDED` 是两份数据**，
 * 靠人记得同步。⇒ 现在**范围行一律从这张表派生**（`renderScopeBlock()`），
 * 并且下面有 `assertSurfaceDocumented()`：**任何新增/改动的扫描面若没写理由，脚本直接报错退出**。
 * ⇒ 这类不一致从此**结构上不可能**（不是"记得改"，是"改不成就跑不起来"）。
 */
const GLOBS = [
  { dir: 'gate', exts: ['.md', '.mjs', '.json'], skip: ['evidence', 'node_modules', '.scratch', '.canary', '_extract'] },
  // ★ R4.6：`lead/` 出局 —— 那是 **Lead 维护的活文档**（每轮追加裁定），
  //   钉它只会让"Lead 写一条注记"就触发漂移判红 ⇒ **自指漂移**（与 §13.5 同类）。
  //   冻结的意义是"钉住**交付物**"，不是"钉住 Lead 的工作记录"。
  { dir: 'slices/gate', exts: ['.md'], skip: ['lead'] },
  // ★ R3b（新增写域）：宿主侧上板门插件必须进冻结清单，否则 frozen.4 覆盖不到本轮的**主要交付物**。
  //   这一条改动使 frozen.3 里 `gate/scripts/write-frozen.mjs` 那一条**失效**
  //   —— 见 HANDOFF.4 §9 的显式声明（只此一条；其余 40 条逐条核对不变）。
  { dir: 'guards/gate-guard', exts: ['.js', '.json', '.md'], skip: ['node_modules'] },
];

/**
 * 排除项的**理由表**（键 = 路径前缀或模式；值 = 人读理由）。
 * `assertSurfaceDocumented()` 要求：**扫描面里每一个被跳过的东西，这里都必须有理由**。
 * 条目顺序 = 范围行的编号顺序。
 */
const EXCLUSION_REASONS = new Map([
  ['gate/evidence/', '带 UTC 时间戳的证据产物，**不可复算**（用 `gate/evidence/GATES.log` 索引）'],
  ['gate/.scratch/', '运行期临时区，收尾应清空（残留由 `SIDE_EFFECT_SELFTREE` 段探测）'],
  ['gate/.canary/', '判据负例的合成树（临时造、收尾删）'],
  ['gate/_recon/_extract/', '从 `app.asar` 抽出的**第三方**源码（P0 临时材料，跑完即删）'],
  ['gate/node_modules/', '第三方依赖（非本 slice 交付物；冻结它只会让清单被上游版本号带偏）'],
  ['guards/gate-guard/node_modules/', '第三方依赖（非本 slice 交付物）'],
  ['slices/gate/lead/', '**Lead 维护的验收记录**（每轮追加裁定）—— 钉它只会制造**自指漂移**；冻结只钉**交付物**'],
  ['slices/gate/frozen.*', '冻结产物自身；冻结"冻结件"会造成**链式漂移**（改 frozen.1 会拖累 frozen.2，而历史冻结件本就不该再改）'],
]);

/** 目录前缀型排除（`frozen.*` 是模式型，单独处理）。 */
const EXCLUDED = [...EXCLUSION_REASONS.keys()].filter((k) => k.endsWith('/'));

/**
 * 自检：扫描面与理由表**必须一一对应**；否则**直接失败**（不写出一个"声明不全"的冻结件）。
 * 这就是"扫描面任何改动必须同步范围行"的**机器强制**版本。
 */
function assertSurfaceDocumented() {
  const problems = [];
  // ① 每个 glob 的每个 skip 都要有理由。
  //    注意 skip 是**名字片段**（如 `_extract` 实际落在 `gate/_recon/_extract/`），
  //    所以按"同 glob 下、末段名字相同"来配理由，而不是拼 `${dir}/${skip}/`。
  const seg = (k) => k.replace(/\/$/, '').split('/').pop();
  for (const g of GLOBS) {
    for (const s of g.skip) {
      const hit = [...EXCLUSION_REASONS.keys()].some((k) => k.startsWith(`${g.dir}/`) && seg(k) === s);
      if (!hit) problems.push(`glob \`${g.dir}\` 的 skip \`${s}\` 没有理由（请在 EXCLUSION_REASONS 里为该目录写一条）`);
    }
  }
  // ② 每个目录前缀型排除，必须真的落在某个 glob 的扫描面下（否则是无用声明）
  for (const e of EXCLUDED) {
    if (!GLOBS.some((g) => e.startsWith(`${g.dir}/`))) problems.push(`排除项 \`${e}\` 不在任何 glob 的扫描面下（无用声明？）`);
  }
  if (problems.length > 0) {
    console.error('FROZEN-SURFACE-ERROR: 扫描面与理由表不一致 —— **拒绝写出冻结件**：');
    for (const p of problems) console.error(`  · ${p}`);
    return false;
  }
  return true;
}

/** 从**同一张表**渲染范围块（范围行 + 排除清单）—— 声明与扫描面**同源**。 */
function renderScopeBlock() {
  const scope = GLOBS.map((g) => `\`${g.dir}/**\``).join(' ＋ ');
  const L2 = [];
  L2.push(`> 范围（**R4.6 起自"扫描面表"派生**）：${scope}，`
    + `**显式排除**下列 ${EXCLUSION_REASONS.size} 项（与脚本的 \`GLOBS[].skip\` / \`EXCLUSION_REASONS\` **同一张表派生**，`
    + '不是"碰巧没扫到"）：');
  let i = 0;
  for (const [p, why] of EXCLUSION_REASONS) {
    i += 1;
    L2.push(`>   ${i}. \`${p}\` —— ${why}；`);
  }
  return L2;
}

// 先把扫描面自检过掉；**不通过就立即退出、绝不写文件**
// （★ 我第一版只设了 exitCode 就用到了 `surfaceOk` 之前，结果**照样写出了文件** —— 与注释里
//  "不通过就不写"自相矛盾。这里改成 `process.exit(1)`：真正阻止写出，而不是"写完了再报错"。）
const surfaceOk = assertSurfaceDocumented();
if (!surfaceOk) {
  console.error('FROZEN-SURFACE-ABORT: 未写出任何文件。');
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

const files = [];
for (const g of GLOBS) {
  const base = join(ROOT, g.dir);
  if (!existsSync(base)) continue;
  for (const p of walk(base)) {
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    if (g.skip.some((s) => rel.includes(`/${s}/`) || rel.endsWith(`/${s}`))) continue;
    if (!g.exts.some((x) => rel.endsWith(x))) continue;
    if (EXCLUDED.some((e) => rel.startsWith(e))) continue;
    // 冻结产物自身不冻（任何轮次）：自指/链式都会让哈希永远对不上
    if (/\/frozen\.[^/]*$/.test(rel)) continue;
    const st = statSync(p);
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    files.push({ path: rel, bytes: st.size, sha256: sha });
  }
}
files.sort((a, b) => a.path.localeCompare(b.path));

// ③ 落地断言：**实际写进清单的文件，一条都不许落在任何排除前缀下**（防御性，防上面逻辑被改坏）
const leaked = files.filter((f) => EXCLUDED.some((e) => f.path.startsWith(e)));
if (leaked.length > 0) {
  console.error(`FROZEN-SURFACE-ERROR: 有 ${leaked.length} 条被排除路径仍进了清单：`);
  for (const l of leaked) console.error(`  · ${l.path}`);
  process.exitCode = 1;
}

const L = [];
L.push(`# frozen.${round} —— gate slice 第 ${round} 轮交付物逐文件哈希`);
L.push('');
// ★ R4.6：范围块**派生**自扫描面表（含 R4.1/R4.6 两次漏声明的更正）
for (const l of renderScopeBlock()) L.push(l);
L.push('>');
L.push('> ★ **更正注记（R4.6，2026-10-16）**：本文件此前含 **4 条 `slices/gate/lead/ACCEPT.{1..4}.md`**');
L.push('> （**Lead 的验收文件**），而范围行**从未声明**过该目录 —— 这是**"清单与声明不一致"的第三次**');
L.push('> （R1.1 漏 `gate/.scratch/**`；R4.1 漏 `guards/gate-guard/**`；本次漏 `slices/gate/lead/**`）。');
L.push('> 处置：① 把 `slices/gate/lead/**` **移出清单**（它是 Lead 维护的活文档，钉它只会制造自指漂移）；');
L.push('> ② 范围行**显式写出**该排除（见上）；③ **范围行改为从扫描面表派生**，并加 `assertSurfaceDocumented()`');
L.push('> —— 今后**扫描面任何改动若没写理由，脚本直接报错、不产出冻结件** ⟹ 此类不一致**结构上不可能**。');
L.push('> 历史更正注记（R4.1）**保留**：本文件初版范围行原文为「`gate/**` 与 `slices/gate/*.md`」，');
L.push('> 漏了 `guards/gate-guard/**`（而当时清单里已有 3 条该目录文件）。');
L.push('> 生成：`node gate/scripts/write-frozen.mjs ' + round + ' <generatedAt>`。**算法：SHA-256（全 64 位十六进制）。**');
L.push(`> 生成时间（由调用方给定，**不是**取当前时间 —— 否则本文件不可复算）：${generatedAt}`);
L.push(`> 文件数：**${files.length}**`);
// 机器可核对行：供 Lead 逐字比"范围行 vs 实际扫描面"
L.push(`> SURFACE: globs=[${GLOBS.map((g) => `${g.dir}${JSON.stringify(g.exts)}skip${JSON.stringify(g.skip)}`).join(' ')}] exclusions=[${[...EXCLUSION_REASONS.keys()].join(' ')}]`);
L.push('');
L.push('| # | 路径 | 字节 | sha256 |');
L.push('|---:|---|---:|---|');
files.forEach((f, i) => L.push(`| ${i + 1} | \`${f.path}\` | ${f.bytes} | \`${f.sha256}\` |`));
L.push('');
L.push('## 复算方式');
L.push('');
L.push('```powershell');
L.push('cd E:\\ChongyouGreenbike-dsh');
L.push('node gate/scripts/write-frozen.mjs ' + round + ' <generatedAt>   # 同一对参数 ⟹ 逐字节相同；不同即漂移');
L.push('# 或只核一个文件：');
L.push('Get-FileHash <路径> -Algorithm SHA256');
L.push('```');
L.push('');
L.push('## 不进冻结清单的东西（以及为什么）');
L.push('');
L.push('- `gate/evidence/**`：每次运行都新增/覆写（含 UTC 时间戳）；它是**证据**不是交付物，用 `gate/evidence/GATES.log` 索引。');
L.push('- `gate/.scratch/**`：运行期临时区（子进程 `TEMP`/`TMP` 与输出重定向都落这里），收尾 `cleanupScratch` 删除。');
L.push('  位置在**工作区根**而不是 `gate/evidence/` 里面 —— 证据目录只放证据（R1.1 修正，见 SPEC I2）。');
L.push('  残留由 `gate/scripts/verify-no-side-effects.mjs` 的 `SIDE_EFFECT_SELFTREE` 段**显式探测**，不靠人眼。');
L.push('- `gate/.canary/**`：`canary-docs.mjs` 造的合成树（含故意断链的 .md）。它只在负例测试期间存在，收尾删除；');
L.push('  万一残留，也不该被冻进交付清单（它是**测试夹具**，不是交付物）。');
L.push('- `slices/gate/frozen.*`：冻结产物自身。**每一轮的冻结清单只覆盖源码/文档，不覆盖往轮冻结件** ——');
L.push('  否则改一下 `frozen.1` 就会让 `frozen.2` 的哈希失效，形成一条"永远需要重算"的链。');
L.push('  历史轮次的冻结件由各自的 `ACCEPT.<round>.md` 独立复算确认。');

const out = join(ROOT, 'slices', 'gate', `frozen.${round}`);
writeFileSync(out, L.join('\n') + '\n', 'utf8');
console.log(`WROTE ${out} files=${files.length}`);
