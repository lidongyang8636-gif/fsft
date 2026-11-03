#!/usr/bin/env node
/**
 * gate/close.mjs —— gate slice 的**唯一收口入口**（R3a）。
 *
 * 「收口 = `gate/close.mjs` 通过」—— 见 `gate/SPEC.md` §3.9 与 `gate/MAINTENANCE.md` §2.2。
 *
 * ★★ 它的边界（**先读这段，再读实现**）：
 *   · 它**不拦手写收口行**：任何人都可以手写一段长得一样的 GATE 段，本工具**无法阻止**。
 *   · 它**不防伪造**：证据 JSON 是普通文件、**没有签名**；想骗它的人可以自己造一份
 *     自洽的 JSON（连哈希一起造）。本工具不是安全边界。
 *   · 它能做的**只有一件事**：让"按规矩收口"成为**最省事**的路 ——
 *     要拿收口行，就得先有一份**能通过三条检查**的证据。
 *   ⟹ **不许**把它描述成"拦截层"。真正的拦截（能 deny 动作）是 R3b，**本轮未做**（TASK.3 §0）。
 *
 * 三条拒绝路径（TASK.3 §0 表格，逐条对应一个**独立退出码**，便于 canary 断言**确切**码）：
 *
 *   | # | 拒绝条件 | 退出码 |
 *   |---|---|---|
 *   | 1 | 没有 PASS 证据（无证据文件 / `gateOk≠true` / `PASS=0` / 零断言） | **2** |
 *   | 2 | 证据与当前文件哈希**漂移**（含"pin 无法重算"—— fail-closed） | **4** |
 *   | 3 | `notRun[]` 非空但**收口行未写明**（缺收口行 / 缺 notRun 条目 / GATE 行与证据不符） | **5** |
 *
 * 另有 `3` = 无法裁决（用法错误、证据不是合法 gate 证据、`--root` 不存在）；
 * `6` = **证据残缺**（R4.1 新增：缺必需字段 / 字段类型不对 / 兜底异常）。
 * 检查**有先后**（否则多条同时命中时退出码不稳定）：① 无 PASS 证据 → ② 漂移 → ③ 收口行。
 *
 * ★ R4.1 补的一个洞：喂一份**残缺**证据（例如缺 `noWriteResults` 或 `evaluated[].real.exit`）时，
 *   `gateRef()` 会抛 `TypeError` ⇒ 作为**未捕获异常**退出 **1** —— 而 `1` 在本契约里**未分配**
 *   （调用方按 0/2/3/4/5 分流，会把 1 读成"未知"）。现在改为：**先做形状校验**，残缺一律 **6**，
 *   并在 `main()` 外面加**兜底 try/catch**，保证任何意外都不再逃逸成 1。
 *
 * 用法：
 *   node gate/close.mjs --task <taskId> --evidence <证据.json> [--draft <我的收口块.md>]
 *                       [--out <写出收口块>] [--root .]
 *
 *   --draft  条件必填：**当证据的 `notRun[]` 非空时必需；缺失 ⇒ 退出码 5**。
 *            它应当是你打算贴进 HANDOFF 的那一段。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { gateRef } from './lib/runner.mjs';

export const CLOSE_EXIT = Object.freeze({
  ACCEPTED: 0,
  REJECT_NO_PASS_EVIDENCE: 2,
  CANNOT_DECIDE: 3,
  REJECT_HASH_DRIFT: 4,
  REJECT_CLOSING_LINE: 5,
  REJECT_MALFORMED_EVIDENCE: 6,   // R4.1：证据残缺（原先会崩成**未分配**的 1）
});

function parse(argv) {
  const o = { root: '.', draft: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1]; i += 1; }
  }
  return o;
}

const sha256 = (abs, n = 64) => {
  try { return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, n); } catch { return null; }
};

/**
 * 证据**形状**校验（R4.1）：收口要用到的字段必须齐全且类型正确。
 *
 * WHY：`gateRef()` 会直接读 `ev.noWriteResults.length` 与 `evaluated[].real.exit`；
 * 残缺证据会让它抛 `TypeError` ⇒ 未捕获 ⇒ 退出码 **1**（契约里未分配）。
 * 与其让调用方拿到一个"未知码"，不如**在入口就说清楚缺什么**，返回 **6**。
 */
export function evidenceShapeErrors(ev) {
  const errs = [];
  if (!ev || typeof ev !== 'object') return ['证据不是对象'];
  if (typeof ev.taskId !== 'string') errs.push('缺 taskId（或不是字符串）');
  if (!ev.taskState || typeof ev.taskState !== 'object') errs.push('缺 taskState');
  else {
    if (typeof ev.taskState.gateOk !== 'boolean') errs.push('缺 taskState.gateOk（或不是布尔）');
    if (!ev.taskState.counts || typeof ev.taskState.counts !== 'object') errs.push('缺 taskState.counts');
    else if (!Number.isInteger(ev.taskState.counts.PASS)) errs.push('缺 taskState.counts.PASS（或不是整数）');
  }
  if (!Array.isArray(ev.evaluated)) errs.push('缺 evaluated（或不是数组）');
  else {
    ev.evaluated.forEach((e, i) => {
      if (!e || typeof e !== 'object') { errs.push(`evaluated[${i}] 不是对象`); return; }
      if (typeof e.id !== 'string') errs.push(`evaluated[${i}] 缺 id`);
      if (!e.real || typeof e.real !== 'object') errs.push(`evaluated[${i}] 缺 real（gateRef 要读 real.exit）`);
    });
  }
  if (!Array.isArray(ev.noWriteResults)) errs.push('缺 noWriteResults（gateRef 直接读 .length）');
  if (ev.notRun !== undefined && !Array.isArray(ev.notRun)) errs.push('notRun 不是数组');
  if (ev.pins !== undefined && (ev.pins === null || typeof ev.pins !== 'object')) errs.push('pins 不是对象');
  return errs;
}

/** 收集这份证据"钉住"的全部文件（描述符 / 判据机器 / 声明 / 被验文件）。 */
export function collectPins(ev) {
  const out = [];
  const add = (p, why) => {
    if (!p || !p.path) return;
    out.push({ path: p.path, expected: p.sha256 ?? null, expectedExists: p.exists ?? null, why: why || p.note || '' });
  };
  const pins = ev.pins || {};
  add(pins.descriptor, pins.descriptor?.note || '任务描述符');
  for (const m of pins.machinery || []) add(m, m.note || '判据机器');
  for (const d of pins.declared || []) add(d, d.note || 'hashFiles 声明');
  for (const e of ev.evaluated || []) {
    for (const f of e.files || []) {
      if (!f || !f.path) continue;
      // 断言级记录的是**截断**哈希（默认 16 位）；按它自己的长度重算，两种长度都能比
      out.push({ path: f.path, expected: f.sha256 ?? null, expectedExists: f.exists ?? null, why: `断言 ${e.id} 的点名文件` });
    }
  }
  // 去重（同一文件可能既被断言点名、又被 hashFiles 声明）
  const seen = new Map();
  for (const p of out) {
    const k = p.path;
    if (!seen.has(k)) seen.set(k, p);
    else {
      const prev = seen.get(k);
      // 保留更强的一条（有期望哈希者优先）
      if (!prev.expected && p.expected) seen.set(k, p);
    }
  }
  return [...seen.values()];
}

/**
 * 重算所有 pin。返回 { rows, drifted }。
 * **fail-closed**：期望有哈希却算不出来（文件消失 / 读不了）⟹ 记为 drift，而不是跳过。
 */
export function verifyPins(ev, root) {
  const rows = [];
  for (const p of collectPins(ev)) {
    const abs = resolve(root, p.path);
    const existsNow = existsSync(abs);
    let actual = null;
    if (existsNow && p.expected) actual = sha256(abs, String(p.expected).length);
    let ok;
    let how;
    if (!p.expected || String(p.expected).startsWith('UNAVAILABLE')) {
      // 期望侧本来就没哈希：只比存在性
      ok = (p.expectedExists === false) ? !existsNow : existsNow;
      how = `无期望哈希，仅比存在性（期望 exists=${p.expectedExists}，实测 ${existsNow}）`;
    } else if (!existsNow) {
      ok = false; how = '期望有哈希，但文件**已不存在**';
    } else if (actual === null) {
      ok = false; how = '期望有哈希，但**重算失败**（fail-closed：记为漂移）';
    } else {
      ok = actual === p.expected;
      how = ok ? `哈希一致（${String(p.expected).slice(0, 16)}…）` : `哈希不符 期望 ${String(p.expected).slice(0, 16)}… 实测 ${String(actual).slice(0, 16)}…`;
    }
    rows.push({ path: p.path, why: p.why, expected: p.expected, actual, existsNow, ok, how });
  }
  return { rows, drifted: rows.filter((r) => !r.ok) };
}

/** notRun 条目必须在收口行里**被点名**（按 id，独立 token，避免 DN1 命中 DN10）。 */
export function missingNotRunIds(ev, draftText) {
  const ids = (ev.notRun || []).map((n) => String(n.id));
  return ids.filter((id) => {
    const re = new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
    return !re.test(draftText);
  });
}

/** 从收口块里抽出 GATE 行。 */
export function extractGateLine(text) {
  const m = String(text || '').split(/\r?\n/).find((l) => /^GATE\s+\S/.test(l.trim()));
  return m ? m.trim() : null;
}

/** 产出可直接贴 HANDOFF 的收口块（TASK.3 §0「通过时产出收口行」）。 */
export function closingBlock(ev, evidenceRel, pinCount) {
  const L = [];
  L.push('## GATE');
  L.push('');
  L.push('```');
  L.push(gateRef(ev));
  L.push('```');
  L.push('');
  L.push(`evidence: ${evidenceRel}`);
  if ((ev.notRun || []).length > 0) {
    L.push('');
    L.push('**NOT RUN:**');
    L.push('');
    for (const nr of ev.notRun) {
      L.push(`- \`${nr.id}\` ${nr.what} —— ${nr.why}（前置：${nr.precondition}）`);
    }
  }
  L.push('');
  L.push(`CLOSE: ${ev.taskId} accepted ${new Date().toISOString()}`
    + ` | evidence sha256=${sha256(resolve(evidenceRel), 64) === null ? '(n/a)' : sha256(resolve(evidenceRel), 64).slice(0, 32)}…`
    + ` | pins checked=${pinCount} drifted=0`);
  L.push('> 收口由 `gate/close.mjs` 判定：**它不拦手写收口行、不防伪造**（见 `gate/SPEC.md` §3.9）。');
  return L.join('\n');
}

function reject(code, tag, lines) {
  console.log(`CLOSE_REJECT: ${tag}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log(`  ⟹ 拒绝收口（退出码 ${code}）。**没有收口行**，这一轮不得宣告收口。`);
  return code;
}

function main() {
  const args = parse(process.argv.slice(2));
  const root = resolve(args.root || process.cwd());
  if (!args.task || !args.evidence) {
    console.error('CLOSE-USAGE: 需要 --task <taskId> --evidence <证据.json> [--draft <file>] [--out <file>]');
    console.error('             --draft 为条件必填：notRun[] 非空时必需；缺失 ⇒ 退出码 5');
    return CLOSE_EXIT.CANNOT_DECIDE;
  }
  if (!existsSync(root)) {
    console.error(`CLOSE-USAGE: --root 不存在：${root}`);
    return CLOSE_EXIT.CANNOT_DECIDE;
  }
  const evAbs = resolve(root, args.evidence);

  // ---------------- 路径 1：没有 PASS 证据 ----------------
  if (!existsSync(evAbs)) {
    return reject(CLOSE_EXIT.REJECT_NO_PASS_EVIDENCE, 'REJECT_NO_PASS_EVIDENCE', [
      `证据文件不存在：${evAbs}`,
      '「我跑过」不是证据；这一轮**没有可收口的东西**。',
    ]);
  }
  let ev;
  try {
    ev = JSON.parse(readFileSync(evAbs, 'utf8'));
  } catch (err) {
    console.error(`CLOSE-CANNOT-DECIDE: 证据不是合法 JSON：${evAbs}\n  ${err.message}`);
    return CLOSE_EXIT.CANNOT_DECIDE;
  }
  if (ev.schema !== 'gate-evidence/v0') {
    console.error(`CLOSE-CANNOT-DECIDE: 不是 gate 证据（schema=${JSON.stringify(ev.schema)}）`);
    return CLOSE_EXIT.CANNOT_DECIDE;
  }
  if (ev.taskId !== args.task) {
    return reject(CLOSE_EXIT.REJECT_NO_PASS_EVIDENCE, 'REJECT_NO_PASS_EVIDENCE', [
      `证据的 taskId=${JSON.stringify(ev.taskId)} 与 --task ${JSON.stringify(args.task)} 不符`,
      '⟹ 这份证据**不是这个任务**的；对当前任务而言等于"没有证据"。',
    ]);
  }
  // ★ R4.1：先做形状校验 —— 残缺证据一律 6，不让它崩成未分配的 1
  const shapeErrs = evidenceShapeErrors(ev);
  if (shapeErrs.length > 0) {
    return reject(CLOSE_EXIT.REJECT_MALFORMED_EVIDENCE, 'REJECT_MALFORMED_EVIDENCE', [
      `证据形状不合法（${shapeErrs.length} 条）⟹ 无法据它收口：`,
      ...shapeErrs.map((e) => `  · ${e}`),
      '（这条路径在 R4.1 之前是"未捕获异常 ⇒ 退出码 1"，而 1 在本契约里未分配。）',
    ]);
  }
  const counts = (ev.taskState && ev.taskState.counts) || {};
  const passCount = counts.PASS || 0;
  const evaluated = ev.evaluated || [];
  const noPassReasons = [];
  if (!ev.taskState || ev.taskState.gateOk !== true) {
    noPassReasons.push(`证据的 gateOk=${JSON.stringify(ev.taskState && ev.taskState.gateOk)}（verdict=${JSON.stringify(ev.taskState && ev.taskState.verdict)}）⟹ 该次运行**没有通过**`);
  }
  if (passCount === 0) noPassReasons.push('PASS 断言数 = 0 ⟹ 没有任何被验证的主张');
  if (evaluated.length === 0) noPassReasons.push('断言数 = 0 ⟹ 这个域本轮**什么都没验**（只有 notRun 声明的域走这条）');
  const notRun = ev.notRun || [];
  if (notRun.length > 0 && evaluated.length === 0) {
    noPassReasons.push(`notRun 有 ${notRun.length} 条 ⟹ 跑不了的域**不产出收口行**（不许把"跑不了"降级成"通过"）`);
  }
  if (noPassReasons.length > 0) {
    return reject(CLOSE_EXIT.REJECT_NO_PASS_EVIDENCE, 'REJECT_NO_PASS_EVIDENCE', [
      `证据：${relative(root, evAbs).replace(/\\/g, '/')}`,
      ...noPassReasons,
    ]);
  }

  // ---------------- 路径 2：哈希漂移 ----------------
  const { rows, drifted } = verifyPins(ev, root);
  if (drifted.length > 0) {
    return reject(CLOSE_EXIT.REJECT_HASH_DRIFT, 'REJECT_HASH_DRIFT', [
      `证据：${relative(root, evAbs).replace(/\\/g, '/')}`,
      `${drifted.length} / ${rows.length} 个 pin 与当前文件不符（**收口后改文件 ⇒ 证据作废**）：`,
      ...drifted.map((d) => `  · ${d.path}  [${d.why}] ${d.how}`),
    ]);
  }

  // ---------------- 路径 3：收口行未按规矩写明 ----------------
  const canonical = gateRef(ev);
  let draftText = null;
  if (args.draft) {
    const dAbs = resolve(root, args.draft);
    if (!existsSync(dAbs)) {
      return reject(CLOSE_EXIT.REJECT_CLOSING_LINE, 'REJECT_CLOSING_LINE', [`--draft 指定的文件不存在：${dAbs}`]);
    }
    draftText = readFileSync(dAbs, 'utf8');
  }
  if (notRun.length > 0) {
    if (draftText === null) {
      return reject(CLOSE_EXIT.REJECT_CLOSING_LINE, 'REJECT_CLOSING_LINE', [
        `证据里有 ${notRun.length} 条 notRun，但**没有给出收口行**（缺 --draft）`,
        `未跑项必须**显式出现在收口行**里：${notRun.map((n) => n.id).join(', ')}`,
      ]);
    }
    const missing = missingNotRunIds(ev, draftText);
    if (missing.length > 0) {
      return reject(CLOSE_EXIT.REJECT_CLOSING_LINE, 'REJECT_CLOSING_LINE', [
        `收口行里**没有点名**这些未跑项：${missing.join(', ')}`,
        '未跑项不许被省略；省略在阅读端与"全部通过"无法区分。',
      ]);
    }
  }
  if (draftText !== null) {
    const got = extractGateLine(draftText);
    if (!got) {
      return reject(CLOSE_EXIT.REJECT_CLOSING_LINE, 'REJECT_CLOSING_LINE', ['收口行里没有 `GATE <taskId> …` 行']);
    }
    if (got !== canonical) {
      return reject(CLOSE_EXIT.REJECT_CLOSING_LINE, 'REJECT_CLOSING_LINE', [
        '收口行里的 GATE 行与证据**不一致**（数字不许手改）：',
        `  收口行：${got}`,
        `  证据中：${canonical}`,
      ]);
    }
  }

  // ---------------- 通过 ----------------
  const evidenceRel = relative(root, evAbs).replace(/\\/g, '/');
  const block = closingBlock(ev, evidenceRel, rows.length);
  console.log(`CLOSE_ACCEPTED: ${ev.taskId}`);
  console.log(`  证据：${evidenceRel}`);
  console.log(`  pins 重算：${rows.length} 条，漂移 0 条`);
  console.log(`  notRun：${notRun.length} 条${notRun.length ? `（已点名：${notRun.map((n) => n.id).join(', ')}）` : '（无）'}`);
  console.log('');
  console.log(block);
  if (args.out) {
    const outAbs = resolve(root, args.out);
    writeFileSync(outAbs, `${block}\n`, 'utf8');
    console.log('');
    console.log(`  收口块已写入：${relative(root, outAbs).replace(/\\/g, '/')}`);
  }
  return CLOSE_EXIT.ACCEPTED;
}

let __code;
try {
  __code = main();
} catch (err) {
  // ★ R4.1 兜底：main() 里任何未预期异常都不许逃逸成**未分配**的 1。
  console.error(`CLOSE-UNEXPECTED: ${err && err.stack ? err.stack : String(err)}`);
  console.log('CLOSE_REJECT: REJECT_MALFORMED_EVIDENCE');
  console.log('  main() 抛出未预期异常 ⟹ 按"证据/环境不可用"处理（R4.1 起本码为 6，原先会逃逸成 1）。');
  __code = CLOSE_EXIT.REJECT_MALFORMED_EVIDENCE;
}
process.exitCode = __code;
