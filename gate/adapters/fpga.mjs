/**
 * gate/adapters/fpga.mjs —— `fpga` 域适配器。
 *
 * ★ 本域在本沙箱**跑不了**（TASK.2 §1）：需要提权 + Vivado 2019.1 / `xtclsh`；
 *   且**本项目禁 shell 起 Vivado/xsct**（AGENTS.md 明文：禁的是"能力"不是工具名；
 *   正规路径是 `mcp__vivado__*` / `mcp__fpga-mcp__*`，而本 slice 不驱动 MCP）。
 *
 * ★ 硬要求（TASK.2 §1/§3-A3）：**零 PASS 断言**，只给 `notRun[]`。
 *
 * ⚠ 一条**实测修正**（写进 why，不写假话）：
 *   TASK.2 §1 表把整个 fpga 域的理由写成「需提权 + Vivado / xtclsh」。实测其中**两个**
 *   设备侧门禁是**只读 PowerShell**，本沙箱**跑得动且通过**：
 *     · `设备项目文件/tools/check_doc_links.ps1` → exit 0，`LINK_CHECK_RESULT: ALL PASS`（62 文件/339 链接）
 *     · `fpga_projects/scripts/check_project_drift.ps1` → exit 0，`DRIFT_RESULT: IN SYNC`
 *   所以它们的 `category` 标为 **authorization**（本轮授权不做），**不是** capability（跑不了）。
 *   本轮仍按 §1 不纳入 acceptance（零 PASS 断言），但前置条件按**实测**写。
 */

export const TASK_META = {
  taskId: 'fpga-r2',
  level: 'L2-F',
  claimsWhat: '（本域本轮**没有任何被验证的主张**）FPGA 综合/实现/位流与设备侧门禁在本次会话**未被纳入验收**；本描述符把"跑不了"与"本轮授权不做"分开声明',
  owner: 'writer-gate',
  round: 2,
  date: '2026-10-16',
  _provenance: {
    note: '★ 本描述符由 gate/adapters/fpga.mjs#buildTask() 生成；用 `node gate/scripts/gen-tasks.mjs --check` 机械核对。',
    adapter: 'gate/adapters/fpga.mjs',
    baseline: '实测（2026-10-16）：`G:\\vivado\\Vivado\\2019.1\\bin\\xtclsh.bat` 存在；'
      + '`设备项目文件/fpga/scripts/test_bitstream_gate.tcl` 存在；'
      + '`check_doc_links.ps1` exit 0 / ALL PASS；`check_project_drift.ps1` exit 0 / IN SYNC。',
    zeroPassPolicy: '本域**只出现在 notRun[]**：acceptance 为空 ⇒ assertions=0、ran=0、verdict=UNVERIFIED、非零退出。',
    noAbsolutePaths: '主仓库路径写成 `<MAINREPO>`；Vivado 安装路径写成 `<VIVADO>`（本机 `G:\\vivado\\Vivado\\2019.1`，记录在 REPRO 里）。',
  },
  noWrite: [],
  rollback: '本任务不执行任何命令（acceptance 为空）⟹ 无副作用；删 gate/evidence/gate-fpga-r2-*.json 即可。',
  // ★ R3a：收口时（gate/close.mjs）要重算的文件 —— 本域证据钉住的判据机器。
  hashFiles: ['gate/adapters/fpga.mjs'],
  refs: [
    'slices/gate/TASK.2.md §1（fpga 行）§3-A3',
    'AGENTS.md §7（比特流新鲜度门禁自测）/ §8（设备端安全边界）',
    'gate/_recon/INVENTORY.md §2',
  ],
};

export const NOT_RUN = [
  {
    id: 'FN1',
    category: 'capability',
    what: '比特流新鲜度门禁自测 `test_bitstream_gate.tcl`',
    why: '需要 `xtclsh`/Vivado 会话；而**本项目禁 shell 起 Vivado/xsct**（AGENTS.md：禁的是能力）⟹ 正规路径是 MCP，本 slice 不驱动 MCP。两条合起来 = 本轮跑不了。',
    precondition: '① 一个已批准的 Vivado 执行通道（MCP 会话，或对 shell 起 Vivado 的显式授权）；② `<VIVADO>` 安装存在（实测存在）；③ 设备工程在可读位置。',
    realCommand: 'xtclsh 设备项目文件\\fpga\\scripts\\test_bitstream_gate.tcl',
    cwd: '<MAINREPO>',
    exitSemantics: '打印 `GATE_SELFTEST_RESULT: ALL PASS` 或 `N FAILURE(S)`；`failures > 0` ⇒ `exit 1`（有机器可读结论串，是较强判据）',
  },
  {
    id: 'FN2',
    category: 'capability',
    what: '设备工程漂移门禁 `check_project_drift.ps1`（**实测本沙箱可跑且通过**）',
    why: '**并非跑不了**：实测 `exit 0`、`DRIFT_RESULT: IN SYNC`（2026-10-16），只读 PowerShell。'
      + '本轮按 TASK.2 §1 的口径（fpga 域零 PASS 断言）**授权不做** ⟹ 归 authorization，不归 capability。'
      + '下轮若要把 fpga 域做成"可判红"，它是最省事的第一个候选（已有真判据与退出码）。',
    precondition: '无需提权（只读）；需主仓库可读（`<MAINREPO>`）。',
    realCommand: 'powershell -NoProfile -ExecutionPolicy Bypass -File <MAINREPO>\\fpga_projects\\scripts\\check_project_drift.ps1',
    cwd: '<MAINREPO>\\fpga_projects',
    exitSemantics: '0 = `DRIFT_RESULT: IN SYNC`；1 = 有差异（打印 differing/single-sided 计数）',
  },
  {
    id: 'FN3',
    category: 'authorization',
    what: '设备侧文档链接门禁 `设备项目文件/tools/check_doc_links.ps1`（**实测本沙箱可跑且通过**）',
    why: '**并非跑不了**：实测 `exit 0`、`LINK_CHECK_RESULT: ALL PASS`（62 文件 / 339 链接，2026-10-16），只读 PowerShell。'
      + '本轮按 §1 口径不做 ⟹ 归 authorization。',
    precondition: '无需提权（只读）；需主仓库可读（`<MAINREPO>`）。',
    realCommand: 'powershell -NoProfile -ExecutionPolicy Bypass -File <MAINREPO>\\设备项目文件\\tools\\check_doc_links.ps1',
    cwd: '<MAINREPO>',
    exitSemantics: '0 = `LINK_CHECK_RESULT: ALL PASS`；1 = 有断链；2 = root 不存在（**这才是"会判红"的正例**，与本 slice docs 域同口径）',
  },
  {
    id: 'FN4',
    category: 'capability',
    what: '综合 / 实现 / 位流生成（RTL 或 XDC 改动后必须重跑，见 AGENTS.md §8）',
    why: '需提权 + Vivado 全流程（且陈旧位流会被 `bitstream_gate.tcl` 拦在 `write_cfgmem` 之前）；本 slice 不驱动 MCP、不起 Vivado。',
    precondition: '① 已批准的 Vivado 执行通道；② 大量机时（综合/实现/位流）；③ 写 `fpga_out/<run-id>/`。',
    realCommand: null,
    cwd: '<MAINREPO>',
    exitSemantics: '（本轮未取到；属 FULL 模式任务，判定规则见 AGENTS.md §8 / FPGA工作流纪律.md）',
  },
];

export function toAssertions() {
  return { acceptance: [], notRun: NOT_RUN };
}

export function buildTask() {
  const { acceptance, notRun } = toAssertions();
  return { ...TASK_META, acceptance, notRun };
}

export function describe() {
  return { domain: 'fpga', tasks: [TASK_META.taskId], assertions: 0, notRun: NOT_RUN.length };
}
