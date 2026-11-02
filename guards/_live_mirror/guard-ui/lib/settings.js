/**
 * guard-ui / settings.js —— **单一真源**（P5）
 *
 * 三个使用者各自 import 同一份，禁止复制粘贴：
 *   · guards/role-guard/lib/index.js        —— 判定期拉取 effective（只管读）
 *   · guards/subagent-sandbox/lib/index.js  —— 同上
 *   · guards/guard-ui/lib/index.js          —— 唯一写者（读 + 校验 + 原子写 + 坏文件隔离）
 *
 * ⚠ 本模块是**跨插件静态 import 的目标**（subagent-sandbox 早就 import 了 role-guard 的
 *   isWriterName，故不引入新机制类型）。因此铁律：
 *     · 零依赖（只用 node: 内置模块）；
 *     · **import 期零副作用**（不做任何 I/O、不读文件、不注册任何东西）——否则本模块一旦
 *       解析失败或抛错，会连坐两个 guard 一起加载失败（= 护栏消失，最坏的 fail-open）。
 *
 * ── 裁决依据（PLAN §9.1 的 P1–P6）─────────────────────────────────────────
 *   P1 判定期按 `agent.session.header.cwd` 拉取；**绝不回落 process.cwd()**。
 *      理由：stub 自测的 cwd 就是仓库根，一旦回落，验收时落下的
 *      `<仓库根>/.dsh-guard.json` 会改写自测行为 ⇒ V6 回归证据被污染。
 *   P2 **默认不缓存**：每次判定读+解析（~1KB）。宁可贵，也不要 mtime 粒度导致「设了不生效」。
 *      （本模块里唯一被记住的是「同一条错误只吼一次」的**日志去重**——它不缓存取值，
 *        每次调用仍然重新读盘、重新解析、重新合并，行为永不陈旧。）
 *   P3 **逐字段合并**（白名单键）：工作区文件里出现的键覆盖 profile 对应键，其余取自 profile。
 *   P4 文件**不存在** ⇒ 回落 profile，**不记警告**（常态）；**存在但坏/不可读** ⇒ 响亮记录 + 回落。
 *   P5 单一真源模块（本文件）。
 *   P6 `exec.agent === undefined`（宿主级调用）⇒ 用 profile 默认（**有意降级**，不许包装成「已覆盖」）。
 *
 * ── 读写策略（刻意不对称，两边都「绝不静默」）──────────────────────────────
 *   写边界（guard-ui settings.set）：**严格拒绝**。任何未知键 / 类型不符 / 取值不在枚举内，
 *     整笔请求 400，一个字节都不落盘（D-B：schema 对未知取值**响亮拒绝**）。
 *   读边界（guard 判定期 / UI 显示）：**宽容但响亮**。整个文件解析不了 ⇒ 整份弃用 + 响亮；
 *     单个键非法 ⇒ 丢掉该键、其余照常生效 + 响亮记录（避免一个笔误让 `mode=set` 整体失效，
 *     那正是本项目最忌的「设了不生效」）。
 *   组合不变式（见下 CROSS_RULES）单独处理：合并后组合非法 ⇒ **整份覆盖弃用** + 响亮（fail-safe）。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 每工作区设置文件名（放在工作区根） */
export const SETTINGS_FILE_NAME = '.dsh-guard.json';
/** 文件格式版本（不匹配即整份弃用 + 响亮） */
export const SETTINGS_VERSION = 1;
/** 本模块负责的两个 guard 插件名（= cordis patch 里的 entry id） */
export const GUARD_PLUGINS = ['subagent-sandbox', 'role-guard'];

/**
 * **旋钮白名单 = UI 与校验的单一真源**。
 *
 * 第一版只暴露 6 个主开关（TASK.2 §2.4）。其余键**不在 UI**，由 profile 决定；
 * 但白名单结构是「加一行就能扩展」的，故 P2 的全量旋钮不需要改架构。
 *
 * 字段含义：
 *   plugin/path   —— 目标插件的点分路径（写入时嵌进 `<plugin>: { <path>: value }`）
 *   kind          —— 'enum' | 'boolean' | 'string'
 *   values        —— kind=enum 的**全部合法取值**。⚠ 必须与 guard 代码真正 honor 的集合逐一对应，
 *                    多写一个「代码里没有的分支」＝ 做出一个「选了也不生效」的假旋钮
 *                    （D-B 的 `enforce` 就是这么错的；本轮又抓到 `unknownPolicy` 的 `deny` 同病）。
 *   builtin       —— 插件**代码默认值**（仅当 profile 也没给时用于显示；来源会如实标 'builtin'）
 *   label/control/valueLabels/doc —— UI 渲染用（客户端不复制 schema，按这些字段画表单）
 */
export const KNOBS = [
  // ── subagent-sandbox ────────────────────────────────────────────────────
  {
    plugin: 'subagent-sandbox',
    path: 'mode',
    kind: 'enum',
    values: ['off', 'observe', 'set'],
    builtin: 'observe',
    label: '子代理沙箱模式',
    control: 'radio',
    valueLabels: { off: '关闭（挂载不动作）', observe: '只观察', set: '真落档' },
    doc: '只有 set 会真的给子会话落档（代码 subagent-sandbox/lib/index.js `if (cfg.mode !== \'set\') return;`）。'
      + '⚠ 不存在 enforce 档——那是 PLAN 写错的词，已作废。',
  },
  {
    plugin: 'subagent-sandbox',
    path: 'childPreset',
    kind: 'string',
    nonEmpty: true,
    builtin: 'fpga-locked',
    label: '钉给子会话的权限档',
    control: 'text',
    doc: '档名必须在进程权限目录里；坏档名只跳该档、不炸子代理创建。候选来自 permissionPresets.catalog()。',
  },
  {
    plugin: 'subagent-sandbox',
    path: 'writerExempt',
    kind: 'boolean',
    builtin: false,
    label: 'writer 豁免',
    control: 'checkbox',
    doc: '名字命中 writerNamePatterns 的**团队成员**保留原档（不被钉只读）。子代理不是成员 ⇒ 不适用（写权限不可委派）。',
  },
  // ── role-guard ──────────────────────────────────────────────────────────
  {
    plugin: 'role-guard',
    path: 'roleScope.enabled',
    kind: 'boolean',
    builtin: false,
    label: '角色分层',
    control: 'checkbox',
    doc: '主闸门：按调用者身份判只读边界。关闭后 role-guard 退回全局只读模式。',
  },
  {
    plugin: 'role-guard',
    path: 'roleScope.unknownPolicy',
    kind: 'enum',
    values: ['pass', 'guard'],
    builtin: 'guard',
    label: '身份未知时',
    control: 'radio',
    valueLabels: { pass: '放行', guard: '按只读拦' },
    doc: '只对「完全无责任链」的宿主级调用生效。'
      + '⚠ 代码只特判 pass，其余值一律等同 guard —— 故没有 deny 档（PLAN §4 画的 deny 是无效旋钮，已从白名单剔除）。',
  },
  {
    plugin: 'role-guard',
    path: 'roleScope.serviceMissingPolicy',
    kind: 'enum',
    values: ['pass', 'guard'],
    builtin: 'guard',
    label: '团队服务取不到时',
    control: 'radio',
    valueLabels: { pass: '放行', guard: '按只读拦' },
    doc: '取不到 agentTeams 时怎么办。默认 guard（不得静默变成 no-op）。同样没有 deny 档。',
  },
  {
    plugin: 'role-guard',
    path: 'shellScope.enabled',
    kind: 'boolean',
    builtin: false,
    label: '命令护栏（shellScope）',
    control: 'checkbox',
    doc: '只读角色调 shell 时扫描命令文本里的厂商/烧板/串口写模式。'
      + '⚠ 这是**文本减速带，不是硬边界**；且开启必须同时 roleScope.enabled=true（见组合不变式）。',
  },
];

/**
 * **组合不变式**：单键合法 ≠ 组合合法。
 * role-guard 在**加载期**就用 `shellScope.enabled && !roleScope.enabled ⇒ throw` 拒绝加载
 * （lib/index.js:525-528：shell 扫描需要角色归因才能判「谁是只读」，否则是「设了但不生效」的假安全感）。
 * 工作区覆盖**必须保持同一条不变式**，否则就绕过了这个保护。
 * 合并后组合非法 ⇒ **整份工作区覆盖弃用** + 响亮记录（fail-safe，绝不带着非法组合跑）。
 */
const CROSS_RULES = [
  {
    plugin: 'role-guard',
    check: (view) => !(view['shellScope.enabled'] === true && view['roleScope.enabled'] !== true),
    message: '组合非法：shellScope.enabled=true 需要 roleScope.enabled=true'
      + '（role-guard 加载期就用这条规则拒绝加载；工作区覆盖必须保持同一不变式）。'
      + '⇒ 整份工作区覆盖已弃用，本次判定用 profile 默认。',
  },
];

/** 显式黑名单：主仓库只读，工作区设置文件**绝不**写到它的任何位置 */
export const FORBIDDEN_ROOTS = ['%MAIN_REPO%'];

/**
 * 把路径解析成**真实落点**（穿透 junction / symlink），用于黑名单判定与写删落点。
 *
 * ⚠⚠ **必须用 `realpathSync.native`，不能用 `fs.realpathSync`**（2026-10-15 实测，红队 F1）：
 *     · `realpathSync(link)`      在 Windows 上**不解析 junction** ⇒ 直接返回**别名本身**；
 *     · `realpathSync.native(link)` 走 `GetFinalPathNameByHandle` ⇒ 返回**目标**。
 *   用前者等于「加了 realpath 却没修」，这正是 F1 修复最容易踩空的一步。
 *
 * ⚠ 目标可能**尚不存在**（首次写）：`realpathSync.native` 对任一不存在的组件抛 ENOENT
 *   ⇒ 必须自下而上找到**最近的已存在祖先**做 native realpath，再把剩余段拼回去。
 *   任何其它错误（EACCES 等）一律**向上抛**，由调用方 fail-closed 处理。
 */
export function resolveRealPath(p) {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('resolveRealPath: 路径为空');
  const abs = resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length === 0 ? real : join(real, ...tail.slice().reverse());
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;                 // 权限等其它错误 ⇒ 抛（fail-closed）
      const parent = dirname(cur);
      if (parent === cur) throw e;                       // 已到卷根仍不存在 ⇒ 抛
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** 文件现状令牌（跨进程乐观并发控制用；见 `writeWorkspaceSettings` 的 `options.expect`） */
export function fileToken(cwd) {
  let real;
  try {
    real = resolveRealPath(cwd);
  } catch {
    return null;
  }
  const file = settingsPathFor(real);
  if (!existsSync(file)) return { exists: false, mtimeMs: null, size: null };
  try {
    const st = statSync(file);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** `options.expect` 与现状是否一致（不一致 ⇒ 有人在我们读取之后改过文件） */
function tokenMatches(expect, cur) {
  if (cur === null) return false;
  if (expect.exists !== cur.exists) return false;
  if (expect.exists !== true) return true;
  return expect.mtimeMs === cur.mtimeMs && expect.size === cur.size;
}

export function settingsPathFor(cwd) {
  return join(cwd, SETTINGS_FILE_NAME);
}

/**
 * 是否命中显式黑名单（主仓库只读）。
 *
 * ⚠ 判定基于 **realpath 后的真实落点**（F1 修复）：只比字面路径会被 junction/symlink 绕过——
 *   别名自身的字面形态不在禁用根内，但写下去落到禁用根里。
 * ⚠ **fail-closed**：目标解析不出来（权限错 / 路径为空 / 连卷根都取不到）一律**判为禁用**。
 *   「解析失败 ⇒ 放行」是安全边界上最糟的默认值。
 * ⚠ **禁用根**解析失败只在 `ENOENT` 时退化（见下方注释），其它失败 fail-closed。
 * ⚠ 保留原有的「前缀陷阱」性质：判**包含关系**而非字符串前缀，
 *   故 `%MAIN_REPO%-dsh` 不以 `%MAIN_REPO%` 为父目录 ⇒ 放行。
 *
 * `roots` 仅供**测试**注入替身禁用根（生产调用一律不传，用默认 `FORBIDDEN_ROOTS`）。
 */
export function isForbiddenWorkspacePath(p, roots = FORBIDDEN_ROOTS) {
  if (typeof p !== 'string' || p.trim() === '') return true;
  let real;
  try {
    real = resolveRealPath(p);
  } catch {
    return true;                                         // 目标解析失败 ⇒ fail-closed
  }
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = resolveRealPath(root);
    } catch (e) {
      // ⚠ 第 2 轮红队 F1-P2-2（收紧）：**只在 ENOENT 时**才退化为字面比较。
      //   退化的正当理由：本机可能配置了**不存在的**禁用根（如别的机器上的路径）；
      //   若这里也一律 fail-closed，会把**全部**工作区全拒 ⇒ 插件彻底不可用。
      //   其余失败（EACCES / ERR_INVALID_ARG_VALUE / reparse 异常 / 瞬态）**不得**退化 ——
      //   那类失败既不该被忽略，也不该被当成「根不存在」，故 **fail-closed**（判禁）。
      if (e?.code === 'ENOENT') {
        realRoot = resolve(root);                        // 根确实不存在 ⇒ 字面比较（正当退化）
      } else {
        return true;                                     // 其它解析失败 ⇒ fail-closed
      }
    }
    if (isInside(realRoot, real)) return true;
  }
  return false;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 白名单里属于某插件的旋钮 */
export function knobsOf(plugin) {
  return KNOBS.filter((k) => k.plugin === plugin);
}

/** 按点分路径读嵌套对象（任一段不是对象 ⇒ undefined） */
export function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * 按点分路径写嵌套对象，**沿途复制**（不改动传入对象）。
 * 这样 `mergeFor` 永远不碰 profile 的原对象 —— 默认路径下能返回同一引用（行为可证同一）。
 */
function setPath(obj, dotted, value) {
  const segs = dotted.split('.');
  const out = { ...obj };
  let cur = out;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i];
    const next = cur[seg];
    cur[seg] = isPlainObject(next) ? { ...next } : {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
  return out;
}

/** 枚举嵌套对象的**叶路径**（点分）。用于揪出白名单外的键（拼错要能看见）。 */
export function leafPaths(obj, prefix = '') {
  const out = [];
  if (!isPlainObject(obj)) return prefix === '' ? out : [prefix];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix === '' ? k : `${prefix}.${k}`;
    if (isPlainObject(v) && Object.keys(v).length > 0) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

/** 递归去掉空对象容器。删键会留下 `{roleScope:{}}` 这种空壳——它会让文件的**实际语义为空**，
 *  但读取方会因「段非空」而把 source 标成 'workspace'（撒谎）。故每次编辑后都修剪。 */
function pruneEmpty(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v)) {
      const p = pruneEmpty(v);
      if (Object.keys(p).length > 0) out[k] = p;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function deletePath(obj, dotted) {
  const segs = dotted.split('.');
  const out = { ...obj };
  let cur = out;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i];
    if (!isPlainObject(cur[seg])) return out;
    cur[seg] = { ...cur[seg] };
    cur = cur[seg];
  }
  delete cur[segs[segs.length - 1]];
  return out;
}

/** 单键校验：返回 { ok, value } 或 { ok:false, error } */
function validateKnob(knob, raw) {
  switch (knob.kind) {
    case 'boolean':
      return typeof raw === 'boolean'
        ? { ok: true, value: raw }
        : { ok: false, error: `应为布尔值，实得 ${JSON.stringify(raw)}` };
    case 'enum':
      return knob.values.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `取值非法：${JSON.stringify(raw)}（限 ${knob.values.join(' / ')}）` };
    case 'string':
      if (typeof raw !== 'string' || (knob.nonEmpty && raw.trim() === '')) {
        return { ok: false, error: `应为${knob.nonEmpty ? '非空' : ''}字符串，实得 ${JSON.stringify(raw)}` };
      }
      return { ok: true, value: raw };
    default:
      return { ok: false, error: `schema 缺陷：未知 kind=${knob.kind}` };
  }
}

/** 逐插件、逐白名单键校验一份「`<plugin>: { <path>: value }`」载荷 */
export function validatePayload(payload) {
  const errors = [];
  const accepted = {};
  if (!isPlainObject(payload)) {
    return { ok: false, errors: ['载荷不是对象'], accepted };
  }
  for (const [plugin, sectionRaw] of Object.entries(payload)) {
    if (!GUARD_PLUGINS.includes(plugin)) {
      errors.push(`未知插件段：${plugin}（限 ${GUARD_PLUGINS.join(' / ')}）`);
      continue;
    }
    if (!isPlainObject(sectionRaw)) {
      errors.push(`${plugin} 段不是对象`);
      continue;
    }
    for (const [dotted, raw] of Object.entries(sectionRaw)) {
      const knob = knobsOf(plugin).find((k) => k.path === dotted);
      if (knob === undefined) {
        errors.push(`${plugin}.${dotted}：不在白名单内（第一版只开放 ${knobsOf(plugin).map((k) => k.path).join(' / ')}）`);
        continue;
      }
      if (raw === null) {                 // null = 「从工作区文件里删掉这个键」，合法
        accepted[plugin] = { ...(accepted[plugin] ?? {}), [dotted]: null };
        continue;
      }
      const v = validateKnob(knob, raw);
      if (!v.ok) {
        errors.push(`${plugin}.${dotted}：${v.error}`);
        continue;
      }
      accepted[plugin] = { ...(accepted[plugin] ?? {}), [dotted]: v.value };
    }
  }
  return { ok: errors.length === 0, errors, accepted };
}

// ─────────────────────────── 路径与黑名单 ───────────────────────────

/**
 * `target` 是否在 `root` 之内（含相等）。
 *
 * ⚠ 为什么不能写成「rel 不以 .. 开头就是在里面」：**跨盘符时 `path.relative` 直接返回绝对路径**。
 *    实测（本机 E: 与 C: 都存在）：
 *      path.relative('E:\\a', 'C:\\b')  ===  'C:\\b'      ← 不是 '..\\..'
 *    于是 `C:\\Users\\...\\Temp\\ws` 会被误判成「在 %MAIN_REPO% 里面」⇒
 *    所有 C: 上的工作区（含自测用的 temp 目录）会被黑名单全部拒掉。
 *    这个 bug 由 test/settings.mjs 的 temp 目录用例抓到（测试在 C:，仓库在 E:）。
 */
function isInside(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true;                 // 同一个目录
  if (isAbsolute(rel)) return false;           // 不同盘符 ⇒ relative 返回绝对路径 ⇒ 在外面
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

// ─────────────────────────── 读取（P1/P2/P4）───────────────────────────

/**
 * **P1**：只认 `agent.session.header.cwd`。
 * 拿不到就返回 null ⇒ 调用方必须用 profile 默认。
 * **绝不回落 `process.cwd()`**（见文件头 P1 理由）。
 */
export function callerWorkspaceRoot(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/**
 * 去掉**前导 BOM**（U+FEFF）后解析 JSON。
 *
 * ⚠ 实测教训（2026-10-15 V3 现场抓到）：Windows 上「人写/手改」这个文件**极易带 BOM** ——
 *   PowerShell 5.1 的 `Set-Content -Encoding utf8` 与记事本默认都写 `EF BB BF`；
 *   而 `JSON.parse('\uFEFF{...}')` **直接抛**。若不剥 BOM，整份文件会被判 invalid
 *   ⇒ 用户明明写了 `mode:"off"`，guard 却仍按 profile 跑 —— 正是本项目最忌的「设了不生效」。
 *   （当时降级与响亮记录都正确，缺的只是这一层宽容。）
 */
function parseJsonLoose(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/** 读 + 解析 + 校验工作区设置文件（**纯读，绝不写盘**——guard 判定期绝不产生写副作用）。
 *
 * 返回：
 *   { status:'absent' }                                   文件不存在（常态，调用方静默回落 profile）
 *   { status:'invalid', errors:[...] }                     整份不可用（不可读 / 非 JSON / 非对象 / 版本不符）
 *   { status:'ok', value:{<plugin>:{<path>:v}}, problems:[...] }
 *                                                          可用；problems 非空 = 有键被丢弃（**响亮**）
 *
 * `problems` 与 `status:'invalid'` 的区别见文件头「读写策略」：整份不可用 vs 单键被丢。
 */
export function readWorkspaceSettings(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { status: 'invalid', cwd: null, file: null, errors: ['未提供工作区路径'], problems: [] };
  }
  // ⚠ **读路径的唯一例外（第 2 轮红队 F1-P2-3，本项选「收窄声明」而非改代码）**：
  //   下面这步「文件是否存在」的探测用的是**字面**路径（`existsSync`），**不走 native realpath**。
  //   理由：P2 要求每次判定都重读，而 realpath 会开句柄；常态是「文件不存在」，
  //   若每次都解析，等于给每一次工具调用都加一次句柄开销，而收益只是「探测也解析」。
  //   风险面（已评估，低）：若 `cwd` 本身是**指向禁用根的别名**，这一步会**探测**一次禁用根里的
  //   `.dsh-guard.json` 是否存在 —— 但**不读内容、不写**；随后第 459 行起的解析与
  //   `isForbiddenWorkspacePath` 会把它判为 `invalid` 并拒绝使用。
  //   ⇒ 因此**不能**声称「读路径的每个 syscall 都基于 realpath」；精确声明见 README「残余风险 R-2」。
  const literalFile = settingsPathFor(cwd);
  if (!existsSync(literalFile)) return { status: 'absent', cwd, file: literalFile, errors: [], problems: [] };

  // 文件存在才解析真实落点（F1）：既让 `file` 如实，也挡掉「经别名读到禁用根里的文件」这条配置注入路。
  let file = literalFile;
  let realCwd = cwd;
  try {
    realCwd = resolveRealPath(cwd);
    file = settingsPathFor(realCwd);
  } catch (e) {
    return { status: 'invalid', cwd, file: literalFile, errors: [`无法解析工作区真实路径（fail-closed）：${e?.message ?? e}`], problems: [] };
  }
  if (isForbiddenWorkspacePath(realCwd)) {
    return { status: 'invalid', cwd, file, errors: [`工作区真实路径命中禁用根（主仓库只读），拒绝读取：${realCwd}`], problems: [] };
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { status: 'invalid', cwd, file, errors: [`文件存在但读不了：${e?.message ?? e}`], problems: [] };
  }

  let parsed;
  try {
    parsed = parseJsonLoose(text);
  } catch (e) {
    return { status: 'invalid', cwd, file, errors: [`不是合法 JSON：${e?.message ?? e}`], problems: [] };
  }
  if (!isPlainObject(parsed)) {
    return { status: 'invalid', cwd, file, errors: ['顶层不是对象'], problems: [] };
  }
  const version = parsed.version ?? SETTINGS_VERSION;
  if (version !== SETTINGS_VERSION) {
    return { status: 'invalid', cwd, file, errors: [`版本不符：文件 version=${JSON.stringify(parsed.version)}，本版本只认 ${SETTINGS_VERSION}`], problems: [] };
  }

  const problems = [];
  const value = {};
  const { version: _v, ...sections } = parsed;   // eslint-disable-line no-unused-vars
  for (const [plugin, sectionRaw] of Object.entries(sections)) {
    if (!GUARD_PLUGINS.includes(plugin)) {
      problems.push(`未知插件段「${plugin}」已忽略（限 ${GUARD_PLUGINS.join(' / ')}）`);
      continue;
    }
    if (!isPlainObject(sectionRaw)) {
      problems.push(`${plugin} 段不是对象，已忽略`);
      continue;
    }
    // 文件里是**嵌套**结构（与插件 config 同形，便于人读/手改）；白名单是**点分路径**。
    // 两件事都要做：① 逐个白名单键取值校验（坏的丢该键、其余照常）；② 揪出**没被消费掉的叶键**。
    // ② 的判据是「消费」而不是「白名单里有」：若有人在文件里写成 `"roleScope.enabled": false`
    // （点分当键名、不是嵌套），getPath 取不到 ⇒ 它**没被消费**，必须响亮报告。
    // 否则它会被静默忽略 —— 正是本项目最忌的「设了不生效」。
    const consumed = new Set();
    for (const knob of knobsOf(plugin)) {
      const raw = getPath(sectionRaw, knob.path);
      if (raw === undefined) continue;
      const v = validateKnob(knob, raw);
      if (!v.ok) {
        problems.push(`${plugin}.${knob.path} ${v.error}，该键已忽略`);
        continue;
      }
      consumed.add(knob.path);
      value[plugin] = setPath(value[plugin] ?? {}, knob.path, v.value);
    }
    for (const leaf of leafPaths(sectionRaw)) {
      if (!consumed.has(leaf)) {
        problems.push(`${plugin}.${leaf} 不在白名单内，或写法不对（文件里必须用嵌套写法），已忽略`);
      }
    }
  }
  return { status: 'ok', cwd, file, value, version, errors: [], problems };
}

// ─────────────────────────── 合并（P3）───────────────────────────

/**
 * **P3 逐字段合并**：只动白名单键。
 * 无覆盖时**原样返回 profile 对象**（同一引用）——这样「默认路径行为与改动前一致」是**构造性成立**的，
 * 而不是靠跑测试碰运气（V6 最关键回归）。
 */
export function mergeFor(plugin, profileConfig, override) {
  if (override === null || override === undefined) return profileConfig;
  let out = isPlainObject(profileConfig) ? profileConfig : {};
  for (const knob of knobsOf(plugin)) {
    const raw = getPath(override, knob.path);
    if (raw === undefined) continue;
    out = raw === null ? deletePath(out, knob.path) : setPath(out, knob.path, raw);
  }
  return out;
}

/** 某插件的白名单键在「profile 已合并」视图下的取值（缺省处用 builtin 兜底，供组合不变式判定） */
export function whitelistView(plugin, merged) {
  const view = {};
  for (const knob of knobsOf(plugin)) {
    const v = getPath(merged, knob.path);
    view[knob.path] = v === undefined ? knob.builtin : v;
  }
  return view;
}

/** 组合不变式（CROSS_RULES）——返回 { ok, errors } */
export function validateCombination(plugin, merged) {
  const view = whitelistView(plugin, merged);
  const errors = [];
  for (const rule of CROSS_RULES) {
    if (rule.plugin !== plugin) continue;
    if (!rule.check(view)) errors.push(rule.message);
  }
  return { ok: errors.length === 0, errors, view };
}

// ─────────────────────────── 判定期拉取（guard 侧唯一入口）───────────────────────────

/**
 * guard 判定期用的**唯一入口**。契约：
 *   · 绝不抛（判定期抛异常会让整条护栏失效——历史先例：guard 抛错 ⇒ 静默失效）；
 *   · 绝不回落 `process.cwd()`（P1）；
 *   · 绝不缓存取值（P2）——每次调用都重读盘、重解析、重合并；
 *   · 无工作区文件 / 文件不可用 / 组合非法 ⇒ 返回 profile 原对象 + source:'profile'（P4）。
 *
 * 返回 { config, source:'workspace'|'profile', cwd, reason, problems[] }
 *   reason: 'ok' | 'absent' | 'invalid' | 'no-plugin-section' | 'cross-rule'
 *         | 'host-level-call'      ← **P6 有意降级**：无 agent（宿主级调用），没有工作区归属
 *         | 'agent-cwd-missing'    ← **意外**：有 agent 却没有 `session.header.cwd`（红队 F2）
 *
 * ⚠ F2（红队 HIGH）：这两种「回落 profile」**必须区分开**。
 *   `SessionHeader.cwd` 是**可选**字段 ⇒ 有 agent 但缺 cwd 是**意外**，不是设计意图；
 *   而它与 P6 的有意降级此前**共用同一个 reason 且 problems 为空** ⇒ 完全静默
 *   （用户写了设置、guard 却按 profile 跑，界面上看不到任何异常）。
 *   现在：`agent-cwd-missing` **一定**带 problems（guard 侧转成 warn + 事件），
 *   且 reason 本身可区分；`host-level-call` 保持静默（那是设计内的、且无法避免）。
 */
export function resolvePluginConfig(plugin, profileConfig, agent) {
  const cwd = callerWorkspaceRoot(agent);
  if (cwd === null) {
    // P6：宿主级调用（连 agent 都没有）⇒ 有意降级为 profile 默认，静默（设计内，无工作区归属可言）
    if (agent === undefined || agent === null) {
      return { config: profileConfig, source: 'profile', cwd: null, reason: 'host-level-call', problems: [] };
    }
    // F2：**有 agent 但拿不到 cwd** ⇒ 意外，必须响亮
    return {
      config: profileConfig,
      source: 'profile',
      cwd: null,
      reason: 'agent-cwd-missing',
      problems: [
        '调用者有 agent，但取不到 `agent.session.header.cwd`（该字段是**可选**的）'
        + ' ⇒ 无法按工作区判定，本次按 profile 默认；该工作区里的 .dsh-guard.json 对它**不生效**。',
      ],
    };
  }

  let read;
  try {
    read = readWorkspaceSettings(cwd);
  } catch (e) {
    return { config: profileConfig, source: 'profile', cwd, reason: 'invalid', problems: [`读取工作区设置抛异常：${e?.message ?? e}`] };
  }
  if (read.status === 'absent') {
    return { config: profileConfig, source: 'profile', cwd, reason: 'absent', problems: [] };  // P4：常态，不记警告
  }
  if (read.status === 'invalid') {
    return { config: profileConfig, source: 'profile', cwd, reason: 'invalid', problems: read.errors };
  }
  const section = read.value?.[plugin];
  if (!isPlainObject(section) || Object.keys(section).length === 0) {
    return { config: profileConfig, source: 'profile', cwd, reason: 'no-plugin-section', problems: read.problems };
  }

  const merged = mergeFor(plugin, profileConfig, section);
  const combo = validateCombination(plugin, merged);
  if (!combo.ok) {
    return { config: profileConfig, source: 'profile', cwd, reason: 'cross-rule', problems: [...read.problems, ...combo.errors] };
  }
  return { config: merged, source: 'workspace', cwd, reason: 'ok', problems: read.problems };
}

/**
 * **日志去重器**（不是取值缓存，见 P2 注解）。
 * P2 要求每次判定都重读盘 ⇒ 一个坏文件会在每次工具调用时产生同一条错误。
 * 去重键 = 消息本身；同一条只吼一次，避免把日志刷爆而掩盖别的问题。
 */
export function createProblemReporter(report) {
  const seen = new Set();
  return (problems, context) => {
    if (!Array.isArray(problems) || problems.length === 0) return;
    for (const p of problems) {
      const key = String(p);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        report(key, context);
      } catch { /* 诊断失败绝不影响主功能 */ }
    }
  };
}

// ─────────────────────────── 写入（**仅 guard-ui**）───────────────────────────

/** 读文件里的原始载荷（写路径要用它做「读-改-写」，不能用校验后的视图，否则会抹掉将来扩展的键） */
function readRawForWrite(cwd) {
  const file = settingsPathFor(cwd);
  if (!existsSync(file)) return { raw: {}, quarantine: null };
  try {
    const parsed = parseJsonLoose(readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('顶层不是对象');
    const version = parsed.version ?? SETTINGS_VERSION;
    if (version !== SETTINGS_VERSION) throw new Error(`版本不符：${JSON.stringify(parsed.version)}`);
    return { raw: parsed, quarantine: null };
  } catch (e) {
    return { raw: {}, quarantine: String(e?.message ?? e) };
  }
}

/** 坏文件改名留底 `*.corrupt-<时间戳>`（**只由 guard-ui 调用**；guard 判定期绝不写盘） */
export function quarantineCorrupt(cwd) {
  const file = settingsPathFor(cwd);
  if (!existsSync(file)) return { renamed: null, error: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${file}.corrupt-${stamp}`;
  for (let i = 1; existsSync(target) && i < 100; i += 1) target = `${file}.corrupt-${stamp}-${i}`;
  try {
    renameSync(file, target);
    return { renamed: target, error: null };
  } catch (e) {
    return { renamed: null, error: String(e?.message ?? e) };
  }
}

/**
 * 原子写：同目录 tmp + rename（rename 在同一卷上是原子的，读方永远看到完整文件）。
 *
 * 形状约定（**两处刻意不同**，别混）：
 *   · `patch`（**API 入参 / 客户端送来的**）= `{ <plugin>: { "<点分路径>": value | null } }`
 *     —— 点分是为了让 UI 对 `knobs` 列表做通用表单，不必懂嵌套。
 *   · **磁盘文件** = `{ version, <plugin>: { <嵌套> } }`
 *     —— 与插件 config 同形，人读/手改友好，且 `mergeFor`/`getPath` 直接可用。
 *   `null` 表示「把这个键从工作区文件里删掉」。
 *
 * `profileConfig`（可选）= 该插件的 **profile 现值**。给了就能在写入前做**权威**组合校验
 * （工作区 × profile）；不给就只能做「文件自身内部一致性」的尽力校验。
 * ⚠ 必须尽量传：否则会出现「UI 显示已覆盖、guard 判定期却因组合非法整份弃用」＝
 *   界面撒谎（正是本项目最忌的「设了不生效」）。guard-ui 主机半从 configEditor 取 profile 现值后传入。
 *
 * 返回 `{ ok, file, value, errors, notes }`；**校验失败一个字节都不写**。
 */
export function writeWorkspaceSettings(cwd, patch, profileConfigByPlugin = null, options = {}) {
  const roots = options.forbiddenRoots ?? FORBIDDEN_ROOTS;
  if (isForbiddenWorkspacePath(cwd, roots)) {
    return { ok: false, errors: [`拒绝写入黑名单路径（判定基于 realpath；主仓库只读）：${cwd}`], file: null };
  }
  // 落点 = realpath 后的真实路径（F1）：别名与真身必须共用同一个判定与同一个目标，
  // 否则「判的是别名、写的是真身」，黑名单形同虚设。解析失败 ⇒ fail-closed。
  let realCwd;
  try {
    realCwd = resolveRealPath(cwd);
  } catch (e) {
    return { ok: false, errors: [`无法解析工作区真实路径（fail-closed）：${e?.message ?? e}`], file: null };
  }
  if (isForbiddenWorkspacePath(realCwd, roots)) {
    return { ok: false, errors: [`工作区真实落点命中禁用根（主仓库只读）：${realCwd}`], file: null };
  }
  const checked = validatePayload(patch);
  if (!checked.ok) return { ok: false, errors: checked.errors, file: null };

  const file = settingsPathFor(realCwd);

  // ── 乐观并发控制（F3）：调用方读取之后文件是否被改过？改过就**不写** ──
  if (options.expect !== undefined && options.expect !== null) {
    const cur = fileToken(realCwd);
    if (!tokenMatches(options.expect, cur)) {
      return { ok: false, conflict: true, file,
        errors: ['工作区设置文件在本次提交前已被其它写者改动（mtime/size 不一致）⇒ 拒绝写入，以免覆盖对方刚写的字段。请重新读取后再提交。'] };
    }
  }

  const { raw, quarantine } = readRawForWrite(realCwd);
  const notes = [];
  // ⚠ 坏文件必须**真的**改名留底（V5）。曾经只记了 note 却没调 quarantineCorrupt —— 谎报。
  if (quarantine !== null) {
    const q = quarantineCorrupt(realCwd);
    notes.push(q.renamed !== null
      ? `原文件不可用（${quarantine}），已改名留底：${q.renamed}`
      : `原文件不可用（${quarantine}），且改名留底失败（${q.error}）`);
  }

  let next = { ...raw, version: SETTINGS_VERSION };
  for (const [plugin, section] of Object.entries(checked.accepted)) {
    let cur = isPlainObject(next[plugin]) ? next[plugin] : {};
    for (const [dotted, v] of Object.entries(section)) {
      cur = v === null ? deletePath(cur, dotted) : setPath(cur, dotted, v);
    }
    cur = pruneEmpty(cur);
    if (Object.keys(cur).length === 0) delete next[plugin];
    else next[plugin] = cur;
  }
  if (Object.keys(next).filter((k) => k !== 'version').length === 0) {
    // 只剩 version = 没有任何覆盖 ⇒ 删掉文件（回落 profile 默认）
    const del = deleteWorkspaceSettings(realCwd, {
      forbiddenRoots: roots,
      ...(options.expect !== undefined ? { expect: options.expect } : {}),
    });
    return { ok: del.ok, errors: del.errors, file: del.file, value: null, notes, conflict: del.conflict };
  }

  // ── 组合不变式：该插件有 profile 现值 ⇒ **权威**校验；没有 ⇒ 只做文件内部校验 + **响亮** note ──
  // ⚠ F4 教训：调用方此前在 configEditor 不可用时传 `{}`，被 `isPlainObject({}) === true`
  //   当成「权威校验」，于是静默放宽且 notes 为空。现在：`null`/缺键 = 读不到，一定记 note。
  const profileKnown = isPlainObject(profileConfigByPlugin);
  const combinationChecked = {};
  for (const plugin of Object.keys(next).filter((k) => k !== 'version')) {
    const prof = profileKnown ? profileConfigByPlugin[plugin] : undefined;
    if (prof !== undefined) {
      const merged = mergeFor(plugin, prof, next[plugin]);
      const combo = validateCombination(plugin, merged);
      if (!combo.ok) return { ok: false, errors: combo.errors, file: null };
      combinationChecked[plugin] = 'with-profile';
    } else {
      const combo = validateCombination(plugin, next[plugin]);
      if (!combo.ok) return { ok: false, errors: combo.errors, file: null };
      combinationChecked[plugin] = 'file-internal-only';
      notes.push(`未取得 ${plugin} 的 profile 现值 ⇒ 该插件的组合不变式只做了「文件内部」尽力校验；`
        + '权威判定在 guard 判定期（若跨文件组合非法，guard 会**整份弃用**本覆盖）。');
    }
  }

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 清理失败不掩盖主错误 */ }
    return { ok: false, errors: [`写入失败：${e?.message ?? e}`], file: null };
  }

  // ── 回读校验（F3）：写完立刻读回比对；不一致 ⇒ 响亮失败，并**如实**说可能已落盘 ──
  let back = null;
  try {
    back = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, wrote: true, verified: false, file, notes, combinationChecked,
      errors: [`写入后回读失败：${e?.message ?? e}`] };
  }
  if (back !== text) {
    return { ok: false, wrote: true, verified: false, file, notes, combinationChecked,
      errors: [`写入后回读与预期不一致（预期 ${text.length} 字节，实得 ${back.length} 字节）`
        + ' ⇒ 可能已被并发写者覆盖；请重新读取核对。'] };
  }
  return { ok: true, wrote: true, verified: true, errors: [], file, value: next, notes, combinationChecked };
}

/**
 * 删除工作区设置文件（`settings.reset`）⇒ 回落 profile 默认。
 * F1：判定与删除都基于 realpath。
 * F3：给了 `options.expect` 且现状不一致 ⇒ **拒绝删除**并报 `conflict`
 *     （否则会删掉别的写者**刚写的新文件**——`REPRO.3.md` §3b 就是这条）。
 */
export function deleteWorkspaceSettings(cwd, options = {}) {
  const roots = options.forbiddenRoots ?? FORBIDDEN_ROOTS;
  if (isForbiddenWorkspacePath(cwd, roots)) {
    return { ok: false, errors: [`拒绝操作黑名单路径（判定基于 realpath；主仓库只读）：${cwd}`], file: null };
  }
  let realCwd;
  try {
    realCwd = resolveRealPath(cwd);
  } catch (e) {
    return { ok: false, errors: [`无法解析工作区真实路径（fail-closed）：${e?.message ?? e}`], file: null };
  }
  if (isForbiddenWorkspacePath(realCwd, roots)) {
    return { ok: false, errors: [`工作区真实落点命中禁用根（主仓库只读）：${realCwd}`], file: null };
  }
  const file = settingsPathFor(realCwd);
  if (!existsSync(file)) return { ok: true, errors: [], file, existed: false };
  if (options.expect !== undefined && options.expect !== null) {
    const cur = fileToken(realCwd);
    if (!tokenMatches(options.expect, cur)) {
      return { ok: false, conflict: true, file,
        errors: ['工作区设置文件在本次删除前已被其它写者改动（mtime/size 不一致）⇒ 拒绝删除，以免删掉对方刚写的内容。'] };
    }
  }
  try {
    unlinkSync(file);
    return { ok: true, errors: [], file, existed: true };
  } catch (e) {
    return { ok: false, errors: [`删除失败：${e?.message ?? e}`], file };
  }
}
