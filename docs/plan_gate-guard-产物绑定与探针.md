# gate-guard：产物绑定 + 产物探针（方案 C）实现计划

**日期**：2026-10-21
**前置**：[闸融合可行性](闸融合可行性_2026-10-21.md)（结论：方案 A 跨语言合并风险大于收益，走 C 分层）
**状态**：**计划**。未改代码、未改 profile、未跑 Vivado。
**目标**：让闸从「有没有新鲜绿证据」升级为「**证据绑到这一份产物，且这份产物自身达标**」。

---

## 1. 为什么必须动这个文件（技术成因，逐条对到代码）

| 现有行为 | 代码位置 | 后果（已实测） |
|---|---|---|
| 判据只看收口证据 + 断言文件 pin | `classifyBurnCall` 的 300–316 行 | 任何**无关任务**的收口都能解锁烧板（`03` 自承"证据与产物无身份关联"） |
| 产物只校验"存在/非链接/非空" | `probeCandidate`(140) + 351–374 行 | 产物**内容**从不检查 ⟹ 时序 `not met` 的位流照样 pass |
| 新鲜度 = 证据时间 > 产物 mtime | `isFresh`(113) + 376–387 行 | mtime 是自报的；`build2` 那次重建只把 mtime 推后了 30 分钟 |
| 产物候选可以多个 | `findArtifactCandidates`(168) | 多个 `.bit` 时**没有"选哪个"的语义**（r54 同一 run 下两份同尺寸位流） |

⟹ 缺的两件事正好是：**唯一性/配对**（哪一份）与**体检**（这一份好不好）。

---

## 2. 新配置（`cordis.patch.yml` 里 `gate-guard.config` 扩展）

```yaml
- insert:
    - id: gate-guard
      name: '%MAIN_REPO%-dsh/guards/gate-guard/lib/index.js'
      config:
        root: '%MAIN_REPO%-dsh'
        evidenceDir: gate/evidence
        # ── 新增（全部有默认值，缺省 = 现状 + 唯一性检查）─────────────
        allowMultipleArtifacts: false      # 同扩展名多候选：false ⇒ ask
        probes:                            # 空数组 = 完全不启用（与现状逐字节等价）
          - name: bitstream-own-timing
            file: '${runDir}/reports/direct_post_route_timing.rpt'
            mustMatch: ['All user specified timing constraints are met']
            mustNotMatch: ['Timing constraints are not met']
          - name: bitstream-own-drc
            file: '${runDir}/reports/direct_post_route_drc.rpt'
            mustMatch: ['Violations found: 0']
```

**路径模板**（只允许这几个，避免变成通用表达式求值器）：

| 变量 | 含义 |
|---|---|
| `${artifactAbs}` | 被点名产物的绝对路径 |
| `${artifactDir}` | 其所在目录（如 `fpga_out/s8-r54/bitstream`） |
| `${runDir}` | `artifactDir` 的上一级（如 `fpga_out/s8-r54`） |

`${runDir}` 正是 r54 需要的：位流在 `bitstream/`，报告在 `reports/`，**同一个 run 目录** ⟹ 一条 probe 就能要求"这份位流自己的报告说 met"。

---

## 3. 判定矩阵（改完之后 `classifyBurnCall` 的完整语义）

| # | 条件 | 动作 | 理由（人读） |
|---|---|---|---|
| 1 | 工具不在 `BURN_TOOLS` | pass | 不变 |
| 2 | 无收口块 | ask | 不变 |
| 3 | 证据缺失 / 解析失败 / `gateOk!=true` / `PASS==0` / pin 漂移 | deny | 不变 |
| 4 | 候选数为 0（未点名产物） | ask | 不变（`generate_bitstream` 这类合法情形） |
| 5 | 任一候选不存在 / 链接 / 目录 / 空文件 | ask | 不变（R4.3） |
| 6 | **同扩展名候选 ≥2**（且 `allowMultipleArtifacts=false`） | **ask（新）** | 列全候选，问"要烧哪一份" |
| 7 | **多候选但扩展名不同**（`bit`+`ltx`） | 允许继续 | 这是**正常配对**，不是歧义 |
| 8 | 证据/收口时间未晚于产物 mtime | deny | 不变 |
| 9 | **probe 文件不存在** | **ask（新）** | "本门无法判定" ≠ "产物坏了"（保留人的判断权） |
| 10 | **probe 命中 `mustNotMatch`** | **deny（新）** | 有原文就说它不达标，属"产物坏" |
| 11 | **probe 未命中任何 `mustMatch`** | **deny（新）** | 同上 |
| 12 | probe 读盘/正则运行期异常 | **ask（新）** | 与插件"绝不抛、永不堵死"的既有不变量一致 |
| 13 | 以上全过 | pass | `basis` 里附"已绑定产物 + 各 probe 结果" |

**关键取舍**：`deny` 只留给"**有证据表明它坏**"（第 3/8/10/11 条）；"**没法判断**"一律 `ask`（第 4/5/6/9/12 条）。这条与项目既有纪律一致：`deny` 制造死路，`ask` 保留人的判断权。

---

## 4. 实现步骤（三步，可独立合并）

### 步骤 1：唯一性（约 30 行，**先做**）

在 351–374 行那个 `for (candidates)` 之后、新鲜度之前插入：

```js
// 同扩展名多候选 = 调用者意图不明（例：同一 run 下两份同尺寸 .bit）
if (!allowMultipleArtifacts) {
  const byExt = new Map();
  for (const c of validFiles) {
    const ext = c.abs.slice(c.abs.lastIndexOf('.')).toLowerCase();
    byExt.set(ext, [...(byExt.get(ext) || []), c]);
  }
  const dup = [...byExt.entries()].filter(([, v]) => v.length > 1);
  if (dup.length > 0) return { action: 'ask', reason: ..., basis: '同扩展名多候选' };
}
```

不变量：**扩展名不同不算歧义**（`bit` + `ltx` 是标准组合），否则会把正常流程变成 ask。

### 步骤 2：探针（约 70 行）

```js
export function runProbes({ probes, artifact, root }) {
  const out = [];
  for (const p of probes) {
    const abs = expandProbePath(p.file, artifact);           // 只认三个模板变量
    if (!existsSync(abs)) { out.push({ name: p.name, verdict: 'ask', why: 'probe-file-missing' }); continue; }
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch (e) { out.push({ name: p.name, verdict: 'ask', why: `read:${e.message}` }); continue; }
    const hitBad = (p.mustNotMatch || []).find((re) => re.test(text));
    if (hitBad) { out.push({ name: p.name, verdict: 'deny', why: 'mustNotMatch', line: firstLineWith(text, hitBad) }); continue; }
    const miss = (p.mustMatch || []).find((re) => !re.test(text));
    if (miss) { out.push({ name: p.name, verdict: 'deny', why: 'mustMatch-miss', line: firstLineWith(text, miss) }); continue; }
    out.push({ name: p.name, verdict: 'ok' });
  }
  return out;
}
```

- **正则预编译**：在 `apply()` 里把 `mustMatch/mustNotMatch` 编译一次并缓存在闭包里；编译失败 ⇒ 记 `probe-config-error` 到判定日志 + 该 probe 判 `ask`（**不许静默丢弃**，否则等于没配）。
- **`deny` 必须带原文行**：`firstLineWith()` 取命中行的 trim，写进 `reason`。r54 会在那里输出 `Timing constraints are not met.` —— 一行就让人看懂。

### 步骤 3：接项目证据（可选，最后做）

把 `preboard-gate.py` 的**输出摘要**写成 `gate/evidence/preboard-latest.txt`，探针只读它：

```yaml
- name: preboard-gate-summary
  file: '${root}/gate/evidence/preboard-latest.txt'
  mustMatch: ['PREBOARD_GATE: PASS']
```

⟹ 插件**不调用** python，只读一份已被人工/脚本写出的摘要。跨语言耦合留在项目侧。

---

## 5. 自测清单（假宿主，与 `rule-router/test/smoke.mjs` 同一套写法）

| # | 场景 | 期望 |
|---|---|---|
| T1 | 两个同扩展名有效候选 | `ask`，reason 里两个路径都在 |
| T2 | `bit` + `ltx` 两个候选 | 不触发唯一性，继续走后面的判定 |
| T3 | 单候选 + probe 全命中 | `pass`，basis 里出现 probe 名 |
| T4 | 单候选 + 报告写 `Timing constraints are not met.` | `deny`，reason 含该原文行 |
| T5 | 单候选 + probe 文件不存在 | `ask`（不是 deny、不是 pass） |
| T6 | `probes: []`（不配置） | 判定序列与改动前**逐条相同**（回归基线） |
| T7 | probe 正则写错 | apply 时有 `probe-config-error` 日志；该 probe 判 `ask` |
| T8 | probe 文件读不了（权限/占用） | `ask`，不抛 |

判定一律**取 `classifyBurnCall` 的返回值 + 落盘日志**，不取内部变量。

---

## 6. 兼容、风险、回滚

| 项 | 处置 |
|---|---|
| 现有 profile 条目 | 只有 `root`/`evidenceDir` ⟹ 新字段全走默认；`probes` 默认 `[]` ⟹ **探针完全不影响既有判定** |
| 唯一性检查的**行为变化** | 默认 `allowMultipleArtifacts: false` 会把"同扩展名多候选"从 pass 变 ask。若现场有合法双 `.bit` 用法，改 `true` 即可回到旧行为 |
| 失败方向 | 严守文件头不变量：**任何异常都 `next()`**；判定层面"没法判断"给 `ask` 而不是 `deny` |
| 性能 | probe 只读 ≤200 KB 文本 + 正则，单次 < 5 ms；加 8 秒总预算上限，超时判 `ask` |
| 回滚 | 删 `probes` 段 + `allowMultipleArtifacts: true` ⟹ 与改动前等价；或整条 `disabled: true` |

---

## 7. NOT RUN（本计划未做的事）

- 未改任何代码/配置；未跑 Vivado；未在真实 MCP 调用上验证 ask/deny 的界面呈现。
- 未核 `gate/close.mjs` 是否需要同步改（它写 `taskState.gateOk`，本方案不动它的格式）。
- 未定义"跨 run 的产物配对"（例如位流在 r54、ELF 在别处）—— 本方案只做**同 run 内**配对。
- `gate/SPEC.md` L390「证据与产物无身份关联」那句**必须在本方案落地后同步改写**，否则文档继续落后于实现；本次未改。

---

## 8. 修订 R1（2026-10-21，用户裁定：「D4 探针改数值优先」）

> 本节**取代** §2 配置示例与 §4 步骤 2 中的**判据部分**（伪代码结构不变，只换判据）。

### 8.1 为什么改（实测，不是推测）

对两份真实报告的 6 种字符串判据实测（`fpga_out/s8-r54/reports/` = 坏；`build2/reports/` = 好）：

| 判据 | good（应 PASS） | bad（应 FAIL） | 结论 |
|---|---|---|---|
精确含 `All user specified timing constraints are met` | match | no | ✅ |
小写 `t` 含 / 忽略大小写含 | match | no | ✅ |
**大写 `T` 含 `Timing constraints are met`** | **no** | no | ❌ **假红** |
**`\b…\b` 词边界正则** | **no** | no | ❌ **假红** |
反向 `are not met`（当 mustMatch 用） | no | match | ❌ 语义反了 |

⟹ **"换成正则"不等于变稳**；脆的不是 in/regex 之别，而是**拿自然语言句子当判据**。

### 8.2 新判据：先解析摘要行，再判数值

```js
// 1) 定位 "Design Timing Summary" 的表头行（含 TNS Failing Endpoints）
// 2) 取其后第一个非空数据行
// 3) 解析 12 列：WNS TNS TNSfail TNStotal WHS THS THSfail THStotal WPWS TPWS TPWSfail TPWStotal
const RE = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s*$/;
// 判据（全部满足才 PASS）：WNS >= 0 && TNS === 0 && TNSfail === 0
```

实测结果：

| 报告 | WNS | TNS | TNSfail | 判决 |
|---|---|---|---|---|
`build2`（好） | `11.034` | `0` | `0` | PASS ✓ |
`s8-r54`（坏） | `-40.037` | `-278.343` | `7` | FAIL ✓ |

**状态句降级为辅助**：`All user specified timing constraints are met` 命中只写进 `basis` 供人读，**不参与判定**；`are not met` 仍可作 `mustNotMatch`（**只用于 deny 加注**，不当 mustMatch）。

### 8.3 配置形态（替换 §2 示例里的 `mustMatch`）

```yaml
- name: bitstream-own-timing
  file: '${runDir}/reports/direct_post_route_timing.rpt'
  expect: { wnsMin: 0, tns: 0, failPoints: 0 }     # ← 数值优先（新）
  noteMustMatch: 'All user specified timing constraints are met'  # ← 仅入 basis，不判定
```

### 8.4 强制 fixture（防"我自己写错判据"）

每条探针**必须**声明正负样本，否则 `apply()` 时判定为 `config-error` 并**禁用该探针**（响亮记日志，不静默）：

```yaml
  fixtures:
    - { file: 'fpga_out/s8-r54/build2/reports/direct_post_route_timing.rpt', expectPass: true  }
    - { file: 'fpga_out/s8-r54/reports/direct_post_route_timing.rpt',       expectPass: false }
```

**判据**：fixture 自测不通过 ⟹ 该探针**不得启用**（否则它会把"格式差异"当"产物坏"）。这正是 §8.1 里两条假红判据被抓住的方式。

### 8.5 R1 的 NOT RUN

- 只验证了 Vivado 2019.1 这两份报告的形态；**其它版本 / 其它报告（`report_timing`、impl_1 runme.log）未测**。
- 数值门槛只取 `WNS/TNS/failPoints`；`WHS`（hold）**未纳入判据**（本工程 WHS 单调 +/-0.06 属固有薄余量，纳入会恒定告警）——**它是刻意排除，不是忘了**。
- 未改任何代码与配置；探针仍未实现。
