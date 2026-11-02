# FPGA 模式

**位置：`%MAIN_REPO%-dsh\docs\FPGA_MODE.md`（本工作区，可写）**
**性质：会话级模式的入口与差异清单。** 进入 FPGA 模式后，本文档优先于默认习惯。

---

## 0. 一句话

**FPGA 模式 = 更严的默认 + 固定的一组入口。**

标准模式靠自觉；FPGA 模式下**默认就把写操作当高危**，
因为这套工作面对的是比特流、板子、电机——**错误不可回滚**。

> 动 FPGA 相关的事（RTL / XDC / IP / Block Design / 综合 / 实现 / 比特流 / 烧板 / ILA）
> **一律走本模式**。

---

## 1. 进入 FPGA 模式（怎么算"进入"）

以下任一成立，即视为处于 FPGA 模式：

- 用户说"进入 FPGA 模式"/"FPGA 模式"/"按 FPGA 模式来"
- 任务触及 Vivado / 综合 / 实现 / 比特流 / 烧板 / ILA / RTL / XDC / IP / Block Design
- 任务触及 `mcp__vivado__*` 或 `mcp__fpga-mcp__*`

**退出**：用户说"退出 FPGA 模式"或明确切到别的工作（如 Android / 后端）。

---

## 2. 与标准模式的差异（**核心**）

| 维度 | 标准模式 | **FPGA 模式** |
| --- | --- | --- |
| 写 MCP 工具 | 按清单先问后调 | **writer 必须先给"三段自述"**；**只读成员与 Lead 的写类 MCP 已被硬掩码 / 角色档移除**（无从"先问"）|
| 只读工具 | 直接调 | 直接调（不变） |
| 动手前 | 直接开工 | **必须先定模式**：`ANALYZE` / `QUICK` / `FULL` |
| 工艺 | 按需 | **必须先声明 `claim_stage`** |
| 产物落点 | 本工作区任意 | **固定 `fpga_out/<run-id>/`** |
| 失败归类 | 按需 | **必须先分类**（十分类），只有 `DUT_FAIL` 才改 RTL |
| 写者 | 不限 | **同一 checkout 只有一个 writer** |
| 完成声明 | 说明结果 | **必须标 `NOT RUN` / `UNVERIFIED`**，不得含糊 |
| 证据 | 带日期环境 | 同左，且**报告必须附工具版本** |

### 2.1 FPGA 模式独有的"三段自述"（比标准模式更严的地方）

调任何写/执行类 MCP 工具前，必须先说清三件事：

1. **要调什么** —— 工具名 + **完整参数**
2. **预期影响** —— 会写什么、起什么进程、动哪块板子
3. **影响范围判定** —— 属于 `ANALYZE` / `QUICK` / `FULL` 哪一档，为什么

标准模式只需要"要调什么 + 影响"两句；FPGA 模式**多一句模式判定**。

> 依据：[设备端高危MCP工具清单.md](设备端高危MCP工具清单.md) §1/§4 +
> [FPGA工作流纪律.md](FPGA工作流纪律.md) §1。

---

## 3. 开工清单（照顺序走）

```text
1. 读纪律        → FPGA工作流纪律.md（判定规则）
2. 定模式        → ANALYZE / QUICK / FULL
3. 定 claim_stage→ PREFLIGHT … BOARD_PREP
4. 建产物目录    → fpga_out/<run-id>/
5. 建证据基线    → CONFIRMED / INFERRED / UNKNOWN
6. 查高危清单    → 设备端高危MCP工具清单.md（写工具先问）
7. 动手
8. 收口          → 失败分类 + NOT RUN 标注 + 落证据
```

**第 4 步的坑**：**别在工作区根目录启动 Vivado**——它把 `vivado.log` /
`webtalk*` / `.Xil/` 生成在**启动时的 cwd**。先 `cd` 进 `fpga_out/<run-id>/` 再启动。

---

## 4. 四份文档的分工（避免重复查）

| 想知道 | 读 |
| --- | --- |
| **模式怎么走、差异是什么** | **本文档** |
| 判定规则（三模式、claim_stage、失败分类、单写者、修复上限） | [FPGA工作流纪律.md](FPGA工作流纪律.md) |
| 哪些 MCP 工具要先问 | [设备端高危MCP工具清单.md](设备端高危MCP工具清单.md) |
| 产物往哪放 | [fpga_out/README.md](../fpga_out/README.md) |
| 沙箱/提权/工作树/验证入口/设备安全 | [docs/工作区手册.md](工作区手册.md)（§2 / §3 / §5）＋ [AGENTS.md](../AGENTS.md) **§3 红线** |

**不重复**：本文档只讲"差异与串联"，判定细节一律指向上面四份。

---

## 5. FPGA 模式下的固定落点

```text
%MAIN_REPO%-dsh\fpga_out\<run-id>\
```

- `<run-id>` 建议 `YYYY-MM-DDTHHMMSSZ-<短描述>`
- 运行时日志进 `fpga_out/_runtime_logs/<日期>_<主题>/`
- **不往工作区根目录丢任何东西**
- 根目录只放纪律文档（本文件也算）

---

## 6. 高风险提醒（FPGA 模式特别强调）

按 [AGENTS.md](../AGENTS.md) **§3 红线 5–9**（设备安全 / 电机供电 / PL 关断权 / 锁态），以下属于**不可回滚**动作：

- **烧板**（`program_device` / `viv_xsct_download_*` / `*_program_*`）
- **生成比特流**（产出可烧制品）
- **任何碰电机的动作** —— 电机与锁控**一律 FULL，没有"小改"**

**PL 必须始终保有电机最终关断权**；**锁态以独立物理传感器为准**，
不能由"已经发送开锁命令"推断为已开锁。

---

## 7. 能力边界（2026-10-21 复核）

> ⚠ 本节旧标题是"尚未做到的部分"、结论是"**半边护栏**"。**那个结论已经过时**：
> 2026-10-21 硬掩码上线后，**只读成员的写类 MCP 已被机械移除**。下表按实测重写。

| 能力 | 状态 |
| --- | --- |
| **权限预设**（`sandbox: read-only` 硬闸门） | ✅ **已落地**：`fpga-readonly`（运行配置 `cordis.patch.yml` 的 `presets:` 段），见 §8.3 |
| **只读强制（子 agent）** | ✅ **已硬**：`role-guard` 的 `restrictMcpWriteTools: 'hard'` 把只读成员的**写类 MCP** 从模型工具面移除（实测 `hard-mask-applied count=498 / restrictable=921`；`TOOL_ABSENT` ×2）|
| **MCP 写工具（只读成员）** | ✅ **已硬**；⚠ 只掩**继承层** —— `read`/`write`/`pwsh`/`send_message` 属 preset 自身层，**掩不到** |
| **MCP 逐工具审批** | ❌ **仍没有**：`dsh-mcp-client` 无审批字段（**这一条没变**）|
| **shell 起厂商工具（vivado / xsct / 串口写）** | ⚠ **减速带**：`shellScope` 文本匹配，变量 / base64 / 路径拼接可绕 |

**结论（已更新）**：**文件面 + 只读成员的写类 MCP 面 = 硬**；**shell 绕过 + 逐工具审批 = 仍软**。
不是"半边护栏"了，但也不是"全硬" —— 准确的划分按上表。
机制、边界与证据：`ARCHITECTURE.md §10.3`；验收数字见 [P1P2-执行记录](P1P2-执行记录_2026-10-21.md) §「D5 硬掩码线上验收证据」。

## 8. 做成 DSH 原生档位：用权限预设（**已落地 `fpga-readonly`**，见 §8.3）

理想形态：新建会话时能选一个"FPGA"档位，一进去就是这套规矩。

### 8.1 正确的机制是「权限预设」，不是「agent 预设」

**插件**：`@deepseek-ai/dsh-permission-presets`（profile id = `permission`）

**schema（`listConfigs` 实测）**：

```yaml
presets:
  <名字>:
    sandbox:   read-only | workspace-write | danger-full-access   # 必填
    approval:  ask | never                                        # 必填
    name:        "显示名"
    description: "说明"
defaultPreset: <名字>
```

**`sandbox: read-only` 就是 Codex `sandbox_mode = "read-only"` 的等价物**，
而且是**宿主强制**——这才是之前几轮一直缺的硬约束。

**UI 入口已确认存在**：客户端 slot 树里有 `conversation.hero.agentPreset`
（"Agent-preset control staged for a New Session"），新建会话时有选择器。

### 8.2 走过的弯路（记录，避免重复）

**agent preset 走不通**：`@deepseek-ai/dsh-agent-preset-registry` 只管
`default` / `selectedDefault` 两个字符串（选中哪个），**不定义内容**；
真正的定义是 `PresetDefinition.plugins[]`——**只描述"加载哪些插件"，
管不了沙箱与审批**。且内置 `standard` / `cordis` 的声明文件在 `app.asar` 内部，
未定位到（已排除：profile 目录、`app.asar.unpacked`、`node_modules`）。

→ **要做"更严的审批"，用权限预设，不要碰 agent preset。**

### 8.3 已落地：`fpga-readonly` 权限预设（2026-10-08）

在 `cordis.patch.yml` 新增了 `- id: permission` 条目，加了一个档位：

```yaml
fpga-readonly:
  sandbox: read-only      # ← 宿主强制只读
  approval: ask
  name: FPGA 只读
  description: 宿主强制只读。适合 ANALYZE 阶段：看报告、审 RTL、读时序。任何写入都会被拒绝。
```

**默认仍是 `workspace-write`，现有行为不变。**

只加了这一档、没加 `fpga-impl`：因为 `fpga-impl` 的 `sandbox: workspace-write`
**与默认档完全相同**，只是换了个名字——**是冗余而非能力**。

`fpga-readonly` 直接落地了 [FPGA工作流纪律.md](FPGA工作流纪律.md) §8
「单写者 + 只读审查者」——**ANALYZE 阶段就该用它，写入会被宿主拦下**。

> ⚠️ **重启后生效**（2026-10-08 落地时口径）；配置现值见运行 profile 的 `presets:` 段。重启后请实测：切到「FPGA 只读」写文件**必须被拒绝**。
> 详见 [查证_DSH的Preset机制.md](查证_DSH的Preset机制.md) §9。

### 8.4 agent preset：已找到写法，但暂不可做

**真实写法**（查证所得）：

```yaml
- id: preset-<名字>
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: <preset id>          # 必填
    plugins: [ ... ]         # 必填——完整插件清单
    name: "显示名"            # 可选
    description: "说明"       # 可选
```

**`plugins[]` 是必填的完整清单**，而内置 preset 的清单在 `app.asar` 里，
**本机读不到样本**。硬猜会做出残缺的 preset（可能缺工具 / skill / MCP 挂载），
**风险大于收益，故暂不做**。

> 这也纠正了一个常见误解：内置 preset **不是**靠磁盘目录发现的
> （`$DSH_HOME/.agent-presets/` 那套说法实测不存在），
> 而是靠 `package.json` 的 `dsh.profile.bundles` 里的条目声明。

### 8.5 硬闸门拦不住什么（重要）

| 面 | 权限预设能拦吗 |
| --- | --- |
| 写文件（pwsh / write 工具） | ✅ **能**（`sandbox: read-only`） |
| **MCP 写类工具**（`mcp__vivado__run_tcl` 等） | ✅ **能拦**（`restrict` 硬掩码，2026-10-21 起）——但**只掩继承层**，且只针对只读成员 |
| **MCP 读类工具**（`report_*` / `get_*`） | ❌ 不拦（这是"取证"要用的） |

所以预设 + 高危清单**两者都要**，不能互相替代。

---

## 9. 开 subagent / 智能体团队（2026-10-21 更新）

**能开，而且"只读"现在有机械执行。** 详见 [查证_只读subagent与团队.md](查证_只读subagent与团队.md)。

**要点**：

- `spawn_teammate` 的参数只有 `name` / `description` / `prompt` / `context` —— **没有任何权限字段**（这条没变）
- **但只读已由宿主侧强制**：`role-guard` 硬掩码把**非 writer 成员**的写类 MCP 从工具面移除（`ARCHITECTURE.md §10.3`）
- ⚠ **名字就是权限**：名字必须命中 `writer` 模式才保留写权；否则**含 Lead 在内**一律按只读处理（`ARCHITECTURE.md §2.3`）
- **同一 checkout 同一时刻只有一个 writer**（`AGENTS.md §3` 红线 11）

**当前团队形态（不再是"1 writer + N 审查者"）**：

| 角色 | 数量 | 说明 |
| --- | --- | --- |
| writer（front / backend / fpga） | 每端 1 | 写域互不重叠；一 slice 一常任 writer（含返修不换人）|
| 分析员 / 审查者（深度 2） | 每 writer 至多 1 | 写手自己开的只读助手 |
| 独立审查者 `reviewer-lead`（深度 1） | 按需（每轮 1–3） | 直挂 Lead，审**写手的审查者结构上看不到**的全局盲区 |

**按 FPGA 档位选**：

| 档位 | 开团队？ |
| --- | --- |
| `ANALYZE` | ✅ 适合并行只读审查，真能提速 |
| `QUICK` | ❌ 别开，协调开销大于收益 |
| `FULL` | ⚠️ 只开只读审查者，**writer 永远一个** |

开只读审查者时，**prompt 仍要把禁调工具列清楚**（硬掩码只覆盖写类 MCP 的**继承层**，不是万能）——
**模板见 [只读审查者模板.md](只读审查者模板.md)**。

---

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-08 | 建档。定义 FPGA 模式的进入条件、与标准模式的 10 项差异、三段自述、四文档分工、未做到的部分。preset 原生形态标注为待验证。 |
| 2026-10-21 | **去掉落后偏移**（用户指出）。① §7「权限预设待落地 / 子 agent 只读不行 / MCP 调用仍软 / 半边护栏」**全部过时** ⟹ 按实测重写：`fpga-readonly` 已在运行配置；`restrictMcpWriteTools: 'hard'` 已把只读成员写类 MCP 移除（`count=498`、`TOOL_ABSENT`×2）。② §8.5 同表更新（写类能拦、读类不拦）。③ §9 删「restrict 需自己写插件 / 本仓库未实施」；团队形态由「1 writer + N 审查者」（2026-10-08 单写手时代）改为**三写手 + 深度 2 配额 + reviewer-lead**。④ 修 `AGENTS.md` 失效节号（原文 §3/5/7/8 与 §8 ⟹ AGENTS 只有 §0–§6，改指手册与 §3 红线）。⑤ 两个 `## 9` ⟹ 第二个改 `## 10`。 |
