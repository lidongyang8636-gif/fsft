#!/usr/bin/env node
/**
 * gate/gate.mjs —— 收口层入口（Gate 收口协议 v0）。
 *
 * 用法：
 *   node gate/gate.mjs --task gate/tasks/<id>.json [--root .] [--out gate/evidence]
 *   node gate/gate.mjs --self-test                 # 四态自测（含 MISMATCH 负例）
 *   node gate/gate.mjs --help
 *
 * 退出码契约（SPEC §3.6）：
 *   0 = 全部断言 PASS（GATE ... PASS）
 *   1 = 自测/用法类失败，或存在 MISMATCH（工具对自己撒谎）
 *   2 = 判据未过：HONEST_FAIL / UNVERIFIED / noWrite 越界
 *   3 = 无法裁决：描述符缺失或非法
 *
 * 硬约束（SPEC §3.4/§3.5）：适配器**只映射**，执行/判定/落盘一律在本文件与 lib/runner.mjs 内。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, runTask, validateTask } from './lib/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgv(argv) {
  const o = { root: null, out: null, task: null, adapter: null, 'self-test': false, help: false, verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--self-test') { o['self-test'] = true; continue; }
    if (a === '--verify') { o.verify = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { o[key] = true; } else { o[key] = val; i += 1; }
      continue;
    }
    if (!o.task) o.task = a;
  }
  return o;
}

function usage() {
  console.log(`Gate 收口协议 v0

  node gate/gate.mjs --task <描述符.json> [--root <工作区根>] [--out <证据目录>]
  node gate/gate.mjs --self-test [--out <证据目录>]
  node gate/gate.mjs --verify --task <描述符.json>     # 只校验描述符，不执行

默认：--root = 当前工作目录；--out = <gate>/evidence。
描述符里的相对路径以【描述符文件所在目录】为基准解析（见 SPEC §3.1）。
`);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) { usage(); return EXIT.PASS; }

  const root = resolve(args.root || process.cwd());
  const outDir = resolve(args.out || join(HERE, 'evidence'));

  if (!existsSync(root)) {
    console.error(`GATE-RUNNER ERROR: --root 不存在：${root}`);
    return EXIT.CANT_DECIDE;
  }

  if (args['self-test']) {
    const { selfTest } = await import('./scripts/self-test.mjs');
    return selfTest({ root, outDir });
  }

  if (!args.task) {
    console.error('GATE-RUNNER ERROR: 缺少 --task（或使用 --self-test）');
    usage();
    return EXIT.CANT_DECIDE;
  }

  const taskPath = resolve(args.task);
  if (!existsSync(taskPath)) {
    console.error(`GATE-RUNNER ERROR: 描述符不存在：${taskPath}`);
    return EXIT.CANT_DECIDE;
  }

  let task;
  try {
    task = JSON.parse(await readText(taskPath));
  } catch (err) {
    console.error(`GATE-RUNNER ERROR: 描述符不是合法 JSON：${taskPath}\n  ${err.message}`);
    return EXIT.CANT_DECIDE;
  }

  const errs = validateTask(task);
  if (errs.length > 0) {
    console.error(`GATE-RUNNER ERROR: 描述符非法（${errs.length} 条）—— 拒绝执行，不产出任何 PASS：`);
    for (const e of errs) console.error(`  - ${e}`);
    return EXIT.CANT_DECIDE;
  }

  if (args.verify) {
    console.log(`DESCRIPTOR OK: ${task.taskId}  assertions=${task.acceptance.length}`);
    return EXIT.PASS;
  }

  mkdirSync(outDir, { recursive: true });
  const { evidence, outPath, gateLine } = runTask({ task, taskPath, root, outDir });

  for (const e of evidence.evaluated) {
    const real = e.real.exit === null ? 'NOT-RUN' : String(e.real.exit);
    console.log(`  [${e.state.padEnd(11)}] ${String(e.id).padEnd(6)} oracle=${String(e.oracle || '-').padEnd(24)} real_exit=${real.padEnd(7)} decl_exit=${String(e.declaration.exit).padEnd(5)} ${e.basis}`);
  }
  for (const nr of evidence.notRun) {
    console.log(`  [NOT-RUN    ] ${String(nr.id).padEnd(6)} ${nr.what}`);
    console.log(`              前置不足：${nr.precondition}`);
  }
  console.log('');
  console.log(gateLine);
  console.log(`evidence: ${outPath}`);

  // ★ 门未过就出要求块（含"只有 notRun、断言数=0"的域）——
  //   否则一个什么都没验的域会静悄悄地退出，看起来像"没问题"。
  if (!evidence.taskState.gateOk) {
    console.log('');
    console.log(requirementBlock(evidence));
  }

  if (evidence.taskState.gateOk) return EXIT.PASS;
  const hasMismatch = evidence.evaluated.some((e) => e.state === 'MISMATCH');
  return hasMismatch ? EXIT.HARNESS : EXIT.GATE_RED;
}

/**
 * 失败时输出「合格判据长什么样」的要求块（TASK.1 §3.5 之 5）。
 * 参考实现 gateRequirementBlock 的思路：给**形态** + 两条自检。
 */
export function requirementBlock(ev) {
  const L = [];
  L.push('================ 要求块：合格判据长什么样 ================');
  L.push(`任务 ${ev.taskId} 未通过（verdict=${ev.taskState.verdict}）。`);
  if (ev.evaluated.length === 0 && (ev.notRun || []).length > 0) {
    // 只有 notRun 的域：一条断言都没有 ⟹ 这里**没有**"不通过的断言"可列，
    // 但必须让人看见"这个域本轮什么都没被验证"。
    L.push(`本任务**断言数 = 0** ⟹ 这个域本轮**没有被验证过任何东西**（不是"通过"）。`);
    L.push('它只有 notRun 声明（跑不了的原因与前置条件）：');
    L.push('');
    L.push('| id | 本该验什么 | 前置条件 | 为什么跑不了 |');
    L.push('|---|---|---|---|');
    for (const nr of ev.notRun) {
      L.push(`| ${nr.id} | ${nr.what} | ${nr.precondition} | ${nr.why} |`);
    }
    L.push('');
    L.push('⟹ 要让它变成可验收：**补齐前置条件**（见上表 precondition），然后把真命令写成带 `exit` 的断言；');
    L.push('   **不要**把"跑不了"降级成"`exit 0` 就算过"。');
  } else {
    L.push('不通过的断言（逐条给出【它声称要证明什么】与【现在能证明什么】）：');
    L.push('| id | 声称要证明 | 现在能证明 | 缺什么 |');
    L.push('|---|---|---|---|');
    for (const e of ev.failed) {
      const declared = e.declaration.assert || e.declaration.cmd || '(无)';
      const real = e.real.exit === null ? '未跑' : `实测 exit=${e.real.exit}`;
      const gap = e.state === 'UNVERIFIED' ? '结论（没跑 / 跑不了 / 未声明）'
        : e.state === 'MISMATCH' ? '声明与实测不符（自述不可信）'
          : '判据没有真正区分能力（红/绿都可能满足）';
      L.push(`| ${e.id} | ${declared} | ${real}，oracle=${e.oracle || '-'} | ${gap} |`);
    }
  }
  L.push('');
  L.push('合格判据的三条形态要求：');
  L.push('  1. **可机械求值**：能从【真实退出码】或【实测文件状态/文本】直接算出真/假，'
    + '不依赖执行者的叙述。');
  L.push('  2. **有区分能力**：存在一个"坏版本"会让它变红（否则它只是装饰）。'
    + ' 造一个断链/坏输入，它必须红；撤销它，必须绿。');
  L.push('  3. **只读且可重复**：不改状态、第二次跑结论相同；改状态的命令不得进 acceptance。');
  L.push('');
  L.push('★ 两条自检（每次写判据都要问，TASK.1 §3.5 之 5）：');
  L.push('  ① 「换个任务它是否照样通过？」——如果换一个完全不相干的实现/任务它仍然 PASS，'
    + '那它证明的不是本任务，是"脚本能跑"。');
  L.push('  ② 「判据是否只读？」——如果它靠写文件/改状态/发请求来"证明"，'
    + '那它既不可重复也不该进 acceptance。');
  L.push('========================================================');
  return L.join('\n');
}

async function readText(p) {
  const { readFile } = await import('node:fs/promises');
  return readFile(p, 'utf8');
}

process.exitCode = await main();
