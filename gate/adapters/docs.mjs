/**
 * gate/adapters/docs.mjs —— `docs` 域适配器（本工作区 `docs/**` 的 Markdown 相对链接）。
 *
 * ★ 契约（TASK.2 §0/§1）：适配器**只做**「任务 → 断言数组」的映射；
 *   执行 / 判定 / 落盘全部由 `gate/lib/runner.mjs` 负责。**不得**自己判 PASS。
 *
 * ★ 本域的核心要求：**必须会判红**。
 *   现场现役的 `.cache/dsh-guard/link_gate.py` 是反面教材（`missing=2` 仍 `exit=0`），
 *   本域**不沿用**它的语义：判据是 `gate/scripts/check-doc-links.mjs` 的真实退出码
 *   （undeclared missing > 0 ⇒ exit 1）。
 *
 * ★ 两条断言是**一对**：
 *   D1 = 真判据（真实 docs + 已声明的例外 ⇒ exit 0）；
 *   D2 = **canary 套件**（`canary-docs.mjs`：造断链⇒红 / 撤销⇒绿 / 真实数据+空例外⇒红 / 零命中⇒不可裁决）。
 *   只跑 D1 无法证明"它会判红"——**恒绿的判据不算判据**，所以 D2 是 acceptance 的一部分，不是附注。
 */

/** 该域任务的元数据（描述符的**生成源**）。 */
export const TASK_META = {
  taskId: 'docs-links-r2',
  level: 'L2-S',
  claimsWhat: '本工作区 docs/** 的 Markdown 相对链接：**未声明的**断链为 0（已声明的 2 条见 exceptions，带理由）；且该判据经 canary 证明"造断链会判红、撤销会判绿、零命中不可裁决"',
  owner: 'writer-gate',
  round: 2,
  date: '2026-10-16',
  _provenance: {
    note: '★ 本描述符由 gate/adapters/docs.mjs#buildTask() 生成；用 `node gate/scripts/gen-tasks.mjs --check` 机械核对。',
    adapter: 'gate/adapters/docs.mjs',
    measuredBaseline: '2026-10-16 实测：docs/ 下 28 个 .md、56 条相对链接，ok=54、未声明断链=0、已声明=2、stale=0。',
    whyNotLinkGate: '`.cache/dsh-guard/link_gate.py` 实测 `ok=67 missing=2` 仍 **exit=0** ⟹ 它不构成判据；本域自实现 `gate/scripts/check-doc-links.mjs`，undeclared missing>0 ⇒ exit 1。',
    declarationPolicy: '已知断链必须写进 `gate/adapters/docs.exceptions.json` 并给理由（与现场 four-layer-pending.json 同族：已知差异要声明，不许删掉以消音）。判据是 undeclared==0，不是"missing 总数"——总数会被别人改文档挪动。',
    stalePolicy: 'exceptions 里已不再断链的条目会打印 STALE 但**不判红**：修好别人的断链是好事，不该把本门搞红；但也绝不允许静默留着。',
    zeroHitPolicy: '扫到 0 条链接 ⇒ exit 2（无法裁决），不是 PASS：一个静默坏掉的范围/过滤器不能因为"没查到东西"而看起来是绿的（同族先例：four-layer-strings.py 把"某层 0 命中"判 FAIL）。',
  },
  noWrite: ['docs'],
  rollback: '本任务只读（noWrite 覆盖 docs/，共 28 个文件）；删 gate/evidence/gate-docs-links-r2-*.json 即可。canary 合成树只写在 gate/.canary/**（收尾删除），不碰 docs/**。',
  // ★ R3a：收口时要重算的文件 —— 判据机器 + 例外表。
  //   本域两条断言都是 `stdout_contains:`，不按路径点名 ⟹ 若不显式声明，
  //   `evaluated[].files[]` 会是**空的**，"哈希漂移"这条拒绝路径就无哈希可查（等于不可达）。
  hashFiles: [
    'gate/adapters/docs.mjs',
    'gate/adapters/docs.exceptions.json',
    'gate/scripts/check-doc-links.mjs',
    'gate/scripts/canary-docs.mjs',
  ],
  refs: [
    'slices/gate/TASK.2.md §1 §2 §3-A2',
    'gate/scripts/check-doc-links.mjs',
    'gate/scripts/canary-docs.mjs',
    'gate/adapters/docs.exceptions.json',
  ],
};

export const NOT_RUN = [
  {
    id: 'DN1',
    category: 'capability',
    what: 'Markdown 锚点（`#标题`）是否存在',
    why: '本检查在解析链接时**剥掉** `#fragment` 后只判路径存在性。锚点校验需要一个 标题→锚点 的解析器（各 Markdown 方言规则不同），本轮不做。',
    precondition: '需要引入/实现 Markdown 锚点规则（含中文标题、重复标题去重规则）；本轮范围外。',
    realCommand: null,
    cwd: 'docs',
    exitSemantics: '（未实现，无退出码语义）',
  },
  {
    id: 'DN2',
    category: 'capability',
    what: '外部 `http(s)://` 链接的存活',
    why: '本检查**跳过**所有外部链接（无法离线判定；且本 slice 明确不联网）。',
    precondition: '需要网络访问；本 slice 禁联网。',
    realCommand: null,
    cwd: 'docs',
    exitSemantics: '（未实现，无退出码语义）',
  },
  {
    id: 'DN3',
    category: 'authorization',
    what: '主仓库设备侧文档链接门禁 `设备项目文件/tools/check_doc_links.ps1`（62 文件 / 339 链接）',
    why: '**并非跑不了**：实测本沙箱**只读可跑**且 `exit 0`、`LINK_CHECK_RESULT: ALL PASS`（2026-10-16）。'
      + '但 TASK.2 §1 把 docs 域范围限定为「本工作区 `docs/**`」，且它读的是主仓库（本 slice 写域之外） ⟹ 本轮不纳入 acceptance。',
    precondition: '无需提权（只读 PowerShell）；需主仓库存在（`<MAINREPO>` 可读）。',
    realCommand: 'powershell -NoProfile -ExecutionPolicy Bypass -File <MAINREPO>\\设备项目文件\\tools\\check_doc_links.ps1',
    cwd: '<MAINREPO>',
    exitSemantics: '0 = LINK_CHECK_RESULT: ALL PASS；1 = 有断链；2 = root 不存在',
  },
];

export function toAssertions() {
  const acceptance = [
    {
      id: 'D1',
      what: 'docs/** 相对链接：未声明的断链为 0（**会判红**：undeclared missing>0 ⇒ exit 1）',
      cmd: 'node',
      args: [
        'gate/scripts/check-doc-links.mjs',
        '--root', '.',
        '--scope', 'docs',
        '--exceptions', 'gate/adapters/docs.exceptions.json',
      ],
      cwd: '.',
      exit: 0,
      assert: 'stdout_contains:DOC_LINK_RESULT: PASS',
    },
    {
      id: 'D2',
      what: 'canary 套件：证明 D1 的判据**有区分能力**（造断链⇒红、撤销⇒绿、真实数据+空例外⇒红、零命中⇒不可裁决）',
      cmd: 'node',
      args: ['gate/scripts/canary-docs.mjs'],
      cwd: '.',
      exit: 0,
      assert: 'stdout_contains:DOCS_CANARY: PASS',
    },
  ];
  return { acceptance, notRun: NOT_RUN };
}

export function buildTask() {
  const { acceptance, notRun } = toAssertions();
  return { ...TASK_META, acceptance, notRun };
}

export function describe() {
  return { domain: 'docs', tasks: [TASK_META.taskId], assertions: 2, notRun: NOT_RUN.length };
}
