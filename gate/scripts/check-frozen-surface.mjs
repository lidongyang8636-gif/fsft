#!/usr/bin/env node
/**
 * gate/scripts/check-frozen-surface.mjs —— **"清单 vs 声明"一致性检查器**（R4.6 新增，常设）。
 *
 * WHY：这一类缺陷**已经犯过三次** ——
 *   R1.1 范围行漏 `gate/.scratch/**`；R4.1 漏 `guards/gate-guard/**`；R4.6 漏 `slices/gate/lead/**`。
 * 病根：**范围行是手写的散文**，与真正决定扫描面的表是**两份数据**。
 * R4.6 把范围行改成**从扫描面表派生**（`write-frozen.mjs#renderScopeBlock`），并输出一行
 * 机器可核对的 `SURFACE:`。**本检查器就是那行的消费者**：它**只读 `frozen.<round>` 本身**，
 * 不依赖 `write-frozen.mjs` 的内部状态 ⇒ **第三方（Lead / 红队）也能独立跑**。
 *
 * 检查四件事：
 *   ① 范围行**提到每一个** glob 目录；
 *   ② 编号排除清单**列出每一项** `SURFACE` 里声明的排除；
 *   ③ **没有任何清单行**落在任何排除前缀下（"清单里有东西没被声明"的直接检查）；
 *   ④ **每一条清单行**都落在某个 glob 目录下、扩展名合法、且不在该 glob 的 skip 里。
 *
 * 用法：
 *   node gate/scripts/check-frozen-surface.mjs [frozen 文件路径]   # 默认 slices/gate/frozen.4
 *   node gate/scripts/check-frozen-surface.mjs --self-test          # ★ 负例自测（本检查器会不会红）
 * 退出码：0 = 一致；1 = 不一致；3 = 无法裁决（文件缺失 / 没有 SURFACE 行）；self-test 不符 ⇒ 1
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** 纯分析：给定 frozen 文本，返回 {problems, globs, exclusions, rows}。 */
export function analyze(txt) {
  const problems = [];
  const surfLine = (txt.match(/^> SURFACE: (.+)$/m) || [])[1];
  if (!surfLine) return { problems: ['找不到 `> SURFACE:` 行'], globs: [], exclusions: [], rows: [], cannotDecide: true };

  const globsPart = (surfLine.match(/globs=\[(.*?)\]\s*exclusions=/) || [])[1] || '';
  const exclusionsPart = (surfLine.match(/exclusions=\[(.*)\]\s*$/) || [])[1] || '';
  const globs = [...globsPart.matchAll(/([A-Za-z0-9_./-]+)\[("[^"]*"(?:,"[^"]*")*)\]\s*skip\[("[^"]*"(?:,"[^"]*")*)?\]/g)]
    .map((m) => ({ dir: m[1], exts: JSON.parse(`[${m[2]}]`), skip: m[3] ? JSON.parse(`[${m[3]}]`) : [] }));
  const exclusions = exclusionsPart.split(/\s+/).filter(Boolean);
  const rows = [...txt.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*\d+\s*\|\s*`[0-9a-f]{64}`\s*\|/gm)].map((m) => m[1]);

  // ① 范围行提到每个 glob 目录
  const scopeLine = (txt.match(/^> 范围.*$/m) || [])[0] || '';
  if (!scopeLine) problems.push('找不到范围行（`> 范围…`）');
  for (const g of globs) if (!scopeLine.includes('`' + g.dir + '/**`')) problems.push(`范围行没提到 glob 目录：${g.dir}`);

  // ② 编号排除清单列出每一项
  const numbered = (txt.match(/^>\s+\d+\.\s+`[^`]+`/gm) || []).join('\n');
  for (const e of exclusions) if (!numbered.includes('`' + e + '`')) problems.push(`编号排除清单里缺：${e}`);

  // ③ 没有清单行落在排除前缀下
  const underExclusion = (p) => exclusions.some((e) => (e.endsWith('*') ? p.startsWith(e.slice(0, -1)) : p.startsWith(e)));
  for (const p of rows) if (underExclusion(p)) problems.push(`清单行落在**已声明的排除**下（不该出现）：${p}`);

  // ④ 每条清单行落在某个 glob 下、扩展名合法、不在 skip 里
  for (const p of rows) {
    const g = globs.find((x) => p.startsWith(x.dir + '/'));
    if (!g) { problems.push(`清单行不在任何 glob 目录下：${p}`); continue; }
    if (!g.exts.some((x) => p.endsWith(x))) problems.push(`清单行扩展名不在 glob 允许集 ${JSON.stringify(g.exts)} 内：${p}`);
    const s = g.skip.find((k) => p.includes('/' + k + '/'));
    if (s) problems.push(`清单行落在 glob 的 skip \`${s}\` 里：${p}`);
  }
  return { problems, globs, exclusions, rows, cannotDecide: false };
}

function report(txt, label) {
  const a = analyze(txt);
  console.log(`FROZEN-SURFACE 检查对象：${label}`);
  if (a.cannotDecide) { console.log('  ★ ' + a.problems[0]); console.log('FROZEN_SURFACE: CANNOT_DECIDE'); return { code: 3, a }; }
  console.log(`  globs      = ${a.globs.map((g) => `${g.dir}${JSON.stringify(g.exts)}skip${JSON.stringify(g.skip)}`).join('  ')}`);
  console.log(`  exclusions = ${a.exclusions.join('  ')}`);
  console.log(`  清单行     = ${a.rows.length} 条`);
  if (a.problems.length > 0) {
    console.log('');
    for (const p of a.problems) console.log(`  ★ ${p}`);
    console.log(`FROZEN_SURFACE: FAIL (${a.problems.length} 条不一致)`);
    return { code: 1, a };
  }
  console.log('FROZEN_SURFACE: PASS (范围行/排除清单/清单行三者一致：每个 glob 与每项排除都已声明，且没有清单行落在排除或 skip 下)');
  return { code: 0, a };
}

/**
 * ★ 负例自测：**证明本检查器会红**（恒绿不算过）。
 * 每个负例都**先核对自己的注入真的生效**（R4.4 的教训：静默 `.Replace()` 不生效会让"测试通过"是假的）。
 */
function selfTest() {
  const real = readFileSync(resolve(ROOT, 'slices/gate/frozen.4'), 'utf8');
  const cases = [];
  const add = (name, txt, expectCode, mustMention) => {
    // 注入生效自检
    if (mustMention && !txt.includes(mustMention)) {
      cases.push({ name, ok: false, note: `注入未生效（文本里没有 ${mustMention}）` });
      return;
    }
    const a = analyze(txt);
    const code = a.cannotDecide ? 3 : (a.problems.length > 0 ? 1 : 0);
    cases.push({ name, ok: code === expectCode, note: `期望 ${expectCode}，实得 ${code}（problems=${a.problems.length}）` });
  };

  add('N0 正例：原样 ⇒ 0', real, 0);

  // ★ 负例一律**从 SURFACE 解析结果派生**，不硬编码字面量 ——
  //   我第一版硬编码 `>   5. \`slices/gate/lead/\``，锚点没匹配上、替换静默失败，
  //   于是"注入生效守卫"把这条用例判成 FAIL（**守卫起作用了**，否则会报一个假的绿灯）。
  const base = analyze(real);
  const globDir = base.globs[2] ? base.globs[2].dir : 'guards/gate-guard';
  const exclKey = base.exclusions.find((e) => e.includes('lead')) || base.exclusions[0];

  // N1：清单里塞一条"落在已声明排除下"的行
  const fakeRow = '| 999 | `slices/gate/lead/ACCEPT.1.md` | 123 | `' + '0'.repeat(64) + '` |';
  const firstRow = real.match(/^\|\s*1\s*\|.*$/m);
  const n1 = firstRow ? real.replace(firstRow[0], `${fakeRow}\n${firstRow[0]}`) : `${real}\n${fakeRow}\n`;
  add('N1 清单里出现一个已声明排除下的行（lead/**）⇒ 1', n1, 1, 'slices/gate/lead/ACCEPT.1.md');

  // N2：范围行删掉一个 glob 声明（从解析结果取那个 glob 的名字）
  const n2 = real.replace('`' + globDir + '/**`', '`（已删）`');
  add(`N2 范围行漏掉一个 glob 目录（${globDir}）⇒ 1`, n2, 1, '`（已删）`');

  // N3：编号排除清单删掉一项（用解析出的键去定位那一行）
  const n3 = real.replace('`' + exclKey + '`', '`（已删）`');
  add(`N3 编号排除清单漏掉一项（${exclKey}）⇒ 1`, n3, 1, '`（已删）`');

  // N4：全局改掉 SURFACE 行 ⇒ 无法裁决（3）
  const n4 = real.replace('> SURFACE:', '> SURFACE_X:');
  add('N4 没有 SURFACE 行 ⇒ 3（无法裁决）', n4, 3, '> SURFACE_X:');

  console.log('== check-frozen-surface 负例自测（恒绿不算过）==');
  for (const c of cases) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}  —— ${c.note}`);
  const bad = cases.filter((c) => !c.ok);
  if (bad.length) { console.log(`FROZEN_SURFACE_SELFTEST: FAIL (${bad.length}/${cases.length})`); return 1; }
  console.log(`FROZEN_SURFACE_SELFTEST: PASS (${cases.length}/${cases.length}：4 个负例各自正确变红/变 3，正例为 0)`);
  return 0;
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

const target = process.argv[2] || 'slices/gate/frozen.4';
const abs = resolve(ROOT, target);
if (!existsSync(abs)) { console.error(`FROZEN-SURFACE: 文件不存在：${target}`); process.exit(3); }
process.exit(report(readFileSync(abs, 'utf8'), target).code);
