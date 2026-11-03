#!/usr/bin/env node
/**
 * gate/scripts/canary-close.mjs —— `gate/close.mjs` 的 canary 套件（TASK.3 §2-A1/A2）。
 *
 * WHY：一个"从不拒绝"的收口门等于没有门；一个"永远拒绝"的门同样不能用。
 * **恒绿不算过，恒红也不算过** —— 所以本套件同时证明两边：
 *   三条拒绝路径**各自可达**且给出**确切非零退出码**；通过路径**确实产出收口行**。
 *
 * 做法（关键）：**不用手造的证据 JSON**。先真跑 `gate/gate.mjs` 产出**真证据**，
 * 再在真证据上制造漂移 / 缺声明。手造 JSON 只能证明"我的解析器能读我自己写的东西"。
 *
 * 场景（每个都断言**确切退出码**，不是"非零就算"）：
 *   C1a 证据文件不存在                          ⇒ 2（无 PASS 证据）
 *   C1b 真跑一个**失败**的合成任务，拿它的证据   ⇒ 2（有证据，但不是 PASS）
 *   C2a 改被验文件后收口 ⇒ 4；复原 ⇒ 0
 *   C2b 改**描述符**（自动 pin）后收口 ⇒ 4；复原 ⇒ 0
 *   C3a notRun 非空但**不给收口行**             ⇒ 5
 *   C3b 收口行**漏点 notRun id**                ⇒ 5
 *   C3c 收口行 **GATE 行数字与证据不符**         ⇒ 5
 *   C4  收口行齐备 ⇒ **0**（通过路径，且产出收口行，内容自检）
 *   C5  无 notRun 的干净证据 ⇒ **0**（防"恒红"哨）
 *
 * 合成夹具只写在 `gate/.canary/close/**`（本 slice 写域内），收尾删除；不碰任何真实交付物。
 * 退出码：0 = 全部场景符合预期；1 = 任一不符。
 */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// 清掉自己用过的空父目录（只在确属空目录时成功；别的 canary 还在用就保留）
function rmdirEmptyParent(p) { try { rmdirSync(p); } catch { /* 非空或不存在：不动 */ } }
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');       // .../gate
const ROOT = resolve(HERE, '..');                       // 工作区根
const CANARY = join(HERE, '.canary', 'close');
const WORK = join(CANARY, 'work');
const EVID = join(CANARY, 'evidence');
const TMP = join(CANARY, 'tmp');
const SUMMARY = join(HERE, 'evidence', 'close-canary-summary.json');

const NODE = process.execPath;
const GATE = join(HERE, 'gate.mjs');
const CLOSE = join(HERE, 'close.mjs');

const rel = (p) => p.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');

/**
 * 跑一个命令并取**真实退出码**。
 * ★ 本沙箱实测：`spawnSync` 带管道一律 EPERM ⟹ 需要 stdout 时只能 fd 重定向到临时文件。
 */
function run(args, { capture = false } = {}) {
  if (!capture) {
    const r = spawnSync(NODE, args, { cwd: ROOT, stdio: 'ignore' });
    return { code: r.status, out: '', error: r.error ? (r.error.code || r.error.message) : null };
  }
  mkdirSync(TMP, { recursive: true });
  const o = join(TMP, `${process.pid}-${Math.random().toString(16).slice(2, 8)}.out`);
  const fd = openSync(o, 'w');
  const r = spawnSync(NODE, args, { cwd: ROOT, stdio: ['ignore', fd, 'ignore'] });
  closeSync(fd);
  let out = '';
  try { out = readFileSync(o, 'utf8'); } catch { /* 读不到就算了，退出码才是判据 */ }
  rmSync(o, { force: true });
  return { code: r.status, out, error: r.error ? (r.error.code || r.error.message) : null };
}

const listEvidence = () => {
  try { return readdirSync(EVID).filter((f) => f.startsWith('gate-') && f.endsWith('.json')); } catch { return []; }
};

const writeTask = (name, body) => {
  const p = join(WORK, name);
  writeFileSync(p, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return p;
};

/** 真跑一个合成任务并找出它新产生的证据文件。 */
function runTaskAndFindEvidence(taskPath, taskId) {
  const before = new Set(listEvidence());
  const r = run([GATE, '--task', taskPath, '--root', '.', '--out', rel(EVID)]);
  const found = listEvidence().filter((f) => !before.has(f) && f.includes(taskId)).sort().pop();
  return { code: r.code, evidencePath: found ? join(EVID, found) : null };
}

function scenario(name, args, expected, note) {
  const r = run([CLOSE, ...args], { capture: true });
  const pass = r.code === expected;
  console.log(`\n--- ${name} ---`);
  console.log(`  期望退出码 ${expected}，实测 ${r.code} —— ${pass ? '符合' : '★不符'}`);
  if (r.error) console.log(`  (error=${r.error})`);
  const tag = (r.out.match(/CLOSE_[A-Z_]+:/) || [])[0];
  if (tag) console.log(`  ${tag}`);
  for (const l of r.out.split(/\r?\n/)) if (/^\s+·\s/.test(l)) console.log(`  ${l.trim()}`);
  if (note) console.log(`  ${note}`);
  return { name, expected, actual: r.code, pass, out: r.out, tag: tag || null };
}

function main() {
  console.log('== close.mjs canary 套件（恒绿不算过；恒红也不算过）==');
  rmSync(CANARY, { recursive: true, force: true });
  rmdirEmptyParent(join(HERE, '.canary'));
  mkdirSync(WORK, { recursive: true });
  mkdirSync(EVID, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  const art = join(WORK, 'artifact.txt');
  const ART_V1 = 'canary artifact v1\n';
  writeFileSync(art, ART_V1, 'utf8');

  // ---- 夹具：A = 通过路径；B = 通过路径 + notRun；C = 失败（gateOk=false）----
  const meta = {
    level: 'L1',
    claimsWhat: 'close.mjs canary 合成夹具（只写 gate/.canary/**）',
    refs: ['slices/gate/TASK.3.md §0 §2'],
  };
  const A = writeTask('canary-A.json', {
    ...meta,
    taskId: 'canary-accept',
    acceptance: [{ id: 'K1', what: '合成产物存在（路径判据）', assert: 'exists:gate/.canary/close/work/artifact.txt' }],
  });
  const B = writeTask('canary-B.json', {
    ...meta,
    taskId: 'canary-notrun',
    acceptance: [{ id: 'K1', what: '合成产物存在（路径判据）', assert: 'exists:gate/.canary/close/work/artifact.txt' }],
    notRun: [{
      id: 'XN1', category: 'capability', what: '本该跑的合成检查',
      why: 'canary 故意声明一条未跑项（用来证明"未跑项必须在收口行里点名"）',
      precondition: '（canary 合成夹具，无真实前置）',
    }],
  });
  const C = writeTask('canary-C.json', {
    ...meta,
    taskId: 'canary-fail',
    acceptance: [{ id: 'K1', what: '点名一个**不存在**的文件', assert: 'exists:gate/.canary/close/work/definitely-absent.txt' }],
  });

  const evA = runTaskAndFindEvidence(A, 'canary-accept');
  const evB = runTaskAndFindEvidence(B, 'canary-notrun');
  const evC = runTaskAndFindEvidence(C, 'canary-fail');
  console.log(`\n夹具真跑：A exit=${evA.code}  B exit=${evB.code}  C exit=${evC.code}（C 故意失败）`);
  for (const [k, v] of [['A', evA], ['B', evB], ['C', evC]]) {
    console.log(`  ${k} evidence=${v.evidencePath ? rel(v.evidencePath) : '(缺)'}`);
  }
  if (!evA.evidencePath || !evB.evidencePath || !evC.evidencePath) {
    console.log('CLOSE_CANARY: FAIL (夹具没产出证据 —— 后面的断言没有意义)');
    rmSync(CANARY, { recursive: true, force: true });
  rmdirEmptyParent(join(HERE, '.canary'));
    return 1;
  }
  const evARel = rel(evA.evidencePath);
  const evBRel = rel(evB.evidencePath);
  const evCRel = rel(evC.evidencePath);

  const results = [];

  results.push(scenario('C1a 证据文件不存在（无 PASS 证据）',
    ['--task', 'canary-accept', '--evidence', 'gate/.canary/close/evidence/does-not-exist.json'],
    2, '「我跑过」不是证据。'));

  results.push(scenario('C1b 有证据但不是 PASS（gateOk=false）',
    ['--task', 'canary-fail', '--evidence', evCRel],
    2, '失败的任务不许产出收口行。'));

  writeFileSync(art, 'canary artifact v2 —— 收口后改了文件\n', 'utf8');
  results.push(scenario('C2a 被验文件被改（哈希漂移）',
    ['--task', 'canary-accept', '--evidence', evARel],
    4, '改文件 ⇒ 证据作废。'));
  writeFileSync(art, ART_V1, 'utf8');
  results.push(scenario('C2a′ 复原被验文件后（应通过）',
    ['--task', 'canary-accept', '--evidence', evARel],
    0, '复原 ⇒ 又能收口。这条防"恒红"。'));

  const aText = readFileSync(A, 'utf8');
  writeFileSync(A, `${aText}\n`, 'utf8');   // 多一个换行 = 内容变化
  results.push(scenario('C2b 描述符被改（判据机器自动 pin 漂移）',
    ['--task', 'canary-accept', '--evidence', evARel],
    4, '改描述符 ⇒ 旧证据作废。'));
  writeFileSync(A, aText, 'utf8');          // 逐字节复原
  results.push(scenario('C2b′ 复原描述符后（应通过）',
    ['--task', 'canary-accept', '--evidence', evARel],
    0, '复原 ⇒ 又能收口。'));

  results.push(scenario('C3a notRun 非空但没给收口行',
    ['--task', 'canary-notrun', '--evidence', evBRel],
    5, '未跑项不许省略。'));

  const draftMissing = join(WORK, 'draft-missing.md');
  writeFileSync(draftMissing,
    'GATE canary-notrun PASS assertions=1 PASS=1 HONEST_FAIL=0 MISMATCH=0 UNVERIFIED=0 ran=0 noWrite=(none-declared)\n', 'utf8');
  results.push(scenario('C3b 给了收口行但漏点 notRun id',
    ['--task', 'canary-notrun', '--evidence', evBRel, '--draft', rel(draftMissing)],
    5, '漏点 XN1。'));

  // 用 A 的**真实**收口块推出 B 的规范 GATE 行（只换 taskId），再故意把数字改错
  const canonRun = run([CLOSE, '--task', 'canary-accept', '--evidence', evARel], { capture: true });
  const canonGate = (canonRun.out.split(/\r?\n/).find((l) => /^GATE\s/.test(l)) || '').trim();
  const bGate = canonGate.replace('canary-accept', 'canary-notrun');

  const draftWrong = join(WORK, 'draft-wrong-numbers.md');
  writeFileSync(draftWrong,
    'GATE canary-notrun PASS assertions=99 PASS=99 HONEST_FAIL=0 MISMATCH=0 UNVERIFIED=0 ran=99 noWrite=(none-declared)\n- `XN1` 已点名\n', 'utf8');
  results.push(scenario('C3c 收口行 GATE 行数字与证据不符',
    ['--task', 'canary-notrun', '--evidence', evBRel, '--draft', rel(draftWrong)],
    5, '数字不许手改。'));

  const draftOk = join(WORK, 'draft-ok.md');
  writeFileSync(draftOk, `${bGate}\n\nNOT RUN:\n- \`XN1\` 本该跑的合成检查\n`, 'utf8');
  const c4 = scenario('C4 收口行齐备（**通过路径**）',
    ['--task', 'canary-notrun', '--evidence', evBRel, '--draft', rel(draftOk)],
    0, '应当产出收口行。');
  results.push(c4);

  const selfCheck = {
    gateLine: c4.out.split(/\r?\n/).some((l) => l.trim() === bGate),
    evidencePath: c4.out.includes(evBRel),
    notRunNamed: /XN1/.test(c4.out),
    closeReceipt: /CLOSE: canary-notrun accepted/.test(c4.out),
  };
  const extraOk = Object.values(selfCheck).every(Boolean);
  console.log(`  收口行内容自检：${JSON.stringify(selfCheck)}`);

  results.push(scenario('C5 无 notRun 的干净证据（防"恒红"哨）',
    ['--task', 'canary-accept', '--evidence', evARel],
    0, '没有未跑项时不需要 --draft。'));

  // ===========================================================================
  // R4.2 §1.2（TASK.5）：退出码 **6** 与 **3** 各自的 canary。
  // 上一轮积压：6 只有**手工实测、无自动 canary** —— 违反我们自己的 `MAINTENANCE §3.1`。
  // 两条分支都必须**不再出现未分配的 1**（Lead 已复现两条；这里把它固化成回归保护）。
  // 分支顺序（实测 close.mjs）：schema 不符 ⇒ 3 ／ 形状残缺 ⇒ 6 ／ 任务号不符 ⇒ 2。
  // ===========================================================================
  console.log('\n== R4.2：退出码 6（证据残缺）与 3（不是 gate 证据）==');

  // 夹具 D：是 gate 证据（schema 对、taskId 对），但**残缺** —— 缺 noWriteResults 与 evaluated[].real
  const brokenName = 'gate-canary-broken-2026-10-16T00-00-00Z.json';
  writeFileSync(join(EVID, brokenName), `${JSON.stringify({
    schema: 'gate-evidence/v0',
    taskId: 'canary-broken',
    taskState: { gateOk: true, verdict: 'PASS', counts: { PASS: 1 } },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    evaluated: [{ id: 'K1', state: 'PASS', files: [] }],   // ★ 故意不给 real
    // ★ 故意不给 noWriteResults
  }, null, 2)}\n`, 'utf8');

  // 夹具 E：**连 schema 都没有** —— 不是 gate 证据
  const notGateName = 'gate-canary-notgate-2026-10-16T00-00-00Z.json';
  writeFileSync(join(EVID, notGateName), `${JSON.stringify({
    taskId: 'canary-notgate',
    whatever: true,
  }, null, 2)}\n`, 'utf8');

  const c6a = scenario('C6a 证据残缺（缺 noWriteResults / evaluated[].real）',
    ['--task', 'canary-broken', '--evidence', `gate/.canary/close/evidence/${brokenName}`],
    6, 'R4.1 前这条会作为**未捕获异常**退出未分配的 1。');
  results.push(c6a);

  const c6b = scenario('C6b 连 schema 都没有（不是 gate 证据）',
    ['--task', 'canary-notgate', '--evidence', `gate/.canary/close/evidence/${notGateName}`],
    3, 'schema 不符 ⇒ 无法裁决，**不是** 6（6 专指"是 gate 证据但残缺"）。');
  results.push(c6b);

  // 显式断言：两条分支都**没有**出现未分配的 1（判据写出来，别只靠"等于 6/3"隐含）
  const noUnallocated1 = c6a.actual !== 1 && c6b.actual !== 1;
  results.push({
    name: 'C6c 两条分支都**不再出现未分配的退出码 1**',
    expected: '≠1', actual: `${c6a.actual}/${c6b.actual}`, pass: noUnallocated1,
    out: '', tag: null,
  });
  console.log(`\n--- C6c 未分配的 1 不再出现 ---`);
  console.log(`  残缺=${c6a.actual} 非 gate 证据=${c6b.actual} —— ${noUnallocated1 ? '符合（都不为 1）' : '★不符'}`);

  const bad = results.filter((r) => !r.pass);
  const summary = {
    schema: 'gate-close-canary/v0',
    ranAt: new Date().toISOString(),
    node: process.version,
    fixtures: { accept: evARel, notrun: evBRel, fail: evCRel, fixtureRunCodes: { A: evA.code, B: evB.code, C: evC.code } },
    exitCodes: { accepted: 0, noPassEvidence: 2, cannotDecide: 3, hashDrift: 4, closingLine: 5, malformedEvidence: 6 },
    scenarios: results.map((r) => ({ name: r.name, expected: r.expected, actual: r.actual, pass: r.pass, tag: r.tag })),
    closingBlockSelfCheck: selfCheck,
  };
  mkdirSync(resolve(SUMMARY, '..'), { recursive: true });
  writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('\n== 汇总 ==');
  for (const r of results) console.log(`  ${r.pass ? 'OK  ' : 'FAIL'} ${r.name}  expected=${r.expected} actual=${r.actual}`);
  console.log(`  ${extraOk ? 'OK  ' : 'FAIL'} C4 收口行内容自检（GATE行 + evidence 路径 + notRun 点名 + CLOSE 收据）`);
  console.log(`  汇总 JSON：${rel(SUMMARY)}`);

  rmSync(CANARY, { recursive: true, force: true });
  rmdirEmptyParent(join(HERE, '.canary'));

  if (bad.length > 0 || !extraOk) {
    console.log(`CLOSE_CANARY: FAIL (${bad.length}/${results.length} 场景不符预期${extraOk ? '' : '；收口行内容自检未过'})`);
    return 1;
  }
  console.log(`CLOSE_CANARY: PASS (${results.length}/${results.length} 场景符合预期：三条拒绝路径各自可达且给出确切码，通过路径确实产出收口行)`);
  return 0;
}

process.exitCode = main();
