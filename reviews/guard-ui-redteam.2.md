# 异构红队报告 · guard-ui 第 3 轮修复复核（**第 2 轮**）

- **红队**：只读 subagent `b49afbfc-df9c-4898-a593-2dc3340fa3ff`
- **模型**：`%PAYG_PROVIDER%2/gpt-6.1-sol`（**异构槽位**），effort = `high`
- **日期**：2026-10-15 ｜ **性质**：只读对抗性复核**修复本身**，未改任何代码/配置/profile
- **落盘说明**：红队 delegated session 强制 read-only，`write` 被沙箱拒绝，**它按约束未重试提权**；
  本文件由 **Lead 代为落盘**（Lead 允许的"证据采集/落证据"），**每条由 Lead 独立复核后标注**。
- **编号口径**：沿用红队给的 `F?-P2-?`（P2 = 第 2 轮）。
- **审查对象**：第 3 轮对 F1–F4 的修复（`guards/guard-ui/lib/*`）+ `REPRO.3.md` + `HANDOFF.3.md`

---

## 1. Findings

### 🔴 F4-P2-1 · MED/HIGH · **CONFIRMED** · `notes` 非空仍输出"已保存、下次生效"（**真回归**）

- **证据**：`lib/client.js:211-223`。`level` **只**由 `!verified`（`:218`）与 `!withProfile`（`:219`）决定；
  `:220` `if (level === "ok") lines.push(t("saveOk"))`；`:221` 之后才逐条追加 `notes`。
- **触发**：`{combinationCheckedWithProfile:true, verified:true, notes:['x']}` ⇒ **`level="ok"` + `saveOk`**，
  notes 只是被"附在后面"。
- **违背**：`TASK.3.md` F4 要求「`combinationCheckedWithProfile===false` **或 `notes` 非空** ⇒ 不得显示无条件成功文案」；
  `HANDOFF.3.md:79-81` 也自称"notes 非空不得成功"。
- **漏测**：`test/redteam.3.mjs:149-165` 覆盖 4 个分支，**缺"两标志为真 + notes 非空"**。
- **Lead 复核**：✅ **CONFIRMED**（逐行读过，判级确实不看 `notes`）。**这是实现违背授权书，不是红队误读。**

### 🔴 F1-P2-1 · HIGH（残余）· **CONFIRMED（结构）** · realpath 判定 → 写/删之间的 **TOCTOU**

- **证据**：判定/解析 `settings.js:702-714`；读 `:452-464`；**写** `:775-780`；**删** `:813-832`。
- **机理**：路径在**判定时**解析、操作在**之后**发生 ⇒ 在两次 syscall 之间把**某个祖先**换成 reparse point，
  操作仍可能落到别处。真实 exploit **NOT RUN**（沙箱拒绝把 reparse point 指向可写根之外）。
- **Lead 复核**：✅ 结构性成立。⚠ 好消息：写/删用的是**解析后的**路径（消除了"检查后换叶子"那一类）；
  坏消息：**祖先链替换**在纯路径 API 下无法根除。红队原话：**"不是缓解"**——插件在宿主进程内、无第二层兜底。
- **裁定**：**接受为残余，如实记录**（见 §2）。

### 🟡 F2-P2-1 · LOW/MED · **CONFIRMED** · 页面 caveat 把"静默"与"响亮"并列

- **证据**：`index.js:308-313`（页面常显 caveat）把"宿主级调用或未设置 cwd 的会话"并列，
  并跟一句"（guard 侧会响亮记录 `agent-cwd-missing`）"。
  实际 `settings.js:581-597`：**无 agent ⇒ `host-level-call` + `problems:[]`（静默，设计内）**；
  **有 agent 缺 cwd ⇒ `agent-cwd-missing` + problems（响亮）**。
- **Lead 复核**：✅ **CONFIRMED**（两处都读过）。读者会以为宿主级调用也告警 ⇒ **UI 对"静默"撒谎**。

### 🟡 F1-P2-2 · LOW/MED · **INFERRED** · 禁用根解析失败退化为字面比较

- **证据**：`settings.js:232-250`。目标解析失败 ⇒ `return true`（fail-closed ✅）；
  **根**解析失败 ⇒ `realRoot = resolve(root)`（`:245`）退化为字面比较，与"解析失败一律禁"注释冲突。
- **Lead 复核**：⚠ **部分成立，且退化本身有正当理由**——本机可能存在**不存在的禁用根**
  （如 `%MAIN_REPO%`）；若根解析失败也一律 fail-closed，会**把全部工作区全拒**。
  ⇒ **裁定：保留退化，但收紧为"仅 `ENOENT` 时退化"**，其它失败仍 fail-closed，并让注释与行为一致。

### 🟡 F1-P2-3 · LOW · **CONFIRMED** · 存在未走 native 的读 fast path ⇒ 强声明不实

- **证据**：`settings.js:445-447`——`// ⚠ 常态（无文件）走最快路径：**不做 realpath**`；
  `const literalFile = settingsPathFor(cwd); if (!existsSync(literalFile)) return {status:'absent', ...}`。
- **影响**：低（只在"文件不存在"时走，不会读到禁用根里的**内容**；但确实会**探测**字面路径）。
  真正的问题是**声明**："读/写/删落点全部基于 realpath"**不实**。
- **Lead 复核**：✅ **CONFIRMED**（读过 `:443-454`，代码注释自己承认）。

### 🟡 F3-P2-1 · MED · **INFERRED（代码 CONFIRMED）** · `fileToken` **非强 CAS**

- **证据**：`settings.js:190-213`，令牌只有 `{exists, mtimeMs, size}` ⇒ 可碰撞（同尺寸同 mtime 替换）、
  **客户端可伪造**；且 `index.js:331` `payload?.expect ?? undefined` ⇒ **不传 `expect` 即跳过 CAS**。
- **Lead 复核**：✅ **CONFIRMED，且有实测旁证**：Lead 用**伪造令牌**打真路由被**接受并写入**
  （因该令牌恰与真实状态一致 ⇒ 说明令牌是可构造的普通对象、无签名）；对照探针**不带 `expect`**
  同样 200 写入 ⇒ **"省略即跳过 CAS" 已实测**。详见 [PLAN §12.3.2–§12.3.3](../../slices/guard-ui/PLAN.md)。

### 🟡 F3-P2-2 · MED · **CONFIRMED（代码）/ 压力 NOT RUN** · CAS 之后仍有竞态

- **证据**：`stat` 之后到 读 `:716-733` / quarantine / rename `:775-780` / unlink `:824-832` 之间仍无锁。
- **裁定**：与 F3-P2-1 合并为**残余风险**，如实记录（**不得**称"已解决"）。

### 已核对**未发现问题**的部分（同样重要）

| 项 | 结论 |
|---|---|
| **两个 guard 的调用点** | `subagent-sandbox:269-271`、`role-guard:570-584` **都**走 `resolvePluginConfig` + `reportProblems`；**未发现第三条静默回落路径**（live NOT RUN） |
| **F4 的 `reset`** | `client.js:349-356` 的成功文案**不是** `saveOk` ⇒ **不算**"无条件下次生效" |
| **普通路径** | 未发现确认性的**新**脆弱（红队明确结论） |

### `NOT RUN`（不许当已通过）

真实 junction 指向主仓库 ｜ TOCTOU exploit ｜ 根解析异常 / UNC / 8.3 短名 ｜ token 碰撞 ｜
跨进程竞态压力 ｜ 真页面渲染 ｜ 真实 HTTP 409 往返。

---

## 2. Lead 裁定

| 编号 | 裁定 | 理由 |
|---|---|---|
| **F4-P2-1** | **必须修（第 4 轮）** | **真回归**：违背授权书硬要求 + UI 撒谎；测试还漏测该组合 |
| **F2-P2-1** | **必须修（第 4 轮，小改）** | 同上（文案层面撒谎） |
| **F1-P2-2** | **必须收紧** | 保留正当退化，但只在 `ENOENT`；注释与行为一致 |
| **F1-P2-3** | **必须消解**（改代码**或**改声明，二选一） | 诚实优先；**禁止**保留不实的强声明 |
| F1-P2-1 | **接受为残余 + 如实记录** | 纯路径 API 下无法根除；须写明"祖先链替换"且"无第二层兜底" |
| F3-P2-1 / F3-P2-2 | **接受为残余 + 如实记录** | 同源 loopback 围栏下可接受；须写明"**非强 CAS**、可伪造、可省略" |

⇒ 已开**第 4 轮**：`slices/guard-ui/TASK.4.md`（仍由本 slice 常任 writer 执行）。

---

## 3. 本轮红队价值小结

- **F4-P2-1 是上一轮修复自己引入的真回归**（修 F4 时漏了 `notes` 分支，且自测漏测该组合）——
  **"修好了"必须由独立方复核，作者自证不够**，本轮就是证据。
- **F2-P2-1 / F1-P2-3 都是"声明与行为不一致"**：代码未必危险，但**说辞不实**。
  本项目口径是**证据优先于叙述**，所以这类必须消解。
- 红队同时**主动排除了**两条怀疑（第三条静默路径、`reset` 文案），并明确"普通路径无新脆弱"——
  这种"否定性结论"同样是交付的一部分。
