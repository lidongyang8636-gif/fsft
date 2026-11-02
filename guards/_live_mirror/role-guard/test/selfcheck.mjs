/**
 * 离线自检：把 lib/index.js 里的只读判定器跑在 846 个真名上。
 *
 * 为什么必须做：
 *   guard 最怕「静默失效」。插件里已内置 22 条断言自检，但那是我挑的用例；
 *   本脚本用**全量真名**再跑一遍，并输出 allow/deny 清单，供与 Python 侧
 *   v3 分类器交叉核对（两份独立实现结果一致 ⇒ 判定器不是笔误产物）。
 *
 * 用法（不需要 DSH、不需要重启）：
 *   node guards/role-guard/test/selfcheck.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// 只 import 纯函数 —— 插件入口不在这里 `apply`，所以不碰 ctx
const here = dirname(fileURLToPath(import.meta.url));
// Windows 上必须转成 file:// URL，否则 ESM loader 报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);
const { readOnlyDecision } = mod;

const CACHE = join(here, '..', '..', '..', '.cache', 'dsh-guard');
const names = readFileSync(join(CACHE, 'mcp-tools.txt'), 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'));

const allow = [];
const deny = [];
for (const n of names) {
  const r = readOnlyDecision(n);
  (r === null ? allow : deny).push([n, r ?? '']);
}

writeFileSync(join(CACHE, 'js-allow.txt'), allow.map(([n]) => n).join('\n') + '\n', 'utf8');
writeFileSync(join(CACHE, 'js-deny.txt'),
  deny.map(([n, r]) => `${n}\t${r}`).join('\n') + '\n', 'utf8');

// ── 断言：危险工具必须全部被拒 ─────────────────────────────────────────────
const MUST_DENY = [
  'mcp__vivado__run_tcl', 'mcp__vivado__safe_tcl', 'mcp__vivado__program_device',
  'mcp__vivado__start_session', 'mcp__vivado__generate_bitstream',
  'mcp__vivado__run_synthesis', 'mcp__vivado__run_implementation',
  'mcp__vivado__set_wave_zoom', 'mcp__vivado__set_wave_analog',
  'mcp__vivado__xdc_auto_fix',
  'mcp__fpga-mcp__set_backend', 'mcp__fpga-mcp__exec_tcl',
  'mcp__fpga-mcp__a_exec', 'mcp__fpga-mcp__viv_exec', 'mcp__fpga-mcp__a_program_device',
  'mcp__fpga-mcp__viv_lint_waiver_add', 'mcp__fpga-mcp__q_set_pin_location',
  'mcp__fpga-mcp__q_execute_all_flows', 'mcp__fpga-mcp__viv_create_bd',
  'mcp__fpga-mcp__viv_place_design', 'mcp__fpga-mcp__viv_route_design',
];
const MUST_ALLOW = [
  'mcp__vivado__list_sessions', 'mcp__vivado__get_project_info',
  'mcp__vivado__get_timing_report', 'mcp__vivado__get_utilization_report',
  'mcp__vivado__parse_xpr', 'mcp__vivado__xdc_lint',
  'mcp__vivado__check_bitstream_readiness',
  'mcp__fpga-mcp__a_get_syn_status', 'mcp__fpga-mcp__viv_get_clocks',
  'mcp__fpga-mcp__q_report_timing', 'mcp__fpga-mcp__get_clock_info',
  'mcp__fpga-mcp__get_synthesis_report', 'mcp__fpga-mcp__a_report_clock_transfers',
];

const problems = [];
for (const n of MUST_DENY) if (readOnlyDecision(n) === null) problems.push(`应拒却放行: ${n}`);
for (const n of MUST_ALLOW) if (readOnlyDecision(n) !== null) {
  problems.push(`应放行却拒: ${n}  ⟸ ${readOnlyDecision(n)}`);
}

// ── 用例真实性检查 ─────────────────────────────────────────────────────────
// 教训：本轮曾把 `mcp__vivado__report_timing_summary` 写进用例，而注册表里
// 根本没有这个名字（只有 get_timing_report / report_utilization）。
// 名字不存在 ⇒ 用例恒真或恒假，等于没测。故强制核对每个用例名都在真实名单里。
const realSet = new Set(names);
for (const n of [...MUST_DENY, ...MUST_ALLOW]) {
  if (!realSet.has(n)) problems.push(`用例名不在真实注册表中（无效用例）: ${n}`);
}

console.log(`真名总数 ${names.length}  →  放行 ${allow.length} / 拒绝 ${deny.length}`);
console.log(`断言：MUST_DENY ${MUST_DENY.length} 条、MUST_ALLOW ${MUST_ALLOW.length} 条`);
if (problems.length > 0) {
  console.log('\n❌ 不符：');
  for (const p of problems) console.log('   ' + p);
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部断言通过');
}
console.log(`\n清单已写：.cache/dsh-guard/js-allow.txt (${allow.length})、js-deny.txt (${deny.length})`);
