#!/usr/bin/env node
/**
 * gate/scripts/canary-docs.mjs —— docs 链接判据的 **canary 负例套件**。
 *
 * WHY 必须存在（TASK.2 §1/§3-A2）：一个"从不判红的判据"等于没有判据
 * （现场 `link_gate.py` 就是：`missing=2` 仍 `exit=0`）。
 * 所以本套件要证明 `check-doc-links.mjs` **两个方向都会动**：
 *   造断链 ⇒ 判红（非零退出）；撤销 ⇒ 判绿。
 * **恒绿不算过。**
 *
 * 五个场景（每个都断言**确切退出码**，不是"跑过就算"）：
 *   C1 合成树 + 1 条断链                ⇒ exit 1（RED）
 *   C2 同树，把断链改好                  ⇒ exit 0（GREEN）
 *   C3 **真实 docs** + 空 exceptions     ⇒ exit 1（证明它**真的看得见**现场那 2 条断链，
 *                                            而不是"因为什么都没查所以绿"）
 *   C4 **真实 docs** + 真 exceptions     ⇒ exit 0（这才是 acceptance 里跑的那条）
 *   C5 零命中（空目录）                   ⇒ exit 2（"没查到东西"**不是通过**）
 *
 * C1/C2 的合成树只写在 `gate/.canary/**`（本 slice 写域内），**不碰 `docs/**`**。
 *
 * 退出码：0 = 五个场景全部符合预期；1 = 任一场景不符（即：canary 没能变红，或绿得不对）
 */

import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// 清掉自己用过的空父目录（只在确属空目录时成功；别的 canary 还在用就保留）
function rmdirEmptyParent(p) { try { rmdirSync(p); } catch { /* 非空或不存在：不动 */ } }
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'scripts', 'check-doc-links.mjs');
const REAL_EXC = 'gate/adapters/docs.exceptions.json';
// ★ 用**自己的子目录**，不要动父目录 `gate/.canary`：
//   踩过的坑（R3a）：早先这里写的是 `join(HERE, '.canary')`，于是跑一次 docs 任务
//   就会把**整个** `gate/.canary` 连同别的脚本（close-e2e 等）正在用的临时文件一起删掉 ——
//   表现为"子进程跑完，我的捕获文件连同目录一起消失"。
//   规矩：**每个 canary 只拥有并只清理自己的子目录。**
const CANARY = join(HERE, '.canary', 'docs');
const rel = (p) => p.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');

// ★ 本沙箱实测：spawnSync 用管道会 EPERM ⟹ 一律用 'inherit' 或忽略输出；
//   这里只需要**真实退出码**，所以直接 inherit（输出打到本进程 stdout，便于人看）。
function runChecker(args) {
  const r = spawnSync(process.execPath, [CHECKER, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) return { code: null, error: r.error.code || r.error.message };
  return { code: r.status, error: null };
}

function scenario(name, args, expected, note) {
  console.log(`\n--- ${name} ---`);
  console.log(`  $ node ${args.join(' ')}`);
  const { code, error } = runChecker(args);
  const pass = code === expected;
  console.log(`  ⟹ 实测退出码 ${code}${error ? ` (error=${error})` : ''}；期望 ${expected} —— ${pass ? '符合' : '★不符'}`);
  if (note) console.log(`  ${note}`);
  return { name, expected, actual: code, pass };
}

function main() {
  console.log('== docs 链接判据 canary 套件（必须两个方向都会动）==');
  rmSync(CANARY, { recursive: true, force: true });
  rmdirEmptyParent(join(HERE, '.canary'));
  const good = join(CANARY, 'good');
  mkdirSync(good, { recursive: true });
  // ★ scope 必须**从 CANARY 推出来**，不能写死：写死就与"每个 canary 用自己的子目录"互相打架
  //   （改了 CANARY 而忘了改 scope ⟹ 场景全走"范围不存在"分支，退出码恰好相同、看着通过）。
  const goodScope = rel(good);
  const emptyScope = rel(join(CANARY, 'empty'));

  // C1/C2 的合成树：同目录一个真实存在的目标 + 一个断链
  const target = join(good, 'target.md');
  writeFileSync(target, '# target\n\n存在的目标。\n', 'utf8');
  const pagePath = join(good, 'page.md');
  writeFileSync(pagePath, '# page\n\n- 好链：[target](./target.md)\n- 断链：[gone](./definitely-gone.md)\n', 'utf8');

  const results = [];
  results.push(scenario('C1 合成树 + 1 条断链（必须判红）',
    ['--root', '.', '--scope', goodScope, '--exceptions', ''],
    1, '造断链 ⇒ 非零退出。这就是"会判红"的定义。'));

  writeFileSync(pagePath, '# page\n\n- 好链：[target](./target.md)\n- 已修：[target again](./target.md)\n', 'utf8');
  results.push(scenario('C2 同树，断链已撤销（必须判绿）',
    ['--root', '.', '--scope', goodScope, '--exceptions', ''],
    0, '撤销 ⇒ 判绿。C1+C2 合起来 = 该判据有区分能力。'));

  results.push(scenario('C3 真实 docs + 空 exceptions（必须判红）',
    ['--root', '.', '--scope', 'docs', '--exceptions', ''],
    1, '★ 关键场景：证明它**真的看得见**现场那 2 条断链，而不是"没查所以绿"。'));

  results.push(scenario('C4 真实 docs + 真 exceptions（acceptance 跑的就是这条）',
    ['--root', '.', '--scope', 'docs', '--exceptions', REAL_EXC],
    0, '两条断链已声明 ⇒ undeclared missing = 0。'));

  // ★ C5 必须**真的**走到"零命中"分支：早先版本没建这个空目录，于是它命中的是
  //   "范围不存在"分支 —— 退出码同样是 2，场景看着通过，但**测的不是它声称的东西**。
  //   （同族病：判据在跑但不判别。这里连"测试在测什么"都要自己先核一遍。）
  const empty = join(CANARY, 'empty');
  mkdirSync(empty, { recursive: true });
  results.push(scenario('C5 零命中（必须无法裁决）',
    ['--root', '.', '--scope', emptyScope, '--exceptions', ''],
    2, '0 条链接不是通过：范围给错/被过滤掉都会走到这里（期望看到 DOC_LINK_ZERO_LINKS）。'));

  rmSync(CANARY, { recursive: true, force: true });
  rmdirEmptyParent(join(HERE, '.canary'));

  const bad = results.filter((r) => !r.pass);
  console.log('\n== canary 汇总 ==');
  for (const r of results) console.log(`  ${r.pass ? 'OK  ' : 'FAIL'} ${r.name}  expected=${r.expected} actual=${r.actual}`);
  if (bad.length > 0) {
    console.log(`DOCS_CANARY: FAIL (${bad.length}/${results.length} 个场景不符预期)`);
    return 1;
  }
  console.log(`DOCS_CANARY: PASS (${results.length}/${results.length} 个场景符合预期，含"造断链判红"与"零命中不可裁决")`);
  return 0;
}

process.exitCode = main();
