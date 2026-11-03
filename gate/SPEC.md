# SPEC —— Gate 收口协议 v0

> 依据：`slices/gate/TASK.1.md` §3（设计口径，Lead 定）。本文件是它的**可执行化**版本：
> §3.1–§3.5 逐条对齐 TASK.1，另加 §3.6 退出码契约、§4 实施约束、**§对齐**（与同工作区既有文档）。
> 实现：`gate/gate.mjs` + `gate/lib/runner.mjs`。适配器：`gate/adapters/*.mjs`。
>
> **本文件与 TASK.1 冲突时以 TASK.1 为准**，并在本节"已知偏差"里登记。

---

## 0 一句话

`一个任务描述符 → 真跑 → 四态判定 → 可第三方复核的证据 JSON → 一行 GATE`。
**判定权在 runner，不在被验脚本**（这是与现场三代脚本最根本的区别）。

---

## 3.1 任务描述符 `gate/tasks/<taskId>.json`

最小形态（TASK.1 §3.1 原文口径）：

```jsonc
{
  "taskId": "guard-ui-r5",
  "level": "L2-F",                       // L1 | L2-S | L2-F | L3
  "claimsWhat": "F4-NEW-1：warn 与 err 通道分离",
  "acceptance": [
    { "id": "A1", "assert": "exists:guards/guard-ui/lib/client.js" },
    { "id": "A2", "cmd": "node guards/guard-ui/test/redteam.3.mjs", "exit": 0 }
  ],
  "files": ["…"], "rollback": "…", "refs": ["…"]
}
```

v0 实际接受的**完整字段**：

| 字段 | 必填 | 语义 |
|---|---|---|
| `taskId` | ✅ | `[A-Za-z0-9._-]+`，用于证据文件命名 |
| `acceptance[]` | ✅ | 断言数组，见下（**与 `notRun[]` 至少要有其一**，两者皆空 = 空壳，拒收） |
| `notRun[]` | | **跑不了的域**的声明（R2）：每条 `{id, what, why, precondition, category?, realCommand?, cwd?, exitSemantics?}`。`category` 区分 **`capability`（跑不了）** 与 **`authorization`（跑得动但本轮授权不做）** —— 两者不许混为一谈。有 `notRun` 而 `acceptance` 为空 ⟹ `assertions=0`、`verdict=UNVERIFIED`、退出码 2、**零 PASS 断言**（§3.6） |
| `acceptance[].id` | ✅ | 断言短名（建议 `A1`/`G01` 这类稳定编号） |
| `acceptance[].assert` | 二选一 | 内联算子串。**支持四算子**：`exists:<路径>` / `not_exists:<路径>` / `path_contains:<路径>::<子串>` / `stdout_contains:<子串>` |
| `acceptance[].cmd` | 二选一 | **命令行字符串**（过 shell；现场命令含引号/管道/重定向，不过 shell 跑不动） |
| `acceptance[].args` | | 参数数组，按引用规则拼到 `cmd` 后 |
| `acceptance[].shell` | | 默认 `true`。`false` = `spawnSync(cmd, args, {shell:false})`（参数不过 shell，用于"命令确实不存在"这类判据） |
| `acceptance[].cwd` | | 默认 `.`（= 工作区根） |
| `acceptance[].exit` | | **声明**退出码（整数）。**仅作为"声明"，与实测比对**，绝不作为结果 |
| `acceptance[].envFailCodes` | | 工具/环境失败约定码（如 `[9009]`）。命中 ⟹ `UNVERIFIED`（TOOL_ENV_FAIL），不当通过也不当判据失败 |
| `acceptance[].env` | | 该条追加的环境变量 |
| `acceptance[].timeoutMs` | | 默认 600000 |
| `acceptance[].what` | | 人读的"它证明什么"（进证据，便于第三方复核） |
| `level` | | `L1`/`L2-S`/`L2-F`/`L3`，非法直接拒收 |
| `claimsWhat` | | 这份证据在主张什么 |
| `noWrite[]` | | **路径前缀**清单：跑完必须未被改写的路径（内容/mtime 都比）。**解析不到会被判 `UNRESOLVED` 而不是"干净"** |
| `evidenceMaxChars` | | 输出摘要上限，默认 20000 |
| `hashFiles[]` | | **收口时要重算的文件**（R3a）：这份证据"钉住"的判据机器/输入（如 docs 域的检查器、例外表）。跑任务时被哈希，`close.mjs` 逐条重算；不符即**拒绝收口** |
| `files` / `rollback` / `refs` | | 交付元数据；`files` **不被隐式哈希**（见 §3.3） |
| `_provenance` | | 由哪个适配器映射生成、基线怎么测的、有哪些 NOT RUN 与已知副作用 |

**两条硬规则**（由 `validateTask` 机械执行，违规 ⟹ 退出码 3、**不产出任何 PASS**）：

1. 每条断言必须**能机械求值**：要么有 `assert`，要么同时有 `cmd` + 整数 `exit`。
   既没有 assert 也没有 exit ⟹ 拒收（"未声明"不许伪装成"通过"）。
   > 注：runner **层**仍有"跑了但未声明 exit ⟹ `UNVERIFIED`"这条分支（自测 §3 有专门证明），
   > 但**描述符层**直接拒收这种条目 —— 描述符是可以改的，能写清楚就不该留模糊。
2. 未知算子 / 非法 `level` / 非法 `exit` 类型 ⟹ 拒收。

### 路径基准（`resolveTarget`，确定性规则）

1. 绝对路径 → 原样；
2. 相对**描述符所在目录**能解析到 → 用描述符目录（便于描述符自带夹具）；
3. 否则 → 用 `--root`（默认 = 当前工作目录 = 工作区根）。

判据：**解析结果与所用基准都写进证据**（`files[].base`），事后可复算。不许"猜着解析"。

---

## 3.2 四态（**语义互斥，不许合并**）

| 态 | 判据 |
|---|---|
| `PASS` | 声明 = 实测 **且** 真实 exit = 0 |
| `HONEST_FAIL` | 声明 = 实测 **但** 真实 exit ≠ 0（诚实声明失败，**同样不得宣告完成**） |
| `MISMATCH` | 声明 ≠ 实测（**打回**） |
| `UNVERIFIED` | 没跑 / 跑不了 / 未声明 |

实现（`decideExitState`）逐条展开，**互斥性由"判定顺序 + 早返回"保证**：

1. `real.error` 或 `status === null`（且非信号）⟹ `UNVERIFIED`，理由含 `error.code`（如 `ENOENT`）；
2. 被信号打断 ⟹ `UNVERIFIED`（未跑完，不计为判据结果）；
3. 真实退出码命中 `envFailCodes` ⟹ `UNVERIFIED` + **TOOL_ENV_FAIL**（工具/环境失败不是判据失败）；
4. 未声明 `exit` ⟹ `UNVERIFIED`（无判据可比）；
5. 声明 ≠ 实测 ⟹ `MISMATCH`；
6. 声明 = 实测 = 0 ⟹ `PASS`；
7. 声明 = 实测 ≠ 0 ⟹ `HONEST_FAIL`。

**文件级断言**（`exists:` / `not_exists:` / `path_contains:`）：**不产生退出码**，`real.exit` 记 `null`，
只进 `evaluated[]`，其 oracle 为 `path` / `path_string`。**不伪造 exit**（Lead 2026-10-16 明令）。

### 任务级裁定（`verdictOf`）

`PASS` 当且仅当**全部断言** PASS；否则按 `UNVERIFIED` → `MISMATCH` → `HONEST_FAIL` 的**报告顺序**
给出任务级 verdict（`UNVERIFIED` 排最前，因为"没拿到结论"比"结论是红的"更该先被看见）。

**门级 `gateOk`** = 任务级 PASS **且** 无 `noWrite` 违规 **且** 无 `noWrite` 未解析。

---

## 3.3 证据落盘

`gate/evidence/gate-<taskId>-<UTC时间戳>.json`（时间戳形如 `2026-10-16T02-58-20Z`），
外加一行追加索引 `gate/evidence/GATES.log`。

顶层结构：

```jsonc
{
  "schema": "gate-evidence/v0",
  "taskId": "…", "taskPath": "…", "level": "…", "claimsWhat": "…",
  "startedAt": "…", "finishedAt": "…", "durationMs": 1234,
  "environment": { "platform":"win32", "node":"v24.21.0", "root":"…",
                   "runtimes": { "python": {"path":"…","source":"bundled"}, "node": {"path":"…"} },
                   "note": "spawnSync 管道 EPERM ⟹ fd 重定向；TEMP/TMP 钉进工作区并收尾清理" },
  "taskState": { "gateOk": true, "verdict": "PASS", "counts": {"PASS":12,…} },
  "noWriteDeclared": ["…"], "noWriteResults": [
    { "path":"…", "resolved":"…", "base":"root", "files":32, "changed":false,
      "verdict":"CLEAN|VIOLATED|UNRESOLVED", "note": null }
  ],
  "evaluated": [ /* 每条断言 */ ],
  "failed": [ /* evaluated 的非 PASS 子集 */ ]
}
```

每条 `evaluated[]`：

| 字段 | 内容 |
|---|---|
| `declaration` | `assert` / `cmd` / `args` / `cwd` / `exit` / `envFailCodes` / `env`（**声明**，原样留痕） |
| `real.exit` | **真实退出码**（runner 自己测的；未跑为 `null`） |
| `real.ms` / `real.cwd` / `real.line` / `real.capture` | 耗时 / 实际工作目录 / 实际命令行 / 捕获方式（`fd` 或 `inherit`） |
| `real.harness` | `exited` / `spawn_error` / `signal` / `no_status` —— **把"工具/环境失败"从"判据未过"里分开记** |
| `real.stdout` / `real.stderr` | 摘要（**截断保留首+尾**，`truncated` / `fullLength` / `kept` 如实标注） |
| `oracle` | 判据来源：`exit_code` / `stdout_contains` / `exit_code + stdout_contains` / `path` / `path_string` |
| `files[]` | 被验文件哈希：`path` / `abs` / `base` / `sha256`(16) / `exists` / `changedByCommand` |
| `state` / `basis` / `notes[]` | 判定 / **判定依据（人读）** / 提示（含只读性启发式提示） |
| `pins` | **收口用**（R3a，§3.9）：`descriptor` / `machinery` / `declared` 三类文件的全 64 位哈希与存在性；`close.mjs` 逐条重算，不符即拒 |

**"被验文件"的定义（对 TASK.1 §3.3 的显式化）**：只哈希**断言里按路径点名的目标**
（`exists:` / `not_exists:` / `path_contains:` 的路径部分）。裸 `files[]` 元数据**不**隐式哈希 ——
因为 `files[]` 常常包含测试**自己会改写**的产物，隐式哈希会制造"文件被改了"的假警报。
（与 A5 的"零写入"是两件事：那由 `noWrite[]` 负责。）

### 一行 `GATE`

```
GATE <taskId> PASS assertions=12 PASS=12 HONEST_FAIL=0 MISMATCH=0 UNVERIFIED=0 ran=12 noWrite=clean:4
GATE <taskId> gateOk=false(assertions=MISMATCH) assertions=1 PASS=0 HONEST_FAIL=0 MISMATCH=1 UNVERIFIED=0 ran=1 noWrite=clean:1
```

字段：`gateOk` 结果 · 断言数 · 四态计数 · `ran=`（真实取得退出码的条数）· `noWrite=`（`clean:N` / `VIOLATED:<路径>` / `UNRESOLVED:<路径>` / `(none-declared)`）。

> ★ 两个已修的实现坑（写在这里防止复发）：
> ① `gateOk` 挂在 `ev.taskState` 上，早先写成 `ev.gateOk` ⟹ 恒 `undefined` ⟹ **GATE 行永远印"门没过"**，
> 连全绿的运行也一样。**一行汇总串如果恒报同一个值，它就不再是证据，是装饰。**
> ② 输出摘要最初截 4000 字符且**只留首部**，被截掉的**正好是末尾那行终判串** ⟹ 三条断言误判 `HONEST_FAIL`。
> 现在**首+尾**都留。

---

## 3.4 适配器契约

`gate/adapters/<domain>.mjs` **只做**「任务 → 断言数组」的映射：

```js
export function toAssertions(ctx) { return { acceptance: [...], notRun: [...], knownSideEffects: [...] }; }
export function describe() { return { domain, tasks, assertions, notRun }; }
```

- **执行 / 判定 / 落盘一律由 `gate/lib/runner.mjs` 负责。**
- 适配器**不得**自己判 `PASS`，不得读被验脚本的输出后"替它下结论"。
- 适配器**可以**声明 `notRun[]`（明确不做 + 理由）与 `knownSideEffects[]`（如实登记，不假装零写入）。
- 适配器与描述符**双写**时以**描述符为准**，差异必须在 HANDOFF 里说明（本 slice：描述符是适配器输出的钉版）。

现有适配器：`gate/adapters/guards-suite.mjs`（本工程现役 `guards/*/test/*.mjs` 12 个）。

---

## 3.5 硬约束（逐条 + 实现位置）

| # | 约束 | 实现 |
|---|---|---|
| 1 | **真跑取真实退出码**；绝不接受自述的 exit；`MISMATCH` 必须能抓到 | `runStep` 用 `spawnSync` 返回值；`decideExitState` 比对声明。**CLI 负例** `gate/tasks/_selftest-mismatch-cli.json` 实测 exit 1 |
| 2 | `assert` 算子**内联求值、不过 shell** | `evalAssert` 纯字符串/路径运算，不经 shell |
| 3 | `UNVERIFIED` 必须**显式**出现，不得静默当通过 | 四态计数进 GATE 行；`UNVERIFIED` 在任务级 verdict 里**排最前**；未声明 exit 的 `cmd` 在 runner 层判 `UNVERIFIED` |
| 4 | 默认**只读、幂等**；改状态类命令不得进 `acceptance` | `noWrite[]` 跑前/跑后内容快照比对；`readOnlyNote` 对含写动词的命令行给启发式提示 |
| 5 | 失败时输出「合格判据长什么样」的要求块（形态 + 两条自检） | `requirementBlock`（`gate/gate.mjs`）：逐条列"声称要证明 / 现在能证明 / 缺什么"，+ 三条形态要求 + 两条自检 |

---

## 3.6 退出码契约（对 TASK.1 的补充：调用方要能机械分流）

| 码 | 含义 | 触发 |
|---|---|---|
| `0` | 门通过 | `gateOk = true` |
| `1` | **工具对自己撒谎** / 自测失败 | 存在 `MISMATCH`；或 `--self-test` 缺态、负例不成立 |
| `2` | 判据未过 | `HONEST_FAIL` / `UNVERIFIED` / `noWrite` 违规或未解析 |
| `3` | **无法裁决** | 描述符缺失 / JSON 非法 / `validateTask` 拒收 / `--root` 不存在 |

> 为什么把 `MISMATCH` 单列成 1 而不是并进 2：两者的**处置完全不同**。
> `2` 是"活没干成"，`1` 是"**你在说谎**"，必须先查描述符与自述从哪来的。
> 现场先例（INVENTORY §0）：`python foo.py` 在本机是坏别名、`$LASTEXITCODE=9009`，
> 而很多脚本**只在跑起来之后**才打印结果 ⟹ 不区分这两类就会把"根本没跑"读成"结果正常"。

### 零断言的域（R2 新增形态）

一个域**跑不了**时，描述符给 `acceptance: []` + `notRun[]`。此时：

- `evaluated` 为空 ⟹ `assertions=0`、`ran=0`；
- 任务级 `verdict = UNVERIFIED`（**不是** PASS、也不是"无事可做所以过"）；
- `gateOk = false` ⟹ **退出码 2**；
- **零 PASS 断言**（`PASS=0`）；`notRun` 条目只出现在证据 JSON 的 `notRun[]` 里，
  **不许**被塞进 `acceptance` 去换一个 `exit 0`（`TASK.2.md` §1 明令）。

---

## 3.7 HANDOFF 契约（R2 接线；模板见 `gate/templates/HANDOFF-GATE.md`）

### GATE 行由哪些字段生成

`GATE` 行**完全**由证据 JSON 的字段算出（不许手改数字）：

| GATE 行片段 | 来源字段 |
|---|---|
| `<taskId>` | `taskId` |
| `PASS` / `gateOk=false(assertions=<verdict>)` | `taskState.gateOk`；为假时附 `taskState.verdict` |
| `assertions=N` | `evaluated.length` |
| `PASS=` / `HONEST_FAIL=` / `MISMATCH=` / `UNVERIFIED=` | `taskState.counts.*`（**断言级**计数） |
| `ran=N` | `evaluated` 中 `real.exit !== null` 的条数 |
| `noWrite=` | `noWriteResults`：全 CLEAN ⇒ `clean:N`；有 VIOLATED/UNRESOLVED ⇒ 列路径；声明为空 ⇒ `(none-declared)` |

`evidence:` 行 = 证据 JSON 的**路径**（`gate/evidence/gate-<taskId>-<UTC>.json`）。
`NOT RUN:` 行逐条来自 `notRun[]`（`id` / `what` / `why` / `precondition`）。

### 缺证据时必须写什么（**不许留空**）

| 情况 | 必须写 |
|---|---|
| 该轮有证据 JSON | `GATE` 行**逐字**抄 + `evidence:` 路径行 |
| 该轮**没有**证据 JSON | 一行 `GATE <taskId> UNVERIFIED（无证据：<原因>）` |
| 有跑不了的检查 | 进 `NOT RUN:`，逐条 `what + why + 前置条件` |
| `noWrite` 非 clean | 原样抄 `VIOLATED:` / `UNRESOLVED:` 与路径 |

**三条不许**（每一条都对应一次实测代价）：

1. **不许留空** —— 空白会被读成"没问题"，而"没验"与"验过"是两件事（§3.2）。
2. **不许只写叙述**（"测试通过"/"已修复"）—— 必须给可复核的指针（`GATE` 行 + 证据路径）。
3. **不许把跑不了的域降级成 `exit 0`** —— 那正是 `.cache/dsh-guard/link_gate.py` 的病
   （`missing=2` 仍 `exit=0`，见 §对齐 3）。

### 为什么把契约写进 SPEC 而不是只放在模板里

模板管"长什么样"，契约管"**缺的时候写什么**"。只给模板 ⟹ 缺证据的人会**省略整段**，
而省略在阅读端无法与"全部通过"区分。**"缺证据"必须有一个显式的写法**，否则它就是静默通过。

---

## 3.8 适配器是描述符的**唯一事实来源**（R2）

- `gate/adapters/<domain>.mjs` 导出 `buildTask()`；`gate/tasks/<taskId>.json` 由它**生成**。
- 生成/核对：`node gate/scripts/gen-tasks.mjs --write | --check`。
  `--check` 逐字段比对（与 key 顺序无关），有漂移 ⟹ **exit 1**。
- **适配器必须能被真实 `import`。** R1 的 `guards-suite.mjs` 从未被任何代码 import 过
  （只被"读码确认"），R2 一接入 `gen-tasks.mjs` 立刻暴露出块注释里星号紧跟斜杠导致
  **注释提前闭合**、运行时 `ReferenceError`。教训：**能被 import 才算适配器**；
  "读起来像映射器"不是判据。
- 描述符里的 `<MAINREPO>` / `<VIVADO>` 是**占位符**，用来避免把机器绝对路径钉进冻结件
  （换机器/换 checkout 仍可复现）。

---

## 3.9 收口契约（R3a）：**收口 = `gate/close.mjs` 通过**

### 定义

**一轮任务的"收口"= `node gate/close.mjs --task <id> --evidence <证据.json> [--draft <收口块>]` 通过（退出码 0）。**
通过后它产出**收口块**（可直接贴进 HANDOFF，见 §3.7 与 `gate/templates/HANDOFF-GATE.md`），
并在块里给出 `evidence:` 路径与一行 `CLOSE:` 收据（含证据哈希）。

### 三条拒绝路径（各有**独立退出码**，便于 canary 断言"确切码"）

| # | 拒绝条件 | 退出码 | 说明 |
|---|---|---|---|
| 1 | **没有 PASS 证据** | **2** | 证据文件不存在 / `gateOk≠true` / `PASS=0` / 零断言 / 证据的 `taskId` 与 `--task` 不符 |
| 2 | **证据与当前文件哈希漂移** | **4** | 逐条重算证据"钉住"的文件；不符即拒。**含"pin 无法重算"⟹ fail-closed**（当作漂移） |
| 3 | **收口行未按规矩写明** | **5** | 有 `notRun[]` 却没给收口行 / 收口行漏点 notRun id / 收口行里的 `GATE` 行与证据**不一致**（数字不许手改）。**`--draft` 是条件必填**：`notRun[]` 非空时必需，缺失即落到本码 |

另有 **3 = 无法裁决**（用法错误、证据不是合法 `gate-evidence/v0`、`--root` 不存在）；
另有 **6 = 证据残缺**（R4.1 新增）：缺必需字段 / 字段类型不对 / `main()` 兜底捕获的未预期异常。
检查**有先后**（①→②→③），所以多条同时命中时退出码稳定、canary 才能逐条隔离；
形状校验（6）在任务号比对之后、PASS 判定之前执行。

> ★ **R4.1 补的一个洞**：喂一份**残缺**证据（例如缺 `noWriteResults` 或 `evaluated[].real.exit`）时，
> `gateRef()` 会抛 `TypeError` ⇒ 作为**未捕获异常**退出 **1** —— 而 `1` 在本契约里**未分配**
> （调用方按 `0/2/3/4/5` 分流，会把 `1` 读成"未知"）。现在：先做 `evidenceShapeErrors()` 形状校验 ⇒ **6**，
> 并在 `main()` 外再加**兜底 try/catch**，保证任何意外都不再逃逸成 1。

### 证据"钉住"了什么（`pins`）

收口时重算四类：

1. `pins.descriptor` —— **任务描述符自身**；
2. `pins.machinery` —— `gate/gate.mjs`、`gate/lib/runner.mjs`、`gate/lib/env.mjs`（**判据机器**）；
3. `pins.declared` —— 描述符 `hashFiles[]` 里显式声明的文件（适配器提供，如 docs 域的检查器与例外表）；
4. `evaluated[].files[]` —— 断言按路径点名的被验文件。

> **为什么必须自动钉住 1 与 2**：像 `docs` 域那样全靠 `stdout_contains:` 的任务，
> `evaluated[].files[]` 是**空的** —— 若不自动钉住描述符与判据机器，
> "哈希漂移"这条拒绝路径在那些域上**无哈希可查**，等于不可达。
> **代价（有意接受）**：改了判据机器或描述符 ⟹ **所有旧证据一律作废，必须重跑**。

### ★ 它的边界（**不许把它写成"拦截层"**）

`close.mjs` 是**纪律工具**，不是安全边界。三条必须照写：

1. **它不拦手写收口行。** 任何人都可以手写一段长得一样的 `GATE …` 段贴进 HANDOFF；
   `close.mjs` **没有任何机制**能阻止这件事。
2. **它不防伪造。** 证据 JSON 是普通文件、**没有签名**；想骗它的人可以自己造一份**自洽**的
   JSON（连哈希一起造），`close.mjs` 会照样通过。它**不检测**"这份证据是不是真跑出来的"。
3. **它只能让"按规矩收口"成为最省事的路。** 要拿收口块，就得先有一份能过三条检查的证据 ——
   这是**降低自述的摩擦力**，不是**阻止违规的能力**。

⟹ 真正的**拦截**（能 deny 动作、没有证据就不许收口）是 **R3b**，它有三个硬前置
（用户当场点头 + 重启 DSH + 一轮异构红队），**本轮未做**（`TASK.3.md` §0）。

### 一次真实收口长什么样

```powershell
# 1) 跑任务拿证据（stdout 里本来就有 GATE 行）
node gate/gate.mjs --task gate/tasks/docs-links-r2.json
# 2) 把 GATE 行 + evidence 行 + NOT RUN 条目写成草稿
# 3) 收口（不通过就说明"这一轮没有可收口的东西"）
node gate/close.mjs --task docs-links-r2 --evidence <证据.json> --draft <草稿> --out gate/evidence/close-docs-links-r2.md
```

端到端可复跑：`node gate/scripts/close-e2e.mjs`（在**真实任务**上走完 1→3 并自检收口块）。
三条拒绝路径的 canary：`node gate/scripts/canary-close.mjs`（11 个场景，各断言**确切退出码**）。

---

## 4 实施约束（本机/本沙箱实测，不是偏好）

| # | 约束 | 实测证据 | 对策 |
|---|---|---|---|
| I1 | Node `spawnSync` **带管道 = EPERM**（`execSync`/`execFileSync` 同） | `status=null error=EPERM`；`stdio:'inherit'` 正常 | `runStep` 用 **fd 重定向**捕获输出；fd 被拒时**回落 `inherit`**（只取退出码，不声称有输出） |
| I2 | 子进程 `os.tmpdir()` 默认指向**工作区外** | 沙箱下写 `<workspace>`（**示例**：本机即主仓库根所在目录）被拒 | 每次运行把 `TEMP`/`TMP` **钉进** `<工作区根>/.scratch/`，收尾 `cleanupScratch` 删除；残留由 `SIDE_EFFECT_SELFTREE` 段**显式探测**（R1.1） |
| I2b | **临时区的位置本身是个判据问题** | R1.1 实测：临时区曾被放在 `gate/evidence/.scratch/`，而 `.scratch` 又被 A5 检查整块跳过 ⟹ 收尾失败时**检查不出声**（`gate/.scratch/tmp/**` 留下 12 个文件而 HANDOFF 写着"不留临时文件"） | ① 临时区移出交付物目录（`<root>/.scratch/`）② A5 **拆两段**：`SIDE_EFFECT_EXTERNAL`（对外）+ `SIDE_EFFECT_SELFTREE`（自身树，专查残留）。③ 新检查**本身**做了 canary 负例：放 1 个文件 ⟹ `FAIL` exit 2，删掉 ⟹ `PASS`（有区分能力，不是恒绿） |
| I2c | **A5 的括号必须只夹住被检命令** | canary 测试期间我还改了 REPRO/frozen，于是 `--before/--after` 之间出现 3 条 `CONTENT` 变化 ⟹ `SIDE_EFFECT_EXTERNAL: FAIL`。那条 FAIL 度量的是**编辑器**，不是 gate | `--before` 与 `--after` 之间**只跑被检命令**；改了任何源文件/文档就**重新取基线** |
| I3 | PATH 上的 `python`/`python3` 是 **WindowsApps 坏别名** | `& python --version` → `[exit code: 1]`，`$LASTEXITCODE=9009` | `lib/env.mjs` **只认** env `GATE_PYTHON` 或已知捆绑路径；**不回落**裸 `python`（回落=静默降级） |
| I4 | `routes.mjs` stdout **逐次不同**（含 `mkdtemp` 路径） | 两次运行 sha 不同 | 判据只用真实退出码；输出摘要仅为信息 |
| I5 | `audit-allow.mjs` / `validate-patch.mjs` **无终判串** | 实测末行不是 PASS/OK 结论 | oracle 记 `exit_code`（弱），**不冒充**结论串证据 |

---

## 5 明确不做（NOT RUN —— 不许当成已验证）

> R1/R2 的边界。**R2 已把四域适配器做掉**（`docs` 可跑且会判红；`android`/`backend`/`fpga` 只给 `notRun`），
> 所以那条从本清单移出；下面只剩**仍未做**的。

- **NOT RUN**：**接线到 Lead 日常流程**（即"每轮 HANDOFF 都必须带 GATE 段"这件事**尚未强制**）。
  R2 只提供了契约与模板（§3.7 + `gate/templates/HANDOFF-GATE.md`），**没有**在任何流程里强制执行。
- **NOT RUN**：**强制门 / 拦截层**（没有证据 JSON 就不许宣告收口）—— `TASK.3.md`（R3），**需用户单独批**。
- **NOT RUN**：与 guard 插件集成；做 UI。
- **已知边界（R4.2 增，引用红队第 1 轮报告 `reviews/gate-guard-redteam.1.md`）** ——
  这三条**不是遗漏，是有意的边界**；引用它们是为了**不让后来者把它们当成"已解决"**：
  1. **F1：`mcp__vivado__run_tcl` / `mcp__fpga-mcp__exec_tcl` 通道保持放行**（`action=pass`，仅落 `watch` 日志）。
     **不修的理由**：这两个工具的**参数是一段 Tcl 文本**，Tcl 允许注释、变量拼接、转义与多语句，
     任何内容正则都只能"看起来拦住"而挡不住有心人 —— 而**"看起来拦住了"比"明确不拦"更危险**
     （后者会让人以为还有一道防线）。所以本门**明确不覆盖**这条通道，若需要覆盖必须换机制
     （宿主侧的 Tcl 白名单 / 沙箱 / 审批），**不是加一条正则**。
  2. **F4：`GATEGUARD_OFF` 是设计内的逃生舱**（`TASK.4 §3.4` 要求）：置位即整层关闭、一律放行。
     代价是**谁能改宿主进程环境，谁就能关掉这道门**；这是**有意接受**的，不是缺陷。
  3. **证据无签名、时间戳自报**：`gate-evidence/v0` 是普通 JSON，**没有签名 / MAC**；
     `finishedAt` / `startedAt` 与产物 mtime **都由写者自报**。所以本门**只做自洽性检查**，
     `pins` 能抓**内容**漂移，但**时间戳不在 `pins` 里** ⟹ 单独伪造时间戳不会触发漂移判定。
     R4.2 已把"**绑不上产物就不放行**"补上（无产物 / 产物不存在 ⇒ `ask`），
     但**这不等于**证据可信 —— 本门**不是安全边界**。
     > ★★ **R4.5 改准（红队第 3 轮 D3）**：**"跨任务挪用"仍未根除，而且它仍然是 `pass`**。
     > 成立的前提只有两条：**①调用点得出一个有效产物**（存在 ∧ 普通文件 ∧ 非空 ∧ 非链接）
     > **＋ ②存在一份新鲜的绿收口证据**；**证据与该产物之间没有任何身份关联**。
     > 即 **"绑不上产物" → `ask`；但"绑上了别的任务的产物" → 依然是 `pass`**。
     > R4.2 关掉的是该攻击的**原样复现**（产物 0 个 ⇒ 退化到只看证据自报时间），
     > **攻击类本身没有关闭**，只是多了"必须点名一个有效产物"的前置。
     > **不许**再表述为"只是 `pass` → `ask`"（旧表述把洞说小了）。
     > ★ **D5（红队第 3 轮，同一口径）**：判定日志 / `basis` 里那句「**已绑定产物 N 个**」**表述过强，
     > 读的时候不要当真**。它**只**证明三件事：① 参数里点名了**有效文件**（存在 ∧ 普通文件 ∧ 非空 ∧ 非链接）
     > ② 证据/收口时间**晚于**该文件 mtime ③ `pins` 未漂移。
     > 它**没有**证明"这份证据是为**这个**产物（或这个任务、这个目标器件）产生的"。
     > ⇒ **「已绑定产物」只表示"参数点名了有效产物"，不代表证据与产物之间存在身份关联**；
     > 读者**不要**把它读成"证据是为该产物出的"。
     > （该字符串位于**已冻结的插件代码**中；R4.5 只更正文档读法，**未改代码**。）
     > ★★ **2026-10-21 追注（P2 落地后重读：洞还在，但爆炸半径变小）** ——
     > 当日给 `gate-guard` 加了**产物探针**（`lib/probes.js`，数值优先 + 强制正负 fixture）与**同扩展名多候选 ⇒ `ask`**。因此现在的判据是：
     > ① 调用点必须点名**有效产物**；② 要有**新鲜绿收口证据**；③ **产物自身必须过探针**（例：位流同 run 的 `reports/direct_post_route_timing.rpt` 必须 `WNS≥0 ∧ TNS==0 ∧ failPoints==0`）；④ 同扩展名多候选一律交人。
     > **没有变的那一条**：**证据与产物之间仍然没有身份关联**（证据 JSON 里不 pin 产物 hash）⟹ "编号 ①②④ 都满足、且产物自身报告达标"的**无关任务证据 + 别人的产物**，仍然可能 `pass`。
     > ⟹ **准确表述**：本门仍是**摩擦层**，不是安全边界；P2 只是把"能烧到任意合格文件"收紧成"**能烧到合格、且自身报告达标的文件**"。
  4. **产物 mtime 在未来 / 与证据只差 1ms（R4.5 增，红队第 3 轮 D4）** ——
     新鲜度是**严格晚于**（`evidenceMs > artifactMtime`），所以时间轴上只差 1ms 就会翻面。
     **实测**（`gate/guards/gate-guard/lib/index.js#isFresh`，本机实跑）：
     | 情形 | `isFresh` |
     |---|---|
     | 证据 `now`，产物 mtime `now + 1h`（**未来**） | **`false`** |
     | 证据 `now`，产物 mtime `now + 1ms`（**未来 1ms**） | **`false`** |
     | 证据 `now`，产物 mtime `now`（同一毫秒） | **`false`** |
     | 证据 `now`，产物 mtime `now − 1ms`（过去 1ms） | `true` |
     | 证据 `now`，产物 mtime `now − 1h` | `true` |
     ⇒ **产物 mtime 落在未来不会被放行**（fail-closed）；**端到端**：把产物 `utimesSync` 到 `now+1h`
     ⇒ `classifyBurnCall` 给 **`deny`**（`basis=证据/收口时间未晚于产物 mtime`），**不是 `pass`**。
     注：这一条**不防伪造** —— mtime 与证据时间戳**都是自报的**（见上一条第 3 项）。
  5. **候选有效性的历史行为与当前行为（R4.3 增，引用 `reviews/gate-guard-redteam.2.md`）**——
     四条**红队第 2 轮点名**的边界，逐条写明**当时的坏行为**与**现在的行为**：
     - **①多候选只要有一个存在即可放行**（不存在的候选被**完全忽略**，只看存在者的 mtime）——
       **R4.2 及以前确实如此**（红队与 Lead **各自实机复现**）。
       **R4.3 起**：**任一被点名的候选不合格 ⇒ `ask`**，不许"只挑存在的那个看"。
       **理由**：门与调用者对"要烧什么"理解不一致时，正是最该交给人确认的情形。
     - **②候选只做「白名单扩展名 + `existsSync`」**，**不校验** regular file / 非空 / 拒绝链接 ——
       **R4.2 及以前确实如此**（空文件、名字带 `.bit` 的**目录** ⇒ `pass`，**Lead 实机**）。
       **R4.3 起**：`probeCandidate` 检查 **`lstatSync().isSymbolicLink()` ∧ `statSync().isFile()` ∧ `size > 0`**，
       不满足 ⇒ `ask`，并在 `reason` 写明**是哪一条不满足**。
       ⚠ **`symlink` / `junction` 分支仍是代码级结论、无实机证据**：本沙箱 `symlinkSync` 得 **`EPERM`**
       （`file` 与 `junction` 两种都试过）⇒ **标 `NOT RUN`**，只能给"实现含该守卫"的**代码级断言**。
       ⚠ **精度**：**无扩展名的目录根本不成为候选**（走"没点名产物"分支 ⇒ `ask`）——
       **不许**把这条读成"目录一律能过"。
     - **③`findArtifactCandidates` 的递归支持 ≠ 产物身份绑定**：它会深入嵌套对象/数组去找路径，
       但那只是"**能找到路径**"，**不等于**"这份证据就是为**这个**产物出的"。
       绑定语义**不存在**（见上面第 3 条），**不因递归而改善**。
     - **④类型/路径校验失败仍可能落进总体的 fail-open 边界**：本门对**任何**自身异常都 `next()` 放行
       （`TASK.4 §3.3` 的硬要求）。**具体哪些异常路径会走到那里，需要独立夹具才能确定 ⇒ 本轮标 `NOT RUN`**
       （未逐条构造异常夹具）。这是**有意的取舍**，不是遗漏。
       > ★ **R4.4 实证（Lead 复核抓出的回归）**：这一条**真的发生过** —— R4.3 的 `pass` 分支残留一个
       > 已改名的变量 `existing` ⇒ **合法路径一律 `ReferenceError`** ⇒ 被本边界吞掉 ⇒
       > 门**永远拿不到 `pass`**（日志只留 `fail-open`）。
       > **可判别的判据**：断言 `classifyBurnCall` 的 `action` ／ 日志里的 `action`，
       > **不能**只断言"`next` 被调用"（fail-open 分支**也**调 `next`）。
       > 详见 `MAINTENANCE §3.1` 第 4 条与 `slices/gate/HANDOFF.4.md §15`。
- **NOT RUN**：`.cache/dsh-guard/link_gate.py` **未纳入 acceptance**（理由见 §对齐 3）。
- **NOT RUN**：`android` / `backend` / `fpga` 三域**本轮未被验证任何东西**
  （`assertions=0`、`ran=0`、`verdict=UNVERIFIED`、退出码 2）；它们的 `notRun[]` 见各自描述符。
- **NOT RUN**：第一代 `smart_home/slices/_common/*`、第二代 `lab_2_2_11_wifi-package/**`、`fpga/**` 的 `.tcl` 未实跑（登记在 `gate/_recon/INVENTORY.md` §1/§2/§5）。
- **NOT RUN**：`docs` 域的 `#锚点` 校验与外部 `http(s)` 链接存活（见 `docs-links-r2` 的 `DN1`/`DN2`）。
- **NOT RUN**：主仓库设备侧的两个只读门禁（`check_doc_links.ps1` / `check_project_drift.ps1`）——
  **实测本沙箱可跑且 exit 0**，按 `TASK.2 §1` 范围限定本轮不纳入；它们归 `notRun[].category = authorization`，
  **不是** `capability`（跑不了）。这条区分是有意保留的：不许把"本轮不做"写成"跑不了"。

**已知残余风险（如实记录，不声称已解决）**：

- `noWrite[]` 是**路径前缀**，不是 glob；写"大面积 glob"需要显式列出。
- `noWrite` 靠**跑前/跑后快照**，两次快照之间发生的"改完又改回去"检测不到（TOCTOU 同族）。
- `stdout_contains:` 的结论串是**写者挑的**；挑得不严（例如只挑一个词）会弱化判据。本 slice 已把
  两个没有结论串的测试**明确标为弱**，没有替它们编一个。
- 只读性 `readOnlyNote` 是**启发式**（正则抓写动词），只作提示，**不作判定依据**。
- **A5 的"自身树"维度仍不完整**（R1.1）：目前只探测三个已知临时区路径（`.scratch`、`gate/.scratch`、
  `gate/evidence/.scratch`）。**在别处新造临时文件仍不会被发现**——它靠的是"临时区只有一个定义"
  这条纪律，不是机制。真正的机制化需要给写域内所有路径做基线快照，v0 不做。
- `SIDE_EFFECT_SELFTREE` 只判"有没有残留文件"，**不判残留是不是本次运行产生的**
  （R1.1 那 12 个文件来自更早的侦察探针，是**人眼追时间戳**才定性的）。

---

## 对齐 —— 与同工作区既有收口/上板口径的关系

Lead 指令（2026-10-16）：`docs/smart-home-acx720/` 里**另一条线**已经写了同族协议文档
（`03-收口裁定.md` 02:34 / `04-上板检查单.md` 02:35 / `06-上板记录模板.md` 02:35），
**两套收口协议若不显式对齐，将来必然互相冒充证据**。以下只读对齐，不改、不抄写、不重造。

### 1 一致在哪

| 口径 | 既有（03/04/06 与三代脚本） | 本 slice | 一致 |
|---|---|---|---|
| 收口要有**一行可 grep 的结论** | `PREBOARD_GATE: PASS\|FAIL`、`FOUR_LAYER_RESULT: PASS\|FAIL`、`VERIFICATION_EXIT=` | `GATE <taskId> …` | ✅ 同族 |
| **失败要占退出码，不能只打印** | `0` 通过 / `2` 判红 / `3` 拒绝运行 | `0`/`1`/`2`/`3` | ✅ 同族（本 slice 把"自述撒谎"从"判红"里拆出来单列 1） |
| **"没跑"≠"通过"** | `not-run-index.py` 的 `gaps=`、`four-layer-strings.py` 的 `zero-hit-layers`、`_edge-probe.mjs` 自述"不属于验收证据" | `UNVERIFIED` 成态 + `harness` 字段 + GATE 行显式计数 | ✅ 同族（本 slice 把它从"约定"变成**状态**） |
| **判据要能被人重算** | `board-identity.json` 记 sha256+size；`expected-drift.json` 记旧值 | 证据 JSON 记真实退出码 / 文件哈希 / 命令行 / 基准 | ✅ 同族 |
| **已知差异要显式声明，不许删掉以消音** | `four-layer-pending.json` + 理由 | 适配器 `notRun[]` / `knownSideEffects[]` / SPEC §5 残余风险 | ✅ 同族 |
| **弱判据要与强判据分开** | `four-layer-strings.py` 第二轮"只报不改"；`extra-in-06` / `frozen-only`"供人眼过" | `oracle` 字段（`exit_code` vs `exit_code + stdout_contains`），无结论串者明确记弱 | ✅ 同族 |
| **快照/视图过期要拒绝而不是猜** | `register-drift.py`：登记表比快照新 ⟹ `REFUSING`（exit 3） | `validateTask` 拒收 + `--root` 校验 ⟹ exit 3 | ✅ 同族 |

### 2 不同在哪（**逐条给理由**）

| # | 差异 | 本 slice 的做法 | 理由 |
|---|---|---|---|
| D1 | **判定权归属** | 适配器**只映射**，判定/落盘全在 runner | 三代脚本都是"脚本自己打印 PASS 自己退出"，调用方无法机械复核（INVENTORY §4 G1）。判定与执行分离后，**自述与实测才有机会被比对**（这就是 `MISMATCH` 的前提） |
| D2 | **多了一个态** | 四态：`PASS`/`HONEST_FAIL`/`MISMATCH`/`UNVERIFIED` | 既有口径只有"过/不过/没跑"。**"声明 ≠ 实测"** 在既有口径里无处安放，而它恰恰是"自述完成"最常见的形态 |
| D3 | **退出码 1 的语义** | `1` = 工具对自己撒谎（MISMATCH）或自测失败 | 现场把 `1` 用作"判据 FAIL"（`four-layer-strings.py`）与 `2` 混用。本 slice 给 `MISMATCH` 一个**独立码**，因为它的处置是"先查自述从哪来"，与"活没干成"不同 |
| D4 | **一致性/幂等建模** | `noWrite[]` 前缀 + 跑前跑后 `size+mtime+sha256` 快照；**解析不到判 `UNRESOLVED`** | 既有口径用"零写入"这种**一句话声明**，实测已经漏过 `link_gate.py` 的越界 mtime 写。把一致性变成**可测字段**，并禁止"什么都没快照到"伪装成"干净" |
| D5 | **一行里报计数** | GATE 行含四态计数 + `ran=` + `noWrite=` | 既有的一行只报总判（`PASS/FAIL`）。**总判为 PASS 但 `ran=0`** 与 `ran=12` 是两件完全不同的事，必须在一行里能看出来 |
| D6 | **输出截断保留首+尾** | `clamp` 保留首部 + 尾部 3000 字符 | 实测：只留首部会截掉**末尾的终判串**（`redteam.3.mjs` 等 stdout > 4000）⟹ 本 slice 自己先踩了一次，三条断言误红 |

### 3 `link_gate.py` 的处置（Lead 明令写进交回材料）

1. **永不判红 ⇒ 不可作验收判据，只作读数。** 实测 `ok=67 missing=2` 仍 **exit=0**（源码里 `bad` 只参与打印）。
2. **全工作区扫描 ⇒ 数字会被别人移动。** 今天 `missing` 已从 **1 → 2**；要当判据**必须钉基线**，本 slice **不钉**。
3. **副作用粒度**：产物 `link-gate-result.txt` **内容幂等**（`sha256` 前 16 位 `7B965CFFF007D21D` 三次连跑不变）、**mtime 非幂等**（每次运行都变）。**不是"改写内容"。**
4. 一条**别的线**的断链（`docs/smart-home-acx720/08-整体测试报告.md` L72）**只记录、不修、不动文件**：非本 slice 写域，未处置。

### 4 与 `06-上板记录模板.md` 的关系

`06` 的"实机记录模板"要求**日期化 + 预期/接线/版本/原始日志/实际结果**（与 `AGENTS.md` §7 同族）。
本协议**不替代**它：`gate/evidence/*.json` 是**机器可复核**的那一半（真实退出码、哈希、基准），
`06` 那种**人读记录**仍是实机验收的正本。两者关系：**证据 JSON 是记录的附件，不是它的替代品。**

---

## 变更记录

- 2026-10-16：建立。按 TASK.1 §3.1–§3.5 实现；新增 §3.6（退出码）、§4（本机实测约束 I1–I5）、
  §对齐（Lead 指令：与 `docs/smart-home-acx720/03|04|06` 只读对齐）。
- 2026-10-16：登记三个已修实现坑（GATE 行恒报 false、输出截断吃掉终判串、`exists:` 算子名带冒号），
  与 §3.5 之 5 的两条自检并列 —— 都是"判据看起来在跑但其实不判别"的实例。
- 2026-10-16（**R1.1**，Lead 复核发现）：临时区移出 `gate/evidence/` → `<工作区根>/.scratch/`（§4 I2/I2b）；
  A5 **拆两段**（对外 / 自身树），`verify-no-side-effects.mjs` 新增 `SIDE_EFFECT_SELFTREE` 残留探测；
  frozen 范围行**显式写出**两个排除项；§5 补两条 A5 自身的残余风险。
- 2026-10-16（**R2**）：新增 §3.7 HANDOFF 契约、§3.8 适配器为唯一事实来源；§3.6 补"零断言的域"形态；
  新增四域适配器（`docs` 可跑且**会判红**、`android`/`backend`/`fpga` 只给 `notRun` 且**零 PASS 断言**）；
  新增 `gate/scripts/check-doc-links.mjs`（会判红的链接判据）、`canary-docs.mjs`（5 场景负例）、
  `gen-tasks.mjs`（描述符生成/机械核对）；新增 `gate/MAINTENANCE.md` 与 `gate/templates/HANDOFF-GATE.md`；
  §5 把"多域适配器"移出未做清单，并补 `docs` 域与两个设备侧只读门禁的 NOT RUN 边界。
- 2026-10-16（**R3a**）：新增 §3.9 收口契约（`gate/close.mjs`：三条拒绝路径各有独立退出码、
  `pins` 四类自动钉住、**边界三条**——不拦手写、不防伪造、只降低摩擦力）；§3.3 补 `pins` 字段；
  §3.1 补 `hashFiles[]`。R3b（宿主拦截）**未做**，三前置见 `TASK.3.md` §0。
  本轮由 canary 抓出一个 R1 起就存在的真 bug：`evaluated[].files[].path` 记的是**整条断言串**
  （`exists:xxx`）而不是路径 —— 在 close.mjs 之前**没有任何消费者读它**，所以一直没暴露；
  教训：**没人读的字段不算被验证过**。
