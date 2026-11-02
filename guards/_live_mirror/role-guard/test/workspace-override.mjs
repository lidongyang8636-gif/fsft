/**
 * role-guard × 每工作区设置（guard-ui P1，PLAN §9.1 裁决 D-A：拉取式）离线自测。
 *
 * 覆盖本轮**最关键回归**：
 *   · V6  无工作区文件时，判定行为须与改动前**逐项一致**（同一 apply、同一矩阵，逐条比对）
 *   · P1  判据是 `exec.agent.session.header.cwd`，**绝不回落 process.cwd()**
 *   · P2  改文件后**不重新 apply** 也立即生效
 *   · P3  逐字段合并
 *   · P4  坏文件不炸、降级、响亮
 *   · P6  `exec.agent === undefined`（宿主级调用）⇒ profile 默认（有意降级）
 *   · 组合不变式：工作区覆盖不得造成 shellScope=true + roleScope=false
 *
 * 用法：node guards/role-guard/test/workspace-override.mjs
 * 只写系统 temp，绝不写工作区根（那是本会话活护栏的工作区根）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);

let bad = 0;
const check = (what, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`   ${pass ? '✅' : '❌'} ${what}${extra ? `  ${extra}` : ''}`);
};
const mkws = () => mkdtempSync(join(tmpdir(), 'rg-ws-'));
const setWs = (cwd, payload) => writeFileSync(join(cwd, '.dsh-guard.json'), JSON.stringify(payload), 'utf8');

/** 近似 Cordis 的 effect（必须支持生成器：插件用 `ctx.effect(function*(){...})` 交出 disposer） */
function runEffect(fn) {
  const ret = typeof fn === 'function' ? fn() : undefined;
  if (ret && typeof ret.next === 'function') {
    const disposers = [];
    for (let r = ret.next(); !r.done; r = ret.next()) if (typeof r.value === 'function') disposers.push(r.value);
    return () => { for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } } };
  }
  return typeof ret === 'function' ? ret : () => {};
}

/** 造 stub ctx + apply 一次；返回 { guards, logs } */
function mount(config, teamMap = {}) {
  const guards = [];
  const logs = [];
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(`INFO ${m}`),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    }),
    tools: {
      guard: (fn) => { guards.push(fn); return () => {}; },
      schemas: () => [{ name: 'mcp__vivado__run_tcl' }, { name: 'mcp__vivado__get_project_info' }, { name: 'pwsh' }],
      restrict: () => { throw new Error('本用例不该调 restrict'); },
    },
    effect: (fn) => runEffect(fn),
    on: () => {},
    get: (k) => (k === 'agentTeams'
      ? { tryMembership: (a) => teamMap[a?.id] }
      : undefined),
  };
  mod.apply(ctx, config);
  return { guards, logs };
}

const dec = (guards, exec) => {
  const r = guards[0](exec);
  return typeof r === 'string' ? 'DENY' : 'ALLOW';
};

// profile 基础配置（= cordis.patch.yml 的形态；shellScope 默认**关**，便于观察覆盖效果）
const PROFILE = {
  mode: 'enforce',
  probeDeny: [],
  probeReadOnlyNames: true,
  restrictMcpWriteTools: false,
  agentScope: { enabled: false, agentIds: [], role: 'reviewer' },
  roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'guard', serviceMissingPolicy: 'guard' },
  shellScope: { enabled: false, toolNames: ['pwsh'], allowPatterns: [] },
};
const TEAM = {
  's-reviewer': { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'reviewer-rt' },
  's-writer': { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'writer-rtl' },
};
const A = (id) => ({ id });
const Aws = (id, cwd) => ({ id, session: { id: `sess-${id}`, header: { cwd } } });

const TERMINAL_CMD = 'vivado.bat -mode batch';   // 命中 shellScope 的厂商模式
const mk = (agent) => ({ name: 'pwsh', arguments: { command: TERMINAL_CMD }, callId: 'x', ...(agent ? { agent } : {}) });

console.log('=== 1) ★ V6 核心：无工作区文件时，判定行为与「改动前」（agent 无 session.header）逐项一致 ===');
{
  const empty = mkws();     // 空目录 = 没有设置文件
  const matrix = [
    ['reviewer 调 MCP 写工具', { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: A('s-reviewer') }],
    ['writer 调 MCP 写工具', { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: A('s-writer') }],
    ['reviewer 调只读工具', { name: 'mcp__vivado__get_project_info', arguments: {}, callId: 'x', agent: A('s-reviewer') }],
    ['宿主级调用（无 agent）', { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x' }],
    ['reviewer 调 pwsh（shellScope 关）', mk(A('s-reviewer'))],
    ['宿主级调用 pwsh', mk(undefined)],
  ];
  const before = mount(PROFILE, TEAM);              // agent 无 session.header（等价改造前）
  const after = mount(PROFILE, TEAM);               // 同一 profile
  const gotBefore = matrix.map(([, exec]) => dec(before.guards, exec));
  // 改造后：agent 带 session.header.cwd（指向空工作区）
  const gotAfter = matrix.map(([, exec], i) => {
    const withCwd = exec.agent ? { ...exec, agent: Aws(exec.agent.id, empty) } : exec;
    return dec(after.guards, withCwd);
  });
  matrix.forEach(([what], i) => {
    check(`逐项一致：${what}`, gotBefore[i] === gotAfter[i], `改造前=${gotBefore[i]} 改造后=${gotAfter[i]}`);
  });
  check('★ 矩阵整体一致（无任何一条因拉取逻辑而改变）', gotBefore.join(',') === gotAfter.join(','), gotAfter.join(','));
  rmSync(empty, { recursive: true, force: true });
}

console.log('\n=== 2) 覆盖生效：工作区文件开 shellScope ⇒ 只读角色的厂商命令被拒 ===');
{
  const ws = mkws();
  const { guards } = mount(PROFILE, TEAM);
  const exec = mk(Aws('s-reviewer', ws));
  check('无文件 ⇒ 放行（shellScope 关，退回旧行为）', dec(guards, exec) === 'ALLOW');
  setWs(ws, { version: 1, 'role-guard': { shellScope: { enabled: true } } });
  check('★ 写文件后（**同一 apply，未重新挂载**）⇒ 被拒', dec(guards, exec) === 'DENY');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 3) ★ 即时生效：同一次 apply 内来回切（证明不是靠重新加载）===');
{
  const ws = mkws();
  const { guards } = mount(PROFILE, TEAM);
  const exec = mk(Aws('s-reviewer', ws));
  const seq = [];
  seq.push(dec(guards, exec));                                     // 无文件 ⇒ ALLOW
  setWs(ws, { version: 1, 'role-guard': { shellScope: { enabled: true } } });
  seq.push(dec(guards, exec));                                     // ⇒ DENY
  setWs(ws, { version: 1, 'role-guard': { shellScope: { enabled: false } } });
  seq.push(dec(guards, exec));                                     // ⇒ ALLOW
  setWs(ws, { version: 1, 'role-guard': { shellScope: { enabled: true } } });
  seq.push(dec(guards, exec));                                     // ⇒ DENY
  check('★ 序列 ALLOW→DENY→ALLOW→DENY，全程一次 apply', seq.join(',') === 'ALLOW,DENY,ALLOW,DENY', seq.join(','));
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 4) ★ P1：判据是 session cwd，不是 process.cwd() ===');
{
  const wsFile = mkws();    // 有设置文件
  const wsOther = mkws();   // 无设置文件
  setWs(wsFile, { version: 1, 'role-guard': { shellScope: { enabled: true } } });
  const { guards } = mount(PROFILE, TEAM);
  check('cwd 指向有文件的工作区 ⇒ 覆盖生效（DENY）', dec(guards, mk(Aws('s-reviewer', wsFile))) === 'DENY');
  check('cwd 指向别的工作区（无文件）⇒ profile（ALLOW）', dec(guards, mk(Aws('s-reviewer', wsOther))) === 'ALLOW');
  check('无会话 cwd ⇒ profile（ALLOW），不去读 process.cwd()', dec(guards, mk(A('s-reviewer'))) === 'ALLOW');
  check('宿主级调用（无 agent）⇒ profile（ALLOW）', dec(guards, mk(undefined)) === 'ALLOW');
  rmSync(wsFile, { recursive: true, force: true });
  rmSync(wsOther, { recursive: true, force: true });
}

console.log('\n=== 5) 覆盖 roleScope 的 policy 旋钮（unknownPolicy）===');
{
  const ws = mkws();
  const { guards } = mount(PROFILE, TEAM);
  // 's-stranger' 不是团队成员、无祖先 ⇒ 走「完全无责任链」分支 = unknownPolicy
  const exec = { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: Aws('s-stranger', ws) };
  check('profile unknownPolicy=guard ⇒ DENY', dec(guards, exec) === 'DENY');
  setWs(ws, { version: 1, 'role-guard': { roleScope: { unknownPolicy: 'pass' } } });
  check('★ 覆盖成 pass（同一 apply）⇒ ALLOW', dec(guards, exec) === 'ALLOW');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 6) P3 逐字段合并：只覆盖一个键，其余仍取自 profile ===');
{
  const ws = mkws();
  const { guards } = mount(PROFILE, TEAM);
  // 覆盖 roleScope.unknownPolicy=pass，但**不动** writerNamePatterns ⇒ writer 仍必须放行
  setWs(ws, { version: 1, 'role-guard': { roleScope: { unknownPolicy: 'pass' } } });
  check('覆盖后 writer 仍放行（writerNamePatterns 来自 profile）', dec(guards, { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: Aws('s-writer', ws) }) === 'ALLOW');
  check('覆盖后 reviewer 仍被拒（仍是只读角色）', dec(guards, { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: Aws('s-reviewer', ws) }) === 'DENY');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 7) 组合不变式：覆盖不得造成 shellScope=true + roleScope=false ===');
{
  const ws = mkws();
  // profile：shellScope **开**（为了让「工作区关 roleScope」非法）
  const profileShellOn = { ...PROFILE, shellScope: { enabled: true, toolNames: ['pwsh'], allowPatterns: [] } };
  const { guards, logs } = mount(profileShellOn, TEAM);
  const exec = mk(Aws('s-reviewer', ws));
  check('profile 下 shell 扫描生效 ⇒ DENY', dec(guards, exec) === 'DENY');
  setWs(ws, { version: 1, 'role-guard': { roleScope: { enabled: false } } });
  check('★ 非法组合 ⇒ **整份覆盖被弃用**（仍按 profile DENY，而不是因 roleScope 关掉而放行）',
    dec(guards, exec) === 'DENY', `实得 ${dec(guards, exec)}`);
  check('★ 且响亮记录（logs 含「组合非法」）', logs.some((l) => l.includes('组合非法')), JSON.stringify(logs.filter((l) => l.includes('工作区设置'))));
  // 反向：同一个文件只要同时关掉 shellScope 就合法 ⇒ 覆盖生效（放行）
  setWs(ws, { version: 1, 'role-guard': { roleScope: { enabled: false }, shellScope: { enabled: false } } });
  check('合法组合（两个都关）⇒ 覆盖生效（ALLOW）', dec(guards, exec) === 'ALLOW');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 8) P4 坏文件 / 异常写法：不炸、降级、响亮 ===');
{
  const ws = mkws();
  const { guards, logs } = mount(PROFILE, TEAM);
  const exec = mk(Aws('s-reviewer', ws));
  writeFileSync(join(ws, '.dsh-guard.json'), '{ not json at all', 'utf8');
  let threw = null;
  let out;
  try { out = dec(guards, exec); } catch (e) { threw = e; }
  check('坏文件不炸', threw === null, threw ? String(threw.message) : '');
  check('坏文件 ⇒ 降级为 profile（ALLOW）', out === 'ALLOW');
  check('★ 坏文件被响亮记录', logs.some((l) => l.includes('工作区设置')), JSON.stringify(logs.filter((l) => l.includes('工作区设置'))));

  // 点分当键名（写法不对）：不得静默生效
  writeFileSync(join(ws, '.dsh-guard.json'), JSON.stringify({ version: 1, 'role-guard': { 'shellScope.enabled': true } }), 'utf8');
  check('★ 点分当键名 ⇒ 不生效（ALLOW）且响亮', dec(guards, exec) === 'ALLOW'
    && logs.some((l) => l.includes('写法不对')), JSON.stringify(logs.filter((l) => l.includes('写法不对'))));

  // 枚举外取值：该键被丢、其余照常，且响亮
  writeFileSync(join(ws, '.dsh-guard.json'), JSON.stringify({ version: 1, 'role-guard': { roleScope: { unknownPolicy: 'deny' } } }), 'utf8');
  // 用「无责任链」的 stranger 才能观察到 unknownPolicy（pwsh + shellScope 关 ⇒ 恒 ALLOW，观察不到）
  const mcpStranger = { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: Aws('s-stranger', ws) };
  check('★ 枚举外取值 deny ⇒ 只丢该键、判定不变（stranger 仍按 profile 的 guard ⇒ DENY）且响亮',
    dec(guards, mcpStranger) === 'DENY' && logs.some((l) => l.includes('deny')),
    JSON.stringify(logs.filter((l) => l.includes('deny'))));
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 9) 判定绝不因设置读取而抛（fail-closed 方向不变）===');
{
  const { guards } = mount(PROFILE, TEAM);
  // 极端的坏 cwd（不存在的路径 / 非字符串 / 超长）
  for (const cwd of ['Z:\\definitely\\not\\here', 42, '', '   ']) {
    let threw = null;
    try { dec(guards, { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: { id: 's-reviewer', session: { header: { cwd } } } }); } catch (e) { threw = e; }
    check(`坏 cwd=${JSON.stringify(cwd)} 不抛`, threw === null, threw ? String(threw.message) : '');
  }
  check('坏 cwd 下 reviewer 仍被拒（不放行）', dec(guards, { name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: { id: 's-reviewer', session: { header: { cwd: 'Z:\\nope' } } } }) === 'DENY');
}

console.log(`\n${bad === 0 ? '✅ role-guard 工作区覆盖自测全部通过' : `❌ 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
