# guard-ui —— DSH 设置页「guard 档」（每工作区，拉取式，即时生效）

> slice: `guard-ui` ｜ 计划与裁决：`slices/guard-ui/PLAN.md`（**§9 裁决优先于上文**）
> 侦察证据：`slices/guard-ui/EVIDENCE.1.md`（R1–R6）｜ 授权书：`TASK.1.md` / `TASK.2.md`

## 这是什么

在 DSH 的 **设置 → guard 档** 里，图形化调控两个护栏插件的主开关：

| 插件 | 本页开放的旋钮 |
|---|---|
| `subagent-sandbox` | `mode`（`off`/`observe`/`set`）、`childPreset`、`writerExempt` |
| `role-guard` | `roleScope.enabled`、`roleScope.unknownPolicy`、`roleScope.serviceMissingPolicy`、`shellScope.enabled` |

其余旋钮**本页不改**（页面会显式列出它们，见下面「刻意不做」）。
设置**每工作区一份**：`<workspace>/.dsh-guard.json`；不存在则以 profile 的
`cordis.patch.yml` 该插件 config 为准。改完**即时生效**，不必重载插件或重启。

## 架构：拉取式（pull）——**不是**推送

```
<workspace>/.dsh-guard.json           ← guard-ui 是**唯一写者**
        ▲ 读（每次判定都重读，不缓存取值）
        │
role-guard/lib/index.js               ← 按 executor 的 session cwd 拉取
subagent-sandbox/lib/index.js         ← 按 agent 的 session cwd 拉取
        │
        └── 共用 lib/settings.js（单一真源：schema + 读 + 校验 + 合并 + 原子写）
```

为什么是 pull（裁决 D-A）：两个 guard 的配置在 `apply` 期就被解构成常量闭包，且**一个插件实例
服务所有工作区**。push 模型必须持 `Map<cwd, patch>`，对**从未被推送过**的 cwd（用户没开过设置页 /
DSH 重启过 / guard-ui 加载失败）只能回落 profile 默认 ⇒ **磁盘上明明有工作区文件却被无视 =
fail-open**。pull 没有这条静默窗口，也没有加载顺序依赖。

### 六条硬约束（PLAN §9.1）与实现位置

| # | 约束 | 实现 |
|---|---|---|
| P1 | 判定期按 `agent.session.header.cwd` 拉取，**绝不回落 `process.cwd()`** | `settings.js` `callerWorkspaceRoot()`；角色 guard 的宿主级调用走 P6 |
| P2 | **默认不缓存**：每次判定读+解析 | `resolvePluginConfig()` 每次都 `existsSync`+`readFileSync`+`JSON.parse`。唯一被记住的是「同一条错误只吼一次」的**日志去重**（`createProblemReporter`），它不缓存取值 |
| P3 | **逐字段合并**（白名单键） | `mergeFor()`：只动白名单路径；**无覆盖时返回 profile 原对象（同一引用）**，故「默认路径行为不变」是构造性成立的 |
| P4 | 不存在 ⇒ 静默回落；存在但坏 ⇒ **响亮** | `readWorkspaceSettings()` 返回 `absent` / `ok` / `invalid`；guard 侧经 `reportProblems` 写 warn + 事件 |
| P5 | 解析器是单一真源，三处 import 同一份 | `lib/settings.js`（本包）；两个 guard 静态 import 它 |
| P6 | `exec.agent === undefined` ⇒ profile 默认（**有意降级**） | `resolvePluginConfig()` 在无 cwd 时短路返回 `reason: 'no-agent-cwd'` |

### 优先级

```
effective（逐键）= 工作区文件里出现的键  →  否则 profile 现值  →  否则插件代码默认
```

## 数据面（主机半）

三道围栏（照 `dsh-super-ppts/lib/routes.js` 骨架，证据见 EVIDENCE.1 R2）：

1. **Host 围栏**：`Host` header 是 loopback（`localhost` / `[::1]` / `127.x.x.x`）或在
   `webRuntime.trustedHosts` 里；
2. **Origin 同源**：带 `Origin` 时必须与请求 Host / loopback / trustedHosts 一致（CSRF 纵深防御）；
3. **content-type 契约**：必须 `application/json`（跨站 `<form>` 发不出这个类型）。

信封：成功 `{ok:true,value}`；失败 `{ok:false,error:{code,message}}`；未知异常**不回传 message**
（可能含绝对路径），只进 host 日志。

| 路由（POST JSON） | 入参 | 出参要点 |
|---|---|---|
| `/guard/api/settings.get` | `{workspaceId}` | `{workspace, knobs[], source:{key}, defaults, defaultsSource, extras, workspaceFileStatus, problems[]}` |
| `/guard/api/settings.set` | `{workspaceId, patch}` | `patch = { "<plugin>": { "<点分路径>": 值 \| null } }`；`null` = 从文件里删掉该键。校验失败**整笔 400、零落盘** |
| `/guard/api/settings.reset` | `{workspaceId}` | 删除工作区文件（回落 profile） |

**不信任客户端送的路径**：只用 `ctx.get('workspaceRegistry').list()` 里存在的 `workspaceId` 反查
`{id, path}`，并显式拒绝 `%MAIN_REPO%`（主仓库只读；用 `path.relative` 判包含关系，
故 `%MAIN_REPO%-dsh` 不被误拦）。

**profile 现值**：`ctx.get('configEditor').configuration()` → 按 `entry.options.id`
（`role-guard` / `subagent-sandbox`）匹配，取 `override`（读不到则 `inherited`）。
**读不到时如实标 `defaultsSource:"builtin"`**，并在页面提示「显示的是代码默认值，未必等于 profile 现配」。
它的第二个用途：`settings.set` 写入前做**权威**组合校验（工作区 × profile），
避免「页面显示已覆盖、guard 判定期却因组合非法整份弃用」＝界面撒谎。

## 文件格式

`<workspace>/.dsh-guard.json`（嵌套，与插件 config 同形；人读/手改友好）：

```json
{
  "version": 1,
  "subagent-sandbox": { "mode": "set", "childPreset": "fpga-locked" },
  "role-guard": { "roleScope": { "enabled": true, "unknownPolicy": "guard" } }
}
```

- **原子写**：同目录 `tmp` + `rename`；
- **坏文件**：改名为 `*.corrupt-<时间戳>` 留底后重建（**只由 guard-ui 写路径做**；guard 判定期纯读，绝不写盘）；
- **删空即删段**：删掉某段最后一个键 ⇒ 该段整段移除；整份没有覆盖 ⇒ 文件本身删除（回落 profile）。
  否则会留下 `{}` 空壳，让读取方把 `source` 谎报成 `workspace`。

## 读写策略（刻意不对称，两边都「绝不静默」）

| 边界 | 策略 |
|---|---|
| **写**（`settings.set`） | **严格拒绝**：未知键 / 类型不符 / 枚举外取值 / 非法组合 ⇒ 整笔 400，一个字节都不写（裁决 D-B：schema 对未知取值**响亮拒绝**） |
| **读**（guard 判定期 / 页面显示） | **宽容但响亮**：整份解析不了 ⇒ 整份弃用 + 响亮；单个键非法 ⇒ 丢该键、其余照常 + 响亮 |

读边界的宽容是有意的：一个笔误不应该让 `mode=set` 整体失效——那正是本项目最忌的「设了不生效」。
**点分当键名**（`"roleScope.enabled": false` 而不是嵌套）会被判为「没被消费的叶键」并响亮报告，
**不会静默忽略**。

### 组合不变式（跨字段）

`role-guard` 在**加载期**就用 `shellScope.enabled && !roleScope.enabled ⇒ throw` 拒绝加载
（shell 扫描需要角色归因才能判「谁是只读」）。工作区覆盖**必须保持同一不变式**：
合并后组合非法 ⇒ **整份工作区覆盖弃用** + 响亮记录（fail-safe，绝不带着非法组合跑）。

## 枚举为什么这么窄（两个「无效旋钮」教训）

| 旋钮 | 合法值 | 为什么没有第三个值 |
|---|---|---|
| `subagent-sandbox.mode` | `off` / `observe` / `set` | PLAN 原写的 `enforce` **不存在**；传进去会被 `normalizeConfig` **静默降级为 `observe`**（UI 显示已开启、实际完全不落档） |
| `roleScope.unknownPolicy` / `serviceMissingPolicy` | `pass` / `guard` | 代码只特判 `'pass'`，其余值一律等同 `guard` ⇒ PLAN §4 画的 `deny` 是**无效旋钮**，已从白名单剔除 |

## 刻意不做（第一版）

`writerNamePatterns`、`exemptNamePatterns`、`childPresetRules`、
`shellScope.toolNames/denyPatterns/denyGroups/allowPatterns`、`eventLog`、`probeDeny`、
`probeReadOnlyNames`、`restrictMcpWriteTools`、`agentScope.*`、`onlyChildren`、`strictPreset`。
⇒ 页面用 `extras` 字段**显式列出**这些键，并声明「仍由 profile 决定」，避免误以为全能改。

## 安装（需要 Lead 提权，writer 禁止写 profile）

`guard-ui/lib/index.js` 存在后，在
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 加：

```yaml
- insert:
    - id: guard-ui
      name: '%MAIN_REPO%-dsh/guards/guard-ui/lib/index.js'
```

⚠ 必须包在**顶层 `- insert:`** 里（顶层裸 `- id:` 只覆盖已有条目——profile 里记着
「首挂被静默忽略 ⇒ RT-02 假 FAIL」的教训）；路径用正斜杠。

## 回滚

1. `settings.reset`（或手工删 `<workspace>/.dsh-guard.json`）⇒ 立刻回到 profile 默认；
2. 撤销两个 guard 的改动：`.cache/dsh-guard/backup/guard-slice-pre-20261015-202330`
   （`role-guard\lib\index.js` = `A9A00A2E5A664E93`，`subagent-sandbox\lib\index.js` = `75C7E45DC31FF14C`）；
3. 去掉 profile 里的 `- insert:` 块 ⇒ 设置页入口消失（两个 guard 不受影响）。

## 自测

```powershell
node guards/guard-ui/test/loadable.mjs                        # 静态可加载性（D-D 前置）
node guards/guard-ui/test/settings.mjs                        # 单一真源：schema/P1–P6/读写策略
node guards/guard-ui/test/routes.mjs                          # 主机半：V2/V4/V5 + 围栏 + 黑名单
node guards/guard-ui/test/client-smoke.mjs                    # 客户端半：自注册形态 + 注册契约 + 降级
node guards/guard-ui/test/redteam.3.mjs                       # 红队 F1–F4 修复验证（含 junction 用例）
node guards/role-guard/test/stub-apply.mjs                    # 回归（既有）
node guards/role-guard/test/workspace-override.mjs            # 拉取式 + V6 逐项一致
node guards/subagent-sandbox/test/stub-apply.mjs              # 回归（既有）
node guards/subagent-sandbox/test/workspace-override.mjs      # 拉取式 + V6 逐项一致
```

## 残余风险（2026-10-15 第 3–4 轮，修红队 F1–F4 / F? -P2-? 之后）—— **未根除，如实记录**

> 纪律：**不许把「已缓解」说成「已解决」**。每条都写清「做到了什么 / 还差什么」。

### R-1 并发写：**非强 CAS**，且跨进程仍无锁（红队 F3 / F3-P2-1 / F3-P2-2）

- **已做**：① 写入后**回读校验**（`verified`；不一致 ⇒ 响亮失败，并如实说「可能已落盘」）；
  ② 客户端把「读取时看到的文件令牌」（`fileToken = {exists, mtimeMs, size}`）随
  `settings.set` / `settings.reset` 回传，宿主**动手前**比对，不一致即 **409 conflict** 并拒绝。
- **⚠ 这不是强 CAS（如实记录）**：
  - 令牌只有 `{exists, mtimeMs, size}` ⇒ **可碰撞**（同尺寸、同 mtime 的替换躲得过），
    且它就是一个**普通可构造对象、无签名** ⇒ **客户端可以伪造**；
  - **不传 `expect` 即跳过 CAS**（`payload?.expect ?? undefined` 语义）⇒ CAS 是**机会性**的，
    不是强制的。Lead 已实测：**伪造令牌与不带 `expect` 都能写入成功**（见 `PLAN.md` §12.3.2–3）。
  - CAS 之后到 quarantine / rename / unlink 之间**仍有竞态**。
- **还差什么**：`stat 比对 → rename/unlink` 之间**仍无锁**；根治需要**跨进程文件锁**（lockfile + 重试）
  或把写入串行化到单一写者进程 —— **本版都没做**。
- **触发前提**：本项目口径是「同一 checkout 只有一个 writer」，故需要**同一工作区两个并发会话**。
  第 3 轮压力实测：12 轮 × 300 次真实并发写**未观测到**丢失（窗口极小）；
  但用同构序列 + 放大窗口**确定性复现**了机理（`slices/guard-ui/REPRO.3.md` §3a）
  ⇒ **缺口真实存在，只是难以偶发。**

### R-2 路径别名：**祖先链替换的 TOCTOU 无法在纯路径 API 下根除**

- **已做**：黑名单判定与**写/删落点**都基于 `realpathSync.native`（穿透 junction/symlink），
  解析失败 **fail-closed（判禁）**；不存在的叶子走「最近已存在祖先」。
- **⚠ 精确声明（第 2 轮红队 F1-P2-3 后收窄，不再声称「读的每个 syscall 都 native」）**：
  - **写 / 删**：判定与落点**全部**基于 realpath ✔
  - **读**：有一条**例外** —— `readWorkspaceSettings` 在「文件是否存在」这一步用**字面**路径
    `existsSync`（常态无文件 ⇒ 零句柄开销）。若 `cwd` 本身是指向禁用根的别名，
    这一步会**探测**一次禁用根里是否存在 `.dsh-guard.json`（**不读内容、不写**），
    随后 realpath + 黑名单会把它判为 `invalid` 并拒绝使用。
- **⚠ 无法根除的部分（红队原话「不是缓解」）**：路径在**判定时**解析、操作在**之后**发生，
  在两次 syscall 之间把**某个祖先目录**换成 reparse point（祖先链替换），操作仍可能落到别处。
  纯路径 API（`realpath` + `rename/unlink`）**根不除**；要根除必须**先打开句柄、再按句柄操作**
  （`FILE_FLAG_OPEN_REPARSE_POINT` 语义）——**本版没做**。
  ⚠ 且 **guard-ui 跑在宿主进程内、没有第二层文件沙箱兜底**，所以这条残余就是**最终状态**，
  不是「以后补个沙箱就行」。
- **真实 exploit 未能复现（`NOT RUN`）**：本机沙箱不允许把 reparse point 指向可写根之外
  （`mklink /J <tmp> %MAIN_REPO%` → `Access is denied`，原样报错见 `REPRO.3.md` §1 ③）。
  修复正确性由**替身禁用根**的 junction 用例证明（`test/redteam.3.mjs`）。
- **⚠ 维护者注意**：`fs.realpathSync`（**非** `.native`）在 Windows 上**不解析 junction**
  （实测返回别名本身）。任何人把它改回 `realpathSync`，**F1 立刻复辟**。

### R-3 `agent.session.header.cwd` 缺失：已响亮，但**无法强制**

- **已做**：拆开 `host-level-call`（无 agent，P6 有意降级，静默）与 `agent-cwd-missing`
  （有 agent 却无 cwd，**响亮**：warn + 事件 + 进 `problems`）；`settings.get` 返回
  `cwdGuarantee.caveat`，页面**常显**「仅对带 session cwd 的调用者生效」。
  （第 2 轮红队 F2-P2-1 后，该 caveat 已把**两类回落的行为差异**写清：无 agent 的宿主级调用是
  **设计内静默**；有 agent 缺 cwd 才是**响亮**的 `agent-cwd-missing`。）
- **还差什么**：`SessionHeader.cwd` 是**宿主侧可选字段**，既不能补齐也不能据此拒绝判定
  ⇒ 对这类调用者工作区覆盖**本就不生效**（回落 profile）。这是**如实告知**，不是修复。

### R-4 `configEditor` 不可用时的组合校验：只能尽力

- **已做**：读不到 profile 现值时**传 `null`**（不再用 `{}` 冒充），逐插件标
  `file-internal-only`，并让客户端**必须**消费 `notes` / `combinationCheckedWithProfile`
  ⇒ 不再显示「已保存、下次生效」，而是明说「guard 可能整份弃用」。
- **还差什么**：这种情形下跨文件组合不变式**确实没有**被权威校验，只能等 guard 判定期；
  UI 现在**如实说了**，但用户仍可能写出一个会被弃用的覆盖。

### R-5 `err` 通道的前缀文案偏窄（**已记录，本轮刻意未改**）

- 第 3 轮红队 F4-NEW-1 之后，三条通道互斥：只有 `err` 配 `loadFailed` 前缀，
  而该前缀文案是 **「读取设置失败：」**。但 `err` 现在也承载**写入失败 / 删除失败 / 409 冲突**，
  于是一次保存失败会显示成「读取设置失败：…」—— 语义偏窄（不再是"读"的问题）。
- **本轮不改文案**：`TASK.5.md` §0.2 明确要求 `err` 继续配 `loadFailed` 前缀，
  而本轮验收判据正是「真失败 ⇒ **含** loadFailed 前缀」；擅自改文案会让该判据失去参照。
- **建议**（留给后续一轮，需 Lead 裁决）：改为操作中性文案（如「操作失败：」），
  或按来源拆成 `loadFailed`（读）与 `opFailed`（写/删）。
  ⚠ 无论怎么改，**判据必须继续落在渲染层**（见 `test/redteam.3.mjs` 的 F4-NEW-1 段）。

### R-6 三条通道的 `warn` 语义比授权书的枚举略宽（**已记录**）

- `TASK.5.md` §0.2 把 `warn` 定义为「**已写入**但有保留」。实现里 `warn` 还承载一种**没有写入**的情形：
  点保存但**没有任何改动**（`t("noChanges")`）——它既不是失败（不该配 `loadFailed` 前缀），
  也不是"成功且无保留"。第 4 轮它曾落在 `err`（⇒ 被渲染成「读取设置失败」，明显错误），
  本轮改到 `warn`。
- 该文案自身是准确的（「没有改动。」），且**不带**任何前缀 ⇒ 不会误导；但为免语义漂移，
  此处如实登记：`warn` = 「**未**达成『成功且无保留』」。

## 已知边界（诚实清单）

- **HMR**：profile 已把 HMR 监视根指向本仓库 `guards/`，所以「改了 `guards/**` 后行为变了」
  可能来自插件重新 apply，而非「即时生效」。故验证「即时生效」必须**只改 `.dsh-guard.json`**，
  并用 `probe-start` / `plugin-start` 计数**不增**来排除重载（见 HANDOFF.2.md）。
- **客户端半的真渲染**未在离线自测里验证（`test/client-smoke.mjs` 用 fake React 驱动渲染路径），
  需要 Lead 落 profile 条目后在真页面确认。
- **`webRuntime` 不在 host Service 目录里**：`trustedHosts` 取不到时为空数组，
  而空数组下 loopback 仍放行，故围栏不依赖这个未入册的服务。
- **`configEditor` 的条目枚举口径**：其 `entries()` 只列 `include` 树下的条目。
  若两个 guard 的 `- insert:` 条目不在其中，页面会如实标 `defaultsSource:"builtin"`
  而非假装知道 profile 现值（`settings.get` 的 `defaultsDetail.reason` 会说明原因）。
