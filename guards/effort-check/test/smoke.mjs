#!/usr/bin/env node
/**
 * effort-check 自测（B 方案验收 §4.4）
 *   T1 算术：declared + missing + excluded + unknown === models
 *   T2 确定性：同一配置连跑两次，reportText 逐字一致
 *   T3 只读：dry-run 前后 cordis.patch.yml 的 sha256 + mtime 不变
 *   T4 退出码：有缺口 2 / 无缺口 0 / 解析失败 1
 *   T5 启动钩子：apply() 不抛、不阻塞，且写出一行 startup.log
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..', '..');
const { runCheck } = await import(pathToFileURL(join(WORKSPACE, 'scripts', 'check-efforts.mjs')).href);

const realPatch = join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const results = [];
const ok = (id, cond, info = '') => { results.push({ id, pass: !!cond, info }); };

/* ── T1 算术 ──────────────────────────────────────────────────────────── */
const r1 = runCheck({ patchPath: realPatch });
const sum = r1.counts.declared + r1.counts.missing + r1.counts.excluded + r1.counts.unknown;
ok('T1 算术', sum === r1.counts.models, `declared+missing+excluded+unknown=${sum} models=${r1.counts.models}`);

/* ── T2 确定性 ────────────────────────────────────────────────────────── */
const r2 = runCheck({ patchPath: realPatch });
ok('T2 确定性', r1.reportText === r2.reportText, `len=${r1.reportText.length}`);

/* ── T3 只读 ──────────────────────────────────────────────────────────── */
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const before = { sha: sha(realPatch), mtime: statSync(realPatch).mtimeMs };
runCheck({ patchPath: realPatch, write: false });
const after = { sha: sha(realPatch), mtime: statSync(realPatch).mtimeMs };
ok('T3 只读', before.sha === after.sha && before.mtime === after.mtime, `sha==${before.sha.slice(0, 12)}…`);

/* ── T4 退出码（构造两个小 fixture）───────────────────────────────────── */
const tmp = mkdtempSync(join(tmpdir(), 'effort-check-'));
const families = join(WORKSPACE, 'config', 'effort-families.json');

const gapPatch = join(tmp, 'gap.yml');
writeFileSync(gapPatch, [
  '- id: llm',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      p1:',
  '        models:',
  '          - id: gpt-6-astra',
  '            reasoningEfforts: { low: low }',
  '          - id: gpt-6-luna',
  '          - id: gpt-image-2',
  '          - id: grok-4.7',
  '',
].join('\n'), 'utf8');
const g = runCheck({ patchPath: gapPatch, familiesPath: families });
ok('T4a 有缺口=2', g.code === 2 && g.counts.missing === 1 && g.counts.excluded === 1 && g.counts.unknown === 1,
  `code=${g.code} declared=${g.counts.declared} missing=${g.counts.missing} excluded=${g.counts.excluded} unknown=${g.counts.unknown}`);

const cleanPatch = join(tmp, 'clean.yml');
writeFileSync(cleanPatch, [
  '- id: llm',
  '  config:',
  '    providers:',
  '      p1:',
  '        models:',
  '          - id: gpt-6-astra',
  '            reasoningEfforts: { low: low }',
  '          - id: gpt-image-2',
  '',
].join('\n'), 'utf8');
const c = runCheck({ patchPath: cleanPatch, familiesPath: families });
ok('T4b 无缺口=0', c.code === 0 && c.verdict === 'NO_GAP', `code=${c.code} verdict=${c.verdict}`);

let threw = false;
try { runCheck({ patchPath: join(tmp, 'nope.yml') }); } catch { threw = true; }
ok('T4c 解析失败抛错', threw);

/* ── T5 启动钩子 ──────────────────────────────────────────────────────── */
const plugDir = join(WORKSPACE, '.effort-check', 'smoke');
if (existsSync(join(plugDir, 'startup.log'))) writeFileSync(join(plugDir, 'startup.log'), '', 'utf8');
const mod = await import(pathToFileURL(join(WORKSPACE, 'guards', 'effort-check', 'lib', 'index.js')).href);
let applyThrew = false;
const t0 = process.hrtime.bigint();
try {
  mod.apply({}, { outDir: plugDir, profileDir: join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop') });
} catch { applyThrew = true; }
const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
ok('T5a apply 同步返回', !applyThrew && applyMs < 50, `${applyMs.toFixed(1)}ms`);

await new Promise((r) => setTimeout(r, 1500));
const logPath = join(plugDir, 'startup.log');
const logTxt = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '';
let logLine = null;
try { logLine = logTxt ? JSON.parse(logTxt.split('\n').pop()) : null; } catch { /* keep null */ }
ok('T5b startup.log 落一行', !!logLine && logLine.event === 'startup-check',
  logLine ? `verdict=${logLine.verdict} counts.missing=${logLine.counts.missing} ms=${logLine.ms}` : 'no line');

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
let fail = 0;
for (const r of results) {
  if (!r.pass) fail += 1;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.info ? `  — ${r.info}` : ''}\n`);
}
process.stdout.write(`EFFORT_CHECK_SELFTEST: ${fail === 0 ? 'ALL PASS' : `${fail} FAIL`} (${results.length} checks)\n`);
process.exit(fail === 0 ? 0 : 1);
