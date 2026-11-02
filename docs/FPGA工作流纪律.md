# FPGA 工作流纪律（移植自 run-fpga-workflow，第一层：判定规则）

**位置：`%MAIN_REPO%-dsh\docs\FPGA工作流纪律.md`（本工作区，可写）**
**性质：判定规则与证据口径。不是工具，不是插件，不含 13 个 agent 定义。**
**来源：`%USERPROFILE%\.agents\skills\run-fpga-workflow\`（v0.4.0）+ `%USERPROFILE%\.codex\agents\*.toml`**

---

## 0. 这份文件是什么、不是什么

**是什么**：把 `run-fpga-workflow` 里**跟工具和目录无关的判定规则**搬到 DSH 侧——
模式路由、claim 分档、失败分类、证据分级、单写者、修复轮次上限。

**不是什么**：

- ❌ 不是 13 个 agent 定义（那是 Codex `agents/*.toml` 格式，DSH 用不了）
- ❌ 不是 9 类 JSON 工件 schema（第一层不引入，见 §9）
- ❌ 不是 Codex 的 `project/par` 目录规范（你现有布局不套这个）
- ❌ 不是 skill（没有 SKILL.md 的 name/description 机制，是纯纪律文档）

**为什么只搬这些**：原 skill 的价值不在那 9 个 JSON，在**它的分类学**——
它逼你把"我改了什么、影响什么、凭什么说对了"写清楚。
工具和目录是它的实现细节，跟你现有纪律冲突，裁掉。

> ⚠️ 原 skill 规定产物写 `codex_out/<run-id>/`。本文件改为**本工作区**：
> `%MAIN_REPO%-dsh\fpga_out\<run-id>\`。
> 理由：主仓库对本工作区只读（细则见 [工作区手册](工作区手册.md) §2.1；纪律见 `AGENTS.md` §2 第三条），产物不该进仓库。

---

## 1. 三种模式：先定模式，再动手

**写操作需要明确授权**（用户说了"实现 / 改 / 修 / 构建"）。**风险永远不扩大授权。**

| 模式 | 何时用 | 允许做什么 |
| --- | --- | --- |
| `ANALYZE` | 分析、诊断、设计、评审 | **纯只读**。不出 RTL、不改约束。 |
| `QUICK` | 已授权、小、保接口、单时钟、低风险 | 小改。不做 FULL 的流程。 |
| `FULL` | 新 RTL、流水/FIFO/RAM 行为、CDC/RDC、regmap/IRQ/DMA、约束、厂商 IP、外部时序、高能量控制、大重构 | 全流程 |

### 1.1 QUICK 的禁用清单（原文照搬，逐条对应本仓库）

**以下任一成立，就不许用 QUICK，必须走 FULL：**

- 涉及时钟/复位跨域
- 触及已发布接口
- 改变可观测延迟或吞吐
- 外部时序
- 厂商 IP 或约束
- 安全 / 能量输出（**对应本仓库：电机驱动、H 桥、锁控**）
- 可能丢数据
- 存在关键歧义

> 对你这个项目，**电机与锁控相关的一律 FULL**——`AGENTS.md` **§3 红线 8** 已经定了
> "PL 必须始终保有电机最终关断权"，这类改动没有"小改"可言。

---

## 2. 证据基线：三种事实标签

建立**唯一**证据基线：读适用的 `AGENTS.md`、需求、SSOT、接口/寄存器来源、RTL、
约束、测试、脚本、**已安装工具版本**、当前报告、当前 diff。**保护用户已有改动。**

每个事实必须标为三者之一：

| 标签 | 含义 |
| --- | --- |
| `CONFIRMED` | 有直接证据（代码、报告、实测） |
| `INFERRED` | 由证据推得，未直接验证 |
| `UNKNOWN` | 不知道 |

**绝不虚构**：器件/封装、引脚、电压、时钟/复位、地址、协议、IP 配置、厂商命令、结果。

> 这条与 AGENTS.md 第 2 节第二条完全同源——**"证据优先于叙述"**。
> 原 skill 把"工具版本"也列进基线，值得抄：**报告离开工具版本就没有意义**。

---

## 3. claim_stage：给当前主张定一档

**按主张选流程，不要为最大化流程而选。** 每次工作用一个 `claim_stage` 限定：

`PREFLIGHT` → `COMPILE` → `SIM_SMOKE` → `FUNCTIONAL_SIM` → `SYNTHESIS` →
`IMPLEMENTATION_QOR` → `TIMING_CLOSURE` → `FORMAL` → `RELEASE` → `BOARD_PREP`

**关键规则**：**compile/smoke 不得自动触发完整 CDC/STA/P&R/formal/release。**
一个 `SIM_SMOKE` 的主张，不需要跑实现，也不该因为"没跑实现"被判失败。

---

## 4. 三档证据档案

| 档案 | 适用 | 要求 |
| --- | --- | --- |
| `DIAGNOSTIC_SMOKE` | 源码检索、编译、elaboration、有界运行、日志收集、路径/工具诊断 | 记录**精确命令、工具/版本、退出码、重要警告、输出路径**。独立模型/完整 scoreboard/负向 canary **可选**。结果只能是 `DIAGNOSTIC_ONLY` 或 `INCONCLUSIVE`——**永远不能叫 `SIMULATION_PASS`** |
| `FUNCTIONAL_ACCEPTANCE` | 结果将用于**接受 DUT 行为** | 激活完整仿真证据规则（§5） |
| `SPECIALIST_ACCEPTANCE` | 只主张某一族证据（formal / CDC-RDC / 实现-STA / 电气 / release） | **只激活被主张的那一族**，其余全部保持 `NOT RUN` 或 `UNVERIFIED` |

> 最后一列是重点：**没跑的东西标 `NOT RUN`，不是罪。假装跑了才是。**
> 这与 `AGENTS.md` **§3 红线 10**（没跑的检查必须标 `NOT RUN`）是同一件事。

**Power 默认 `NOT APPLICABLE`**，除非有真实预算或 release 主张激活它。

---

## 5. 仿真证据完整性（FUNCTIONAL_ACCEPTANCE 才用）

**验证从需求导出，不从当前 DUT 行为导出。**

禁止：

- 把 DUT RTL 抄进参考模型
- 读 DUT 内部状态来改期望值
- 把期望延迟**适配**成观测到的实现延迟
- 声称"被 force / 被 bypass 的功能"已验证

`FUNCTIONAL_ACCEPTANCE` 的 scoreboard 必须**按周期索引**：
记录接受输入沿与 tag、应到周期/窗口、期望数据/sideband/错误、观测沿、
以及 早到/迟到/丢失/重复/乱序 的判定结果。

关键验收 checker 需要**隔离的负向 canary**。

> **`$stop`、干净的日志、没有独立 checker 的波形，都不是功能验收的证明。**

---

## 6. 失败分类：先分类，再路由（**本文件对你最有用的一节**）

失败必须**先分类**，再决定派给谁修：

| 分类 | 归属 |
| --- | --- |
| `DUT_FAIL` | → 产品 RTL（**唯一直接路由到 RTL 的**） |
| `TESTBENCH_FAIL` | → 验证资产 |
| `REFERENCE_MODEL_FAIL` | → 参考模型 |
| `ASSERTION_FAIL` | → 断言/验证资产 |
| `SCRIPT_PATH_FAIL` | → 脚本/路径 |
| `COMPILE_ELAB_FAIL` | → 编译/elaboration |
| `TOOL_ENV_FAIL` | → **工具环境**，不是 RTL |
| `VENDOR_LIBRARY_FAIL` | → **厂商库**，不是 RTL |
| `TIMEOUT_HANG` | → 挂起诊断 |
| `INCONCLUSIVE` | → 证据不足 |

**两条硬规则**：

1. **只有 `DUT_FAIL` 直接路由到产品 RTL。** 把 `TOOL_ENV_FAIL` / `VENDOR_LIBRARY_FAIL`
   误当成 RTL bug 去改代码，是这套流程最想防的事故。
2. **手工波形证据与自动化结论矛盾时，撤销 `SIMULATION_PASS`**，
   先修/审验证资产。

**仿真永不签署 CDC/RDC 或 STA。** 这是两类独立证据。

> 原 skill 特别重复了三次"环境/路径/库失败不得误路由进 RTL 改动"
> （`fpga_reviewer.toml` 第 8 节），说明这是高频真实事故。

---

## 7. findings 生命周期与修复上限

### 7.1 状态机

`OPEN` → `FIXED_PENDING_REVIEW` → `VERIFIED_CLOSED`；旁支：
`DUPLICATE` / `DISPUTED` / `NOT_APPLICABLE` / `ACCEPTED_RISK`

**写者不能关闭自己提出的 findings。** 审查者**永不**把 findings 改掉（只能改状态并留证据）。

### 7.2 修复轮次上限（原文规则）

- **最多 3 轮**自动修复/复审。
- **第 1 个无进展轮**：停止盲目编辑，与架构师和受影响 specialist **重建根因**。
- **连续 2 个无进展轮**，或第 3 轮后仍有 open `BLOCKER`/`HIGH`：**停止并报告证据边界。**

**什么叫"有进展"**（原文定义，很严格）：

- open `BLOCKER`/`HIGH` **变少**，或
- **首次失败点后移**，或
- 失败特征**有可解释的变化**，或
- **新增了必需证据**

**不算进展**：改措辞、无关 diff。

> 这条对 CI 式长跑特别重要——它给"改不动了还硬改"设了硬闸门。

### 7.3 严重度

`BLOCKER` / `HIGH` / `MEDIUM` / `LOW`

**open `BLOCKER`/`HIGH` 阻止无条件通过。**

---

## 8. 单写者规则（**这套东西的核心**）

> **同一 checkout 内，只有一个 writer。**

原 skill 的角色分工：

| 角色 | 写什么 | 沙箱 |
| --- | --- | --- |
| `fpga_engineer` | 产品 RTL、约束、平台 wrapper、regmap 实现、构建脚本 | **可写**（唯一） |
| `embedded_engineer` | 固件/驱动（**后续串行批次**） | 可写 |
| `verification_engineer` | testbench / 断言 / 参考模型（**后续串行批次**） | 可写 |
| 其余 10 个 | **只读审查**，永不修 findings | `read-only` |

**关键约束**：

- **一个 checkout 内不得有重叠写者。**
- 一个写批次只能有一个主模式：`RTL_IMPLEMENTATION` / `IP_INTEGRATION` /
  `BUILD_FLOW` / `PHYSICAL_IMPLEMENTATION` / `RELEASE_PACKAGING`
- **写完一个自洽切片 → 冻结 diff/hash checkpoint → 只读审查者对着该快照审 →
  合并成一份 findings ledger → 把稳定 ID 交回写者**
- **验证作者不能签署自己创建或修改过的模型/checker 产出的证据**（作者独立性）

### 8.1 DSH 侧怎么落地（重要差异）

Codex 用 `sandbox_mode = "read-only"` **强制**只读。**DSH 的 `spawn_teammate` / `subagent`
没有这个字段**——你无法在工具调用层面强制一个 teammate 只读。

**当前可用的手段（2026-10-21 更新：第 3 条已落地）**：

1. **纪律**：在 teammate 的 prompt 里写明"只读，不得调用写工具"。
2. **工具面**：给只读审查者**不给写工具**（在授权书里限定其职责范围）。
3. ✅ **硬约束（已实施）**：`role-guard` 的 `restrictMcpWriteTools: 'hard'` 会对**非 writer 成员**
   调 `ctx.tools.restrict({ deny })`，把**写类 MCP 从模型工具面移除**（线上实测 `hard-mask-applied count=498`，
   `TOOL_ABSENT` ×2）。⚠ **只掩继承层** —— `read`/`write`/`pwsh`/`send_message` 掩不到。

> ⚠️ 别再走 `agent.ctx.tools.guard(fn)` 那条老路：**2026-10-21 实测它会拖垮该 agent 的全部工具管线**
> （`read`/`write`/`send_message` 全 `Error: null`）。归因与对照实验见 `ARCHITECTURE.md §10.3`。

**诚实的结论（已更新）**：纪律 + **写类 MCP 硬掩码**已在位；**仍是软的两处**是——
① **shell 面**（`shellScope` 文本匹配，可绕）；② **逐工具审批**（DSH 没有这个字段）。

---

## 9. 工件：按需，不要为绿而绿

原 skill 有 9 类 JSON 工件。**第一层不强制引入**，但**两条原则照抄**：

1. **只为支撑当前主张而建工件。** 小的诊断/冒烟只需要一条命令+结果记录；
   功能/时序/CDC/formal/release 验收才需要相应工件。
2. **不要为了把清单打绿而造工件。** 工件从**实际读到的文件、实际跑的命令、
   实际报告**填充。**工件校验只证明形状，不证明工程正确性。**

**产物落点（本仓库口径）**：`%MAIN_REPO%-dsh\fpga_out\<run-id>\`
（`<run-id>` 建议 `YYYY-MM-DDTHHMMSSZ-<短描述>`）

**若日后要引入工件**，最小可用子集按需取：
`task-contract` / `snapshot-manifest` / `impact-manifest` / `cycle-contract` /
`verification-plan` / `run-manifest` / `simulation-evidence` / `findings-ledger` /
`ip-proof-packet`。schema 原件在
`%USERPROFILE%\.agents\skills\run-fpga-workflow\references\schemas\`。

**快照一致性（这条要抄）**：
> 报告或波形，其 snapshot 与所审 RTL 不一致的，**是陈旧的，不能支撑结论**。

对应你 AGENTS.md 第 2 节"验收看带日期和环境的证据"。

---

## 10. 本仓库裁剪与未实施项

### 10.1 已裁剪（原 skill 有，本文件不要）

| 原内容 | 为什么裁 |
| --- | --- |
| 13 个 agent 定义（`agents/*.toml`） | Codex 专有格式；DSH 无 `sandbox_mode` 字段 |
| `project/par` 等 6 个标准目录 | 规范本仓库不套用，与现有布局冲突 |
| 三厂商适配（Xilinx/Pango/Anlogic） | 本仓库只用 Vivado 2019.1 |
| ModelSim/Questa 专章 | 本仓库未确认使用；用 XSim 时该章不适用 |
| `run.bat` 一键入口契约 | 本仓库用 `gradlew` 与 xtclsh 门禁，不走这套 |
| 私有故障库 hook | 无此数据源 |

### 10.2 未实施（第二层，触发条件才做）

**硬约束插件**：用 `ctx.tools.restrict()` + `ctx.tools.guard()` 实现真只读 FPGA 审查者。

- **能力已确认存在**（`listService('tools')` 实测）：
  - `restrict({allow?, deny?})` —— "Restrict global tools for the calling agent scope"，
    "Restrictions intersect"
  - `guard(fn)` —— "one registered through `agent.ctx` applies only to that agent"，
    "**no guard can force-allow a call another guard denied**"（单调加严）
- **未验证**：`guard` **能否拦住 MCP 工具**（`mcp__vivado__*`）。
  MCP 走独立路径，需要先做实验确认，**不要假设能拦**。
- **触发条件**：长时间 FPGA 自动化任务中，只读纪律被绕过并造成实际损失时。

### 10.3 与原 skill 的关系

原 skill **仍然可用**（在 Codex 侧）。本文件是它在 DSH 侧的**判定规则子集**，
两者不冲突但**不自动同步**——原 skill 升级后本文件需人工核对。

---

## 11. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-10-08 | 建档。第一层（判定规则）落地；裁剪工具/目录/厂商章节；产物落点改本工作区。 | 读 `%USERPROFILE%\.agents\skills\run-fpga-workflow\SKILL.md` + `references/{task-profiles,workflow-artifacts,project-layout}.md` + `%USERPROFILE%\.codex\agents\{fpga_architect,fpga_cdc_timing_reviewer,fpga_reviewer}.toml`；`tools` service 经 `listService` 实测 |
