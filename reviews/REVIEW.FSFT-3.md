# REVIEW · FSFT-3 —— 智能体架构红队评价

**日期**：2026-10-21 22:54（Etc/GMT-8）  
**范围**：FSFT 组织架构、role-guard、subagent-sandbox、gate-guard、rule-router、verify-all。  
**方法**：代码静态审计 + 独立只读红队；未启动真实 Cordis/Vivado，所有未运行项明确标 `NOT RUN`。  
**证据口径**：本文件只把能落到当前工作区代码/文档行号的内容列为结论；既有 REVIEW.FSFT-1/2 只作历史参考，不替代当前复核。

## 0. 结论先行

**总体判词：PARTIAL / 高风险边界未闭合。**

FSFT 的角色归因和 MCP 工具拒绝已经形成可测试的硬边界；但“上板安全”仍不能由 gate-guard 单独保证。最高优先级风险是：**单个环境变量即可整层关闭上板门（R0）、名单外执行路径可绕过上板闸、gate 异常时 fail-open、证据没有绑定任务/目标器件/实际执行字节、时间戳与配置可伪造**。因此当前架构可作为开发期摩擦和审计辅助，不能把 `verify-all` 全绿或 gate `pass` 解释为“只允许正确位流上板”。

## 1. 高危发现

### R0 · CRITICAL：单个环境变量可整层关闭上板门（`GATEGUARD_OFF`）

**攻击/失效路径**：给进程环境置 `GATEGUARD_OFF` 为任意非空、非 `0`、非 `false` 的值；`tools/pre-execute` 对**名单内**烧板工具直接 `next()`，evidence、pin 漂移、新鲜度、产物探针**全部不执行**。  
**影响**：R1–R7 的判据同时失效，且这是**预期路径**而非异常路径 —— 比 R2 的异常 fail-open 更直接、更容易触发；一次设置即可完成烧板与固化。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:49-50`（`OFF_ENV` 导出）、`:520-524`（置位即 `next()`）、`:491-493`（`truthyEnv`：任何非空且非 `0`/`false` 即为真）、`:526-531`（名单外同样放行，二者叠加）；既有文档已把它记为“逃生舱、不算缺陷”：`guards/_live_mirror/gate-guard/REDTEAM-NOTES.md:26`、`:167`。  
**状态**：代码级 `CONFIRMED`；真实宿主置位后烧板 `NOT RUN`。

**与 R1/R2 的区别**：R1 是“名单外工具没人管”，R2 是“插件自己坏了才放行”，R0 是**名单内工具被主动放行**，且不需要任何异常，也不需要名单外工具。  
**建议**：烧写/固化类动作不得共享该逃生舱；若必须保留，至少 ①只认受控启动参数 ②记录置位者与原因 ③置位时对烧板动作仍 `ask` ④`verify-all` 断言生产配置未置位。

### R1 · CRITICAL（已收窄）：非授权者可经 shell 与范围外 MCP 到达 FPGA 执行面

**判定对象**：本条只约束「**非授权者**」是否够得到烧板/任意执行能力；**授权 writer 的 shell 是设计内执行通道，不计入本条**（用户 2026-10-26 裁定）。理由：writer 是唯一被授权的执行者（烧板/综合/位流归它），而 Lead 与 reviewer 被 `role-guard` 恒判 `enforce`（`guards/_live_mirror/role-guard/lib/index.js:554`、`:568-569`），`program_device` 实测 `TOOL_ABSENT`；给 writer 加 shell 扫描等于绑住自己的执行者，不产生安全收益。

**攻击路径**：非授权角色若能调 `pwsh`/`bash` 直接起 `vivado -mode batch`、`xsct`、`quartus_*`，即绕过 MCP 闸；或 FPGA 能力被挂到范围外/改名的 MCP server 别名上（`mcp__<other>__run_tcl`），gate 直接 `next()`。  
**影响**：绕过 gate evidence、产物探针与门禁日志，直接生成/烧写/固化。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:65-93`（窄名单）；改造后为 `:509-579`（两 namespace 内 23 项显式只读 + 14 项 burn，其余默认拒绝；范围外仍放行）；只读角色的 shell 仅做**命令文本**扫描（`role-guard/lib/index.js:922-933`，自认减速带），writer 在 `:919` 提前 `roleSkip`；`docs/FSFT-架构_v2.md:111-122`（gate 不是能力边界）。

**分割线**（2026-10-26，R0–R2 修复后）：

| 子项 | 状态 |
|---|---|
两个 FPGA namespace 内的 MCP 执行入口 | **已收口**（12 类整体拒绝 + 797 项默认拒绝；OFF 不可绕过） |
授权 writer 用 shell 直连厂商工具 | **设计内**，不是本漏洞；受 `AGENTS.md §3` 红线 12 约束，非机械可拦 |
非授权角色的 shell | **未闭合**：只有文本匹配（可被拼接/变量/`cmd /c`/base64 绕过） |
范围外/改名 MCP server | **未闭合**：fail-open 边界（为不误伤 StudyHub 有意保留） |

**状态**：代码级 `CONFIRMED`；真实烧板 `NOT RUN`。MCP 面已由 R012 收口；shell 与范围外 server 两条仍为残余，需 OS 级能力边界（独立账号 / Job Object / AppLocker / 厂商 exe 租约）才可能真正闭合。

### R2 · CRITICAL：gate-guard 异常路径无条件 fail-open

**攻击/失效路径**：使 `exec.arguments` 取值、证据读取、解析或哈希流程抛异常；外层 catch 记录 `fail-open` 后调用 `next()`。  
**影响**：门禁失效时动作继续执行；日志只能事后说明异常，不能撤销已发生的物理动作。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:517-559`，尤其 `:553-559`。  
**状态**：代码级 `CONFIRMED`；异常注入与真实宿主执行 `NOT RUN`。这是稳定性取舍与安全需求的直接冲突：上板类动作不能与普通工具共享同一 fail-open 策略。

### R3 · CRITICAL：收口证据与本次产物之间缺少“授权前身份匹配”

**攻击路径**：准备任意有效 `.bit`，再提供另一任务的 `gateOk=true/PASS>0` 收口证据；代码会取最新 closure、校验 pin 漂移与新鲜度，但**从不把证据里的任务与本次要烧的产物做匹配**。  
**影响**：跨任务错绑；无关绿证据可授权任意位流。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:192-206`（`parseClosure` **解析出 `taskId` 但判定逻辑从不使用**）、`:280-318`（只取最新收口 + `gateOk`/`PASS` + pin）、`:400-411`（只做时间比较）、`:459-481`（`classifyBurnCall` 确实对候选产物算 `sha256` 并写入日志与 `basis`）。  
**状态**：代码级 `CONFIRMED`；独立任务夹具和真实宿主 `NOT RUN`。

**措辞边界**：产物 hash **存在**（`:459-481`），但它是**事后记录** —— 既不与 evidence 里的期望 hash 比对，也不与 `taskId`、目标 part 绑定，且在 inner 判定返回后才计算（见 R7 的 TOCTOU）。所以缺陷不是“没算 hash”，而是“算了也不参与授权”。缺少的是 `(taskId, part, expected_artifact_sha256)` 三元组与本次调用的强制相等关系。

### R4 · HIGH：未来时间可伪造 fresh

**攻击路径**：修改 evidence `finishedAt` 与 closure `acceptedAt` 为未来时间；只要 pin 与文件存在，`isFresh` 可能判定通过。  
**影响**：陈旧或无关证据可被伪装为新鲜。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:101-123`（fresh 仅比较传入时间与 mtime）；`:265-266`（`nowMs` 参数存在）；`:400-410`（读取自报时间，未校验不得晚于当前时间）。  
**状态**：代码级 `CONFIRMED`；未来时间端到端夹具 `NOT RUN`。

### R5 · HIGH：探针配置错误会退化为无质量体检

**攻击/失效路径**：探针 file/fixture/正则损坏；`compileProbes` 将错误探针移出启用列表，只记日志，插件继续运行；若最终 `probes=[]`，质量检查分支被跳过。  
**影响**：时序/DRC 质量门可能静默退化为通用 PASS + pin/时间检查，形成假通过。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:505-515`（编译错误仅日志）；`:412-438`（空探针不检查）；`guards/_live_mirror/gate-guard/lib/probes.js:121-146`（错误探针被禁用）。  
**状态**：代码级 `CONFIRMED`；损坏 live profile 配置的宿主验证 `NOT RUN`。

### R6 · HIGH：空 pin / UNAVAILABLE hash 可把证据降级为存在性检查

**攻击路径**：构造 `pins:{}`，或给 pin 使用 `UNAVAILABLE...`，同时将 taskState 设为 PASS；当前文件存在时 `verifyPinsNoDrift` 不报漂移。  
**影响**：证据不能证明判定基于哪版源文件，也不能证明关键 pin 完整。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:230-257`，尤其 `:247-250`；调用判定见 `:303-318`。  
**状态**：代码级 `CONFIRMED`；最小伪造 evidence 运行 `NOT RUN`。

### R7 · HIGH：判定与执行之间存在 TOCTOU

**攻击路径**：完成 mtime/探针判定后、`next()` 前替换同一路径位流；外层 artifacts hash 在 inner 判定返回后才计算，不能锁定真正被执行的字节。  
**影响**：日志哈希与实际下发内容可能不同，审计不可复现。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:354-411`（检查结束）；`:459-478`（事后计算 hash）；`:551-552`（随后执行 next）。  
**状态**：代码级 `CONFIRMED`；并发替换夹具 `NOT RUN`。

## 2. 中高风险发现

### R8 · HIGH：subagent-sandbox 的父级解析失败会跳过文件落档

**失效路径**：`agents` 服务缺失、`agents.list()` 抛错、`isOwnedBy()` 抛错，或 `agent/created` 时子代理尚未出现在列表中；`findParent()` 返回 `undefined`，随后 `onlyChildren=true` 被解释为“不是子代理”并直接 `skip-not-child`，没有重试或补挂。  
**影响**：本应被钉入 `fpga-locked` 的子会话可能保留父级/默认文件权限；role-guard 的 MCP 判定不能补救文件写入面。  
**证据**：`guards/_live_mirror/subagent-sandbox/lib/index.js:230-241`（父级查询失败转 undefined）；`:273-290`（转成 `isChild=false` 并跳过）；`:343-348`（仅 permissionPresets 缺失有单独记录）。相关 stub 只提供正常 `agents` 服务：`guards/_live_mirror/subagent-sandbox/test/stub-apply.mjs:22-55`。  
**状态**：代码级 `CONFIRMED`；真实运行期触发、时序竞态和文件写入 `NOT RUN`。现有 README 未明确把“所有权查询不可用”列为 fail-open 风险。

### R9 · MEDIUM：`serviceMissingPolicy=pass` 是可配置的条件性权限风险

**失效路径**：工作区覆盖将 `role-guard.serviceMissingPolicy` 设为 `pass`，且 `agentTeams` 服务暂时不可用；角色判定可按 pass 跳过边界。  
**影响**：服务故障时 MCP / shell 角色边界可能放宽；这是显式配置风险，不是隐蔽注入漏洞。  
**证据**：`guards/_live_mirror/role-guard/lib/index.js:900-918`（服务缺失时读取策略）；`:542-560`（`serviceMissingPolicy=pass` 可返回 skip）；`guards/_live_mirror/guard-ui/lib/settings.js:117-125`（配置白名单允许 pass）；`guards/_live_mirror/role-guard/test/validate-patch.mjs:165-176`（只对 `unknownPolicy=pass` 做硬告警，未对 serviceMissingPolicy=pass 做同等告警）。  
**状态**：代码/门禁失配 `CONFIRMED`；服务故障下 live 行为 `NOT RUN`。需保留“条件性”措辞，不应把该旋钮描述成已发生的攻击。

### R10 · HIGH：`verify-all` 通过面不足以证明 live gate 安全

`verify-all` 只显式执行 13 个 G2 脚本，未覆盖名单外 MCP/shell 旁路、未来时间、伪造 evidence、TOCTOU、真实 `tools/pre-execute` 责任链。G4 只比对 live guard tree 与 manifest，不校验 profile 中 gate 配置、探针配置或配置 hash。  
**证据**：`scripts/verify-all.mjs:197-215`（G2 清单）；`:222-260`（G4 范围）；`:15-16`（明确不跑 live 探测）。  
**状态**：代码/测试覆盖边界 `CONFIRMED`；当前 `verify-all` 实际运行 `NOT RUN`，不能引用历史“18/18”作为现状。

### R9 · MED/HIGH：通信与任务状态只能事后对账，不能保证合规闭环

写手间 `send_message` 仍可直接发生，任务板不在磁盘，审计脚本对快照只原样列出，不能阻断违规通信或证明任务完成与冻结产物同步。  
**证据**：`ARCHITECTURE.md:391-414`；`:596-610`；`docs/FSFT-架构_v2.md:188-200`。  
**状态**：架构自述已承认“只回答发生过什么”；真实会话对账 `NOT RUN`。

### R10 · MED/HIGH：`allowMultipleArtifacts=true` 放宽意图消歧，且 primary 探针可能选错文件

开启该配置后同扩展名多候选不再 `ask`；探针使用 `validFiles.find(...)` 取第一个非 `.ltx` 文件，多个 `.bit` 时调用意图可能漂移。配置 hash 也未进入 decisions.log。  
**证据**：`guards/_live_mirror/gate-guard/lib/index.js:379-397`、`:412-415`、`:512`；`docs/FSFT-架构_v2.md:146-148`（配置 hash 未完成）。  
**状态**：代码级 `CONFIRMED`；live profile 是否启用该开关 `NOT RUN`。

## 3. 已有设计有效处（不等于系统安全）

1. `role-guard` 对 MCP 工具使用 fail-closed 分类，未知 token 默认拒绝：`guards/_live_mirror/role-guard/lib/index.js:257-279`。
2. 子代理默认按责任链归因，写权限不应因未知子代理身份而继承：`guards/_live_mirror/role-guard/lib/index.js:536-560`。
3. gate 已处理空候选、缺失文件、目录、空文件、链接和同扩展名歧义：`guards/_live_mirror/gate-guard/lib/index.js:344-397`。
4. 这些机制的测试仍主要是离线/显式 fixture；不能把它们外推为真实宿主和物理动作验收。

## 4. 修复优先级

1. **先消除 R0/R1/R2**：`GATEGUARD_OFF` 不得覆盖烧写/固化动作；上板/固化工具改为能力层硬隔离；gate 异常、缺失、配置错误对烧写动作必须 deny 或阻断，不能沿用普通工具 fail-open。名单外执行入口要纳入统一能力策略，而不是继续依赖文本/工具名。
2. **再消除 R3/R4/R6/R7**：收口 evidence 必须包含任务 ID、目标 part、产物完整 hash，并由 gate 校验；拒绝未来时间；在执行前后对同一字节做不可变快照或等价锁定，消除 TOCTOU。
3. **收紧 R5/R10**：启用探针数量为 0、编译错误、配置 hash 缺失或多候选意图不明时，对上板动作直接 deny/暂停；将生效配置 hash 写入每条判定。
4. **补 R8/R9 的测试和观测**：增加真实 pre-execute 集成测试及端到端 adversarial fixture；将任务/通信审计纳入可验证的事实链，至少让“未审/未绑定/状态不一致”成为机器可判的阻断条件。

## 5. NOT RUN

- 未启动真实 Cordis、Vivado、fpga-mcp；未执行真实烧板/固化。
- 未在宿主注入 `exec.arguments` getter 异常、证据目录异常、未来时间、`GATEGUARD_OFF` 置位或并发替换。
- 未读取 live profile 的实际 gate 配置并确认 `allowMultipleArtifacts` 当前值。
- 未运行 `node scripts/verify-all.mjs`；其历史输出不作为当前状态证据。
- 未读取任务板 zstd 存档或运行 `audit-session-traffic.mjs` / `audit-session-reads.mjs`。

## 6. 最终评价

FSFT 的**角色边界设计**已经有可复核的硬化方向；FSFT 的**上板安全链**仍是“能力层 + 窄名单 gate + 事后日志”的组合，关键处存在旁路和 fail-open。当前应把系统等级写成：**开发期治理框架，具备部分硬边界；未达到可把 gate pass 当作物理安全保证的等级**。任何更强表述都需要先完成 R0–R7 的代码修复和 live adversarial 验证。
