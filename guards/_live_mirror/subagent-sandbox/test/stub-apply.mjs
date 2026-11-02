/**
 * 阶段 0 探针的离线自检：用 stub ctx 验证分支与"不伤主功能"的铁律。
 * 不需要 DSH、不需要重启。
 *
 * 用法：node guards/subagent-sandbox/test/stub-apply.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** 造一个 stub ctx：可控的 permissionPresets / agents / agentTeams / agent/created 派发 */
function makeCtx({ presets = {}, agents = [], known = new Set(['fpga-locked']), setThrows = null, teamMap = {} } = {}) {
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
          set: (session, name) => {
            if (setThrows) throw new Error(setThrows);
            setCalls.push({ sessionId: session?.id, name });
            presets[session?.id] = name;
          },
        };
      }
      if (k === 'agents') {
        return {
          list: () => agents,
          isOwnedBy: (childId, owner) => (owner?.children ?? []).includes(childId),
        };
      }
      if (k === 'agentTeams') {
        return { tryMembership: (a) => teamMap[a?.id] };
      }
      return undefined;
    },
    _listeners: listeners,
    _setCalls: setCalls,
    _logs: logs,
  };
  return ctx;
}

console.log('=== 1) 模块与导出 ===');
console.log('   exports =', Object.keys(mod).join(', '));
check('name 正确', mod.name === 'subagent-sandbox');
check('inject 为空（无硬依赖）', Array.isArray(mod.inject) && mod.inject.length === 0);

console.log('\n=== 2) observe 模式：只看不写 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' } };
  const ctx = makeCtx({ agents: [lead], presets: { 's-lead': 'workspace-write' } });
  mod.apply(ctx, { mode: 'observe', eventLog: file });
  ctx._listeners[0]({ agent: lead, source: 'startup' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('写了 probe-start', lines.some((l) => l.event === 'probe-start'));
  check('写了 startup 快照', lines.some((l) => l.event === 'roster-snapshot' && l.trigger === 'startup'));
  check('写了 agent-created 且记录了档位', lines.some((l) => l.event === 'agent-created' && l.presetBefore === 'workspace-write'));
  check('observe 模式**没有**调用 set', ctx._setCalls.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 3) set 模式：只落子会话，父不动（E5） ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-child'] };
  const child = { id: 's-child', session: { id: 's-child' } };
  const ctx = makeCtx({
    agents: [lead, child],
    presets: { 's-lead': 'workspace-write', 's-child': 'workspace-write' },
  });
  mod.apply(ctx, { mode: 'set', preset: 'fpga-locked', eventLog: file });
  // 父自己创建事件（不是子）：应被 onlyChildren 跳过
  ctx._listeners[0]({ agent: lead, source: 'startup' });
  // 子创建事件：应落档
  ctx._listeners[0]({ agent: child, source: 'startup' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const applied = lines.find((l) => l.event === 'set-applied');
  check('对子会话落档成功', !!applied);
  check('落档后回读 = fpga-locked（E2 前半）', applied?.presetAfter === 'fpga-locked');
  check('父会话档位未变（E5）', applied?.parentPresetBefore === applied?.parentPresetAfter
    && applied?.parentUnchanged === true);
  check('父自己**没有**被落档', !ctx._setCalls.some((c) => c.sessionId === 's-lead'));
  check('写了 skip-not-child 记录', lines.some((l) => l.event === 'skip-not-child'));
  check('落档后打了 roster 快照', lines.some((l) => l.event === 'roster-snapshot' && l.trigger === 'after-set'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 4) 挂载期**绝不 throw**（阶段 0 第一次跑就栽在这）+ 预设名坏掉的正确行为 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-kid'] };
  const kid = { id: 's-kid', session: { id: 's-kid' } };
  const ctx = makeCtx({ known: new Set(['fpga-locked']), agents: [lead, kid] });
  let threw = null;
  try {
    // 预设名不存在 + 严格模式：**挂载期不得抛**
    mod.apply(ctx, { mode: 'set', preset: 'no-such-preset', strictPreset: true, eventLog: file });
  } catch (e) { threw = e; }
  check('挂载期不抛（曾因"启动预检太早"炸掉自己 ⇒ 监听器从未注册）', threw === null);
  const startupLines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('写了 listener-registered 且 ok=true', startupLines.some((l) => l.event === 'listener-registered' && l.ok === true));
  check('写了 startup 快照（加载成功的判据）', startupLines.some((l) => l.event === 'roster-snapshot' && l.trigger === 'startup'));

  // 第一次真要用到预设时才预检 → 坏名 ⇒ 响亮记录 + 跳过落档，且**不抛**（抛会让子代理创建失败）
  let boom = null;
  try { ctx._listeners[0]({ agent: kid, source: 'startup' }); } catch (e) { boom = e; }
  check('惰性预检失败时派发不抛（不得炸掉子代理创建）', boom === null);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('记了 preset-invalid', lines.some((l) => l.event === 'preset-invalid'));
  check('记了 skip-invalid-preset', lines.some((l) => l.event === 'skip-invalid-preset'));
  check('坏名时**没有**调用 set', ctx._setCalls.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 4b) 正常预设名：惰性预检通过并落档 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-kid2'] };
  const kid = { id: 's-kid2', session: { id: 's-kid2' } };
  const ctx = makeCtx({ known: new Set(['fpga-locked']), agents: [lead, kid],
    presets: { 's-lead': 'workspace-write', 's-kid2': 'workspace-write' } });
  mod.apply(ctx, { mode: 'set', preset: 'fpga-locked', eventLog: file });
  ctx._listeners[0]({ agent: kid, source: 'startup' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('记了 preset-ok', lines.some((l) => l.event === 'preset-ok'));
  check('落档成功', lines.some((l) => l.event === 'set-applied' && l.presetAfter === 'fpga-locked'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 4c) 上下文没有 ctx.on ⇒ 注册失败要可见（不静默） ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const ctx = makeCtx({});
  delete ctx.on;
  let threw = null;
  try { mod.apply(ctx, { mode: 'set', eventLog: file }); } catch (e) { threw = e; }
  check('无 ctx.on 时不抛', threw === null);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('listener-registered 记 ok=false（失败可见）',
    lines.some((l) => l.event === 'listener-registered' && l.ok === false));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 5) 子会话无 session / set 抛错 ⇒ 只记录，不抛 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-nosession', 's-throws'] };
  const noSession = { id: 's-nosession' };
  const throws = { id: 's-throws', session: { id: 's-throws' } };
  const ctx = makeCtx({ agents: [lead, noSession, throws], setThrows: 'unknown names throw' });
  mod.apply(ctx, { mode: 'set', preset: 'fpga-locked', eventLog: file });
  let boom = null;
  try {
    ctx._listeners[0]({ agent: noSession, source: 'startup' });
    ctx._listeners[0]({ agent: throws, source: 'startup' });
  } catch (e) { boom = e; }
  check('派发过程不抛（探针不得影响会话）', boom === null);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('无 session ⇒ skip-no-session', lines.some((l) => l.event === 'skip-no-session'));
  check('set 抛错 ⇒ set-failed 入档', lines.some((l) => l.event === 'set-failed'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 6) 阶段 1：写手豁免（且写权限不可委派） ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-writer', 's-reviewer', 's-wkid'] };
  const writer = { id: 's-writer', session: { id: 's-writer' } };
  const reviewer = { id: 's-reviewer', session: { id: 's-reviewer' } };
  const wkid = { id: 's-wkid', session: { id: 's-wkid' }, };      // 写手的子代理
  const teamMap = {
    's-writer': { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'writer-rtl' },
    's-reviewer': { root: { id: 's-lead' }, id: 't', role: 'teammate', name: 'reviewer-rt' },
  };
  const ctx = makeCtx({
    agents: [lead, writer, reviewer, wkid], teamMap,
    presets: { 's-lead': 'workspace-write', 's-writer': 'workspace-write',
      's-reviewer': 'custom', 's-wkid': 'workspace-write' },
  });
  mod.apply(ctx, { mode: 'set', preset: 'fpga-locked', writerExempt: true,
    writerNamePatterns: ['writer'], eventLog: file });
  ctx._listeners[0]({ agent: writer, source: 'startup' });
  ctx._listeners[0]({ agent: reviewer, source: 'startup' });
  ctx._listeners[0]({ agent: wkid, source: 'startup' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const wSet = ctx._setCalls.some((c) => c.sessionId === 's-writer');
  const rSet = ctx._setCalls.some((c) => c.sessionId === 's-reviewer');
  const kSet = ctx._setCalls.some((c) => c.sessionId === 's-wkid');
  check('写手成员**豁免**（未被落档）', !wSet);
  check('记了 skip-writer-exempt', lines.some((l) => l.event === 'skip-writer-exempt'));
  check('审查者成员**被落档**', rSet);
  check('★ 写手的子代理**仍被落档**（写权限不可委派）', kSet);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 7) 豁免语义按 role-guard 同一套规则（走真实豁免路径）===');
{
  // 逐名验证：命中写手模式者豁免；近似名（rewriter）**不得**误豁免
  // 注意：前缀匹配是**设计如此**（用户口径"只有 writer* 能写"）⇒ 'writerx' 也豁免。
  //   真正的反例是 'rewriter'（writer 出现在词中而非词首）。
  const cases = [
    ['writer-rtl', true], ['rtl-writer', true], ['writer', true], ['writerx', true],
    ['rewriter', false], ['reviewer-rt', false], ['lead', false],
  ];
  for (const [name, shouldExempt] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const file = join(dir, 'ev.jsonl');
    const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-x'] };
    const x = { id: 's-x', session: { id: 's-x' } };
    const ctx = makeCtx({
      agents: [lead, x], teamMap: { 's-x': { id: 't', role: 'teammate', name } },
      presets: { 's-lead': 'workspace-write', 's-x': 'workspace-write' },
    });
    mod.apply(ctx, { mode: 'set', preset: 'fpga-locked', writerExempt: true, eventLog: file });
    ctx._listeners[0]({ agent: x, source: 'startup' });
    const exempted = !ctx._setCalls.some((c) => c.sessionId === 's-x');
    check(`「${name}」→ ${shouldExempt ? '豁免' : '被落档'}`, exempted === shouldExempt);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n=== 8) 路 A：配置规范化（别名 / 未知键 / 非法值 / 额外豁免名）===');
{
  // 别名：老配置 preset 仍可用，且**不抛**
  const r1 = mod.normalizeConfig({ mode: 'set', preset: 'fpga-locked' });
  check('preset 别名 → childPreset', r1.cfg.childPreset === 'fpga-locked');
  check('别名用法产生告警（建议改用 childPreset）',
    r1.warnings.some((w) => w.includes('兼容别名')));

  // 两者冲突：以 childPreset 为准
  const r2 = mod.normalizeConfig({ childPreset: 'a', preset: 'b' });
  check('冲突时以 childPreset 为准', r2.cfg.childPreset === 'a');
  check('冲突产生告警', r2.warnings.some((w) => w.includes('冲突')));

  // 未知键（拼错）：可见但不阻断
  const r3 = mod.normalizeConfig({ mode: 'set', chldPreset: 'typo' });
  check('未知键产生告警', r3.warnings.some((w) => w.includes('chldPreset')));
  check('未知键不抛、不污染 childPreset', r3.cfg.childPreset === 'fpga-locked');

  // 非法 mode：回退 observe
  const r4 = mod.normalizeConfig({ mode: 'SET' });
  check('非法 mode 回退 observe', r4.cfg.mode === 'observe');
  check('非法 mode 产生告警', r4.warnings.some((w) => w.includes('非法')));

  // 空 childPreset：回退默认
  const r5 = mod.normalizeConfig({ childPreset: '   ' });
  check('空 childPreset 回退 fpga-locked', r5.cfg.childPreset === 'fpga-locked');

  // 规范化**绝不 throw**（挂载期抛异常 = 插件不加载）
  let boom = null;
  try { mod.normalizeConfig({ mode: 5, childPreset: {}, writerNamePatterns: 'nope' }); } catch (e) { boom = e; }
  check('极端输入也不抛（含类型错乱）', boom === null);

  // 额外豁免名：audit-* 豁免
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const file = join(dir, 'ev.jsonl');
  const lead = { id: 's-lead', session: { id: 's-lead' }, children: ['s-a', 's-r'] };
  const audit = { id: 's-a', session: { id: 's-a' } };
  const rev = { id: 's-r', session: { id: 's-r' } };
  const ctx = makeCtx({
    agents: [lead, audit, rev],
    teamMap: { 's-a': { id: 't', role: 'teammate', name: 'audit-rtl' },
      's-r': { id: 't', role: 'teammate', name: 'reviewer-rt' } },
    presets: { 's-lead': 'workspace-write', 's-a': 'workspace-write', 's-r': 'workspace-write' },
  });
  mod.apply(ctx, { mode: 'set', childPreset: 'fpga-locked', writerExempt: true,
    exemptNamePatterns: ['audit'], eventLog: file });
  ctx._listeners[0]({ agent: audit, source: 'startup' });
  ctx._listeners[0]({ agent: rev, source: 'startup' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('audit-rtl 被 exemptNamePatterns 豁免',
    !ctx._setCalls.some((c) => c.sessionId === 's-a'));
  check('记了 skip-name-exempt 且 matchedBy 正确',
    lines.some((l) => l.event === 'skip-name-exempt' && l.matchedBy === 'exemptNamePatterns'));
  check('reviewer-rt 仍被落档', ctx._setCalls.some((c) => c.sessionId === 's-r'));
  check('probe-start 记了 effectiveConfig 与 configWarnings',
    lines.some((l) => l.event === 'probe-start' && l.effectiveConfig && Array.isArray(l.configWarnings)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 9) 命名→档位 规则表（Auto 的确定性替代）===');
{
  const mk = (rules, extra = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const file = join(dir, 'ev.jsonl');
    const lead = { id: 's-lead', session: { id: 's-lead' },
      children: ['s-w', 's-r', 's-sim', 's-other', 's-kid'] };
    const agents = [{ id: 's-w', session: { id: 's-w' } }, { id: 's-r', session: { id: 's-r' } },
      { id: 's-sim', session: { id: 's-sim' } }, { id: 's-other', session: { id: 's-other' } },
      { id: 's-kid', session: { id: 's-kid' } }];
    const teamMap = {
      's-w': { id: 't', role: 'teammate', name: 'writer-rtl' },
      's-r': { id: 't', role: 'teammate', name: 'reviewer-rt' },
      's-sim': { id: 't', role: 'teammate', name: 'sim-rtl' },
      's-other': { id: 't', role: 'teammate', name: 'audit-rtl' },
      // s-kid 无 membership ⇒ 子代理
    };
    const presets = { 's-lead': 'workspace-write' };
    for (const a of ['s-w', 's-r', 's-sim', 's-other', 's-kid']) presets[a] = 'workspace-write';
    // ⚠ stub 的 resolve() 只认 known 里的档名；不含 workspace-write 会被判"坏档名"而跳过
    const ctx = makeCtx({ agents: [lead, ...agents], teamMap, presets,
      known: new Set(['fpga-locked', 'workspace-write']) });
    mod.apply(ctx, { mode: 'set', childPreset: 'fpga-locked', writerExempt: true,
      childPresetRules: rules, eventLog: file, ...extra });
    return { ctx, file };
  };
  const run = (ctx, ids) => { for (const id of ids) ctx._listeners[0]({ agent: { id, session: { id } }, source: 'startup' }); };
  const readLines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // 规则表：writer→豁免；sim→workspace-write；其余→fpga-locked
  const rules = [
    { namePatterns: ['writer'], preset: null },
    { namePatterns: ['sim'], preset: 'workspace-write' },
    { namePatterns: ['reviewer', 'audit'], preset: 'fpga-locked' },
  ];
  const { ctx, file } = mk(rules);
  run(ctx, ['s-w', 's-r', 's-sim', 's-other', 's-kid']);
  const lines = readLines(file);
  const setOf = (id) => ctx._setCalls.find((c) => c.sessionId === id)?.name;
  check('writer 命中规则①（preset=null）⇒ 豁免', !ctx._setCalls.some((c) => c.sessionId === 's-w'));
  check('reviewer 命中规则③ ⇒ 钉 fpga-locked', setOf('s-r') === 'fpga-locked');
  check('★ sim 命中规则② ⇒ 被钉 workspace-write（**每角色不同档**）', setOf('s-sim') === 'workspace-write');
  check('audit 命中规则③（多模式并存）⇒ fpga-locked', setOf('s-other') === 'fpga-locked');
  check('★ 子代理（非成员）⇒ 用默认 childPreset（不被规则表影响）', setOf('s-kid') === 'fpga-locked');
  check('落档事件记了 presetChosenBy（可审计）',
    lines.some((l) => l.event === 'set-applied' && /childPresetRules\[2\]/.test(l.presetChosenBy ?? '')));
  // ⚠ writerExempt 优先级高于规则表（设计如此）⇒ 规则豁免要用**非写手名**来验
  const { ctx: ctxR, file: fileR } = mk([{ namePatterns: ['audit'], preset: null }]);
  run(ctxR, ['s-other']);
  const lR = readLines(fileR);
  check('★ 规则 preset=null ⇒ 豁免，且记 skip-rule-exempt（与写手豁免可区分）',
    !ctxR._setCalls.some((c) => c.sessionId === 's-other')
    && lR.some((l) => l.event === 'skip-rule-exempt'));
  check('写手豁免优先于规则表（writerExempt 命中即停，不进规则）',
    lines.some((l) => l.event === 'skip-writer-exempt')
    && !lines.some((l) => l.event === 'set-applied' && l.memberName === 'writer-rtl'));

  // 按序求值、首个命中生效
  const { ctx: ctx2 } = mk([{ namePatterns: ['sim'], preset: 'workspace-write' },
    { namePatterns: ['sim-rtl'], preset: 'fpga-locked' }]);
  run(ctx2, ['s-sim']);
  check('规则**按序**求值：首个命中生效（第二条同名字段被忽略）',
    ctx2._setCalls.find((c) => c.sessionId === 's-sim')?.name === 'workspace-write');

  // 坏档名：只跳该档，其余照常
  const { ctx: ctx3, file: file3 } = mk([{ namePatterns: ['sim'], preset: 'no-such-preset' }]);
  run(ctx3, ['s-sim', 's-r']);
  const l3 = readLines(file3);
  check('坏档名 ⇒ 记 preset-invalid', l3.some((l) => l.event === 'preset-invalid' && l.preset === 'no-such-preset'));
  check('坏档名的成员被跳过（skip-invalid-preset）', l3.some((l) => l.event === 'skip-invalid-preset'));
  check('★ 坏档名**不影响其它档**（reviewer 仍落 fpga-locked）',
    ctx3._setCalls.find((c) => c.sessionId === 's-r')?.name === 'fpga-locked');

  // 规范化：坏条目被丢弃并告警，绝不 throw
  const r9 = mod.normalizeConfig({ childPresetRules: [
    { namePatterns: ['a'], preset: 'x' }, { namePatterns: [] }, { preset: 'y' },
    { namePatterns: ['b'], preset: 123 },
  ] });
  check('坏规则被丢弃（只剩 1 条有效）', r9.cfg.childPresetRules.length === 1);
  check('坏规则有告警', r9.warnings.filter((w) => w.includes('childPresetRules')).length >= 3);
  let boom9 = null;
  try { mod.normalizeConfig({ childPresetRules: 'not-an-array' }); } catch (e) { boom9 = e; }
  check('childPresetRules 类型错乱也不抛', boom9 === null);
}

console.log(bad === 0 ? '\n✅ 探针离线自检全部通过' : `\n❌ ${bad} 条不符`);
process.exitCode = bad === 0 ? 0 : 1;
