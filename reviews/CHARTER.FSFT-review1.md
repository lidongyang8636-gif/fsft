# 授权书 · FSFT 架构一次性独立审查（review-1）

**审查对象**：[docs/FSFT-架构_v2.md](../docs/FSFT-架构_v2.md) · `ARCHITECTURE.md §10`（新增）· `AGENTS.md §0.2`（新增）· 相关实现：`guards/gate-guard/lib/index.js`、`guards/rule-router/lib/index.js`
**模式**：只读。**禁止**写任何文件、禁止调 MCP、禁止跑构建、禁止烧板。
**交付**：按 `slices/_common/REVIEWER_FORMAT.md` 格式（总行数 ≈ 12 + 4×发现数），每条发现**必须带 `path:line`**，写不出引用就不许写。
**判词**：`CONFIRMED` / `REFUTED` / `UNRESOLVED` / `UNKNOWN`（**不许把 UNRESOLVED 提升为 REFUTED**）。

---

## 0. 反锚定（先证伪，再同意）

下面是**提出者（用户）与 Lead 的四个假设**。**它们都可能错**。你的首要任务是**证伪**，不是复述：

1. 探针用 `All user specified timing constraints are met` 做字符串匹配太脆，应改正则或解析 WNS/TNS 数值。
2. AGENTS.md 瘦身成指针后，廉价模型会"假装读过了"（Compliance Hallucination）⟹ 红线必须全量留在注入里，过程纪律应由 guard 在特定阶段强制注入。
3. spawn 时定档与"按角色路由模型"互斥；解法是编排脚本先查角色→模型表，再带参数调 spawn。
4. P4 把规则搬进 ARCHITECTURE.md 会让它膨胀成巨兽，之后应做 DDD 拆分（`arch/roles.md` 等）。

---

## 1. 必须回答的四个问题（逐条给判词 + 证据）

### Q1 · 时序判据的抗造性
- Vivado 2019.1 的 `report_timing_summary` **实际**输出有哪几种形态？请给出**本项目内的原文实例**（提示：`fpga_out/s8-r54/reports/` 与 `fpga_out/s8-r54/build2/reports/` 各有一份）。
- 字符串匹配会漏判/误判的**具体**情形是什么（大小写？句号？换行？"not met" 与 "met" 的包含关系）？⚠ 特别检查：`"Timing constraints are not met"` 是否**包含** `"Timing constraints are met"` 之外的陷阱。
- 若要解析 WNS/TNS：给出该报告里**摘要表的确切列序与正则**（需要能从 `reports/direct_post_route_timing.rpt` 里稳定取出 `WNS/TNS/Failing Endpoints`）。
- 结论：字符串匹配是 **CONFIRMED 脆弱 / PARTIAL / 可接受**？给出你建议的**最小可靠判据**（不要设计过度）。

### Q2 · 指针化的失效风险
- 在本仓库/本会话文档里，**有没有先例证据**表明"要求 agent 自己先去读某文档"会失败？请给 `path:line`。
- 反过来：有没有证据表明"全量注入"也会失败（长度/注意力/被忽略）？
- `AGENTS.md §0.2`（新增）在 D2 预算下只留 4 条口径，**红线是否仍全量在注入里**？请核对 `AGENTS.md` 现状并判定：哪些**必须**留在注入、哪些可以是指针。给出一份"红线清单"（≤6 条）。
- 结论：用户的第 2 条假设是 **CONFIRMED / PARTIAL / REFUTED**？

### Q3 · spawn 定档 vs 角色路由
- 请**读源码/文档**回答：`spawn_teammate` 的调用参数里**有没有** model/provider 字段？`subagent` 呢？（提示：DSH 的 agent-team 与 subagent 是两套工具；`ARCHITECTURE.md` 2026-10-15 那条记录里有一条明确结论。）
- 若 `spawn_teammate` 没有 model 参数，则"编排脚本先查表再带参调 spawn"**在 spawn_teammate 上是否可行**？给判据。
- 本项目实测过「spawn 时的模型 = 当时本会话的模型」（`AGENTS.md`/画像里有一条）。请核对该结论与 `guards/rule-router/lib/index.js` 的 `skip-explicit-route` 实现，判断：**角色路由能否覆盖 spawn 时钉死的档**？
- 结论：用户第 3 条假设是 **CONFIRMED / PARTIAL / REFUTED**？给出**在本工具链上真能落地**的替代方案。

### Q4 · ARCHITECTURE 膨胀
- 量化：`ARCHITECTURE.md` 现多少行/字节？其中 **§9 变更记录**占多少行/字节/占比？（用 node 数 `\n`，**不要用 `pwsh (Get-Content).Count`** —— 它对 LF-only 文件会少计。）
- 按 D1（"只放指针、禁止复制正文"），把 `AGENTS.md` 的细则搬进 ARCHITECTURE 会不会**违反 D1**（因为 ARCHITECTURE 是组织架构权威，不是纪律权威）？请判定搬迁的**正确落点**。
- DDD 拆分（`arch/roles.md` 等）与 D1「单一权威」是否冲突？给出**不破坏单一权威**的拆分方式（提示：权威 vs 索引可以分离）。
- 结论：用户第 4 条假设是 **CONFIRMED / PARTIAL / REFUTED**？

---

## 2. 额外要求（防"看起来对"）

- 每条结论必须能落到 `path:line`；**没有引用的判断一律标 `UNKNOWN`**。
- 凡是"我认为/通常/一般"开头的句子，改成"`<file>:<line>` 显示……"。
- 明确列出 **NOT RUN**（你没能核到的部分）。
- 若发现**提出者四个假设里有自我矛盾**，直接写出来并给证据。
