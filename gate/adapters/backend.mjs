/**
 * gate/adapters/backend.mjs —— `backend` 域适配器。
 *
 * ★ 本域在本沙箱**跑不了**（TASK.2 §1）：需要提权 + 服务进程 + H2/DB + 端口。
 *   直接证据：`lab_2_2_11_wifi-package/backend/scripts/run-verification.ps1` 必须在 staging
 *   构建副本里跑 Gradle（四阶段 red/base/green/full），而构建副本与 `GRADLE_USER_HOME`
 *   都要可写；另有 `page-contract-check.mjs` / `lab-console-proof.mjs` 需要后端**已经在跑**。
 *
 * ★ 硬要求（TASK.2 §1/§3-A3）：**零 PASS 断言**，只给 `notRun[]`。
 *   **不降级**成"`exit 0` 就算过"。
 */

export const TASK_META = {
  taskId: 'backend-r2',
  level: 'L2-F',
  claimsWhat: '（本域本轮**没有任何被验证的主张**）后端测试与页面契约在本次会话**未被验证**；本描述符把"跑不了"与"前置条件"写成机械可读的声明',
  owner: 'writer-gate',
  round: 2,
  date: '2026-10-16',
  _provenance: {
    note: '★ 本描述符由 gate/adapters/backend.mjs#buildTask() 生成；用 `node gate/scripts/gen-tasks.mjs --check` 机械核对。',
    adapter: 'gate/adapters/backend.mjs',
    baseline: '实测（2026-10-16）：主仓库只读；`<MAINREPO>\\后端项目文件\\greenbike-server\\gradlew.bat` 存在；'
      + '第一代 `smart_home/slices/_common/` 与第二代 `lab_2_2_11_wifi-package/` 的域内脚本已在 INVENTORY §1/§2 逐条登记。',
    zeroPassPolicy: '本域**只出现在 notRun[]**：acceptance 为空 ⇒ assertions=0、ran=0、verdict=UNVERIFIED、非零退出。',
    noAbsolutePaths: '主仓库路径写成 `<MAINREPO>` 占位符（= 主仓库根），避免把机器绝对路径钉进冻结件。',
  },
  noWrite: [],
  rollback: '本任务不执行任何命令（acceptance 为空）⟹ 无副作用；删 gate/evidence/gate-backend-r2-*.json 即可。',
  // ★ R3a：收口时（gate/close.mjs）要重算的文件 —— 本域证据钉住的判据机器。
  hashFiles: ['gate/adapters/backend.mjs'],
  refs: [
    'slices/gate/TASK.2.md §1（backend 行）§3-A3',
    'gate/_recon/INVENTORY.md §1 §2',
    'AGENTS.md §7（后端: gradlew test）',
  ],
};

export const NOT_RUN = [
  {
    id: 'BN1',
    category: 'capability',
    what: '后端单元/集成测试 `gradlew test`',
    why: 'Gradle 必须写 `build/**` 与 `GRADLE_USER_HOME`，而主仓库对本工作区**只读**（实测拒绝写入）⟹ 本沙箱内无法真跑。',
    precondition: '① 主仓库可写（需提权）或 staging 构建副本；② JDK 17；③ 可写的 Gradle 用户目录；④ 仓库内 `gradlew.bat`（实测存在）。',
    realCommand: 'gradlew.bat test',
    cwd: '<MAINREPO>\\后端项目文件\\greenbike-server',
    exitSemantics: '0 = 测试通过；非 0 = 失败。**注意**：1 也可能是环境问题（JDK/依赖），真纳入时要配 `envFailCodes`。',
  },
  {
    id: 'BN2',
    category: 'capability',
    what: '四阶段验证 `run-verification.ps1`（red / base / green / full）',
    why: '需要 staging 构建副本 + overlay/restore 改副本源码 + 四次 Gradle 运行；副本与证据目录都要可写。',
    precondition: '① 可写的 staging 副本（`.scratch/greenbike-server` 一类）；② 可写 `GRADLE_USER_HOME`；③ JDK 17；④ 离线依赖缓存。',
    realCommand: 'powershell -File scripts/run-verification.ps1',
    cwd: 'lab_2_2_11_wifi-package/backend',
    exitSemantics: '末尾 `VERIFICATION_EXIT=` 转发 Gradle 退出码（`NO_TEST_RESULTS` 也算 0 —— 这是个弱判据，真纳入时要单独处理）',
  },
  {
    id: 'BN3',
    category: 'capability',
    what: '页面契约 `page-contract-check.mjs` 与真实点击 `lab-console-proof.mjs`',
    why: '两者都要求后端**已经跑起来**并监听端口；且 `lab-console-proof.mjs` 需要 Edge + CDP，本会话已知起不来（Mojo/命名管道被沙箱拒）。',
    precondition: '① 后端进程在监听（需提权启动 + DB + 端口）；② 对 `lab-console-proof.mjs` 另需可用的 Edge/CDP 通道。',
    realCommand: 'node scripts/page-contract-check.mjs',
    cwd: 'lab_2_2_11_wifi-package/backend',
    exitSemantics: '0 + `PAGE_CONTRACT_OK`；否则 `process.exit(1)`（有机器可读结论串，是较强的判据）',
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
  return { domain: 'backend', tasks: [TASK_META.taskId], assertions: 0, notRun: NOT_RUN.length };
}
