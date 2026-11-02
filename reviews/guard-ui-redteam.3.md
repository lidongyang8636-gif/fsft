# 异构红队报告 · guard-ui 第 4 轮修复复核（**第 3 轮**）

- **红队**：只读异构 subagent `ea108f76-2197-4228-ae0d-0424cc990e55`，模型 `%PAYG_PROVIDER%2/gpt-6.1-sol`，effort `high`
- **日期**：2026-10-15 22:1x ｜ **性质**：只读，未改代码/配置/profile
- **落盘说明**：它的 delegated session 为只读，`write` 被沙箱拒绝，**未重试提权**；本文件由 **Lead 代为落盘**，
  每条由 Lead 独立复核后标注。
- **授权书**：`reviews/CHARTER.guard-ui-redteam.3.md`

---

## 1. 🔴 F4-NEW-1 · MED · **CONFIRMED** · 第 4 轮的修复**引入了新的误导文案**

| 项 | 内容 |
|---|---|
| 证据 | `client.js:341` 把 `saveOutcome()` 的 **`warn` 结果写进 `msg.err`**：`setMsg(outcome.level === "ok" ? {ok:…} : {ok:"", err: outcome.text})`；`client.js:489` 又对**所有** `msg.err` 套前缀 `t("loadFailed")`（`:57` 中文 = **「读取设置失败」**、`:96` 英文） |
| 后果 | `notes` 非空 / 未与 profile 权威校验 / 回读未通过 —— 这些**"已写入但有保留"**的结果，会被渲染成**「读取设置失败 + …」** ⇒ 用户以为**保存失败**，实际是**写成功** |
| 红队状态 | **CONFIRMED**；真页面 NOT RUN |
| **Lead 独立复核** | ✅ **CONFIRMED**（读过 `:328-347` 与 `:486-492`）。这是"修好一条、引入另一条"的典型：第 4 轮**正确地**把 notes 降级为 warn，却撞上了既有的"err ⇒ 读取失败"渲染约定 |

**修法（第 5 轮）**：引入**独立的 warning 通道**（如 `msg.warn`），用**自己的**样式/文案渲染，
**不得**复用 `loadFailed` 前缀。

---

## 2. 其余各项：红队确认**静态成立**（Lead 已复核）

| 项 | 红队结论 | 证据 |
|---|---|---|
| **F4-P2-1** | ✅ CONFIRMED 已修：`:222-228` 保证 `notes.length>0 ⇒ warn`，仅 `level==="ok"` 才追加 `saveOk`；**唯一** `saveOk` 路径是 `:226`；notes 逐条展示；空 notes + 两标志为真仍为 `ok` | Lead 已逐行核过 |
| **reset** | ✅ `:351-368` 只用 `resetOk/resetNone`；错误与 409 走 conflict/error，**无"下次生效"承诺** | Lead 已核 |
| **F2-P2-1** | ✅ `index.js:304-317`、`:356-363` 已区分"宿主级调用=静默"与"有 agent 缺 cwd=`agent-cwd-missing` 响亮"，与 `settings.js:598-615` 一致 | Lead 已核 |
| **F1-P2-2** | ✅ `settings.js:241-259` 仅 `ENOENT` fallback，其余 fail-closed。只读探针输出：`bad-nul=true`、`multi-missing-then-forbidden=true`、`multi-forbidden-then-missing=true`、`prefix-safe=false`（前缀陷阱未被误伤） | 权限/UNC/8.3/真实 junction **NOT RUN** |
| **F1-P2-3** | ✅ **未发现残留强声明**：`settings.js:455-464`、`README.md:190-195`、`HANDOFF.3.md:51-57` 都已明确"读路径存在字面 `existsSync` 例外" | Lead 已核 |

---

## 3. ⚠ 一条**操作性**观察（红队环境侧，但很重要）

红队报告：**无法向我发送消息**，因为它观察到
**Lead 会话 `session-cb49ba71-2ef4-4231-a34c-05be13ff8624` 显示 `unavailable`**。

这与用户报的"**上下缩放按钮不渲染**"可能是**同一根因：宿主 / GUI 处于降级状态**，
而**不是** guard-ui 那 8 行 diff（Lead 已静态排除：8 行、单槽位无 id 冲突、CSS 全兜底）。
⇒ **处置建议：先重启一次 DSH**（清客户端模块缓存与宿主状态），再回头验证 guard-ui。

---

## 4. `NOT RUN`

真页面渲染 ｜ 真实 HTTP 409 往返 ｜ 权限受限 / UNC / 8.3 短名 / 真实 junction ｜
跨进程竞态压力 ｜ **`redteam.3.mjs` 在红队的只读沙箱里跑不了**：
它在 3 个 PASS 后于 `mkdtempSync(%USERPROFILE%\AppData\Local\Temp\...)` 报 `EPERM` 停止
（**环境失败，不是断言失败**）。**Lead 在本机会话里跑过该脚本：exit 0。**

---

## 5. Lead 裁定

| 项 | 裁定 |
|---|---|
| **F4-NEW-1** | **必须修（第 5 轮）** —— 属"UI 撒谎"类，且是本轮修复**自己引入**的 |
| F4-P2-1 / reset / F2-P2-1 / F1-P2-2 / F1-P2-3 | **通过**（静态） |
| 检查点协议 | **改**：不再"长期启用"。改为"**你（用户）要看时 → Lead 启用 → 你刷新 → 看完 → Lead 立刻停用**"；**开发期一律 disabled** |

> **本轮红队的价值**：F4-NEW-1 是**"修 A 引入 B"**的教科书案例，而且**只有独立方**会去读
> "warn 文本最终被渲染成什么前缀"。作者自测只验了 `level`/文案字符串，**验不到渲染层**。
