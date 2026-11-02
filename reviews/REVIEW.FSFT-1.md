# 审查对账 · FSFT-1（2026-10-21）

**审查者**：一次性独立审查（`%PAYG_PROVIDER%2/gpt-6.1-sol`，独立上下文，只读）。
**授权书**：[CHARTER.FSFT-review1.md](CHARTER.FSFT-review1.md)
**对账人**：Lead（**自己的复核，不采信报告**——逐条重算/重测）

---

## 1. 四条假设的最终判词

| # | 假设 | 审查者判 | Lead 自核 | **最终** | 关键依据 |
|---|---|---|---|---|---|
| Q1 | 探针用定句字符串太脆 | CONFIRMED | CONFIRMED | **CONFIRMED** | 两份真实报告：坏=`Timing constraints are not met.`（**无 `All user specified` 前缀**）、好=`All user specified timing constraints are met.`（**小写 t**）；我实测 6 种字符串判据，**大写 `T` 与 `\b` 正则都假红** |
| Q2 | 指针化 ⟹ 廉价模型假装读过 | **UNRESOLVED** | 我原判 CONFIRMED → **接受降级** | **UNRESOLVED** | 现有证据只能证「prompt 是软约束 / 第二层未实施」（`ARCHITECTURE.md:635`、`docs/查证_只读subagent与团队.md`）；**证不出"必然偷懒"** |
| Q3 | 编排脚本查表后带 model 调 spawn | **REFUTED**（该做法） | 我判「冲突成立、解法不可行」 | **REFUTED（做法）／冲突 CONFIRMED** | `ARCHITECTURE.md:150` `spawn_teammate` **无权限参数**；`rule-router` 的 `skip-explicit-route` 保留显式档 |
| Q4 | P4 搬规则会让 ARCH 爆炸 ⟹ DDD 拆 | **UNRESOLVED**（因果） | 我判 PARTIAL | **PARTIAL** | 规模证据成立：§9 = **39 LF / 42 057 B = 50.01% 字节**；但**尚未发生 P4 搬迁**，因果未证 |

> **Lead 的一处自我更正**：Q2 我原先写 CONFIRMED，是把「prompt 只读是软约束」的**先例**当成了「廉价模型必然偷懒」的**因果**。审查者按 `REVIEWER_FORMAT` 的 `UNRESOLVED` 判得对——**同意并采纳**。

---

## 2. 审查者对我的数字提出的更正（成立）

| 项 | 我原写 | 实际（复算） | 结论 |
|---|---|---|---|
| `AGENTS.md` 行数 | 327 | **336** | 我写的是**加 §0.2 之前**的值 ⟹ **已过期**，已改 |
| `ARCHITECTURE.md` 行数 | 690 | **689 LF**（我多算了尾部空行） | 口径统一为 **LF 计数** |
| `§9` 占比 | 50.0%（我算 39 行/32 条） | **39 LF / 42 057 B / 50.01%** | 一致 |
| 常驻合计 | ≈377 行 = 6.3× | **≈386 行 = 6.4×** | 已改 |

**教训（新增一条口径）**：**基线数字写完当天又改文件 ⟹ 数字即刻过期**。凡在文档里写"实测 X 行"，要么随后复算一次，要么写"见脚本输出"而不写死数值（与 `ARCHITECTURE §7.1` 禁肯定式版本声明同族）。

---

## 3. 采纳的改动（待落地，未做）

1. **D4 探针契约**：**数值优先**（解析 `Design Timing Summary` 摘要行的 WNS/TNS/失败端点），状态句只作辅助证据；**每条探针必须绑定正负 fixture**（就用 `s8-r54` 与 `s8-r54/build2` 这两份报告），无 fixture 不许启用。
2. **D2 补充**：**红线（不变量/停止线/安全边界）不参与"降级为指针"**；只有解释性内容可指针化。⚠ 注意 Q2 仍是 `UNRESOLVED` ⟹ 这条是**设计取舍**，不是被证实的必要性。
3. **Q3 结论写进 FSFT v2**：角色→模型路由**只对一次性 agent（`subagent`/`workflow`）有效**；常驻成员只能"在目标档位上 spawn"。把原 P3 的表述改掉。
4. **Q4 顺序**：先 **§9 → append-only `CHANGELOG.md`**（一步砍掉 50% 字节），再考虑拆册；拆册必须由 ARCH 保留 SSOT 索引、`arch/*.md` 为**从属章节**，纪律正文**不进** ARCHITECTURE。

---

## 4. NOT RUN

- 未跑 Vivado / 构建 / MCP；时序形态只核了指定两份报告。
- **Q2 的判别实验（三组对照：完整注入 / 指针 / guard 阶段注入）未做** ⟹ 风险等级保持 `UNRESOLVED`。
- Q3 未实际调用 `spawn_teammate` 或 `workflow`（依据 schema + 源码静态判定）。
- P4 搬迁未执行，Q4 的因果仍属推断。
