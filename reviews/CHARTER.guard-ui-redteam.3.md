# CHARTER · guard-ui 异构红队第 3 轮（复核第 4 轮修复）

**红队**：只读异构 subagent（`%PAYG_PROVIDER%2/gpt-6.1-sol`）。**只读**：禁改代码/配置/profile，禁写 `.dsh-guard.json`。

**目标**：对抗性复核 `guard-ui` **第 4 轮**对第 2 轮红队 4 条必修项的修复，寻找"修了没修住 / 修出新洞 / 声明仍不实"。

**必读**：
- `reviews/guard-ui-redteam.2.md`（第 2 轮发现 F4-P2-1 / F2-P2-1 / F1-P2-2 / F1-P2-3 + 2 条残余）
- `slices/guard-ui/TASK.4.md`（第 4 轮授权书）
- `slices/guard-ui/REPRO.4.md`（改前复现）
- `slices/guard-ui/HANDOFF.4.md`（交回说明，含检查点清单）
- `guards/guard-ui/lib/{client.js,settings.js,index.js}`、`guards/guard-ui/README.md`

**必须回答**：
1. **F4-P2-1**：`notes.length>0 ⇒ warn` 是否覆盖**所有**成功文案路径（含 `reset`、含保存后刷新分支）？
   反向守卫（notes 为空仍须成功文案）是否可能把正常路径误压成 warn？有无**第三种**文案走出无条件成功？
2. **F2-P2-1**：两处 caveat 的措辞与 `settings.js` 的**实际**行为是否逐字一致？有无新的误导（例如把"响亮度"说过头）？
3. **F1-P2-2**：仅 ENOENT 退化的判定是否成立？**能否构造**一个非 ENOENT 但"应当退化"的场景，
   使合法工作区被误拒（即修得过严）？多根（`FORBIDDEN_ROOTS` 多个）时行为如何？
4. **F1-P2-3**：三处声明收窄后，**是否还有地方**保留了"全部基于 realpath"式的强声明（含注释、README、HANDOFF）？
5. **F4 的 `reset` 文案**：是否真的不含"下次生效"类承诺（含并发/错误分支）？
6. **新引入风险**：第 4 轮改动是否让正常路径更脆（例如 warn 文案导致用户以为保存失败）？

**要求**：每条给文件+行号或可复现命令；标 CONFIRMED / INFERRED / NOT RUN；按严重性排序；
结论要能**反驳** HANDOFF.4；无发现也要写清检查过的路径与 NOT RUN。
报告写 `reviews/guard-ui-redteam.3.md`；**若被只读沙箱拒绝，直接把完整内容发给 Lead 代落盘（不要重试提权）**。
给 Lead 的消息 ≤15 行，只放指针。
