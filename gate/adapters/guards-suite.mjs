/**
 * gate/adapters/guards-suite.mjs —— 本工程现役验证（`guards/{guard-ui,role-guard,subagent-sandbox}/test/` 下 12 个）的适配器。
 *
 * ⚠ 本条注释**踩过一个真坑**（记在此处防止复发）：原文写过 `guards/<星>/test` 这种通配写法，
 *   而 **星号紧跟斜杠** 在块注释里就是一个**提前闭合**标记 —— 注释在那两个字符处被关掉，
 *   残留文本被当成代码解析，运行时抛 `ReferenceError: test is not defined`。
 *   **而它在 R1 从未被发现**，因为 R1 里没有任何代码 import 过本文件：
 *   它是一份被"读码确认"过的**文档**，不是被**执行**过的程序。
 *   R2 一接入 `gen-tasks.mjs`（真 import）立刻暴露 ⟹ 教训：**能被 import 才算适配器**。
 *   （连"解释这个坑"的这段话本身都又踩了一次，因为我在注释里把通配符原样写了出来。）
 *
 * ★ 契约（TASK.1 §3.4）：适配器**只做**「任务 → 断言数组」的映射。
 *   **执行 / 判定 / 落盘一律由 gate/lib/runner.mjs 负责**；本文件**不得**自己判 PASS，
 *   也不得读别人的输出后"替它下结论"。
 *
 * ★ R2：本文件现在是该域**唯一**的事实来源（single source）。
 *   `gate/tasks/guards-suite-r1.json` 由 `gate/scripts/gen-tasks.mjs` 从 `buildTask()` **生成**，
 *   并由 `gen-tasks.mjs --check` 机械核对。R1 时两者靠 `_provenance` 里一句"以描述符为准"的
 *   **散文**承诺 —— 那是自述，不是检查项；R2 把它换成检查。
 *
 * ★ R10（2026-11-03，T8-A 收窄授权）：`GUARD_TESTS[].path` 里的 `guards/<plugin>/...`
 *   **不再当路径用**，只当「插件 + 相对路径」的**键**；真正的落点由 `locatePath()`
 *   在生成描述符时**从树里发现**（先看 `guards/<plugin>/`，再看 `guards/<容器>/<plugin>/`；
 *   容器唯一才认，`_retired*` 历史快照排除，不唯一就响亮失败）。
 *   原因：`guards/<plugin>/test/*` 自本树首个提交起就不存在 ⟹ 12/12 一路 MISMATCH，是真 bug。
 *   **不得**把容器名写死；**不得**因此声称"镜像可复现"（镜像受 verify-all G4 逐字节约束）。
 *
 * 实测基线（2026-11-03 R10，本树实跑，非历史数字）：**9/12 exit=0**；
 *   G06/G07 红（ENOENT `.cache/dsh-guard/mcp-tools.txt`，未入库生成物）、G09 红（宿主 profile 绝对路径）
 *   ⟹ 这三条是**环境测试**，红就写红。2026-10-16 的"12/12 全绿"是旧树旧环境记录，**已作废**。
 * 判据只用**真实退出码**——理由见 INVENTORY §3.2：
 *   · `routes.mjs` 的 stdout 含 `mkdtemp` 路径，逐次不同 ⟹ 输出不可作判据；
 *   · `audit-allow.mjs` / `validate-patch.mjs` **没有终判串** ⟹ 只能靠退出码，
 *     其 oracle 记为 `exit_code`（弱），**不冒充**成有结论串的强证据。
 * 对其余 10 个，另给一条 `stdout_contains:` 结论串佐证 —— 退出码说"过"而文本里看不到结论串时，
 * runner 会**按最强者取红**。
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');   // 仓库根（gate/ 的上一级）
const GUARDS = join(ROOT, 'guards');

/**
 * ★ R10：路径**发现**（不是路径**约定**）。
 *
 * 需求（T8-A）：descriptor 的落点必须从树里发现镜像位置，**不许**硬编码 `guards/<plugin>`。
 * 步骤：① `guards/<plugin>/test` 在 ⟹ 就是它；② 否则在 `guards/` 的**一层子目录**里找
 * `<子目录>/<plugin>/test`；③ 候选唯一才认；0 个或多个 ⟹ 抛错（响亮失败，不猜）。
 * `_retired*` 是历史快照，永不当现役落点。
 */
const RETIRED_RE = /^_retired/i;

/** 插件现役容器：'' = 直接位于 guards/<plugin>；其它 = guards/<容器>/<plugin>。 */
function discoverContainer(plugin) {
  if (existsSync(join(GUARDS, plugin, 'test'))) return '';
  let cands;
  try {
    cands = readdirSync(GUARDS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !RETIRED_RE.test(d.name))
      .map((d) => d.name)
      .filter((n) => existsSync(join(GUARDS, n, plugin, 'test')));
  } catch (err) {
    throw new Error(`[guards-suite] 读不到 ${GUARDS}（${err.message}）⟹ 无法发现现役插件 ${plugin}`);
  }
  if (cands.length === 1) return cands[0];
  if (cands.length === 0) {
    throw new Error(`[guards-suite] 树里找不到现役插件 ${plugin}：guards/${plugin}/test 与 guards/*/${plugin}/test 均不存在`);
  }
  throw new Error(`[guards-suite] 插件 ${plugin} 在多个容器里都有副本：${cands.join(', ')} —— 拒绝猜，先清理`);
}

/** `guards/<plugin>/<rel>` 的真实落点（相对工作区根，正斜杠）。 */
export function locatePath(key) {
  const parts = String(key).replace(/^guards\//, '').split('/');
  const plugin = parts.shift();
  const rel = parts.join('/');
  const c = discoverContainer(plugin);
  return c ? `guards/${c}/${plugin}/${rel}` : `guards/${plugin}/${rel}`;
}

/** 12 个现役测试（`path` 是**键**，落点由 locatePath() 发现）。`needle=null` = 该脚本无机器可读终判串（弱判据，如实标）。 */
export const GUARD_TESTS = [
  { id: 'G01', path: 'guards/guard-ui/test/client-smoke.mjs', what: 'guard-ui 客户端半冒烟（含"渲染不含 undefined"）', needle: 'guard-ui 客户端半冒烟全部通过' },
  { id: 'G02', path: 'guards/guard-ui/test/loadable.mjs', what: '静态可加载性：缺 webServer 时 apply 必须抛（不静默降级）', needle: '静态可加载性自检全部通过' },
  { id: 'G03', path: 'guards/guard-ui/test/redteam.3.mjs', what: '红队 F1–F4 修复验证（symlink/junction、profile 组合）', needle: '红队 F1–F4 修复验证全部通过' },
  { id: 'G04', path: 'guards/guard-ui/test/routes.mjs', what: 'guard-ui 主机半自测（HTTP 路由契约、坏 settings）', needle: 'guard-ui 主机半自测全部通过' },
  { id: 'G05', path: 'guards/guard-ui/test/settings.mjs', what: 'settings.js 契约自测（含 BOM 处理）', needle: 'settings.js 契约自测全部通过' },
  { id: 'G06', path: 'guards/role-guard/test/audit-allow.mjs', what: 'allow 清单里有没有漏进去的写操作（清单级）', needle: null },
  { id: 'G07', path: 'guards/role-guard/test/selfcheck.mjs', what: '判定器"有没有搞错方向"（断言级）', needle: '全部断言通过' },
  { id: 'G08', path: 'guards/role-guard/test/stub-apply.mjs', what: '插件逻辑本身（stub 应用）；含负控', needle: 'stub 验证全部通过' },
  { id: 'G09', path: 'guards/role-guard/test/validate-patch.mjs', what: '校验构造出的 profile 补丁', needle: null },
  { id: 'G10', path: 'guards/role-guard/test/workspace-override.mjs', what: '每工作区覆盖；坏 cwd 下 reviewer 仍被拒', needle: 'role-guard 工作区覆盖自测全部通过' },
  { id: 'G11', path: 'guards/subagent-sandbox/test/stub-apply.mjs', what: '子代理探针离线自检', needle: '探针离线自检全部通过' },
  { id: 'G12', path: 'guards/subagent-sandbox/test/workspace-override.mjs', what: '子代理侧每工作区覆盖', needle: 'subagent-sandbox 工作区覆盖自测全部通过' },
];

export const NOT_RUN = [
  {
    id: 'N1',
    category: 'capability',
    what: '.cache/dsh-guard/link_gate.py（链接门禁）',
    why: '① 实测**永不判红**：`ok=67 missing=2` 仍 exit=0（源码里 bad 只参与打印）⟹ 不可作验收判据；'
      + '② 它是**全工作区扫描**，别人改文档就会移动数字（missing 今日 1→2）⟹ 要当判据必须"钉基线"；'
      + '③ 有越界副作用：写 `.cache/dsh-guard/link-gate-result.txt`（**内容幂等、mtime 非幂等**），不在本 slice 写域内。',
    precondition: '无前置阻碍（它跑得动）—— 是**判据不成立**而非"跑不了"：它恒返回 0。'
      + '要用它就必须先把期望值钉进描述符，并接受它会写 `.cache/dsh-guard/**`。',
    realCommand: 'python .cache/dsh-guard/link_gate.py',
    cwd: '.',
    exitSemantics: '恒 0（无判据能力）',
  },
  {
    id: 'N2',
    category: 'capability',
    what: 'smart_home/slices/_common/*（第一代收口层）与 sync-templates.ps1',
    why: '属 smart_home/ 域且多数会写 smart_home/**（不在本 slice 写域内）。已在 INVENTORY §1 逐条登记，本轮不实跑。',
    precondition: '需要写 smart_home/**（多个脚本会改 expected-drift.json / NOT_RUN.index.md / STATUS.generated.md）⟹ 越界。',
    realCommand: null,
    cwd: 'smart_home/slices/_common',
    exitSemantics: '0=通过 / 2=判红 / 3=拒绝运行（各脚本不完全一致，见 INVENTORY §1）',
  },
  {
    id: 'N3',
    category: 'capability',
    what: 'lab_2_2_11_wifi-package/**（第二代域内验证）与 fpga/** 各 .tcl',
    why: '需 staging 构建副本／后端进程／Edge／Vivado；已知 lab-console-proof.mjs 在本会话起不来。已在 INVENTORY §2 逐条登记，本轮不实跑。',
    precondition: '需提权（构建产物）+ 后端进程 + Edge/CDP，或 Vivado 2019.1 会话。',
    realCommand: null,
    cwd: 'lab_2_2_11_wifi-package',
    exitSemantics: '见 INVENTORY §2（同一目录里 exit 2 / 转发 / throw 三种语义并存）',
  },
];

/** 该域任务的元数据（描述符的**生成源**）。 */
export const TASK_META = {
  taskId: 'guards-suite-r1',
  level: 'L2-F',
  claimsWhat: '本工程现役验证（由本适配器在生成描述符时**从树里发现**的 guard-ui/role-guard/subagent-sandbox 三插件 test/ 共 12 个）—— 本次实测 **9/12** 真实退出码 0；G06/G07/G09 为**环境测试**（分别依赖未入库的 .cache 生成物、宿主 profile 绝对路径），红就写红、不降 notRun 也不改判据凑绿；每个脚本至少证明它自己声称的那一组断言（逐条 what 见 acceptance）',
  owner: 'writer-gate',
  round: 1,
  date: '2026-10-16',
  _provenance: {
    note: '★ 本描述符由 gate/adapters/guards-suite.mjs#buildTask() **生成**（R2 起单一事实来源）；用 `node gate/scripts/gen-tasks.mjs --check` 机械核对，不再靠散文承诺。',
    adapter: 'gate/adapters/guards-suite.mjs',
    measuredBaseline: '2026-11-03 R10 本树实跑：9/12 真实 exit=0；G06/G07 红（ENOENT .cache/dsh-guard/mcp-tools.txt）、G09 红（宿主 profile 绝对路径）—— 三条均为环境测试。**2026-10-16 的"12/12 全绿"是旧树旧环境记录，已作废**；不得据此声称镜像可复现（镜像受 verify-all G4 逐字节约束）。',
    oraclePolicy: '判据只用【真实退出码】。routes.mjs 的 stdout 含 mkdtemp 路径、逐次不同 ⟹ 不作判据；audit-allow.mjs / validate-patch.mjs 无终判串 ⟹ 其 oracle 为 exit_code（弱），不冒充结论串证据。其余 10 个另给 stdout_contains 结论串佐证；退出码说"过"而文本无结论串时 runner 按最强者取红。',
    knownSideEffects: [
      { path: '.cache/dsh-guard/js-allow.txt', by: 'G07', kind: '测试重新生成清单' },
      { path: '.cache/dsh-guard/js-deny.txt', by: 'G07', kind: '测试重新生成清单' },
      { path: '.cache/dsh-guard/profile-patch.CONSTRUCTED.yml', by: 'G09', kind: '测试构造产物' },
    ],
  },
  noWrite: [
    'guards/guard-ui/lib',
    'guards/role-guard/lib',
    'guards/subagent-sandbox/lib',
    'slices/guard-ui',
  ],
  rollback: '本任务只读（noWrite 覆盖三个 guard 的 lib/ 与 slices/guard-ui/）；删 gate/evidence/gate-guards-suite-r1-*.json 即可。测试自身会重新生成 .cache/dsh-guard/{js-allow.txt,js-deny.txt,profile-patch.CONSTRUCTED.yml}（已登记为已知副作用，不在本 slice 写域）。',
  // ★ R3a：收口时（gate/close.mjs）要重算的文件 —— 这份证据"钉住"的判据机器。
  hashFiles: ['gate/adapters/guards-suite.mjs'],
  refs: [
    'slices/gate/TASK.1.md §3.1 §3.2 §3.5 §4-A3',
    'gate/_recon/INVENTORY.md §3.2',
    'gate/adapters/guards-suite.mjs',
  ],
};

/** 把任务映射成断言数组。**只映射**，不执行、不判定。 */
export function toAssertions() {
  const acceptance = GUARD_TESTS.map((t) => ({
    id: t.id,
    what: t.what,
    cmd: 'node',
    args: [locatePath(t.path)],
    cwd: '.',
    exit: 0,
    // 结论串佐证：只有那些**确实有稳定终判串**的测试才给（10/12）；
    // 其余两个（G06/G09）保持纯 exit_code —— 不伪造判据。
    ...(t.needle ? { assert: `stdout_contains:${t.needle}` } : {}),
  }));
  return { acceptance, notRun: NOT_RUN };
}

/** 供 gen-tasks.mjs 生成完整描述符。 */
export function buildTask() {
  const { acceptance, notRun } = toAssertions();
  return {
    ...TASK_META,
    acceptance,
    notRun,
    // noWrite 里 `guards/**` 的条目同样走发现（`slices/guard-ui` 等非 guards 路径原样保留）
    noWrite: TASK_META.noWrite.map((p) => (String(p).startsWith('guards/') ? locatePath(p) : p)),
    files: GUARD_TESTS.map((t) => locatePath(t.path)),
  };
}

export function describe() {
  return { domain: 'guards', tasks: [TASK_META.taskId], assertions: GUARD_TESTS.length, notRun: NOT_RUN.length };
}
