# dsh-role-guard —— 角色硬边界 guard（含 RT-02 最小实验）

**日期**：2026-10-14
**性质**：实验 + 接线实现（**未执行**：尚未在运行中的 DSH 里加载过）
**上游依据**：
- [红队_smart_home团队结构与权限.md](../../docs/红队_smart_home团队结构与权限.md) §2.2 / §3 RT-02 / §4.2 / §5 建议 A
- [待落地_角色硬边界guard交接brief.md](../../docs/待落地_角色硬边界guard交接brief.md) §1（实验）/ §2（接线）/ §3（交付物）

> **本文件不许被当成「工具级闸已可用」的结论。** 它只证明：接线已写好、判定器已离线自验证。
> **运行期从未加载过**——RT-02 的执行结果见文末「状态」一节，那一栏现在是 `NOT RUN`。

---

## 1. 要解决的唯一问题

> **`ctx.tools.guard()` 能不能拦住 MCP 工具（`mcp__vivado__*` / `mcp__fpga-mcp__*`）？**

这道缝（`ctx.tools.restrict()` / `guard()`）确实存在，但全库未见接线；
而团队结构把「单写者 + 只读审查者」当安全底座，底座却只有纪律。

### 1.1 先于实验拿到的静态证据（不是运行期结论）

本轮**在只读沙箱里**用官方 inspect 拿到了三条硬事实（证据见 §5）：

| # | 事实 | 来源 | 强度 |
|---|---|---|---|
| E1 | MCP 工具**确实注册为全局工具**：`Tool.listTools`（本 agent 视角）列出 `mcp__vivado__list_sessions` / `run_tcl` / `mcp__fpga-mcp__exec_tcl` 等，**共 846 个** | `Tool.listTools` inspect 输出 | `CONFIRMED`（运行期注册表投影） |
| E2 | `restrict` 是 **exact-name 校验**：不认识的名字会抛错，且报错里会**列出全部合法全局工具名** | `app.asar` 实现原文（`tools.restrict() names unknown global tool …; known global tools: …`） | `CONFIRMED`（源码） |
| E3 | `guard` 是**单调加严**且**同步**：返回字符串即拒绝，后续监听器无法翻回允许 | `app.asar` 内 API 清单 + 实现 `guardReason(exec)` | `CONFIRMED`（源码） |

**这三条把「guard 够不够得着 MCP」从推断推进到「强静态证据」**，
但**仍未执行**——静态证据不等于 `dispatch` 前真的被拦。RT-02 仍需跑。

### 1.2 由 E1/E2 直接推出的设计结论（这是本插件形态的由来）

- **主闸门必须是 `guard`，不能是 `restrict`。**
  `restrict` 要确切名单，而 MCP 工具是**会话启动时异步注册**的（连上才注册）；
  挂早了抛异常，挂晚了漏工具。`guard` 用前缀/token 匹配，**名字无关**，没有这个时序洞。
- **`restrict` 只作加固层**（可选），且只在「名字确认就位」时才调用，失败只告警不炸会话。
- **per-agent 必须逐 agent 装**：子 agent 是 fresh scope，**不继承父的工具限制**
  （`app.asar`：`parent tool restrictions and authority are not imported`）。

---

## 2. 实验协议（RT-02，**已执行：CONFIRMED PASS**）

> **结果**：2026-10-14 16:47:21 +08:00 完成，判据达成（结果里出现本插件独有的探针串）。
> 完整记录见 [RT-02_实验记录_20261014.md](RT-02_实验记录_20261014.md)。
> 本节保留**当初定下的协议与判据**，供复跑与审计用。

### 2.1 三条硬要求（brief §1.1 原文约束，本插件按此实现）

| # | 要求 | 本插件的落实 |
|---|---|---|
| ① | 探针必须是**只读** MCP 工具 | 默认探针 `mcp__vivado__list_sessions`；禁止清单（`set_backend` / `run_tcl` / `a_exec` / `program_device` …）已写进 README §4 与 `lib/index.js` 的 `VETO_EXACT` |
| ② | 判据必须能区分「被 guard 拦」与「工具自己失败」 | 探针命中时返回**本插件独有的固定串**：`[role-guard] RT-02 探针命中：…`；只要结果里出现这个串 ⇒ 是 guard 拦的。若返回的是数据/连接错/参数错 ⇒ **不算拦**，重做 |
| ③ | 实验期用 plain-context guard（全局），验完立刻 dispose | 探针走全局 `ctx.tools.guard()`；卸载方式见 §3.4。另：本机 auto-review **只在 preset=`auto` 时拦截**，本会话 preset 非 auto ⇒ 它不参与 |

### 2.2 判定表

```text
PASS    = 结果里出现 "[role-guard] RT-02 探针命中" 且 **没有发生 MCP 往返**
FAIL    = 工具正常返回数据（例如 "当前没有活跃的 Vivado 会话"）⟹ guard 拦不住 MCP
不可判  = 连接失败 / 参数错 / 超时 ⟹ 别当成「拦住了」，重做
```

**「没有发生 MCP 往返」怎么核**：探针选 `list_sessions` 这类**不需要 Vivado 会话**的工具，
它在 `mcp__vivado__` 服务器进程内即可回答。若 guard 生效，服务器侧不应有**新的调用记录**；
对照做法是先跑一次基线（无 guard）拿到它的正常返回，再加载 guard 跑第二次，两次对比。

---

## 3. 落地形态

### 3.1 文件与加载方式（**不落进 profile 的 node_modules**）

`app.asar` 内 `plugin-manager` 的解析原文：

```js
const moduleUrl = isAbsolute(entry.options.name)
    ? pathToFileURL(entry.options.name)      // 绝对路径直接当 ESM 模块加载
    : new URL(entry.options.name, treeBase);
```

⇒ **profile patch 的 `name` 可以直接写工作区里的绝对路径**，插件不必安装进 profile。
本插件就放在工作区，随工作区一起备份/回滚。

### 3.2 profile 补丁（**已应用**）

条目模板见 [profile-patch-entry.yml](profile-patch-entry.yml)，含 dry-run 与 enforce 两段（默认 dry-run）。

**已应用到** `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾（2026-10-14 16:37）；
实解后的完整文件副本见 `.cache/dsh-guard/profile-patch.CONSTRUCTED.yml`。
写回后已用 `test/validate-patch.mjs` 对**写回后的文件本身**做过结构校验：15 个顶层项、
`role-guard` 在末尾、既有条目（`permission` / `skill-filesystem` / 两个 `insert` / `subagent` …）齐在。

**两处硬约束**：
1. **必须重启 DSH**——本机 profile 里**没有 `dsh-hmr` 条目**，
   按 `app.asar`：「未启用 HMR 时，更改在重启后生效」。
2. profile 在沙箱之外（`%USERPROFILE%\.dsh\profiles\desktop\`），
   本会话的 workspace-write 覆盖不到 ⇒ 写入走了一次 `danger-full-access` 提权（用户已批准）。

### 3.3 两种模式

| 模式 | 行为 | 用途 |
|---|---|---|
| `dry-run`（**默认**） | 只记录「本应拒绝谁」到日志，不真拒绝；**探针除外**（探针永远真拒，否则实验观测不到） | 先在活跃会话里验证判定是否正确，避免突然锁死工具 |
| `enforce` | 真拒绝，返回理由字符串 | 实验通过后打开 |

### 3.4 回滚

三种，任选其一（从轻到重）：
1. **改配置**：把补丁里的条目 `disabled: true`，重启；
2. **去条目**：删掉 `cordis.patch.yml` 里这段，重启；
3. **改工作区**：删掉 `guards/role-guard/`（条目会加载失败并报错，**不会静默**）。

`restrict` 那层不改变工具定义，随插件卸载即解除（`Restrictions … lift when disposed`）。

---

## 4. 判定器：口径与自验证

### 4.1 口径

- **只放行 token 级明确只读的 MCP 工具**；其余（含判不出来）**一律拒**（fail-closed）。
- 剥掉 scope 前缀（`a_` / `q_` / `viv_` / `vivado_`）与量词前缀（`all_` / `current_` / `is_`）后，
  **每个 token 都必须在只读词表里**才放行。
- **非 MCP 工具本插件不碰**（`readOnlyDecision` 返回 `null`）。这是刻意的边界声明：
  本插件只负责「MCP 这条唯一没闸的路」，不越权管文件工具（那由会话级 permission preset 管）。

### 4.2 已知的坑（都在本轮被自检或实测抓出来过）

| 坑 | 症状 | 处置 |
|---|---|---|
| **可选加固层拖垮主闸门** ⚠ **最险** | `agentScope` 块里一句 `lookupAgents is not defined`（重构删了定义、留下调用）使 `apply` 抛异常 ⇒ **Loader 回滚 guard 注册 ⇒ 角色主闸门整块失效**；而 `plugin-start` 事件已写，外部看着像"已加载" | 整块包 `try/catch`；`agent.ctx` 缺失只跳过不抛。**铁律：加固层绝不允许影响主闸门**（stub §11 守这条） |
| **stub 不迭代生成器 ⇒ 路径测不到** | 插件用 `agent.ctx.effect(function* () { yield ... })`（官方指引写法），而 stub 直接调 `fn()`、不迭代生成器 ⇒ yield 的注册被静默跳过，per-agent 路径形同未测 | stub 的 `effect` 改为**生成器感知**（`runEffect`），与 Cordis 语义对齐 |
| **新插件写成顶层裸 `- id`** ⚠ **最坑** | DSH 把它当「**按 id 覆盖已有条目**」；`role-guard` 不存在 ⇒ **静默忽略、无 stderr 警告**，探针照常执行 ⇒ RT-02 **假 FAIL** | 新条目必须包在 **`- insert:`** 下；`Config(entry=...)` 报 `unknown entry id` 即为该症状 |
| **子串误判** | 用「含 `lock`」判写 ⇒ `clock` 被误拒；`synthesis` 里的 `synth` 同理 | 改为**按 `_` 切词**的 token 级判定 |
| **`open` 被当只读** | `a_open_run` / `viv_open_run` 是「打开 run 作为 design」，被误放行 | `open` 归入写词；`q_project_open` 进 `VETO_EXACT` |
| **`restrict` 时序** | MCP 未注册时调用会抛 `unknown global tool` | 只在名单就位时调用；失败只告警，guard 主闸门不受影响 |
| **测试用例名字错** | 曾用 `mcp__vivado__report_timing_summary`（**注册表里不存在**）当用例 ⇒ 恒真/恒假，等于没测 | 自检新增**存在性检查**：用例名必须在真实 846 名单里 |
| **Config 目录里查不到 ≠ 没加载** | 插件未声明 Config schema 时，`Config` provider 不列它（对照：顶层 `agent-default-model` / `permission` 同样不列） | 判「有没有加载」要**看运行期行为**（探针是否被拒），不要只看目录 |

### 4.3 自验证（**不需要 DSH、不需要重启**）

```powershell
# 判定器断言（21 条 MUST_DENY + 13 条 MUST_ALLOW，含名字存在性检查）
& %USERPROFILE%\nodejs\node.exe guards\role-guard\test\selfcheck.mjs

# allow 清单安全复核（allow 里还有没有含写动词 token 的）
& %USERPROFILE%\nodejs\node.exe guards\role-guard\test\audit-allow.mjs

# profile 补丁校验：**真 YAML 解析器** + 断言 + 缩进扫描
#   加 RG_VALIDATE_FILE 时校验指定文件本身（用于写回 profile 后的复核）：
$env:RG_VALIDATE_FILE='%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml'
& %USERPROFILE%\nodejs\node.exe guards\role-guard\test\validate-patch.mjs
Remove-Item Env:\RG_VALIDATE_FILE

# 插件逻辑（stub ctx 跑 apply，不需要 DSH、不需要重启）
& %USERPROFILE%\nodejs\node.exe guards\role-guard\test\stub-apply.mjs
```

> YAML 解析器来源：`.cache/dsh-guard/yamlprobe/node_modules/js-yaml`（装在工作区内，
> 因为 profile 与系统 npm 缓存都在沙箱外）。该解析器对未知 tag（如 `!!js`）**比 DSH 更严格**，
> 所以它通过是**保守信号**，不会出现"比 DSH 松所以假绿"。

**当前实测结果**（2026-10-14，node v24.21.0）：

```text
真名总数 846  →  放行 222 / 拒绝 624
断言：MUST_DENY 21 条、MUST_ALLOW 13 条
✅ 全部断言通过
```

allow 清单中仍有 3 条「名字含写动词 token」的，**逐条解释如下**（不是漏网）：

| 工具 | 为什么放行 |
|---|---|
| `mcp__fpga-mcp__a_report_route_status` | 「报告布线状态」是只读；`route` 出现在名字里 |
| `mcp__fpga-mcp__viv_report_route_status` | 同上 |
| `mcp__fpga-mcp__q_is_project_open` | 「返回工程是否打开」是只读；`open` 出现在名字里 |

### 4.4 分层与证据等级

| 项 | 等级 |
|---|---|
| 846 个 MCP 工具名与描述 | `CONFIRMED`（运行期 `Tool.listTools` 投影） |
| 判定器对 846 个真名的分类结果 | `CONFIRMED`（离线复算，两份独立实现交叉核对） |
| `restrict`/`guard` 的失败语义与时序洞 | `CONFIRMED`（源码原文） |
| **guard 运行期能拦住 MCP 调用** | **`CONFIRMED: PASS`**（2026-10-14 16:47:21 +08:00，见 §6.1 原始证据） |
| 新插件必须挂 `- insert:`（裸顶层 `- id` 会被静默忽略） | **`CONFIRMED`**（2026-10-14 反向实测：`unknown entry id "role-guard"`） |
| per-agent 路径在真实子 agent 上的生效情况 | **`NOT RUN`** |
| enforce 模式在真实会话里的拦截效果 | **`NOT RUN`**（dry-run 已实测；enforce 仅经 stub 验证） |

---

### 4.5 角色作用域（roleScope）——为什么不能全局硬锁

**踩过的坑（重要）**：`ctx.tools.guard(fn)` 在 **plain context** 里注册 = **对所有 agent 生效**，
判定函数只看工具名、**完全不知道调用者是谁**。
于是 2026-10-14 16:53 切 enforce 后，**Lead 和 writer 一起被锁**，
「单写者 + 只读审查者」的分工直接不成立。

**正解：全局 guard + 调用时按角色判**（不需要 per-agent 注册）。依据是两条契约：

```ts
// ① 调用对象带调用者
ToolExecutionInput { ..., agent?: Agent }

// ② 团队服务能按 agent 反查身份（app.asar 契约原文）
ctx.agentTeams.tryMembership(agent: Agent): TeamMembership | undefined
//   "Resolve a caller without throwing, used by scoped-tool installation and observers."
interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'   // ← 只有两档
  readonly name: string                // ← Lead 在 spawn 时起的名（不可变）
}
interface TeamMemberView { id, name, role, status, description?, provider?, context?, model?, diagnostics }
```

**关键限制**：`role` 只有 `lead` / `teammate`，**writer 与 reviewer 都是 `teammate`**；
业务角色只能由 **Lead 起的名字**承载（`SpawnTeammateRequest` 的语义是 immutable name，
模型自己也没有改名方法）。所以走**命名约定**。

**六条决策**（用户 2026-10-14 定；第 3、5 条随后因两次漏洞被修正）：

| # | 情形 | 判定 |
|---|---|---|
| 1 | **调用者本人就是写手成员**（`writer*` 前缀或整词） | **放行**——这是**唯一**可写的情形 |
| 2 | 调用者本人是成员但非写手（含 `lead`） | **enforce**（Lead 不下场写） |
| 3 | 完全找不到责任链（无 `agent` 归属的宿主调用） | `unknownPolicy`，**默认 `guard`** ⚠（由 `pass` 翻正） |
| 4 | 团队服务取不到 | `serviceMissingPolicy`，默认 **guard** |
| 5 | **成员派生的子/孙 agent**（含 writer 派的） | **enforce** —— **写权限不可委派** ⚠（见 §4.5） |
| 6 | 有祖先责任链但本人不是写手 | **enforce**，且**不受 `unknownPolicy` 影响**（钉死） |

### ⚠ 两处漏洞（都在 2026-10-14 被用户指出并实测/修复，必读）

#### 漏洞一 · 越权委托（审查者派生写手子 agent）

**第一版**判定把"子 agent 无团队身份"当作"身份未知 ⇒ 放行"。于是
**审查者只要用 `subagent` 派生一个子 agent，就拿到完整 MCP 写权限**
（实测该子 agent 的 `stop_session` 真的执行了）。

DSH 文档写明了前提：子 agent 是 fresh scope，**"parent tool restrictions and authority are not imported"**
⇒ **继承必须自己实现**。

#### 漏洞二 · 角色继承把写权限也继承了下去（第二个洞）

**第二版**改成"有效角色 = 最近团队成员祖先的角色"。这堵住了审查者的洞，
却让 **writer 的子 agent 继承到写权限** ⇒
- writer 可派生**任意多个可写子 agent** ⇒ **「同一 checkout 单一 writer」当场失效**；
- 等于给 writer 一条把写权限"洗"给协助者的通道——而 writer 带的子 agent 本应是**审查/协助**。

#### 定稿：**写权限不可委派**

`skip`（可写）**当且仅当调用者本人就是写手成员**。祖先身份**只用于归因，绝不用于授予写权限**：

| 调用者 | 自身身份 | 祖先身份 | 结果 |
|---|---|---|---|
| writer 本人 | writer | — | **放行** |
| **writer 的子 agent** | 无 | writer | **拒绝**（写不可委派） |
| reviewer 本人 | reviewer | — | 拒绝 |
| **reviewer 的子 agent** | 无 | reviewer | 拒绝 |
| **reviewer 的孙 agent** | 无 | reviewer | 拒绝（多层） |
| 孤儿 / 无 `agent` 归属 | 无 | 无 | 按 `unknownPolicy`（默认 guard ⇒ 拒绝） |

**实现要点**：`ancestorMembership` 一旦存在就**钉死 `enforce`**，
因此子 agent 的安全性**不依赖 `unknownPolicy` 这个旋钮**（即便有人把它拧成 `pass`，
写手子 agent 仍被拦——`test/stub-apply.mjs` §10 专门断言了这一点）。

**⚠ 行为后果（要按这个调整工作流）**：**writer 不能把 Vivado 写操作外包给子 agent**。
如果确实需要两个写手，应当由 **Lead 直接派第二个 `writer-*` 成员**（而不是让 writer 派生），
并且遵守「同一 checkout 同一时刻只有一个 writer」的既有纪律。

**per-agent 注册（`agent/created` + `agent.ctx.guard()`）在本设计里的定位已变**：
它**不是**安全主闸门（主闸门是调用时判定的 `roleScope`），而只是 **`restrict` 的唯一落点**
（`restrict` 是 scope 静态掩码，无法按调用判角色）。
它失败（创建期身份查不到）时只是**不安装遮蔽** ⇒ 只损失"隐藏工具"的收益，安全性不变。
插件卸载不自动解除 `agent.ctx` 注册这一官方警告仍适用，故其 disposer 必须存进插件自己的 effect。

**配置**（2026-10-14 17:3x 起为安全口径）：

```yaml
roleScope:
  enabled: true
  writerNamePatterns: ['writer']    # 前缀命中 或 按 -/_/. 切词后整词命中
  unknownPolicy: guard              # ⚠ 不得设 pass（校验器硬断言）
  serviceMissingPolicy: guard
```

**运行期证据**：`list_agents` 返回 `[{"target":"lead","role":"lead","status":"running",...}]`
⇒ 团队服务是活的、`role` 字段可用。
**离线证据**：`test/stub-apply.mjs` §5/§6/§9 共 21 条角色与继承用例（§9 是越权委托防护）。

**命名纪律（给 Lead）**：写手成员**必须**用 `writer-*` 开头命名（如 `writer-rtl`、`writer-fw`）；
其余成员（`reviewer-*` / `audit-*` / …）自动进只读档。名字取错的方向是安全的：
**写手被误锁会当场报错（可见）**，而审查者被误放行才是危险——所以白名单比黑名单对。

---

## 5. 本轮证据落点

```text
%MAIN_REPO%-dsh\.cache\dsh-guard\
  mcp-tools.txt                 846 个 MCP 工具名（一行一个）
  mcp-tool-descriptions.json    846 条描述（判读依据）
  extract_mcp_tools.py          抽取脚本（从 inspect 输出）
  classify_tools_v3.py          按 token 的三态分类器（Python 侧）
  classify.v3.txt               v3 汇总（total/allow/deny/review）
  allowlist.v3.txt / denylist.v3.txt / review.v3.txt
  qc_classify.py / qc.v2.txt    用描述反查分类质量的质检脚本与报告
  js-allow.txt / js-deny.txt    JS 判定器的实际放行/拒绝清单（交叉核对用）
  whitelist.audit.txt           早期前缀规则的反向审计（含被证伪的规则，留作历史）
  backup/cordis.patch.yml.20261014-163759-改前   补丁写前备份
  profile-patch.CONSTRUCTED.yml 带补丁的完整 profile 副本
  link-gate-result.txt          文档链接门禁结果
```

```text
%MAIN_REPO%-dsh\guards\role-guard\
  package.json
  lib/index.js                        插件主体（判定器 + guard + 可选 restrict/per-agent）
  test/selfcheck.mjs                  离线断言自检（846 真名，含用例名存在性检查）
  test/audit-allow.mjs                allow 清单安全复核
  test/stub-apply.mjs                 stub ctx 跑 apply，验证插件逻辑（无需 DSH）
  test/validate-patch.mjs             profile 补丁校验（真 YAML 解析 + 结构断言）
  README.md                           本文件
  profile-patch-entry.yml             可复用的补丁模板（已是 `- insert:` 形态）
  RT-02_实验记录_20261014.md          RT-02 实验原始证据与判定（交付物 #3）
```

⚠ `.cache/dsh-guard/` 是**工作区临时证据**，不是仓库事实来源。结论以本文件论述为准。

---

## 6. 状态（**诚实栏**）

| 项 | 状态 |
|---|---|
| 插件源码 | ✅ 已写（工作区） |
| 判定器离线自检 | ✅ 通过（222 允许 / 624 拒绝；含用例名存在性检查） |
| profile 补丁 | ✅ **已应用**（2026-10-14 16:37，写入 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾） |
| 补丁校验（真解析器） | ✅ **通过** —— js-yaml 真解析成功（顶层 15 项），断言基于解析对象逐条核对；写回后的文件本体也验过（`RG_VALIDATE_FILE` 模式）。解析器对未知 tag 比 DSH 更严格，属保守信号 |
| 补丁写前备份 | ✅ `%MAIN_REPO%-dsh\.cache\dsh-guard\backup\cordis.patch.yml.20261014-163759-改前`（原文件 SHA-256 `85BA5253B3869E1E1BB49690104E088898D2A28B0FC0FC8C6096AF07447B5961`） |
| **是否已重启 DSH** | ✅ **是** —— 2026-10-14 16:47 复验后插件已加载；`Config(entry="role-guard")` 不列它是预期（插件未声明 Config schema），运行期 guard 已由探针结果确认 |
| **RT-02 实验（guard 拦 MCP）** | ✅ **`CONFIRMED: PASS`** —— 2026-10-14 16:47:21 +08:00，`mcp__vivado__list_sessions` 返回 `[role-guard] RT-02 探针命中：本会话已注册对 \`mcp__vivado__list_sessions\` 的拒绝`，未返回 MCP 正常数据 |
| dry-run 实测 | ✅ **通过** —— 探针在 dry-run 下按设计真拒；普通写/执行工具在 dry-run 下只记录 |
| enforce 全局模式 | ⚠ **已试过并回退** —— 16:53 切 enforce 后发现它**不分角色**（writer/Lead 一起锁），团队模式不成立 ⇒ 17:0x 退回 dry-run。教训见 §4.5 |
| 角色模式（roleScope）实现 | ✅ **已实现 + 离线 13 条用例全过**（`test/stub-apply.mjs` §5/§6） |
| **角色模式运行期实测** | ✅ **`CONFIRMED: PASS`** —— 2026-10-14 17:2x，同工具（`mcp__vivado__stop_session`）三方对照：`reviewer-smoke` **被拒** / `writer-smoke` **放行且真执行**（返回业务语义「会话 'default' 不存在」）/ **Lead 被拒**。详见 `RT-02_实验记录_20261014.md` §6.2 |
| 当前生效模式 | `mode: enforce` + `roleScope.enabled: true` + `unknownPolicy: guard`；**`agentScope.enabled: true` + `restrictMcpWriteTools: 'waterfall'`**（2026-10-21：软能力——只过滤模型所见，判据见下两行） |
| 决策 3/4（身份未知 / 服务缺失） | ✅ 默认已翻正为 **guard**；决策 3 的运行期验证曾**误判为 PASS**，真相是**绕过通道**（见 §4.5 越权委托漏洞） |
| **越权委托防护（子 agent 继承祖先角色）** | ✅ **运行期 `CONFIRMED: PASS`** —— 2026-10-14 20:45，五路对照（见 `RT-02_实验记录_20261014.md` §6.6）：Lead 拒 / reviewer 拒 / **reviewer 子 agent 拒** / writer **放行且真执行** / **writer 子 agent 拒**。离线另 8 条用例（`test/stub-apply.mjs` §9/§10） |
| **写权限不可委派** | ✅ **运行期 `CONFIRMED: PASS`** —— writer 本人放行、其子 agent 被拒（同一工具同一参数） |
| `restrict` 加固层 | ⛔ **已关闭**（`agentScope` 曾同时开着）。⚠ **2026-10-21 归因修正**：本行原写"2026-10-14 曾把非 MCP 工具管道整条拖垮"——**这个账记错了对象**。当日对照实验（全量 restrict / **1 条** restrict / **只挂 waterfall 完全不调 restrict**）失败现象**完全一致**（被约束 agent 的 `read`/`write`/`list_agents`/`team_task_list`/`send_message` **5/5 `Error: null`**，而工具在 schema 里仍可见），三者**唯一共同项是 per-agent `actx.tools.guard(...)`**。⟹ **元凶是 `agent.ctx` 上的 per-agent 注册路径（见下一行），不是 `restrict`**。 |
| per-agent 注册路径（`agent.ctx`） | ⛔ **刻意不用** —— 2026-10-14 记为「时序竞态 + 卸载坑 + 热路径故障面」；**2026-10-21 补充实证**：在 `agent.ctx` 上注册 `tools.guard()` 会让该 agent 的**非 MCP 工具全部 `Error: null`**（5/5）。因此 `'waterfall'` 模式**不装 per-agent guard**，判定一律交给全局 `roleScope`。 |
| `'waterfall'` 软能力（2026-10-21 新增） | 挂在 **agent scope** 上的 `system-prompt/assemble` 过滤：把「MCP 写工具」从**模型所见**剔除。技术来源 `@rayfalling/dsh-tool-visibility` 的降级路径。**语义边界：看不见 ≠ 不能调**；执行仍由 `roleScope` 兜底。离线 `test-roleguard-waterfall.mjs` **5/5**。 |
| 事件日志（`eventLog`） | ✅ 已实现（JSONL 写工作区）。**2026-10-14 又修两个取证缺陷**：去重键由「工具名」改为 `(工具名, 调用者)`（否则同工具被不同角色拒绝只记第一条）、`allow` 事件如实记 `source`（`roleSkip` / `readonlyWhitelist`）。**待下次重启生效** |
| per-agent 注册路径（`agent.ctx`） | ⛔ **刻意不用**（时序竞态 + 卸载坑 + 热路径故障面，见 §4.5） |
| 红队文档 §4.2 | ✅ **已回填为 `CONFIRMED: PASS`**（含时间、工具名、原始拒绝结果及首次失败根因） |

### 6.1 RT-02 原始证据（判定表 §2.2 的 PASS）

**实验判据**：结果里出现本插件独有的探针串 ⇒ 被 guard 拦；返回 MCP 正常数据 ⇒ 拦不住。

```text
时刻     ：2026-10-14 16:47:21 +08:00
探针     ：mcp__vivado__list_sessions        （只读类，brief §1.1① 硬要求）
副作用   ：无（未调用任何写/执行类工具；未启动 Vivado 会话）

原始返回 ：
  Error: [role-guard] RT-02 探针命中：本会话已注册对 `mcp__vivado__list_sessions` 的拒绝

对照（同一探针在 guard 生效前，2026-10-14 16:42 左右）：
  当前没有活跃的 Vivado 会话。使用 start_session 启动一个新会话。
  ⇒ 那时工具**真的执行了**，即插件尚未加载

判定     ：PASS —— 请求在 MCP dispatch 之前被拒绝，MCP 服务器侧未产生该次调用的正常结果
```

**第一次 FAIL 的根因（已修正，留作教训）**：补丁把新插件写成顶层裸 `- id: role-guard`，
DSH 将其视为「按 id 覆盖已有条目」，条目不存在 ⇒ 静默忽略。
反向证据：`Config(entry="role-guard")` 返回 `unknown entry id "role-guard"`；
而同文件的 `- insert:` 条目 `include:mcp-vivado` 能被正常解析。
改成 `- insert:` 并重启后即 PASS。

### 6.2 探针选择纪律（**协议已执行完毕，纪律长期有效**）

**⚠ 验证必须用「即使 guard 失效也无害」的探针**（brief §1.1① 的硬要求）。
绝不能用 `run_tcl` / `safe_tcl` / `a_exec` / `program_device` 这类做验证——
guard 万一没生效，那次调用**会真的执行**。

| # | 调用 | 期望 | 为什么安全 |
|---|---|---|---|
| 1 | `mcp__vivado__list_sessions` | **放行**，返回「当前没有活跃的 Vivado 会话」 | 只读；证明 enforce 没过度拦截 |
| 2 | `mcp__vivado__stop_session` | **拒绝**，返回 `[role-guard] … 写动词 stop` | 写类（`stop_`），但**当前无会话**，即使真执行也只是同类无害回答 |
| 3 | `mcp__fpga-mcp__status` | 放行 | 只读 |

判读：①③ 放行 + ② 被拒 ⇒ enforce 按白名单工作。
若 ② 正常执行 ⇒ guard 没生效，**立即回滚**（`mode: dry-run`）。

**其余未做项**：
- **per-agent 实测**：需要真实子 agent 验证 `agent/created` + `agent.ctx.guard()`，
  以及「角色如何稳定判定」（当前只有 agent id 白名单这一条可靠路径）。
- **restrict 加固层实测**：验证名字就位时 `restrict` 的遮蔽效果与 schema 消失。

---

## 6.5 方案 A：shell 面减速带（`shellScope`，2026-10-14）

### 6.5.1 为什么加它——一处**实测确认**的缺口

只读边界原先是"两件套"：本插件管 **MCP 工具**，会话沙箱管 **文件**。
但 2026-10-14 实测发现**第三面没人管**：

| 测试（调用者 = 被自动钉 `fpga-locked` 的 `reviewer-*`） | 结果 |
|---|---|
| `pwsh -Command "echo shell-ok"` | ✅ **跑通**（退出码 0，输出 `shell-ok`） |
| `Test-Path 'G:\vivado\Vivado\2019.1\bin\vivado.bat'` | ✅ **`True`**（厂商二进制可见） |
| `write` 一个工作区文件 | ❌ 被拦（文件面确实有效） |

代码依据——本插件此前对非 MCP **显式放行**：

```js
if (!isMcpTool(n)) return { deny: null, source: 'nonMcp' }; // 非 MCP 不管
```

⇒ **只读子会话能起 shell、能看见厂商二进制，而这条路径无人管**。
烧板/综合是**进程 + 硬件**行为，文件沙箱对它无感。

### 6.5.2 机制

只读角色（即角色判定为 `enforce` 者）调用**shell 类工具**时，
扫描命令文本里的厂商/烧板模式，命中即拒：

```yaml
shellScope:
  enabled: true
  toolNames: [ 'pwsh', 'bash', 'sh', 'exec' ]
  denyPatterns: [ ... ]   # 省略 = 用内置默认表
  denyGroups: [ ... ]     # 复合规则：全部子串同时出现才命中
  allowPatterns: []       # 逃生门：命中即整体放行
```

**内置默认模式——面 1：厂商工具链 / 烧板**
`vivado.bat` / `vivado.exe` / `vivado -mode` / `vivado -source`、
`xsdb` / `xsct` / `hw_server`、
`program_hw_devices` / `program_hw_cfgmem` / `write_cfgmem` / `create_hw_cfgmem` /
`open_hw_manager` / `connect_hw_server` / `open_hw_target` / `boot_hw_device`、
`quartus_pgm` / `quartus_sh` / `quartus_map` / `quartus_fit` / `quartus_sta`、`impact.exe` / `openocd`。

**内置默认模式——面 2：串口**写**＝物理致动**（2026-10-14 追加）
`-sendhex`（`capture_serial.ps1 -SendHex '01'` ⇒ 发命令）、`send_0_to_f`（逐字节驱动脚本）、
`live_brake`（主动制动）、`live_sweep`（扫频）。

**复合规则**（`denyGroups`，比裸子串精确）：
`['serialport', '.write']`、`['serialport', '.writeline']` ⇒ 命中 `SerialPort…Write`。

> **为什么把串口单列一面**：本项目 `send_0_to_f.ps1` 的实测记录写明「**会驱动电机输出**」——
> **串口不只是观测通道，也是控制通道**。取证 ≠ 驱动，后者按 `AGENTS.md` §8 属 writer。
> 因此只读角色**允许被动监听**，**禁止发送**（见下负例）。

**新增判定来源**（`decide()` 的 `source`）：`shellDeny`（命中）、`shellAllow`（未命中）。

#### 6.5.2.1 关键负例（必须有，否则把取证一起误杀）

| 命令 | 期望 |
|---|---|
| `capture_serial.ps1 -PortName COM8 -Seconds 120`（**无** `-SendHex`） | **放行**（被动监听） |
| `live_listen.ps1`（脚本自述 "sends nothing, DTR/RTS low"） | **放行** |
| `[System.IO.Ports.SerialPort]::GetPortNames()` / `mode COMx` 查询 | **放行** |
| `Get-Content vivado.log` | **放行**（裸 `vivado` 刻意不匹配） |
| `something.Write(1)`（无 `SerialPort` 上下文） | **放行**（复合规则不误伤） |

### 6.5.3 ⚠ 三条必须说清的限制

1. **这是减速带，不是硬边界。** 变量、base64、路径拼接、字符串拼接都能绕过。
   它的价值 = 挡住**明显的**厂商/烧板调用 + 留下可审计的拒绝记录。
   **不要**据此宣称"只读是完整的"。真正的硬边界见 §6.5.5 的方案 B。
2. **误伤是设计代价（用户 2026-10-14 明确接受此代价，选 2a）**：文本匹配分不清"调用"与"提到"。
   因此**只读角色**（含 Lead）在 shell 里**提到**这些串也会被拒，例如 `grep vivado.bat`、
   `Select-String ... vivado.log`、`echo -sendhex-probe`。
   **已实测**：Lead 一条含 `xsdb` 的**搜索**命令被拒。
   **约定的应对**：搜索改用 `grep`/`read` **工具**（不走 shell）；规则变成"命令文本里别提这些串"。
   逃生门是 `allowPatterns`，但那会进一步削弱强度（整条命令放行）。
3. **刻意不匹配裸 `vivado`**：否则 `Get-Content vivado.log` 这类**合法读日志**会被误伤——
   把审查者读日志的能力换掉是坏交易。代价是"不带扩展名/旗标的 vivado 调用"可能漏过。
   判定器自检里专门放了这条**负例**（`vivado.log` 必须不命中）。

### 6.5.4 生效条件（fail-loud）

`shellScope.enabled=true` 但 `roleScope.enabled=false` ⇒ **拒绝加载**：
没有角色归因就判不出"谁是只读"，静默放行会变成"设了但不生效"的假安全感
（与本插件对 `restrictMcpWriteTools` 的同一条纪律）。

### 6.5.5 待评估的方案 B（更接近硬边界）

让只读子代理**根本没有 shell 工具**（`SubagentStartRequest.toolFilter` 字段存在）。
优点是**没有误伤**（不是"匹配文本"，而是"工具就不在手边"）；
需确认能否按角色设置、以及审查者用 `read`/`grep` 替代 shell 读需求是否够用。

> ⚠ **2026-10-14 评估结论：B 对 Lead 出局。**
> **串口抓取本身就是 shell 操作**（`pwsh + capture_serial.ps1`），
> 让只读角色"没有 shell"会把**抓串口一起禁掉**——与"Lead 要能抓串口"的要求直接冲突。
> B 最多只能用于**纯 reviewer 子代理**；而 A 已挡住主要路径 ⇒ **B 暂不做**。

### 6.5.6 落地约定：拆两步（2026-10-14 用户确认）

A 生效后，原先"一条命令里既下载又抓串口"的组合写法会被拒
（命令行里含 `xsct` 等字样）。约定改为**两步**：

| 步 | 谁 | 做什么 |
|---|---|---|
| ① | **writer** | 下载 / 烧写 / 驱动工具链（`xsct`、`dow`、`vivado`…）——writer 是 `roleSkip`，不被 shell 扫描 |
| ② | **Lead** | **被动**抓串口（`capture_serial.ps1` 不带 `-SendHex` / `live_listen.ps1`）、读数、落证据 |

⇒ **不要**再写 `capture_banner.ps1 -ElfScript "...download_elf_xsct.tcl"` 这类**组合命令**
（命令行里出现 `xsct` 字样就会被拒）；把下载交 writer、抓取留给 Lead。

#### 6.5.6.1 ✅ 该方案已运行期验证（2026-10-14 21:51，PASS）

派一次性成员 `writer-dow`（名字前缀 `writer`）执行：

```powershell
& 'G:\vivado\SDK\2019.1\bin\xsct.bat' 'E:\…\.cache\dsh-guard\xsct-alive.tcl'
```

**结果：真的执行成功**（**不是"没被拦"，而是跑通了**）：

```text
XSCT_ALIVE=1
VERSION_ERR=bad option '-short': -help -server    ← 仅波形脚本内版本参数写错，xsct 本体正常
TCL_SCRIPT_RAN=1
退出码 0；无沙箱/守卫拒绝串
```

**两条机器证据**（两个插件各一条，互相独立）：

```json
// role-guard：writer 的 pwsh 被 roleSkip（根本不进 shell 扫描）
{"event":"allow","tool":"pwsh","caller":{"name":"writer-dow","role":"teammate","via":"self"},"source":"roleSkip"}

// 沙箱探针：writer 同样豁免只读档（保留 custom ⇒ workspace-write）
{"event":"skip-writer-exempt","name":"writer-dow","role":"teammate","presetBefore":"custom"}
```

⇒ **"拆两步"可行**：writer 能驱动工具链、且不被两道守卫拦；Lead 能被动抓串口（§6.5.2.1）。
**未验证**：完整下载流程需要真板子（本轮无板，只验证到"二进制可执行 + 权限放行"）。

#### 6.5.6.2 ✅ **Lead 侧**（被动取证）运行期验证（2026-10-14 22:22，PASS）

**证据来源**：[`docs/查证_Lead取证与shellScope运行期验证_20261014.md`](../../docs/查证_Lead取证与shellScope运行期验证_20261014.md) §1（探针矩阵）/ §2（机器证据）。
**由另一位 agent 完成**（它遵守"不碰别人的地盘"，未改本目录，只提出建议——本节由 guard 侧补入）。

**探针矩阵（6 条，3 放行 / 3 拒）**：

| # | 命令要点 | 实测 | `source` | 命中 |
|---|---|---|---|---|
| A | `[System.IO.Ports.SerialPort]::GetPortNames()` 枚举串口 | ✅ 放行 | `shellAllow` | — |
| D | `capture_serial.ps1 -PortName COM8 -Seconds 120`（**无** send 旗标） | ✅ 放行 | `shellAllow` | — |
| B | 文本含 `xsdb`（面 1·厂商） | ❌ 拒 | `shellDeny` | `xsdb` |
| C1 | `capture_serial.ps1 -SendHex 01`（面 2·串口写） | ❌ 拒 | `shellDeny` | `-sendhex` |
| C2 | `SerialPort` + `.Write`（复合规则） | ❌ 拒 | `shellDeny` | `SerialPort…Write（串口写）` |
| C3 | `something.Write(1)`（**负例**，无串口上下文） | ✅ 放行 | `shellAllow` | — |

**三条拒绝命中的是三个互不相同的模式**（`xsdb` / `-sendhex` / 复合 label）
⟹ 走的是**三条独立规则**，不是一条规则兜住所有情况。

**机器证据**（`guard-events.jsonl`）：`caller=lead/lead` ⟹ 判定**按角色**作用到了 Lead
（未被 `unknownPolicy` 兜走）；`enforced=true` **只出现在 deny 上** ⟹ **真拒**，不是 dry-run 只记录。

> ⚠ **两个计数口径别混**（guard 侧补记）：
> 该时间窗日志里共 **8 条** shell 判定（**5 放行 / 3 拒**），而矩阵只列 **6 条**（3 放行 / 3 拒）。
> 多出的 **2 条放行**是**附带命令**、不属于矩阵；本插件**不记命令文本**（避免敏感内容落盘），
> 故无法回溯是哪两条。**引用时请说明是哪一个口径**，否则会"算不平"。

**这次验证把 §6.5.2.1 的结论从「离线用例」提升到了「运行期实测」。**
但**不改变** §6.5.3 的定性：`shellScope` **仍是减速带、非硬边界**。

**两条读数纪律**（记录 §3，值得留在这里）：

1. **读任何 JSONL / UTF-8 证据文件必须显式带编码**——不带 `-Encoding UTF8` 会读出
   `鍙υ瑙掕壊绂佹…` 这类乱码，**差点被误报成"守卫日志编码 bug"**（实为读法错）。
2. **枚举外设别只靠 `Get-CimInstance`**（那条路失败会把整体退出码带成 1，干扰判读）；
   可用**注册表按 VID 查**：`Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB' | ? PSChildName -match 'VID_1A86'`。

**顺带得到的现场事实**：CH340 有 USB 注册记录（`VID_1A86&PID_7523`）但 `GetPortNames()` 为空
⟹ **当时没有 COM 口**（板子大概率未连接/未供电）。**真抓串口前先确认枚举出 `COMx`，不要硬编码 COM 号。**

### 6.5.7 角色口径：Lead 兼"调试员"（2026-10-14 用户确认）

- **不加**新的"调试员"成员；
- Lead 承担**观测/调试的读侧**：抓串口、读寄存器/内存、看已导出 ILA、日志解读、落证据
  ——这与只读**相容**，也是 `ARCHITECTURE.md` §2.2 早已写明的本职；
- **控制侧**（halt / step / download ELF / set register / reset / breakpoint）**仍由 writer 做**
  （即 §6.5.6 的第 ① 步）；
- ⚠ 若日后需要 Lead 亲自**控制**目标，那要**改口径**（Lead 不再是只读）——须用户明确点头，
  **不得由 Lead 自行放宽**。

---

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-14 | RT-02 完成：修正新插件必须使用 `- insert:`（此前裸顶层 `- id` 被当作覆盖不存在条目，导致第一次探针假 FAIL）；重启后以只读 `mcp__vivado__list_sessions` 为探针，16:47:21 +08:00 返回固定 guard reason，确认 MCP dispatch 前拦截。**CONFIRMED: PASS**。 |
| 2026-10-14 | 发现**全局 enforce 不分角色**（writer/Lead 一起锁），退回 dry-run；实现**角色作用域**（全局 guard + 调用时按 `exec.agent` + `agentTeams.tryMembership` 判角色），落地用户四条决策，补 13 条离线角色用例。运行期角色验证仍 `NOT RUN`。 |
| 2026-10-14 17:2x | 切 `enforce` + 重启，用两个一次性 teammate 做**同工具三方对照**（reviewer 拒 / writer 放行且真执行 / Lead 拒）⇒ 角色档 **`CONFIRMED: PASS`**。 |
| 2026-10-14 17:3x | ⚠ **用户指出并证实越权委托漏洞**：成员用 `subagent` 派生的子 agent 非团队成员 ⇒ 落到 `unknownPolicy=pass` ⇒ 可绕过只读边界写/烧板。修正：**祖先角色继承**（`effectiveMembership` 沿创建链归因）+ `unknownPolicy` 默认翻正 `guard` + 校验器硬断言；同时把 `restrictMcpWriteTools` 的"静默 no-op"改为配置错误即拒绝加载，并加 JSONL 事件日志。离线 21 条角色/继承用例全过。 |
| 2026-10-14 17:4x | ⚠ **用户指出第二处漏洞**：角色继承让 writer 的子 agent 也继承写权限 ⇒ 单一 writer 纪律失效。定稿 **写权限不可委派**（祖先存在即钉死 enforce）。 |
| 2026-10-14 19:3x | ⚠ **第三次事故**：`lookupAgents` 定义被删但调用残留 ⇒ apply 抛异常 ⇒ Loader 回滚 guard ⇒ **主闸门整块失效**（日志看着像已加载）。修正：补回定义 + agentScope 块 try/catch + `agent.ctx` 缺失只跳过不抛；补 stub §11 覆盖 `agentScope.enabled: true`。 |
| 2026-10-14 20:45 | ✅ **最终验收全绿（五路对照）**：Lead 拒 / reviewer 拒 / **reviewer 子 agent 拒** / writer **放行且真执行** / **writer 子 agent 拒**（§6.6）。按"加固层与主闸门故障隔离"原则摘除 `agentScope`/`restrict`；另修两个取证缺陷（去重键含调用者、`allow` 记真实 `source`）并补 stub 断言。 |
| 2026-10-14 21:30 | ⚠ **发现第三面缺口**（§6.5）：只读子会话实测能跑 `pwsh`（`shell-ok`）、能看见 `vivado.bat`（`True`），而本插件对非 MCP 显式放行 ⇒ 烧板/综合的进程路径无人管。 |
| 2026-10-14 21:40 | **方案 A 实现**：`shellScope`（只读角色的 shell 命令文本扫描 + `shellDeny`/`shellAllow` 判定来源 + 11 条加载期自检用例 + 12 条离线用例）。`shellScope` 开而 `roleScope` 关 ⇒ 拒绝加载。**⚠ 代码需重启才生效**；且明确定位为**文本减速带、非硬边界**（§6.5.3）。方案 B（`toolFilter` 移除 shell）待评估。 |
| 2026-10-14 21:45 | **面 2 追加：串口写＝物理致动**（用户要求）。背景：`send_0_to_f.ps1` 的实测记录写明「会驱动电机输出」，而这类命令**不含任何厂商模式**、原先会被放行 ⇒ 只读角色仍能用串口让电机动作。新增 `-sendhex`/`send_0_to_f`/`live_brake`/`live_sweep` + 复合规则 `SerialPort…Write`；**关键负例**保证被动监听仍可用。 |
| 2026-10-14 21:47 | ✅ **运行期自证（无需重启）**：`echo -sendhex-probe` → **DENY**（命中 `-sendhex`，理由文案正确说明"被动监听允许"）；`capture_serial.ps1 -PortName COM8 -Seconds 120` / `[System.IO.Ports.SerialPort]::GetPortNames()` / `live_listen.ps1 …` → **均 ALLOW**（日志 `source: shellAllow`）。 |
| 2026-10-14 21:47 | 用户定 **2(a)**：接受"命令文本里提到这些串也会被拒"的误伤代价；应对约定 = 搜索改用 `grep`/`read` 工具。另确认 **B 对 Lead 出局**——串口抓取本身就是 shell 操作，去掉 shell 会连抓串口一起禁掉。 |
| 2026-10-14 22:22 | **Lead 侧运行期验证 PASS**（另一位 agent 记录，guard 侧补 §6.5.6.2）：6 探针 3 放行 / 3 拒，三条拒绝命中三个**互不相同**的模式；机器证据 `caller=lead/lead` + deny 带 `enforced=true`。⟹ "Lead 能被动取证"从离线用例提升到**运行期实测**（§6.5.3 的"减速带"定性不变）。 |
| 2026-10-14 22:0x | 插件**正名**：`subagent-sandbox-probe` → `subagent-sandbox`（id / 目录 / 模块路径 / 导出名 / 包名）；改名后做双向回归（reviewer 仍被拒、writer 仍豁免）。取证日志文件名**刻意保留** `sandbox-probe.jsonl`（证据链优先）。 |
