/**
 * gate/adapters/android.mjs —— `android` 域适配器。
 *
 * ★ 本域在本沙箱**跑不了**（TASK.2 §1）：主仓库 `E:\ChongyouGreenbike` 对本工作区**只读**
 *   （实测 `Set-Content` → 访问被拒绝），而 `gradlew testDebugUnitTest` 必须写构建产物；
 *   模拟器/实机点击还需要设备与 `mobile-automator-*` 工具链。
 *
 * ★ 硬要求（TASK.2 §1/§3-A3）：**零 PASS 断言**。
 *   本适配器返回 `acceptance: []`，只给 `notRun[]` —— 每条写清**真命令 + 退出码语义 + 前置条件**。
 *   **不降级**成"`exit 0` 就算过"：把跑不了的命令塞进 acceptance 换个退出码，正是本轮要禁的。
 *   只有 notRun 的域，runner 会给出 `verdict=UNVERIFIED` 且**非零退出**（assertions=0, ran=0）。
 */

export const TASK_META = {
  taskId: 'android-r2',
  level: 'L2-F',
  claimsWhat: '（本域本轮**没有任何被验证的主张**）Android 客户端的单元测试与 UI 点击链在本次会话**未被验证**；本描述符的作用是把"跑不了"与"前置条件"写成机械可读的声明',
  owner: 'writer-gate',
  round: 2,
  date: '2026-10-16',
  _provenance: {
    note: '★ 本描述符由 gate/adapters/android.mjs#buildTask() 生成；用 `node gate/scripts/gen-tasks.mjs --check` 机械核对。',
    adapter: 'gate/adapters/android.mjs',
    baseline: '实测（2026-10-16）：主仓库 `Set-Content` → 访问被拒绝；`gradlew.bat` 位于 E:\\ChongyouGreenbike\\前端项目文件\\Android客户端\\ChongyouGreenBike\\gradlew.bat（存在）。',
    zeroPassPolicy: '本域**只出现在 notRun[]**：acceptance 为空 ⇒ runner 产出 assertions=0、ran=0、verdict=UNVERIFIED、非零退出。**没有**任何 PASS 断言，也没有把"跑不了"换成 exit 0。',
    noAbsolutePaths: '为保持冻结件可复现，真命令里的主仓库路径一律写成 `<MAINREPO>` 占位符（= `E:\\ChongyouGreenbike`，本机值记录在 REPRO 里），不把机器绝对路径钉进描述符。',
  },
  noWrite: [],
  rollback: '本任务不执行任何命令（acceptance 为空）⟹ 无副作用；删 gate/evidence/gate-android-r2-*.json 即可。',
  // ★ R3a：收口时（gate/close.mjs）要重算的文件 —— 本域证据钉住的判据机器。
  hashFiles: ['gate/adapters/android.mjs'],
  refs: [
    'slices/gate/TASK.2.md §1（android 行）§3-A3',
    'AGENTS.md §7（Android: gradlew testDebugUnitTest）',
  ],
};

export const NOT_RUN = [
  {
    id: 'AN1',
    category: 'capability',
    what: 'Android 单元测试 `testDebugUnitTest`',
    why: '主仓库对本工作区**只读**，而 Gradle 必须写 `build/**`（实测 `Set-Content` → 访问被拒绝）⟹ 本沙箱内无法真跑。',
    precondition: '① 主仓库可写（需提权）；② JDK 17；③ 仓库内 `gradlew.bat`（实测存在）。三条缺任一条都跑不了。',
    realCommand: 'gradlew.bat testDebugUnitTest',
    cwd: '<MAINREPO>\\前端项目文件\\Android客户端\\ChongyouGreenBike',
    exitSemantics: '0 = 单测通过；非 0 = 失败。**注意**：Gradle 的 1 也可能是工具/环境问题（SDK 缺失、依赖下载失败），'
      + '所以真纳入时要配 `envFailCodes`，否则会把"环境没起来"读成"测试红了"（见 SPEC §3.2 之 3）。',
  },
  {
    id: 'AN2',
    category: 'capability',
    what: '模拟器/实机 UI 点击链（mobile-automator-* 那一套）',
    why: '需要 Android SDK + 模拟器或实机 + adb；本会话没有可用设备，且启动模拟器需要提权与硬件加速。',
    precondition: '① 主仓库可写；② Android SDK / 平台工具；③ 可用模拟器或实机（adb devices 非空）；④ 提权。',
    realCommand: null,
    cwd: '<MAINREPO>\\前端项目文件\\Android客户端\\ChongyouGreenBike',
    exitSemantics: '（本轮无可用链路，未取到退出码语义）',
  },
];

export function toAssertions() {
  // ★ 刻意为空：本域本轮不可验证 ⟹ 不许有任何 PASS 断言。
  return { acceptance: [], notRun: NOT_RUN };
}

export function buildTask() {
  const { acceptance, notRun } = toAssertions();
  return { ...TASK_META, acceptance, notRun };
}

export function describe() {
  return { domain: 'android', tasks: [TASK_META.taskId], assertions: 0, notRun: NOT_RUN.length };
}
