# subagent-sandbox — 子会话沙箱配置手册

> **本插件会真的落档（enforce）**，不是只观察的探针。
> 历史：它最初是阶段 0 的插桩探针（`docs/查证_子代理沙箱委派.md` §9），
> 2026-10-14 **正名为 `subagent-sandbox`**（profile 的 `id` / `name` 已同步；旧目录见 §7 迁移说明）。

**状态**：阶段 0（可行性 E1–E5）与阶段 1（Manual）**均已运行期验证 PASS**；
本文件是它的正式配置接口。
**性质**：把**子会话**钉进指定权限档，补齐「只读」的另一半——
`role-guard` 管 **MCP 工具**，本插件管**文件沙箱**（+ 子会话审批，DSH 默认已钉 `never`）。

> **它做什么**：`agent/created` 时（serial，且在子代理**首次工具调用之前**被 await 完），
> 若新 agent 是**子代理**（能查出创建者），就把它的会话档位
> `permissionPresets.set(child.session, <childPreset>)`。**父/Lead 永不落档。**

---

## 1. 为什么需要它

| 面 | 谁在管 | 不装本插件的后果 |
|---|---|---|
| MCP 工具（`run_tcl`/烧板/改 RTL） | `role-guard` | 已拦 |
| **文件写入**（`write`/`edit`/命令） | **本插件**（会话级 sandbox） | **子代理能写文件 ⇒ 只读是"半只读"** |

实测（app.asar 源码 + 运行期）：DSH 委派子代理时**不会**自动给子会话定档
（只有父档是 `auto`/`danger-full-access` 才往下传），所以默认情况下子代理的文件策略
是 `custom`；本插件那一笔 `set` 才是把它钉住的动作。

---

## 2. 配置项（写进 profile 的 `cordis.patch.yml`）

```yaml
- insert:
    - id: subagent-sandbox
      name: '%MAIN_REPO%-dsh/guards/subagent-sandbox/lib/index.js'
      config:
        mode: set                    # off | observe | set
        childPreset: fpga-locked     # 钉给子会话的档名（必须在进程目录里）
        onlyChildren: true           # 只影响子代理；Lead 与自己不受影响
        strictPreset: true           # 首次真正要用时校验档名；坏名则跳过落档（不炸）
        writerExempt: true           # 写手团队成员豁免
        writerNamePatterns: [ 'writer' ]
        exemptNamePatterns: []       # 额外豁免名（如 [ 'audit' ]）
        eventLog: '%MAIN_REPO%-dsh/.cache/dsh-guard/sandbox-probe.jsonl'
```

### 2.1 逐项说明

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `off` / `observe` / `set` | `observe` | `off` 挂载但不动作；`observe` 只记录不落档（**试运行档**）；`set` 观察 + 落档 |
| `childPreset` | 档名字符串 | `fpga-locked` | 见 §3。`preset` 是它的**兼容别名**（有告警提示） |
| `onlyChildren` | bool | `true` | 只对子代理落档。写 `false` 会连自己一起钉——**通常不该关** |
| `strictPreset` | bool | `true` | 首次真要用时 `resolve()` 校验档名；失败则**响亮记录 + 跳过落档**（绝不 throw） |
| `writerExempt` | bool | `false` | 命中写手模式的**团队成员**保留原档 |
| `writerNamePatterns` | string[] | `['writer']` | 与 `role-guard` 共用同一个匹配函数（前缀或按 `-`/`_`/`.`/空格整词） |
| `exemptNamePatterns` | string[] | `[]` | 额外豁免名，同一套匹配语义，如 `['audit']` |
| `eventLog` | 路径 | 空 | JSONL 取证通道；**空则无任何记录**（不建议留空） |

### 2.2 ⚠ 两条纪律

1. **`mode: observe` 先试**：它只记录"如果落档会钉谁"，不改任何会话。
   换档/换环境时先跑 observe，看日志确认对象正确，再切 `set`。
2. **豁免只对团队成员生效**：子代理**不是**团队成员 ⇒ 写手的子代理**仍被钉只读**。
   这是刻意设计，与 `role-guard` 的「**写权限不可委派**」同口径。

### 2.3 命名 → 档位 规则表（`childPresetRules`）——"父代理按需设置"的**确定性**实现

```yaml
childPresetRules:
  - namePatterns: [ 'sim', 'simulate' ]
    preset: workspace-write        # 允许跑仿真、写产物
  - namePatterns: [ 'writer' ]
    preset: null                   # null ⇒ 豁免（保留原档）
  - namePatterns: [ 'reviewer', 'audit' ]
    preset: fpga-locked            # 纯只读
```

**语义**：只对**团队成员**生效；**按序求值、首个命中生效**；`preset: null` ⇒ 豁免。
未命中任何规则 ⇒ 回落 `childPreset`（子代理恒走这一条，因为它们不是成员）。

**优先级（自上而下，首个生效）**：

| # | 依据 | 结果 |
|---|---|---|
| ① | `writerExempt` + `writerNamePatterns` | 豁免 |
| ② | `exemptNamePatterns` | 豁免 |
| ③ | `childPresetRules`（按序） | 该规则的档位（`null` = 豁免） |
| ④ | `childPreset` | 默认档 |

#### 2.3.1 为什么是"按名字分档"，而不是"父代理传参数"

你最初要的 Auto 是"**父代理按需设置**"。它当然可以做，但**参数式**在这套宿主上有两道硬约束：

| 约束 | 依据 |
|---|---|
| **内置委派工具没有沙箱字段** | `SubagentStartRequest` = `{label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona?}`；`SpawnTeammateRequest` = `{name, description, prompt, context, provider, signal}`。**都没有** sandbox/preset |
| **必须"先登记意图、再派生"** | 派生后再 `set` 有竞态（子代理可能已开始调用工具）；安全落档点只有 `agent/created`（serial、且在子代理首次调用之前）。握手键只能用 **teammate 的不可变 name** |

⇒ 参数式 Auto 必须**自建委派工具**；而内置 `subagent`/`spawn_teammate` 仍然在，
模型完全可以继续用内置的 ⇒ **Auto 静默不生效**——正是本项目最忌讳的失败形态
（"设了但不生效"，见 `restrictMcpWriteTools` 那次事故）。

**而名字是 Lead 指定且不可变的** ⇒ 用名字分档同样实现"父代理按需设置"，
但是**确定的**（不依赖模型自觉）、**不需要新工具**（无 split-brain）、**完全可审计**
（每条落档都记 `presetChosenBy`）。

> 取舍说明：本表覆盖 teammate 路径（有名字）。**非团队的 `subagent` 子代理没有稳定名字**，
> 恒走 `childPreset` —— 若日后确实需要给它们分档，那才需要自建委派工具（真 Auto）。

---

## 3. 可用的档名（进程目录）

```
workspace-write      在工作区与许可临时目录内写入；越界重试需批准
danger-full-access   全盘写入且不弹审批
fpga-readonly        宿主强制只读；越界弹窗征求批准（有逃生门）
fpga-locked          只读且无逃生门——越界直接失败，连提权申请都不给   ← 本插件默认
auto                 由 auto-review 集成决定
```

档名以**运行时目录**为准（`probe-start.catalog` 会把它写进日志，可直接核对）。

---

## 4. 取证（怎么知道它真的生效了）

日志：`<eventLog>`（JSONL，一行一事件）。

| 事件 | 含义 |
|---|---|
| `probe-start` | 插件加载并读完配置。**这是"插件真的加载了"的判据**；含 `effectiveConfig`、`configWarnings`、`catalog` |
| `listener-registered` | `agent/created` 监听器注册结果（`ok:false` 说明该上下文不支持事件） |
| `roster-snapshot` | 全量快照：每个 agent 的 `preset` 与 `parent`（**改前/改后各一份**，用来证明父没被动过） |
| `agent-created` | 每个新 agent：`hasSession` / `presetBefore` / `parentId` / `isChild` |
| `set-applied` / `set-failed` | 落档结果，含 `presetBefore`/`presetAfter` 与 `parentUnchanged` |
| `skip-writer-exempt` / `skip-name-exempt` | 豁免命中（`matchedBy` 指出是哪条规则） |
| `skip-not-child` / `skip-no-session` / `skip-no-service` / `skip-invalid-preset` | 各类跳过及原因 |
| `probe-error` | 探针自身出错（**不影响会话**） |

**独立行为判据**（不依赖日志）：让子代理写一个工作区文件。
被拒串应为 `[sandbox: file access denied under read-only mode]`；读文件应正常。

---

## 5. 失败方向（设计意图）

| 情形 | 行为 | 为什么 |
|---|---|---|
| 档名写错 | **响亮记录 + 跳过落档**，不 throw | 在 `agent/created` 抛异常会让**子代理创建失败** |
| 挂载时服务未就绪 | 只记录，不 throw、不中止 apply | 2026-10-14 实测：挂载期 `permissionPresets` 还不存在，早期版本因此"自炸"⇒ 监听器从未注册 ⇒ 假只读 |
| 取不到团队服务 | 记 `skip-no-service` 后返回（**不落档**） | 宁可不管，也不误钉 |
| 探针内部异常 | 只记 `probe-error` | 铁律：**加固层不得拖垮主功能** |

---

## 6. 安全边界与信任假设（**必读**）

### 6.1 本质：宿主侧静态策略，不是"主 agent 分配沙箱"

| 环节 | 谁决定 | 何时 | 依据 |
|---|---|---|---|
| **策略内容**（钉哪个档、谁豁免） | **人**（profile 里的 `config`） | 运行前 | 配置文件 |
| **是否落档 / 是否豁免** | 本插件（执行器） | 每个子代理诞生时 | 名字匹配 |
| **子代理叫什么名字** | **Lead**（派成员时传 `name`） | 每次委派 | `spawn_teammate(name=…)` |
| Lead 自己的档位 | 人在 GUI 的权限选择器 | 会话级 | 本插件**不碰**非子代理 |

⇒ 主 agent 在链路上**没有沙箱决策入口**（内置委派工具的请求体里没有沙箱字段）。
本插件是**策略执行器**，不是分配器。

### 6.2 ⚠ 信任假设一：**命名即分配**

豁免是**按名字**判的，而**名字由 Lead 给**：

```text
name='writer-rtl'  → 豁免（保留 workspace-write）
name='reviewer-rt' → 钉 fpga-locked
（子代理没有名字、且不是团队成员）→ 一律钉死
```

**后果**：Lead 可以把一个本该只读的成员命名为 `writer-reviewer` 从而给它写权限。
这在本项目口径（"只有 `writer*` 能写"）下**字面合规**，但意味着
**"谁该是只读"最终取决于 Lead 的命名纪律，而不是环境强制**。

**收紧方式**（一行，配置改动可热重载）：

```yaml
writerExempt: false      # 所有子代理一律钉死；只有 Lead 自己的会话能写
```

### 6.3 ⚠ 信任假设二：**锁的配置与锁本身在同一个可写面上**

- 策略存在 `cordis.patch.yml`（**在会话工作区之外**）⇒ 改它需**提权 + 人批准**；
- 但 `mode: off` / `writerExempt: true` 这类改动**足以关掉这把锁**；
- 且 HMR 生效后，这类改动**不再需要重启**——**少了一道可见的确认门**。

⇒ **真正的边界是"人是否审那个提权弹窗"，不是文件权限本身。**
处置建议：

1. 把 `cordis.patch.yml` 里涉及 `mode` / `childPreset` / `writerExempt` 的改动
   一律视为**敏感变更**，逐条看清；
2. 或在需要硬门时把 HMR 关掉（`disabled: true`）——策略改动退回"需重启"，代价是你也要重启。

### 6.4 ⚠ 本插件**不覆盖**的面（不在"只读"保证内）

| 面 | 谁管 | 说明 |
|---|---|---|
| **MCP 写类工具**（`run_tcl`/烧板/`set_backend`） | `role-guard`（工具级 guard） | 本插件不管工具 |
| **`pwsh` 等 shell 直达厂商二进制** | **没人管** | ⚠ 见下 |
| 主仓库（`%MAIN_REPO%`）的写入 | **会话工作区边界** + 提权 | FPGA 源码对所有会话都只读 |
| 位流陈旧 | 仓库自带 `bitstream_gate.tcl` | 与本插件无关 |
| "同一 checkout 只有一个 writer" | **纪律**（无环境强制） | 本插件只按名字分档，不查并发 |

> ⚠ **`pwsh` 是一处真实缺口**：`role-guard` 拦的是 `mcp__*` 工具，
> 而 `pwsh` 可以**直接调用厂商二进制**（如 `vivado.bat` / `xsdb`），
> 从而**绕过 MCP 工具级的只读限制**。文件沙箱能挡住它写文件，
> 但**挡不住它与硬件对话**（烧板不是文件操作）。
>
> **已代码确认**（`../role-guard/lib/index.js:482`）：
> `if (!isMcpTool(n)) return { deny: null, source: 'nonMcp' }; // 非 MCP 不管`
> ⇒ `pwsh` 等 shell 工具**不在 role-guard 管辖内**。
>
> **已运行期确认（2026-10-14，**CONFIRMED**）**：一个被自动钉成 `fpga-locked` 的
> `reviewer-*` 成员实测——
>
> | 测试 | 结果 |
> |---|---|
> | `pwsh -Command "echo shell-ok"` | ✅ 跑通（退出码 0，输出 `shell-ok`） |
> | `Test-Path 'G:\vivado\Vivado\2019.1\bin\vivado.bat'` | ✅ `True`（厂商二进制可见） |
> | `write` 一个工作区文件 | ❌ `file access denied under read-only mode` |
>
> ⇒ **只读子会话能起 shell，且能看见厂商二进制**（**未**启动 Vivado 本身，故"能否真烧板"是**推断**而非实测）。
> pwsh 在只读档下运行于 ConstrainedLanguage，但该模式**不限制调用外部可执行文件**，封不住此路径。
>
> #### 6.4.1 处置进度（**已处置，但请按"减速带"理解**）
>
> | 方案 | 状态 |
> |---|---|
> | **A · 内容匹配**（`role-guard.shellScope`，**减速带**） | ✅ **已实施并运行期验收**（`echo -sendhex-probe` → DENY；被动监听 → ALLOW）。详见 [`../role-guard/README.md` §6.5](../role-guard/README.md) |
> | **B · 工具面移除**（`toolFilter`，**硬边界**） | ⛔ **不做**（2026-10-14 用户决定）—— 串口抓取本身就是 shell 操作，去掉 shell 会把**抓串口一起禁掉**，与"Lead 要能抓串口"冲突 |
>
> ⇒ 现状：**面 1（厂商/烧板）+ 面 2（串口写）已挡**，但**仍是文本减速带、非硬边界**
> （变量 / base64 / 路径拼接可绕过）。**不要把这里读成"完整的只读保证"。**
>
> ⚠ A 的三条限制（硬边界？误伤？裸 `vivado`？）见 role-guard README §6.5.3；
> **B 落地前，不要把三件套宣传为"完整的只读保证"。**

### 6.5 Lead 自身

- 本插件**不锁 Lead**（`onlyChildren: true`，且 Lead 查不出创建者）；
- Lead 的档位由人在 GUI 决定；
- Lead 不能**静默**改自己的档位——想越界只能走**单次提权请求**，由人批准。

---

## 7. 已知边界（**不要当成已通过**）

| 项 | 状态 |
|---|---|
| **Auto 模式**（参数式：父代理每次委派传沙箱参数） | **不做**（2026-10-14 决定）—— 见 §2.3.1 两道硬约束 + 静默不生效风险；改以**命名→档位规则表**替代 |
| **命名→档位规则表**（`childPresetRules`） | ✅ 已实现、离线 15 条用例全过；**代码仍需一次重启激活**（配置已就位，向后兼容 ⇒ 重启前行为不变） |
| **插件管理页 UI**（Default/Auto/Manual 点选） | `NOT IMPLEMENTED` —— 路 B，需把插件做成带 client 半侧的 bundle 包 |
| 源码级 HMR | **不一致**：实测 role-guard 的新代码经 reload 上线了，但**本插件没有**（`probe-start` 仍为旧格式）⇒ **不能依赖**，改代码按"需重启"对待 |
| 真实 Vivado 工作流下的行为 | `NOT RUN` —— 阶段 0/1 全部用文件读写验证，未启 Vivado |
| **`pwsh` → 厂商二进制** 的绕过面 | 见 §6.4（role-guard 的 `shellScope` 已封，但**是减速带非硬边界**） |

---

## 8. 迁移说明：`subagent-sandbox-probe` → `subagent-sandbox`（2026-10-14）

| 项 | 旧 | 新 |
|---|---|---|
| 目录 | `guards/subagent-sandbox-probe/` | **`guards/subagent-sandbox/`** |
| profile `id` | `subagent-sandbox-probe` | **`subagent-sandbox`** |
| 模块路径（profile `name`） | `…/subagent-sandbox-probe/lib/index.js` | **`…/subagent-sandbox/lib/index.js`** |
| 插件导出 `name` | `subagent-sandbox-probe` | **`subagent-sandbox`** |
| npm 包名 | `dsh-subagent-sandbox-probe` | **`dsh-subagent-sandbox`** |
| **取证日志文件名** | `sandbox-probe.jsonl` | **保留旧名（刻意）** |

**为什么日志名不改**：`sandbox-probe.jsonl` 是阶段 0/1 的**原始证据**，
[RT-阶段0_实验记录](RT-阶段0_实验记录_20261014.md) 与
[查证文档](../../docs/查证_子代理沙箱委派.md) 都逐字引用它。**改名会打断证据链**——
按本项目纪律，证据宁可保留旧名，也不为了整齐去动它。

> ⚠ **旧目录 `guards/subagent-sandbox-probe/` 可能仍在盘上**：
> 正名时 DSH 宿主正持有 `lib/index.js` 的句柄，Windows 拒绝对该目录改名
> （实测：临时目录能改名、`guards/` 下能建目录 ⇒ 不是沙箱限制，是句柄占用）。
> 因此采用"**复制到新名 + 旧目录留待重启后删**"。
> **重启后**执行 `Remove-Item -Recurse -Force guards/subagent-sandbox-probe` 即可，
> 删之前确认 profile 只引用新路径。

---

## 9. 相关文档

- 可行性查证与设计取舍：`docs/查证_子代理沙箱委派.md`
- 阶段 0 实验记录（E1–E5 全 PASS + 原始证据）：`RT-阶段0_实验记录_20261014.md`
- 工具侧只读边界（MCP）：`../role-guard/README.md`

