# FULL-SUPER-FPGA-TEAM（FSFT）· 架构 v1

**定名**：2026-10-21
**状态**：**结构性改造第一步已完成（护栏搬出可写区，实测 agent 改不动）**；重启验证尚未做 → 见 §7
**一句话**：FSFT 不是"更强的闸"，而是**把"能不能动硬件"从摩擦层挪到能力层**——护栏必须住在 agent 写不到的地方，闸只负责再问一次。

---

## 1. 四层（层名即职责，不许混用）

| 层 | 名字 | 组件 | 回答的问题 | 失效后果 |
|---|---|---|---|---|
| **I** | **Identity 身份层** | `role-guard` | **谁**可以写、谁只读 | 越权写 |
| **C** | **Capability 能力层** | `role-guard`（`roleScope` / `shellScope` / `restrictMcpWriteTools`） | **能不能碰到**厂商二进制与 MCP 写工具 | 绕过（能力还在） |
| **F** | **Friction 摩擦层** | `gate-guard` | 烧板前**该不该再问一次** | 多问一次 / 少问一次 |
| **T** | **Telemetry 观测层** | `rule-router`、`effort-check`、`subagent-sandbox` | 发生了什么（模型路由 / 挡位缺口 / 子会话档位） | 只是看不见，不影响安全 |

**关键分层纪律**：`Friction` **不是**安全边界。它的价值是"让手快的动作停一下"，不是"挡住知道怎么绕的人"。把安全寄托在它身上，就是 `技法坊-12`「放行类断言在 fail-open 下假绿」的同族。

---

## 2. 住址（本次改造的核心）

| 层 | 住址 | 为什么 |
|---|---|---|
| **I / C / F** | `%USERPROFILE%\.dsh\guards\`（会话工作区**之外**） | DSH 文件沙箱拒绝写 ⟹ **被保护对象改不动闸**，不需要改 ACL |
| **T** | `%MAIN_REPO%-dsh\guards\`（工作区，可写） | 它们靠相对路径找 `../config`、`../scripts/check-efforts.mjs`；搬走会**静默失效**。且坏了不影响安全 |

⚠ **这不是"没搬干净"，是刻意的**：`rule-router` / `effort-check` 的路径是从**自身文件位置**上溯三级推出来的。搬进 `~/.dsh` 后会指向 `~/.dsh/config/rule-router.json`、`~/.dsh/scripts/check-efforts.mjs`（不存在）⟹ 加载即失败且**只写一行 error**。分层正好把这个问题变成设计而不是补丁。

---

## 3. 四条不变量（改架构前先读这一节）

1. **护栏住在 agent 写不到的地方。** 判据不是"我们小心"，而是"沙箱拒绝写"——已实测（§5）。
2. **护栏不热插拔。** 改护栏代码**必须重启**；HMR 的模块监视根设为 `root: []`，只保留 patch 级热重载。
3. **摩擦层不冒充边界。** `gate-guard` 的失败方向是"多问一次"，永不是"静默放行恶意"。
4. **证据必须绑定产物。** 没有身份关联的"绿证据"不构成放行理由（`s8-r54` 已证明：时序不满足的位流可以拿到新鲜绿证据）。

---

## 4. 当前接线（2026-10-21 01:5x 实测）

| entry id | 路径 | 状态 |
|---|---|---|
| `role-guard` | `%USERPROFILE%/.dsh/guards/role-guard/lib/index.js` | ON |
| `subagent-sandbox` | `%USERPROFILE%/.dsh/guards/subagent-sandbox/lib/index.js` | ON |
| `guard-ui` | `%USERPROFILE%/.dsh/guards/guard-ui/lib/index.js` | ON |
| `gate-guard` | `%USERPROFILE%/.dsh/guards/gate-guard/lib/index.js` | ON |
| `effort-check` | `%MAIN_REPO%-dsh/guards/effort-check/lib/index.js` | ON（观测层，留工作区） |
| `rule-router` | `%MAIN_REPO%-dsh/guards/rule-router/lib/index.js` | ON（观测层，留工作区） |

- `cordis.patch.yml` YAML 解析通过（`entries=23`）；`hmr.root = []`。
- 备份：`cordis.patch.yml.bak-guards-move-20261021`（改动前，36450 B）。

---

## 5. 验收证据（已取得）

| 项 | 证据 |
|---|---|
| **搬迁完整** | src 34 文件 / dst 34 文件；只在 src=0、只在 dst=0、**内容不同=0**（逐文件 SHA-256） |
| **受保护树只含护栏** | 目录 = `gate-guard` / `guard-ui` / `role-guard` / `subagent-sandbox`（观测两件已从该树移除） |
| **★ 结构性质成立** | 非提权 `Add-Content` 写 `~/.dsh/guards/gate-guard/lib/index.js` → **`WRITE-DENIED: UnauthorizedAccessException`**，且 `sha256` 前后不变（`534C732A24BABB39…`） |

---

## 6. 重启后的验收清单（**必须做，否则本改造只算"就位"**）

> 现状：**运行中的进程仍在用旧路径**（`rule-router` 最后 `apply` = 15:46:28、`effort-check` 最后 `startup-check` = 15:22:48，均早于本次改动）⟹ **旧副本暂时不能删**。

1. 重启 DSH。
2. 四个护栏各留一条"我活着"的信号：
   - `role-guard` → `.cache/dsh-guard/guard-events.jsonl` 出现新行
   - `subagent-sandbox` → `.cache/dsh-guard/sandbox-probe.jsonl` 出现新的 `probe-start`
   - `gate-guard` → 任意烧板类调用被 `ask`（或 `gate/evidence/gateguard-decisions.log` 新增一行）
   - `guard-ui` → 设置页「guard 档」可开（人眼）
3. 观测层仍工作：`rule-router` 写 `apply`、`effort-check` 写 `startup-check`。
4. **四条都过了**，才可删 `%MAIN_REPO%-dsh\guards\{role-guard,subagent-sandbox,guard-ui,gate-guard}`（旧副本；当前**保留**）。
5. 若任一条没出现：用 `.bak-guards-move-20261021` 覆盖 `cordis.patch.yml` + 重启，回到旧接线。

---

## 7. 未做 / 下一步（按性价比）

| 优先级 | 事项 | 说明 |
|---|---|---|
| **P1** | **能力层收口** | 现在只读角色的"能力"仍靠 `shellScope` 文本匹配（代码自认是减速带）。真正的能力边界：对非 writer 角色 `ctx.tools.restrict()` 掉 `pwsh`/`bash` 与 MCP 写工具（`role-guard.restrictMcpWriteTools` 现在还是 `false`） |
| **P2** | **闸的产物绑定** | [plan](plan_gate-guard-产物绑定与探针.md) 已写；`deny/ask` 分工、`${runDir}` 探针 |
| **P3** | **护栏自哈希** | 启动时校验自身 `lib/index.js` 与记录值一致，不一致**响亮告警**（防工作区外的意外改动） |
| **P4** | **文档同步** | `gate/SPEC.md` L390「证据与产物无身份关联」那句，P2 落地后必须改写 |

---

## 8. 本次边界（NOT RUN）

- **未重启**：新路径尚未在运行实例上验证过（§6 全清单 = NOT RUN）。
- **旧副本未删**（刻意）。
- 未做能力层收口（`restrictMcpWriteTools` 仍 `false`、`shellScope` 仍是文本减速带）。
- 未做护栏自哈希。
- 未实测"绕过闸"（本次只实测了"改不动闸"）。
