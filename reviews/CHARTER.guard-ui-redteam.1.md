# CHARTER · guard-ui 异构红队第 1 轮

**目标**：只读对抗性复核 `guard-ui` P1 交付，重点寻找"设置已写但 guard 静默失效"与 fail-open。

**审查范围**：
- `guards/guard-ui/**`
- `guards/role-guard/lib/index.js`
- `guards/subagent-sandbox/lib/index.js`
- `guards/*/test/**`
- `slices/guard-ui/PLAN.md`
- `slices/guard-ui/EVIDENCE.1.md`
- `slices/guard-ui/HANDOFF.2.md`
- `.cache/dsh-guard/` 相关日志与回滚证据

**禁止**：修改任何代码、profile、主仓库；不要写 `.dsh-guard.json`；不要启动/停止 guard；不要为了验证而改变运行时状态。可新建审查报告文件。

**必须回答**：
1. 工作区文件读取/JSON 解析/前导 BOM/坏文件/并发删除等异常，是否可能让 guard 静默 fail-open？
2. `agent.session.header.cwd` 缺失、跨盘符、路径穿越、主仓库黑名单、workspaceId→path 映射是否有绕过？
3. `mode=off/observe/set`、`profile → workspace` 合并、reset 后回落是否可能 UI 与实际不一致？
4. V3 证据是否真的排除了 HMR 重载，V6 是否足以证明无工作区文件时语义不变？
5. HTTP 路由围栏、workspaceRegistry 信任边界、profile 默认读取、客户端 UI 的错误处理是否有高风险缺口？

**证据口径**：每个发现必须给文件+行号或可复现命令/输出；区分 CONFIRMED / INFERRED / NOT RUN；按严重性排序。重点查能在不改 `guards/**` 的情况下造成错误放行的路径。

**交付**：写 `reviews/guard-ui-redteam.1.md`，包含 Findings、证据、最小修复建议、NOT RUN；给 Lead 的 `send_message` ≤15 行，只放报告指针与结论摘要。