#!/usr/bin/env node
/**
 * gate/scripts/close-e2e.mjs —— 在**真实任务**上走一遍端到端收口（TASK.3 §2-A2）。
 *
 * 它同时是三件事：
 *   1. **通过路径的真实证据**（不是合成夹具）：对 `--task` 指定的真任务，
 *      真跑 `gate.mjs` 拿证据 → 写收口行草稿 → `close.mjs` 收口 → **exit 0**；
 *   2. **接线示范**（TASK.3 §0「产出收口行 + 引用证据 JSON 路径」）：产出的块可以直接贴 HANDOFF；
 *   3. 反证 canary 不是"恒红"：合成夹具能过、真任务也能过。
 *
 * 工作流（与 `gate/templates/HANDOFF-GATE.md` 及 SPEC §3.7 一致）：
 *   `gate.mjs` 的 stdout 里本来就有 `GATE …` 行 → 抄进草稿 →
 *   `close.mjs` 校验草稿（GATE 行与证据逐字一致 + notRun 逐个点名）→ 通过后产出收口块。
 *
 * 用法：node gate/scripts/close-e2e.mjs [--task gate/tasks/docs-links-r2.json]
 * 退出码：0 = 收口成功；非 0 = 收口被拒（透传 close.mjs 的码）。
 */

import { mkdirSync, openSync, closeSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const ROOT = resolve(HERE, '..');
const NODE = process.execPath;
const TMP = join(HERE, '.canary', 'close-e2e');

const rel = (p) => p.replace(ROOT, '').replace(/^[\\/]/, '').replace(/\\/g, '/');

/** 跑命令并捕获 stdout（本沙箱管道 EPERM ⟹ fd 重定向）。 */
function runCapture(args) {
  mkdirSync(TMP, { recursive: true });
  const o = join(TMP, `out-${Date.now()}.txt`);
  const fd = openSync(o, 'w');
  const r = spawnSync(NODE, args, { cwd: ROOT, stdio: ['ignore', fd, 'ignore'] });
  closeSync(fd);
  let out = '';
  try { out = readFileSync(o, 'utf8'); } catch { /* 忽略 */ }
  return { code: r.status, out };
}

function main() {
  const argv = process.argv.slice(2);
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const taskRel = val('--task', 'gate/tasks/docs-links-r2.json');
  const taskAbs = resolve(ROOT, taskRel);

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // 1) 真跑任务，拿证据 + GATE 行
  const runOut = runCapture([join(HERE, 'gate.mjs'), '--task', taskRel]);
  console.log(`[1/4] 真跑 ${taskRel} → 退出码 ${runOut.code}`);
  const gateLine = (runOut.out.split(/\r?\n/).find((l) => /^GATE\s/.test(l)) || '').trim();
  const evLine = (runOut.out.split(/\r?\n/).find((l) => /^evidence:\s/.test(l)) || '').trim();
  if (runOut.code !== 0 || !gateLine || !evLine) {
    console.log(`  ⟹ 任务本身没通过（exit=${runOut.code}），无法演示收口。`);
    rmSync(TMP, { recursive: true, force: true });
    return runOut.code || 2;
  }
  // ★ `gate.mjs` 打印的是**绝对**路径；收口块里写的是**仓库相对**路径 ⟹ 这里必须归一化，
  //   否则第 4 步自检会因为"拿绝对路径去相对路径里找"而假失败（实测踩过）。
  const evRel = rel(evLine.replace(/^evidence:\s*/, '').trim());
  console.log(`  GATE 行：${gateLine}`);
  console.log(`  证据：${evRel}`);

  // 2) 从证据里取 notRun，写草稿（这就是写者要贴进 HANDOFF 的那段）
  const ev = JSON.parse(readFileSync(resolve(ROOT, evRel), 'utf8'));
  const notRun = ev.notRun || [];
  const draftLines = [gateLine, `evidence: ${evRel}`];
  if (notRun.length > 0) {
    draftLines.push('', '**NOT RUN:**', '');
    for (const nr of notRun) draftLines.push(`- \`${nr.id}\` ${nr.what} —— ${nr.why}（前置：${nr.precondition}）`);
  }
  const draftPath = join(TMP, 'draft.md');
  writeFileSync(draftPath, `${draftLines.join('\n')}\n`, 'utf8');
  console.log(`[2/4] 草稿已写：${rel(draftPath)}（含 ${notRun.length} 条 notRun 点名）`);

  // 3) 收口
  const outPath = join(HERE, 'evidence', `close-${ev.taskId}.md`);
  const closeRun = runCapture([
    join(HERE, 'close.mjs'), '--task', ev.taskId, '--evidence', evRel,
    '--draft', rel(draftPath), '--out', rel(outPath),
  ]);
  console.log(`[3/4] close.mjs → 退出码 ${closeRun.code}`);
  for (const l of closeRun.out.split(/\r?\n/)) if (l.trim()) console.log(`  | ${l}`);

  // 4) 自检产出的收口块
  let block = '';
  try { block = readFileSync(outPath, 'utf8'); } catch { /* 未产出 */ }
  const checks = {
    退出码为0: closeRun.code === 0,
    含规范GATE行: block.includes(gateLine),
    含证据路径: block.includes(evRel),
    含notRun点名: notRun.every((nr) => block.includes(nr.id)),
    含CLOSE收据: /^CLOSE: /m.test(block),
  };
  console.log('[4/4] 收口块自检：');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'OK  ' : 'FAIL'} ${k}`);

  rmSync(TMP, { recursive: true, force: true });
  // 清掉自己用过的空父目录（只在确属空目录时成功；别的 canary 还在用就保留）
  try { rmdirSync(join(HERE, '.canary')); } catch { /* 非空或不存在：不动 */ }

  const ok = Object.values(checks).every(Boolean);
  console.log(ok
    ? `CLOSE_E2E: PASS (真实任务 ${ev.taskId} 收口成功，收口块：${rel(outPath)})`
    : 'CLOSE_E2E: FAIL (收口块自检未过)');
  return ok ? 0 : 1;
}

process.exitCode = main();
