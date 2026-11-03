#!/usr/bin/env node
/**
 * gate/scripts/self-test.mjs —— runner 自测：**四态各跑出一例**（TASK.1 §4 A2）。
 *
 * 关键判据（不许妥协）：必须有 **MISMATCH 负例**（声称 exit=0、真实非 0）。
 * 这不是"跑一个命令看它过没过"，而是"**伪造一份自述**，看判定器能不能抓住"。
 *
 * 做法（三层，逐层加强）：
 *   1. 用真实 runner（in-process 调 runTask）跑四个夹具；
 *   2. **重新读回落盘的那份 evidence JSON**，从产物里核对状态
 *      —— 证明"证据 JSON 里真的记着四态"，而不是只在内存里对；
 *   3. 断言 MUST_HAVE=["PASS","HONEST_FAIL","MISMATCH","UNVERIFIED"] 全部出现，
 *      缺任何一个（尤其 MISMATCH）⟹ exit 1。
 *
 * 夹具不是假货：它们本身就是 SPEC §3.1 描述符（只是 taskId 带 _selftest- 前缀），
 * 经过同一个 validateTask。MISMATCH 用的是**真实非零退出码**，不是模拟出来的。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, runTask, validateTask } from '../lib/runner.mjs';

const MUST_HAVE = ['PASS', 'HONEST_FAIL', 'MISMATCH', 'UNVERIFIED'];

const HERE = resolve(join(import.meta.dirname, '..'));

/** 造一份夹具描述符：故意用「声明 exit=0 而真实 exit=3」来产出 MISMATCH。 */
function fixtures(exe) {
  const n = (code) => `"${exe}" -e "process.exitCode=${code}"`;
  const common = {
    level: 'L1',
    claimsWhat: 'gate runner 四态判定自测',
    // noWrite 目标必须能解析到（否则 runner 会判 UNRESOLVED）。
    // 用 gate/lib：它在这个夹具运行时是**不变**的（runner 自己不写源码）。
    noWrite: ['gate/lib'],
    refs: ['slices/gate/TASK.1.md §3.2', 'slices/gate/TASK.1.md §4-A2'],
  };
  return [
    {
      ...common,
      taskId: 'selftest-pass',
      claimsWhat: 'PASS 态：声明 exit=0 且真实 exit=0，外加一条文件判据',
      acceptance: [
        { id: 'S1', assert: 'exists:gate/gate.mjs' },
        { id: 'S2', cmd: n(0), exit: 0, cwd: '.' },
      ],
    },
    {
      ...common,
      taskId: 'selftest-honest-fail',
      claimsWhat: 'HONEST_FAIL 态：声明 exit=3 且真实 exit=3（诚实声明失败）',
      acceptance: [
        { id: 'S1', cmd: n(3), exit: 3, cwd: '.' },
      ],
    },
    {
      ...common,
      taskId: 'selftest-mismatch',
      claimsWhat: '★ MISMATCH 负例：**声称 exit=0，真实 exit=3** —— 抓的就是"自述未跑/自述通过"',
      acceptance: [
        { id: 'S1', cmd: n(3), exit: 0, cwd: '.' },
      ],
    },
    {
      ...common,
      taskId: 'selftest-unverified',
      claimsWhat: 'UNVERIFIED 态：同一描述符里有三条"未取得结论"的路径',
      acceptance: [
        // ① 命令跑不起来：shell:false + 不存在的可执行文件 ⟹ 真实 error.code=ENOENT
        //    （★ 实测：shell:true 时找不到的可执行文件会被 cmd.exe 吞成 exit=1，
        //     那会被当成 MISMATCH；只有 shell:false 才真正暴露 ENOENT
        //     —— 这正是"环境失败 ≠ 判据失败"要靠 harness 字段分开记的原因）
        { id: 'S1', cmd: 'gate-definitely-not-a-real-exe-xyz', args: [], shell: false, exit: 0, cwd: '.' },
        // ② 只声明、没跑：纯文件判据不产生退出码（oracle=path），real_exit 记 null
        { id: 'S2', assert: 'exists:gate/gate.mjs', cwd: '.' },
        // ③ 跑了但没有声明退出码 ⟹ 无判据可比，显式 UNVERIFIED（不得静默当通过）
        { id: 'S3', cmd: n(0), cwd: '.', allowUndeclaredExit: true },
      ],
    },
  ];
}

export function selfTest({ root, outDir }) {
  const sdir = join(outDir, '_selftest');
  rmSync(sdir, { recursive: true, force: true });
  mkdirSync(sdir, { recursive: true });

  const exe = process.execPath;
  const cases = fixtures(exe);
  const results = [];
  let hardFail = 0;

  console.log('== gate self-test：四态各一例（含 MISMATCH 负例）==');
  for (const task of cases) {
    // allowUndeclaredExit 的条目**故意**绕过 describe 校验：
    // 它们要证明的正是"跑了却没声明退出码 ⟹ UNVERIFIED"。
    // CLI 会拒收这种描述符（要么给 exit 要么给 assert）；runner 层的这条分支也必须被证明存在，
    // 否则「未声明 = 未验证」就只是文档里的一句话。
    const validated = {
      ...task,
      acceptance: task.acceptance.filter((a) => !a.allowUndeclaredExit),
    };
    const errs = validateTask(validated).filter((e) => {
      const id = (e.match(/断言 (\S+?)[：:]/) || [])[1];
      return !task.acceptance.some((a) => a.id === id && a.allowUndeclaredExit);
    });
    const bypassed = task.acceptance.filter((a) => a.allowUndeclaredExit).map((a) => a.id);
    if (errs.length > 0) {
      console.log(`  [HARNESS-FAIL] 夹具 ${task.taskId} 未通过 describe 校验：${errs.join('; ')}`);
      hardFail += 1;
      continue;
    }
    if (bypassed.length > 0) {
      console.log(`  （${task.taskId}：${bypassed.join(',')} 故意绕过 describe 校验，用于证明"未声明 ⟹ UNVERIFIED"这条分支）`);
    }
    const taskPath = join(sdir, `${task.taskId}.json`);
    writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf8');

    const { evidence, outPath, gateLine } = runTask({ task, taskPath, root, outDir: sdir });

    // ★ 第二层：重新从【落盘的产物】读回状态，证明证据 JSON 里真的记着
    const reread = JSON.parse(readFileSync(outPath, 'utf8'));
    const perAssertion = reread.evaluated.map((e) => `${e.id}=${e.state}`);
    const statesSeen = [...new Set(reread.evaluated.map((e) => e.state))];

    const declaredExit = reread.evaluated.map((e) => e.declaration.exit);
    const realExit = reread.evaluated.map((e) => e.real.exit);
    results.push({
      taskId: task.taskId,
      expected: task.taskId.replace('selftest-', '').toUpperCase().replace(/-/g, '_'),
      perAssertion,
      statesSeen,
      verdict: reread.taskState.verdict,
      gateOk: reread.taskState.gateOk,
      declaredExit,
      realExit,
      evidencePath: outPath,
      gateLine,
    });
    console.log(`  ${task.taskId.padEnd(26)} → ${perAssertion.join(' ')}  | verdict=${reread.taskState.verdict}`);
    console.log(`      ${gateLine}`);
    console.log(`      declared_exit=${JSON.stringify(declaredExit)} real_exit=${JSON.stringify(realExit)}`);
  }

  // 第三层：四态必须都出现过
  const allSeen = new Set(results.flatMap((r) => r.statesSeen));
  const missing = MUST_HAVE.filter((s) => !allSeen.has(s));
  const mismatchCase = results.find((r) => r.taskId === 'selftest-mismatch');
  const mismatchOk = !!mismatchCase
    && mismatchCase.statesSeen.includes('MISMATCH')
    && mismatchCase.declaredExit.includes(0)
    && mismatchCase.realExit.some((x) => x !== 0 && x !== null);

  console.log('');
  console.log(`  四态覆盖：${MUST_HAVE.map((s) => `${s}=${allSeen.has(s) ? 'YES' : 'NO'}`).join('  ')}`);
  console.log(`  MISMATCH 负例（声明 0 / 实测非 0）：${mismatchOk ? '成立' : '不成立'}`);

  const summary = {
    schema: 'gate-selftest/v0',
    ranAt: new Date().toISOString(),
    node: process.version,
    executable: exe,
    mustHave: MUST_HAVE,
    covered: Object.fromEntries(MUST_HAVE.map((s) => [s, allSeen.has(s)])),
    mismatchNegative: mismatchOk,
    hardFail,
    results,
  };
  const sumPath = join(sdir, 'selftest-summary.json');
  writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`  summary: ${sumPath}`);

  if (hardFail > 0) {
    console.log('SELFTEST: FAIL (夹具未通过描述符校验)');
    return EXIT.HARNESS;
  }
  if (missing.length > 0) {
    console.log(`SELFTEST: FAIL (缺态：${missing.join(',')})`);
    return EXIT.HARNESS;
  }
  if (!mismatchOk) {
    console.log('SELFTEST: FAIL (MISMATCH 负例未成立 —— 按 TASK.1 §4 A2 本轮不算过)');
    return EXIT.HARNESS;
  }
  console.log('SELFTEST: PASS (四态齐备，含 MISMATCH 负例)');
  return EXIT.PASS;
}

// 允许独立运行：node gate/scripts/self-test.mjs [--root .] [--out gate/evidence]
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const argv = process.argv.slice(2);
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  process.exitCode = selfTest({
    root: resolve(val('--root', process.cwd())),
    outDir: resolve(val('--out', join(HERE, 'evidence'))),
  });
}
