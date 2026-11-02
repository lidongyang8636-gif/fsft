/**
 * probes.js —— 产物探针（**数值优先** + **强制正负 fixture**）
 *
 * 2026-10-21（FSFT P2 / D4）。为什么不用"匹配一句话"：
 *   对两份真实报告做 6 种字符串判据实测（`reviews/REVIEW.FSFT-1.md`、`docs/plan_gate-guard-产物绑定与探针.md` §8）：
 *     · 坏报告写 `Timing constraints are not met.`（**没有 `All user specified` 前缀**）
 *     · 好报告写 `All user specified timing constraints are met.`（**小写 t**）
 *   ⟹ 判据「大写 T 含」与「`\b…\b` 正则」**都会假红**（好报告被拦）。
 *   ⟹ 主判据改为**解析摘要行数值**（WNS/TNS/失败端点）；状态句只作 basis 供人读。
 *
 * 铁律：
 *   1. 探针**必须**带正负 fixture；apply 期自测不过 ⟹ 该探针**禁用**（响亮记录，不静默）。
 *   2. "没法判断"（文件缺失/读不了/解析不到）⇒ `ask`；"有证据表明坏"（数值不达标/命中 mustNotMatch）⇒ `deny`。
 *   3. 本模块**永不抛**；异常一律转 `ask`。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Design Timing Summary 的 12 列数据行：
 *  WNS TNS TNSfail TNStotal | WHS THS THSfail THStotal | WPWS TPWS TPWSfail TPWStotal */
const TIMING_ROW =
  /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s*$/;

const HEADER_HINT = 'TNS Failing Endpoints';

/** 路径模板：只认三个变量（不做通用表达式求值，可审计优先） */
export function expandPath(tpl, artifactAbs, root) {
  if (typeof tpl !== 'string' || tpl.length === 0) return null;
  const artifactDir = artifactAbs ? resolve(artifactAbs, '..') : root;
  const runDir = resolve(artifactDir, '..');
  const out = tpl
    .replace(/\$\{artifactAbs\}/g, artifactAbs ?? '')
    .replace(/\$\{artifactDir\}/g, artifactDir)
    .replace(/\$\{runDir\}/g, runDir);
  return isAbsolute(out) ? out : join(root, out);
}

/** 从报告文本里取 Design Timing Summary 的数值行 */
export function parseTimingSummary(text) {
  const lines = String(text).split(/\r?\n/);
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(HEADER_HINT)) { start = i + 1; break; }
  }
  for (let i = start; i < lines.length; i += 1) {
    const m = TIMING_ROW.exec(lines[i]);
    if (!m) continue;
    return {
      wns: Number(m[1]), tns: Number(m[2]), tnsFail: Number(m[3]), tnsTotal: Number(m[4]),
      whs: Number(m[5]), ths: Number(m[6]), thsFail: Number(m[7]), thsTotal: Number(m[8]),
      line: lines[i].trim(),
    };
  }
  return null;
}

function findLine(body, s) {
  const l = body.split(/\r?\n/).find((x) => x.includes(s));
  return l ? l.trim() : null;
}

/** 判一条探针（`text` 可预注入，便于 fixture 用同一份内容） */
export function judgeProbe(probe, abs, text) {
  if (!existsSync(abs)) return { verdict: 'ask', why: 'probe-file-missing', line: null };

  let body = text;
  if (typeof body !== 'string') {
    try { body = readFileSync(abs, 'utf8'); } catch (e) {
      return { verdict: 'ask', why: `probe-read-error:${e && e.message ? e.message : e}`, line: null };
    }
  }

  // ① 数值判据（主）
  if (probe.expect && typeof probe.expect === 'object') {
    const t = parseTimingSummary(body);
    if (t === null) return { verdict: 'ask', why: 'timing-summary-row-not-found', line: null };
    const want = probe.expect;
    const bad = [];
    if (typeof want.wnsMin === 'number' && !(t.wns >= want.wnsMin)) bad.push(`WNS=${t.wns} < ${want.wnsMin}`);
    if (typeof want.tns === 'number' && !(t.tns === want.tns)) bad.push(`TNS=${t.tns} != ${want.tns}`);
    if (typeof want.failPoints === 'number' && !(t.tnsFail === want.failPoints)) bad.push(`fail=${t.tnsFail} != ${want.failPoints}`);
    if (bad.length > 0) return { verdict: 'deny', why: `numeric:${bad.join(';')}`, line: t.line };
  }

  // ② 字符串兜底（只用于 deny 加注，或非时序类探针）
  for (const re of probe.mustNotMatch || []) {
    if (re.test(body)) {
      const hit = body.split(/\r?\n/).find((l) => re.test(l));
      return { verdict: 'deny', why: `mustNotMatch:${re}`, line: hit ? hit.trim() : null };
    }
  }
  for (const re of probe.mustMatch || []) {
    if (!re.test(body)) return { verdict: 'deny', why: `mustMatch-miss:${re}`, line: null };
  }

  return { verdict: 'ok', why: '', line: probe.noteMustMatch ? findLine(body, probe.noteMustMatch) : null };
}

const toRe = (v) => (v instanceof RegExp ? v : new RegExp(String(v)));

/**
 * 编译 + **fixture 自测**。自测不过的探针被 `disabled`，并回调 `log('probe-config-error', …)`。
 * @returns {{ probes: object[], errors: object[] }}
 */
export function compileProbes(rawProbes, { root, log } = {}) {
  const out = [];
  const errors = [];
  const list = Array.isArray(rawProbes) ? rawProbes : [];
  for (const raw of list) {
    try {
      const p = {
        name: String(raw.name || 'unnamed'),
        file: String(raw.file || ''),
        expect: raw.expect,
        noteMustMatch: raw.noteMustMatch,
        mustMatch: (raw.mustMatch || []).map(toRe),
        mustNotMatch: (raw.mustNotMatch || []).map(toRe),
        fixtures: Array.isArray(raw.fixtures) ? raw.fixtures : [],
      };
      if (p.fixtures.length < 2) {
        errors.push({ name: p.name, why: 'fixtures-missing(<2)' });
        if (log) log('probe-config-error', { probe: p.name, why: 'fixtures-missing(<2) ⟹ 探针禁用' });
        continue;
      }
      const bad = [];
      for (const f of p.fixtures) {
        const abs = expandPath(f.file, null, root ?? process.cwd());
        const r = judgeProbe(p, abs);
        const pass = r.verdict === 'ok';
        if (pass !== !!f.expectPass) {
          bad.push(`${f.file} 期望 ${f.expectPass ? 'PASS' : 'FAIL'} 实得 ${r.verdict}(${r.why})`);
        }
      }
      if (bad.length > 0) {
        errors.push({ name: p.name, why: `fixture-mismatch: ${bad.join(' | ')}` });
        if (log) log('probe-config-error', { probe: p.name, why: `fixture 自测不符 ⟹ 探针禁用：${bad.join(' | ')}` });
        continue;
      }
      out.push(p);
    } catch (e) {
      errors.push({ name: raw && raw.name, why: `compile-error:${e && e.message ? e.message : e}` });
      if (log) log('probe-config-error', { probe: raw && raw.name, why: `编译失败 ⟹ 探针禁用：${e && e.message ? e.message : e}` });
    }
  }
  return { probes: out, errors };
}

/** 对某产物跑全部探针；任何异常 → ask（fail-safe，不静默放行） */
export function runProbes(probes, artifactAbs, root) {
  const results = [];
  for (const p of probes) {
    try {
      const abs = expandPath(p.file, artifactAbs, root);
      results.push({ name: p.name, ...(abs ? judgeProbe(p, abs) : { verdict: 'ask', why: 'path-unresolved', line: null }) });
    } catch (e) {
      results.push({ name: p.name, verdict: 'ask', why: `probe-error:${e && e.message ? e.message : e}`, line: null });
    }
  }
  return results;
}
