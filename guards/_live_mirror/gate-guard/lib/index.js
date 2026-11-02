/**
 * guards/gate-guard/lib/index.js —— R3b「上板门」。
 *
 * ## 它是什么
 *
 * 在宿主 `tools/pre-execute` 上挂一道**窄**门：**烧板 / 位流 / 固化**类 MCP 工具，
 * 在缺少**新鲜 gate 收口证据**时分级处置：
 *
 * | 证据状态 | 动作 | 判据 |
 * |---|---|---|
 * | 无收口证据 | **`ask`** | 卡上写明「无 gate 证据」与期望证据路径 |
 * | 有证据但 FAIL / 漂移 | **`deny`** | 红证据 / 哈希漂移不得推进烧板 |
 * | 有证据且 PASS 且新鲜 | **放行** | `next()`（**不是** `{kind:'allow'}`，见下） |
 *
 * ## 两条由 P0 实测（不是猜）决定的硬约束
 *
 * 1. **允许继续时必须调用 `next()`，不能返回 `{kind:'allow'}` 覆盖链。**
 *    P0 实测（`gate/_recon/PRESECUTE-PROBE.md` §3，真实 cordis 4.0.4 执行）：
 *    waterfall 里**不调用 `next()` 会否决链上其余 listener，连内置默认行为也不跑**。
 *    所以 `{kind:'allow'}` 不是"放行"，而是**静默覆盖别人的更严判定**。
 * 2. **插件任何异常都会把工具堵死**：cordis 里 handler 抛异常 ⟹ promise reject；
 *    而 `dsh-tools` 把它 catch 成 `toolErrorResult`（P0 §2.1/§3.1）⟹ 工具**不被派发**。
 *    返回 `undefined`（忘写 next）同样堵死；永不 settle 则**卡死**。
 *    R012：仅判定逻辑进入 try/catch；内部异常返回 deny，不调用 next。
 *    下游 next 在 try/catch 之外执行，异常原样传播，禁止重试派发。
 *
 * ## 它**不是**什么
 *
 * 它**不防伪造**（证据 JSON 无签名，可被造到自洽）、**不拦手写收口行**、**不是安全边界**。
 * 它只让"按规矩上板"成为最省事的路。边界与 R3a 的 `close.mjs` 同口径，见 `gate/SPEC.md` §3.9。
 *
 * ## 为什么自实现哈希/钉住校验，而不 import `gate/close.mjs`
 *
 * `gate/close.mjs` 文件末尾是 `process.exitCode = main();`（顶层调用）⟹ **import 它会直接执行 CLI**。
 * 而 R3b 授权书 §6 禁止改 R1–R3a 的冻结件，所以我不能在 close.mjs 上加 `import.meta` 守卫。
 * ⟹ 本文件**自包含**地实现同一族校验，并靠 `gate/scripts/canary-gateguard.mjs` 里的
 * **一致性 canary**（对同一夹具分别问插件与 close.mjs，断言两者结论一致）来防两份实现漂移。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// ★ 2026-10-21 P2/D4：产物探针（数值优先 + 强制正负 fixture），见 probes.js
import { compileProbes, runProbes } from './probes.js';

export const name = 'dsh-gate-guard';
export const inject = ['tools'];

/** 非保护类摩擦开关：保护类忽略 OFF，不能关闭拒绝与 burn gate。 */
export const OFF_ENV = 'GATEGUARD_OFF';

/**
 * ★ 拦截面（**窄**，逐条列出并给理由）。
 *
 * 入选判据：**它会改变硬件状态或产出可被烧录的位流** —— 即"上板"这条路径上的动作。
 * 依据：`.cache/dsh-guard/mcp-tools.txt`（850 行真实工具名）里按 program/flash/bitstream/erase 筛出后**逐条人工判**。
 *
 * **明确排除**（读/查类，虽然名字命中关键词）：
 *   `mcp__fpga-mcp__viv_list_flash_parts`（列型号）、`mcp__fpga-mcp__viv_readback_flash`（回读）、
 *   `mcp__fpga-mcp__viv_verify_flash`（校验）、`mcp__vivado__check_bitstream_readiness`（纯检查）。
 * **明确排除**（准备类，不改变硬件，且属"配置本次烧写会话"）：`viv_add_flash_config`、
 *   `viv_set_flash_property`、`viv_set_hw_device_program_file`、`q_load_package_programmer`。
 *   ⟹ 这四条是**有意的窄边界**，它们在 REDTEAM-NOTES 里作为"前置步骤可被滥用"列出。
 */
export const BURN_TOOLS = Object.freeze([
  // Vivado（本工作区 profile 里的两个 MCP 服务器之一）
  'mcp__vivado__program_device',            // 直接烧 FPGA
  'mcp__vivado__generate_bitstream',        // 生成位流（产物即上板物）
  // fpga-mcp：Vivado 后端
  'mcp__fpga-mcp__program_device',
  'mcp__fpga-mcp__generate_bitstream',
  'mcp__fpga-mcp__viv_program_flash',       // 固化到 flash（掉电不丢，最危险）
  'mcp__fpga-mcp__viv_program_hw_device',   // 烧器件
  'mcp__fpga-mcp__viv_erase_flash',         // 擦 flash（破坏性）
  'mcp__fpga-mcp__viv_write_bitstream',     // 位流落盘
  'mcp__fpga-mcp__viv_write_bitstream_with_ltx',
  'mcp__fpga-mcp__viv_xsct_download_bitstream', // 下载位流到板
  // fpga-mcp：Quartus 后端
  'mcp__fpga-mcp__q_program_device_pgm',
  'mcp__fpga-mcp__q_run_quartus_pgm',     // R012/R1 补：quartus_pgm 直跑（原名单外）
  // fpga-mcp：TangDynasty 后端
  'mcp__fpga-mcp__a_program_device',
  'mcp__fpga-mcp__a_generate_bitstream',
]);

/**
 * "看着像烧板但不在名单里" —— **只记日志、永不拦截**。
 * 目的：让"名单需要扩充"这件事在日志里**可见**，而不是靠记得去改代码。
 * （明示：它**不是**第二道防线，不参与判定。）
 */
export const WATCH_RE = /program|flash|bitstream|cfgmem|erase/i;

export function isBurnTool(toolName) {
  return typeof toolName === 'string' && BURN_TOOLS.includes(toolName);
}

export function sha256(absPath, n = 64) {
  try { return createHash('sha256').update(readFileSync(absPath)).digest('hex').slice(0, n); } catch { return null; }
}

/**
 * **新鲜度**（TASK.4 §3.2 要求"写成函数并自测"）。
 *
 * 定义：证据生成时间**严格晚于**每一个被验产物 mtime。
 *   · `evidenceMs` 缺失或不可解析 ⟹ **不新鲜**（fail-closed，不是 fail-open）；
 *   · **没有任何产物可比 ⟹ 不新鲜**（R4.2 修，见下）；
 *   · 有产物但 mtime 晚于（或等于）证据 ⟹ **不新鲜**。
 *
 * ★ R4.2 修的洞（红队 F3 + Lead 第一手复现）：
 *   旧版对 `artifactTimes = []` **返回 true**，也就是**没有任何时间上界** ——
 *   Lead 实测 `isFresh(now+1h, []) === true` **且** `isFresh(now−1h, []) === true`
 *   ⇒ **陈年证据也算"新鲜"**。根因不是这个函数算错，而是**"新鲜"没有与「本次要烧的产物」绑定**：
 *   比较对象一消失，它就退化成"只看证据自报的时间"，而那个时间戳也是自报的。
 *   现在：**空产物列表一律判不新鲜**（fail-closed）；分类器还会更早给出 `ask` 与人读理由。
 */
export function isFresh(evidenceMs, artifactTimes) {
  if (!Number.isFinite(evidenceMs)) return false;
  // ★ 无产物可比 ⇒ 判**不新鲜**：没有时间上界的"新鲜"不是新鲜
  if (!Array.isArray(artifactTimes) || artifactTimes.length === 0) return false;
  for (const t of artifactTimes) {
    if (!Number.isFinite(t)) return false;   // 产物 mtime 不可用 ⇒ 同样 fail-closed
    if (!(evidenceMs > t)) return false;     // 严格晚于
  }
  return true;
}

/** 只保留**存在**的候选（保留旧名以免破坏既有调用；新代码请用 `findArtifactCandidates`）。 */
export function findArtifacts(args, root) {
  return findArtifactCandidates(args, root).filter((c) => c.exists).map((c) => c.abs);
}

/**
 * 探一个候选路径的**真实身份**（R4.3）。
 *
 * WHY：红队第 2 轮 —— 旧版只做"扩展名 + `existsSync`"，于是**目录 / 空文件 / symlink / junction**
 * 只要名字带白名单扩展名就能进 `existing`，再 `statSync` 取 mtime ⇒ 时间新鲜即 `pass`。
 * 所以这里**先 `lstat` 后 `stat`**：
 *   · `lstat` 不跟随链接 ⇒ 链接/junction 能被识别出来（Windows 的 junction 在 Node 下同样报 symlink）；
 *   · 只有"非链接的普通文件"才继续看大小。
 *
 * @returns {{exists:boolean, kind:'missing'|'symlink'|'file'|'dir'|'other', size:number|null}}
 */
export function probeCandidate(abs) {
  let lst = null;
  try { lst = lstatSync(abs); } catch { lst = null; }
  if (lst === null) return { exists: false, kind: 'missing', size: null };
  if (typeof lst.isSymbolicLink === 'function' && lst.isSymbolicLink()) {
    return { exists: true, kind: 'symlink', size: null };
  }
  let st = lst;
  try { st = statSync(abs); } catch { st = lst; }
  if (typeof st.isFile === 'function' && st.isFile()) {
    return { exists: true, kind: 'file', size: typeof st.size === 'number' ? st.size : null };
  }
  if (typeof st.isDirectory === 'function' && st.isDirectory()) {
    return { exists: true, kind: 'dir', size: null };
  }
  return { exists: true, kind: 'other', size: null };
}

/**
 * 找出参数里"**看起来是烧写产物**"的候选 —— **不过滤存在性**（R4.2），**并带上类型探针**（R4.3）。
 *
 * WHY 必须留着"不存在"的候选：红队 **F2b** 实测 —— 参数里点名一个**不存在**的 `absent.bit` 时，
 * 旧版按 `existsSync` 把它**丢掉**，于是产物列表变空、新鲜度失去比较对象，**照样 `pass`**
 * （Lead 复现原话："**产物路径被完全忽略**"，比原报告更糟）。
 * 现在候选**一律保留**，由分类器逐条判定。
 *
 * 注：**递归进嵌套对象是预期支持，不是漏洞**（红队第 2 轮主动澄清）。
 */
export function findArtifactCandidates(args, root) {
  const out = [];
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (/\.(bit|bin|mcs|sof|ltx)$/i.test(v)) {
        const abs = isAbsolute(v) ? v : resolve(root, v);
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push({ raw: v, abs, ...probeCandidate(abs) });
        }
      }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') { for (const x of Object.values(v)) walk(x); }
  };
  walk(args);
  return out;
}

/** 解析一份 close 块（`gate/evidence/close-*.md`）。 */
export function parseClosure(text) {
  const evidence = (text.match(/^evidence:\s*(\S+)\s*$/m) || [])[1] || null;
  const closeLine = (text.match(/^CLOSE:\s*(\S+)\s+accepted\s+(\S+)/m) || null);
  const gateLine = (text.split(/\r?\n/).find((l) => /^GATE\s/.test(l.trim())) || '').trim();
  const targetLine = (text.match(/^TARGET_PART:\s*(\S+)\s*$/m) || [])[1] || null;
  const artifactLine = (text.match(/^ARTIFACT_SHA256:\s*([0-9a-f]{64})\s*$/mi) || [])[1] || null;
  if (!evidence || !closeLine) return null;
  const gateOk = /\sPASS\s/.test(gateLine);
  return {
    evidencePath: evidence.replace(/\\/g, '/'),
    taskId: closeLine[1], targetPart: targetLine, artifactSha256: artifactLine,
    acceptedAt: closeLine[2], acceptedMs: Date.parse(closeLine[2]),
    gateOk, gateLine,
  };
}

/** 列出候选收口块（按 CLOSE 时间倒序）。 */
export function listClosures(root, evidenceDir) {
  const dir = isAbsolute(evidenceDir) ? evidenceDir : resolve(root, evidenceDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!/^close-.*\.md$/.test(f)) continue;
    try {
      const c = parseClosure(readFileSync(join(dir, f), 'utf8'));
      if (c) out.push({ ...c, file: join(dir, f), rel: relOf(root, join(dir, f)) });
    } catch { /* 单份读坏不影响其余 */ }
  }
  return out.sort((a, b) => (b.acceptedMs || 0) - (a.acceptedMs || 0));
}

const relOf = (root, p) => p.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/');

/**
 * 校验一份证据的 `pins` + 断言级文件哈希是否**未漂移**。
 * 与 `gate/close.mjs#verifyPins` 同族（但自包含，理由见文件头）。
 * 返回 `{ ok, drifted: [{path, why}] }`。
 */
export function verifyPinsNoDrift(evidence, root) {
  const rows = [];
  const add = (p, why) => { if (p && p.path) rows.push({ path: p.path, expected: p.sha256, why }); };
  const pins = evidence.pins || {};
  add(pins.descriptor, '描述符');
  for (const m of pins.machinery || []) add(m, '判据机器');
  for (const d of pins.declared || []) add(d, 'hashFiles 声明');
  for (const e of evidence.evaluated || []) for (const f of e.files || []) add(f, `断言 ${e.id} 点名文件`);

  const seen = new Map();
  for (const r of rows) if (!seen.has(r.path)) seen.set(r.path, r);

  const drifted = [];
  for (const r of seen.values()) {
    const abs = isAbsolute(r.path) ? r.path : resolve(root, r.path);
    const exists = existsSync(abs);
    const exp = r.expected;
    if (!exp || String(exp).startsWith('UNAVAILABLE')) {
      // R6：缺失/UNAVAILABLE 哈希绝不降级为存在性通过。
      drifted.push({ path: r.path, why: `${r.why}：缺失或 UNAVAILABLE 哈希` });
      continue;
    }
    if (!exists) { drifted.push({ path: r.path, why: `${r.why}：期望有哈希但文件已不存在` }); continue; }
    const act = sha256(abs, String(exp).length);
    if (act === null) { drifted.push({ path: r.path, why: `${r.why}：重算失败（fail-closed）` }); continue; }
    if (act !== exp) drifted.push({ path: r.path, why: `${r.why}：哈希不符` });
  }
  return { ok: drifted.length === 0, drifted, checked: seen.size };
}

/**
 * **判定核心**（纯函数，便于离线自测与 canary 断言确切返回值）。
 *
 * @returns {{action:'pass'|'ask'|'deny', reason:string, basis:string, evidencePath:string|null}}
 */
function classifyBurnCallInner({ toolName, args, root, evidenceDir = 'gate/evidence', nowMs = Date.now(),
  probes = [], allowMultipleArtifacts = false, probeLog = null }) {
  if (!isBurnTool(toolName)) {
    return { action: 'pass', reason: '', basis: '不在拦截面（窄名单）内', evidencePath: null };
  }
  // ★ R4.2：**保留不存在的候选**，以便区分"没点名 / 点名但不存在 / 存在"三种情形。
  // ★ R4.3：候选**带类型探针**（`probeCandidate`），"有效产物"= 存在 ∧ 非链接 ∧ 普通文件 ∧ 非空。
  const candidates = findArtifactCandidates(args, root);
  const validFiles = candidates.filter(
    (c) => c.exists && c.kind === 'file' && typeof c.size === 'number' && c.size > 0,
  );
  const callTaskId = args && typeof args.taskId === 'string' ? args.taskId : null;
  const callTargetPart = args && typeof args.targetPart === 'string' ? args.targetPart : null;
  const callArtifactSha256 = args && typeof args.artifactSha256 === 'string' ? args.artifactSha256.toLowerCase() : null;
  const artifactTimes = validFiles
    .map((c) => { try { return statSync(c.abs).mtimeMs; } catch { return null; } })
    .filter((x) => x !== null);

  const closures = listClosures(root, evidenceDir);
  if (closures.length === 0) {
    return {
      action: 'ask',
      reason: `无 gate 证据：${toolName} 属烧板/位流类。期望先有一份**收口**证据（gate/evidence/close-*.md，由 gate/close.mjs 产出）。`,
      basis: 'evidenceDir 下没有任何 close-*.md',
      evidencePath: null,
    };
  }
  const newest = closures[0];
  const evAbs = isAbsolute(newest.evidencePath) ? newest.evidencePath : resolve(root, newest.evidencePath);
  if (!existsSync(evAbs)) {
    return {
      action: 'deny',
      reason: `收口块引用的证据不存在：${newest.evidencePath}（收口块 ${newest.rel}）⟹ 红证据`,
      basis: 'closure 引用的证据文件缺失',
      evidencePath: newest.evidencePath,
    };
  }
  let evidence;
  try { evidence = JSON.parse(readFileSync(evAbs, 'utf8')); } catch (err) {
    return { action: 'deny', reason: `证据无法解析：${newest.evidencePath}（${err.message}）`, basis: '证据 JSON 解析失败', evidencePath: newest.evidencePath };
  }
  const evidenceArtifactHash = typeof evidence.artifactSha256 === 'string' ? evidence.artifactSha256.toLowerCase() : null;
  const expectedBinding = callTaskId && callTargetPart && /^[0-9a-f]{64}$/.test(callArtifactSha256 || '')
    && newest.taskId && newest.targetPart && newest.artifactSha256;
  if (!expectedBinding || newest.taskId !== callTaskId || newest.targetPart !== callTargetPart
      || newest.artifactSha256.toLowerCase() !== callArtifactSha256 || evidence.taskId !== callTaskId
      || evidence.targetPart !== callTargetPart || evidenceArtifactHash !== callArtifactSha256) {
    return { action: 'deny', reason: 'R3 绑定缺失或不相等：taskId/targetPart/artifactSha256 必须在调用、closure、evidence 三处逐项匹配', basis: 'R3 binding mismatch', evidencePath: newest.evidencePath };
  }
  if (evidence.taskState?.gateOk !== true || (evidence.taskState?.counts?.PASS ?? 0) === 0) {
    return {
      action: 'deny',
      reason: `红证据：${newest.evidencePath} 的 gateOk=${JSON.stringify(evidence.taskState?.gateOk)}、PASS=${evidence.taskState?.counts?.PASS ?? 0} ⟹ 不得推进烧板`,
      basis: '最新收口引用的证据不是 PASS',
      evidencePath: newest.evidencePath,
    };
  }
  const currentMs = Date.now();
  if (!Number.isFinite(newest.acceptedMs) || newest.acceptedMs > currentMs) {
    return { action: 'deny', reason: 'R4 收口时间缺失或晚于当前时间', basis: 'future/invalid closure timestamp', evidencePath: newest.evidencePath };
  }
  const evidenceMs = Date.parse(evidence.finishedAt || evidence.startedAt || '');
  if (!Number.isFinite(evidenceMs) || evidenceMs > currentMs) {
    return { action: 'deny', reason: 'R4 evidence finishedAt/startedAt 缺失或晚于当前时间', basis: 'future/invalid evidence timestamp', evidencePath: newest.evidencePath };
  }
  if (!evidence.pins || typeof evidence.pins !== 'object' || Object.keys(evidence.pins).length === 0
      || !Array.isArray(evidence.evaluated) || evidence.evaluated.length === 0) {
    return { action: 'deny', reason: 'R6 pins/evaluated 必须非空', basis: 'empty pins/evaluated', evidencePath: newest.evidencePath };
  }
  const pin = verifyPinsNoDrift(evidence, root);
  if (!pin.ok || pin.checked === 0) {
    return {
      action: 'deny',
      reason: `证据漂移：${pin.drifted.length}/${pin.checked} 个 pin 与当前文件不符（首个：${pin.drifted[0].path} —— ${pin.drifted[0].why}）⟹ 收口后文件被改，证据作废`,
      basis: 'pin 哈希漂移',
      evidencePath: newest.evidencePath,
    };
  }
  // ---------------------------------------------------------------------------
  // ★ R4.2 的核心修复：**"新鲜"必须与「本次要烧的产物」绑定**
  //
  // 红队 F2 / F2b / F3 是**同一条根因**：产物列表为空时，新鲜度失去比较对象，
  // 于是退化成"只看证据自报的时间"，而那个时间戳本身也是自报的。
  //   · F2  —— 参数里**根本没点名产物**（如 `generate_bitstream`），拿一份**无关的**
  //            docs 绿证据即可放行（红队实测 + Lead 复现）。
  //   · F2b —— 参数里**点名了产物但文件不存在**（`absent.bit`）；旧版按 existsSync 把它丢掉，
  //           产物列表同样变空 ⇒ **连路径都被完全忽略**（Lead 复现，比原报告更糟）。
  //   · F3  —— 产物为空 ⇒ `isFresh` 没有任何时间上界 ⇒ **陈年证据也算新鲜**。
  //
  // 修法（TASK.5 §1.1）：**绑不上就不放行** —— 一律 `ask`，并把理由写成"本门无法把证据
  // 与本次烧写对象绑定"。**不是**改成 deny：因为"没点名产物"在合法用法里也可能出现
  // （例如生成位流的工具），deny 会把正常流程堵死；`ask` 保留人的判断权。
  //
  // ★ R4.3 再收口（红队第 2 轮）：上面只挡住了"**一个候选都没有**的情况"，
  //   仍然留下三个洞（**Lead 与红队各自实机复现**）：
  //   · **混合候选**：1 个存在 + 1 个不存在 ⇒ 旧版只看 `existing` ⇒ **pass**
  //     （门与调用者对"要烧什么"的理解不一致，而这正是最该交给人确认的情形）；
  //   · **空文件 / 带扩展名的目录**：`existsSync` 不校验类型 ⇒ 冒充产物 ⇒ **pass**；
  //   · **symlink / junction**：`existsSync` 会**跟随链接** ⇒（代码级结论，双方均无实机）。
  //   所以现在改为：**逐条检查每一个候选**，任一有问题就 `ask`，并写明**是哪一条不满足**。
  //   仍然**不做 deny**（合法 setup 也可能用链接/占位，堵死正常流程代价更高）。
  // ---------------------------------------------------------------------------
  const problems = [];
  if (candidates.length === 0) {
    return {
      action: 'ask',
      reason: '本门无法把证据与本次烧写对象绑定：参数里**没有**任何形如 .bit/.bin/.mcs/.sof/.ltx 的产物路径。'
        + '没有产物就无法判断证据是否"新鲜"（旧版在这种情况下会退化成只看证据自报的时间）⟹ 交给人确认。',
      basis: '无产物候选（未点名）',
      evidencePath: newest.evidencePath,
    };
  }
  for (const c of candidates) {
    if (!c.exists) {
      problems.push(`点名的产物**不存在**：${c.raw}`);
    } else if (c.kind === 'symlink') {
      problems.push(`**是符号链接 / junction**（拒绝跟随链接）：${c.raw}`);
    } else if (c.kind === 'dir') {
      problems.push(`**是目录**，不是普通文件：${c.raw}`);
    } else if (c.kind !== 'file') {
      problems.push(`**不是普通文件**（kind=${c.kind}）：${c.raw}`);
    } else if (!(typeof c.size === 'number' && c.size > 0)) {
      problems.push(`**是空文件**（size=${c.size}），不能作为有效产物：${c.raw}`);
    }
  }
  if (problems.length > 0) {
    return {
      action: 'ask',
      reason: `本门无法把证据与本次烧写对象绑定（${problems.length}/${candidates.length} 个候选不合格）：\n`
        + problems.map((p) => `  · ${p}`).join('\n')
        + '\n任一被点名的候选不合格即不放行 —— **不许"只挑存在的那个看"**：'
        + '门与调用者对"要烧什么"的理解不一致时，必须交给人确认。',
      basis: `候选不合格 ${problems.length}/${candidates.length}（混合/类型/空文件/链接）`,
      evidencePath: newest.evidencePath,
    };
  }

  // ★ 2026-10-21（P2）：同扩展名多候选 = 调用者意图不明；先 ask，再做唯一候选 R3 hash。
  //   扩展名不同（.bit + .ltx）是正常配对，不算歧义。
  if (!allowMultipleArtifacts) {
    const byExt = new Map();
    for (const c of validFiles) {
      const ext = c.abs.slice(c.abs.lastIndexOf('.')).toLowerCase();
      byExt.set(ext, [...(byExt.get(ext) || []), c]);
    }
    const dup = [...byExt.entries()].filter(([, v]) => v.length > 1);
    if (dup.length > 0) {
      return {
        action: 'ask',
        reason: `同扩展名候选有 ${dup.length} 组（${dup.map(([e, v]) => `${e}×${v.length}`).join(', ')}）：`
          + dup.flatMap(([, v]) => v.map((c) => `\n  · ${c.raw}`)).join('')
          + '\n本门无法判断要烧哪一份 ⟹ 交给人选（不要"取第一个"或"取最新"）。',
        basis: '同扩展名多候选',
        evidencePath: newest.evidencePath,
      };
    }
  }
  if (candidates.length !== 1 || !callArtifactSha256 || sha256(validFiles[0].abs, 64) !== callArtifactSha256) {
    return { action: 'deny', reason: 'R3 artifactSha256 必须与本次唯一候选的实际内容哈希相等', basis: 'artifact hash mismatch', evidencePath: newest.evidencePath };
  }

  const evMs = Date.parse(evidence.finishedAt || evidence.startedAt || '');
  const closureMs = newest.acceptedMs;
  const freshByEvidence = isFresh(evMs, artifactTimes);
  const freshByClosure = isFresh(closureMs, artifactTimes);
  if (!freshByEvidence || !freshByClosure) {
    return {
      action: 'deny',
      reason: `证据不新鲜：需**晚于**被烧产物 mtime（产物 ${artifactTimes.length} 个）；证据时间=${new Date(evMs).toISOString?.() ?? evMs}、收口时间=${newest.acceptedAt}`,
      basis: '证据/收口时间未晚于产物 mtime',
      evidencePath: newest.evidencePath,
    };
  }
  // R5：burn 必须有至少一条最终启用探针；缺失/编译失败/空列表均拒绝。
  if (!Array.isArray(probes) || probes.length === 0) {
    return { action: 'deny', reason: 'R5 最终启用探针为空或缺失，禁止按无探针 PASS', basis: 'empty enabled probes', evidencePath: newest.evidencePath };
  }
  // ★ 2026-10-21（P2/D4）：产物体检。deny = 有证据表明坏；ask = 没法判断。
  {
    const primary = validFiles.find((c) => !/\.ltx$/i.test(c.abs)) || validFiles[0];
    const results = runProbes(probes, primary.abs, root);
    const bad = results.filter((r) => r.verdict === 'deny');
    const unsure = results.filter((r) => r.verdict === 'ask');
    if (probeLog) probeLog({ action: 'probe', tool: toolName, primary: primary.raw, results });
    if (bad.length > 0) {
      return {
        action: 'deny',
        reason: `产物体检不通过（${bad.length}/${results.length}）：\n`
          + bad.map((r) => `  · ${r.name}: ${r.why}${r.line ? `\n    原文：${r.line}` : ''}`).join('\n'),
        basis: `probe deny: ${bad.map((r) => r.name).join(',')}`,
        evidencePath: newest.evidencePath,
      };
    }
    if (unsure.length > 0) {
      return {
        action: 'ask',
        reason: `产物探针无法判定（${unsure.length}/${results.length}）：\n`
          + unsure.map((r) => `  · ${r.name}: ${r.why}`).join('\n')
          + '\n"没法判断"不等于"通过" ⟹ 交给人确认。',
        basis: `probe ask: ${unsure.map((r) => r.name).join(',')}`,
        evidencePath: newest.evidencePath,
      };
    }
  }

  return {
    action: 'pass',
    reason: '',
    basis: `新鲜 PASS 证据（${newest.evidencePath}；收口于 ${newest.acceptedAt}；pin ${pin.checked} 条无漂移；**已绑定产物 ${artifactTimes.length} 个**（全部为有效普通文件、非空、非链接）：${validFiles.slice(0, 3).map((c) => c.raw).join(', ')}）`,
    evidencePath: newest.evidencePath,
  };
}

/**
 * **产物绑定（F 层，2026-10-21）**：任何判定（pass / ask / deny）都附带 `artifacts[]`，
 * 每项含 `raw` / `abs` / `size` / `mtimeMs` / **`sha256`（64 位，内容哈希）**。
 *
 * WHY 放在外层而不是改造 11 个 return：逐个改必漏；集中绑定才保证"**每条判定都能反查到具体产物内容**"。
 * WHY 必须绑**内容**而不是名字：同名 `.bit` 被重新生成后，只看路径/时间"看起来仍然合法"——
 *   这正是 `s3-r54` 那类漂移能溜过的机制性原因（日志证明不了它判的是哪一版）。
 *
 * 边界：只对**窄名单内的烧板工具**绑定；不在拦截面 ⇒ `artifacts: []`（不误伤、不伪造）。
 * 算不出哈希的候选**不进** artifacts（不伪造）；不存在的候选也不进。
 */
export function classifyBurnCall(input) {
  const verdict = classifyBurnCallInner(input ?? {});
  let artifacts = [];
  if (isBurnTool(input?.toolName)) {
    try {
      const root = input?.root ?? process.cwd();
      artifacts = findArtifactCandidates(input?.args, root)
        .filter((c) => c.exists && c.kind === 'file' && typeof c.size === 'number' && c.size > 0)
        .map((c) => {
          const h = sha256(c.abs, 64);
          let mtimeMs = null;
          try { mtimeMs = statSync(c.abs).mtimeMs; } catch { /* 取不到时间不影响哈希 */ }
          return { raw: c.raw, abs: c.abs, size: c.size, mtimeMs, sha256: h };
        })
        .filter((a) => typeof a.sha256 === 'string' && a.sha256.length === 64);
    } catch { artifacts = []; }
  }
  const out = { ...verdict, artifacts };
  if (typeof out.basis === 'string' && artifacts.length > 0) {
    out.basis += `；产物哈希 ${artifacts.map((a) => a.sha256.slice(0, 12)).join(',')}`;
  }
  return out;
}

/** 每次判定落一行日志（TASK.4 §3.5）。**永不抛**。 */
export function logDecision(logPath, rec) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 日志失败绝不影响判定与放行 */ }
}

export function truthyEnv(v) {
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

// R012 round2：仅两个 FPGA namespace 在本轮能力策略内。
// 显式 readonly 放行；burn 延用原 gate；其余 FPGA（含未知/新别名）默认 deny。
// 注册表仅供审计覆盖统计，是否在注册表内不产生授权。
// 保护类忽略 OFF；内部异常 fail-closed；下游 next 在 catch 之外仅派发一次。
// pwsh 经过 tools/pre-execute，但本轮没有封堵其执行能力，因此 R1 整体 PARTIAL。
// 其他服务器保持原行为；将 FPGA 能力迁往未知服务器别名仍是残余风险。

/**
 * 任意执行入口（R1）——**整体 deny**，不看命令文本、不看参数。
 * 按声明能力保守拒绝（含 catch/source/间接命令）；实际模板实现另审。
 * 部分双花括号模板是否执行未经本轮实证，拒绝不能依赖该实现缺陷。
 * 列表用于审计解释；未知 FPGA 工具仍默认 deny，注册表会员身份不授权。
 */
export const EXEC_TOOLS = Object.freeze([
  'mcp__vivado__run_tcl',                  // 任意 Tcl
  'mcp__vivado__safe_tcl',                 // 任意 Tcl（参数转义）
  'mcp__fpga-mcp__exec_tcl',               // 任意 Tcl
  'mcp__fpga-mcp__viv_exec',               // 系统命令
  'mcp__fpga-mcp__viv_source_tcl',         // source 任意 Tcl 文件
  'mcp__fpga-mcp__viv_xsct_exec',          // XSCT 内执行 shell 命令
  'mcp__fpga-mcp__a_catch',                // cmd 是任意 Tcl，catch 不是隔离
  'mcp__fpga-mcp__viv_catch',              // cmd 是任意 Tcl
  'mcp__fpga-mcp__a_exec',                 // 系统命令
  'mcp__fpga-mcp__a_source',               // source 任意 Tcl 文件
  'mcp__fpga-mcp__q_run_quartus_cdb',      // 跑自定义 Tcl 脚本
  'mcp__fpga-mcp__q_set_sim_tool_args',    // 间接执行：设置任意 EDA 命令
]);

const REGISTRY_FILE = join(dirname(fileURLToPath(import.meta.url)), 'mcp-registry.json');

/** 读冻结的 MCP 注册表快照。读不到 ⇒ `ok:false`（调用侧必须 fail-closed）。 */
export function loadMcpRegistry(file = REGISTRY_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw.tools)) {
      return { ok: false, tools: new Set(), count: 0, sha256: null, why: 'tools 不是数组' };
    }
    return {
      ok: true, tools: new Set(raw.tools), count: raw.tools.length,
      sha256: raw.sourceSha256 ?? null, why: '',
    };
  } catch (err) {
    return { ok: false, tools: new Set(), count: 0, sha256: null, why: err && err.message ? err.message : String(err) };
  }
}

/** 保守的显式只读集合。必须逐项审查后才能添加，名称或注册表会员身份不授权。 */
export const READONLY_TOOLS = Object.freeze([
  'mcp__vivado__get_project_info',
  'mcp__vivado__list_sessions',
  'mcp__fpga-mcp__current_project',
  'mcp__fpga-mcp__get_project_info',
  'mcp__fpga-mcp__list_all_files',
  'mcp__fpga-mcp__list_source_files',
  'mcp__fpga-mcp__list_constraint_files',
  'mcp__fpga-mcp__list_backends',
  'mcp__fpga-mcp__status',
  'mcp__fpga-mcp__viv_get_runs',
  'mcp__fpga-mcp__viv_get_files',
  'mcp__fpga-mcp__viv_get_ips',
  'mcp__fpga-mcp__viv_get_part',
  'mcp__fpga-mcp__viv_get_clocks',
  'mcp__fpga-mcp__viv_get_project_dir',
  'mcp__fpga-mcp__viv_get_synth_status',
  'mcp__fpga-mcp__viv_get_impl_status',
  'mcp__fpga-mcp__q_get_part',
  'mcp__fpga-mcp__q_get_top_entity',
  'mcp__fpga-mcp__q_get_clocks',
  'mcp__fpga-mcp__a_get_part',
  'mcp__fpga-mcp__a_get_top',
  'mcp__fpga-mcp__a_get_files',
]);
export const FPGA_NAMESPACES = Object.freeze(['mcp__fpga-mcp__', 'mcp__vivado__']);
export function classifyToolForGuard(toolName, _inventoryOnly) {
  if (typeof toolName !== 'string' || toolName.trim() === '') return 'invalid-name';
  if (!FPGA_NAMESPACES.some((prefix) => toolName.startsWith(prefix))) return 'flow-nonfpga';
  if (EXEC_TOOLS.includes(toolName)) return 'exec';
  if (isBurnTool(toolName)) return 'burn';
  if (READONLY_TOOLS.includes(toolName)) return 'readonly-fpga';
  return 'denied-fpga';
}
export const PROTECTED_CATEGORIES = Object.freeze(['invalid-name', 'exec', 'burn', 'denied-fpga']);

/**
 * 纯判定：**不调用 `next()`、不 catch 下游**；异常直接抛给调用方（由 apply 的 catch 转 deny）。
 * @returns {{kind:'allow'} | {kind:'deny'|'ask', reason:string, displayReason?:string}}
 */
export function decideGuard(input) {
  const {
    toolName, args, category, registry = { ok: false, tools: new Set(), count: 0 },
    root, evidenceDir, probes, compileErrors = [], allowMultipleArtifacts, probeLog, env = {}, log = () => {},
  } = input;

  if (category === 'invalid-name') {
    log({ action: 'deny', basis: '工具名缺失/非法（fail-closed）' });
    return { kind: 'deny', reason: `上板门：工具名缺失或非法（${typeof toolName}），无法判定调用类别 ⟹ fail-closed 拒绝。` };
  }
  if (category === 'exec') {
    log({ action: 'deny', basis: '任意执行入口（R1 能力层整体拒绝）' });
    return {
      kind: 'deny',
      reason: `上板门：${toolName} 属任意执行入口（Tcl / 系统命令 / 自定义脚本），本门不看命令文本、整体拒绝（R1）。`,
    };
  }
  if (category === 'denied-fpga') {
    log({ action: 'deny', basis: 'FPGA 工具未经显式只读授权，也不属于 burn gate；默认拒绝' });
    return { kind: 'deny', reason: '本轮默认拒绝 FPGA 配置/执行/loader/未知工具：' + toolName + '。注册表会员身份不授予能力。' };
  }
  if (category === 'burn') {
    if (Array.isArray(compileErrors) && compileErrors.length > 0) {
      log({ action: 'deny', basis: `R5 探针编译失败 ${compileErrors.length} 条；任一失败即拒绝` });
      return { kind: 'deny', reason: 'R5 探针编译失败，任一失败即拒绝 burn' };
    }
    const verdict = classifyBurnCall({
      toolName, args, root, evidenceDir, probes, allowMultipleArtifacts, probeLog,
    });
    if (verdict.action === 'deny') {
      log({ action: 'deny', basis: verdict.basis, evidence: verdict.evidencePath, artifacts: verdict.artifacts ?? [] });
      return { kind: 'deny', reason: verdict.reason };
    }
    if (verdict.action === 'ask') {
      log({ action: 'ask', basis: verdict.basis, evidence: verdict.evidencePath, artifacts: verdict.artifacts ?? [] });
      return {
        kind: 'ask',
        reason: verdict.reason,
        displayReason: `上板门：**需人工确认** —— ${toolName}（${verdict.basis}）。`,
      };
    }
    log({ action: 'pass', basis: verdict.basis, evidence: verdict.evidencePath, artifacts: verdict.artifacts ?? [] });
    return { kind: 'allow', artifacts: verdict.artifacts ?? [] };
  }
  // 仅显式只读 FPGA / 范围外工具到达此处；保护类不接受 OFF。
  if (truthyEnv(env[OFF_ENV])) {
    log({ action: 'off', basis: `${OFF_ENV} 置位，非保护类放行` });
    return { kind: 'allow' };
  }
  if (category === 'readonly-fpga') log({ action: 'pass', basis: '显式只读 FPGA 授权' });
  return { kind: 'allow' };
}

/**
 * 插件入口：判定内部异常返回 deny；next 在 catch 之外执行一次，下游异常不重试。
 */
export function apply(ctx, config = {}) {
  const root = config.root || process.cwd();
  const evidenceDir = config.evidenceDir || 'gate/evidence';
  const logPath = config.logPath || join(root, 'gate', 'evidence', 'gateguard-decisions.log');
  const env = config.env || process.env;

  // ★ 2026-10-21（P2）：探针在 apply 期**编译+fork 自测**；自测不过的探针被禁用并**响亮记录**。
  const probeLog = (rec) => logDecision(logPath, { at: new Date().toISOString(), tool: rec.tool || '-', action: rec.action, basis: JSON.stringify(rec) });
  const compiled = compileProbes(config.probes, {
    root,
    log: (kind, detail) => logDecision(logPath, { at: new Date().toISOString(), tool: '-', action: kind, basis: JSON.stringify(detail) }),
  });
  const probes = compiled.probes;
  const allowMultipleArtifacts = config.allowMultipleArtifacts === true;
  if (compiled.errors.length > 0) {
    logDecision(logPath, { at: new Date().toISOString(), tool: '-', action: 'probe-config-error', basis: `共 ${compiled.errors.length} 条探针被禁用` });
  }

  // 注册表仅作离线审计，不授权；不可读不改变编译内显式分类策略。
  const registry = loadMcpRegistry(config.registryFile || REGISTRY_FILE);
  if (!registry.ok) {
    logDecision(logPath, {
      at: new Date().toISOString(), tool: '-', action: 'registry-unavailable',
      basis: `MCP 注册表审计快照不可用，显式 FPGA 策略仍生效：${registry.why}`,
    });
  }
  const record = (tool) => (rec) => logDecision(logPath, { at: new Date().toISOString(), tool: tool ?? '-', ...rec });

  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision;
    let toolName = '-';
    try {
      // ① 取名字/参数与判定：任何一步抛错都进 catch ⇒ deny（R2 fail-closed）
      toolName = exec && exec.name;
      const category = classifyToolForGuard(toolName, registry.tools);
      const args = exec && exec.arguments;
      decision = decideGuard({
        toolName, args, category, registry, root, evidenceDir, probes, compileErrors: compiled.errors,
        allowMultipleArtifacts, probeLog, env, log: record(toolName),
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      logDecision(logPath, {
        at: new Date().toISOString(), tool: toolName ?? '-', action: 'fail-closed',
        basis: `内部异常 ⇒ deny（R2），不调用 next：${msg}`,
      });
      decision = { kind: 'deny', reason: `上板门内部异常 ⇒ fail-closed 拒绝（R2）：${msg}` };
    }
    // ★ R2：`next()` **在 try 之外**。
    //   ① 判定内部抛错 ⇒ 上面已转 deny，**不调 next**；
    //   ② 下游 next() 抛错 ⇒ 直接向上抛，**不会**被本门 catch 后重试（只调用一次）。
    if (decision.kind === 'deny' || decision.kind === 'ask') return decision;
    const before = (decision.artifacts || []).map((a) => ({ ...a }));
    const downstream = await next();
    // R7：路径接口无法锁定已派发字节；仅在 next 前后复核路径存在性、mtime、内容 hash。
    // 漂移可被记录，但不能撤销已发生的下游动作，故不声称物理锁定。
    if (before.length > 0) {
      const drift = before.filter((a) => sha256(a.abs, 64) !== a.sha256 || !existsSync(a.abs)
        || (() => { try { return statSync(a.abs).mtimeMs !== a.mtimeMs; } catch { return true; } })());
      if (drift.length > 0) {
        logDecision(logPath, { at: new Date().toISOString(), tool: toolName, action: 'post-next-drift', basis: 'R7 path snapshot changed after next; physical bytes not locked', artifacts: drift });
        return { kind: 'deny', reason: 'R7：next 前后路径快照发生漂移；仅能报告，不能物理撤销下游动作。' };
      }
    }
    return downstream;
  });
}

export default { name, inject, apply };
