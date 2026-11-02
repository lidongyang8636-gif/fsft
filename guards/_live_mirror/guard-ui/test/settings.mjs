/**
 * guard-ui / settings.js 离线自测 —— 单一真源模块的契约测试。
 *
 * 覆盖 P1–P6 与「读写策略」（写边界严格拒绝 / 读边界宽容但响亮）：
 *   · P1 绝不回落 process.cwd()
 *   · P2 不缓存取值（改文件后立刻反映）
 *   · P3 逐字段合并；无覆盖时原样返回 profile 对象（同一引用）
 *   · P4 不存在 ⇒ 静默回落；存在但坏 ⇒ 响亮
 *   · P5 本测试同时是「模块可加载」的门禁（guard 静态 import 它，它坏 = 两个 guard 一起挂）
 *   · P6 无 agent / 无会话 cwd ⇒ profile 默认
 *
 * 用法：node guards/guard-ui/test/settings.mjs
 * 只写系统 temp，不碰工作区与 profile。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUARD_PLUGINS, KNOBS, SETTINGS_FILE_NAME, SETTINGS_VERSION,
  callerWorkspaceRoot, createProblemReporter, deleteWorkspaceSettings, getPath,
  isForbiddenWorkspacePath, mergeFor, quarantineCorrupt, readWorkspaceSettings,
  resolvePluginConfig, settingsPathFor, validateCombination, validatePayload,
  whitelistView, writeWorkspaceSettings,
} from '../lib/settings.js';

let bad = 0;
const check = (what, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`   ${pass ? '✅' : '❌'} ${what}${extra ? `  ${extra}` : ''}`);
};
const mkws = () => mkdtempSync(join(tmpdir(), 'guard-ui-ws-'));
const writeRaw = (cwd, text) => writeFileSync(settingsPathFor(cwd), text, 'utf8');
const readRawText = (cwd) => JSON.parse(readFileSync(settingsPathFor(cwd), 'utf8'));

const PROFILE_SANDBOX = { mode: 'set', childPreset: 'fpga-locked', writerExempt: true, eventLog: 'X:/ev.jsonl', onlyChildren: true };
const PROFILE_ROLE = {
  mode: 'enforce',
  roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'guard', serviceMissingPolicy: 'guard' },
  shellScope: { enabled: true, toolNames: ['pwsh'], allowPatterns: [] },
  eventLog: 'X:/guard.jsonl',
};

console.log('=== 1) schema 自洽：白名单不得含代码里不存在的分支 ===');
check('插件名单 = 两个 guard', GUARD_PLUGINS.join(',') === 'subagent-sandbox,role-guard', `实得 ${GUARD_PLUGINS.join(',')}`);
// ⚠ PLAN/TASK.2 §2.4 的标题写「6 个主开关」，但**同一条里枚举了 7 个**
//   （subagent-sandbox 3 个 + role-guard 4 个）。按枚举实现 7 个；「6」是笔误，已记入 HANDOFF。
check('第一版主开关 = 枚举出来的 7 个（TASK.2 §2.4 标题的「6」是笔误）', KNOBS.length === 7, `实得 ${KNOBS.length}`);
{
  const mode = KNOBS.find((k) => k.plugin === 'subagent-sandbox' && k.path === 'mode');
  check('mode 枚举 = off/observe/set', mode.values.join(',') === 'off,observe,set', `实得 ${mode.values.join(',')}`);
  check('★ mode 枚举**不含** enforce（D-B：那是作废的词，选了会被静默降级成 observe）', !mode.values.includes('enforce'));
  for (const p of ['roleScope.unknownPolicy', 'roleScope.serviceMissingPolicy']) {
    const k = KNOBS.find((x) => x.plugin === 'role-guard' && x.path === p);
    check(`★ ${p} 枚举**不含** deny（代码只特判 pass，deny 会是无效旋钮）`, !k.values.includes('deny'), `实得 ${k.values.join(',')}`);
  }
  check('每个旋钮都有 label/control/builtin', KNOBS.every((k) => k.label && k.control && k.builtin !== undefined));
}

console.log('\n=== 2) callerWorkspaceRoot：只认 session.header.cwd（P1） ===');
check('无 agent ⇒ null', callerWorkspaceRoot(undefined) === null);
check('agent 无 session ⇒ null', callerWorkspaceRoot({ id: 'a' }) === null);
check('session 无 header ⇒ null', callerWorkspaceRoot({ id: 'a', session: { id: 's' } }) === null);
check('header.cwd 为空串 ⇒ null', callerWorkspaceRoot({ id: 'a', session: { header: { cwd: '   ' } } }) === null);
check('header.cwd 有值 ⇒ 原样返回', callerWorkspaceRoot({ id: 'a', session: { header: { cwd: 'E:\\ws' } } }) === 'E:\\ws');

console.log('\n=== 3) ★ P1 绝不回落 process.cwd()（否则 stub 自测会被工作区文件改写）===');
{
  // ⚠ 绝不在**真实 process.cwd()（= 仓库根 / 本会话工作区）**里落 .dsh-guard.json：
  //   那是本会话正在跑的 guard 的工作区根，落下它 = 当场改写本会话的活护栏行为
  //   （且进程被 kill 时会留下一个长期静默改行为的文件）。
  //   改用 `process.chdir(临时目录)`：process.cwd() 变成 temp，回落与否照样能测，零风险。
  const ws = mkws();
  const prevCwd = process.cwd();
  try {
    writeRaw(ws, JSON.stringify({ version: 1, 'subagent-sandbox': { mode: 'off' } }));
    process.chdir(ws);
    check('前置：process.cwd() 已是临时目录且含设置文件',
      process.cwd() === ws && existsSync(join(ws, SETTINGS_FILE_NAME)));

    const noCwd = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { id: 'a', session: { id: 's' } });
    check('★ 无会话 cwd ⇒ 用 profile（不去读 process.cwd() 的文件）',
      noCwd.source === 'profile' && noCwd.config === PROFILE_SANDBOX,
      `source=${noCwd.source} reason=${noCwd.reason}`);
    check('★ 且 reason 明确标 agent-cwd-missing（红队 F2：意外缺 cwd，与 P6 有意降级分开）',
      noCwd.reason === 'agent-cwd-missing', noCwd.reason);
    check('★ F2：意外缺 cwd 时 problems **非空**（响亮，不再静默）',
      noCwd.problems.length === 1, JSON.stringify(noCwd.problems));

    const withCwd = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { id: 'a', session: { header: { cwd: ws } } });
    check('★ 有会话 cwd 且该目录有文件 ⇒ 才生效（证明判据是 session cwd，不是 process.cwd()）',
      withCwd.source === 'workspace' && withCwd.config.mode === 'off');

    const otherDir = mkws();
    const elsewhere = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { id: 'a', session: { header: { cwd: otherDir } } });
    check('会话 cwd 指向别处（无文件）⇒ profile / absent', elsewhere.source === 'profile' && elsewhere.reason === 'absent');
    rmSync(otherDir, { recursive: true, force: true });
  } finally {
    process.chdir(prevCwd);
    rmSync(ws, { recursive: true, force: true });
  }
  check('★ 复原：process.cwd() 已还原，且仓库根**没有**留下设置文件',
    process.cwd() === prevCwd && !existsSync(settingsPathFor(prevCwd)), settingsPathFor(prevCwd));
}

console.log('\n=== 4) readWorkspaceSettings：absent / ok / 各种坏 ===');
{
  const ws = mkws();
  const r0 = readWorkspaceSettings(ws);
  check('文件不存在 ⇒ absent（P4 常态，不记警告）', r0.status === 'absent' && r0.problems.length === 0);

  writeRaw(ws, `{"version":1,"subagent-sandbox":{"mode":"off","childPreset":"fpga-readonly","writerExempt":false}}`);
  const r1 = readWorkspaceSettings(ws);
  check('合法文件 ⇒ ok', r1.status === 'ok' && r1.problems.length === 0);
  check('值解析正确', r1.value['subagent-sandbox'].mode === 'off' && r1.value['subagent-sandbox'].childPreset === 'fpga-readonly');
  check('version 字段不混进 value', r1.value.version === undefined);

  writeRaw(ws, '{ this is not json ');
  check('非 JSON ⇒ invalid + 原因', readWorkspaceSettings(ws).status === 'invalid'
    && readWorkspaceSettings(ws).errors[0].includes('JSON'));

  writeRaw(ws, '[1,2,3]');
  check('顶层是数组 ⇒ invalid', readWorkspaceSettings(ws).status === 'invalid');

  writeRaw(ws, '{"version":99,"subagent-sandbox":{"mode":"set"}}');
  const rv = readWorkspaceSettings(ws);
  check('版本不符 ⇒ invalid（响亮，不许猜语义）', rv.status === 'invalid' && rv.errors[0].includes('版本不符'));

  writeRaw(ws, '{"version":1,"subagent-sandbox":{"mode":"enforce"}}');
  const re = readWorkspaceSettings(ws);
  check('★ mode=enforce ⇒ **该键被丢**且响亮（不是整份静默弃用）', re.status === 'ok'
    && re.value['subagent-sandbox'] === undefined
    && re.problems.some((p) => p.includes('enforce')), `problems=${JSON.stringify(re.problems)}`);

  writeRaw(ws, '{"version":1,"subagent-sandbox":{"mode":"set","typoKey":1},"unknown-plugin":{"x":1}}');
  const rt = readWorkspaceSettings(ws);
  check('同一份里：合法键照常生效 + 坏键响亮', rt.status === 'ok'
    && rt.value['subagent-sandbox']?.mode === 'set'
    && rt.problems.length === 2, `problems=${JSON.stringify(rt.problems)}`);

  writeRaw(ws, '{"version":1,"subagent-sandbox":{"mode":"set"},"role-guard":{"roleScope":{"enabled":false}}}');
  const rn = readWorkspaceSettings(ws);
  check('文件是**嵌套**写法，点分视图取得到', rn.value['role-guard'].roleScope.enabled === false);

  // ★ 前导 BOM：Windows 上「人写/手改」极易带 BOM（PowerShell 5.1 Set-Content -Encoding utf8、
  //   记事本默认都写 EF BB BF），而 JSON.parse('\uFEFF{…}') 直接抛。
  //   不剥 BOM ⇒ 用户写了 mode:"off" 却仍按 profile 跑 = 「设了不生效」。**V3 现场实测抓到的。**
  const wsBom = mkws();
  writeFileSync(settingsPathFor(wsBom), Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from('{"version":1,"subagent-sandbox":{"mode":"off"}}', 'utf8'),
  ]));
  const rb = readWorkspaceSettings(wsBom);
  check('★ 带 BOM 的文件仍能读（status ok / 值正确 / 无 problems）',
    rb.status === 'ok' && rb.value['subagent-sandbox']?.mode === 'off' && rb.problems.length === 0,
    JSON.stringify({ status: rb.status, mode: rb.value?.['subagent-sandbox']?.mode, errors: rb.errors }));
  check('★ 带 BOM 时覆盖真的生效（不是静默回落 profile）',
    resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { session: { header: { cwd: wsBom } } }).source === 'workspace');
  const wb = writeWorkspaceSettings(wsBom, { 'subagent-sandbox': { mode: 'set' } });
  check('★ 写入时也不把带 BOM 的文件误当坏文件改名',
    wb.ok && !(wb.notes ?? []).some((n) => n.includes('改名留底'))
    && readdirSync(wsBom).filter((f) => f.includes('.corrupt-')).length === 0, JSON.stringify(wb.notes));
  rmSync(wsBom, { recursive: true, force: true });

  // ★ 反向陷阱：把点分路径**当键名**写进文件（不是嵌套）⇒ 取不到 ⇒ 必须响亮，不许静默忽略
  writeRaw(ws, '{"version":1,"role-guard":{"roleScope.enabled":false}}');
  const rd = readWorkspaceSettings(ws);
  check('★ 点分当键名（写法不对）⇒ 响亮报告，不是静默 no-op',
    rd.status === 'ok' && rd.value['role-guard'] === undefined
    && rd.problems.some((p) => p.includes('写法不对')), `problems=${JSON.stringify(rd.problems)}`);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 5) P3 逐字段合并 + 无覆盖时同一引用 ===');
{
  const noOv = mergeFor('subagent-sandbox', PROFILE_SANDBOX, null);
  check('★ 无覆盖 ⇒ 返回**同一引用**（默认路径行为构造性不变）', noOv === PROFILE_SANDBOX);

  const merged = mergeFor('subagent-sandbox', PROFILE_SANDBOX, { mode: 'observe' });
  check('覆盖 mode，其余取自 profile', merged.mode === 'observe'
    && merged.childPreset === 'fpga-locked' && merged.writerExempt === true && merged.eventLog === 'X:/ev.jsonl');
  check('★ 不改动 profile 原对象', PROFILE_SANDBOX.mode === 'set');
  check('★ 未列入覆盖的键不被引入', merged.onlyChildren === true);

  const nested = mergeFor('role-guard', PROFILE_ROLE, { roleScope: { enabled: false } });
  check('嵌套逐字段合并', nested.roleScope.enabled === false
    && nested.roleScope.unknownPolicy === 'guard'
    && nested.shellScope.enabled === true
    && nested.roleScope.writerNamePatterns.join(',') === 'writer');
  check('★ 不改动 profile 的嵌套对象', PROFILE_ROLE.roleScope.enabled === true);
  check('不复制点分键到顶层', nested['roleScope.enabled'] === undefined);
}

console.log('\n=== 6) 组合不变式（role-guard 加载期规则，工作区覆盖必须保持）===');
{
  check('profile 原样 ⇒ 合法', validateCombination('role-guard', PROFILE_ROLE).ok);
  const bad1 = mergeFor('role-guard', PROFILE_ROLE, { roleScope: { enabled: false } });
  check('★ shellScope=true + roleScope=false ⇒ 不合法', !validateCombination('role-guard', bad1).ok);
  const ok1 = mergeFor('role-guard', PROFILE_ROLE, { shellScope: { enabled: false }, roleScope: { enabled: false } });
  check('两个都关 ⇒ 合法', validateCombination('role-guard', ok1).ok);
  check('subagent-sandbox 无组合规则', validateCombination('subagent-sandbox', { mode: 'off' }).ok);
  check('whitelistView 用 builtin 兜底缺失键', whitelistView('role-guard', { roleScope: {} })['shellScope.enabled'] === false);
}

console.log('\n=== 7) resolvePluginConfig：优先级 / 坏文件 / 组合非法 / P2 不缓存 ===');
{
  const ws = mkws();
  const agent = { id: 'a', session: { header: { cwd: ws } } };
  const base = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, agent);
  check('V4-a 无文件 ⇒ profile', base.source === 'profile' && base.config === PROFILE_SANDBOX);

  writeRaw(ws, JSON.stringify({ version: 1, 'subagent-sandbox': { mode: 'off' } }));
  const ov = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, agent);
  check('V4-b 有文件 ⇒ 覆盖生效 + source=workspace', ov.source === 'workspace' && ov.config.mode === 'off');
  check('V4-b 其余字段仍来自 profile', ov.config.childPreset === 'fpga-locked');

  rmSync(settingsPathFor(ws), { force: true });
  const back = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, agent);
  check('V4-c 删除文件 ⇒ 回落 profile', back.source === 'profile' && back.config === PROFILE_SANDBOX);

  writeRaw(ws, '{ broken');
  const badf = resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, agent);
  check('V5-a 坏文件 ⇒ 不炸、降级 profile、problems 非空（响亮）',
    badf.source === 'profile' && badf.reason === 'invalid' && badf.problems.length > 0);

  writeRaw(ws, JSON.stringify({ version: 1, 'subagent-sandbox': { mode: 'set' } }));
  check('★ P2 不缓存：坏文件改成好文件后，下一次调用立刻反映（无需重载）',
    resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, agent).source === 'workspace');

  writeRaw(ws, JSON.stringify({ version: 1, 'role-guard': { roleScope: { enabled: false } } }));
  const xr = resolvePluginConfig('role-guard', PROFILE_ROLE, agent);
  check('★ 组合非法（工作区关 roleScope、profile 开 shellScope）⇒ 整份覆盖弃用 + reason=cross-rule + 响亮',
    xr.source === 'profile' && xr.reason === 'cross-rule' && xr.problems.some((p) => p.includes('组合非法')));

  writeRaw(ws, JSON.stringify({ version: 1, 'subagent-sandbox': { mode: 'set' } }));
  const other = resolvePluginConfig('role-guard', PROFILE_ROLE, agent);
  check('文件里没有本插件段 ⇒ profile（reason=no-plugin-section）',
    other.source === 'profile' && other.reason === 'no-plugin-section');

  const noAgent = resolvePluginConfig('role-guard', PROFILE_ROLE, undefined);
  check('P6 无 agent（宿主级调用）⇒ profile + reason=host-level-call（有意降级，静默）',
    noAgent.source === 'profile' && noAgent.reason === 'host-level-call' && noAgent.problems.length === 0,
    `${noAgent.reason} / ${JSON.stringify(noAgent.problems)}`);
  // ★ 红队 F2 的核心：两种「回落 profile」必须可区分
  check('★ F2：host-level-call 与 agent-cwd-missing 是**两个**不同 reason',
    resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, undefined).reason
    !== resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { id: 'a', session: {} }).reason);
  check('★ F2：有 agent 但连 session 都没有 ⇒ 同样按 agent-cwd-missing 响亮',
    resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { id: 'a' }).reason === 'agent-cwd-missing');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 8) 写边界：严格拒绝（D-B 响亮拒绝），失败零落盘 ===');
{
  const ws = mkws();
  const cases = [
    ['未知插件段', { 'unknown-plugin': { mode: 'set' } }],
    ['未知键（拼错）', { 'subagent-sandbox': { mod: 'set' } }],
    ['枚举外取值 enforce', { 'subagent-sandbox': { mode: 'enforce' } }],
    ['枚举外取值 deny', { 'role-guard': { 'roleScope.unknownPolicy': 'deny' } }],
    ['类型不符', { 'subagent-sandbox': { writerExempt: 'yes' } }],
    ['空字符串', { 'subagent-sandbox': { childPreset: '  ' } }],
    ['组合非法（文件内部自相矛盾）', { 'role-guard': { 'shellScope.enabled': true, 'roleScope.enabled': false } }],
  ];
  for (const [what, patch] of cases) {
    const r = writeWorkspaceSettings(ws, patch);
    const wrote = existsSync(settingsPathFor(ws));
    check(`拒绝：${what}（且零落盘）`, !r.ok && r.errors.length > 0 && !wrote, `errors=${JSON.stringify(r.errors)}`);
  }
  // ★ 跨文件组合（工作区 × profile）：只有拿到 profile 现值才能权威拒绝。
  //   不传 profile ⇒ 只能尽力校验，且必须**如实记 note**（不假装查过）。
  const loose = writeWorkspaceSettings(ws, { 'role-guard': { 'roleScope.enabled': false } });
  check('不给 profile ⇒ 写入放行，但 notes 如实说明「未取得该插件的 profile 现值」',
    loose.ok && (loose.notes ?? []).some((n) => n.includes('未取得 role-guard 的 profile 现值')),
    JSON.stringify(loose.notes));
  check('★ F4：不给 profile 时 combinationChecked 逐插件标 file-internal-only（不再冒充权威校验）',
    loose.ok && loose.combinationChecked?.['role-guard'] === 'file-internal-only',
    JSON.stringify(loose.combinationChecked));
  check('★ F4：传 `{}`（=「读到了但为空」）也必须按「读不到」处理，不得静默放宽',
    (() => {
      rmSync(settingsPathFor(ws), { force: true });
      const r = writeWorkspaceSettings(ws, { 'role-guard': { 'roleScope.enabled': false } }, {});
      return r.ok && (r.notes ?? []).some((n) => n.includes('未取得 role-guard 的 profile 现值'));
    })());
  rmSync(settingsPathFor(ws), { force: true });
  rmSync(settingsPathFor(ws), { force: true });

  const strict = writeWorkspaceSettings(ws, { 'role-guard': { 'roleScope.enabled': false } },
    { 'role-guard': PROFILE_ROLE, 'subagent-sandbox': PROFILE_SANDBOX });
  check('★ 给 profile ⇒ 权威拒绝跨文件非法组合（否则 UI 会撒谎：显示已覆盖、guard 却整份弃用）',
    !strict.ok && strict.errors.some((e) => e.includes('组合非法')) && !existsSync(settingsPathFor(ws)),
    JSON.stringify(strict.errors));

  check('★ 跨盘符回归（relative 会返回绝对路径）：C: 上的 temp 目录**不**被误判为黑名单',
    !isForbiddenWorkspacePath(ws), ws);
  check('★ validatePayload 逐条报错（不是只报第一条）',
    validatePayload({ 'subagent-sandbox': { mod: 1, mode: 'x' } }).errors.length === 2);
  check('黑名单：拒绝写 %MAIN_REPO%', !writeWorkspaceSettings('%MAIN_REPO%', { 'subagent-sandbox': { mode: 'set' } }).ok);
  check('黑名单判定：%MAIN_REPO%-dsh **不**被误拦（前缀陷阱）', !isForbiddenWorkspacePath('%MAIN_REPO%-dsh'));
  check('黑名单判定：子目录被拦', isForbiddenWorkspacePath('%MAIN_REPO%\\sub'));
  check('黑名单判定：空值被拦', isForbiddenWorkspacePath(''));
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 9) 写边界：正常写入（原子写 + 读回一致）===');
{
  const ws = mkws();
  const r = writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'observe', writerExempt: false } });
  check('写入成功', r.ok && existsSync(settingsPathFor(ws)), JSON.stringify(r.errors));
  const onDisk = readRawText(ws);
  check('落盘内容正确', onDisk.version === SETTINGS_VERSION
    && onDisk['subagent-sandbox'].mode === 'observe' && onDisk['subagent-sandbox'].writerExempt === false);
  check('★ 原子写：目录里**没有**残留 .tmp 文件',
    readdirSync(ws).filter((f) => f.includes('.tmp')).length === 0, JSON.stringify(readdirSync(ws)));
  check('★ 读回（判定期同一条路径）与写入一致',
    resolvePluginConfig('subagent-sandbox', PROFILE_SANDBOX, { session: { header: { cwd: ws } } }).config.mode === 'observe');

  writeWorkspaceSettings(ws, { 'role-guard': { 'roleScope.unknownPolicy': 'pass' } });
  check('跨插件累加写（不互相覆盖）', existsSync(settingsPathFor(ws))
    && readRawText(ws)['subagent-sandbox'].mode === 'observe'
    && readRawText(ws)['role-guard']['roleScope'].unknownPolicy === 'pass');

  const del = writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: null } });
  check('null = 删掉该键（同段其它键保留）', del.ok
    && readRawText(ws)['subagent-sandbox'].mode === undefined
    && readRawText(ws)['subagent-sandbox'].writerExempt === false);

  const delRest = writeWorkspaceSettings(ws, { 'subagent-sandbox': { writerExempt: null } });
  check('★ 删空一个段 ⇒ 该段整段移除（不留 {} 空壳，否则 source 会撒谎成 workspace）',
    delRest.ok && readRawText(ws)['subagent-sandbox'] === undefined, JSON.stringify(readRawText(ws)));

  const delAll = writeWorkspaceSettings(ws, { 'role-guard': { 'roleScope.unknownPolicy': null } });
  check('★ 删到没有覆盖 ⇒ 文件本身被删（回落 profile）', delAll.ok && !existsSync(settingsPathFor(ws)));

  const d = deleteWorkspaceSettings(ws);
  check('delete 幂等（文件已不在也 ok）', d.ok && d.existed === false);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 10) 坏文件隔离（*.corrupt-*）与写后重建 ===');
{
  const ws = mkws();
  writeRaw(ws, '{ totally broken');
  const q = quarantineCorrupt(ws);
  check('改名成功且原文件已不在', q.renamed !== null && !existsSync(settingsPathFor(ws)), JSON.stringify(q));
  check('留底文件名含 .corrupt-', q.renamed.includes('.corrupt-'));
  check('留底内容 = 原坏内容', readFileSync(q.renamed, 'utf8') === '{ totally broken');

  writeRaw(ws, '{ broken again');
  const w = writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'set' } });
  check('写时遇到坏文件：改名留底 + 重建成功 + notes 说明',
    w.ok && (w.notes ?? []).some((n) => n.includes('改名留底')), JSON.stringify(w));
  check('坏文件留了两份底', readdirSync(ws).filter((f) => f.includes('.corrupt-')).length === 2);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 11) 日志去重器（不是取值缓存）===');
{
  const seen = [];
  const report = createProblemReporter((msg) => seen.push(msg));
  report(['同一个问题', '同一个问题', '另一个问题'], { a: 1 });
  report(['同一个问题'], { a: 2 });
  check('同一消息只吼一次，不同消息各吼一次', seen.length === 2, JSON.stringify(seen));
  report([], {});
  check('空 problems 不吼', seen.length === 2);
  check('report 抛错被吞（诊断不得影响主功能）', (() => {
    const r2 = createProblemReporter(() => { throw new Error('boom'); });
    try { r2(['x'], {}); return true; } catch { return false; }
  })());
}

console.log(`\n${bad === 0 ? '✅ settings.js 契约自测全部通过' : `❌ 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
