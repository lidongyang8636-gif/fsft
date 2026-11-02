/**
 * dsh-role-guard — DSH 角色硬边界 guard（含 RT-02 最小实验探针）
 *
 * 依据（不复制论述，只引用）：
 *   docs/红队_smart_home团队结构与权限.md §2.2 / §3 RT-02 / §4.2 / §5 建议 A
 *   docs/待落地_角色硬边界guard交接brief.md §1（实验）/ §2（接线）/ §3（交付物）
 *
 * 三条设计纪律（都来自 app.asar 内 API 原文，不是自创）：
 *   1. 选型用「最弱够用」：隐藏工具用 `restrict`，必须无视注册顺序的拒绝用 `guard`。
 *   2. 必须无视顺序生效的拒绝只能靠 `guard`（单调加严）——
 *      而 `restrict` 是 exact-name 校验，MCP 工具「连接后才注册」⇒ 有时序风险。
 *      所以主闸门是 guard（前缀匹配、名字无关），restrict 只作加固层。
 *   3. per-agent 注册走 `agent/created` + `agent.ctx.effect()`，
 *      并把 disposer 按 agent 存进本插件自己的 effect（插件卸载不自动解除注册）。
 *
 * ⚠ 失败方向刻意设成 fail-closed：判定不出来就拒。
 *    宁可让审查者少用一个工具，不可让它多用一个写工具。
 */

import { appendFileSync } from 'node:fs';

// ── 每工作区设置（guard-ui，PLAN §9.1 裁决 D-A：**拉取式 pull**）────────────
// 单一真源模块（P5）：与 subagent-sandbox / guard-ui 共用**同一份**，禁止复制粘贴。
// ⚠ import 期零副作用；但它一旦解析失败，本插件会**连带加载失败** ⇒ 护栏消失
//   （最坏的 fail-open）。故 `guards/guard-ui/test/settings.mjs` 同时是它的「可加载 + 契约」门禁。
// ⚠ 绝不回落 process.cwd()（P1）：stub 自测的 cwd 就是仓库根，一旦回落，
//   验收时落下的 <仓库根>/.dsh-guard.json 会改写自测行为、污染 V6 回归证据。
import { createProblemReporter, resolvePluginConfig } from '../../guard-ui/lib/settings.js';

export const name = 'dsh-role-guard';

/** `tools` 是硬依赖：拿不到工具服务，本插件就没有存在意义，应当挂载失败而不是静默降级 */
export const inject = ['tools'];

/** 两个 MCP 服务器（见 profile 的 cordis.patch.yml：serverName: vivado / fpga-mcp） */
const MCP_PREFIXES = ['mcp__vivado__', 'mcp__fpga-mcp__'];

// ── 只读白名单：按「token 级」判定（见 docs 里 v3 分类器与审计底稿）────────
//
// 为什么不用「get_/report_ 前缀」这种粗规则：
//   审计 846 个真名时发现，前缀规则会把 `clock` 里的 `lock`、`synthesis` 里的 `synth`
//   当写动词（子串误判），也会放过 `lint_waiver_add` 这类「名字像只读、其实写状态」的。
// 现在改成：剥掉 scope 前缀（a_/q_/viv_/vivado_）后，**每个 token 都必须是只读词**。
const SCOPE_PREFIXES = ['a', 'q', 'viv', 'vivado'];

const READ_WORDS = new Set([
  'get', 'list', 'report', 'read', 'parse', 'compare', 'inspect', 'check',
  'status', 'version', 'info', 'exists', 'is', 'current', 'all',
  'progress', 'summary', 'file', 'files', 'dir', 'pwd', 'env', 'var',
  'property', 'properties', 'param', 'part', 'parts', 'board', 'boards',
  'clock', 'clocks', 'cell', 'cells', 'net', 'nets', 'pin', 'pins', 'port',
  'ports', 'lib', 'libs', 'site', 'sites', 'bel', 'bels', 'iobank', 'iobanks',
  'package', 'pattern', 'of', 'ref', 'type', 'supported', 'props', 'defs',
  'run', 'runs', 'route', 'routing', 'timing', 'utilization', 'power', 'area',
  'drc', 'cdc', 'methodology', 'exceptions', 'paths', 'path', 'wns', 'tns',
  'failfast', 'hierarchy', 'floorplan', 'pipeline', 'analysis', 'high', 'fanout',
  'netlist', 'noise', 'pulse', 'width', 'synchronizer', 'interaction',
  'transfers', 'relationships', 'failures', 'recovery', 'removal', 'multicycle',
  'false', 'constraints', 'sources', 'ip', 'ips', 'messages', 'unconstrained',
  'specific', 'database', 'license', 'chip', 'logic', 'option', 'assignments',
  'partitions', 'metastability', 'fmax', 'ram', 'dsp', 'hold', 'setup', 'min',
  'max', 'delay', 'revisions', 'revision', 'family', 'entity', 'hdl', 'user',
  'systemverilog', 'verilog', 'vhdl', 'sdc', 'syntax', 'primitives',
  'incremental', 'reuse', 'help', 'topic', 'jtag', 'bufg', 'bufr',
  // 下列为自检（test/selfcheck.mjs 的 MUST_ALLOW）抓出来的缺失只读词，
  // 每个都对应真实工具名；不是凭空补的。
  'sessions', 'session', 'events', 'env', 'debug', 'cores', 'probes',
  'costs', 'groups', 'from', 'to', 'specific', 'reference', 'references',
]);

/** 写/状态变更 token：出现即拒；保留它是为了「即使名字伪装成 get_ 也拦住」 */
const WRITE_WORDS = new Set([
  'set', 'create', 'delete', 'remove', 'add', 'launch', 'exec', 'program',
  'write', 'save', 'close', 'reset', 'force', 'import', 'export', 'generate',
  'connect', 'disconnect', 'select', 'build', 'download', 'upload', 'flash',
  'erase', 'readback', 'lock', 'unlock', 'upgrade', 'synth', 'place', 'opt',
  'start', 'stop', 'append', 'mkdir', 'copy', 'move', 'restore', 'clear',
  'apply', 'enable', 'disable', 'attach', 'detach', 'init', 'load', 'boot',
  'halt', 'reboot', 'send', 'post', 'put', 'patch', 'install', 'uninstall',
  'commit', 'revert', 'rename', 'truncate', 'link', 'make', 'archive', 'update',
  'validate', 'clean', 'abort', 'capture', 'force_signal', 'release',
  // 'open' 是状态变更（open_run / open_project / open_hw_target 都会改会话状态），
  // 曾被误归入只读词导致 a_open_run 被放行 —— 由 test/selfcheck.mjs 抓出。
  'open',
]);

/** 精确只读白名单：多词只读工具，token 规则覆盖不到但语义确定只读 */
const EXEMPT_READ = new Set([
  'mcp__vivado__get_pre_commit_summary', 'mcp__vivado__get_next_suggestion',
  'mcp__vivado__get_critical_warnings', 'mcp__vivado__get_timing_report',
  'mcp__vivado__get_utilization_report', 'mcp__vivado__get_io_report',
  'mcp__vivado__get_project_info', 'mcp__vivado__get_run_progress',
  'mcp__vivado__get_ip_status', 'mcp__vivado__parse_xpr',
  'mcp__vivado__parse_bit_header', 'mcp__vivado__parse_ltx',
  'mcp__vivado__compare_xci', 'mcp__vivado__verilog_compile_check',
  'mcp__vivado__check_bitstream_readiness', 'mcp__vivado__xdc_lint',
  'mcp__vivado__inspect_ip_params', 'mcp__fpga-mcp__ping_backend',
  'mcp__fpga-mcp__status', 'mcp__fpga-mcp__a_pwd', 'mcp__fpga-mcp__viv_pwd',
  // 2026-10-21 修假阳性：这是**纯元数据**查询（列 flash 型号），但 token 里含写动词
  // `flash` ⟹ 旧版判成"写/执行类"直接拒。同类"名字带写动词、实则只读"的工具都放这里。
  'mcp__fpga-mcp__viv_list_flash_parts',
  'mcp__fpga-mcp__a_get_user', 'mcp__fpga-mcp__a_get_td_version',
  'mcp__fpga-mcp__a_file_exists', 'mcp__fpga-mcp__viv_file_exists',
  'mcp__fpga-mcp__viv_file_stat', 'mcp__fpga-mcp__viv_file_mtime',
  'mcp__fpga-mcp__q_is_project_open', 'mcp__fpga-mcp__q_project_exists',
  'mcp__fpga-mcp__get_all_clocks', 'mcp__fpga-mcp__get_clock_info',
  'mcp__fpga-mcp__get_project_info', 'mcp__fpga-mcp__get_run_status',
  'mcp__fpga-mcp__get_synthesis_report', 'mcp__fpga-mcp__a_get_syn_progress',
  'mcp__fpga-mcp__a_get_syn_status', 'mcp__fpga-mcp__a_get_pnr_progress',
  'mcp__fpga-mcp__a_get_pnr_status',
]);

/** 精确否决：名字像只读、实际会写/改状态（此名单来自 846 个真名的逐条审计） */
const VETO_EXACT = new Set([
  'mcp__vivado__xdc_auto_fix',            // 会写 .xdc
  'mcp__fpga-mcp__viv_lint_waiver_add',   // 新增 waiver = 写状态
  'mcp__fpga-mcp__set_backend',           // brief §1.1① 明文禁止当探针
  'mcp__fpga-mcp__viv_xsct_select_target',
  'mcp__fpga-mcp__viv_xsct_open_serial', 'mcp__fpga-mcp__viv_xsct_close_serial',
  'mcp__fpga-mcp__a_catch', 'mcp__fpga-mcp__a_puts', 'mcp__fpga-mcp__a_puts_log',
  'mcp__fpga-mcp__a_log_info', 'mcp__fpga-mcp__a_log_warning',
  'mcp__fpga-mcp__a_log_error', 'mcp__fpga-mcp__q_project_open',
  // 名字里含 open 的「查询是否打开」变体：一律拒（fail-closed；实际注册的是
  // q_is_project_open，且它在 EXEMPT_READ 里已显式放行）
  'mcp__fpga-mcp__q_is_project_open_x',
]);

// ── 纯判定函数（可离线单测；guard 内只调用，不做推理）──────────────────────

function isMcpTool(n) {
  return typeof n === 'string' && MCP_PREFIXES.some((p) => n.startsWith(p));
}

// ── 方案 A：shell 面减速带（**不是硬边界**，见 README §6.4.1）──────────────
//
// 背景（2026-10-14 实测 CONFIRMED）：只读子会话能起 pwsh（`shell-ok`）、
// 且能看见厂商二进制（`Test-Path ...vivado.bat` → True）；
// 而 `decide()` 此前对非 MCP **显式放行** ⇒ 这条路径无人管。
//
// ⚠ 诚实定位：本机制是**文本匹配的减速带**，不是安全边界。
//   变量、base64、路径拼接、字符串拼接都能绕过它。
//   它的价值是"把明显的厂商/烧板调用挡在门外 + 留下可审计的拒绝记录"。
//
// 刻意**不含**裸 `vivado`：否则 `Get-Content vivado.log` 这类**合法读日志**会被误伤。
// 代价是"不带扩展名、带旗标之外的 vivado 调用"可能漏过——这正是"减速带"的含义。

/** 只读角色禁止出现的 shell 文本模式（小写子串匹配） */
const DEFAULT_SHELL_DENY_PATTERNS = [
  // ── 面 1：厂商工具链 / 烧板 ────────────────────────────────────────────
  // Vivado / Xilinx 套件
  'vivado.bat', 'vivado.exe', 'vivado -mode', 'vivado -source',
  'xsdb', 'xsct', 'hw_server',
  // 烧板 / 配置存储 / 硬件管理（Tcl 侧动词，纵深防御）
  'program_hw_devices', 'program_hw_cfgmem', 'write_cfgmem', 'create_hw_cfgmem',
  'open_hw_manager', 'connect_hw_server', 'open_hw_target', 'boot_hw_device',
  // Quartus（fpga-mcp 的另一后端）
  'quartus_pgm', 'quartus_sh', 'quartus_map', 'quartus_fit', 'quartus_sta',
  // 其他 JTAG / 烧写工具
  'impact.exe', 'openocd',
  // ── 面 2：串口**写**＝物理致动（2026-10-14 追加，用户要求）──────────────
  // 依据：本项目 `send_0_to_f.ps1` 的实测记录写明「**会驱动电机输出**」；
  //      串口不只是观测通道，还是控制通道。取证 ≠ 驱动，后者按 AGENTS §8 属 writer。
  // 只读角色**允许被动监听**（capture_serial.ps1 不带 -SendHex / live_listen.ps1 /
  // GetPortNames / mode COMx 查询），**禁止发送**：
  '-sendhex',        // capture_serial.ps1 -SendHex '01' ⇒ 发命令
  'send_0_to_f',     // 逐字节 0x00~0x0F 驱动脚本
  'live_brake',      // 主动制动
  'live_sweep',      // 扫频（会驱动）
];

/**
 * 复合拒绝规则：**所有**子串同时出现才命中。
 * 用于"单看每个词都很普通、合起来才是致动"的情形——比裸子串精确，误伤更少。
 * 每项：`{ all: [...], label }`（label 进拒绝理由，便于审计）。
 */
const DEFAULT_SHELL_DENY_GROUPS = [
  // 直接对串口对象写字节/行（.NET SerialPort 的致动写法）
  { all: ['serialport', '.write'], label: 'SerialPort…Write（串口写）' },
  { all: ['serialport', '.writeline'], label: 'SerialPort…WriteLine（串口写）' },
];

/** shell 工具名（可配）：只读角色对这些工具的**命令文本**做扫描 */
const DEFAULT_SHELL_TOOL_NAMES = ['pwsh', 'bash', 'sh', 'exec'];

/**
 * 从工具调用参数里取 shell 命令文本。
 * 兼容：对象 `{command}` / JSON 字符串 / 其他常见字段名；取不到就整体序列化。
 */
function extractShellCommand(args) {
  if (args === undefined || args === null) return '';
  let a = args;
  if (typeof a === 'string') {
    const s = a.trim();
    if (s.startsWith('{')) {
      try { a = JSON.parse(s); } catch { return s; }
    } else {
      return s;
    }
  }
  if (typeof a !== 'object') return String(a);
  for (const k of ['command', 'cmd', 'script', 'input']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  try { return JSON.stringify(a); } catch { return ''; }
}

/**
 * 扫描 shell 命令文本。返回 `{ pattern }`（命中）或 null（放行）。
 * allowPatterns 优先：命中即整体放行（逃生门，用于已知的合法只读用法）。
 * 判定顺序：allow → 平铺 denyPatterns → 复合 denyGroups。
 */
function scanShellCommand(text, denyPatterns = DEFAULT_SHELL_DENY_PATTERNS,
  allowPatterns = [], denyGroups = DEFAULT_SHELL_DENY_GROUPS) {
  const lower = String(text ?? '').toLowerCase();
  if (lower.trim() === '') return null;
  for (const p of allowPatterns) {
    const s = String(p ?? '').toLowerCase();
    if (s !== '' && lower.includes(s)) return null;
  }
  for (const p of denyPatterns) {
    const s = String(p ?? '').toLowerCase();
    if (s !== '' && lower.includes(s)) return { pattern: p };
  }
  for (const g of denyGroups) {
    const all = Array.isArray(g?.all) ? g.all : [];
    if (all.length > 0 && all.every((s) => lower.includes(String(s).toLowerCase()))) {
      return { pattern: g.label ?? all.join('+') };
    }
  }
  return null;
}

function isShellTool(n, names = DEFAULT_SHELL_TOOL_NAMES) {
  return typeof n === 'string' && names.includes(n);
}

function tokensOf(n) {
  const body = n.split('__')[2] ?? '';
  return body.split('_').filter(Boolean);
}

/** 剥掉 scope 前缀与量词前缀（all_/current_/is_）后的 token 列表 */
function bodyTokens(n) {
  let t = tokensOf(n);
  while (t.length > 0 && SCOPE_PREFIXES.includes(t[0])) t = t.slice(1);
  for (const q of ['all', 'current', 'is']) {
    if (t[0] === q) { t = t.slice(1); break; }
  }
  return t;
}

/**
 * 只读判定：返回 null = 放行；返回字符串 = 拒绝理由。
 * 判定不出来一律拒（fail-closed）。
 */
export function readOnlyDecision(n) {
  if (typeof n !== 'string' || n.length === 0) {
    return '[role-guard] 工具名不可解析 ⟹ 按只读边界拒绝（fail-closed）';
  }
  if (VETO_EXACT.has(n)) {
    return `[role-guard] 该工具名字像只读、实际会写/改状态，真只读模式一律拒绝：\`${n}\``;
  }
  if (!isMcpTool(n)) return null;           // 非 MCP：本插件不管（边界见 README）
  if (EXEMPT_READ.has(n)) return null;
  const t = bodyTokens(n);
  if (t.length === 0) {
    return `[role-guard] \`${n}\` 无法判定只读 ⟹ 拒绝（fail-closed）`;
  }
  const w = t.filter((x) => WRITE_WORDS.has(x));
  if (w.length > 0) {
    return `[role-guard] 真只读模式：拒绝写/执行类工具 \`${n}\`（写动词 ${w.join('/')}）`;
  }
  const unknown = t.filter((x) => !READ_WORDS.has(x));
  if (unknown.length > 0) {
    return `[role-guard] \`${n}\` 含未识别 token ${unknown.join('/')} ⟹ 拒绝（fail-closed）`;
  }
  return null;
}


// ── 2026-10-21 数据驱动补丁（由 scripts/gen-roleguard-exempt.mjs 生成）────────────
// 来源：`.cache/dsh-guard/deny-full.json` —— restrict **干跑**在真实宿主里落下的 deny 名单（623 条）。
// 以下 102 个名字**含只读动词、且不含任何写动词**，却被 fail-closed 判成"写"：
// 表现是**只读审查者连读硬件状态都读不了**（判定层与能力层同一份分类，所以两层都在拒）。
// 判据：逐条来自实测名单，不是手抄、不是猜。
const EXEMPT_READ_GENERATED = new Set([
  'mcp__fpga-mcp__a_get_hw_devices',
  'mcp__fpga-mcp__a_get_hw_targets',
  'mcp__fpga-mcp__a_get_pblocks',
  'mcp__fpga-mcp__a_get_project_dir',
  'mcp__fpga-mcp__a_get_top',
  'mcp__fpga-mcp__a_list_ip_catalog',
  'mcp__fpga-mcp__a_report_design_analysis',
  'mcp__fpga-mcp__a_report_io',
  'mcp__fpga-mcp__a_report_qor_suggestions',
  'mcp__fpga-mcp__list_backends',
  'mcp__fpga-mcp__list_constraint_files',
  'mcp__fpga-mcp__list_hardware_devices',
  'mcp__fpga-mcp__list_hardware_targets',
  'mcp__fpga-mcp__list_source_files',
  'mcp__fpga-mcp__q_get_failing_paths',
  'mcp__fpga-mcp__q_get_instance_assignment',
  'mcp__fpga-mcp__q_get_pin_location',
  'mcp__fpga-mcp__q_get_top_entity',
  'mcp__fpga-mcp__q_qsys_get_parameter',
  'mcp__fpga-mcp__q_qsys_list_components',
  'mcp__fpga-mcp__q_qsys_list_connections',
  'mcp__fpga-mcp__q_report_io',
  'mcp__fpga-mcp__q_report_resource',
  'mcp__fpga-mcp__read_file_lines',
  'mcp__fpga-mcp__viv_get_bd_cell_property',
  'mcp__fpga-mcp__viv_get_bd_cells',
  'mcp__fpga-mcp__viv_get_bd_intf_pins',
  'mcp__fpga-mcp__viv_get_bd_nets',
  'mcp__fpga-mcp__viv_get_bd_pins',
  'mcp__fpga-mcp__viv_get_bd_ports',
  'mcp__fpga-mcp__viv_get_default_lib',
  'mcp__fpga-mcp__viv_get_families',
  'mcp__fpga-mcp__viv_get_filesets',
  'mcp__fpga-mcp__viv_get_generated_clocks',
  'mcp__fpga-mcp__viv_get_hw_device_property',
  'mcp__fpga-mcp__viv_get_hw_devices',
  'mcp__fpga-mcp__viv_get_hw_ila_property',
  'mcp__fpga-mcp__viv_get_hw_ilas',
  'mcp__fpga-mcp__viv_get_hw_probes',
  'mcp__fpga-mcp__viv_get_hw_targets',
  'mcp__fpga-mcp__viv_get_hw_vio_input',
  'mcp__fpga-mcp__viv_get_hw_vios',
  'mcp__fpga-mcp__viv_get_impl_progress',
  'mcp__fpga-mcp__viv_get_impl_status',
  'mcp__fpga-mcp__viv_get_ipdefs',
  'mcp__fpga-mcp__viv_get_part_packages',
  'mcp__fpga-mcp__viv_get_pblocks',
  'mcp__fpga-mcp__viv_get_project_dir',
  'mcp__fpga-mcp__viv_get_project_property',
  'mcp__fpga-mcp__viv_get_project_summary',
  'mcp__fpga-mcp__viv_get_projects',
  'mcp__fpga-mcp__viv_get_sim_property',
  'mcp__fpga-mcp__viv_get_sim_state',
  'mcp__fpga-mcp__viv_get_target_language',
  'mcp__fpga-mcp__viv_get_user_id',
  'mcp__fpga-mcp__viv_get_value',
  'mcp__fpga-mcp__viv_get_vivado_version',
  'mcp__fpga-mcp__viv_get_wave_objects',
  'mcp__fpga-mcp__viv_get_xdc_files',
  'mcp__fpga-mcp__viv_lint_data_check',
  'mcp__fpga-mcp__viv_lint_route_status',
  'mcp__fpga-mcp__viv_lint_waiver_list',
  'mcp__fpga-mcp__viv_list_ip_catalog',
  'mcp__fpga-mcp__viv_report_bus_skew',
  'mcp__fpga-mcp__viv_report_clock_jitter',
  'mcp__fpga-mcp__viv_report_clock_latency',
  'mcp__fpga-mcp__viv_report_clock_propagation',
  'mcp__fpga-mcp__viv_report_compile_order',
  'mcp__fpga-mcp__viv_report_design_analysis',
  'mcp__fpga-mcp__viv_report_environment',
  'mcp__fpga-mcp__viv_report_hw_devices',
  'mcp__fpga-mcp__viv_report_hw_target',
  'mcp__fpga-mcp__viv_report_io',
  'mcp__fpga-mcp__viv_report_methodology_violations',
  'mcp__fpga-mcp__viv_report_power_verbose',
  'mcp__fpga-mcp__viv_report_powerup',
  'mcp__fpga-mcp__viv_report_qor_suggestions',
  'mcp__fpga-mcp__viv_report_ram_widgets',
  'mcp__fpga-mcp__viv_report_route_status_verbose',
  'mcp__fpga-mcp__viv_report_utilization_bram',
  'mcp__fpga-mcp__viv_report_utilization_hierarchical',
  'mcp__fpga-mcp__viv_report_utilization_slr',
  'mcp__fpga-mcp__viv_xsct_get_app_config',
  'mcp__fpga-mcp__viv_xsct_get_global',
  'mcp__fpga-mcp__viv_xsct_get_locals',
  'mcp__fpga-mcp__viv_xsct_get_platform_info',
  'mcp__fpga-mcp__viv_xsct_get_register',
  'mcp__fpga-mcp__viv_xsct_get_registers',
  'mcp__fpga-mcp__viv_xsct_get_target_info',
  'mcp__fpga-mcp__viv_xsct_get_workspace',
  'mcp__fpga-mcp__viv_xsct_hsi_get_addr_map',
  'mcp__fpga-mcp__viv_xsct_hsi_get_cpus',
  'mcp__fpga-mcp__viv_xsct_hsi_get_ip_config',
  'mcp__fpga-mcp__viv_xsct_hsi_get_memory',
  'mcp__fpga-mcp__viv_xsct_hsi_get_peripherals',
  'mcp__fpga-mcp__viv_xsct_list_apps',
  'mcp__fpga-mcp__viv_xsct_list_breakpoints',
  'mcp__fpga-mcp__viv_xsct_list_platforms',
  'mcp__fpga-mcp__viv_xsct_list_targets',
  'mcp__fpga-mcp__viv_xsct_read_memory',
  'mcp__fpga-mcp__viv_xsct_read_serial',
  'mcp__fpga-mcp__viv_xsct_version',
]);
for (const n of EXEMPT_READ_GENERATED) EXEMPT_READ.add(n);

// 名字像只读、**实际执行**：`run` 在 READ_WORDS 里（为保住 get_run_status），
// 于是这几个掉进 unknown。必须显式否决——尤其 `run_tcl` 正是绕开闸的 F1 口子。
const EXEC_EXACT = [
  'mcp__vivado__run_tcl',
  'mcp__vivado__safe_tcl',
  'mcp__vivado__run_synthesis',
  'mcp__vivado__run_implementation',
];
for (const n of EXEC_EXACT) VETO_EXACT.add(n);


// ── 2026-10-21 第二遍（更宽的只读动词集：current/all/is/wait/verify）────────────────
// 第一遍漏掉的原因：那遍只认 get/list/report/... 开头，于是 `current_project`、`viv_all_inputs`、
// `viv_wait_on_impl`、`verify_io_placement_tool` 这类留在 unknown 里继续被误杀。
const EXEMPT_READ_GENERATED_2 = new Set([
  'mcp__fpga-mcp__a_all_inputs',
  'mcp__fpga-mcp__a_all_outputs',
  'mcp__fpga-mcp__a_all_registers',
  'mcp__fpga-mcp__a_current_design',
  'mcp__fpga-mcp__a_current_project',
  'mcp__fpga-mcp__a_log_info',
  'mcp__fpga-mcp__current_project',
  'mcp__fpga-mcp__q_all_inputs',
  'mcp__fpga-mcp__q_all_outputs',
  'mcp__fpga-mcp__q_all_registers',
  'mcp__fpga-mcp__q_execute_all_flows',
  'mcp__fpga-mcp__viv_all_dsps',
  'mcp__fpga-mcp__viv_all_ffs',
  'mcp__fpga-mcp__viv_all_inputs',
  'mcp__fpga-mcp__viv_all_latches',
  'mcp__fpga-mcp__viv_all_outputs',
  'mcp__fpga-mcp__viv_all_rams',
  'mcp__fpga-mcp__viv_all_registers',
  'mcp__fpga-mcp__viv_current_bd',
  'mcp__fpga-mcp__viv_current_design',
  'mcp__fpga-mcp__viv_current_fileset',
  'mcp__fpga-mcp__viv_current_project',
  'mcp__fpga-mcp__viv_current_sim',
  'mcp__fpga-mcp__viv_run_all_simulation',
  'mcp__fpga-mcp__viv_wait_on_impl',
  'mcp__vivado__verify_io_placement_tool',
]);
for (const n of EXEMPT_READ_GENERATED_2) EXEMPT_READ.add(n);

// `run_simulation` 是**执行**（跑仿真、写产物），不是只读 ⟹ 显式否决。
for (const n of [
  'mcp__fpga-mcp__run_simulation',
]) VETO_EXACT.add(n);


// ── 2026-10-21 回收：生成式白名单**误放**的两条（审查生成结果时抓到）─────────
// 它们含 `execute` / `run_all`，作用是**执行整条流程**，不是查询；
// 之所以被放进来，是因为只读动词集里含 `all`，而写动词集里没有 `execute`。
const EXEC_RECALLED = [
  'mcp__fpga-mcp__q_execute_all_flows',
  'mcp__fpga-mcp__viv_run_all_simulation',
];
for (const n of EXEC_RECALLED) { EXEMPT_READ.delete(n); VETO_EXACT.add(n); }

/** 只读判定器自检：断言的**判定结果**与预期一致（不依赖名字集合，故不需重启即可复验） */
const SELF_CHECKS = [
  // [工具名, 期望放行?]
  ['mcp__vivado__list_sessions', true],
  ['mcp__vivado__get_project_info', true],
  ['mcp__vivado__get_timing_report', true],
  ['mcp__vivado__get_utilization_report', true],
  ['mcp__vivado__parse_xpr', true],
  ['mcp__vivado__xdc_lint', true],
  ['mcp__fpga-mcp__a_get_syn_status', true],
  ['mcp__fpga-mcp__viv_get_clocks', true],
  ['mcp__fpga-mcp__viv_list_flash_parts', true],   // 2026-10-21：名字含写动词 flash，但语义只读
  ['mcp__fpga-mcp__q_report_timing', true],
  ['mcp__vivado__run_tcl', false],
  ['mcp__vivado__safe_tcl', false],
  ['mcp__vivado__program_device', false],
  ['mcp__vivado__start_session', false],
  ['mcp__vivado__set_wave_zoom', false],
  ['mcp__vivado__xdc_auto_fix', false],
  ['mcp__fpga-mcp__set_backend', false],
  ['mcp__fpga-mcp__viv_lint_waiver_add', false],
  ['mcp__fpga-mcp__q_set_pin_location', false],
  ['mcp__fpga-mcp__q_execute_all_flows', false],
  ['mcp__fpga-mcp__viv_create_bd', false],
  // 回归 A：v2 的子串误判（clock→lock / synthesis→synth）必须放行
  ['mcp__fpga-mcp__get_clock_info', true],
  ['mcp__fpga-mcp__get_synthesis_report', true],
  ['mcp__fpga-mcp__a_report_clock_transfers', true],
  // 回归 B：「open」是状态变更，open_run 必须拒（曾经被误放行）
  ['mcp__fpga-mcp__a_open_run', false],
  ['mcp__fpga-mcp__viv_open_run', false],
  ['mcp__fpga-mcp__q_project_open', false],
  // 对照：名字里有 route，但它是「报告布线状态」，属只读
  ['mcp__fpga-mcp__a_report_route_status', true],
];

// ── 角色作用域：按「调用者是谁」决定要不要把只读边界套在这次调用上 ──────────
//
// 为什么不靠 per-agent 注册（agent/created + agent.ctx.guard）：
//   1. 时序：agent/created 时 Lead 的 spawn 记录可能尚未落盘，身份查不到 ⇒ 静默放行；
//   2. 卸载：官方警告——插件卸载**不会**自动解除 agent.ctx 注册。
//   调用时（工具真的被调的那一刻）解析身份没有这两个问题，也天然覆盖已存在的 agent。
//
// 依据（app.asar 内契约原文）：
//   ctx.agentTeams.tryMembership(agent) -> TeamMembership | undefined
//   TeamMembership = { root, id, role: 'lead' | 'teammate', name }
//   ⇒ 只有 lead / teammate 两档；writer 与 reviewer 都是 teammate，
//     故业务角色只能由 **Lead 在 spawn 时起的 name** 承载（该 name 不可变）。
export const DEFAULT_WRITER_PATTERNS = ['writer'];

/**
 * 名字是否命中「写手模式」——命中者**保留** MCP 写权限。
 *
 * 匹配规则（刻意收窄，失败方向是"少给权限"）：
 *   - 大小写不敏感；
 *   - 前缀命中：`writer-rtl` ⇒ 命中；
 *   - 或按 `-`/`_`/`.`/空白 切词后**整词**命中：`rtl-writer` ⇒ 命中。
 * 注意：`writer` 出现在名字里但不在词首/整词时**不算**（如 `rewriter`）。
 */
export function isWriterName(name, patterns = DEFAULT_WRITER_PATTERNS) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const lower = name.toLowerCase();
  const tokens = lower.split(/[-_\s.]+/).filter(Boolean);
  return patterns.some((p) => {
    const pat = String(p ?? '').toLowerCase().trim();
    if (!pat) return false;
    return lower.startsWith(pat) || tokens.includes(pat);
  });
}

/**
 * 角色判定：返回 'enforce' = 套只读边界；'skip' = 放行（不套）。
 *
 * ## 核心不变式：**写权限不可委派**（2026-10-14 用户两次指出后定稿）
 *
 * 第一版错在"子 agent 无身份 ⇒ 放行" ⇒ 审查者派生写手子 agent 绕过边界。
 * 第二版错在"角色继承" ⇒ **writer 的子 agent 继承到写权限**，于是：
 *   · writer 可以派生任意多个可写子 agent ⇒ **"同一 checkout 单一 writer"当场失效**；
 *   · 等于给 writer 开了一条把写权限"洗"给协助者的通道。
 *
 * 定稿规则：`skip`（可写）**当且仅当调用者本人就是写手成员**。
 *   · writer 本人                 → skip
 *   · **writer 的子/孙 agent**    → enforce（子 agent 是审查/协助，不是写手）
 *   · reviewer 本人及其子 agent   → enforce
 *   · 有责任链但自己不是写手       → enforce（**不受 unknownPolicy 影响**）
 *   · 完全无责任链（宿主级调用）   → unknownPolicy（默认 guard）
 *
 * `ancestorMembership` 因此只用于**归因与用途说明**（日志里能指出"谁派的"），
 * 且它一旦存在就**钉死 enforce**——这样安全性不再依赖 `unknownPolicy` 这个旋钮。
 */
export function resolveRoleVerdict({
  hasAgent,
  teamServiceAvailable,
  selfMembership,
  ancestorMembership,
  writerPatterns = DEFAULT_WRITER_PATTERNS,
  unknownPolicy = 'guard',
  serviceMissingPolicy = 'guard',
} = {}) {
  if (!teamServiceAvailable) return serviceMissingPolicy === 'pass' ? 'skip' : 'enforce';
  if (!hasAgent) return unknownPolicy === 'pass' ? 'skip' : 'enforce';
  // 1) 写手本人 ⇒ 可写（唯一可写的情形）
  if (selfMembership && isWriterName(selfMembership.name, writerPatterns)) return 'skip';
  // 2) 自己就是成员但非写手 ⇒ 只读
  if (selfMembership) return 'enforce';
  // 3) 不是成员、但有责任链祖先 ⇒ 一律只读（**写权限不可委派**，与 unknownPolicy 无关）
  if (ancestorMembership) return 'enforce';
  // 4) 完全无责任链
  return unknownPolicy === 'pass' ? 'skip' : 'enforce';
}

/** 角色判定自检用例（纯函数，配置写错时 fail-closed 拒绝加载） */
const ROLE_SELF_CHECKS = [
  // [说明, 入参, 期望]
  ['teammate 名 reviewer-rt → 套边界',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: { name: 'reviewer-rt', role: 'teammate' } }, 'enforce'],
  ['lead → 也套边界（用户决策：Lead 不下场写）',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: { name: 'lead', role: 'lead' } }, 'enforce'],
  ['teammate 名 writer-rtl（本人）→ 放行（写手保留写权限）',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: { name: 'writer-rtl', role: 'teammate' } }, 'skip'],
  ['teammate 名 rtl-writer（本人）→ 放行（整词命中）',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: { name: 'rtl-writer', role: 'teammate' } }, 'skip'],
  ['teammate 名 rewriter → 套边界（不得子串误命中 writer）',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: { name: 'rewriter', role: 'teammate' } }, 'enforce'],

  // ── 不变式：**写权限不可委派** ─────────────────────────────────────────
  // 2026-10-14 第二轮修正：曾把"祖先继承"实现成角色继承 ⇒ writer 的子 agent 可写，
  // 于是 writer 能无限派生写手、单一 writer 纪律失效，且可把写权限"洗"给协助者。
  ['★ writer 的子 agent → 套边界（写不可委派；协助者不是写手）',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: undefined,
      ancestorMembership: { name: 'writer-rtl', role: 'teammate' } }, 'enforce'],
  ['★ writer 的子 agent（即使 unknownPolicy=pass）→ 仍套边界（不受旋钮影响）',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: undefined,
      ancestorMembership: { name: 'writer-rtl', role: 'teammate' }, unknownPolicy: 'pass' }, 'enforce'],
  ['★ writer 的孙 agent（多层）→ 套边界',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: undefined,
      ancestorMembership: { name: 'writer-rtl', role: 'teammate' } }, 'enforce'],
  ['reviewer 的子 agent → 套边界',
    { hasAgent: true, teamServiceAvailable: true, selfMembership: undefined,
      ancestorMembership: { name: 'reviewer-rt', role: 'teammate' } }, 'enforce'],

  ['无 agent 归属 + unknownPolicy=pass → 放行',
    { hasAgent: false, teamServiceAvailable: true, unknownPolicy: 'pass' }, 'skip'],
  ['无 agent 归属 + unknownPolicy=guard → 套边界',
    { hasAgent: false, teamServiceAvailable: true, unknownPolicy: 'guard' }, 'enforce'],
  // ⚠ 默认值守卫：unknownPolicy 默认必须是 guard（fail-closed）。
  //    2026-10-14 曾默认 pass，导致「审查者派生 subagent 绕过只读边界」。
  ['无 agent 归属 + 不传 unknownPolicy（默认）→ 套边界',
    { hasAgent: false, teamServiceAvailable: true }, 'enforce'],
  ['非成员、无责任链 + 不传 unknownPolicy（默认）→ 套边界',
    { hasAgent: true, teamServiceAvailable: true }, 'enforce'],
  ['团队服务缺失 + serviceMissingPolicy=guard → 套边界（不得静默放行）',
    { teamServiceAvailable: false, serviceMissingPolicy: 'guard' }, 'enforce'],
  ['团队服务缺失 + serviceMissingPolicy=pass → 放行',
    { teamServiceAvailable: false, serviceMissingPolicy: 'pass' }, 'skip'],
];

/**
 * shell 扫描判定器的加载期自检（方案 A）。
 * 每项：`[说明, 命令文本, 期望是否命中]`。
 * ⚠ 必须包含**负例**：`vivado.log` 这类合法读日志**不得**被误伤——
 *   误伤会让审查者连日志都读不了，那是把可用性换安全性的坏交易。
 */
const SHELL_SELF_CHECKS = [
  ['vivado.bat 调用 → 命中', "& 'G:\\vivado\\Vivado\\2019.1\\bin\\vivado.bat' -mode batch", true],
  ['vivado -mode → 命中', 'vivado -mode tcl -source build.tcl', true],
  ['program_hw_devices → 命中', 'vivado -mode tcl -source pgm.tcl  # program_hw_devices', true],
  ['write_cfgmem → 命中', 'write_cfgmem -format mcs -size 16 -interface SPIx4 x.mcs', true],
  ['quartus_pgm → 命中', 'quartus_pgm -c USB-Blaster foo.sof', true],
  ['openocd → 命中', 'openocd -f board.cfg', true],
  ['hw_server → 命中', 'hw_server -s tcp::3121', true],
  ['echo 无害 → 不命中', 'echo shell-ok', false],
  ['★ 读 vivado.log（负例，不得误伤）→ 不命中', 'Get-Content vivado.log -Tail 20', false],
  ['★ 读项目文件（负例）→ 不命中', 'Get-ChildItem -Recurse guards', false],
  ['空命令 → 不命中', '', false],
  // ── 面 2：串口写＝物理致动 ─────────────────────────────────────────────
  ['★ 串口发命令 -SendHex → 命中', "capture_serial.ps1 -PortName COM8 -SendHex '01' -Repeat 12", true],
  ['★ 驱动脚本 send_0_to_f → 命中', 'pwsh -File scripts/send_0_to_f.ps1 -PortName COM3 -Cycles 1', true],
  ['★ 主动制动 live_brake → 命中', 'pwsh -File live_brake.ps1 -PortName COM8', true],
  ['★ 扫频 live_sweep → 命中', 'pwsh -File live_sweep.ps1 -PortName COM8', true],
  ['★ 复合：SerialPort…Write → 命中', '$port = New-Object System.IO.Ports.SerialPort COM8; $port.Write($b,0,1)', true],
  ['★ 被动监听 capture_serial（无 -SendHex）→ **不命中**',
    'pwsh -File scripts/capture_serial.ps1 -PortName COM8 -Seconds 120', false],
  ['★ 被动监听 live_listen → **不命中**', 'pwsh -File live_listen.ps1 -PortName COM8 -Seconds 30', false],
  ['★ 枚举串口 GetPortNames → 不命中', '[System.IO.Ports.SerialPort]::GetPortNames()', false],
  ['★ 只有 .Write( 无 SerialPort（负例）→ 不命中', 'something.Write(1)', false],
];

function runSelfChecks(log) {
  const bad = [];
  for (const [tool, expectAllow] of SELF_CHECKS) {
    const reason = readOnlyDecision(tool);
    const allowed = reason === null;
    if (allowed !== expectAllow) {
      bad.push(`${tool}: 期望 ${expectAllow ? '放行' : '拒绝'}，实得 ${allowed ? '放行' : `拒绝(${reason})`}`);
    }
  }
  for (const [what, input, expect] of ROLE_SELF_CHECKS) {
    const got = resolveRoleVerdict(input);
    if (got !== expect) bad.push(`角色判定「${what}」：期望 ${expect}，实得 ${got}`);
  }
  for (const [what, command, expectHit] of SHELL_SELF_CHECKS) {
    const hit = scanShellCommand(command) !== null;
    if (hit !== expectHit) bad.push(`shell 扫描「${what}」：期望${expectHit ? '命中' : '不命中'}，实得${hit ? '命中' : '不命中'}`);
  }
  if (bad.length > 0) {
    log.error(`[role-guard] 判定器自检失败，拒绝以损坏状态加载：\n  ${bad.join('\n  ')}`);
    throw new Error(`[role-guard] 判定器自检 ${bad.length} 条不符，插件拒绝加载`);
  }
  log.info(`[role-guard] 判定器自检通过（只读 ${SELF_CHECKS.length} 条 + 角色 ${ROLE_SELF_CHECKS.length} 条`
    + ` + shell ${SHELL_SELF_CHECKS.length} 条用例）`);
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const {
    mode = 'dry-run',
    probeDeny = [],
    probeReadOnlyNames = false,
    // ★ 2026-10-21 新增取值 'waterfall'（技术来源：@rayfalling/dsh-tool-visibility 的降级路径）：
    //   只在 agent scope 上挂 `system-prompt/assemble` waterfall，把「MCP 写工具」从**模型所见**里剔除；
    //   **完全不调用 tools.restrict** ⟹ 不碰非 MCP 工具管线（这正是 2×2/1b 实验里被拖垮的那条）。
    //   语义边界：只影响"模型看到什么"，**不阻止执行**；执行仍由 roleScope 判定层兜底。
    restrictMcpWriteTools = false,
    // ★ 2026-10-21 受控实验开关：
    //   restrictOnly 非空 ⟹ **只遮蔽名单内**的 MCP 写工具（支持 `mcp__x__*` 前缀通配）；
    //   空数组 = 旧行为（全量 498 条）。
    restrictOnly = [],
    // ★ 团队通道白名单：这些名字**永不被 restrict 遮蔽**（即使分类器判成写）。
    //   起因：2×2 实验发现 restrict 后 `send_message` 变 `Error: null`，先隔离"是不是名单太大/误伤"。
    restrictProtect = [],
    agentScope = { enabled: false, agentIds: [], role: 'reviewer', dryRunLog: true },
    roleScope = {
      enabled: false,
      writerNamePatterns: DEFAULT_WRITER_PATTERNS,
      // ⚠ 默认 guard（fail-closed）。2026-10-14 由 pass 翻正：
      //    子 agent 已通过「祖先角色继承」归因，真正的"未知"只剩无 agent 归属的宿主调用，
      //    对它放行没有安全理由，而且 pass 会变成一个绕过通道。
      unknownPolicy: 'guard',
      serviceMissingPolicy: 'guard',
    },
    teamServiceKey = 'agentTeams',
    eventLog = '',
    // ── 方案 A：shell 面减速带（默认关；开启需 roleScope 同时开启）──────────
    shellScope = {
      enabled: false,
      toolNames: DEFAULT_SHELL_TOOL_NAMES,
      denyPatterns: DEFAULT_SHELL_DENY_PATTERNS,
      denyGroups: DEFAULT_SHELL_DENY_GROUPS,
      allowPatterns: [],
    },
  } = config;

  const log = ctx.logger?.('role-guard') ?? console;
  runSelfChecks(log);

  // ★ 2026-10-21 目标轮 1：**本机契约探测**（零副作用，只记日志）。
  //   背景：'hard' 模式的名单只允许来自 `tools.view(agent).restrictableNames`（第三方实现的做法）。
  //   但那个方法**不在文档化的 Service 契约**里 ⟹ 必须在本宿主实测它是否存在，不能只靠上游文档推断。
  //   本行只观测 `typeof`，不调用、不改权限；重启后看 guard-events 的 `capability` 行即可定论。
  let posCaps = null;
  try {
    const caps = {
      hasToolsView: typeof ctx?.tools?.view === 'function',
      hasToolsRestrict: typeof ctx?.tools?.restrict === 'function',
      hasToolsGuard: typeof ctx?.tools?.guard === 'function',
      hasToolsSchemas: typeof ctx?.tools?.schemas === 'function',
    };
    posCaps = caps;
    log.info(`[role-guard] 契约探测：view=${caps.hasToolsView} restrict=${caps.hasToolsRestrict}`
      + ` guard=${caps.hasToolsGuard} schemas=${caps.hasToolsSchemas}`
      + (caps.hasToolsView ? '' : ' ⚠ 无 view ⟹ hard 模式会 fail-safe 跳过（不会误伤）'));
  } catch { /* 探测失败绝不影响加载 */ }

  // ── 配置自检：把「设了但不会生效」的组合变成加载失败 ─────────────────────
  // 教训：`restrictMcpWriteTools: true` 原先只在 agentScope.enabled 分支里被读取，
  // 于是 agentScope 关闭时它是个**静默 no-op**——正是本项目最忌讳的失败形态。
  // ★ 2026-10-21（A′）：只有 **字面 true** 才要求 agentScope。
  //   `'dry-run'` 走**独立干跑块**（只读 + 只记日志，不碰 agent scope），故不需要 agentScope。
  if ((restrictMcpWriteTools === true || restrictMcpWriteTools === 'waterfall'
      || restrictMcpWriteTools === 'hard') && !agentScope.enabled) {
    throw new Error('[role-guard] 配置无效：restrictMcpWriteTools=' + JSON.stringify(restrictMcpWriteTools)
      + ' 但 agentScope.enabled=false。两者都是 **per-agent** 手段（restrict 是 scope 静态掩码；'
      + 'waterfall 要挂在 agent scope 上才只影响它自己），角色模式无法承载。'
      + '要么开 agentScope，要么把 restrictMcpWriteTools 置 false。');
  }
  // shell 扫描必须有**角色归因**才能判"谁是只读"。roleScope 关闭时它无从判定，
  // 若静默放行就又是一个"设了但不生效"的假安全感 ⇒ 拒绝加载（与上面同一条纪律）。
  if (shellScope.enabled && !roleScope.enabled) {
    throw new Error('[role-guard] 配置无效：shellScope.enabled=true 但 roleScope.enabled=false。'
      + 'shell 扫描需要按调用者判角色（只读角色才扫）。要么开 roleScope，要么把 shellScope.enabled 置 false。');
  }

  // ── 可读事件日志（JSONL）：宿主日志我看不到，写进工作区我就能核对 ──────────
  // 纯诊断用，opt-in；只记判定与角色解析，**不记工具参数**（避免敏感内容写盘）。
  let appendEvent = () => {};
  if (eventLog) {
    appendEvent = (obj) => {
      try {
        appendFileSync(eventLog, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
      } catch { /* 诊断失败绝不影响主功能 */ }
    };
    log.info(`[role-guard] 事件日志已开启：${eventLog}`);
  }

  const decided = new Map(); // tool -> reason（去重，避免刷屏）

  // ── 工作区设置问题的**响亮**通道（P4）────────────────────────────────────
  // P2 要求每次判定都重读盘 ⇒ 坏文件会在每次工具调用时产生同一条错误；
  // 去重键 = 消息本身，同一条只吼一次（**日志去重，不是取值缓存**——取值永不缓存）。
  const reportProblems = createProblemReporter((msg, info) => {
    log.warn(`[role-guard] 工作区设置：${msg}${info?.cwd ? `（cwd=${info.cwd}）` : ''}`);
    appendEvent({ event: 'workspace-settings-problem', message: msg,
      reason: info?.reason ?? null, cwd: info?.cwd ?? null });
  });

  /**
   * 判定期拉取工作区覆盖（P1–P4/P6），返回 effective 的 `{ roleScope, shellScope }`。
   *
   * ⚠ 关键性质：**无工作区文件 / 文件不可用 / 组合非法 / 无会话 cwd** 时，
   *   返回的是 apply 期解构出来的**那两个原对象**（同一引用）
   *   ⇒ 「无工作区文件时判定行为与改动前逐项一致」是**构造性成立**的（V6 最关键回归）。
   * ⚠ `exec.agent === undefined`（宿主级调用）⇒ `resolvePluginConfig` 直接短路返回 profile（P6，
   *   **有意降级**：宿主级调用没有工作区归属，不许包装成「已按工作区覆盖」）。
   */
  function effectiveScopes(exec) {
    let pull;
    try {
      pull = resolvePluginConfig('role-guard', config, exec?.agent);
    } catch (e) {
      // 判定期绝不抛：抛异常会让整条护栏失效（历史先例）
      return { roleScope, shellScope, pull: { source: 'profile', cwd: null, reason: 'pull-error', problems: [`拉取工作区设置抛异常：${e?.message ?? e}`] } };
    }
    reportProblems(pull.problems, { reason: pull.reason, cwd: pull.cwd });
    if (pull.source !== 'workspace') return { roleScope, shellScope, pull };
    const rs = pull.config?.roleScope;
    const ss = pull.config?.shellScope;
    return {
      roleScope: (rs && typeof rs === 'object') ? { ...roleScope, ...rs } : roleScope,
      shellScope: (ss && typeof ss === 'object') ? { ...shellScope, ...ss } : shellScope,
      pull,
    };
  }

  // 团队服务惰性解析：apply 期服务可能尚未挂载，故每次调用时取（很便宜）
  const teamService = () => {
    try { return ctx.get?.(teamServiceKey) ?? undefined; } catch { return undefined; }
  };
  let warnedNoTeamService = false;

  function membershipOf(exec) {
    const svc = teamService();
    if (!svc || !exec?.agent) return undefined;
    try { return svc.tryMembership?.(exec.agent) ?? undefined; } catch { return undefined; }
  }

  const MAX_ANCESTOR_HOPS = 8;

  /**
   * 解析调用者的身份：`{ self, ancestor, via }`。
   *
   * ⚠ 本函数是 2026-10-14 两次安全修正的产物，两版错误都已记录：
   *
   * **第一版错**：子 agent 不是团队成员（`tryMembership` → undefined），
   *   若就此落到"身份未知 ⇒ 放行"，则**审查者派生一个子 agent 就能写**
   *   ⇒ 越权委托绕过。（DSH 文档明示子 agent 是 fresh scope，不继承父限制。）
   *
   * **第二版错**：改成"有效角色 = 最近团队成员祖先的角色"（角色继承），
   *   于是 **writer 的子 agent 继承到写权限** ⇒ writer 可无限派生可写子 agent，
   *   "同一 checkout 单一 writer"失效，且等于把写权限"洗"给协助者。
   *
   * **定稿**：祖先身份**只用于归因，绝不用于授予写权限**。
   *   `self` = 调用者自己的团队身份；`ancestor` = 沿创建链最近的团队成员祖先；
   *   判定时只有 `self` 是写手才放行，`ancestor` 存在则**钉死 enforce**。
   */
  function resolveCaller(exec) {
    const svc = teamService();
    if (!svc || !exec?.agent) return { self: undefined, ancestor: undefined, via: 'none' };
    let cur = exec.agent;
    const seen = new Set([cur?.id]);
    for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop++) {
      let m;
      try { m = svc.tryMembership?.(cur) ?? undefined; } catch { m = undefined; }
      if (m) {
        return hop === 0
          ? { self: m, ancestor: undefined, via: 'self' }
          : { self: undefined, ancestor: m, via: `ancestor+${hop}` };
      }
      // 向上找直接父：用运行时所有权判定（isOwnedBy），不依赖 session 血统
      const agents = (() => { try { return ctx.get?.('agents') ?? undefined; } catch { return undefined; } })();
      if (!agents?.isOwnedBy || !agents?.list) return { self: undefined, ancestor: undefined, via: 'none' };
      let parent;
      for (const cand of agents.list() ?? []) {
        if (!cand || seen.has(cand.id)) continue;
        try { if (agents.isOwnedBy(cur.id, cand)) { parent = cand; break; } } catch { /* skip */ }
      }
      if (!parent) return { self: undefined, ancestor: undefined, via: 'none' };
      seen.add(parent.id);
      cur = parent;
    }
    return { self: undefined, ancestor: undefined, via: 'too-deep' };
  }

  // plugin-start 必须写在 teamService 定义**之后**（const 有 TDZ；
  // 之前放在前面时被自己的 catch 吞掉，导致启动事件静默丢失——已被 stub 测试抓到）
  if (eventLog) {
    appendEvent({ event: 'plugin-start', mode, eventLog,
      roleScope: roleScope.enabled, writerNamePatterns: roleScope.writerNamePatterns,
      unknownPolicy: roleScope.unknownPolicy, serviceMissingPolicy: roleScope.serviceMissingPolicy,
      agentScope: agentScope.enabled, restrictMcpWriteTools,
      teamServiceKey, teamServiceAvailable: teamService() !== undefined });
    if (posCaps) appendEvent({ event: 'capability', ...posCaps });
  }

  /** 日志用的调用者标签（便于人工核对 dry-run 的"本应拒绝谁"） */
  function callerLabel(exec) {
    if (!exec?.agent) return 'caller=∅';
    const c = resolveCaller(exec);
    if (c.self) return `caller=${c.self.name}(${c.self.role},self)`;
    if (c.ancestor) return `caller=child-of:${c.ancestor.name}(${c.via})`;
    return `caller=无责任链(${c.via})`;
  }

  /**
   * 判定一次调用。返回 `{ deny, source }`：
   *   deny   = 字符串 ⇒ 拒绝理由（null ⇒ 放行）
   *   source = 判定来源，**必须如实**（用于取证日志）：
   *            'probe' | 'nonMcp' | 'roleSkip' | 'readonlyWhitelist' | 'readonlyDeny'
   *            | 'shellAllow' | 'shellDeny'
   * 2026-10-14 教训：此前只返回理由串，无法区分"角色 skip"与"只读白名单放行"，
   * 导致日志把两种放行混为一谈（取证会误导）。
   */
  function decide(exec) {
    const n = exec?.name;
    // 探针优先：即使 dry-run 也真拒（探针本身就是实验，必须能观测到拒绝）
    if (typeof n === 'string' && probeDeny.includes(n)) {
      return { deny: `[role-guard] RT-02 探针命中：本会话已注册对 \`${n}\` 的拒绝`, source: 'probe' };
    }
    // ── 拉取式 effective（PLAN §9.1 裁决 D-A + P1–P4/P6）───────────────────
    // 按 `exec.agent.session.header.cwd` 读工作区覆盖；**绝不回落 process.cwd()**（P1）。
    // 无覆盖时 roleScopeNow/shellScopeNow **就是** apply 期那两个原对象（同一引用）
    // ⇒ 默认路径行为与改动前逐项一致（V6 最关键回归）。
    const { roleScope: roleScopeNow, shellScope: shellScopeNow } = effectiveScopes(exec);
    const mcp = isMcpTool(n);
    // 方案 A：shell 工具也纳入（只读角色的命令文本扫描）
    const shell = shellScopeNow.enabled && isShellTool(n, shellScopeNow.toolNames);
    if (!mcp && !shell) return { deny: null, source: 'nonMcp' }; // 其余非 MCP 不管
    if (roleScopeNow.enabled) {
      const svc = teamService();
      if (!svc && !warnedNoTeamService) {
        warnedNoTeamService = true;
        log.error(`[role-guard] roleScope 已启用，但 ctx.get("${teamServiceKey}") 取不到服务；`
          + `按 serviceMissingPolicy=${roleScopeNow.serviceMissingPolicy} 处理`);
        appendEvent({ event: 'team-service-missing', tool: n, key: teamServiceKey,
          policy: roleScopeNow.serviceMissingPolicy });
      }
      const caller = resolveCaller(exec);
      const verdict = resolveRoleVerdict({
        hasAgent: exec?.agent !== undefined,
        teamServiceAvailable: svc !== undefined,
        selfMembership: caller.self,
        ancestorMembership: caller.ancestor,
        writerPatterns: roleScopeNow.writerNamePatterns,
        unknownPolicy: roleScopeNow.unknownPolicy,
        serviceMissingPolicy: roleScopeNow.serviceMissingPolicy,
      });
      if (verdict === 'skip') return { deny: null, source: 'roleSkip' }; // 写手本人
    }
    // 到这里 = 只读角色（或 roleScope 关闭时的全局只读模式）
    if (shell) {
      const text = extractShellCommand(exec?.arguments);
      const hit = scanShellCommand(text, shellScopeNow.denyPatterns, shellScopeNow.allowPatterns,
        shellScopeNow.denyGroups);
      if (hit === null) return { deny: null, source: 'shellAllow' };
      return {
        deny: `[role-guard] 只读角色禁止通过 shell 调厂商/烧板工具或**串口写（物理致动）**`
          + `（命中 \`${hit.pattern}\`）：${n}。`
          + `被动监听串口是允许的；这是**文本减速带，非硬边界**（见 role-guard README §6.5）。`,
        source: 'shellDeny',
        pattern: hit.pattern,
      };
    }
    const r = readOnlyDecision(n);
    return r === null
      ? { deny: null, source: 'readonlyWhitelist' }
      : { deny: r, source: 'readonlyDeny' };
  }

  function onCall(exec) {
    const { deny, source } = decide(exec);
    const n = exec?.name;
    const callerInfo = (() => {
      const c = resolveCaller(exec);
      return c.self ? { name: c.self.name, role: c.self.role, via: 'self' }
        : c.ancestor ? { name: c.ancestor.name, role: c.ancestor.role, via: c.via, childOf: true }
          : null;
    })();
    // 取证用去重键：必须含调用者。
    // 2026-10-14 教训：原先只按工具名去重 ⇒ 同一工具被不同角色拒绝时只记第一条，
    // reviewer 与其子 agent 的拒绝因此**没能入档**，只能靠工具返回原文取证。
    const callerKey = callerInfo
      ? `${callerInfo.name}|${callerInfo.role}|${callerInfo.via}`
      : `∅|${exec?.agent ? 'agent-no-chain' : 'no-agent'}`;
    const dedupKey = `${n}::${callerKey}`;
    if (deny === undefined || deny === null) {
      // 放行也要留痕，且**如实记录来源**（roleSkip = 写手本人；readonlyWhitelist = 只读白名单；
      // shellAllow = 只读角色的 shell 命令未命中厂商/烧板模式）
      const tracked = isMcpTool(n) || (shellScope.enabled && isShellTool(n, shellScope.toolNames));
      if (roleScope.enabled && tracked) {
        appendEvent({ event: 'allow', tool: n, caller: callerInfo, source,
          hasAgent: exec?.agent !== undefined, teamServiceAvailable: teamService() !== undefined });
      }
      return undefined;
    }
    if (decided.get(dedupKey) !== deny) {
      decided.set(dedupKey, deny);
      const tag = mode === 'enforce' ? 'DENY' : 'DRY-RUN(本应拒绝)';
      log.warn(`[role-guard] ${tag} ${n} [${callerLabel(exec)}] ⟸ ${deny}`);
      appendEvent({ event: 'deny', tool: n, enforced: mode === 'enforce', source,
        caller: callerInfo, hasAgent: exec?.agent !== undefined, reason: deny });
    }
    if (mode === 'enforce' || (typeof n === 'string' && probeDeny.includes(n))) {
      return deny;
    }
    return undefined; // dry-run：只记录，不拦
  }

  ctx.tools.guard(onCall);
  if (roleScope.enabled && roleScope.unknownPolicy === 'pass') {
    log.warn('[role-guard] ⚠ roleScope.unknownPolicy=pass：**无责任链**的宿主级 MCP 写调用会被放行。'
      + '有祖先的子 agent 仍会被拦（写不可委派），但本档位已宽松，建议用 guard。');
  }
  log.info(`[role-guard] 已挂全局 guard；mode=${mode}；探针=${probeDeny.length} 项；`
    + `roleScope=${roleScope.enabled ? 'on' : 'off'}`
    + (roleScope.enabled
      ? `（写手模式=${JSON.stringify(roleScope.writerNamePatterns)}，未知身份=${roleScope.unknownPolicy}，`
        + `服务缺失=${roleScope.serviceMissingPolicy}，agentTeams=${teamService() ? '可用' : '暂不可用'}）`
      : ''));

  // ── 探针辅助：把「全局工具名集合」打日志，便于核对判定器面对真实名单的表现 ──
  const report = () => {
    let names = [];
    try {
      names = (ctx.tools.schemas?.() ?? []).map((s) => s.name);
    } catch (e) {
      log.warn(`[role-guard] 列工具名失败：${e?.message ?? e}`);
      return;
    }
    const mcp = names.filter(isMcpTool);
    const wouldDeny = mcp.filter((n) => readOnlyDecision(n) !== null);
    const allow = mcp.filter((n) => readOnlyDecision(n) === null);
    log.info(`[role-guard] 工具名核对：可见 ${names.length}，MCP ${mcp.length}`
      + `（会放行 ${allow.length} / 会拒绝 ${wouldDeny.length}）`);
    if (probeReadOnlyNames) {
      for (const n of allow) log.info(`[role-guard] ALLOW ${n}`);
      for (const n of wouldDeny) log.info(`[role-guard] DENY  ${n}`);
    }
    for (const p of probeDeny) {
      log.info(`[role-guard] 探针检查：${p} 是否可 restrict ⟹ ${names.includes(p) ? '在' : '不在'}全局名集`);
    }
  };
  report();

  // ── 可选加固：把「已知的 MCP 写工具」从该 agent 的可见集合里遮蔽 ──────────
  // 时序坑：MCP 工具「连接后才注册」，此处若名字未就位，restrict 会抛
  //         `names unknown global tool`（API 原文）。故只在名单非空且全部命中时才调用。
  const AGENT_TEAM_TOOLS = [
    'send_message', 'list_agents', 'spawn_teammate', 'interrupt_agent', 'wait_agent',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
    'subagent', 'subagent_fork',
  ];

  /**
   * 生成一个 `system-prompt/assemble` 的 **waterfall**：把「MCP 写工具」从**模型所见**里剔除。
   * 技术来源：`@rayfalling/dsh-tool-visibility`（该插件在根层挂载、restrict 不可用时唯一可用的降级路径）。
   * 边界（必须记住）：**只影响 schema 注入，不阻止执行**；执行仍由 roleScope 判定层兜底。
   * 安全：**完全不调用任何 restrict** ⟹ 不会碰非 MCP 工具管线（2026-10-21 实验里被拖垮的那条）。
   */
  function makeAssembleFilter(agentId, role) {
    return async (assembly, _context, next) => {
      let result;
      try {
        result = await next();
      } catch (e) {
        appendEvent({ event: 'assemble-filter-failed', agent: agentId, error: String(e?.message ?? e) });
        throw e;
      }
      try {
        const tools = Array.isArray(result?.tools) ? result.tools : null;
        if (!tools) return result;
        const kept = tools.filter((t) => !(t && typeof t.name === 'string'
          && isMcpTool(t.name) && readOnlyDecision(t.name) !== null));
        if (kept.length === tools.length) return result;
        appendEvent({ event: 'assemble-filter', agent: agentId, role,
          before: tools.length, after: kept.length, removed: tools.length - kept.length });
        return { ...result, tools: kept };
      } catch (e) {
        appendEvent({ event: 'assemble-filter-error', agent: agentId, error: String(e?.message ?? e) });
        return result;
      }
    };
  }

  /**
   * 方案 B：对**继承层**写类 MCP 做硬掩码（`restrict({deny})` ⇒ 调用返回 UNKNOWN_TOOL）。
   *
   * 契约来自已固定的上游实现（commit 6908b27）：
   *   · 可限制集合**只能**从 `tools.view(agent).restrictableNames`（Set）取；
   *   · 取不到 ⇒ **跳过**，绝不退回 `schemas()`（它含 Agent 自身层与保留传输名，
   *     把这些名字喂给 restrict 会让**整次调用失败**）；
   *   · `restrict()` 返回 disposer，必须保存并在 agent 销毁 / 插件卸载时释放。
   *
   * 与 `waterfall` 的分工：本函数是**硬**掩码（看不见 + 调不到）；waterfall 只是软过滤。
   * @returns {Function|null} disposer；未施加时 null
   */
  function applyHardMask(actx, agent, role) {
    // ★ 2026-10-21 审查修正（HIGH）：restrictableNames 的正确来源是**全局** `ctx.tools.view(agent)`
    //   （上游固定 commit 6908b27 的契约）；`agent.ctx.tools.view` 只作兼容回退。
    //   两者都取不到 ⇒ 跳过（fail-safe），**绝不退回 schemas()**。
    const viewFn = (() => {
      try { if (typeof ctx?.tools?.view === 'function') return (a) => ctx.tools.view(a); } catch { /* fall */ }
      try { if (typeof actx?.tools?.view === 'function') return (a) => actx.tools.view(a); } catch { /* fall */ }
      return null;
    })();
    if (!viewFn) {
      appendEvent({ event: 'hard-mask-skip', agent: agent?.id, role, reason: 'view-unavailable' });
      return { disposer: null, denied: [] };
    }
    let view = null;
    try {
      view = viewFn(agent);
    } catch (e) {
      appendEvent({ event: 'hard-mask-skip', agent: agent?.id, role, reason: 'view-threw', error: String(e?.message ?? e) });
      return { disposer: null, denied: [] };
    }
    const restrictable = view && view.restrictableNames;
    if (!(restrictable instanceof Set)) {
      appendEvent({ event: 'hard-mask-skip', agent: agent?.id, role, reason: 'restrictableNames-not-set' });
      return { disposer: null, denied: [] };
    }

    const only = Array.isArray(restrictOnly) ? restrictOnly.filter((x) => typeof x === 'string' && x) : [];
    const protect = new Set([...AGENT_TEAM_TOOLS, ...(Array.isArray(restrictProtect) ? restrictProtect : [])]);
    const hit = (n) => only.some((p) => (p.endsWith('*')
      ? n.startsWith(p.slice(0, -1))
      : p.startsWith('*') ? n.endsWith(p.slice(1)) : n === p));

    const deny = [...restrictable].filter((n) => typeof n === 'string'
      && isMcpTool(n) && readOnlyDecision(n) !== null
      && !protect.has(n)
      && (only.length === 0 || hit(n)));

    if (deny.length === 0) {
      appendEvent({ event: 'hard-mask-skip', agent: agent?.id, role, reason: 'deny-empty', restrictable: restrictable.size });
      return { disposer: null, denied: [] };
    }
    try {
      const disposer = actx.tools.restrict({ deny });
      appendEvent({ event: 'hard-mask-applied', agent: agent?.id, role,
        restrictable: restrictable.size, count: deny.length, denyNames: deny.slice(0, 80) });
      log.info(`[role-guard] ${agent?.id}: 硬掩码生效 ${deny.length} 个（可限制集合 ${restrictable.size}）`);
      return { disposer: typeof disposer === 'function' ? disposer : null, denied: deny };
    } catch (e) {
      appendEvent({ event: 'hard-mask-failed', agent: agent?.id, role, count: deny.length, error: String(e?.message ?? e) });
      log.warn(`[role-guard] ${agent?.id}: 硬掩码失败（不影响主闸门）：${e?.message ?? e}`);
      return { disposer: null, denied: [] };
    }
  }

  function applyRestrict(target, label) {
    let names = [];
    try {
      names = (ctx.tools.schemas?.() ?? []).map((s) => s.name);
    } catch { return; }
    let deny = names.filter((n) => isMcpTool(n) && readOnlyDecision(n) !== null);
    const matchedAll = deny.length;

    // ★ 受控实验①：只遮蔽 restrictOnly 名单内（支持前缀通配 `mcp__x__*`）
    const only = Array.isArray(restrictOnly) ? restrictOnly.filter((x) => typeof x === 'string' && x) : [];
    if (only.length > 0) {
      const hit = (n) => only.some((p) => (p.endsWith('*')
        ? n.startsWith(p.slice(0, -1))
        : p.startsWith('*') ? n.endsWith(p.slice(1)) : n === p));
      deny = deny.filter(hit);
    }

    // ★ 受控实验②：团队通道白名单永不被遮（单独开白名单，与分类器无关）
    const protect = new Set([...AGENT_TEAM_TOOLS, ...(Array.isArray(restrictProtect) ? restrictProtect : [])]);
    const protectedHit = deny.filter((n) => protect.has(n));
    deny = deny.filter((n) => !protect.has(n));

    if (deny.length === 0) {
      log.info(`[role-guard] ${label}: 无可遮蔽（分类器命中 ${matchedAll}，restrictOnly=${only.length}，白名单命中 ${protectedHit.length}）`);
      appendEvent({ event: 'restrict-skip', agent: label, matchedAll, only, protectedHit, reason: 'deny-empty' });
      return;
    }
    const missing = deny.filter((n) => !names.includes(n));
    if (missing.length > 0) {
      log.warn(`[role-guard] ${label}: ${missing.length} 个名字未就位，跳过 restrict（guard 仍然生效）`);
      return;
    }
    try {
      target.tools.restrict({ deny });
      log.info(`[role-guard] ${label}: 已 restrict 遮蔽 ${deny.length} 个（分类器命中 ${matchedAll}，restrictOnly=${only.length}，白名单挡下 ${protectedHit.length}）`);
      appendEvent({ event: 'restrict-applied', agent: label, count: deny.length, matchedAll,
        restrictOnly: only, protectedHit, denyNames: deny.slice(0, 80) });
    } catch (e) {
      log.warn(`[role-guard] ${label}: restrict 失败（不影响 guard 主闸门）：${e?.message ?? e}`);
      appendEvent({ event: 'restrict-failed', agent: label, error: String(e?.message ?? e), denyCount: deny.length });
    }
  }

  // ── 可选：按 agent 生效（默认关闭，见 README「为什么默认关」）────────────
  // ⚠ 这条路径是 restrict 的唯一落点：restrict 是 **scope 静态**掩码，
  //    只能在「某个 agent 的 context」上注册，无法按调用者动态判定。
  //
  // ⚠⚠ 铁律：**可选加固层绝不允许拖垮主闸门**。
  //   2026-10-14 实测过一次：本块内一句 `lookupAgents is not defined`
  //   （重构时删了定义、留下调用）导致 apply 抛异常 ⇒ Loader 回滚 guard 注册
  //   ⇒ **角色主闸门整块失效**（而 plugin-start 日志已写，外部看着像"已加载"）。
  //   故整块 try/catch：加固层失败只记错误并跳过，主闸门不受影响。
  // ── A′ 干跑（2026-10-21）：restrict 的两个未知，用**零副作用**方式先答出来 ────
  // 起因：2026-10-21 把 restrictMcpWriteTools 直接开成 true，导致**全部工具** Error: null
  //   （patch 热重载即时生效；见 docs/P1P2-执行记录_2026-10-21.md）。
  // 本块只回答两件事，**不改变任何权限**：
  //   ① 会遮蔽哪些名字？② 作用对象是不是**只有子代理**（父/Lead 必须不在内）？
  // 铁律：**只读 + 只写事件日志**；绝不调用 agent.ctx.* / tools.guard / tools.restrict。
  if (restrictMcpWriteTools === 'dry-run') {
    const previewAgent = (agent) => {
      try {
        let c = null;
        try { c = resolveCaller({ agent }); } catch (e) {
          appendEvent({ event: 'restrict-dry-run', agent: agent?.id, error: String(e?.message ?? e) });
          return;
        }
        const isChild = !!(c?.ancestor && !c?.self);
        const isWriter = !!(c?.self && isWriterName(c.self.name, roleScope.writerNamePatterns));
        const selfRole = c?.self?.role ?? null;
        const selfName = c?.self?.name ?? null;
        // Lead 本人：按 role 或名字判定（两首都算）
        const isLead = selfRole === 'lead' || selfName === 'lead';
        // 窄判据（用户 2026-10-21 指示）：**只对子代理**
        const wouldApplyNarrow = isChild && !isWriter;
        // 宽判据（D5 原意）：**所有非写手、非 Lead 的执行体**（含常驻 reviewer 这类团队成员）
        const wouldApplyBroad = !isWriter && !isLead && (isChild || !!c?.self);
        // ★ 2026-10-21 用户裁定：**作用域取宽**（宁错杀不放过）⟹ 应用判据 = 宽。
        //   窄判据（只子代理）会漏掉常驻 reviewer（团队成员 ⟹ self 命中 ⟹ isChild=false），
        //   而 D5 的原意恰是"只读角色不该能调写工具"。
        const wouldApply = wouldApplyBroad;
        let names = [];
        try { names = (ctx.tools?.schemas?.() ?? []).map((s) => s.name); } catch { names = []; }
        const deny = names.filter((n) => isMcpTool(n) && readOnlyDecision(n) !== null);
        // ★ 2026-10-21：把 deny 逐个**按原因**分类，用于回答"遮蔽面是不是过宽"。
        //   veto    = VETO_EXACT（名字像只读、实际写状态）
        //   write:x = 命中写动词 x（**确定是写/执行**）
        //   unknown = 含未识别 token（fail-closed 判进来的，**很可能误杀只读**）
        const whyOf = (n) => {
          if (VETO_EXACT.has(n)) return 'veto';
          const t = bodyTokens(n);
          const w = t.filter((x) => WRITE_WORDS.has(x));
          if (w.length > 0) return `write:${w.join('+')}`;
          const unknown = t.filter((x) => !READ_WORDS.has(x));
          if (unknown.length > 0) return `unknown:${unknown.join('+')}`;
          return 'read';
        };
        const denyDetailed = deny.map((n) => ({ n, why: whyOf(n) }));
        const byWhy = denyDetailed.reduce((acc, d) => {
          const k = d.why.split(':')[0];
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {});
        appendEvent({
          event: 'restrict-dry-run',
          agent: agent?.id,
          caller: c?.self ? { name: selfName, role: selfRole, via: c.via } : null,
          via: c?.via ?? 'none',
          isChild,
          isWriter,
          isLead,
          wouldApplyNarrow,
          wouldApplyBroad,
          wouldApply,
          totalTools: names.length,
          denyCount: deny.length,
          denyByWhy: byWhy,
          denySample: deny.slice(0, 15),
          denyFull: denyDetailed,
        });
        log.info(`[role-guard] restrict-dry-run: agent=${agent?.id} via=${c?.via}`
          + ` isChild=${isChild} isWriter=${isWriter} isLead=${isLead}`
          + ` ⇒ 窄(只子代理)=${wouldApplyNarrow ? '**会**' : '不会'} 宽(非写手非Lead)=${wouldApplyBroad ? '**会**' : '不会'}`
          + ` 遮蔽 ${deny.length}/${names.length} 个 MCP 写工具`);
      } catch (e) {
        try { appendEvent({ event: 'restrict-dry-run-failed', agent: agent?.id, error: String(e?.message ?? e) }); } catch { /* ignore */ }
      }
    };
    try {
      ctx.on('agent/created', ({ agent }) => previewAgent(agent));
      let reg;
      try { reg = ctx.get?.('agents') ?? undefined; } catch { reg = undefined; }
      for (const a of reg?.list?.() ?? []) previewAgent(a);
      log.info('[role-guard] restrict 干跑已挂：**不改变任何权限**，只写 guard-events.jsonl 的 restrict-dry-run 行');
    } catch (e) {
      log.warn(`[role-guard] 干跑安装失败（不影响主闸门）：${e?.message ?? e}`);
    }
  }

  if (agentScope.enabled) {
   try {
    const attached = new Map();
    // ★ 方案 B 生命周期状态（必须在 installOne 之前声明，否则 TDZ）
    const masked = new Map();
    const rememberMask = (agent, disposer, denied) => {
      if (typeof disposer !== 'function') return;
      const cur = masked.get(agent) ?? { disposers: [], denied: new Set() };
      cur.disposers.push(disposer);
      for (const n of denied ?? []) cur.denied.add(n);
      masked.set(agent, cur);
    };
    const releaseMask = (agent, why) => {
      const cur = masked.get(agent);
      if (!cur) return;
      masked.delete(agent);
      for (const d of cur.disposers.reverse()) {
        try { d(); } catch (e) {
          log.warn(`[role-guard] 撤销 ${agent?.id} 的掩码失败：${e?.message ?? e}`);
        }
      }
      appendEvent({ event: 'hard-mask-released', agent: agent?.id, reason: why, count: cur.disposers.length });
    };
    /** 就地做能力探测：优先全局 `ctx.tools.view`，回退 `agent.ctx.tools.view`；都没有返回 null（绝不退回 schemas） */
    const restrictableOf = (agent) => {
      const probe = (t) => {
        try {
          if (typeof t?.view !== 'function') return null;
          const v = t.view(agent);
          return v && v.restrictableNames instanceof Set ? v.restrictableNames : null;
        } catch { return null; }
      };
      return probe(ctx?.tools) ?? probe(agent?.ctx?.tools) ?? null;
    };

    /** `restrictOnly` 过滤（空数组 = 不过滤）；与 applyHardMask 共用同一套语义 */
    const passesOnly = (n) => {
      const only = Array.isArray(restrictOnly) ? restrictOnly.filter((x) => typeof x === 'string' && x) : [];
      if (only.length === 0) return true;
      return only.some((p) => (p.endsWith('*')
        ? n.startsWith(p.slice(0, -1))
        : p.startsWith('*') ? n.endsWith(p.slice(1)) : n === p));
    };
    const lookupAgents = () => {
      try { return ctx.get?.('agents') ?? undefined; } catch { return undefined; }
    };

    /**
     * 解析该 agent 的角色。返回 'writer'（不装）/ 'readonly'（装）/ undefined（不管）。
     * 口径与 `resolveRoleVerdict` **必须一致**（否则两处会漂移）：
     *   · 只有**该 agent 本人是写手成员**才算 writer；
     *   · 写手派生出来的子 agent 是**协助/审查** ⇒ readonly ⇒ 要装边界（写不可委派）。
     */
    const resolveRole = (agent) => {
      if (agentScope.agentIds.includes(agent.id)) return agentScope.role;
      const c = resolveCaller({ agent });
      const svc = teamService();
      // 关键未知：创建期能不能查到身份？（时序竞态）——这里留痕，便于事后核对
      appendEvent({ event: 'agent-created', agent: agent.id,
        teamServiceAvailable: svc !== undefined,
        self: c.self ? { name: c.self.name, role: c.self.role } : null,
        ancestor: c.ancestor ? { name: c.ancestor.name, role: c.ancestor.role } : null,
        via: c.via,
        resolvedBy: c.self ? 'self' : (c.ancestor ? 'ancestor' : (svc ? 'none' : 'service-missing')) });
      // ★ 2026-10-21（用户裁定「宽、宁错杀」）：**Lead 一律不装**。
      //   宽 = 非写手 + 非 Lead。父代理被自己的能力层锁死是最坏情形
      //   （2026-10-21 的 A 事故就是把 restrict 开到了 Lead 身上，全工具 Error: null）。
      if (c.self && (c.self.role === 'lead' || c.self.name === 'lead')) return undefined;
      // 本人是写手 ⇒ 不装（唯一放行写权限的情形）
      if (c.self && isWriterName(c.self.name, roleScope.writerNamePatterns)) return 'writer';
      // 本人是成员但非写手 ⇒ readonly
      if (c.self) return 'readonly';
      // 有祖先（写手的子 agent 也算）⇒ readonly（写不可委派）
      if (c.ancestor) return 'readonly';
      return undefined;
    };

    const installOne = (agent) => {
      if (attached.has(agent)) return;
      const role = resolveRole(agent);
      if (role === undefined || role === 'writer') return;
      // ⚠ 防御：`Agent` 的公开类型只有 `{ id }`；`agent.ctx` 是「官方指引里的写法」，
      //   本次实测尚未证实它在运行期一定存在。**缺了只跳过，绝不抛**——
      //   抛出去会让整个插件加载失败、连主闸门一起被回滚（已踩过一次）。
      const actx = agent?.ctx;
      const hardMode = restrictMcpWriteTools === 'hard';
      const legacyGuardMode = !hardMode && restrictMcpWriteTools !== 'waterfall';
      const ctxOk = !!actx && typeof actx.effect === 'function'
        && (hardMode ? typeof actx?.tools?.restrict === 'function' : true)
        && (!legacyGuardMode || typeof actx?.tools?.guard === 'function');
      if (!ctxOk) {
        log.warn(`[role-guard] agent ${agent.id} 的 agent.ctx 不满足 ${restrictMcpWriteTools} 所需能力（role=${role}）⇒ 跳过；`
          + '主闸门（roleScope 调用时判定）不受影响');
        appendEvent({ event: 'agent-scope-skip', agent: agent.id, role, reason: 'no-agent-ctx', mode: String(restrictMcpWriteTools) });
        return;
      }
      // 官方指引原文：用「一个」agent.ctx.effect() 包住全部注册，并把 disposer 存起来。
      // 注意：不要写成 ctx.effect(() => agent.ctx.effect(...)) —— 内层会被外层立刻消费掉。
      const dispose = ctx.effect(() => actx.effect(function* () {
        // ★★ 2026-10-21 实证修正：**per-agent `actx.tools.guard()` 才是拖垮非 MCP 管线的元凶**。
        //   证据链：全量 restrict / 1 条 restrict / **只挂 waterfall 且完全不调 restrict** 三种模式，
        //   该 agent 的 `read`/`write`/`send_message`/`list_agents`/`team_task_list` 都是 **5/5 `Error: null`**；
        //   三者唯一共同项 = 这一句 per-agent guard（`restrict` 已被 waterfall 模式排除）。
        //   与 `role-guard/README.md:358`「per-agent 注册路径刻意不用（时序竞态 / 卸载坑 / 热路径故障面）」一致。
        //   ⟹ `'waterfall'` 模式**不装 per-agent guard**；判定仍由全局 `roleScope` 承担（它一直有效）。
        if (restrictMcpWriteTools !== 'waterfall' && restrictMcpWriteTools !== 'hard') {
          yield actx.tools.guard((exec) => readOnlyDecision(exec?.name));
        }
        // ★ 2026-10-21 修不一致：原来写 `if (restrictMcpWriteTools)`，而 `'dry-run'` 也是 truthy
        //   ⟹ 干跑模式下**也会真的调 restrict**（与"干跑不改变权限"的约定矛盾）。
        //   收紧为**只对字面 true** 生效 ⟹ 于是 `agentScope: true` + `restrictMcpWriteTools: 'dry-run'`
        //   就成了"只装 per-agent guard、不调 restrict"的天然实验条件。
        if (restrictMcpWriteTools === 'hard') {
          // ★ 方案 B：硬掩码只对**继承层**生效；不装 per-agent guard（2026-10-21 实证是它拖垮管线）
          // ★ 所有权单一：disposer **只**进 `masked`，由 `agent/disposed` 与插件卸载各走一次 releaseMask；
          //   绝不 yield 给 effect —— 否则同一 disposer 会被两条路径各调一次（审查发现 HIGH#3）。
          const r = applyHardMask(actx, agent, role);
          if (r && typeof r.disposer === 'function') rememberMask(agent, r.disposer, r.denied);
        } else if (restrictMcpWriteTools === true) {
          // 在 agent scope 内调用 ⇒ 只影响该 agent
          yield (() => applyRestrict(actx, `agent ${agent.id}`))();
        } else if (restrictMcpWriteTools === 'waterfall') {
          // ★ 只挂 assemble 过滤，**绝不调 restrict**（restrict 会拖垮非 MCP 管线，2026-10-21 实测）
          yield actx.on('system-prompt/assemble', makeAssembleFilter(agent.id, role));
          appendEvent({ event: 'assemble-filter-installed', agent: agent.id, role });
        } else if (restrictMcpWriteTools === 'dry-run') {
          appendEvent({ event: 'agent-scope-guard-only', agent: agent.id, role });
        }
      }));
      attached.set(agent, dispose);
      log.info(`[role-guard] 已为 agent ${agent.id} 安装只读边界（role=${role}，restrict=${restrictMcpWriteTools}）`);
    };

    ctx.on('agent/created', ({ agent }) => installOne(agent));
    // ★ 方案 B 生命周期（对齐上游 commit 6908b27）：
    //   ① 掩码是**快照** ⟹ 监听 `tools/change` **追加**晚注册写工具的兜底掩码，但**绝不重建**已有掩码；
    //   ② 切 preset 不重发 `agent/created` ⟹ 监听 `agent-preset/selected` 先撤旧再重施加（限制取交集，不撤旧无法放宽）；
    //   ③ 插件卸载时释放全部存活掩码，避免"插件没了、掩码还在"。
    ctx.effect(() => () => {
      for (const agent of [...masked.keys()]) releaseMask(agent, 'plugin-dispose');
    });

    // ★ 重入保护（审查 HIGH#2）：`restrict()` 可能**同步**触发 `tools/change`，
    //   没有这个标志会无穷递归。上游同款 `updating` 标志。
    let updating = false;
    ctx.on('tools/change', () => {
      if (updating) return;
      updating = true;
      try {
        for (const agent of [...masked.keys()]) {
          try {
            const cur = masked.get(agent);
            const restrictable = restrictableOf(agent);
            if (!(restrictable instanceof Set)) continue;
            const protect = new Set([...AGENT_TEAM_TOOLS, ...(Array.isArray(restrictProtect) ? restrictProtect : [])]);
            const added = [...restrictable].filter((n) => typeof n === 'string'
              && isMcpTool(n) && readOnlyDecision(n) !== null
              && !protect.has(n) && !cur.denied.has(n) && passesOnly(n));
            if (added.length === 0) continue;
            const disposer = agent.ctx.tools.restrict({ deny: added });
            for (const n of added) cur.denied.add(n);
            if (typeof disposer === 'function') cur.disposers.push(disposer);
            appendEvent({ event: 'hard-mask-appended', agent: agent?.id, count: added.length, denyNames: added.slice(0, 80) });
          } catch (e) {
            const msg = String(e?.message ?? e);
            // ★ 自愈（2026-10-21）：`cannot create effect on inactive context` = 该 agent 的 ctx 已失活。
            //   历史症状：同一 agent 在同一时刻**反复**失败 12 次 —— 原来只记日志、没摘僵尸 entry。
            //   处理：直接摘掉（**不调 disposer**：context 已失活，掩码随它消失，再调可能二次抛）。
            if (/inactive context/i.test(msg)) {
              masked.delete(agent);
              appendEvent({ event: 'hard-mask-dropped', agent: agent?.id, reason: 'inactive-context' });
            } else {
              appendEvent({ event: 'hard-mask-append-failed', agent: agent?.id, error: msg });
            }
          }
        }
      } finally {
        updating = false;
      }
    });

    ctx.on('agent-preset/selected', (sessionId) => {
      try {
        const agents = ctx.get?.('agents');
        let agent;
        if (typeof agents?.get === 'function') agent = agents.get(sessionId);
        else if (typeof agents?.list === 'function') agent = (agents.list() || []).find((a) => a && a.id === sessionId);
        if (!agent) return;
        releaseMask(agent, 'preset-switch');
        const role = resolveRole(agent);
        if (role !== 'readonly') return;
        const r = applyHardMask(agent.ctx, agent, role);
        if (r && typeof r.disposer === 'function') rememberMask(agent, r.disposer, r.denied);
      } catch (e) {
        appendEvent({ event: 'hard-mask-preset-failed', error: String(e?.message ?? e) });
      }
    });
    // ★ 方案 B：硬掩码的 disposer 归本插件所有 —— Agent 销毁时必须释放，
    //   否则配置重载/成员下线会在存活 scope 上留下旧掩码（上游同款处理）。
    ctx.on('agent/disposed', ({ agent }) => {
      // ★ 掩码 disposer 的**唯一释放点**之一：先把 masked 里的全部释放并删记录，
      //   再销毁 effect（effect 内已不再持有 restrict disposer，不会重复调用）。
      releaseMask(agent, 'agent-disposed');
      const dispose = attached.get(agent);
      if (typeof dispose === 'function') {
        try { dispose(); } catch { /* 释放失败不阻塞销毁 */ }
        attached.delete(agent);
      }
    });
    // 插件挂载前已存在的 agent：从 agents 服务枚举补装
    const agents = lookupAgents();
    for (const a of agents?.list?.() ?? []) installOne(a);
   } catch (e) {
     // 加固层失败不得影响主闸门：只记错并继续
     log.error(`[role-guard] agentScope 加固层初始化失败（**主闸门不受影响**）：${e?.message ?? e}`);
     appendEvent({ event: 'agent-scope-failed', error: String(e?.message ?? e) });
   }
  }
}
