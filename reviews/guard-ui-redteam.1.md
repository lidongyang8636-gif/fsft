# 异构红队报告 · guard-ui P1（第 1 轮）

- **红队**：只读 subagent `baf5c243-29a8-47fe-9818-46e0d43824dc`
- **模型**：`%PAYG_PROVIDER%2/gpt-6.1-sol`（**异构槽位**：与 writer 的 `deepseek-flash` 不同族），reasoning effort = `high`，depth 1
- **日期**：2026-10-15 ｜ **性质**：只读对抗性复核，**未改任何代码/配置/profile**
- **落盘说明**：红队的 delegated session 被强制 read-only，`write` 返回
  `[sandbox: file access denied under read-only mode]`；**它按约束未重试提权**。
  本文件由 **Lead 代为落盘**（属 Lead 允许的"证据采集与观测 / 落证据"），
  **内容为红队结论，F1–F4 由 Lead 逐条独立复核后标注状态**。
- **审查范围**：`guards/guard-ui/**`、`guards/{role-guard,subagent-sandbox}/lib/index.js`、
  `guards/*/test/**`、`slices/guard-ui/{PLAN,EVIDENCE.1,HANDOFF.2}.md`
- **未读**：`.cache/dsh-guard/` 运行日志（红队声明）

---

## 1. Findings（按严重性）

### F1 · HIGH · 黑名单可被 junction/symlink 绕过 ⇒ 可能写进主仓库

| 项 | 内容 |
|---|---|
| 证据 | `guards/guard-ui/lib/settings.js:307-313`（`isForbiddenWorkspacePath` 只用 `resolve` + `relative`），`isInside` 定义在 `:326-331`；写入落点 `:636-645`；reset 落点 `:651-660`；调用方 `lib/index.js:171`、`:167-174` |
| 机理 | 判定基于**字面路径**，不做 `realpath`。若注册一个指向 `%MAIN_REPO%` 的 junction/symlink 工作区（如 `E:\alias`→主仓库），其字面路径不在禁用根内 ⇒ 通过黑名单 ⇒ 随后把 `.dsh-guard.json` 写/删到 **主仓库**里 |
| 红队状态 | 代码缺口 **CONFIRMED**；真实 exploit **NOT RUN** |
| **Lead 独立复核** | ✅ **CONFIRMED（代码级）**：`grep -r realpath guards/guard-ui` **零命中**；`:307-313` 确实只有 `resolve`+`isInside(relative)`。⚠ 补充风险面：插件运行在**宿主进程**内，不受 pwsh 文件沙箱约束 ⇒ 这条路径没有第二层兜底 |

### F2 · HIGH · 缺 `cwd` 时静默回落 profile，而 UI 无条件声称"下次生效"

| 项 | 内容 |
|---|---|
| 证据 | `settings.js:340-343`（`callerWorkspaceRoot` 缺 `agent.session.header.cwd` 返回 `null`）；`settings.js:485-490`（`resolvePluginConfig` 直接 `source:'profile', reason:'no-agent-cwd', problems: []`，**无告警**）；消费者 `subagent-sandbox/lib/index.js:264-288`、`role-guard/lib/index.js:570-579`；UI `client.js:58` + `:276-288`（`saveOk` 文案 + 无条件 `setMsg({ok: t("saveOk")})`） |
| 机理 | 设置**已写进磁盘**，但调用方 agent 若没有 `cwd`（`SessionHeader.cwd` 是**可选**字段），guard 一律按 profile 判定 ⇒ **"设了不生效"**；而 UI 仍说"下一次判定就会用上新值"。且 P6 的**有意降级**（无 agent 的宿主级调用）与**意外情况**（有 agent 但无 cwd）**共用同一个 reason**，无法区分 |
| 红队状态 | **CONFIRMED** |
| **Lead 独立复核** | ✅ **CONFIRMED**：`:340-343` 确实返回 `null`；`:489` 的 `problems: []` 说明**没有把它当问题**上报；`client.js:285` 确实在 `.then()` 里**无条件**报成功（`276-288` 不读响应的 `notes`/`combinationCheckedWithProfile`） |

### F3 · MEDIUM · 读改写 / 删除无锁无 CAS ⇒ 并发丢字段、并发 reset 误删

| 项 | 内容 |
|---|---|
| 证据 | 读改写：`settings.js:372-379`（读）→ `:636-645`（tmp + rename 写）；quarantine `:593-601`；reset `:654-660`（`existsSync` → `unlinkSync`，TOCTOU） |
| 机理 | `read → merge → rename` 之间无锁、无 mtime/size 预检 ⇒ 两个并发 set 的**后写覆盖前写，丢字段**；reset 在"读过旧文件"之后才 unlink ⇒ 可删掉另一写者**刚写的新文件** |
| 红队状态 | **CONFIRMED**（推理级） |
| **Lead 独立复核** | ✅ **CONFIRMED（代码级）**：`:636-646` 无回读校验、无锁；`:655-658` 为 `existsSync`+`unlinkSync` 裸序列。⚠ **缓解因素**：本项目口径是"同一 checkout 只有一个 writer"，故触发需要**同工作区两个并发会话**——真实但低概率。**残余风险需如实记录，不得包装成"已解决"** |

### F4 · MEDIUM · 无 `configEditor` 时走"宽松写"，客户端丢弃 `notes` ⇒ UI 撒谎

| 项 | 内容 |
|---|---|
| 证据 | `lib/index.js:314-326`（`configEditor` 缺失时 `profileConfigByPlugin` 传 `undefined`，`:325` 置 `combinationCheckedWithProfile: profile.used`）；`settings.js:619-634`（无 profile 现值 ⇒ 只做文件内部一致性校验 + `notes.push(...)`，`:633`）；客户端 `client.js:276-287` |
| 机理 | 此时**跨文件组合不变式未做权威校验**，但客户端**不读 `notes`、不读 `combinationCheckedWithProfile`**，仍报"已保存、下次生效"。若组合非法，guard 在判定期会**整份弃用**该工作区覆盖（`settings.js:509-514` ⇒ `source: profile` / `cross-rule`）⇒ **UI 与实际相反** |
| 红队状态 | **CONFIRMED**（推理级） |
| **Lead 独立复核** | ✅ **CONFIRMED（代码级）**：`:628-634` 的宽松分支确实只 push note；`client.js:276-288` 确实完全丢弃响应体里的 `notes` 与 `combinationCheckedWithProfile`。⚠ 触发前提是 `configEditor` 不可用——**本机现状 `defaultsSource=profile`（Lead 实测）说明当前可用**，故这是**条件性**缺陷 |

---

## 2. 红队确认**无问题**的项（同样重要）

| 项 | 结论 |
|---|---|
| 前导 BOM | ✅ **已正确剥离**（`settings.js:354-356`）—— 与 V3 现场教训一致 |
| 坏 JSON | ✅ 有 `status/problems` + catch，不炸 |
| **跨盘符** `path.relative` 返回绝对路径 | ✅ 已正确处理（`isInside:329`） |
| 普通 `..` 穿越 | ✅ 正确拦截 |
| HTTP 路由围栏 | ✅ **总体 fail-closed** |
| junction/symlink | ❌ 不安全（= F1） |

## 3. 红队对既有证据强度的评价

- **V3**（即时生效，计数不增）**只能排除 `guards/**` 的 HMR / 插件重新 apply**，
  **不能**证明真实 UI 路径、并发、**缺 cwd** 边界 ⇒ 结论强度限于"apply 未重入"。
- **V6**（语义等价）只覆盖"无文件 / 空工作区"，且为**作者自证**，
  不足以证明上述边界 ⇒ **需要第三方复现**。

## 4. `NOT RUN`（红队声明，不许当已通过）

真实 symlink/junction exploit ｜并发压力 ｜真实 `configEditor` 故障注入 ｜真实 React / 浏览器渲染 ｜live 缺 cwd 场景 ｜未读 `.cache/dsh-guard/` 运行日志。

## 5. Lead 裁定与去向

**F1、F2 属"静默 fail-open"**——本项目最忌的失败形态，**必须在交付前修**；F4 是**UI 撒谎**，同属
"设了但不生效"的变体，**必须修**；F3 做**最小缓解 + 如实记录残余风险**。
⇒ 已开**第 3 轮**：`slices/guard-ui/TASK.3.md`，仍由本 slice 常任 writer `writer-guard-ui` 执行，
要求**先复现（留证据）再修**，并新增可复现用例。红队发现**与同模发现同等对待**（本项目口径）。
