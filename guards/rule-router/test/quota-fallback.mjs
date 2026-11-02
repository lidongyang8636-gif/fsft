#!/usr/bin/env node
/**
 * quota-fallback 自测 —— 402 额度超限后的按量兜底（不碰真会话、不调模型）
 *
 * 判据（全部取写出的 JSONL，不看内部变量）：
 *   Q1 `next()` 抛 402 ⟹ 写出 `quota-exhausted` 行，且**原错误照原样抛回**
 *   Q2 之后的一次 pre-step ⟹ 路由到 fallback 的 provider/model/effort，decision.rule='quota-fallback'
 *   Q3 fallback 的 **effort 是手写的**（来自配置，不继承原档位）
 *   Q4 非 402 错误 ⟹ **不**触发兜底，也不写 quota-exhausted
 *   Q5 TTL 过期后 ⟹ 恢复按规则路由（不再 quota-fallback）
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const mod = await import(pathToFileURL(join(WS, 'guards', 'rule-router', 'lib', 'index.js')).href);

const results = [];
const ok = (id, pass, info = '') => results.push({ id, pass: !!pass, info });
const readRows = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const FALLBACK = { provider: '%PAYG_PROVIDER%', model: 'gpt-6-luna', effort: 'medium' };

function makeHarness(quotaFallback, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rrq-'));
  const logPath = join(dir, 'decisions.jsonl');
  const created = [];
  const applied = [];
  const DEFAULT = { provider: 'deepseek-account', model: 'deepseek-flash' };
  /** opts.rejectEffort：模拟上游/校验器拒绝某个档位（用于验证"降级为不带 effort"） */
  const rejectEffort = opts.rejectEffort ?? null;
  const ctx = {
    on(ev, fn) { if (ev === 'agent/created') created.push(fn); return () => {}; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get(name) {
      if (name === 'llm') {
        return {
          resolveCallConfig: async (r) => {
            if (rejectEffort && r.reasoningEffort === rejectEffort) throw new Error(`unsupported effort: ${r.reasoningEffort}`);
            return { provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort };
          },
        };
      }
      if (name === 'sessionController') return { agents: { selectForNextRequest: (a, sel) => applied.push({ agent: a.id, ...sel }) } };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...DEFAULT }) };
      if (name === 'agents') return { store: new Map() };
      return undefined;
    },
  };
  // ★ 2026-10-26：隔离模式文件（理由同 smoke.mjs）——插件按模块常量 WORKSPACE 读
  //   `.rule-router/mode.json`，操作者「让位」时会让本测试全程 yield（why=yielded:manual-file）。
  writeFileSync(join(dir, 'mode.json'), '{"mode":"auto"}\n', 'utf8');
  mod.apply(ctx, {
    mode: 'apply', rulesPath: join(WS, 'config', 'rule-router.json'), logPath, quotaFallback,
    manualOverride: { modeFile: join(dir, 'mode.json') },
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
      async _request(payload, err) {
        const fn = listeners['agent/request'][0];
        return fn(payload, async () => { if (err) throw err; return { ok: true }; });
      },
    };
    return agent;
  };
  return { created, applied, logPath, mkAgent, ctx };
}

const userMsg = (t) => ({ role: 'user', content: [{ type: 'text', text: t }], source: { kind: 'user', form: '' } });

// ── Q1/Q2/Q3：402 → 兜底路由 + 手写 effort
{
  const h = makeHarness({ enabled: true, statusCodes: [402], ...FALLBACK, ttlMs: 60_000 });
  const agent = h.mkAgent('s-quota');
  h.created.forEach((fn) => fn({ agent }));

  const err = Object.assign(new Error('payment required'), { status: 402 });
  let rethrown = null;
  try { await agent._request({ step: 1 }, err); } catch (e) { rethrown = e; }
  ok('Q1 402 触发 quota-exhausted 且原错误抛回', rethrown === err,
    `rethrown=${rethrown ? rethrown.message : 'none'}`);

  const quotaRows = readRows(h.logPath).filter((r) => r.event === 'quota-exhausted');
  ok('Q1b 写出 quota-exhausted 行', quotaRows.length === 1 && quotaRows[0].status === 402,
    JSON.stringify(quotaRows[0] || null));

  // 之后的一次 pre-step：应走兜底
  const before = h.applied.length;
  await agent._preStep(2, [userMsg('你好，随便聊聊')]);
  const decisionRows = readRows(h.logPath).filter((r) => r.event === 'decision');
  const last = decisionRows.at(-1);
  ok('Q2 后续请求路由到 %PAYG_PROVIDER%2 按量档',
    h.applied.length > before && h.applied.at(-1).provider === FALLBACK.provider && h.applied.at(-1).model === FALLBACK.model,
    JSON.stringify(h.applied.at(-1) || null));
  ok('Q3 思考挡位是手写的 medium', h.applied.at(-1)?.reasoningEffort === FALLBACK.effort,
    `effort=${h.applied.at(-1)?.reasoningEffort}`);
  ok('Q2b 审计行标明 quota-fallback', last?.rule === 'quota-fallback', `rule=${last?.rule} why=${last?.why}`);
}

// ── Q4：非 402 不触发
{
  const h = makeHarness({ enabled: true, statusCodes: [402], ...FALLBACK, ttlMs: 60_000 });
  const agent = h.mkAgent('s-other');
  h.created.forEach((fn) => fn({ agent }));
  const err = Object.assign(new Error('boom'), { status: 500 });
  try { await agent._request({ step: 1 }, err); } catch { /* expected */ }
  const quotaRows = readRows(h.logPath).filter((r) => r.event === 'quota-exhausted');
  ok('Q4 非 402 不触发兜底', quotaRows.length === 0, `rows=${quotaRows.length}`);
}

// ── Q5：TTL 过期后恢复
{
  const h = makeHarness({ enabled: true, statusCodes: [402], ...FALLBACK, ttlMs: 40 });
  const agent = h.mkAgent('s-ttl');
  h.created.forEach((fn) => fn({ agent }));
  const err = Object.assign(new Error('payment required'), { status: 402 });
  try { await agent._request({ step: 1 }, err); } catch { /* expected */ }
  await new Promise((r) => setTimeout(r, 80));
  const before = h.applied.length;
  await agent._preStep(2, [userMsg('你好')]);
  const applied = h.applied.at(-1);
  ok('Q5 TTL 过期后不再走兜底', h.applied.length === before || applied?.provider !== FALLBACK.provider,
    `applied=${JSON.stringify(applied || null)}`);
}

// ── Q6：兜底档位被上游拒绝 ⟹ 降级为**不带 effort**（而不是整轮失败）
{
  const h = makeHarness(
    { enabled: true, statusCodes: [402], ...FALLBACK, ttlMs: 60_000 },
    { rejectEffort: FALLBACK.effort },
  );
  const agent = h.mkAgent('s-drop');
  h.created.forEach((fn) => fn({ agent }));
  const err = Object.assign(new Error('payment required'), { status: 402 });
  try { await agent._request({ step: 1 }, err); } catch { /* expected */ }
  await agent._preStep(2, [userMsg('你好')]);
  const applied = h.applied.at(-1);
  const last = readRows(h.logPath).filter((r) => r.event === 'decision').at(-1);
  ok('Q6 档位被拒时降级为不带 effort', applied?.provider === FALLBACK.provider
    && applied?.model === FALLBACK.model && applied?.reasoningEffort === undefined,
    `applied=${JSON.stringify(applied || null)}`);
  ok('Q6b 审计行标 effort_dropped', last?.effort_dropped === true, `effort_dropped=${last?.effort_dropped}`);
}

// ── Q7：**真实上游 payload**（无任何数值状态码）⟹ 必须命中语义信号并兜底
//   实测原文（2026-10-21）：
//   { "type":"rate_limit_error", "code":"rate_limit_exceeded",
//     "message":"每日额度超限：当前 $64.4832 USD（限制：$60.0000 USD）。将于 … 重置",
//     "limit_type":"daily_quota", "reset_time":"2026-10-21T16:00:00.000Z" }
//   ⚠ 旧判据只看状态码 ⟹ 这条永远命中不了，且**静默**。本用例锁死这个回归。
{
  const h = makeHarness({ enabled: true, statusCodes: [402, 429], ...FALLBACK, ttlMs: 60_000 });
  const agent = h.mkAgent('s-real-payload');
  h.created.forEach((fn) => fn({ agent }));
  const resetMs = Date.now() + 3_600_000;
  const err = Object.assign(
    new Error('每日额度超限：当前 $64.4832 USD（限制：$60.0000 USD）'),
    {
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      limit_type: 'daily_quota',
      current: 64.4832,
      limit: 60,
      reset_time: new Date(resetMs).toISOString(),
    },
  );
  let rethrown = false;
  try { await agent._request({ step: 1 }, err); } catch (e) { rethrown = e === err; }
  const rows = readRows(h.logPath);
  const hit = rows.filter((r) => r.event === 'quota-exhausted').at(-1);
  ok('Q7 真实 payload（无状态码）也能命中', !!hit && String(hit.reason || '').startsWith('text:'),
    `reason=${hit?.reason ?? 'none'} status=${hit?.status ?? 'null'}`);
  ok('Q7b 原错误照原样抛回', rethrown === true, `rethrown=${rethrown}`);
  ok('Q7c 到期时间取上游 reset_time（不是固定 ttl）',
    !!hit && Math.abs(Date.parse(hit.until) - resetMs) < 5_000,
    `until=${hit?.until ?? 'none'} resetAt=${hit?.resetAt ?? 'none'}`);
  await agent._preStep(2, [userMsg('你好')]);
  const applied = h.applied.at(-1);
  ok('Q7d 之后路由到按量档（手写 effort）', applied?.provider === FALLBACK.provider
    && applied?.model === FALLBACK.model && applied?.reasoningEffort === FALLBACK.effort,
    `applied=${JSON.stringify(applied || null)}`);
}

// ── Q8：普通错误 ⟹ 写 `quota-miss` 留痕（不许静默）
{
  const h = makeHarness({ enabled: true, statusCodes: [402, 429], ...FALLBACK, ttlMs: 60_000 });
  const agent = h.mkAgent('s-miss');
  h.created.forEach((fn) => fn({ agent }));
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  try { await agent._request({ step: 1 }, err); } catch { /* expected */ }
  const rows = readRows(h.logPath);
  const miss = rows.filter((r) => r.event === 'quota-miss').at(-1);
  const bad = rows.filter((r) => r.event === 'quota-exhausted').length;
  ok('Q8 未命中写 quota-miss 且不误触发兜底', !!miss && bad === 0,
    `miss=${miss?.reason ?? 'none'} exhausted=${bad}`);
}

let fail = 0;
for (const r of results) {
  if (!r.pass) fail += 1;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.info ? `  — ${r.info}` : ''}\n`);
}
process.stdout.write(`QUOTA_FALLBACK_SELFTEST: ${fail === 0 ? 'ALL PASS' : `${fail} FAIL`} (${results.length} checks)\n`);
process.exit(fail === 0 ? 0 : 1);
