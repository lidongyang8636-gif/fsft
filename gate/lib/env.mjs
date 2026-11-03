/**
 * gate/lib/env.mjs —— 解释器/运行时的解析与**实测记录**。
 *
 * WHY（本机实测，2026-10-16）：
 *   PATH 上的 `python` / `python3` 是 WindowsApps 执行别名，`& python --version` 直接
 *   `[exit code: 1]`、`$LASTEXITCODE=9009` —— 即"命令发出去但什么都没跑"。
 *   任何写 `python xx.py` 的收口脚本在本机都会**假成功**（若脚本只看自己的打印）
 *   或**假失败**。所以解释器路径必须显式解析，并把**实际用的那个**记进证据里。
 *
 * ★ R11/T9（2026-11-03 用户裁定）：本文件此前把**宿主绝对路径**（含用户名）写成常量，
 *   一旦进公开仓就永久留在历史里。现改为**派生**：
 *     ① `process.env.DSH_HOME`（显式，语义 = `~/.dsh`）；② 回退 `os.homedir()` + `.dsh`。
 *   源码里**不出现**用户名、不出现盘符+用户目录前缀；**fail-closed**——两处都拿不到就抛错，
 *   绝不静默降级成相对路径或空串。派生默认值**逐字节等于**原常量 ⟹ 行为不变。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 宿主**用户目录**（`~/`）。派生规则：
 *   · `DSH_HOME` 已设（语义 = `~/.dsh`）⟹ 取它的**父目录**；
 *   · 否则 `os.homedir()`。
 * fail-closed：两者都拿不到 ⟹ 抛错，不猜。
 */
export function userHome(env = process.env) {
  const dsh = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dsh !== '') return dirname(dsh);
  let home = '';
  try { home = homedir(); } catch { home = ''; }
  if (!home) {
    throw new Error('[gate/env] 无法确定宿主用户目录：DSH_HOME 未设且 os.homedir() 不可用 ⟹ fail-closed（拒绝猜路径）');
  }
  return home;
}

/** `~/.dsh`（DSH 主目录）。派生：`DSH_HOME` 优先，否则 `~/` + `.dsh`。 */
export function dshHome(env = process.env) {
  const dsh = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dsh !== '') return dsh;
  return join(userHome(env), '.dsh');
}

/** 相对 `~/.dsh` 的子路径（不含用户名、不含盘符前缀）。 */
const SUB_PY_DSH = ['dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'];
const SUB_NODE_DSH = ['dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'node.exe'];
/** 相对 `~/` 的子路径（codex 运行时在 `~/.cache` 下）。 */
const SUB_PY_CODEX = ['.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'];

/** 现场已知的捆绑 Python（派生）。 */
export function bundledPythonCandidates(env = process.env) {
  return [join(dshHome(env), ...SUB_PY_DSH), join(userHome(env), ...SUB_PY_CODEX)];
}

/** 现场已知的捆绑 Node（派生）。 */
export function bundledNodeCandidates(env = process.env) {
  return [join(dshHome(env), ...SUB_NODE_DSH)];
}

/**
 * 兼容旧名（导入期派生一次）。
 * @deprecated 新代码请用 `bundledPythonCandidates(env)` / `bundledNodeCandidates(env)`（可按 env 覆盖）。
 */
export const BUNDLED_PY_CANDIDATES = bundledPythonCandidates();
/** @deprecated 见上。 */
export const BUNDLED_NODE_CANDIDATES = bundledNodeCandidates();

/**
 * 解析 Python。优先级：env `GATE_PYTHON` → 已知捆绑路径（存在即可执行）→ null。
 * **不回落到裸 `python`**：那是坏别名，回落等于静默降级（见 SPEC §3.5 之 3 的精神）。
 */
export function resolvePython(env = process.env) {
  const tried = [];
  const explicit = env.GATE_PYTHON || env.PYTHON;
  if (explicit) {
    tried.push({ source: 'env', path: explicit, exists: existsSync(explicit) });
    if (existsSync(explicit)) return { path: explicit, source: 'env', tried };
  }
  for (const p of bundledPythonCandidates(env)) {
    const exists = existsSync(p);
    tried.push({ source: 'bundled-candidate', path: p, exists });
    if (exists) return { path: p, source: 'bundled', tried };
  }
  return { path: null, source: 'unresolved', tried };
}

/** 解析 Node：优先 env `GATE_NODE` → 运行本 runner 的那个解释器（最可信）→ 捆绑候选。 */
export function resolveNode(env = process.env) {
  const tried = [];
  const explicit = env.GATE_NODE;
  if (explicit) {
    tried.push({ source: 'env', path: explicit, exists: existsSync(explicit) });
    if (existsSync(explicit)) return { path: explicit, source: 'env', tried };
  }
  tried.push({ source: 'process.execPath', path: process.execPath, exists: true });
  for (const p of bundledNodeCandidates(env)) {
    if (existsSync(p)) tried.push({ source: 'bundled-candidate', path: p, exists: true });
  }
  return { path: process.execPath, source: 'process.execPath', tried };
}

/**
 * 给子进程用的环境：注意 shell 是 cmd.exe（windows），`PYTHON` 这类变量对脚本无用，
 * 真正有用的是把**可执行文件的绝对路径**放进描述符的 cmd 里。
 * 本函数只负责把解析结果与"怎么发现的"落进证据。
 */
export function runtimeFacts(env = process.env) {
  const py = resolvePython(env);
  const nd = resolveNode(env);
  return {
    python: { path: py.path, source: py.source, tried: py.tried },
    node: { path: nd.path, source: nd.source },
    pathEnv: env.PATH ? `${env.PATH.split(';').length} entries` : '(empty)',
  };
}

/**
 * 运行期临时区（**全工程唯一**定义）。
 *
 * ★ 位置：`<root>/.scratch/`，**不在** `gate/evidence/` 里面。
 *   理由（R1.1，Lead 复核发现）：`gate/evidence/` 是**交付物**（证据 JSON）。
 *   把临时区塞进交付物目录 ⇒ 一旦收尾清理失败，交付物目录就被临时文件污染，
 *   而"证据"与"垃圾"混在一处，看的人分不出哪份是哪份。
 *   现在：证据目录只放证据；临时区单独一处，并在冻结清单里**显式排除**。
 *   ★ 而且它**必须**工作区内部：子进程 `os.tmpdir()` 默认指向工作区外，本沙箱下写外面会被拒（见 README/SPEC I2）。
 */
export const SCRATCH_DIRNAME = '.scratch';

export function scratchDir(root) {
  return join(root, SCRATCH_DIRNAME);
}
