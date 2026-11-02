/**
 * profile 补丁校验器：真 YAML 解析（硬门禁）+ 结构/缩进扫描（补充）。
 *
 * 两层各管一件事：
 *   1. 真解析器（js-yaml / yaml）：语法错、缩进错、重复键 —— 解析失败即非零退出；
 *   2. 结构扫描：本文件特有的形状断言，重点是「role-guard 必须落在 `- insert:` 内」。
 *      教训：顶层裸 `- id: xxx` 是「按 id 覆盖已有条目」，新插件这样写会被 DSH
 *      静默忽略（Config provider 报 unknown entry id），第一次 RT-02 因此假 FAIL。
 *
 * ⚠ 解析器对未知 tag（如 `!!js`）比 DSH 更严格，故「通过」是保守信号。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const WORK = join(here, '..', '..', '..');
const CACHE = join(WORK, '.cache', 'dsh-guard');
const PROFILE_PATCH = String.raw`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`;
const ENTRY_FILE = join(WORK, 'guards', 'role-guard', 'profile-patch-entry.yml');

const PROBLEM_FILE = process.env.RG_VALIDATE_FILE ?? PROFILE_PATCH;
const raw = readFileSync(PROBLEM_FILE, 'utf8');
let constructed;
if (process.env.RG_VALIDATE_FILE) {
  // 直接校验指定文件（用于写回 profile 后的复核）
  constructed = raw;
} else {
  const entryRaw = readFileSync(ENTRY_FILE, 'utf8');
  const mm = entryRaw.match(/INSERT-START\r?\n([\s\S]*?)# INSERT-END/);
  if (!mm) { console.error('找不到 INSERT-START…INSERT-END 区块'); process.exit(1); }
  constructed = raw.replace(/\s*$/, '\n') + '\n' + mm[1].trimEnd() + '\n';
  writeFileSync(join(CACHE, 'profile-patch.CONSTRUCTED.yml'), constructed, 'utf8');
}

// ── 第一步：真解析器（硬门禁）──────────────────────────────────────────────
// 之前的版本只有我自写的结构检查，那是"形状检查"不是"解析"。这里接上 js-yaml：
//   解析失败 ⇒ 立刻非零退出，不再往下走（缩进/重复键/类型错都会在这里暴露）。
let doc = null;
let parserName = '(未找到解析器)';
const PARSER_CANDIDATES = [
  ['js-yaml', join(CACHE, 'yamlprobe', 'node_modules', 'js-yaml')],
  ['js-yaml', 'js-yaml'],
  ['yaml', 'yaml'],
];
for (const [label, spec] of PARSER_CANDIDATES) {
  let mod;
  try { mod = require(spec); } catch { continue; }
  const load = mod.load ?? mod.parse ?? mod.default?.load;
  if (typeof load !== 'function') continue;
  try {
    doc = load(constructed, { filename: PROBLEM_FILE });
    parserName = `${label} @ ${spec}`;
    break;
  } catch (e) {
    console.error(`❌ YAML 解析失败（${label}）：`);
    console.error(`   ${e.message}`);
    if (e.mark) console.error(`   位置：第 ${e.mark.line + 1} 行，第 ${e.mark.column + 1} 列`);
    process.exit(1);
  }
}
if (doc === null) {
  console.error('❌ 找不到任何 YAML 解析器（js-yaml / yaml），无法用真解析器验证。');
  console.error('   提示：把 js-yaml 装到 .cache/dsh-guard/yamlprobe 后重跑。');
  process.exit(1);
}
console.log(`真解析器：${parserName}`);
if (!Array.isArray(doc)) {
  console.error(`❌ 顶层解析结果不是数组，而是 ${typeof doc}`);
  process.exit(1);
}
console.log(`真解析：顶层 ${doc.length} 项 ✅`);

const problems = [];
const lines = constructed.split(/\r?\n/);

/** 逐行解析成 [{indent, raw, text, kind}]，并检查制表符/尾随空格 */
const rows = [];
lines.forEach((raw, i) => {
  const ln = i + 1;
  if (/^\s*$/.test(raw)) return;
  const stripped = raw.replace(/\r$/, '');
  const lead = stripped.match(/^[ \t]*/)[0];
  if (lead.includes('\t')) problems.push(`L${ln}: 含制表符（YAML 禁止用 tab 做缩进）：${stripped.slice(0, 60)}`);
  const indent = lead.replace(/\t/g, '  ').length;
  const text = stripped.slice(lead.length);
  if (text.startsWith('#')) return;                       // 注释行
  let kind = 'other';
  if (text.startsWith('- ')) kind = 'list-item';
  else if (/^[^:#]+:\s*$/.test(text)) kind = 'map-key';   // key: 后面空
  else if (/^[^:#]+:\s+\S/.test(text)) kind = 'inline-pair';
  else if (/^-/.test(text)) kind = 'list-item';
  rows.push({ ln, indent, text, kind, raw: stripped });
});

// ── 顶层项：indent === 0 且是 list-item ────────────────────────────────────
const topItems = rows.filter((r) => r.indent === 0 && r.kind === 'list-item');
console.log(`顶层数组项：${topItems.length} 条`);
const topIds = [];
for (const r of topItems) {
  const m = r.text.match(/^-\s+(?:id|insert)\s*:\s*(.*)$/);
  if (m) topIds.push(m[1].trim() || '(insert)');
}
console.log('顶层 id 序列：' + topIds.join(', '));

// ── 断言 A：基于**真解析对象**（最硬）─────────────────────────────────────
// 形态要点（2026-10-14 实测教训）：新插件必须挂在 `- insert:` 下。
// 顶层裸 `- id: xxx` 是「按 id 覆盖已有条目」——role-guard 不存在时会被
// DSH 静默忽略（Config provider 报 unknown entry id），第一次 RT-02 就是这样假 FAIL 的。
// 故这里只在 insert 块里找它，顶层出现反而应当报警。
const EXPECT_NAME = '%MAIN_REPO%-dsh/guards/role-guard/lib/index.js';
const normPath = (s) => String(s ?? '').replace(/\\/g, '/');

const inserts = doc.filter((x) => x && Array.isArray(x.insert));
const insertedEntries = inserts.flatMap((x) => x.insert);
const rgNode = insertedEntries.find((x) => x && x.id === 'role-guard');

if (!rgNode) {
  const inTop = doc.find((x) => x && x.id === 'role-guard');
  problems.push(inTop
    ? 'role-guard 出现在顶层裸条目里（会被 DSH 当作「覆盖不存在的条目」而忽略）——必须放进 `- insert:`'
    : '真解析结果里找不到 id: role-guard 条目（insert 块内也没有）');
} else {
  if (normPath(rgNode.name) !== EXPECT_NAME) {
    problems.push(`role-guard.name 不符：${JSON.stringify(rgNode.name)}（期望 ${EXPECT_NAME}）`);
  }
  const c = rgNode.config ?? {};
  // mode 两态都合法；不硬编码，但必须报出来（enforce 会真拦工具，属行为变更）
  if (c.mode !== 'dry-run' && c.mode !== 'enforce') {
    problems.push(`config.mode 应为 'dry-run' 或 'enforce'，实为 ${JSON.stringify(c.mode)}`);
  }
  if (!Array.isArray(c.probeDeny)) {
    problems.push(`config.probeDeny 应为数组（可为空），实为 ${JSON.stringify(c.probeDeny)}`);
  } else if (c.probeDeny.length > 0 && c.probeDeny.some((n) => typeof n !== 'string')) {
    problems.push('config.probeDeny 只应包含字符串工具名');
  }
  if (c.probeReadOnlyNames !== true) problems.push(`config.probeReadOnlyNames 应为 true，实为 ${JSON.stringify(c.probeReadOnlyNames)}`);
  // restrictMcpWriteTools：布尔即可；但复刻插件的配置自检——restrict 是 scope 静态掩码，
  // 唯一落点是 agent scope。设 true 却不开 agentScope ⇒ 插件拒绝加载，这里提前挡下。
  if (typeof c.restrictMcpWriteTools !== 'boolean') {
    problems.push(`config.restrictMcpWriteTools 应为布尔，实为 ${JSON.stringify(c.restrictMcpWriteTools)}`);
  }
  if (c.restrictMcpWriteTools === true && c.agentScope?.enabled !== true) {
    problems.push('config.restrictMcpWriteTools=true 但 agentScope.enabled≠true —— 插件会拒绝加载（restrict 无落点）');
  }
  if (c.eventLog !== undefined && (typeof c.eventLog !== 'string' || c.eventLog.trim() === '')) {
    problems.push(`config.eventLog 若非空应为路径字符串，实为 ${JSON.stringify(c.eventLog)}`);
  }
  if (typeof c.agentScope?.enabled !== 'boolean') problems.push('config.agentScope.enabled 应为布尔');
  if (!Array.isArray(c.agentScope?.agentIds)) problems.push('config.agentScope.agentIds 应为数组');
  if (c.agentScope?.role !== 'reviewer') problems.push(`config.agentScope.role 应为 'reviewer'，实为 ${JSON.stringify(c.agentScope?.role)}`);
  console.log(`加固层：restrictMcpWriteTools=${c.restrictMcpWriteTools}  agentScope=${c.agentScope?.enabled === true ? 'on' : 'off'}  eventLog=${c.eventLog ? 'on' : 'off'}`);
  // roleScope：角色作用域（2026-10-14 四条决策的落点）
  if (c.roleScope !== undefined) {
    const rs = c.roleScope;
    if (typeof rs.enabled !== 'boolean') problems.push(`config.roleScope.enabled 应为布尔，实为 ${JSON.stringify(rs.enabled)}`);
    if (!Array.isArray(rs.writerNamePatterns) || rs.writerNamePatterns.length === 0) {
      problems.push(`config.roleScope.writerNamePatterns 应为非空数组，实为 ${JSON.stringify(rs.writerNamePatterns)}`);
    } else if (rs.writerNamePatterns.some((p) => typeof p !== 'string' || p.trim() === '')) {
      problems.push('config.roleScope.writerNamePatterns 不应包含空串/非字符串');
    }
    for (const [k, allowed] of [['unknownPolicy', ['pass', 'guard']], ['serviceMissingPolicy', ['guard', 'pass']]]) {
      if (!allowed.includes(rs[k])) problems.push(`config.roleScope.${k} 应为 ${allowed.join('/')}，实为 ${JSON.stringify(rs[k])}`);
    }
    // ⚠ 安全硬断言：unknownPolicy=pass 是**绕过通道**。
    //    2026-10-14 实测：审查者用 `subagent` 派生一个子 agent（非团队成员 ⇒ 身份未知）
    //    即可拿到完整 MCP 写权限。子 agent 现已由「祖先角色继承」归因，
    //    故 pass 只剩"对无责任链的宿主调用放行"这一含义，没有安全理由。
    if (rs.enabled && rs.unknownPolicy === 'pass') {
      problems.push('config.roleScope.unknownPolicy=pass 会留下绕过通道（审查者可用 subagent 派生写手子 agent）'
        + ' —— 应为 guard。若确需 pass，请先改本校验器的这条规则并说明理由');
    }
    console.log(`角色模式：roleScope=${rs.enabled ? 'on' : 'off'}  写手模式=${JSON.stringify(rs.writerNamePatterns)}  未知身份=${rs.unknownPolicy}  服务缺失=${rs.serviceMissingPolicy}`);
    if (rs.enabled && c.mode !== 'enforce') {
      console.log('  （roleScope 已启用但 mode 非 enforce ⇒ 只记录不拦，属预期）');
    }
  }
  console.log(`运行模式：mode=${c.mode}  probeDeny=${JSON.stringify(c.probeDeny)}`);
}
// role-guard 必须存在于某个 insert 块里（不要求"最后一个"了：
// 2026-10-14 追加了 subagent-sandbox 条目，末尾已不是它）
if (!insertedEntries.some((x) => x && x.id === 'role-guard')) {
  problems.push('role-guard 未出现在任何 insert 块内');
}
// 子代理沙箱条目：存在则校验其关键字段（不存在不算错，实验完成会摘掉）
{
  const probe = insertedEntries.find((x) => x && x.id === 'subagent-sandbox');
  if (probe) {
    const pc = probe.config ?? {};
    // 路 A 正式键是 childPreset；preset 为兼容别名（旧配置仍可校验通过）
    const childPreset = pc.childPreset ?? pc.preset;
    if (!['observe', 'set', 'off'].includes(pc.mode)) {
      problems.push(`沙箱条目 config.mode 应为 observe/set/off，实为 ${JSON.stringify(pc.mode)}`);
    }
    if (typeof pc.eventLog !== 'string' || pc.eventLog.trim() === '') {
      problems.push('沙箱条目 config.eventLog 必须是非空路径（否则取证通道缺失）');
    }
    if (pc.mode === 'set' && (typeof childPreset !== 'string' || childPreset.trim() === '')) {
      problems.push('沙箱条目 mode=set 时 config.childPreset（或别名 preset）必填');
    }
    if (pc.preset !== undefined && pc.childPreset === undefined) {
      problems.push('沙箱条目仍在使用兼容别名 preset，建议改用正式键 childPreset');
    }
    if (pc.writerExempt === true && Array.isArray(pc.writerNamePatterns) && pc.writerNamePatterns.length === 0) {
      problems.push('沙箱条目 writerExempt=true 但 writerNamePatterns 为空 ⇒ 豁免永不命中');
    }
    console.log(`  子代理沙箱：mode=${pc.mode} childPreset=${childPreset} `
      + `writerExempt=${pc.writerExempt} 豁免名=${JSON.stringify(pc.writerNamePatterns ?? [])}`
      + `+${JSON.stringify(pc.exemptNamePatterns ?? [])}`);
  }
}
// 既有关键条目必须在（真解析对象里核）
const docIds = doc.map((x) => x && x.id).filter(Boolean);
for (const need of ['permission', 'skill-filesystem', 'ui-conversation',
                    'agent-preset-registry', 'subagent', 'llm-pi-ai',
                    'agent-default-model', 'ui-theme']) {
  if (!docIds.includes(need)) problems.push(`既有关键条目疑似丢失：${need}`);
}
// 原有 insert 块必须还在（本轮之前是 2 个：MCP 服务器 + engram；现在多了 role-guard = 3）
const insertedCount = insertedEntries.length;
if (inserts.length < 3) problems.push(`insert 块应至少 3 个（MCP/engram/role-guard），实为 ${inserts.length}`);
const insertedIds = insertedEntries.map((x) => x && (x.id ?? x.name)).filter(Boolean);
for (const need of ['mcp-vivado', 'mcp-fpga', 'dsh-engram']) {
  if (!insertedIds.includes(need)) problems.push(`原有 insert 条目疑似丢失：${need}`);
}
if (insertedCount < 4) problems.push(`insert 内条目偏少（${insertedCount}），疑似丢失`);
// 权限预设四档必须还在（fpga-locked 是上一轮的成果）
const perm = doc.find((x) => x && x.id === 'permission');
const presetNames = Object.keys(perm?.config?.presets ?? {});
for (const need of ['workspace-write', 'danger-full-access', 'fpga-readonly', 'fpga-locked']) {
  if (!presetNames.includes(need)) problems.push(`权限预设疑似丢失：${need}`);
}

// ── 断言 B：基于**结构/缩进扫描**（补充，专挡缩进静默失效）─────────────────
if (topItems.length === 0) problems.push('顶层没有任何 `- ` 数组项');
for (const need of ['permission', 'skill-filesystem', 'ui-conversation', 'agent-preset-registry']) {
  if (!topIds.includes(need)) problems.push(`既有关键条目疑似丢失或缩进错：${need}`);
}
if (!topIds.includes('(insert)')) problems.push('原有 `- insert:` 区块疑似丢失');

// ── role-guard 段：相对结构判定（不假设绝对缩进，因为它在 insert 块内，整体 +4）──
const rgRow = rows.find((r) => /^-\s+id:\s*role-guard\s*$/.test(r.text));
if (!rgRow) {
  problems.push('缩进扫描找不到 `- id: role-guard` 行');
} else {
  if (rgRow.indent === 0) {
    problems.push('`- id: role-guard` 出现在顶层（indent 0）——必须缩进在 `- insert:` 之内');
  }
  // 收集该条目后续行，直到遇到同级或更浅的 list-item
  const seg = [];
  for (let i = rows.indexOf(rgRow) + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'list-item' && r.indent <= rgRow.indent) break;
    seg.push(r);
  }
  const relKeys = (delta) => new Set(
    seg.filter((r) => r.indent === rgRow.indent + delta)
       .map((r) => r.text.split(':')[0].trim()),
  );
  const lvl1 = relKeys(2);   // name / config
  const lvl2 = relKeys(4);   // mode / probeDeny / ...
  for (const k of ['name', 'config']) {
    if (!lvl1.has(k)) problems.push(`role-guard 段缺少键 ${k}（缩进层级异常）`);
  }
  for (const k of ['mode', 'probeDeny']) {
    if (!lvl2.has(k)) problems.push(`role-guard.config 缺少 ${k}（缩进层级异常）`);
  }
  // 探针列表项：仅当 probeDeny 非空时要求它出现在 config 内更深一层
  const probeDenyNode = doc.find((x) => x && Array.isArray(x.insert))
    ?.insert?.find((x) => x && x.id === 'role-guard')?.config?.probeDeny ?? [];
  if (Array.isArray(probeDenyNode) && probeDenyNode.length > 0) {
    const probe = seg.find((r) => r.kind === 'list-item'
      && probeDenyNode.some((n) => r.text.includes(n)));
    if (!probe) {
      problems.push(`probeDeny 的列表项在结构扫描里找不到：${JSON.stringify(probeDenyNode)}`);
    } else if (probe.indent <= rgRow.indent + 4) {
      problems.push(`probeDeny 列表项缩进异常（indent=${probe.indent}，应深于 config）`);
    }
  }
  // name 的值必须是工作区绝对路径（正/反斜杠都接受）
  const nameRow = seg.find((r) => /^name:/.test(r.text));
  if (!nameRow || normPath(nameRow.text.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '')) !== EXPECT_NAME) {
    problems.push(`role-guard.name 不是预期的工作区绝对路径：${nameRow ? nameRow.text : '(缺失)'}`);
  }
}

console.log(`\n检查了 ${rows.length} 行有效内容`);
if (problems.length > 0) {
  console.log('\n❌ 发现问题：');
  for (const p of problems) console.log('   ' + p);
  process.exitCode = 1;
} else {
  console.log(`\n✅ 通过：真解析器（${parserName}）成功解析，且断言全部满足`);
  console.log('   · role-guard 位于文件末的 `- insert:` 块内（新插件唯一正确形态），');
  console.log('      name / mode / probeDeny / agentScope 逐字段核对通过');
  console.log('   · 既有条目齐在：permission（4 档预设含 fpga-locked）/ skill-filesystem /');
  console.log('     mcp-vivado / mcp-fpga / dsh-engram / subagent / llm-pi-ai …');
  console.log('   · 无制表符缩进；role-guard 段缩进层级正确（未落回顶层）');
  console.log('   ⚠ 本文件用到的解析器对未知 tag（如 !!js）比 DSH 更严格，');
  console.log('     故它通过是保守信号；"能否加载"以运行期 guard 是否拦截为准。');
}
console.log(`\n构造结果：${join(CACHE, 'profile-patch.CONSTRUCTED.yml')}`);
