/**
 * 安全复核：allow 清单里还有没有「名字含写动词」的条目。
 * 每一条都必须能解释清楚；不能解释的就是漏网写操作。
 *
 * 与 selfcheck.mjs 的分工：
 *   selfcheck  → 判定器「有没有搞错方向」（断言级）
 *   本脚本     → allow 清单「有没有漏进去的写操作」（清单级）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { readOnlyDecision } = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);
const CACHE = join(here, '..', '..', '..', '.cache', 'dsh-guard');

const names = readFileSync(join(CACHE, 'mcp-tools.txt'), 'utf8')
  .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const allow = names.filter((n) => readOnlyDecision(n) === null);

const WRITEY = ['set', 'create', 'delete', 'remove', 'add', 'exec', 'program',
  'write', 'save', 'open', 'close', 'reset', 'force', 'generate', 'connect',
  'select', 'build', 'download', 'flash', 'erase', 'lock', 'unlock', 'upgrade',
  'synth', 'place', 'route', 'start', 'stop', 'append', 'apply', 'enable',
  'disable', 'update', 'validate', 'clean', 'put', 'catch', 'puts', 'launch',
  'route_design', 'opt'];

const suspicious = allow.filter((n) => {
  const body = n.split('__')[2];
  return body.split('_').some((t) => WRITEY.includes(t));
});

console.log(`allow 总数: ${allow.length}`);
console.log('\n=== allow 中含写动词 token 的（必须逐条解释）===');
if (suspicious.length === 0) console.log('  （无）');
for (const n of suspicious) console.log('  ⚠', n);

console.log('\n=== 点名核对（真名，取自 mcp-tools.txt）===');
const spot = [
  'mcp__vivado__list_sessions',
  'mcp__vivado__get_project_info',
  'mcp__vivado__get_timing_report',
  'mcp__vivado__report_utilization',
  'mcp__vivado__report_timing_summary', // 预期：注册表里不存在
];
for (const t of spot) {
  const exists = names.includes(t);
  const verdict = !exists ? '不存在于注册表' : (readOnlyDecision(t) === null ? 'ALLOW' : 'DENY');
  console.log(`  ${exists ? '  ' : '? '}${t}  →  ${verdict}`);
}
