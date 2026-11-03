#!/usr/bin/env node
/**
 * gate/scripts/gen-tasks.mjs —— 描述符生成 / 机械核对。
 *
 * WHY（R2 补的洞）：R1 时适配器与 `gate/tasks/*.json` 是**两份**手写的东西，
 * 一致性靠 `_provenance` 里一句"以描述符为准"的**散文承诺**。散文不是检查项 ——
 * 这正是本 slice 一直在治的病（"声明由自述支撑，而不是由检查项支撑"）。
 * R2 起：**适配器是唯一事实来源**，`gate/tasks/*.json` 是它的**生成物**，
 * 并由本脚本 `--check` 机械核对（差异 ⇒ 非零退出）。
 *
 * 用法：
 *   node gate/scripts/gen-tasks.mjs --check    # 只核对（CI/回归用；有漂移 ⇒ exit 1）
 *   node gate/scripts/gen-tasks.mjs --write    # 覆写描述符（改适配器后跑）
 *
 * 说明：描述符里的 `<MAINREPO>` / `<VIVADO>` 是**占位符**，不是被替换的模板变量 ——
 *   目的是不把本机绝对路径钉进冻结件（换机器/换 checkout 仍可复现）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = resolve(import.meta.dirname, '..');
const ROOT = resolve(HERE, '..');
const TASKS = join(HERE, 'tasks');

/** 五个域（guards 是 R1 的，R2 起也纳入生成/核对）。 */
const DOMAINS = ['guards-suite', 'docs', 'android', 'backend', 'fpga'];

/** 递归排序 key，用于"与 key 顺序无关"的深比较。 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const serial = (v) => JSON.stringify(canonical(v));

async function load() {
  const out = [];
  for (const d of DOMAINS) {
    // ★ Windows 上动态 import 必须给 file:// URL：直接传 `E:\...\x.mjs` 会
    //   ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'e:'）—— 实测踩过。
    const url = pathToFileURL(join(HERE, 'adapters', `${d}.mjs`)).href;
    const mod = await import(url);
    if (typeof mod.buildTask !== 'function') {
      out.push({ domain: d, error: '适配器未导出 buildTask()（描述符生成源）' });
      continue;
    }
    out.push({ domain: d, task: mod.buildTask(), describe: mod.describe?.() ?? null });
  }
  return out;
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  mkdirSync(TASKS, { recursive: true });
  const specs = [];
  // 顶层 await 在 ESM 里可用；这里用同步包装避免顶层 await（Node 24 支持，但保持直白）
  return load().then((loaded) => {
    let drift = 0;
    let hardFail = 0;
    // ★ 汇总必须统计**全部**域名，不是只统计"已一致"的那些 ——
    //   早先版本把 totals 放在 `if (same)` 分支里累加，于是 `--write` 那一跑
    //   汇总印出 `assertions_total=0`（实际 14）。**汇总行印错数字比不印更坏。**
    const all = loaded.filter((l) => !l.error).map((l) => l.task);
    for (const l of loaded) {
      if (l.error) {
        console.log(`  [FAIL] ${l.domain}: ${l.error}`);
        hardFail += 1;
        continue;
      }
      const { task } = l;
      const file = join(TASKS, `${task.taskId}.json`);
      const body = `${JSON.stringify(task, null, 2)}\n`;
      const exists = existsSync(file);
      const pinned = exists ? readFileSync(file, 'utf8') : null;
      const same = exists && serial(JSON.parse(pinned)) === serial(task);
      const tag = same ? 'IN SYNC' : (exists ? '★DRIFT ' : 'MISSING');
      const acc = (task.acceptance || []).length;
      const nr = (task.notRun || []).length;
      console.log(`  [${tag}] ${l.domain.padEnd(14)} ${task.taskId.padEnd(18)} assertions=${acc} notRun=${nr}`);
      if (same) { specs.push({ domain: l.domain, taskId: task.taskId, acc, nr, file }); continue; }
      drift += 1;
      if (mode === 'write') {
        writeFileSync(file, body, 'utf8');
        console.log(`           -> 已写入 ${file.replace(ROOT + '\\', '').replace(/\\/g, '/')}`);
      } else if (exists) {
        // 只报**第一处**差异，避免刷屏；完整比对留给 --write 后看 git diff
        const a = canonical(JSON.parse(pinned));
        const b = canonical(task);
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
          if (serial(a[k]) !== serial(b[k])) {
            console.log(`           差异在字段 \`${k}\`：`);
            console.log(`             描述符: ${serial(a[k]).slice(0, 160)}`);
            console.log(`             适配器: ${serial(b[k]).slice(0, 160)}`);
            break;
          }
        }
        console.log('           -> 跑 `node gate/scripts/gen-tasks.mjs --write` 重新生成（改适配器后必须跑）');
      } else {
        console.log('           -> 描述符不存在；跑 `--write` 生成');
      }
    }

    // 汇总统计**全部**域名（含刚被 --write 覆写的），不只看 in_sync 的那些
    const totalAcc = all.reduce((a, t) => a + (t.acceptance || []).length, 0);
    const totalNr = all.reduce((a, t) => a + (t.notRun || []).length, 0);
    const zeroAssert = all.filter((t) => (t.acceptance || []).length === 0);
    console.log(`\n  domains=${loaded.length} in_sync=${specs.length} drift=${drift} assertions_total=${totalAcc} notRun_total=${totalNr}`);
    console.log(`  零断言域名（只能 UNVERIFIED，禁止 exit 0 冒充通过）：${zeroAssert.map((t) => t.taskId).join(', ') || '(无)'}`);

    if (hardFail > 0) { console.log('ADAPTER_DESCRIPTOR_SYNC: FAIL (适配器自身有问题)'); return 1; }
    if (mode === 'write') { console.log('ADAPTER_DESCRIPTOR_SYNC: WRITTEN'); return 0; }
    if (drift > 0) { console.log(`ADAPTER_DESCRIPTOR_SYNC: FAIL (${drift} 个描述符与适配器不一致 —— 这是"两份事实"的复发)`); return 1; }
    console.log('ADAPTER_DESCRIPTOR_SYNC: PASS (5/5 描述符与适配器逐字段一致)');
    return 0;
  });
}

// ★ 必须 await：main() 返回的是 Promise（它内部要 import 五个适配器）。
//   直接 `process.exitCode = main()` 会把 Promise 塞给 exitCode ⇒ ERR_INVALID_ARG_TYPE
//   （实测踩过：三个模式全崩，但**崩之前打印都正常**，很容易被误读成"跑过了"）。
process.exitCode = await main();
