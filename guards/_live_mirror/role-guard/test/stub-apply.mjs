/**
 * 用 stub ctx 把插件真正 apply 一遍 —— 验证「插件逻辑对不对」，与「DSH 有没有加载它」分开。
 *
 * 为什么要分：
 *   RT-02 在运行期 FAIL 了，但 FAIL 有两种根因：
 *     (a) 插件根本没被 Loader 加载（配置/路径问题）
 *     (b) 插件加载了，但 guard 拦不住工具（原理问题）
 *   本脚本把 (b) 排除掉：stub 一个最小 ctx，调 apply，然后**手工喂一个 exec** 给
 *   注册进来的 guard，看它是否按预期拒绝。
 *
 * 用法：node guards/role-guard/test/stub-apply.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href;

console.log('=== 1) 模块能否干净导入（导入期错误会让 Loader 加载失败）===');
let mod;
try {
  mod = await import(modUrl);
  console.log('   ✅ import OK');
} catch (e) {
  console.log('   ❌ import 失败：', e.message);
  if (e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
console.log('   exports =', Object.keys(mod).join(', '));
console.log('   name    =', mod.name);
console.log('   inject  =', JSON.stringify(mod.inject));
console.log('   typeof apply =', typeof mod.apply);
console.log('   Config schema 导出 =', mod.Config ?? mod.configSchema ?? '(无 —— Config 目录不会列它，正常)');

console.log('\n=== 2) stub ctx 跑 apply，验证 guard 逻辑 ===');
const guards = [];
const logs = [];

/**
 * 近似 Cordis 的 effect：**必须支持生成器（composite effect）**。
 * 插件用的是官方指引那种写法：
 *     ctx.effect(() => agent.ctx.effect(function* () { yield ...注册... }))
 * 生成器里的 yield 就是"注册 + 交出 disposer"。若 stub 不迭代生成器，
 * 这些注册会被静默跳过（本 stub 曾如此，导致 per-agent 路径测不到）。
 */
function runEffect(fn) {
  const ret = typeof fn === 'function' ? fn() : undefined;
  if (ret && typeof ret.next === 'function') {          // 生成器 / 迭代器
    const disposers = [];
    for (let r = ret.next(); !r.done; r = ret.next()) {
      if (typeof r.value === 'function') disposers.push(r.value);
    }
    return () => { for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } } };
  }
  return typeof ret === 'function' ? ret : () => {};
}

const stubCtx = {
  logger: () => ({
    info: (m) => logs.push(`INFO  ${m}`),
    warn: (m) => logs.push(`WARN  ${m}`),
    error: (m) => logs.push(`ERROR ${m}`),
  }),
  tools: {
    guard: (fn) => { guards.push(fn); return () => {}; },
    schemas: () => [
      { name: 'mcp__vivado__list_sessions' },
      { name: 'mcp__vivado__get_project_info' },
      { name: 'mcp__vivado__run_tcl' },
      { name: 'mcp__fpga-mcp__set_backend' },
      { name: 'read' },
    ],
    restrict: () => { throw new Error('本用例不该调 restrict'); },
  },
  effect: (fn) => runEffect(fn),
  on: () => {},
  get: () => undefined,
};
let applied = false;
try {
  mod.apply(stubCtx, {
    mode: 'dry-run',
    probeDeny: ['mcp__vivado__list_sessions'],
    probeReadOnlyNames: true,
    restrictMcpWriteTools: false,
    agentScope: { enabled: false, agentIds: [], role: 'reviewer' },
  });
  applied = true;
  console.log('   ✅ apply 未抛异常');
} catch (e) {
  console.log('   ❌ apply 抛异常：', e.message);
}
if (!applied) process.exit(1);

console.log(`   注册的 guard 数 = ${guards.length}`);
console.log('   --- 启动日志 ---');
for (const l of logs) console.log('     ' + l);

console.log('\n=== 3) 手工喂 exec，看 guard 判定 ===');
const cases = [
  ['mcp__vivado__list_sessions', true],   // 探针：即使 dry-run 也必须拒
  ['mcp__vivado__run_tcl', false],        // dry-run：只记录，不拒
  ['mcp__vivado__get_project_info', false],
  ['mcp__fpga-mcp__set_backend', false],
  ['read', false],
];
let bad = 0;
for (const [name, expectDeny] of cases) {
  const r = guards[0]({ name, arguments: {}, callId: 'x' });
  const denied = typeof r === 'string';
  const ok = denied === expectDeny;
  if (!ok) bad++;
  console.log(`   ${ok ? '✅' : '❌'} ${name}\n        → ${denied ? `拒绝：${r}` : '放行'}`);
}

console.log('\n=== 4) enforce 模式：全部推写工具都应被拒 ===');
guards.length = 0;
mod.apply(stubCtx, { mode: 'enforce', probeDeny: [], agentScope: { enabled: false } });
const enf = [
  ['mcp__vivado__list_sessions', false],
  ['mcp__vivado__get_project_info', false],
  ['mcp__vivado__run_tcl', true],
  ['mcp__fpga-mcp__set_backend', true],
  ['mcp__fpga-mcp__a_set_pin_location', true],
  ['read', false],
];
for (const [name, expectDeny] of enf) {
  const r = guards[0]({ name, arguments: {}, callId: 'x' });
  const denied = typeof r === 'string';
  const ok = denied === expectDeny;
  if (!ok) bad++;
  console.log(`   ${ok ? '✅' : '❌'} ${name}  →  ${denied ? '拒绝' : '放行'}`);
}

console.log('\n=== 5) 角色模式（roleScope）：谁被锁、谁被放行 ===');
// 造一个带 agentTeams 的 ctx：按 agent.id 返回团队身份
function ctxWithTeam(map, { service = true } = {}) {
  return {
    ...stubCtx,
    get: (k) => (k === 'agentTeams' && service
      ? { tryMembership: (agent) => map[agent?.id] }
      : undefined),
  };
}
const A = (id) => ({ id });
const agentTeamsMap = {
  's-lead': { root: A('s-lead'), id: 't', role: 'lead', name: 'lead' },
  's-reviewer': { root: A('s-lead'), id: 't', role: 'teammate', name: 'reviewer-rt' },
  's-writer': { root: A('s-lead'), id: 't', role: 'teammate', name: 'writer-rtl' },
  's-writer2': { root: A('s-lead'), id: 't', role: 'teammate', name: 'rtl-writer' },
  's-audit': { root: A('s-lead'), id: 't', role: 'teammate', name: 'audit-agent' },
};

// 期望值依据用户 2026-10-14 的四条决策：
//   Lead 也锁 / 只有 writer* 能写 / 身份未知放行 / 服务缺失按 guard
const roleCases = [
  // [说明, ctx, exec, 对 run_tcl 期望拒绝?]
  ['reviewer-rt 调 run_tcl → 拒绝', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl', agent: A('s-reviewer') }, true],
  ['audit-agent 调 run_tcl → 拒绝', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl', agent: A('s-audit') }, true],
  ['lead 调 run_tcl → 拒绝（Lead 也锁）', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl', agent: A('s-lead') }, true],
  ['writer-rtl 调 run_tcl → 放行（写手）', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl', agent: A('s-writer') }, false],
  ['rtl-writer 调 run_tcl → 放行（整词命中）', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl', agent: A('s-writer2') }, false],
  ['writer-rtl 调 program_device → 放行', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__program_device', agent: A('s-writer') }, false],
  ['非团队成员 调 run_tcl → 放行（身份未知）', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl', agent: A('s-stranger') }, false],
  ['无 agent 归属 调 run_tcl → 放行（身份未知）', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__run_tcl' }, false],
  ['reviewer 调 run_tcl 但服务缺失 → 拒绝（serviceMissingPolicy=guard）',
    ctxWithTeam(agentTeamsMap, { service: false }), { name: 'mcp__vivado__run_tcl', agent: A('s-reviewer') }, true],
  // 只读工具对任何角色都应放行
  ['reviewer 调 get_project_info → 放行（只读）', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__get_project_info', agent: A('s-reviewer') }, false],
  ['writer 调 get_project_info → 放行', ctxWithTeam(agentTeamsMap), { name: 'mcp__vivado__get_project_info', agent: A('s-writer') }, false],
];

for (const [what, ctx, exec, expectDeny] of roleCases) {
  guards.length = 0;
  mod.apply(ctx, {
    mode: 'enforce',
    probeDeny: [],
    roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'pass', serviceMissingPolicy: 'guard' },
    agentScope: { enabled: false },
  });
  const r = guards[0]({ arguments: {}, callId: 'x', ...exec });
  const denied = typeof r === 'string';
  const ok = denied === expectDeny;
  if (!ok) bad++;
  console.log(`   ${ok ? '✅' : '❌'} ${what}  →  ${denied ? '拒绝' : '放行'}`);
}

console.log('\n=== 6) 角色模式关闭时应等价于全局 enforce ===');
guards.length = 0;
mod.apply(ctxWithTeam(agentTeamsMap), { mode: 'enforce', probeDeny: [], roleScope: { enabled: false }, agentScope: { enabled: false } });
for (const [name, expectDeny] of [['mcp__vivado__run_tcl', true], ['mcp__vivado__get_project_info', false]]) {
  const r = guards[0]({ name, arguments: {}, callId: 'x', agent: A('s-writer') });
  const denied = typeof r === 'string';
  const ok = denied === expectDeny;
  if (!ok) bad++;
  console.log(`   ${ok ? '✅' : '❌'} ${name}（writer 也应被拦）→ ${denied ? '拒绝' : '放行'}`);
}

console.log('\n=== 9) 越权委托防护：子 agent 继承父角色（本轮最关键）===');
// 造一个带「创建链」的 ctx：agents.isOwnedBy(child, parent) 表示 child 由 parent 派生
function ctxWithTree(teamMap, edges, { service = true } = {}) {
  const ids = new Set([...Object.keys(teamMap), ...Object.values(edges).flat(), ...Object.keys(edges)]);
  const list = [...ids].map((id) => ({ id }));
  return {
    ...stubCtx,
    get: (k) => {
      if (k === 'agentTeams' && service) {
        return { tryMembership: (a) => teamMap[a?.id] };
      }
      if (k === 'agents') {
        return {
          list: () => list,
          isOwnedBy: (childId, owner) => (edges[childId] ?? []).includes(owner?.id),
        };
      }
      return undefined;
    },
  };
}
const teamOnly = {
  's-lead': { root: { id: 's-lead' }, id: 't', role: 'lead', name: 'lead' },
  's-rev': { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'reviewer-rt' },
  's-wri': { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'writer-rtl' },
};
// 创建链：lead → rev/wri；rev → rev-kid → rev-grand；wri → wri-kid
const tree = {
  's-rev': ['s-lead'],
  's-wri': ['s-lead'],
  's-rev-kid': ['s-rev'],
  's-rev-grand': ['s-rev-kid'],
  's-wri-kid': ['s-wri'],
};
const inheritCases = [
  // [说明, exec, 期望拒绝?]
  ['reviewer 本人 → 拒绝', { name: 'mcp__vivado__run_tcl', agent: A('s-rev') }, true],
  ['reviewer 的子 agent → 拒绝（越权委托防护）', { name: 'mcp__vivado__run_tcl', agent: A('s-rev-kid') }, true],
  ['reviewer 的孙 agent → 拒绝（多层）', { name: 'mcp__vivado__run_tcl', agent: A('s-rev-grand') }, true],
  ['writer 本人 → 放行（唯一可写情形）', { name: 'mcp__vivado__run_tcl', agent: A('s-wri') }, false],
  // ⚠ 2026-10-14 第二处修正：写权限**不可委派**。
  //   曾实现成"角色继承"⇒ writer 的子 agent 可写 ⇒ 单一 writer 纪律失效。
  ['★ writer 的子 agent → 拒绝（写不可委派）', { name: 'mcp__vivado__run_tcl', agent: A('s-wri-kid') }, true],
  ['无责任链的孤儿 agent → 拒绝（默认 guard）', { name: 'mcp__vivado__run_tcl', agent: A('s-orphan') }, true],
  ['无 agent 归属 → 拒绝（默认 guard）', { name: 'mcp__vivado__run_tcl' }, true],
  ['reviewer 子 agent 调只读工具 → 放行', { name: 'mcp__vivado__get_project_info', agent: A('s-rev-kid') }, false],
  ['writer 子 agent 调只读工具 → 放行', { name: 'mcp__vivado__get_project_info', agent: A('s-wri-kid') }, false],
];
for (const [what, exec, expectDeny] of inheritCases) {
  guards.length = 0;
  mod.apply(ctxWithTree(teamOnly, tree), {
    mode: 'enforce', probeDeny: [],
    roleScope: { enabled: true, writerNamePatterns: ['writer'] },   // 不传 unknownPolicy ⇒ 用默认值
    agentScope: { enabled: false },
  });
  const r = guards[0]({ arguments: {}, callId: 'x', ...exec });
  const denied = typeof r === 'string';
  const ok = denied === expectDeny;
  if (!ok) bad++;
  console.log(`   ${ok ? '✅' : '❌'} ${what}  →  ${denied ? '拒绝' : '放行'}`);
}

console.log('\n=== 10) 写不可委派：即便 unknownPolicy=pass 也拦得住写手子 agent ===');
{
  guards.length = 0;
  mod.apply(ctxWithTree(teamOnly, tree), {
    mode: 'enforce', probeDeny: [],
    // 故意把旋钮拧到最松：写手子 agent 仍必须被拦（因为祖先存在就钉死 enforce）
    roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'pass', serviceMissingPolicy: 'pass' },
    agentScope: { enabled: false },
  });
  const cases = [
    ['writer 的子 agent + 最松旋钮 → 仍拒绝', { name: 'mcp__vivado__run_tcl', agent: A('s-wri-kid') }, true],
    ['writer 本人 + 最松旋钮 → 放行', { name: 'mcp__vivado__run_tcl', agent: A('s-wri') }, false],
  ];
  for (const [what, exec, expectDeny] of cases) {
    const r = guards[0]({ arguments: {}, callId: 'x', ...exec });
    const denied = typeof r === 'string';
    const ok = denied === expectDeny;
    if (!ok) bad++;
    console.log(`   ${ok ? '✅' : '❌'} ${what}  →  ${denied ? '拒绝' : '放行'}`);
  }
}

console.log('\n=== 11) agentScope 加固层：不得拖垮主闸门（补测试盲区）===');
{
  // 这次盲区导致真事故：`lookupAgents is not defined` 让 apply 抛异常
  // ⇒ Loader 回滚 guard 注册 ⇒ **角色主闸门整块失效**。
  // 下面这几个断言就是为了让这种回归再也溜不过去。
  const makeActx = () => {
    const calls = { guard: 0, restrict: 0, restrictFilter: null };
    return {
      calls,
      tools: {
        guard: () => { calls.guard++; return () => {}; },
        restrict: (f) => { calls.restrict++; calls.restrictFilter = f; return () => {}; },
        schemas: () => [
          { name: 'mcp__vivado__run_tcl' },
          { name: 'mcp__vivado__get_project_info' },
        ],
      },
      effect: (fn) => runEffect(fn),
    };
  };
  const withCtx = makeActx();
  const teamMap11 = { 's-rev': { root: { id: 's-rev' }, id: 't', role: 'teammate', name: 'reviewer-rt' } };
  const ctx11 = {
    ...stubCtx,
    on: () => {},
    get: (k) => {
      if (k === 'agentTeams') return { tryMembership: (a) => teamMap11[a?.id] };
      if (k === 'agents') {
        return {
          list: () => [{ id: 's-rev', ctx: withCtx }, { id: 's-nocontext' }],
          isOwnedBy: () => false,
        };
      }
      return undefined;
    },
  };

  let threw = null;
  try {
    guards.length = 0;
    mod.apply(ctx11, {
      mode: 'enforce', probeDeny: [],
      restrictMcpWriteTools: true,          // ← 同时又开加固层
      agentScope: { enabled: true, agentIds: [], role: 'reviewer' },
      roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'guard', serviceMissingPolicy: 'guard' },
    });
  } catch (e) { threw = e; }

  const checks = [
    ['apply 不抛异常（加固层失败也要被 try/catch 兜住）', threw === null],
    ['主闸门仍然注册（guards 数 = 1）', guards.length === 1],
    ['有 agent.ctx 的 agent 装上了 per-agent guard', withCtx.calls.guard === 1],
    ['该 agent 同时被 restrict 遮蔽', withCtx.calls.restrict === 1],
    ['restrict 的 deny 只含 MCP 写工具', Array.isArray(withCtx.calls.restrictFilter?.deny)
      && withCtx.calls.restrictFilter.deny.includes('mcp__vivado__run_tcl')
      && !withCtx.calls.restrictFilter.deny.includes('mcp__vivado__get_project_info')],
  ];
  for (const [what, pass] of checks) {
    if (!pass) bad++;
    console.log(`   ${pass ? '✅' : '❌'} ${what}`);
  }
  if (threw) console.log(`        抛错原文：${threw.message.slice(0, 140)}`);

  // 反向：即便 agent.ctx 缺失，也绝不能抛（缺了只跳过）
  let threw2 = null;
  try {
    guards.length = 0;
    mod.apply(ctxWithTree(teamOnly, tree), {
      mode: 'enforce', probeDeny: [],
      restrictMcpWriteTools: false,
      agentScope: { enabled: true, agentIds: [], role: 'reviewer' },
      roleScope: { enabled: true, writerNamePatterns: ['writer'] },
    });
  } catch (e) { threw2 = e; }
  const ok2 = threw2 === null && guards.length === 1;
  if (!ok2) bad++;
  console.log(`   ${ok2 ? '✅' : '❌'} 无 agent.ctx 时只跳过、不抛，主闸门仍注册`);
}

console.log('\n=== 7) 配置自检：restrict 不再静默失效 ===');
{
  let threw = null;
  try {
    guards.length = 0;
    mod.apply(ctxWithTeam(agentTeamsMap), {
      mode: 'enforce',
      restrictMcpWriteTools: true,          // ← 设了
      agentScope: { enabled: false },      // ← 但承载它的路径关着
      roleScope: { enabled: true },
    });
  } catch (e) { threw = e; }
  const ok = threw !== null && /restrictMcpWriteTools/.test(String(threw.message));
  if (!ok) bad++;
  console.log(`   ${ok ? '✅' : '❌'} restrictMcpWriteTools=true 且 agentScope 关闭 → 应加载失败`);
  if (threw) console.log(`        抛错原文：${threw.message.slice(0, 120)}…`);
}

console.log('\n=== 8) 事件日志（JSONL）：把判定写进可读文件 ===');
{
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rg-evt-'));
  const file = join(dir, 'events.jsonl');
  guards.length = 0;
  // ⚠ 必须用带「创建链」的 ctx：否则子 agent 查不到祖先，会落到 unknownPolicy，
  //   那是另一个分支（本用例要验的是 deny 去重键含调用者）。
  mod.apply(ctxWithTree(teamOnly, tree), {
    mode: 'enforce', probeDeny: [], eventLog: file,
    roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'pass', serviceMissingPolicy: 'guard' },
    agentScope: { enabled: false },
  });
  guards[0]({ name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: A('s-rev') });
  guards[0]({ name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: A('s-wri') });
  guards[0]({ name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x' });   // 无 agent + unknownPolicy=pass ⇒ 角色 skip
  guards[0]({ name: 'mcp__vivado__get_project_info', arguments: {}, callId: 'x', agent: A('s-rev') }); // 只读白名单
  // 再来一个**同工具不同调用者**的拒绝：验证去重键含调用者（否则第二条不入档）
  guards[0]({ name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: A('s-wri-kid') });
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const kinds = lines.map((l) => l.event);
  const checks = [
    ['plugin-start', kinds.includes('plugin-start')],
    ['deny 且 caller=reviewer-rt', lines.some((l) => l.event === 'deny' && l.caller?.name === 'reviewer-rt')],
    ['allow 且 hasAgent=false（身份未知 + pass 角色放行留痕）', lines.some((l) => l.event === 'allow' && l.hasAgent === false)],
    // ⚠ 取证关键：两条放行来源必须可区分（此前硬编码 verdict 会把它们混为一谈）
    ['allow 的 source 如实记为 roleSkip（写手/策略放行）',
      lines.some((l) => l.event === 'allow' && l.source === 'roleSkip')],
    ['allow 的 source 如实记为 readonlyWhitelist（只读白名单放行）',
      lines.some((l) => l.event === 'allow' && l.source === 'readonlyWhitelist')],
    // ⚠ 取证关键：同一工具被不同角色拒绝时，两条都要入档
    ['同工具不同调用者的拒绝都入档（reviewer + writer 子 agent）',
      lines.filter((l) => l.event === 'deny' && l.tool === 'mcp__vivado__run_tcl').length >= 2
      && lines.some((l) => l.event === 'deny' && l.caller?.childOf === true)],
  ];
  for (const [what, pass] of checks) {
    if (!pass) bad++;
    console.log(`   ${pass ? '✅' : '❌'} ${what}`);
  }
  console.log(`        写入 ${lines.length} 行：${kinds.join(', ')}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 12) 方案 A：shell 面减速带（只读角色禁调厂商/烧板工具）===');
{
  // 背景：2026-10-14 实测 CONFIRMED —— 只读子会话能跑 pwsh、能看见 vivado.bat，
  // 而 decide() 此前对非 MCP **显式放行**，这条路径无人管。
  const mk = (teamMap) => ({
    ...stubCtx,
    on: () => {},
    get: (k) => (k === 'agentTeams' ? { tryMembership: (a) => teamMap[a?.id] } : undefined),
  });
  const teamMap = {
    's-rev': { root: { id: 's-rev' }, id: 't', role: 'teammate', name: 'reviewer-rt' },
    's-wri': { root: { id: 's-wri' }, id: 't', role: 'teammate', name: 'writer-rtl' },
  };
  const apply12 = (cfg = {}) => {
    guards.length = 0;
    mod.apply(mk(teamMap), {
      mode: 'enforce', probeDeny: [],
      roleScope: { enabled: true, writerNamePatterns: ['writer'],
        unknownPolicy: 'guard', serviceMissingPolicy: 'guard' },
      shellScope: { enabled: true },
      ...cfg,
    });
    return guards[0];
  };
  const call = (g, name, command, agent) =>
    g({ name, arguments: { command }, callId: 'x', ...(agent ? { agent: A(agent) } : {}) });
  const D = (s) => typeof s === 'string' && s.length > 0;
  const check = (what, pass) => {
    if (!pass) bad++;
    console.log(`   ${pass ? '✅' : '❌'} ${what}`);
  };

  const g = apply12();
  // 只读角色 + 厂商/烧板命令 ⇒ 拒
  check('只读角色 `vivado.bat` 被拒', D(call(g, 'pwsh', "& 'G:\\vivado\\Vivado\\2019.1\\bin\\vivado.bat' -mode batch", 's-rev')));
  check('只读角色 `program_hw_devices` 被拒', D(call(g, 'pwsh', 'vivado -mode tcl -source x.tcl  # program_hw_devices', 's-rev')));
  check('只读角色 `quartus_pgm` 被拒', D(call(g, 'pwsh', 'quartus_pgm -c USB-Blaster foo.sof', 's-rev')));
  check('只读角色 `openocd` 被拒', D(call(g, 'bash', 'openocd -f board.cfg', 's-rev')));
  // 只读角色 + 无害命令 ⇒ 放行
  check('只读角色 `echo shell-ok` 放行', call(g, 'pwsh', 'echo shell-ok', 's-rev') === undefined);
  check('只读角色读日志 `Get-Content vivado.log` 放行（刻意不匹配裸 vivado）',
    call(g, 'pwsh', 'Get-Content vivado.log -Tail 20', 's-rev') === undefined);
  // 写手本人 ⇒ 不扫（与 MCP 口径一致：写手可写可执行）
  check('写手本人 `vivado.bat` 放行（roleSkip）',
    call(g, 'pwsh', "& 'vivado.bat' -mode batch", 's-wri') === undefined);
  // 身份未知 + unknownPolicy=guard ⇒ 视为只读 ⇒ 拒（fail-closed）
  check('身份未知（无 agent）`vivado.bat` 被拒（unknownPolicy=guard）',
    D(call(g, 'pwsh', "& 'vivado.bat' -mode batch")));
  // 非 shell 工具不受影响
  check('非 shell 非 MCP 工具仍放行（nonMcp）', g({ name: 'read', arguments: { file_path: 'x' }, callId: 'x' }) === undefined);
  // 关掉 shellScope ⇒ 恢复旧行为（只读角色也能跑 shell）
  const gOff = apply12({ shellScope: { enabled: false } });
  check('shellScope 关闭时恢复旧行为（放行）',
    call(gOff, 'pwsh', "& 'vivado.bat' -mode batch", 's-rev') === undefined);

  // 配置纪律：enabled 但 roleScope 关闭 ⇒ 拒绝加载（不得静默失效）
  let threw12 = null;
  try {
    guards.length = 0;
    mod.apply(mk(teamMap), { mode: 'enforce', shellScope: { enabled: true }, roleScope: { enabled: false } });
  } catch (e) { threw12 = e; }
  check('shellScope 开但 roleScope 关 ⇒ 拒绝加载（不静默失效）',
    threw12 !== null && /shellScope/.test(String(threw12.message)));

  // allowPatterns 逃生门
  const gAllow = apply12({ shellScope: { enabled: true, allowPatterns: ['test-path'] } });
  check('allowPatterns 命中 ⇒ 放行（逃生门）',
    call(gAllow, 'pwsh', "Test-Path 'G:\\vivado\\Vivado\\2019.1\\bin\\vivado.bat'", 's-rev') === undefined);

  // ── 面 2：串口写＝物理致动（2026-10-14 追加，用户要求）────────────────────
  // 依据：send_0_to_f.ps1 的实测记录写明「会驱动电机输出」；取证 ≠ 驱动。
  check('★ 只读角色 `-SendHex`（串口发命令）被拒',
    D(call(g, 'pwsh', "capture_serial.ps1 -PortName COM8 -SendHex '01' -Repeat 12", 's-rev')));
  check('★ 只读角色 `send_0_to_f.ps1`（驱动脚本）被拒',
    D(call(g, 'pwsh', 'pwsh -File scripts/send_0_to_f.ps1 -PortName COM3', 's-rev')));
  check('★ 只读角色 `live_brake`（主动制动）被拒',
    D(call(g, 'pwsh', 'pwsh -File live_brake.ps1 -PortName COM8', 's-rev')));
  check('★ 只读角色 `live_sweep`（扫频）被拒',
    D(call(g, 'pwsh', 'pwsh -File live_sweep.ps1 -PortName COM8', 's-rev')));
  check('★ 复合规则：SerialPort…Write 被拒',
    D(call(g, 'pwsh', '$p=New-Object System.IO.Ports.SerialPort COM8; $p.Write($b,0,1)', 's-rev')));
  // ★ 关键负例：被动监听必须仍可用（否则串口取证被误杀）
  check('★ 被动监听 `capture_serial.ps1`（无 -SendHex）**放行**',
    call(g, 'pwsh', 'pwsh -File scripts/capture_serial.ps1 -PortName COM8 -Seconds 120', 's-rev') === undefined);
  check('★ 被动监听 `live_listen.ps1` **放行**',
    call(g, 'pwsh', 'pwsh -File live_listen.ps1 -PortName COM8 -Seconds 30', 's-rev') === undefined);
  check('★ 枚举串口 `GetPortNames()` **放行**',
    call(g, 'pwsh', '[System.IO.Ports.SerialPort]::GetPortNames()', 's-rev') === undefined);
  check('只有 `.Write(` 无 SerialPort 上下文 → 不命中（复合规则不误伤）',
    call(g, 'pwsh', 'something.Write(1)', 's-rev') === undefined);
}

console.log(bad === 0 ? '\n✅ stub 验证全部通过：插件逻辑本身没问题' : `\n❌ ${bad} 条不符`);
process.exitCode = bad === 0 ? 0 : 1;
