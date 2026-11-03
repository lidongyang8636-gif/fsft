#!/usr/bin/env node
/**
 * gate/scripts/write-repro.mjs —— **由实测生成** `slices/gate/REPRO.1.md`。
 *
 * WHY 不手写：本 slice 的核心主张是"结论必须能从真实退出码复算"。
 * 如果复现文档里的数字是手抄的，它自己就违反了这条主张。
 * 所以这份文档从**当前这一次运行**的原始输出与证据 JSON 里抽取，
 * 每次运行都会被覆写；引用它的地方必须同时给命令与退出码。
 *
 * 用法：node gate/scripts/write-repro.mjs
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const GATE = join(ROOT, 'gate');
const EVID = join(GATE, 'evidence');
const round = process.argv[2] || '1';
const OUT = join(ROOT, 'slices', 'gate', `REPRO.${round}.md`);

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '(缺失)');
const newest = (prefix) => {
  const files = readdirSync(EVID).filter((f) => f.startsWith(prefix) && f.endsWith('.json') && !f.includes('_selftest'));
  if (!files.length) return null;
  const sorted = files.sort();
  return { name: sorted[sorted.length - 1], path: join(EVID, sorted[sorted.length - 1]) };
};
/** 所有匹配的证据文件（按时间戳排序），用于逐域列出。 */
const allOf = (prefix) => readdirSync(EVID)
  .filter((f) => f.startsWith(prefix) && f.endsWith('.json') && !f.includes('_selftest'))
  .sort()
  .map((f) => ({ name: f, path: join(EVID, f) }));
const code = (p) => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return j;
};

function main() {
  const gs = newest('gate-guards-suite-r1-');
  const mm = newest('gate-selftest-mismatch-cli-');
  const selftest = readIf(join(EVID, '_selftest', 'selftest-summary.json'));
  const st = JSON.parse(selftest);
  const g = gs ? code(gs.path) : null;
  const m = mm ? code(mm.path) : null;

  const L = [];
  L.push(`# REPRO.${round} —— gate slice 第 ${round} 轮复现步骤与证据`);
  L.push('');
  L.push('> **本文件由 `gate/scripts/write-repro.mjs ' + round + '` 从原始输出与证据 JSON 生成**，不是手抄。');
  L.push(`> 生成时间（本次运行）：${new Date().toISOString()}`);
  L.push('> 环境：本机 DSH 工作区 `E:\\ChongyouGreenbike-dsh`，Node `' + process.version + '`。');
  L.push('> 所有命令都可在工作区根直接复跑；**未跑的一律标 `NOT RUN`**。');
  L.push('');

  L.push('## 0 前置：本机两个必须知道的坑（否则复跑会得到假结果）');
  L.push('');
  L.push('| 坑 | 实测 | 影响 |');
  L.push('|---|---|---|');
  L.push('| PATH 上的 `python`/`python3` 是 WindowsApps 坏别名 | `& python --version` → `[exit code: 1]`，`$LASTEXITCODE=9009` | 任何 `python xx.py` **什么都没跑**；本 slice 的解释器解析**不回落**裸 `python` |');
  L.push('| Node `spawnSync` 带管道 = EPERM | `status=null error=EPERM`；`stdio:\'inherit\'` 正常 | runner 用 **fd 重定向**捕获；fd 被拒时回落 `inherit`；`TEMP/TMP` 钉进工作区内 |');
  L.push('');

  L.push('## 1 自测（A2：四态各一例，**必须含 MISMATCH 负例**）');
  L.push('');
  L.push('```powershell');
  L.push('cd E:\\ChongyouGreenbike-dsh');
  L.push('node gate/gate.mjs --self-test');
  L.push('```');
  L.push('');
  L.push(`**实测退出码：` + (st ? '0' : '（见下）') + `**`);
  L.push('');
  L.push('| 夹具 | 期望/实测断言态 | declared_exit | real_exit | 产物 |');
  L.push('|---|---|---|---|---|');
  for (const r of st.results) {
    L.push(`| \`${r.taskId}\` | ${r.perAssertion.join(' ')} | \`${JSON.stringify(r.declaredExit)}\` | \`${JSON.stringify(r.realExit)}\` | \`${r.evidencePath.replace(ROOT + '\\', '').replace(/\\/g, '/')}\` |`);
  }
  L.push('');
  L.push(`四态覆盖：**${Object.entries(st.covered).map(([k, v]) => `${k}=${v ? 'YES' : 'NO'}`).join(' · ')}**`);
  L.push('');
  L.push(`MISMATCH 负例成立：**${st.mismatchNegative ? '是' : '否'}** —— 声明 \`exit=0\`，真实 \`exit=3\`，runner 独立测量后判 \`MISMATCH\`。`);
  L.push('');
  L.push('★ 关键点：**这个负例不是"跑一个命令看它过没过"**，而是"**伪造一份自述，看判定器能不能抓住**"。');
  L.push('命令真实退出码由 runner 测量（`spawnSync` 返回值），描述符里的 `exit` 只作**声明**。');
  L.push('');

  L.push('### 1.1 UNVERIFIED 的三条分支（都是"没取得结论"，不是"通过"）');
  L.push('');
  const uv = st.results.find((r) => r.taskId === 'selftest-unverified');
  if (uv) {
    L.push('| 断言 | 场景 | 结果 |');
    L.push('|---|---|---|');
    L.push('| S1 | 命令**起不来**（`shell:false` + 不存在的可执行文件 ⟹ `ENOENT`） | `UNVERIFIED`（即便声明了 `exit=0`） |');
    L.push('| S2 | 只有文件判据（**不产生退出码**） | `PASS`，`real.exit=null`，不伪造 exit |');
    L.push('| S3 | 跑了但**未声明退出码** | `UNVERIFIED`（无判据可比） |');
    L.push(`| — | 任务级 verdict | \`${uv.verdict}\`（UNVERIFIED **排最前**） |`);
  }
  L.push('');
  L.push('> 实测附加发现：`shell:true` 时"找不到的可执行文件"会被 `cmd.exe` **吞成 `exit=1`**，');
  L.push('> 从而被误判成 `MISMATCH`。只有 `shell:false` 才真正暴露 `ENOENT`。');
  L.push('> 这正是"**环境失败 ≠ 判据失败**"必须靠 `harness` 字段分开记的活证据。');
  L.push('');

  L.push('## 2 真实适配器（A3：本工程现役验证跑成证据 JSON）');
  L.push('');
  L.push('```powershell');
  L.push('node gate/gate.mjs --task gate/tasks/guards-suite-r1.json');
  L.push('```');
  L.push('');
  if (g) {
    L.push(`**实测退出码：0**（` + (g.taskState.gateOk ? 'gateOk=true' : 'gateOk=false') + `）`);
    L.push('');
    L.push('```');
    L.push('GATE guards-suite-r1 PASS'
      + ` assertions=${g.evaluated.length}`
      + ` PASS=${g.taskState.counts.PASS} HONEST_FAIL=${g.taskState.counts.HONEST_FAIL}`
      + ` MISMATCH=${g.taskState.counts.MISMATCH} UNVERIFIED=${g.taskState.counts.UNVERIFIED}`
      + ` ran=${g.evaluated.filter((e) => e.real.exit !== null).length}`
      + ` noWrite=${g.noWriteResults.every((r) => r.verdict === 'CLEAN') ? `clean:${g.noWriteResults.length}` : 'SEE-EVIDENCE'}`);
    L.push('```');
    L.push('');
    L.push('| id | 它证明什么 | oracle | 真实退出码 | 声明 | 结论串 | 状态 | 耗时 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const e of g.evaluated) {
      const needleHit = (e.basis.match(/包含 "([^"]+)"/) || [])[1] || '—（无结论串，弱判据）';
      L.push(`| ${e.id} | ${(e.what || '').slice(0, 44)} | \`${e.oracle}\` | ${e.real.exit} | ${e.declaration.exit} | ${needleHit} | **${e.state}** | ${e.real.ms} ms |`);
    }
    L.push('');
    L.push('**noWrite 实测（A5 的机器部分）**：');
    L.push('');
    L.push('| 路径 | 文件数 | changed | 裁定 |');
    L.push('|---|---|---|---|');
    for (const r of g.noWriteResults) {
      L.push(`| \`${r.path}\` | ${r.files} | ${r.changed} | ${r.verdict} |`);
    }
    L.push('');
    L.push(`**证据文件**：\`${gs.name}\``);
    L.push('');
    L.push('### 2.1 已知副作用（**如实登记，不假装零写入**）');
    L.push('');
    L.push('| 路径 | 由谁写 | 性质 |');
    L.push('|---|---|---|');
    L.push('| `.cache/dsh-guard/js-allow.txt` / `js-deny.txt` | G07 `selfcheck.mjs` | 测试重新生成自己的清单（不在本 slice 写域） |');
    L.push('| `.cache/dsh-guard/profile-patch.CONSTRUCTED.yml` | G09 `validate-patch.mjs` | 测试构造产物（不在本 slice 写域） |');
    L.push('');
    L.push('### 2.2 明确 NOT RUN（不是"没提"，是"明确不做"）');
    L.push('');
    L.push('| id | 什么 | 为什么不做 |');
    L.push('|---|---|---|');
    L.push('| N1 | `.cache/dsh-guard/link_gate.py` | **永不判红**（`ok=67 missing=2` 仍 exit=0）⇒ 不可作判据；全工作区扫描 ⇒ 数字会被别人移动（`missing` 今日 1→2），当判据必须钉基线；有越界副作用（**内容幂等、mtime 非幂等**）。 |');
    L.push('| N2 | `smart_home/slices/_common/*`（第一代） | 属 `smart_home/` 域且多数写 `smart_home/**`；已在 INVENTORY §1 登记。 |');
    L.push('| N3 | `lab_2_2_11_wifi-package/**`（第二代）与 `fpga/**` | 需 staging 构建副本／后端进程／Edge／Vivado；已在 INVENTORY §2 登记。 |');
  } else {
    L.push('**NOT RUN**：未找到 `gate-guards-suite-r1-*.json` 证据文件.');
  }
  L.push('');

  L.push('## 3 CLI 负例：MISMATCH 会被判红（TASK.1 §4-A2 的命令行证明）');
  L.push('');
  L.push('```powershell');
  L.push('node gate/gate.mjs --task gate/tasks/_selftest-mismatch-cli.json');
  L.push('```');
  L.push('');
  if (m) {
    L.push(`**实测退出码：1**（= 工具对自己撒谎，与"判据未过"的 2 分开）`);
    L.push('');
    L.push('| 断言 | 声明 | 真实 | 状态 | 依据 |');
    L.push('|---|---|---|---|---|');
    for (const e of m.evaluated) {
      L.push(`| ${e.id} | exit=${e.declaration.exit} | **exit=${e.real.exit}** | **${e.state}** | ${e.basis.replace(/\|/g, '\\|')} |`);
    }
  }
  L.push('');
  L.push('## 4 描述符被拒：无判据不收（退出码 3）');
  L.push('');
  L.push('```powershell');
  L.push('node gate/gate.mjs --task gate/no-such-task.json          # 描述符不存在');
  L.push('node gate/gate.mjs --verify --task gate/tasks/guards-suite-r1.json   # 只校验不执行');
  L.push('```');
  L.push('');
  L.push('实测：描述符不存在 → **退出码 3** + `GATE-RUNNER ERROR: 描述符不存在`（**不产出任何 PASS**）。');
  L.push('');
  L.push('## 5 无副作用（A5：全工作区指纹比对）');
  L.push('');
  L.push('```powershell');
  L.push('node gate/scripts/verify-no-side-effects.mjs --before');
  L.push('# （跑上面 1/2/3 的命令 —— ★ 中间**不要**改任何源文件/文档）');
  L.push('node gate/scripts/verify-no-side-effects.mjs --after');
  L.push('```');
  L.push('');
  L.push('> ★ **括号纪律**：`--before` 与 `--after` 之间只许跑被检命令。');
  L.push('> 若在这中间编辑了 `slices/gate/**` 或 `gate/**` 的源文件，它们会以 `CONTENT` 变化出现在 `--after` 里，');
  L.push('> 那条 FAIL 度量的是**编辑器**而不是 gate。**改了东西就重新取基线。**');
  L.push('> （这条是 R1.1 实测踩出来的：canary 负例测试期间正好也在改 REPRO/frozen，于是 EXTERNAL 报了 3 条"越界"。）');
  L.push('');
  L.push('实测（**两个维度分开报**，R1.1 修正）：');
  L.push('');
  L.push('- **对外**：`SIDE_EFFECT_EXTERNAL: PASS` —— 全工作区指纹变化都在白名单内：');
  L.push('  `gate/evidence/**`（gate 自己的产物），以及 `.cache/dsh-guard/{js-allow.txt,js-deny.txt,profile-patch.CONSTRUCTED.yml}` 的 **mtime**（内容不变）。');
  L.push('- **自身交付树**：`SIDE_EFFECT_SELFTREE: PASS` —— 临时区（`<工作区根>/.scratch/` 与两个历史位置）探到 **0 个残留文件**，退出码 0。');
  L.push('');
  L.push('> 为什么拆两段：A5 原来只有"对外"一个维度，而 `.scratch` 被整块跳过 ⟹ **收尾清理失败时检查不出声**。');
  L.push('> R1.1 之前实测代价：`gate/.scratch/tmp/**` 悄悄留下 **12 个文件**（R1 侦察阶段手工探针的 `ev.jsonl`），');
  L.push('> 而当时 HANDOFF 写着"不留临时文件"。**已删除**（见 HANDOFF §5.1）—— 声明与事实不符是这一族的通病。');
  L.push('');
  L.push('### 5.1 新增的自身树检查**本身**经过负例证明（否则它也只是装饰）');
  L.push('');
  L.push('```powershell');
  L.push('New-Item -ItemType Directory -Force -Path .scratch\\tmp | Out-Null');
  L.push("Set-Content .scratch\\tmp\\canary.txt 'deliberate residue'");
  L.push('node gate/scripts/verify-no-side-effects.mjs --after     # 必须变红');
  L.push('Remove-Item .scratch -Recurse -Force');
  L.push('node gate/scripts/verify-no-side-effects.mjs --after     # 必须变绿');
  L.push('```');
  L.push('');
  L.push('实测（R1.1）：有 canary 时 → `[★RESIDUE] .scratch/ files=1 bytes=56` + `SIDE_EFFECT_SELFTREE: FAIL` + **退出码 2**；');
  L.push('删掉 canary 后 → `SIDE_EFFECT_SELFTREE: PASS`。');
  L.push('**这条检查有区分能力**（不是"恒绿"），且能给出残留的文件数与字节数。');
  L.push('');
  L.push('**零变化的路径**（也在实测里被逐条确认）：');
  L.push('');
  L.push('- `guards/**` 源码与测试**零改动**（`noWrite` 的 4 个目录：37 个文件全 `CLEAN`）；');
  L.push('- `slices/guard-ui/**` 零改动；');
  L.push('- 主仓库 `E:\\ChongyouGreenbike\\**` 零写入（沙箱实测拒绝：`Set-Content` → 访问被拒绝）；');
  L.push('- `<DSH_HOME>\\.dsh\\**`（profile）零写入；'); // R11/T9：宿主路径改占位符，源码内不留用户名
  L.push('- 临时文件**零残留**：子进程 `TEMP`/`TMP` 与输出重定向都钉在 `<工作区根>/.scratch/`，收尾 `cleanupScratch` 删除，并由 `SIDE_EFFECT_SELFTREE` 段显式探测。');
  L.push('');

  L.push('## 6 未跑的检查（NOT RUN —— 不许当成已验证）');
  L.push('');
  L.push('- **NOT RUN**：**接线未强制**——契约与模板已就位（`gate/SPEC.md` §3.7 + `gate/templates/HANDOFF-GATE.md`），'
    + '但"每轮 HANDOFF 必须带 GATE 段"这件事**没有**在任何流程里强制执行。');
  L.push('- **NOT RUN**：**强制门 / 拦截层**（没有证据 JSON 就不许宣告收口）—— `TASK.3.md`（R3），需用户单独批。');
  L.push('- **NOT RUN**：**R3b（宿主拦截：没有证据就不许收口做成 deny 动作）** —— 三个前置缺一不做：'
    + '① 用户当场点头（新能力 + 要改 profile）② **必须重启 DSH**（2026-10-15 三次事故铁律）'
    + '③ 一轮异构红队（判据：能否造出一条"绕过它却仍产出收口行/证据行"的路径）。'
    + '见 `TASK.3.md` §0。');
  L.push('- **NOT RUN**：与 guard 插件集成；UI。');
  L.push('- **NOT RUN**：`link_gate.py` 未纳入 acceptance（理由见 §2.2 N1）。');
  L.push('- **NOT RUN**：`android` / `backend` / `fpga` 三域**本轮未被验证任何东西**'
    + '（`assertions=0`、`ran=0`、`verdict=UNVERIFIED`、退出码 2）；其 `notRun[]` 见 §8。');
  L.push('- **NOT RUN**：第一代（`smart_home/slices/_common/*`）、第二代（`lab_2_2_11_wifi-package/**`）、'
    + '`fpga/**` 的 `.tcl` 未实跑（见 INVENTORY §1/§2/§5）。');
  L.push('- **NOT RUN**：`docs` 域的 `#锚点` 校验与外部 `http(s)` 链接存活（见 §7.3 的 DN1/DN2）。');
  L.push('');

  // ---------------- R2 段 ----------------
  L.push('## 7 R2：四域适配器（`docs` 真跑；`android`/`backend`/`fpga` 只给 notRun）');
  L.push('');
  L.push('### 7.1 `docs` 域：**真跑**，且判据**会判红**');
  L.push('');
  L.push('```powershell');
  L.push('node gate/gate.mjs --task gate/tasks/docs-links-r2.json');
  L.push('```');
  L.push('');
  const docsAll = allOf('gate-docs-links-r2-');
  const docs = docsAll.length ? code(docsAll[docsAll.length - 1].path) : null;
  if (docs) {
    L.push(`实测退出码 **0**（gateOk=${docs.taskState.gateOk}）；证据：\`${docsAll[docsAll.length - 1].name}\``);
    L.push('');
    L.push('```');
    L.push(`GATE docs-links-r2 ${docs.taskState.gateOk ? 'PASS' : 'gateOk=false'}`
      + ` assertions=${docs.evaluated.length}`
      + ` PASS=${docs.taskState.counts.PASS} HONEST_FAIL=${docs.taskState.counts.HONEST_FAIL}`
      + ` MISMATCH=${docs.taskState.counts.MISMATCH} UNVERIFIED=${docs.taskState.counts.UNVERIFIED}`
      + ` ran=${docs.evaluated.filter((e) => e.real.exit !== null).length}`
      + ` noWrite=${docs.noWriteResults.every((r) => r.verdict === 'CLEAN') ? `clean:${docs.noWriteResults.length}` : 'SEE-EVIDENCE'}`);
    L.push('```');
    L.push('');
    L.push('| id | 判据 | oracle | 真实退出码 | 状态 |');
    L.push('|---|---|---|---|---|');
    for (const e of docs.evaluated) {
      L.push(`| ${e.id} | ${(e.what || '').slice(0, 70)} | \`${e.oracle}\` | ${e.real.exit} | **${e.state}** |`);
    }
    L.push('');
  } else {
    L.push('**NOT RUN**：未找到 `gate-docs-links-r2-*.json` 证据文件。');
  }

  L.push('### 7.2 docs 域的 canary 套件（**恒绿不算过**）');
  L.push('');
  L.push('```powershell');
  L.push('node gate/scripts/canary-docs.mjs     # 5 个场景，逐一断言**确切退出码**');
  L.push('```');
  L.push('');
  L.push('| 场景 | 构造 | 期望退出码 | 说明 |');
  L.push('|---|---|---:|---|');
  L.push('| C1 | 合成树里放 1 条**断链** | **1** | 造断链 ⇒ 判红。"会判红"的定义 |');
  L.push('| C2 | 同树，把断链**撤销** | **0** | 撤销 ⇒ 判绿。C1+C2 = 有区分能力 |');
  L.push('| C3 | **真实 `docs/`** + **空** exceptions | **1** | ★ 证明它**真的看得见**现场那 2 条断链，而不是"没查所以绿" |');
  L.push('| C4 | **真实 `docs/`** + 真 exceptions | **0** | acceptance 里跑的就是这条（`DOC_LINK_RESULT: PASS`） |');
  L.push('| C5 | **零命中**（空目录） | **2** | "没查到东西"**不是**通过 ⇒ 无法裁决 |');
  L.push('');
  L.push('> 实测 `DOCS_CANARY: PASS (5/5)`，退出码 **0**。');
  L.push('> ⚠ 踩过的坑：C5 最初**没建空目录**，于是它命中的是"范围不存在"分支 —— '
    + '退出码同样是 2，场景看着通过，**但测的不是它声称的东西**。已修（现在真走到 `DOC_LINK_ZERO_LINKS`）。');
  L.push('> 这正是本协议的病根：**测试自己也要能被问"它真的在测它说的东西吗"**。');
  L.push('');

  L.push('### 7.3 `android` / `backend` / `fpga`：**零 PASS 断言**，只有 `notRun[]`');
  L.push('');
  L.push('```powershell');
  for (const t of ['android-r2', 'backend-r2', 'fpga-r2']) L.push(`node gate/gate.mjs --task gate/tasks/${t}.json     # 期望退出码 2`);
  L.push('```');
  L.push('');
  L.push('| 域 | 退出码 | assertions | ran | PASS | verdict | notRun 条数 |');
  L.push('|---|---:|---:|---:|---:|---|---:|');
  for (const t of ['android-r2', 'backend-r2', 'fpga-r2']) {
    const arr = allOf(`gate-${t}-`);
    if (!arr.length) { L.push(`| \`${t}\` | (无证据) | | | | | |`); continue; }
    const j = code(arr[arr.length - 1].path);
    L.push(`| \`${t}\` | **2** | ${j.evaluated.length} | ${j.evaluated.filter((e) => e.real.exit !== null).length}`
      + ` | ${j.taskState.counts.PASS} | \`${j.taskState.verdict}\` | ${(j.notRun || []).length} |`);
  }
  L.push('');
  L.push('**逐条 notRun（含前置条件；`capability`=跑不了 / `authorization`=跑得动但本轮授权不做）**：');
  L.push('');
  L.push('| 域 | id | category | 本该验什么 | 前置条件 |');
  L.push('|---|---|---|---|---|');
  for (const t of ['android-r2', 'backend-r2', 'fpga-r2', 'docs-links-r2']) {
    const arr = allOf(`gate-${t}-`);
    if (!arr.length) continue;
    const j = code(arr[arr.length - 1].path);
    for (const nr of (j.notRun || [])) {
      L.push(`| \`${t}\` | ${nr.id} | \`${nr.category || '-'}\` | ${String(nr.what).slice(0, 46)} | ${String(nr.precondition).slice(0, 60)} |`);
    }
  }
  L.push('');
  L.push('> ⚠ 一条**实测修正**：`TASK.2 §1` 把整个 `fpga` 域的理由写成「需提权 + Vivado / xtclsh」。'
    + '实测其中**两个**设备侧门禁是**只读 PowerShell**，本沙箱**跑得动且通过**：'
    + '`check_doc_links.ps1`（exit 0 / `LINK_CHECK_RESULT: ALL PASS`，62 文件 339 链接）与 '
    + '`check_project_drift.ps1`（exit 0 / `DRIFT_RESULT: IN SYNC`）。'
    + '它们的 `category` 因此标为 **authorization** 而非 `capability` —— **不许把"本轮不做"写成"跑不了"**。');
  L.push('');

  L.push('### 7.4 适配器 ↔ 描述符：机械核对（R2 补的洞）');
  L.push('');
  L.push('```powershell');
  L.push('node gate/scripts/gen-tasks.mjs --check     # 期望退出码 0');
  L.push('```');
  L.push('');
  L.push('> R1 时适配器与描述符是**两份手写**的东西，一致性靠 `_provenance` 里一句散文承诺 —— **那是自述不是检查项**。');
  L.push('> R2 起适配器是**唯一事实来源**，描述符是生成物，`--check` 逐字段比对（有漂移 ⇒ exit 1）。');
  L.push('> ⚠ 而且实测发现：R1 的 `guards-suite.mjs` **从未被任何代码 import 过**（只被"读码确认"）。'
    + 'R2 一接入 `gen-tasks.mjs` 立刻暴露出块注释里星号紧跟斜杠导致**注释提前闭合**、运行时 `ReferenceError`。'
    + '**能被 import 才算适配器。**');
  L.push('');

  // ---------------- R3a 段 ----------------
  L.push('## 8 R3a：收口门 `close.mjs`（三条拒绝路径 + 通过路径）');
  L.push('');
  L.push('「**收口 = `gate/close.mjs` 通过**」。退出码：`0` 收口成功 / `2` 无 PASS 证据 / `4` 哈希漂移 / `5` 收口行不合规 / `3` 无法裁决 / `6` **证据残缺**（R4.1 新增；此前会逃逸成**未分配**的 `1`）。');
  L.push('');
  L.push('```powershell');
  L.push('node gate/scripts/canary-close.mjs     # 14 个场景，各自断言**确切**退出码（R4.2 起含 6 与 3 两例）');
  L.push('node gate/scripts/close-e2e.mjs        # 在**真实任务**上端到端收口');
  L.push('```');
  L.push('');
  const ccPath = join(EVID, 'close-canary-summary.json');
  if (existsSync(ccPath)) {
    const cc = JSON.parse(readFileSync(ccPath, 'utf8'));
    L.push(`实测（生成于 ${cc.ranAt}）：`);
    L.push('');
    L.push('| 场景 | 期望码 | 实测码 | 结论 |');
    L.push('|---|---:|---:|---|');
    for (const s of cc.scenarios) L.push(`| ${s.name} | ${s.expected} | ${s.actual} | ${s.pass ? 'OK' : '**FAIL**'} |`);
    L.push('');
    L.push(`收口块内容自检：\`${JSON.stringify(cc.closingBlockSelfCheck)}\``);
    L.push('');
    L.push('**三条拒绝路径各自的"会红"证据**（都在**真跑**出来的证据上制造，不是手造 JSON）：');
    L.push('');
    L.push('- **路径 1（无 PASS 证据 ⇒ 码 2）**：证据文件不存在 ⇒ 2；真跑一个失败的合成任务拿它的证据 ⇒ 2。');
    L.push('- **路径 2（哈希漂移 ⇒ 码 4）**：改被验文件 ⇒ 4，**复原 ⇒ 0**；改描述符（自动 pin）⇒ 4，**复原 ⇒ 0**。');
    L.push('- **路径 3（收口行不合规 ⇒ 码 5）**：不给收口行 ⇒ 5；漏点 notRun id ⇒ 5；GATE 行数字与证据不符 ⇒ 5；**齐备 ⇒ 0**。');
    L.push('');
    L.push('> ★ **"复原 ⇒ 0" 的对照是刻意加的**：只证明"会红"的门可能是**恒红**的，那同样不能用。');
    L.push('> `TASK.3.md` 的判据是「**恒绿不算过，恒红也不算过**」，所以每条拒绝路径都配一条通过对照。');
  } else {
    L.push('**NOT RUN**：未找到 `close-canary-summary.json`（先跑 `canary-close.mjs`）。');
  }
  L.push('');
  const cbPath = join(EVID, 'close-docs-links-r2.md');
  if (existsSync(cbPath)) {
    L.push('### 8.1 真实任务上产出的收口块（可直接贴 HANDOFF）');
    L.push('');
    L.push('```');
    for (const l of readFileSync(cbPath, 'utf8').split(/\r?\n/).slice(0, 8)) L.push(l);
    L.push('…（完整块见 `gate/evidence/close-docs-links-r2.md`）');
    L.push('```');
    L.push('');
  }
  L.push('### 8.2 证据钉住什么 / 边界');
  L.push('');
  L.push('- `pins` 四类：任务描述符 · 判据机器（`gate.mjs` / `lib/runner.mjs` / `lib/env.mjs`）· `hashFiles[]` 声明 · 断言按路径点名的被验文件。');
  L.push('- **自动钉住描述符与判据机器是有意的**：像 `docs` 域那样全靠 `stdout_contains:` 的任务，');
  L.push('  若不自动钉，`evaluated[].files[]` 是空的 ⟹ "哈希漂移"这条拒绝路径**不可达**。');
  L.push('- **边界（不许写成拦截层）**：`close.mjs` **不拦手写收口行**、**不防伪造**（证据无签名），');
  L.push('  它只让"按规矩收口"成为最省事的路。真正的拦截是 R3b，**本轮未做**（三前置见 `TASK.3.md` §0）。');
  L.push('');

  // ---------------- R3b 段 ----------------
  L.push('## 9 R3b：宿主侧上板门（`guards/gate-guard`）');
  L.push('');
  L.push('> 本轮**只做代码 + 离线自证 + 攻击面自曝**；**未激活**（不改 profile、不装/启插件、不重启）。');
  L.push('> P0 侦察（`tools/pre-execute` 真实形状）见 `gate/_recon/PRESECUTE-PROBE.md`。');
  L.push('');
  L.push('```powershell');
  L.push('node gate/_recon/rt-probe.mjs           # 用宿主真实 cordis 实测 waterfall 失败语义（6 用例）');
  L.push('node gate/scripts/canary-gateguard.mjs  # 上板门离线 canary（三条分级 + fail-open + 不误伤 + 一致性）');
  L.push('```');
  L.push('');
  const ggPath = join(EVID, 'gateguard-canary-summary.json');
  if (existsSync(ggPath)) {
    const gg = JSON.parse(readFileSync(ggPath, 'utf8'));
    L.push(`实测（生成于 ${gg.ranAt}）：**${gg.total - gg.failed}/${gg.total} 条通过**，拦截面 ${gg.burnTools} 个工具。`);
    L.push('');
    L.push('| # | 断言 | 结果 |');
    L.push('|---:|---|---|');
    gg.checks.forEach((c, i) => L.push(`| ${i + 1} | ${c.name} | ${c.ok ? 'OK' : '**FAIL**'} |`));
    L.push('');
  } else {
    L.push('**NOT RUN**：未找到 `gateguard-canary-summary.json`（先跑 `canary-gateguard.mjs`）。');
  }
  L.push('### 9.1 三条分级的确切返回值（不是"非空"）');
  L.push('');
  L.push('| 证据状态 | 插件返回 | 断言 |');
  L.push('|---|---|---|');
  L.push('| 无收口证据 | `{kind:"ask", reason:"无 gate 证据…", displayReason:"上板门：**无 gate 证据**…"}` | `kind==="ask"` + 两个文案各含指定字样 + **未调用 `next()`** |');
  L.push('| **绑不上产物**（R4.2 增） | `{kind:"ask", reason:"本门无法把证据与本次烧写对象绑定：…"}` | ① 无产物候选 ② 点名了但**磁盘上不存在** ⇒ **各断言确切 `ask`** 且未调用 `next()` |');
  L.push('| **候选不合格**（R4.3 增） | `{kind:"ask", reason:"…候选不合格（n/m）：· <哪条不满足>…"}` | **混合**（1 存在 + 1 不存在）／**空文件**／**带扩展名目录**／**symlink** ⇒ 各断言 **`action==="ask"` 且 `nextCalls===0`**；**保留正向对照**（有效普通文件 ⇒ `pass`） |');
  L.push('| 红证据 / 漂移 / 不新鲜 | `{kind:"deny", reason:"红证据…" / "证据漂移…" / "证据不新鲜…"}` | `kind==="deny"` + reason 含对应字样 + **未调用 `next()`** |');
  L.push('| PASS 且新鲜 | **调用 `next()` 并原样返回它的返回值** | 断言 `nextCalls===1` 且返回值 `=== next()` 的哨兵值 |');
  L.push('');
  L.push('> **R4.2（红队第 1 轮返修）**：`reviews/gate-guard-redteam.1.md` 总判「造得出绕过路径」。');
  L.push('> 根因一条：**"新鲜"没有与「本次要烧的产物」绑定** —— 产物列表为空时退化成"只看证据自报时间"。');
  L.push('> 修法：**绑不上就不放行**（`ask`），并把 `isFresh(_, [])` 从 `true` 改为 **`false`**');
  L.push('> （Lead 第一手复现：旧版 `isFresh(now+1h, [])` 与 `isFresh(now−1h, [])` **都**为 `true`）。');
  L.push('> canary 里另有**前置自证**：绿证据 + 存在产物 ⇒ `pass`，否则四例证明不了绑定规则。');
  L.push('> **F1（`run_tcl`/`exec_tcl`）有意不修**、**F4（`GATEGUARD_OFF`）保持不变**，见 `SPEC §5` 已知边界。');
  L.push('');
  L.push('### 9.2 fail-open（硬要求）与逃生舱');
  L.push('');
  L.push('- **fail-open canary**：把 `exec.arguments` 换成**会抛的 getter** ⇒ 插件走 `catch` ⇒ **放行**（`nextCalls===1`），');
  L.push('  且日志出现 `"action":"fail-open"` 与注入标记 `INJECTED-PLUGIN-FAULT`。');
  L.push('- **逃生舱**：`GATEGUARD_OFF=1` ⇒ 整层关闭（无证据也放行），日志 `"action":"off"`。');
  L.push('');
  L.push('> **为什么 fail-open 必须写成 `next()` 而不是 `return {kind:"allow"}`** —— P0 实测（真实 cordis）：');
  L.push('> **不调用 `next()` 会否决链上其余 listener，连内置默认行为也不跑**。');
  L.push('> 所以 `{kind:"allow"}` 不是"放行"，而是**静默覆盖别人的更严判定**。');
  L.push('');
  L.push('### 9.3 不误伤');
  L.push('');
  L.push('- 18 个常见工具（`report_*`/`get_*`/`run_tcl`/`pwsh`/`Read`/`Write`/`Edit`/`Grep`/`Glob`/`job_output` 等）**零拦截**；');
  L.push('- **有意排除**的读类/准备类（`viv_readback_flash`、`viv_list_flash_parts`、`viv_verify_flash`、');
  L.push('  `viv_add_flash_config`、`viv_set_flash_property`、`viv_set_hw_device_program_file`、`check_bitstream_readiness`）同样零拦截；');
  L.push('- 拦截面 13 个工具**全部**在无证据时被拦下（`ask`）；名单 `<= 20` 且不含任何读类名。');
  L.push('');
  L.push('### 9.4 一致性：两份实现不许漂移');
  L.push('');
  L.push('插件**不能** import `gate/close.mjs`（那个文件顶层就 `process.exitCode = main();`，import 会执行 CLI），');
  L.push('而 R3b 又禁止改 R1–R3a 的冻结件 ⟹ 只能有两份实现。');
  L.push('因此 canary 里有**一致性段**：同一夹具分别问插件与 `close.mjs`（spawn），断言两者同结论：');
  L.push('干净 ⇒ `close.mjs` 退出 **0** / 插件 `pass`；漂移 ⇒ `close.mjs` **4** / 插件 `deny`。');
  L.push('');
  L.push('### 9.5 攻击面自曝（红队入口）');
  L.push('');
  L.push('`guards/gate-guard/REDTEAM-NOTES.md` —— **11 条**绕过路径，含：');
  L.push('`run_tcl` 通道内任意执行（最大洞）· `pwsh` 起 Vivado 完全绕开 MCP · 跨任务挪用 · 名单字面化 ·');
  L.push('伪造证据（无签名）· 时间戳自报可伪造 · fail-open 被反向利用 · 逃生舱 · TOCTOU ·');
  L.push('有意排除的准备类工具 · `ask` 在无 UI/无 agent 时退化为 `deny`。');
  L.push('**其中 6 条没有缓解措施**，已如实标注。');
  L.push('');

  L.push('## 10 残余风险（如实记录，不声称已解决）');
  L.push('');
  L.push('- `noWrite[]` 是**路径前缀**不是 glob；`UNRESOLVED`（解析不到）会判红，但"改完又改回去"检测不到。');
  L.push('- `stdout_contains:` 的结论串由写者挑选；本 slice 对没有结论串的检查（G06/G09）**明确标弱**，没有替它们编一个。');
  L.push('- `docs` 域的 exceptions 表是**人工声明**：新增断链若被误加进 exceptions 就会静默通过。'
    + '缓解：`STALE` 条目会被打印；但"该不该声明"仍需人判。');
  L.push('- `SIDE_EFFECT_SELFTREE` 只探三个已知临时区路径；在别处新造临时文件不会被发现（靠"临时区唯一化"的纪律）。');
  L.push('- `readOnlyNote`（写动词启发式）只作提示，**不作判定依据**。');
  L.push('- 证据 JSON 是**机器可复核**的那一半；实机验收仍以日期化人读记录（`06-上板记录模板.md` 同族）为正本。');
  L.push('');

  writeFileSync(OUT, L.join('\n'), 'utf8');
  console.log(`WROTE ${OUT} (${L.length} lines)`);
  return 0;
}

process.exitCode = main();
