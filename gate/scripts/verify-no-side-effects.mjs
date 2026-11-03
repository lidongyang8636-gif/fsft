#!/usr/bin/env node
/**
 * gate/scripts/verify-no-side-effects.mjs —— A5「无副作用」的可复算证明。
 *
 * 做法：对**工作区全树**做内容指纹（path → size+mtime+sha256），跑完一轮 gate 后再取一次，
 * 逐条列出**变化的路径**，并对照"允许变化的清单"给出裁定。
 *
 * ★ 为什么不能只说"我看过了"：guard 测试**确实会写** `.cache/dsh-guard/**`
 *   （G07 重生成 js-allow/js-deny、G09 构造 profile-patch）。那是已知且可解释的，
 *   所以本脚本**不假装零变化**——它把变化逐条列出来，并逐条判"在不在白名单里"。
 *
 * 用法：
 *   node gate/scripts/verify-no-side-effects.mjs --before   # 取跑前指纹
 *   node gate/scripts/verify-no-side-effects.mjs --after    # 取跑后指纹并裁定
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const SNAP = join(HERE, 'evidence', '_sideeffect-snapshot.json');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.scratch', 'xsim.dir', '.Xil',
  'vivado.log', 'webtalk.log', 'xsim.log', 'xvlog.log', 'xelab.log']);

/**
 * ★ R1.1：**自身交付树残留**必须单独查。
 *
 * WHY（Lead 2026-10-16 复核发现）：A5 原来只有"对外零副作用"这一个维度，而 `.scratch` 被
 * `SKIP_DIRS` 整个跳过 ⇒ **收尾清理失败时，本脚本看不见残留**。实测代价：`gate/.scratch/tmp/**`
 * 悄悄留下 12 个文件，而 HANDOFF 写着"不留临时文件"——**声明与事实不符，且检查不出声**。
 * 现在两个维度分开报：对外（全工作区指纹）+ 自身树（临时区必须为空）。
 */
const SCRATCH_PATHS = [
  '.scratch',                    // 运行期临时区（gate/lib/env.mjs#scratchDir）
  'gate/evidence/.scratch',      // R1 早先的位置；保留探测，防止旧位置复活
  'gate/.scratch',               // R1 侦察阶段手工探针用过；保留探测
  'gate/.canary',                // 各 canary 的合成夹具区（规矩：每个脚本只清自己的子目录）
];

function scanScratch(root) {
  const out = [];
  for (const rel of SCRATCH_PATHS) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    let n = 0; let bytes = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const c = join(d, e.name);
        if (e.isDirectory()) walk(c);
        else if (e.isFile()) { n += 1; bytes += statSync(c).size; }
      }
    };
    walk(p);
    out.push({ path: rel, files: n, bytes });
  }
  return out;
}

/** 允许变化的路径**前缀**（每条都有理由；不在表里 = 违规）。 */
const ALLOWED_CHANGES = [
  { prefix: 'gate/evidence/', why: 'gate 自己的证据产物（本脚本与 runner 的输出）' },
  { prefix: 'gate/_selftest/', why: '自测夹具与产物' },
  { prefix: '.cache/dsh-guard/js-allow.txt', why: 'G07 selfcheck.mjs 重新生成清单（已知副作用）' },
  { prefix: '.cache/dsh-guard/js-deny.txt', why: 'G07 selfcheck.mjs 重新生成清单（已知副作用）' },
  { prefix: '.cache/dsh-guard/profile-patch.CONSTRUCTED.yml', why: 'G09 validate-patch.mjs 构造产物（已知副作用）' },
  { prefix: '.cache/dsh-guard/link-gate-result.txt', why: 'link_gate.py 的产物（内容幂等、mtime 非幂等）；本 slice 不跑它，若变化说明有人跑过' },
];

function walk(dir, out = [], base = dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, base);
    else if (e.isFile()) {
      try {
        const st = statSync(p);
        const buf = readFileSync(p);
        out.push({
          path: relative(base, p).replace(/\\/g, '/'),
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
        });
      } catch { /* 读不到就跳过（不在本脚本的裁定范围） */ }
    }
  }
  return out;
}

function allowed(rel) {
  return ALLOWED_CHANGES.find((a) => rel.startsWith(a.prefix)) || null;
}

function main() {
  const mode = process.argv.includes('--after') ? 'after' : 'before';
  const root = resolve(process.env.GATE_ROOT || process.cwd());
  const now = walk(root, [], root);
  const map = Object.fromEntries(now.map((f) => [f.path, f]));

  if (mode === 'before') {
    writeFileSync(SNAP, JSON.stringify({ takenAt: new Date().toISOString(), root, files: map }, null, 0), 'utf8');
    console.log(`SIDE-EFFECT BEFORE: files=${now.length} snapshot=${SNAP}`);
    return 0;
  }

  if (!existsSync(SNAP)) {
    console.error(`SIDE-EFFECT ERROR: 没有跑前指纹（先跑 --before）：${SNAP}`);
    return 3;
  }
  const before = JSON.parse(readFileSync(SNAP, 'utf8')).files;
  const changed = [];
  for (const [p, f] of Object.entries(map)) {
    const b = before[p];
    if (!b) { changed.push({ path: p, kind: 'ADDED', size: f.size }); continue; }
    if (b.sha256 !== f.sha256) { changed.push({ path: p, kind: 'CONTENT', before: b.sha256, after: f.sha256, beforeMtime: b.mtimeMs, afterMtime: f.mtimeMs }); continue; }
    if (b.mtimeMs !== f.mtimeMs) { changed.push({ path: p, kind: 'MTIME_ONLY', sha256: f.sha256, beforeMtime: b.mtimeMs, afterMtime: f.mtimeMs }); }
  }
  for (const p of Object.keys(before)) if (!map[p]) changed.push({ path: p, kind: 'REMOVED' });

  const violations = changed.filter((c) => !allowed(c.path));
  console.log(`SIDE-EFFECT AFTER: files_before=${Object.keys(before).length} files_after=${now.length} changed=${changed.length}`);
  for (const c of changed) {
    const a = allowed(c.path);
    const tag = a ? 'ALLOWED' : '★VIOLATION';
    console.log(`  [${tag}] ${c.kind.padEnd(10)} ${c.path}`
      + (c.kind === 'CONTENT' ? `  ${c.before}->${c.after}` : '')
      + (c.kind === 'MTIME_ONLY' ? '  (内容不变，仅 mtime)' : '')
      + (a ? `  <- ${a.why}` : ''));
  }
  console.log(violations.length === 0
    ? 'SIDE_EFFECT_EXTERNAL: PASS (对外零副作用：全工作区变化都在白名单内)'
    : `SIDE_EFFECT_EXTERNAL: FAIL (${violations.length} 条越界变化)`);

  // ★ 第二个维度：自身交付树的临时区残留（与"对外"分开报，不许一句话盖住两件事）
  const scratch = scanScratch(root);
  const residues = scratch.filter((s) => s.files > 0);
  if (scratch.length === 0) {
    console.log('SIDE_EFFECT_SELFTREE: PASS (临时区不存在或已清空：' + SCRATCH_PATHS.join(' / ') + ' 均无残留)');
  } else {
    for (const s of scratch) {
      console.log(`  [${s.files > 0 ? '★RESIDUE' : 'clean'}] ${s.path}/ files=${s.files} bytes=${s.bytes}`);
    }
    console.log(residues.length === 0
      ? 'SIDE_EFFECT_SELFTREE: PASS (临时区存在但已空)'
      : `SIDE_EFFECT_SELFTREE: FAIL (自身交付树残留 ${residues.reduce((a, s) => a + s.files, 0)} 个文件)`
        + ' ⟹ 收尾清理失败或有人手工留了临时文件；删掉或在 HANDOFF 里显式登记理由');
  }

  const ok = violations.length === 0 && residues.length === 0;
  console.log(ok
    ? 'SIDE_EFFECT_RESULT: PASS (对外=clean 且 自身树=clean)'
    : 'SIDE_EFFECT_RESULT: FAIL (对外或自身树有一项不干净)');
  return ok ? 0 : 2;
}

process.exitCode = main();
