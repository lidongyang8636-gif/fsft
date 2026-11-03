# HANDOFF GATE 段（模板 —— 复制到你的 HANDOFF 里）

> 用途：把一次 gate 运行**接进 HANDOFF**，让读的人不必相信叙述，能自己去核。
> 生成源：`gate/evidence/gate-<taskId>-<UTC>.json`（字段映射见 `gate/SPEC.md` §「HANDOFF 契约」）。
> **不许手改数字**：`GATE` 行与 `evidence:` 行从 JSON 里**抄**，`NOT RUN:` 从 `notRun[]` 里**抄**。

---

## GATE

<!-- ↓↓↓ 这一段整体复制；下面尖括号里的东西从证据 JSON 里取 ↓↓↓ -->

```
GATE <taskId> <gateOk ? PASS : gateOk=false(assertions=<verdict>)> assertions=<evaluated.length> PASS=<counts.PASS> HONEST_FAIL=<counts.HONEST_FAIL> MISMATCH=<counts.MISMATCH> UNVERIFIED=<counts.UNVERIFIED> ran=<real.exit 非 null 的条数> noWrite=<clean:N | VIOLATED:路径 | UNRESOLVED:路径 | (none-declared)>
```

```
evidence: gate/evidence/gate-<taskId>-<UTC>.json
```

**NOT RUN:**

- `<notRun[].id>` `<notRun[].what>` —— `<notRun[].why>`（前置：`<notRun[].precondition>`）

<!-- ↑↑↑ 复制到此为止 ↑↑↑ -->

---

## 填写规则（缺一条就不算接线完成）

| 情况 | 必须写什么 | **不许** |
|---|---|---|
| 该轮**有**证据 JSON | `GATE` 行 **逐字**抄（四态计数、`ran=`、`noWrite=` 都要在） | 只写"测试通过"这类叙述 |
| 该轮**没有**证据 JSON | 写一行 `GATE <taskId> UNVERIFIED（无证据：<原因>）` | **留空**；或写"看起来没问题"；或省略这一段 |
| 有跑不了的检查 | 进 `NOT RUN:` 列表，逐条写 **what + why + 前置条件** | 把它算进"通过"；或用"暂未覆盖"含糊掉 |
| `noWrite=` 非 `clean` | 原样抄 `VIOLATED:` / `UNRESOLVED:` 与路径，并说明 | 只写"无副作用" |

### 三条硬口径

1. **`GATE` 行是人读的入口，不是结论本身**；结论在证据 JSON 里。指针必须指向能复核的东西。
2. **`UNVERIFIED` 是合法且必须显式出现的状态**（没跑 / 跑不了 / 未声明）。
   静默省略 = 把"没验"伪装成"验过了"（`gate/SPEC.md` §3.2 之 3）。
3. **`NOT RUN` 与"通过"是两件事**：跑不了的域只给 `notRun[]`，其 `gateOk=false`、
   退出码非零 —— **不许**为了好看把它降级成 `exit 0 就算过`（`TASK.2.md` §1）。

---

## 最小示例（真实取值，来自 `docs-links-r2`）

```
GATE docs-links-r2 PASS assertions=2 PASS=2 HONEST_FAIL=0 MISMATCH=0 UNVERIFIED=0 ran=2 noWrite=clean:1
```

```
evidence: gate/evidence/gate-docs-links-r2-<UTC>.json
```

**NOT RUN:**

- `DN1` Markdown 锚点（`#标题`）是否存在 —— 本检查剥掉 `#fragment` 后只判路径存在性；锚点校验需要 标题→锚点 规则（各方言不同），本轮不做。
- `DN2` 外部 `http(s)://` 链接存活 —— 需要网络；本 slice 禁联网。
- `DN3` 主仓库设备侧链接门禁 `check_doc_links.ps1` —— **并非跑不了**（实测只读可跑且 `exit 0`），按 `TASK.2 §1` 范围限定本轮不纳入。

## 另一个最小示例（真实取值，来自 `android-r2`：本域**零断言**）

```
GATE android-r2 gateOk=false(assertions=UNVERIFIED) assertions=0 PASS=0 HONEST_FAIL=0 MISMATCH=0 UNVERIFIED=0 ran=0 noWrite=(none-declared)
```

```
evidence: gate/evidence/gate-android-r2-<UTC>.json
```

**NOT RUN:**

- `AN1` Android 单元测试 `testDebugUnitTest` —— 主仓库对本工作区只读，Gradle 必须写 `build/**`（前置：主仓库可写 + JDK 17 + `gradlew.bat`）。
- `AN2` 模拟器/实机 UI 点击链 —— 需 SDK + 模拟器/实机 + adb（前置：设备可用 + 提权）。

> ⚠ 第二种形态**必须**被如实呈现：`assertions=0` + `ran=0` + 非零退出。
> 它读起来"什么都没验"——**因为它确实什么都没验**。这正是它该看起来的样子。
