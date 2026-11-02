# 待落地：角色硬边界 guard（交接 brief）

> ## ✅ 执行结果（2026-10-14 追记；**2026-10-14 21:50 更新**，原文保留为历史）
>
> 本 brief 的 §1 实验与 §2 接线**已执行完毕**，且**范围已扩到 brief 当初没写的两面**：
>
> | 交付物（§3） | 状态 | 落点 |
> |---|---|---|
> | RT-02 实验结论 + 原始证据 | ✅ **`PASS`**（guard 能拦 MCP） | [RT-02_实验记录_20261014.md](../guards/role-guard/RT-02_实验记录_20261014.md)；红队文档 §4.2 已从 `NOT RUN` 回填 |
> | 插件源码与配置 | ✅ 已落盘并**已挂进 profile** | [guards/role-guard/](../guards/role-guard/)（`lib/index.js` + `profile-patch-entry.yml`） |
> | 验证记录（dry-run → enforce） | ✅ **`enforce` 已实测**；五路对照全 PASS | 同上实验记录 §6.2 / §6.6 |
> | 回滚方式 | ✅ 四档，含写前备份 | 同上实验记录 §5 |
>
> **brief 之后新增的边界（两面）**：
>
> | 新增面 | 机制 | 等级 |
> |---|---|---|
> | **文件写入**（子会话沙箱） | [guards/subagent-sandbox/](../guards/subagent-sandbox/README.md)：把子代理钉 `fpga-locked` | **硬**（host 沙箱，实测拒绝） |
> | **shell → 厂商/烧板 + 串口写（物理致动）** | `role-guard.shellScope`（[README §6.5](../guards/role-guard/README.md)） | ⚠ **文本减速带，非硬边界** |
>
> **一条给后来人的关键更正（本 brief 未写、实测才发现）**：
> 新插件在 `cordis.patch.yml` 里**必须包在 `- insert:` 下**；顶层裸 `- id:` 只
> "按 id 覆盖已有条目"，条目不存在时会被**静默忽略**（无 stderr 警告），
> 会让 RT-02 出现**假 FAIL**。反之，**覆盖已有条目必须用顶层裸 `- id:`**。
>
> **仍未做（不许当已通过）**：`restrict` 加固层的运行期遮蔽效果（**已决定不再启用**，
> 因其在调用热路径上、曾拖垮非 MCP 工具管道）；**shell 面不是硬边界**——
> 变量 / base64 / 路径拼接可绕过，方案 B（`toolFilter` 移除 shell）**已决定不做**
> （会连"抓串口"一起禁掉）。完整现状见 [查证_子代理沙箱委派.md](查证_子代理沙箱委派.md)。

**日期**：2026-10-14
**性质**：**任务授权 brief**（可直接转发给执行 agent）。
**目标读者**：负责"硬边界 guard"的那位 agent（**未读过相关对话**，故本文件自包含）。
**上游依据**：[红队_smart_home团队结构与权限.md](红队_smart_home团队结构与权限.md) §2.2 / §3 RT-02 / §4.2 / §5 建议 A。
**权威口径**：机制细节以 [红队_smart_home团队结构与权限.md](红队_smart_home团队结构与权限.md) 为准；本文件只是**执行编排**，不复制其论述。

---

## 0. 一句话

> **先做一个小实验，再写插件。**
> 实验通过之前，**不得**把工具级 guard 写进任何安全边界的说法里。

**背景**：本工程的团队结构要求"只读审查者"，但三层权限里**没有一层在按 agent 强制只读**。
工具级缝（`ctx.tools.restrict()` / `guard()`）**存在且可用**，但全库**未见任何接线**。
本任务就是把它接上线——而**前置是 RT-02 那个未跑的实验**。

> **2026-10-14 追记（本段为写作时的现状，已被执行结果取代）**：
> 接线已完成并实测——工具级 `guard` 按角色分档（[guards/role-guard](../guards/role-guard/README.md)），
> 文件沙箱面由 [guards/subagent-sandbox](../guards/subagent-sandbox/README.md) 补齐，
> shell 面由 `role-guard.shellScope` 覆盖（**减速带**）。
> 当前完整边界见 [查证_子代理沙箱委派.md](查证_子代理沙箱委派.md)。

---

## 1. 📌 第一件事：RT-02 最小实验（~~`NOT RUN`，必须先跑~~ → **2026-10-14 已跑，`PASS`**）

**要回答的唯一问题**：

> **`ctx.tools.guard()` 能不能拦住 MCP 工具（`mcp__vivado__*` / `mcp__fpga-mcp__*`）？**

这条至今**未验证**——既有查证文档与红队文档都把它标为"**推断，不是验证过的结论**"。

### 1.1 实验设计（三条硬要求）

**① 探针工具必须选「失败了也无害」的。**

guard 若不生效，**那次调用会真的执行**。所以探针**只能**选只读类 MCP 工具：

```text
✅ mcp__vivado__get_*        （get_wns / get_tns / get_part / get_project_info …）
✅ mcp__vivado__list_*       （list_sessions / get_io_report …）
✅ mcp__vivado__report_*     （report_timing_summary / report_utilization …）
✅ mcp__fpga-mcp__a_get_*    （只读枚举类）

❌ 绝不能用：program_device / write_bitstream / run_pnr / run_implementation /
             generate_bitstream / run_tcl / safe_tcl / a_exec / viv_exec / set_backend
```

> 这是整个任务里**唯一可能伤到硬件**的地方。选错探针，一次失败就等于真烧板。

**② 判据必须能区分「被 guard 拦」与「工具自己失败」。**

guard 拒绝时返回的是**那个字符串**。所以通过判据是：

```text
PASS  = 工具结果里出现 guard 的 reason 串
        且 **没有发生 MCP 往返**（无 Vivado 会话启动、无对应日志行、无 session 建立）
FAIL  = 工具正常返回了数据         ⟹ guard 拦不住 MCP
不可判 = 报连接失败 / 参数错 / 超时  ⟹ 这不是"拦住了"，重做
```

只看"调用失败了"是**不够的**——MCP 连不上、参数错、超时都会"失败"。

**③ 实验期用 plain-context guard（全局），验完立刻 dispose。**

- plain-context guard 作用全局，**影响所有 agent**，所以必须一次性、可卸。
- ⚠️ **`guard` 在 `tools/pre-execute` 瀑布「之后」跑**，而本机 profile 里已经有
  `@deepseek-ai/dsh-experimental-auto-review` 也挂在 `tools/pre-execute` 上。
  **实验前先确认它没在拦**（或把它的 auto preset 排除掉），否则分不清是哪一层拒的。

### 1.2 实验的交付物

| 项 | 要求 |
|---|---|
| 结论 | `guard 能拦 MCP` / `不能` / `仍不可判`，**三选一，不许含糊** |
| 证据 | 探针工具名、命令、**原始输出**、时间、工具版本 |
| 副作用声明 | 有没有真的发生 MCP 往返；有没有残留未卸的 guard |

---

## 2. 第二步：只有在实验「能拦」的前提下，才做接线

### 2.1 推荐形态（**不改内置工具**）

一个独立插件，挂 `agent/created`，在 **`agent.ctx`** 上注册：

```js
export const inject = ['tools']

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const role = roleOf(agent)                    // 从 descriptor / label 判角色
    if (role !== 'reviewer' && role !== 'analyst') return

    ctx.effect(() => agent.ctx.effect(function* () {
      // 选型纪律：用「最弱够用」的机制 —— restrict 只能删工具；guard 只能拒绝
      yield agent.ctx.tools.restrict({ deny: WRITE_TOOLS })
      yield agent.ctx.tools.guard((exec) =>
        outsideReadScope(exec) ? 'role-guard: 越出只读边界' : undefined)
    }))
  })
}
```

**注册位置的依据**（`app.asar` 内置指引原文）：

> Register per-agent behavior on **`agent.ctx`**, obtained in an **`agent/created`** listener,
> so it is removed when that agent is disposed. Wrap it in one `agent.ctx.effect()`
> and **also keep that disposer** in your plugin's own effect.

**先做 dry-run**：只记录"本应拒绝谁"，不真拒绝。判据验证正确后再打开强制——
避免在活跃会话里突然把工具锁死。

### 2.2 四个必踩的坑（**接线前先读**）

| # | 坑 | 后果 |
|---|---|---|
| 1 | `restrict` 对**未知工具名直接失败**，而 **MCP 工具是「连接后」才注册的** | 注册 filter **有时序要求**；挂早了会抛异常 |
| 2 | `restrict` 只删 **global** 工具，**scope-local 注册的工具在 mask 之外** | 只靠 restrict 会有漏网 |
| 3 | `restrict` 是**相交**语义（restrictions intersect） | **只能更严，不能给谁开后门** |
| 4 | `guard` 必须**同步** | 要问用户必须改走 `tools/pre-execute` 返回 `ask`；`guard` 里做不到 |

### 2.3 可直接参考的活模板

`@deepseek-ai/dsh-experimental-auto-review`（**已在本机 profile 的 bundles 里**）：

```js
const permissionPresets = ctx.permissionPresets
ctx.on("tools/pre-execute", async (exec, next) => {
    const agent = exec.agent
    if (agent === undefined || ...) return next()
    if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next()
    ...
    const review = await classifyRisk(ctx, agent, exec, ...)
```

它同时示范了两件事：**逐工具调用的 gate** 怎么写，以及 **`ctx.permissionPresets.current(agent.session)`** 怎么读会话权限档。

---

## 3. 交付物与落盘位置（**必须落盘，不许只在消息里说**）

> 依据：[通信架构与模板.md](../smart_home/docs/team/通信架构与模板.md) §1.1 ——
> "**任何最终的交付、结论、finding 状态、证据引用，都不允许只存在于消息里。**"

| # | 交付物 | 落点 |
|---|---|---|
| 1 | **RT-02 实验结论 + 原始证据** | **回填 [红队_smart_home团队结构与权限.md](红队_smart_home团队结构与权限.md) §4.2 里 `guard 能否拦住 MCP 工具` 那一行**（从 `NOT RUN` 改成实测结论） |
| 2 | 插件源码与配置 | 按 profile 插件布局落盘；写清包名与 `cordis.patch.yml` 条目 |
| 3 | 验证记录 | dry-run 与强制模式各自的实测结果（含"试着写文件被拒"这类决定性验证） |
| 4 | 回滚方式 | 备份路径 + 卸载步骤 |

**§4.2 那一行现在是这样的**（原样抄）：

```text
| 工具级 `guard` **能否拦住 MCP 工具** | **`NOT RUN`** —— 需最小实验（见 RT-02） |
```

改成实测结论时，**同时给证据指引**（工具名 / 原始输出 / 时刻）。

---

## 4. 禁止事项

| # | 禁止 |
|---|---|
| 1 | **不得**用写/执行类 MCP 工具当探针（见 §1.1 ①） |
| 2 | **不得**在实验未通过时就宣称"工具级闸已覆盖 MCP" |
| 3 | **不得**把 `UNRESOLVED` / `NOT RUN` 写成 `REFUTED` 或"已通过"（红队三态纪律） |
| 4 | **不得**为了让结论好看而缩小探针范围或降低判据 |
| 5 | **不得**未经授权扩大写域（本任务的落点限于插件与上述文档的回填） |

---

## 5. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-14 | 建档。为"硬边界 guard"执行 agent 写的自包含 brief：先跑 RT-02 最小实验（探针选择 / 判据 / 与 auto-review 区分），通过后再接线；含四个必踩的坑、活模板指路、交付物落盘位置（含回填红队文档 §4.2 哪一行）与禁令。 |
