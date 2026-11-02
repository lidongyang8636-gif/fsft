#!/usr/bin/env node
/**
 * rule-router 自测（不碰真会话、不碰板卡、不调模型）
 *
 * 用**假 ctx + 假 agent** 驱动插件的真实代码路径，把三件事钉死：
 *   T1 managed agent 命中规则 → `switch`，且真的调了 `selectForNextRequest`
 *   T2 缓存 ≠ 实际（模拟用户在面板手选换回来）→ `hold` 必须报**实际**路由 + `drift:true`
 *   T3 显式指定模型的 agent → `skip-explicit-route`（不接管）
 *   T4 只有平台注入块（`runtime-context`）时 → **不产生**任何决策行
 *
 * 判据全部取**写出的 JSONL 内容**，不看内部变量 —— 与生产用同一份日志格式。
 */
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const mod = await import(pathToFileURL(join(WS, 'guards', 'rule-router', 'lib', 'index.js')).href);

const results = [];
const ok = (id, pass, info = '') => results.push({ id, pass: !!pass, info });

/* ── 假宿主 ────────────────────────────────────────────────────────────── */
function makeHarness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rr-'));
  const logPath = join(dir, 'decisions.jsonl');
  const created = [];
  const applied = [];
  const store = new Map(); // 假 AgentRegistry.store（key = sessionId）
  const DEFAULT = opts.default || { provider: 'deepseek-account', model: 'deepseek-flash' };

  const ctx = {
    on(ev, fn) { if (ev === 'agent/created') created.push(fn); return () => {}; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get(name) {
      if (name === 'llm') {
        return {
          resolveCallConfig: async (req) => ({ provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort }),
        };
      }
      if (name === 'sessionController') {
        return { agents: { selectForNextRequest: (agent, sel) => applied.push({ agent: agent.id, ...sel }) } };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...DEFAULT }) };
      if (name === 'agents') return { store }; // AgentRegistry
      return undefined;
    },
  };

  const applyOnce = (config = {}) => mod.apply(ctx, {
    mode: 'apply',
    rulesPath: join(WS, 'config', 'rule-router.json'),
    logPath,
    // ★ 2026-10-26：**测试必须自带模式文件**。插件默认用模块常量 WORKSPACE 解析
    //   `.rule-router/mode.json`（lib/index.js:86），而操作者可能正处在「让位」状态
    //   ⇒ 测试会读到真实的 mode=manual 并全程 yield，出现与代码无关的红。
    //   这里显式给临时目录的 auto 文件；绝对路径由 abs() 原样返回。
    manualOverride: { modeFile: join(dir, 'mode.json') },
    ...config,
  });
  writeFileSync(join(dir, 'mode.json'), '{"mode":"auto"}\n', 'utf8');
  applyOnce(opts.config);

  const mkAgent = (id, { provider, model, header } = {}) => {
    const listeners = { 'agent/pre-step': [], 'agent/request': [] };
    const agent = {
      id,
      options: { provider: provider ?? DEFAULT.provider, model: model ?? DEFAULT.model },
      session: {
        header: { id },
        requestHeader: () => (header === undefined ? undefined : { config: header }),
      },
      ctx: {
        on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; },
      },
      _listeners: listeners,
      /** 驱动一次 pre-step：payload.step + decision.messages */
      _preStep(step, messages) {
        const fn = listeners['agent/pre-step'][0];
        return fn({ agent, step }, async () => ({ kind: 'enter', messages }));
      },
      setHeader(cfg) { agent.session.requestHeader = () => ({ config: cfg }); },
    };
    return agent;
  };

  return { ctx, created, applied, logPath, mkAgent, DEFAULT, dir, store, applyOnce };
}

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', form: '' } });
const injected = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context', form: 'snapshot' } });
const readRows = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/* ── T1 + T2：managed agent，先 switch，再模拟手选换回 ───────────────────── */
{
  const h = makeHarness();
  const createdFn = h.created[0];
  const a = h.mkAgent('agent-managed');
  createdFn({ agent: a });

  await a._preStep(1, [userMsg('请读一下 verilog 文件')]);
  await new Promise((r) => setTimeout(r, 30));
  let rows = readRows(h.logPath).filter((r) => r.event === 'decision');
  ok('T1 switch', rows.length === 1 && rows[0].action === 'switch' && rows[0].model === '%PAYG_PROVIDER%2/gpt-6.1-sol',
    rows.length ? `${rows[0].action} ${rows[0].model}` : 'no row');
  ok('T1 真的调了 selectForNextRequest', h.applied.length === 1 && h.applied[0].model === 'gpt-6.1-sol',
    JSON.stringify(h.applied[0] || null));

  // 模拟用户手选换回 flash：header 变了，但插件缓存仍是 gpt-6.1-sol
  a.setHeader({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  await a._preStep(1, [userMsg('继续说')]);
  await new Promise((r) => setTimeout(r, 30));
  rows = readRows(h.logPath).filter((r) => r.event === 'decision');
  const last = rows[rows.length - 1];
  ok('T2 hold 报实际路由', last && last.action === 'hold' && last.model === 'deepseek-account/deepseek-flash',
    last ? `${last.action} ${last.model}` : 'no row');
  ok('T2 drift 标记', last && last.drift === true && last.cached_before === '%PAYG_PROVIDER%2/gpt-6.1-sol',
    last ? `drift=${last.drift} cached_before=${last.cached_before}` : 'no row');
  ok('T2 actual_source=header', last && last.actual_source === 'header', last?.actual_source);
}

/* ── T3：显式指定模型的 agent ────────────────────────────────────────────── */
{
  const h = makeHarness();
  h.created[0]({ agent: h.mkAgent('agent-explicit', { provider: '%PAYG_PROVIDER%2', model: 'gpt-5.6-terra' }) });
  const a = h.mkAgent('agent-explicit', { provider: '%PAYG_PROVIDER%2', model: 'gpt-5.6-terra' });
  // 重新走一遍：上面新建的 agent 没被 attach，重新用同一实例
  h.created[0]({ agent: a });
  await a._preStep(1, [userMsg('verilog')]);
  await new Promise((r) => setTimeout(r, 30));
  const rows = readRows(h.logPath).filter((r) => r.event === 'decision');
  const last = rows[rows.length - 1];
  ok('T3 skip-explicit-route', last && last.action === 'skip-explicit-route' && last.model === '%PAYG_PROVIDER%2/gpt-5.6-terra',
    last ? `${last.action} ${last.model}` : 'no row');
  ok('T3 没有落选（不接管）', h.applied.length === 0, `applied=${h.applied.length}`);
}

/* ── T4：只有注入块 ──────────────────────────────────────────────────────── */
{
  const h = makeHarness();
  const a = h.mkAgent('agent-injected');
  h.created[0]({ agent: a });
  await a._preStep(1, [injected('Current runtime context. This snapshot supersedes ... available ...')]);
  await new Promise((r) => setTimeout(r, 30));
  const rows = readRows(h.logPath).filter((r) => r.event === 'decision');
  ok('T4 注入块不算用户消息', rows.length === 0, `decisions=${rows.length}`);
}

/* ── T5：HMR 重载后补挂已存在的 agent ────────────────────────────────────── */
{
  const h = makeHarness();              // 第 1 次 apply（此时无活 agent）
  const a = h.mkAgent('agent-live');    // agent 在 apply **之后**才存在，且不经过 agent/created
  h.store.set('agent-live', a);         // 放进 AgentRegistry.store（模拟"重载时它已经活着"）

  h.applyOnce();                        // 第 2 次 apply = HMR 重载
  const attachRows = readRows(h.logPath).filter((r) => r.event === 'attach-live');
  const last = attachRows[attachRows.length - 1];
  ok('T5 扫描到活 agent', last && last.ok === true && last.scanned === 1 && last.attached === 1,
    last ? `scanned=${last.scanned} attached=${last.attached}` : 'no row');

  // 补挂是否真的生效：驱动一次 pre-step，应出现决策行
  await a._preStep(1, [userMsg('verilog')]);
  await new Promise((r) => setTimeout(r, 30));
  const dec = readRows(h.logPath).filter((r) => r.event === 'decision');
  ok('T5 补挂后能决策', dec.length >= 1 && dec[dec.length - 1].action === 'switch',
    dec.length ? `${dec[dec.length - 1].action} ${dec[dec.length - 1].model}` : 'no row');
}

/* ── T6：拿不到 agents 服务时必须响亮记录，不静默 ─────────────────────────── */
{
  const dir = mkdtempSync(join(tmpdir(), 'rr-'));
  const logPath = join(dir, 'decisions.jsonl');
  mod.apply({
    on() { return () => {}; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get() { return undefined; }, // 所有服务都拿不到
  }, { mode: 'apply', logPath, rulesPath: join(WS, 'config', 'rule-router.json') });
  const rows = readRows(logPath).filter((r) => r.event === 'attach-live');
  const last = rows[rows.length - 1];
  ok('T6 无服务时响亮记录', last && last.ok === false && last.note === 'no-agents-registry',
    last ? `ok=${last.ok} note=${last.note}` : 'no row');
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let fail = 0;
for (const r of results) {
  if (!r.pass) fail += 1;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.info ? `  — ${r.info}` : ''}\n`);
}
process.stdout.write(`RULE_ROUTER_SELFTEST: ${fail === 0 ? 'ALL PASS' : `${fail} FAIL`} (${results.length} checks)\n`);
process.exit(fail === 0 ? 0 : 1);
