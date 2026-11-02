/**
 * subagent-sandbox × 每工作区设置（guard-ui P1，PLAN §9.1 裁决 D-A：拉取式）离线自测。
 *
 * 覆盖本轮**最关键回归**：
 *   · V6  无工作区文件时，判定行为须与改动前**逐项一致**（比对完整事件序列，去掉时间戳）
 *   · P1  判据是 `agent.session.header.cwd`，**绝不回落 process.cwd()**
 *   · P2  改文件后**不重新 apply** 也立即生效
 *   · P3  逐字段合并（只覆盖 childPreset 时 mode 仍来自 profile）
 *   · P4  坏文件不炸、降级、响亮
 *
 * 用法：node guards/subagent-sandbox/test/workspace-override.mjs
 * 只写系统 temp，绝不写工作区根（那是本会话活护栏的工作区根）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const mkws = () => mkdtempSync(join(tmpdir(), 'sb-ws-'));
const tmpEv = () => join(mkdtempSync(join(tmpdir(), 'sb-ev-')), 'ev.jsonl');
const setWs = (cwd, payload) => writeFileSync(join(cwd, '.dsh-guard.json'), JSON.stringify(payload), 'utf8');
const readEvents = (file) => readFileSync(file, 'utf8').trim().split('\n')
  .filter(Boolean).map((l) => JSON.parse(l))
  .map(({ t, ...rest }) => rest);   // 去掉时间戳才好逐项比对

/** 造 stub ctx（与 stub-apply.mjs 同形，但 agent 可带 session.header.cwd） */
function makeCtx({ presets = {}, agents = [], known = new Set(['fpga-locked', 'workspace-write']), teamMap = {} } = {}) {
  const listeners = [];
  const setCalls = [];
  const logs = [];
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(`INFO ${m}`),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    }),
    on: (name, fn) => { if (name === 'agent/created') listeners.push(fn); },
    get: (k) => {
      if (k === 'permissionPresets') {
        return {
          resolve: (n) => { if (!known.has(n)) throw new Error(`unknown preset ${n}`); return { name: n }; },
          catalog: () => [...known],
          current: (session) => presets[session?.id] ?? 'custom',
          set: (session, name) => { setCalls.push({ sessionId: session?.id, name }); presets[session?.id] = name; },
        };
      }
      if (k === 'agents') return { list: () => agents, isOwnedBy: (c, o) => (o?.children ?? []).includes(c) };
      if (k === 'agentTeams') return { tryMembership: (a) => teamMap[a?.id] };
      return undefined;
    },
    _listeners: listeners,
    _setCalls: setCalls,
    _logs: logs,
  };
  return ctx;
}

const PROFILE_OBSERVE = { mode: 'observe', childPreset: 'fpga-locked', onlyChildren: true, strictPreset: true };

console.log('=== 1) ★ V6 核心：无工作区文件时，事件序列与「改动前」（agent 无 session.header）逐项一致 ===');
{
  const empty = mkws();
  const run = (withCwd) => {
    const ev = tmpEv();
    const lead = withCwd ? { id: 's-lead', session: { id: 's-lead', header: { cwd: empty } }, children: ['s-child'] } : { id: 's-lead', session: { id: 's-lead' }, children: ['s-child'] };
    const child = withCwd ? { id: 's-child', session: { id: 's-child', header: { cwd: empty } } } : { id: 's-child', session: { id: 's-child' } };
    const ctx = makeCtx({ agents: [lead, child], presets: { 's-lead': 'workspace-write', 's-child': 'workspace-write' }, eventLog: ev });
    mod.apply(ctx, { ...PROFILE_OBSERVE, eventLog: ev });
    ctx._listeners[0]({ agent: lead, source: 'startup' });
    ctx._listeners[0]({ agent: child, source: 'startup' });
    const all = readEvents(ev);
    // 拆两路：① 「判定相关」事件序列（去掉新增溯源字段 + 去掉 F2 新增的响亮事件）
    //          ② F2 新增的响亮事件计数（它**应该**只在「有 agent 但缺 cwd」那一路出现）
    const loud = all.filter((e) => e.event === 'workspace-settings-problem');
    const events = all
      .filter((e) => e.event !== 'workspace-settings-problem')
      .map((e) => { const { settingsSource, settingsReason, settingsCwd, ...rest } = e; return rest; });
    return { events, loud, setCalls: ctx._setCalls };
  };
  const before = run(false);   // agent 无 session.header（= 改造前的形态）
  const after = run(true);     // agent 有 session.header.cwd 指向空工作区
  check('★ 事件序列（含新增的 settings* 溯源字段）逐项一致',
    JSON.stringify(before.events) === JSON.stringify(after.events),
    `before=${before.events.length} after=${after.events.length}`);
  check('★ 落档调用逐项一致（observe ⇒ 都是 0 次）',
    JSON.stringify(before.setCalls) === JSON.stringify(after.setCalls), JSON.stringify(after.setCalls));
  // ★ 红队 F2：无 cwd 的那一路**必须**多出一条响亮事件（此前是静默的）
  check('★ F2：无 cwd ⇒ 恰好多出 1 条 agent-cwd-missing 响亮事件（不再静默）',
    before.loud.length === 1 && before.loud[0].reason === 'agent-cwd-missing',
    `loud=${JSON.stringify(before.loud.map((l) => l.reason))}`);
  check('★ F2：有 cwd 且无文件 ⇒ 不产生响亮事件（常态，P4）', after.loud.length === 0);
  if (JSON.stringify(before.events) !== JSON.stringify(after.events)) {
    for (let i = 0; i < Math.max(before.events.length, after.events.length); i += 1) {
      const a = JSON.stringify(before.events[i]); const b = JSON.stringify(after.events[i]);
      if (a !== b) console.log(`      [${i}] before=${a}\n          after =${b}`);
    }
  }
  rmSync(empty, { recursive: true, force: true });
}

console.log('\n=== 2) 覆盖生效：profile observe ⇒ 工作区 set 后子会话被落档（同一 apply）===');
{
  const ws = mkws();
  const ev = tmpEv();
  const lead = { id: 's-lead', session: { id: 's-lead', header: { cwd: ws } }, children: ['s-child', 's-child2'] };
  const child1 = { id: 's-child', session: { id: 's-child', header: { cwd: ws } } };
  const child2 = { id: 's-child2', session: { id: 's-child2', header: { cwd: ws } } };
  const ctx = makeCtx({ agents: [lead, child1, child2], presets: { 's-lead': 'workspace-write', 's-child': 'workspace-write', 's-child2': 'workspace-write' } });
  mod.apply(ctx, { ...PROFILE_OBSERVE, eventLog: ev });

  ctx._listeners[0]({ agent: child1, source: 'startup' });
  check('无文件 ⇒ profile observe ⇒ 不落档', ctx._setCalls.length === 0);

  setWs(ws, { version: 1, 'subagent-sandbox': { mode: 'set', childPreset: 'fpga-locked' } });
  ctx._listeners[0]({ agent: child2, source: 'startup' });
  const line = readEvents(ev).filter((e) => e.event === 'set-applied').pop();
  check('★ 写文件后（**同一 apply**）⇒ 落档成功且 presetAfter=fpga-locked',
    ctx._setCalls.length === 1 && line?.presetAfter === 'fpga-locked', JSON.stringify(ctx._setCalls));
  check('★ 事件里如实标了来源（settingsSource=workspace）',
    readEvents(ev).some((e) => e.settingsSource === 'workspace' && e.settingsReason === 'ok'));
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 3) ★ 即时生效：同一次 apply 内 set→off→set 来回切 ===');
{
  const ws = mkws();
  const ev = tmpEv();
  const kids = ['k1', 'k2', 'k3'].map((id) => ({ id, session: { id, header: { cwd: ws } } }));
  const lead = { id: 's-lead', session: { id: 's-lead', header: { cwd: ws } }, children: kids.map((k) => k.id) };
  const ctx = makeCtx({ agents: [lead, ...kids], presets: Object.fromEntries([['s-lead', 'workspace-write'], ...kids.map((k) => [k.id, 'workspace-write'])]) });
  mod.apply(ctx, { ...PROFILE_OBSERVE, eventLog: ev });

  const fire = (k) => ctx._listeners[0]({ agent: k, source: 'startup' });
  setWs(ws, { version: 1, 'subagent-sandbox': { mode: 'set' } });
  fire(kids[0]);
  const n1 = ctx._setCalls.length;
  setWs(ws, { version: 1, 'subagent-sandbox': { mode: 'off' } });
  fire(kids[1]);
  const n2 = ctx._setCalls.length;
  setWs(ws, { version: 1, 'subagent-sandbox': { mode: 'set' } });
  fire(kids[2]);
  const n3 = ctx._setCalls.length;
  check('★ set⇒落档 / off⇒不落档 / set⇒再落档，全程一次 apply（计数 1,1,2）',
    n1 === 1 && n2 === 1 && n3 === 2, `实得 ${n1},${n2},${n3}`);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 4) ★ P1：判据是 session cwd，不是 process.cwd() ===');
{
  const wsFile = mkws();
  const wsOther = mkws();
  const ev = tmpEv();
  setWs(wsFile, { version: 1, 'subagent-sandbox': { mode: 'set' } });
  const mkChild = (id, cwd) => (cwd ? { id, session: { id, header: { cwd } } } : { id, session: { id } });
  const c1 = mkChild('c-file', wsFile);
  const c2 = mkChild('c-other', wsFile === wsOther ? wsOther : wsOther);
  const c3 = mkChild('c-nocwd', null);
  const kids = [c1, c2, c3];
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: kids.map((k) => k.id) };
  const ctx = makeCtx({ agents: [lead, ...kids], presets: Object.fromEntries(kids.map((k) => [k.id, 'workspace-write'])) });
  mod.apply(ctx, { ...PROFILE_OBSERVE, eventLog: ev });
  ctx._listeners[0]({ agent: c1, source: 'startup' });
  const afterFile = ctx._setCalls.map((s) => s.sessionId);
  ctx._listeners[0]({ agent: c2, source: 'startup' });
  const afterOther = ctx._setCalls.map((s) => s.sessionId);
  ctx._listeners[0]({ agent: c3, source: 'startup' });
  const afterNoCwd = ctx._setCalls.map((s) => s.sessionId);
  check('cwd 指向有文件的工作区 ⇒ 落档', afterFile.join() === 'c-file', afterFile.join());
  check('cwd 指向别的工作区（无文件）⇒ profile observe ⇒ 不落档', afterOther.join() === 'c-file', afterOther.join());
  check('★ 无会话 cwd ⇒ profile observe ⇒ 不落档（绝不读 process.cwd()）', afterNoCwd.join() === 'c-file', afterNoCwd.join());
  rmSync(wsFile, { recursive: true, force: true });
  rmSync(wsOther, { recursive: true, force: true });
}

console.log('\n=== 5) P3 逐字段合并：只覆盖 childPreset 时 mode 仍来自 profile ===');
{
  const ws = mkws();
  const ev = tmpEv();
  const kid = { id: 'k', session: { id: 'k', header: { cwd: ws } } };
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['k'] };
  const ctx = makeCtx({ agents: [lead, kid], presets: { k: 'workspace-write' } });
  mod.apply(ctx, { ...PROFILE_OBSERVE, mode: 'set', childPreset: 'fpga-locked', eventLog: ev });
  setWs(ws, { version: 1, 'subagent-sandbox': { childPreset: 'workspace-write' } });
  ctx._listeners[0]({ agent: kid, source: 'startup' });
  check('★ mode 来自 profile（仍落档）+ childPreset 来自工作区（workspace-write）',
    ctx._setCalls.length === 1 && ctx._setCalls[0].name === 'workspace-write', JSON.stringify(ctx._setCalls));
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 6) P4 坏文件：不炸、降级、响亮 ===');
{
  const ws = mkws();
  const ev = tmpEv();
  const kid = { id: 'k', session: { id: 'k', header: { cwd: ws } } };
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['k'] };
  const ctx = makeCtx({ agents: [lead, kid], presets: { k: 'workspace-write' } });
  mod.apply(ctx, { ...PROFILE_OBSERVE, mode: 'set', childPreset: 'fpga-locked', eventLog: ev });
  writeFileSync(join(ws, '.dsh-guard.json'), '{ nope', 'utf8');
  let threw = null;
  try { ctx._listeners[0]({ agent: kid, source: 'startup' }); } catch (e) { threw = e; }
  check('坏文件不炸', threw === null, threw ? String(threw.message) : '');
  check('坏文件 ⇒ 降级 profile（仍落档）', ctx._setCalls.length === 1);
  const problems = readEvents(ev).filter((e) => e.event === 'workspace-settings-problem');
  check('★ 坏文件被响亮记录（事件里可见）', problems.length === 1 && problems[0].cwd === ws, JSON.stringify(problems));
  check('★ 且同一条只吼一次（P2 每次重读 ⇒ 去重器防刷屏）',
    readEvents(ev).filter((e) => e.event === 'workspace-settings-problem').length === 1);
  // 再触发一次：同一坏文件，不应再记第二条
  ctx._listeners[0]({ agent: { id: 'k2', session: { id: 'k', header: { cwd: ws } } }, source: 'startup' });
  check('★ 第二次触发仍只有一条（日志去重，不是取值缓存）',
    readEvents(ev).filter((e) => e.event === 'workspace-settings-problem').length === 1);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 7) writerExempt 覆盖（团队成员豁免）===');
{
  const ws = mkws();
  const ev = tmpEv();
  const kid = { id: 'wk', session: { id: 'wk', header: { cwd: ws } } };
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['wk'] };
  const teamMap = { wk: { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'writer-x' } };
  const ctx = makeCtx({ agents: [lead, kid], presets: { wk: 'workspace-write' }, teamMap });
  mod.apply(ctx, { ...PROFILE_OBSERVE, mode: 'set', childPreset: 'fpga-locked', writerExempt: false, eventLog: ev });
  s1: {
    ctx._listeners[0]({ agent: kid, source: 'startup' });
    check('profile writerExempt=false ⇒ 写手成员也被钉', ctx._setCalls.length === 1);
  }
  setWs(ws, { version: 1, 'subagent-sandbox': { writerExempt: true } });
  const before = ctx._setCalls.length;
  ctx._listeners[0]({ agent: kid, source: 'startup' });
  check('★ 覆盖 writerExempt=true（同一 apply）⇒ 豁免、不再落档',
    ctx._setCalls.length === before
    && readEvents(ev).some((e) => e.event === 'skip-writer-exempt' && e.name === 'writer-x'));
  rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${bad === 0 ? '✅ subagent-sandbox 工作区覆盖自测全部通过' : `❌ 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
