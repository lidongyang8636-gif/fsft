#!/usr/bin/env node
/**
 * gate/scripts/check-doc-links.mjs —— docs 域链接判据（**会判红**）。
 *
 * WHY 自己实现（TASK.2 §1 明令）：现场现役的 `.cache/dsh-guard/link_gate.py` **永不判红** ——
 * 实测 `link gate: ok=67  missing=2` 仍然 `exit=0`（源码里 `bad` 只参与打印）。
 * "跑过它"因此不能作为任何验收证据。本脚本把同一件事做成**真判据**。
 *
 * 与 link_gate.py 的三条**有意差异**（每一条都对着一个实测缺陷）：
 *
 * 1. **missing>0 ⇒ 非零退出**。不是"打印一下"。
 * 2. **全工作区数字会漂 ⇒ 必须钉基线**。本脚本不把"missing 的总数"当判据，
 *    而是要求 **undeclared missing == 0**：**点名的已知断链**必须写进 exceptions 文件并给理由
 *    （与现场 `four-layer-pending.json` 同族：已知差异必须**声明**，不许删掉以消音）。
 *    exceptions 里"已经不再断"的条目会作为 `STALE` **打印出来**（不判红：修好别人的断链是好事，
 *    不该把我们的门搞红；但也绝不允许它静默留着）。
 * 3. **扫到 0 条链接 = 无法裁决（exit 2），不是 PASS**。
 *    （同族先例：`four-layer-strings.py` 把"某层 0 命中"直接判 FAIL —— 一个静默坏掉的正则
 *      不能因为"没查到东西"而看起来是绿的。）
 *
 * 用法：
 *   node gate/scripts/check-doc-links.mjs [--root .] [--scope docs]
 *        [--exceptions gate/adapters/docs.exceptions.json] [--quiet]
 *
 * 退出码：
 *   0 = undeclared missing == 0 且链接数 > 0
 *   1 = undeclared missing > 0（判红）
 *   2 = 无法裁决：scope 不存在 / 链接数 == 0 / exceptions 文件非法
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch', 'render_review']);

function parse(argv) {
  const o = { root: '.', scope: 'docs', exceptions: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--quiet') { o.quiet = true; continue; }
    if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1]; i += 1; }
  }
  return o;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) acc.push(p);
  }
  return acc;
}

/** 抽链接：只认 markdown 行内链接 `](target)` 与裸尖括号 `<target>` 不处理（保持与现场同口径）。 */
function linksIn(text) {
  const out = [];
  const RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = RE.exec(text)) !== null) out.push(m[1]);
  return out;
}

function isExternal(t) {
  return /^(https?:|mailto:|tel:|ftp:|data:)/i.test(t) || t.startsWith('#') || t.startsWith('//');
}

function main() {
  const args = parse(process.argv.slice(2));
  const root = resolve(args.root);
  const scopeAbs = resolve(root, args.scope);
  const p = (...s) => { if (!args.quiet) console.log(...s); };

  if (!existsSync(scopeAbs) || !statSync(scopeAbs).isDirectory()) {
    console.log(`DOC_LINK_ZERO_SCOPE: 扫描范围不存在或不是目录：${scopeAbs}`);
    console.log('DOC_LINK_RESULT: UNVERIFIED (无法裁决：范围不存在)');
    return 2;
  }

  // exceptions（已知断链的**声明**；缺文件 = 允许，表示"一条都不许断"）
  let exceptions = [];
  let excProblem = null;
  if (args.exceptions) {
    const ep = resolve(root, args.exceptions);
    if (!existsSync(ep)) {
      excProblem = `exceptions 文件不存在：${ep}（要么给出文件，要么显式传 --exceptions '' 表示零容忍）`;
    } else {
      try {
        const raw = JSON.parse(readFileSync(ep, 'utf8'));
        const arr = Array.isArray(raw) ? raw : raw.entries;
        if (!Array.isArray(arr)) throw new Error('顶层既不是数组，也没有 entries[]');
        exceptions = arr.map((e) => ({
          file: String(e.file || '').replace(/\\/g, '/'),
          target: String(e.target || ''),
          reason: e.reason || '(未写理由)',
          since: e.since || null,
        }));
        for (const e of exceptions) {
          if (!e.file || !e.target || !e.reason || e.reason === '(未写理由)') {
            excProblem = `exceptions 条目缺 file/target/reason：${JSON.stringify(e)}`;
          }
        }
      } catch (err) {
        excProblem = `exceptions 文件无法解析：${err.message}`;
      }
    }
  }
  if (excProblem) {
    console.log(`DOC_LINK_BAD_EXCEPTIONS: ${excProblem}`);
    console.log('DOC_LINK_RESULT: UNVERIFIED (无法裁决：exceptions 非法)');
    return 2;
  }

  const files = walk(scopeAbs).sort();
  const missing = [];
  const staleCandidates = new Map(exceptions.map((e) => [`${e.file}::${e.target}`, e]));
  let ok = 0;
  let considered = 0;

  for (const f of files) {
    const rel = relative(root, f).replace(/\\/g, '/');
    const text = readFileSync(f, 'utf8');
    for (const raw of new Set(linksIn(text))) {
      if (isExternal(raw)) continue;
      considered += 1;
      const target = raw.split('#')[0].split('?')[0];
      if (!target) continue;
      let abs = resolve(dirname(f), target);
      let exists = existsSync(abs);
      if (!exists) {
        // 容忍 URL 编码（%20 等）——只试一次，不猜第二遍
        try {
          const dec = decodeURIComponent(target);
          if (dec !== target) { abs = resolve(dirname(f), dec); exists = existsSync(abs); }
        } catch { /* 编码坏了就当不存在 */ }
      }
      if (exists) { ok += 1; staleCandidates.delete(`${rel}::${raw}`); continue; }
      missing.push({ file: rel, target: raw });
    }
  }

  if (considered === 0) {
    console.log(`DOC_LINK_ZERO_LINKS: scope=${args.scope} 下扫到 **0** 条相对链接（files=${files.length}）`);
    console.log('  ⟹ 0 条链接**不是通过**：可能是范围给错/全被过滤掉了。判为无法裁决。');
    console.log('DOC_LINK_RESULT: UNVERIFIED (无法裁决：零命中)');
    return 2;
  }

  const isDeclared = (m) => exceptions.some((e) => e.file === m.file && e.target === m.target);
  const declared = missing.filter(isDeclared);
  const undeclared = missing.filter((m) => !isDeclared(m));

  // STALE = 声明了但现在不断（被修好了，或声明写错了）—— 打印，不判红
  const stale = [...staleCandidates.values()].filter((e) => {
    const stillMissing = missing.some((m) => m.file === e.file && m.target === e.target);
    return !stillMissing;
  });

  p(`doc-links: scope=${args.scope} files=${files.length} links=${considered} ok=${ok}`);
  p(`  declared exceptions = ${exceptions.length}`);
  for (const m of declared) {
    const e = exceptions.find((x) => x.file === m.file && x.target === m.target);
    p(`  ~ DECLARED  ${m.file}  ->  ${m.target}   <- ${e.reason}`);
  }
  for (const m of undeclared) p(`  ! MISSING   ${m.file}  ->  ${m.target}`);
  for (const e of stale) p(`  ? STALE     ${e.file}  ->  ${e.target}   （已不再断链：target 现已存在）`);
  p(`  undeclared missing = ${undeclared.length}   declared = ${declared.length}   stale = ${stale.length}`);

  if (undeclared.length > 0) {
    p(`DOC_LINK_RESULT: FAIL ok=${ok} missing=${undeclared.length} declared=${declared.length} stale=${stale.length}`);
    return 1;
  }
  p(`DOC_LINK_RESULT: PASS ok=${ok} missing=0 declared=${declared.length} stale=${stale.length}`);
  return 0;
}

process.exitCode = main();
