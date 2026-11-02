# ~~待落地~~ → **已落地**：DSH `fpga-readonly` 权限预设

> **状态更新（2026-10-08）：已落地。** 本文件保留为**方案与理由的记录**，
> 实际执行结果与验证步骤见 [查证_DSH的Preset机制.md](查证_DSH的Preset机制.md) §9。
>
> **实际落地时与原方案有一处差异**：只加了 `fpga-readonly` 一档，
> **没加 `fpga-impl`**——因为它的 `sandbox: workspace-write` 与默认档完全相同，
> 只是换了个名字，**是冗余而非能力**。理由见 §2.2。

**原状态：未落地（配置文件在工作区外，需提权）**
**目标文件：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`**
**备份：已建两处（工作区 + 同目录 `.bak-fpgamode-20261010`）**

---

## 0. 为什么是"权限预设"而不是"agent 预设"

查证结论：**DSH 有原生权限预设机制，这才是你要的东西。**

插件：`@deepseek-ai/dsh-permission-presets`（profile 里 id = `permission`）

它的 schema（`listConfigs` 实测）：

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
而且是**宿主强制**的，不是纪律约定——这正是之前几轮一直缺的硬约束。

对比之前查过但没走通的 **agent preset**（`agent-presets-registry`）：
它只管"加载哪些插件"（`PresetDefinition.plugins[]`），
**管不了沙箱与审批**，且内置 preset 的声明文件在 `app.asar` 内部、未定位到。
**不用它。**

---

## 1. 当前状态

`cordis.patch.yml` 里**没有 `permission` 条目**，跑的是插件默认：

```yaml
# 插件内建默认（未在 profile 中覆盖）
presets:
  workspace-write:                                     # ← 你现在用的
    sandbox: workspace-write
    approval: ask
  danger-full-access:
    sandbox: danger-full-access
    approval: never
```

对应你 `AGENTS.md` 第 3 节的画像：本工作区可写、主仓库只读、写越界弹审批。
**这个默认没错，只是"FPGA 模式"想更严。**

---

## 2. 建议的改动（待你确认）

在 `cordis.patch.yml` 的顶部区域（建议放在 `agent-preset-registry` 之后）插入：

```yaml
# ── FPGA 权限预设：比 workspace-write 更严 ────────────────────────────────
# 目的：给 FPGA 会话一个"只读分析"档位，宿主强制，不靠自觉。
# 用法：新建会话时在权限选择器里选 fpga；或在需要纯分析时切到 fpga-readonly。
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      # 保留插件原有两档（覆盖时必须连默认一起写，否则会被替换掉）
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: workspace-write
        description: 在工作区与许可的临时目录内写入；越界重试需批准。
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: danger-full-access
        description: 全盘写入且不弹审批。
      # ↓ 新增：FPGA 只读分析档
      fpga-readonly:
        sandbox: read-only
        approval: ask
        name: FPGA 只读
        description: 宿主强制只读——适合 ANALYZE 阶段、看报告、审 RTL。任何写入都会被拦。
      # ↓ 新增：FPGA 实施档（与 workspace-write 同档，但语义明确）
      fpga-impl:
        sandbox: workspace-write
        approval: ask
        name: FPGA 实施
        description: 按 FPGA 模式施工：工作区可写，越界提权，写 MCP 工具先问后调。
    defaultPreset: workspace-write
```

### 2.1 关键设计点

1. **`read-only` 是硬闸门**：`fpga-readonly` 下**任何**写入都被宿主拦下。
   这直接落地了 [FPGA工作流纪律.md](FPGA工作流纪律.md) §8「单写者 + 只读审查者」——
   `ANALYZE` 阶段就该用它。
2. **`defaultPreset: workspace-write` 保持不变**：不改变你现在的默认行为。
3. **覆盖时必须连默认两档一起写**：schema 里 `presets` 是整体替换语义
   （`additionalProperties`），只写新档会把 `workspace-write` / `danger-full-access` 弄丢。
   **这是最容易踩的坑。**
4. **命名建议**：`fpga-readonly` 比 `fpga` 更准确——它描述的是**沙箱档位**，
   不是"FPGA 任务"本身；FPGA 施工该用 `fpga-impl`。

---

## 3. 落地步骤（需提权）

```powershell
# 1) 备份（当前被沙箱拒绝，提权后执行）
Copy-Item '%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml' `
          '%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml.bak-fpgamode'

# 2) 按 §2 插入那段 YAML

# 3) 重启 DSH（或等热加载）
```

**落地后必须验证**（不能只看配置文件就说成功）：

1. 新建会话，确认权限选择器里出现 `FPGA 只读` / `FPGA 实施`
2. **切到 `fpga-readonly`，试着写一个文件——必须被拒绝**（这是决定性验证）
3. 切回 `workspace-write`，确认行为恢复

> ⚠️ **未验证的风险**：`presets` 覆盖是否真会替换掉默认两档（§2.1 第 3 点），
> 以及 `defaultPreset` 指向的 preset 若不存在会怎样。
> 落地后请按上面第 2 步实测；若有异常，用备份回滚。

---

## 4. 与纪律文档的关系

| | 权限预设（本文件） | 纪律文档 |
| --- | --- | --- |
| 性质 | **硬约束**（宿主强制） | 软约束（约定） |
| 管什么 | 文件写入范围、审批 | MCP 工具先问后调、模式路由、失败分类 |
| 位置 | `cordis.patch.yml`（工作区外） | 本工作区 |

**两者互补，不重复**：预设拦得住"写文件"，但**拦不住 `mcp__vivado__run_tcl`**
（MCP 子进程在沙箱之外）。所以
[设备端高危MCP工具清单.md](设备端高危MCP工具清单.md) 仍然必要。

---

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-08 | 建档。确认 `dsh-permission-presets` 机制；给出 `fpga-readonly` / `fpga-impl` 方案；**未落地**（沙箱拒绝写 profile 目录）。 |
