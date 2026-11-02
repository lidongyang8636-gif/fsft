#!/usr/bin/env node
/**
 * manual-override 自测 —— 「用户手选 ⟹ 路由器让位 ⟹ 显式接管」。
 *
 * 为什么要它（2026-10-21 用户原话）：「role-route 会拉我的选择，我选了东西它也要卡我」
 * 旧插件（@neptune810/dsh-model-router）有 yieldOnManual；我们这份当时**没有**，
 * 于是手选会在下一次 pre-step 被规则拉回。本用例锁死这条语义。
 *
 * 判据全部取写出的 JSONL 与 `applied` 记录，不看内部变量：
 *   M1 规则命中 ⟹ 真的切换（基线）
 *   M2 投影出现 pending 手选 ⟹ **不切换**，写 `router-yield reason=manual-pick`
 *   M3 写 mode.json {"mode":"auto"} ⟹ 恢复切换，写 `router-resume`
 *   M4 mode.json {"mode":"manual"} ⟹ 强制让位（无需 pending）
 *   M5 取不到投影 ⟹ **不猜**（仍按规则切换）
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const mod = await import(pathToFileURL(join(WS, 'guards', 'rule-router', 'lib', 'index.js')).href);

const results = [];
const ok = (id, pass, info = '') => results.push({ id, pass: !!pass, info });
const readRows = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', form: '' } });

function makeHarness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rrm-'));
  const logPath = join(dir, 'decisions.jsonl');
  const modeFile = join(dir, 'mode.json');
  const applied = [];
  const created = [];
  const DEFAULT = { provider: 'deepseek-account', model: 'deepseek-flash' };
  const projections = { modelSelection: undefined }; // undefined = 投影不可用

  const ctx = {
    on(ev, fn) { if (ev === 'agent/created') created.push(fn); return () => {}; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get(name) {
      if (name === 'llm') return { resolveCallConfig: async (r) => ({ provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort }) };
      if (name === 'sessionController') return { agents: { selectForNextRequest: (a, sel) => applied.push({ agent: a.id, ...sel }) } };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...DEFAULT }) };
      if (name === 'agents') return { store: new Map() };
      if (name === 'sessionProjections' && opts.withProjections) {
        return { stateOf: (_session, key) => (key === 'modelSelection' ? projections.modelSelection : undefined) };
      }
      return undefined;
    },
  };

  mod.apply(ctx, {
    mode: 'apply',
    rulesPath: join(WS, 'config', 'rule-router.json'),
    logPath,
    manualOverride: { yieldOnManual: true, modeFile },
    ...opts.config,
  });

  const mkAgent = (id) => {
    const listeners = { 'agent/pre-step': [], 'agent/request': [] };
    const agent = {
      id,
      options: { ...DEFAULT },
      session: { header: { id }, requestHeader: () => undefined },
      ctx: { on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; } },
      _preStep(step, messages) {
        const fn = listeners['agent/pre-step'][0];
        return fn({ agent, step }, async () => ({ kind: 'enter', messages }));
      },
    };
    return agent;
  };

  return { dir, logPath, modeFile, applied, created, mkAgent, projections };
}

// ── M1/M2：规则命中 → 手选 → 让位
{
  const h = makeHarness({ withProjections: true });
  const agent = h.mkAgent('s-manual');
  h.created.forEach((fn) => fn({ agent }));
  await agent._preStep(1, [userMsg('请读一下 verilog 文件')]);
  const first = h.applied.at(-1);
  ok('M1 规则命中会切换（基线）', first?.model === 'gpt-6.1-sol', `applied=${JSON.stringify(first || null)}`);

  // 用户在 composer 手选 deepseek-flash（与路由目标不同）⟹ pending
  h.projections.modelSelection = { lastUsed: { provider: '%PAYG_PROVIDER%2', model: 'gpt-6.1-sol' }, pending: { provider: 'deepseek-account', model: 'deepseek-flash' } };
  const before = h.applied.length;
  await agent._preStep(2, [userMsg('继续')]);
  const yielded = readRows(h.logPath).filter((r) => r.event === 'router-yield').at(-1);
  const yieldDec = readRows(h.logPath).filter((r) => r.event === 'decision').at(-1);
  ok('M2 手选后不再切换', h.applied.length === before, `before=${before} after=${h.applied.length}`);
  ok('M2b 写出 router-yield(manual-pick)', yielded?.reason === 'manual-pick', `reason=${yielded?.reason ?? 'none'}`);
  ok('M2c decision 标 action=yield', yieldDec?.action === 'yield', `action=${yieldDec?.action ?? 'none'}`);

  // ── M3：显式接管（mode.json = auto）
  writeFileSync(h.modeFile, '{"mode":"auto"}\n', 'utf8');
  await agent._preStep(3, [userMsg('继续')]);
  const resumed = readRows(h.logPath).filter((r) => r.event === 'router-resume').at(-1);
  ok('M3 mode=auto 会恢复路由', resumed?.reason === 'mode-file-auto', `reason=${resumed?.reason ?? 'none'}`);
}

// ── M4：mode.json = manual ⟹ 无需 pending 也强制让位
{
  const h = makeHarness({ withProjections: true });
  writeFileSync(h.modeFile, '{"mode":"manual"}\n', 'utf8');
  const agent = h.mkAgent('s-forced');
  h.created.forEach((fn) => fn({ agent }));
  await agent._preStep(1, [userMsg('请读一下 verilog 文件')]);
  const yielded = readRows(h.logPath).filter((r) => r.event === 'router-yield').at(-1);
  ok('M4 mode=manual 强制让位且不切换', yielded?.reason === 'manual-file' && h.applied.length === 0,
    `reason=${yielded?.reason ?? 'none'} applied=${h.applied.length}`);
}

// ── M5：取不到投影 ⟹ 不猜（仍按规则切换）
{
  const h = makeHarness({ withProjections: false });
  const agent = h.mkAgent('s-noproj');
  h.created.forEach((fn) => fn({ agent }));
  await agent._preStep(1, [userMsg('请读一下 verilog 文件')]);
  const yields = readRows(h.logPath).filter((r) => r.event === 'router-yield').length;
  ok('M5 无投影时不误判让位', h.applied.length === 1 && yields === 0, `applied=${h.applied.length} yield=${yields}`);
}

let fail = 0;
for (const r of results) {
  if (!r.pass) fail += 1;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.info ? `  — ${r.info}` : ''}\n`);
}
process.stdout.write(`MANUAL_OVERRIDE_SELFTEST: ${fail === 0 ? 'ALL PASS' : `${fail} FAIL`} (${results.length} checks)\n`);
process.exit(fail === 0 ? 0 : 1);
