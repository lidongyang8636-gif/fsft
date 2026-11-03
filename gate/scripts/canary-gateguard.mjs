#!/usr/bin/env node
/**
 * gate/scripts/canary-gateguard.mjs —— `guards/gate-guard` 的离线上板门 canary（R3b §4-A2/A3/A4/A5）。
 *
 * 四条要求，逐条对应：
 *   · **A2**：三条分级路径**各自断言确切返回值**（不是"非空"）——
 *           `ask` 断言 `kind==='ask'` 且 reason/displayReason 含指定字样；
 *           `deny` 断言 `kind==='deny'`；放行断言**调用了 `next()`** 且返回 next 的返回值。
 *   · **A3**：fail-open canary —— 注入异常 ⇒ **放行**（且日志出现 `fail-open` 行）；
 *           **并用日志证明它确实走了放行分支**。
 *   · **A4**：不误伤 —— 一组常见工具（读/查/写/pwsh）**零拦截**；且**被有意排除**的
 *           读类/准备类工具也不拦。
 *   · **A5**：离线可测（stub ctx / 假 exec）＋**必须真 `import()` 并调用**（`node --check` 不算，R2 教训）。
 *
 * 全部夹具写在 `gate/.canary/gateguard/**`（本 slice 写域内），收尾删除；不碰任何真实交付物、不激活插件。
 *
 * 退出码：0 = 全部断言通过；1 = 任一不符。
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = resolve(import.meta.dirname, '..');       // .../gate
const ROOT = resolve(HERE, '..');                       // 工作区根
const CANARY = join(HERE, '.canary', 'gateguard');
const CG_ROOT = join(CANARY, 'ws');                     // 假工作区根
const EVID = join(CG_ROOT, 'gate', 'evidence');
const LOG = join(EVID, 'gateguard-decisions.log');
const PLUGIN = join(ROOT, 'guards', 'gate-guard', 'lib', 'index.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  —— ${detail}` : ''}`);
}

const NEXT_SENTINEL = { kind: 'allow', from: 'next' };

/** 造一个 stub ctx 并挂上插件；返回 { handler, nextCalls, logLines } */
function mountPlugin(mod, { env = {} } = {}) {
  let handler = null;
  const ctx = { on: (evt, cb) => { if (evt === 'tools/pre-execute') handler = cb; } };
  mod.apply(ctx, { root: CG_ROOT, evidenceDir: 'gate/evidence', logPath: LOG, env });
  if (!handler) throw new Error('插件没有注册 tools/pre-execute');
  return handler;
}

async function invoke(handler, exec, { nextReturns = NEXT_SENTINEL } = {}) {
  let nextCalls = 0;
  const next = async () => { nextCalls += 1; return nextReturns; };
  const ret = await handler(exec, next);
  return { ret, nextCalls };
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 写一份"绿证据 + 收口块"，可指定 pinned 文件与时间。 */
function writeGreenClosure({ taskId, acceptedAt, finishedAt, pinnedFile, drift = false }) {
  const evName = `gate-${taskId}-2026-10-16T00-00-00Z.json`;
  const sha = mod.sha256(pinnedFile, 64);
  const ev = {
    schema: 'gate-evidence/v0',
    taskId,
    taskState: { gateOk: true, verdict: 'PASS', counts: { PASS: 1, HONEST_FAIL: 0, MISMATCH: 0, UNVERIFIED: 0 } },
    startedAt: finishedAt,
    finishedAt,
    pins: { descriptor: { path: pinnedFile.replace(CG_ROOT, '').replace(/\\/g, '/').replace(/^\//, ''), sha256: drift ? '0'.repeat(64) : sha, exists: true } },
    evaluated: [{ id: 'K1', state: 'PASS', files: [], real: { exit: 1, harness: 'exited' } }],
    notRun: [],
    noWriteDeclared: [],
    noWriteResults: [],
    noWriteUnresolved: [],
    failed: [],
  };
  writeFileSync(join(EVID, evName), JSON.stringify(ev, null, 2), 'utf8');
  const rel = `gate/evidence/${evName}`;
  const block = `## GATE\n\n\`\`\`\nGATE ${taskId} PASS assertions=1 PASS=1 HONEST_FAIL=0 MISMATCH=0 UNVERIFIED=0 ran=1 noWrite=clean:1\n\`\`\`\n\nevidence: ${rel}\n\nCLOSE: ${taskId} accepted ${acceptedAt} | evidence sha256=deadbeef… | pins checked=1 drifted=0\n`;
  writeFileSync(join(EVID, `close-${taskId}.md`), block, 'utf8');
  return { evName, rel };
}

function writeRedClosure({ taskId, acceptedAt }) {
  const evName = `gate-${taskId}-2026-10-16T00-00-00Z.json`;
  const ev = {
    schema: 'gate-evidence/v0', taskId,
    taskState: { gateOk: false, verdict: 'HONEST_FAIL', counts: { PASS: 0, HONEST_FAIL: 1, MISMATCH: 0, UNVERIFIED: 0 } },
    startedAt: acceptedAt, finishedAt: acceptedAt, pins: {}, evaluated: [{ id: 'K1', state: 'HONEST_FAIL', files: [], real: { exit: 1, harness: 'exited' } }],
    notRun: [], noWriteDeclared: [], noWriteResults: [], noWriteUnresolved: [], failed: [{ id: 'K1' }],
  };
  writeFileSync(join(EVID, evName), JSON.stringify(ev, null, 2), 'utf8');
  writeFileSync(join(EVID, `close-${taskId}.md`),
    `## GATE\n\n\`\`\`\nGATE ${taskId} gateOk=false(assertions=HONEST_FAIL) assertions=1 PASS=0 HONEST_FAIL=1 MISMATCH=0 UNVERIFIED=0 ran=1 noWrite=clean:1\n\`\`\`\n\nevidence: gate/evidence/${evName}\n\nCLOSE: ${taskId} accepted ${acceptedAt} | evidence sha256=deadbeef… | pins checked=0 drifted=0\n`, 'utf8');
}

let mod;

async function main() {
  console.log('== gate-guard（R3b 上板门）离线 canary ==');
  rmSync(CANARY, { recursive: true, force: true });
  mkdirSync(EVID, { recursive: true });

  // ---------- A5：必须真 import 并调用 ----------
  console.log('\n--- A5 真加载（import()，不是 node --check）---');
  let importErr = null;
  try {
    mod = await import(pathToFileURL(PLUGIN).href);
  } catch (e) { importErr = e; }
  check('A5.1 plugins真 import 成功', !importErr, importErr ? importErr.message : 'ok');
  check('A5.2 导出 name/inject/apply', !!mod && mod.name === 'dsh-gate-guard'
    && JSON.stringify(mod.inject) === '["tools"]' && typeof mod.apply === 'function',
    mod ? `name=${mod.name} inject=${JSON.stringify(mod.inject)} apply=${typeof mod.apply}` : 'no module');
  if (importErr) { return finish(); }

  const pinned = join(CG_ROOT, 'design.rpt');
  writeFileSync(pinned, 'pinned content v1\n', 'utf8');

  const NOW = Date.now();
  const PAST = new Date(NOW - 60_000).toISOString();
  const FUTURE = new Date(NOW + 60_000).toISOString();
  const art = join(CG_ROOT, 'top.bit');
  writeFileSync(art, 'bitstream\n', 'utf8');

  // 产物 mtime 设为过去（默认"新鲜"场景）
  const setArtMtime = (ms) => utimesSync(art, new Date(ms), new Date(ms));
  setArtMtime(NOW - 120_000);

  // ---------- A2-1：ask（无证据）----------
  console.log('\n--- A2-1 无新鲜证据 ⇒ ask ---');
  let h = mountPlugin(mod);
  let r = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'top.bit' } });
  check('ask.kind === "ask"', r.ret && r.ret.kind === 'ask', JSON.stringify(r.ret));
  check('ask 未调用 next（确实拦下）', r.nextCalls === 0, `nextCalls=${r.nextCalls}`);
  check('ask.reason 含「无 gate 证据」', typeof r.ret?.reason === 'string' && r.ret.reason.includes('无 gate 证据'), r.ret?.reason);
  check('ask.displayReason 含「无 gate 证据」与证据路径提示',
    typeof r.ret?.displayReason === 'string' && r.ret.displayReason.includes('无 gate 证据') && r.ret.displayReason.includes('close-'),
    r.ret?.displayReason);

  // ---------- A2-2：deny（红证据）----------
  console.log('\n--- A2-2 红证据 ⇒ deny ---');
  rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });
  writeRedClosure({ taskId: 'redtask', acceptedAt: new Date(NOW).toISOString() });
  h = mountPlugin(mod);
  r = await invoke(h, { name: 'mcp__fpga-mcp__viv_program_flash', arguments: { mcs_file: 'top.bit' } });
  check('red.kind === "deny"', r.ret && r.ret.kind === 'deny', JSON.stringify(r.ret));
  check('red 未调用 next', r.nextCalls === 0, `nextCalls=${r.nextCalls}`);
  check('red.reason 含「红证据」', typeof r.ret?.reason === 'string' && r.ret.reason.includes('红证据'), r.ret?.reason);

  // ---------- A2-3：deny（漂移）----------
  console.log('\n--- A2-3 绿证据但哈希漂移 ⇒ deny ---');
  rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });
  writeGreenClosure({ taskId: 'drifttask', acceptedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), pinnedFile: pinned, drift: true });
  h = mountPlugin(mod);
  r = await invoke(h, { name: 'mcp__fpga-mcp__program_device', arguments: { bitstream: 'top.bit' } });
  check('drift.kind === "deny"', r.ret && r.ret.kind === 'deny', JSON.stringify(r.ret));
  check('drift.reason 含「漂移」', typeof r.ret?.reason === 'string' && r.ret.reason.includes('漂移'), r.ret?.reason);

  // ---------- A2-4：放行（绿 + 新鲜）----------
  // ★ R4.2：必须**点名一个存在的产物** —— 否则会落到"无法绑定 ⇒ ask"（这正是本轮修的洞）。
  console.log('\n--- A2-4 PASS 且新鲜 ⇒ 放行（调用 next）---');
  rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });
  rmSync(LOG, { force: true });
  writeGreenClosure({ taskId: 'greentask', acceptedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), pinnedFile: pinned, drift: false });
  setArtMtime(NOW - 120_000);   // 产物比证据早 ⇒ 新鲜
  h = mountPlugin(mod);
  r = await invoke(h, { name: 'mcp__vivado__generate_bitstream', arguments: { bitstream: 'top.bit' } });
  check('green 调用了 next（放行）', r.nextCalls === 1, `nextCalls=${r.nextCalls}`);
  check('green 返回值 === next() 的返回值（不是 {kind:"allow"} 自造）', deepEq(r.ret, NEXT_SENTINEL), JSON.stringify(r.ret));

  // ---------- A2-5：deny（不新鲜）----------
  console.log('\n--- A2-5 绿证据但不新鲜（产物比证据新）⇒ deny ---');
  setArtMtime(NOW + 60_000);    // 产物"晚于"证据
  h = mountPlugin(mod);
  r = await invoke(h, { name: 'mcp__fpga-mcp__viv_write_bitstream', arguments: { path: 'top.bit' } });
  check('stale.kind === "deny"', r.ret && r.ret.kind === 'deny', JSON.stringify(r.ret));
  check('stale.reason 含「不新鲜」', typeof r.ret?.reason === 'string' && r.ret.reason.includes('不新鲜'), r.ret?.reason);
  setArtMtime(NOW - 120_000);

  // ===========================================================================
  // ---------- R4.2 §1.1：四例，**各断言确切 action** ----------
  // 判据（TASK.5 §3-A1）：**恒 pass 或恒 ask 都不算过**。
  // 前置：先让一份**绿且不漂移**的收口存在 ⟹ 四例的差别**只在产物绑定**上，
  //       否则第 ①/② 例会退化成"无证据 ⇒ ask"，**证明不了绑定规则**（这点必须自己先核）。
  // ===========================================================================
  console.log('\n--- R4.2 §1.1 四例：产物绑定（各断言确切 action）---');
  rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });
  writeGreenClosure({ taskId: 'bindtask', acceptedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), pinnedFile: pinned, drift: false });
  h = mountPlugin(mod);

  // 先自证前置成立：绿证据在场，且**存在**一个产物时确实能 pass（否则四例无意义）
  setArtMtime(NOW - 120_000);
  const baseline = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'top.bit' } });
  check('前置自证：绿证据 + 存在产物 ⇒ pass（否则四例证明不了绑定规则）',
    baseline.nextCalls === 1 && deepEq(baseline.ret, NEXT_SENTINEL), `nextCalls=${baseline.nextCalls} ret=${JSON.stringify(baseline.ret)}`);

  // ① 无产物（参数里根本没点名产物）
  const b1 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { other: 'nothing-to-see' } });
  check('① 无产物 ⇒ 确切 ask', b1.ret && b1.ret.kind === 'ask' && b1.nextCalls === 0,
    `kind=${b1.ret && b1.ret.kind} nextCalls=${b1.nextCalls}`);
  check('① reason 写明「无法把证据与本次烧写对象绑定」',
    typeof b1.ret?.reason === 'string' && b1.ret.reason.includes('无法把证据与本次烧写对象绑定'), b1.ret?.reason);

  // ② 点名了产物但**文件不存在**（红队 F2b）
  const b2 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'absent.bit' } });
  check('② 产物路径不存在 ⇒ 确切 ask', b2.ret && b2.ret.kind === 'ask' && b2.nextCalls === 0,
    `kind=${b2.ret && b2.ret.kind} nextCalls=${b2.nextCalls}`);
  check('② reason 写明点名的那个 + 「不存在」',
    typeof b2.ret?.reason === 'string' && b2.ret.reason.includes('不存在') && b2.ret.reason.includes('absent.bit'),
    b2.ret?.reason && b2.ret.reason.split('\n')[1]);

  // ③ 有产物且**证据比产物旧** ⇒ 不得 pass（deny 或 ask 都算过）
  setArtMtime(NOW + 60_000);
  const b3 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'top.bit' } });
  check('③ 证据比产物旧 ⇒ **不得 pass**（deny 或 ask）',
    b3.nextCalls === 0 && b3.ret && (b3.ret.kind === 'deny' || b3.ret.kind === 'ask'),
    `kind=${b3.ret && b3.ret.kind} nextCalls=${b3.nextCalls}`);

  // ④ 有产物且**证据比产物新** ⇒ 确切 pass
  setArtMtime(NOW - 120_000);
  const b4 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'top.bit' } });
  check('④ 证据比产物新 ⇒ 确切 pass（调用 next）',
    b4.nextCalls === 1 && deepEq(b4.ret, NEXT_SENTINEL), `nextCalls=${b4.nextCalls} ret=${JSON.stringify(b4.ret)}`);

  check('四例**不同时恒 pass / 恒 ask**（① ask 与 ④ pass 必须并存）',
    b1.ret?.kind === 'ask' && b4.nextCalls === 1, `①=${b1.ret?.kind} ④=${b4.nextCalls === 1 ? 'pass' : 'not-pass'}`);

  // ===========================================================================
  // ---------- R4.3 §1.3：再补四例（混合 / 空文件 / 带扩展名目录 / symlink·junction）----------
  // 判据（TASK.6 §3-A1）：**各断言 `action === 'ask'` 且 `nextCalls === 0`** ——
  //   这才证明"真拦下"；只断言"返回了个对象"会漏掉"其实放行了"。**恒 pass / 恒 ask 都不算过**。
  // ===========================================================================
  console.log('\n--- R4.3 §1.3 四例：候选有效性（各断言 ask + nextCalls===0）---');
  h = mountPlugin(mod);
  setArtMtime(NOW - 120_000);   // 时间上"新鲜"，把差别单独留给候选有效性

  // M 混合：1 个存在 + 1 个不存在
  const m1 = await invoke(h, {
    name: 'mcp__vivado__program_device',
    arguments: { bitstream: 'top.bit', mcs_file: 'missing.mcs' },
  });
  check('M 混合候选（1 存在 + 1 不存在）⇒ 确切 ask 且 nextCalls===0',
    m1.ret && m1.ret.kind === 'ask' && m1.nextCalls === 0,
    `kind=${m1.ret && m1.ret.kind} nextCalls=${m1.nextCalls}`);
  check('M reason 写明**不存在的那个**（不许只挑存在的看）',
    typeof m1.ret?.reason === 'string' && m1.ret.reason.includes('missing.mcs') && m1.ret.reason.includes('不存在'),
    m1.ret?.reason && m1.ret.reason.split('\n')[1]);

  // E 空文件（0 字节，名为 *.bit）
  writeFileSync(join(CG_ROOT, 'empty.bit'), '', 'utf8');
  const e1 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'empty.bit' } });
  check('E 空文件（0 字节，名为 *.bit）⇒ 确切 ask 且 nextCalls===0',
    e1.ret && e1.ret.kind === 'ask' && e1.nextCalls === 0,
    `kind=${e1.ret && e1.ret.kind} nextCalls=${e1.nextCalls}`);
  check('E reason 写明「空文件」', typeof e1.ret?.reason === 'string' && e1.ret.reason.includes('空文件'),
    e1.ret?.reason && e1.ret.reason.split('\n')[1]);

  // D 目录（**名字带白名单扩展名** —— 只有这种才成为候选）
  mkdirSync(join(CG_ROOT, 'dir.bit'), { recursive: true });
  const d1 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'dir.bit' } });
  check('D 目录（名字带 .bit）⇒ 确切 ask 且 nextCalls===0',
    d1.ret && d1.ret.kind === 'ask' && d1.nextCalls === 0,
    `kind=${d1.ret && d1.ret.kind} nextCalls=${d1.nextCalls}`);
  check('D reason 写明「是目录」', typeof d1.ret?.reason === 'string' && d1.ret.reason.includes('目录'),
    d1.ret?.reason && d1.ret.reason.split('\n')[1]);

  // D2 精度：**无扩展名的目录**根本不成为候选 ⇒ 走"没点名产物"分支
  //（TASK.6 §0 精度 1：**不许**写成"目录一律能过"）
  mkdirSync(join(CG_ROOT, 'plain-dir'), { recursive: true });
  const d2 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'plain-dir' } });
  check('D2 精度：无扩展名目录 ⇒ ask（**不是**"目录一律能过"）',
    d2.ret && d2.ret.kind === 'ask' && d2.nextCalls === 0,
    `kind=${d2.ret && d2.ret.kind} nextCalls=${d2.nextCalls}`);

  // S symlink / junction —— 能造则造（实机证据），造不出则 **NOT RUN** + 代码级断言
  const linkBit = join(CG_ROOT, 'link.bit');
  let linkHow = '';
  for (const [type, how] of [['file', 'symlink(file)'], ['junction', 'symlink(junction)']]) {
    try { symlinkSync(join(CG_ROOT, 'top.bit'), linkBit, type); linkHow = how; break; } catch { /* 试下一种 */ }
  }
  if (linkHow) {
    const s1 = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'link.bit' } });
    check(`S symlink/junction（${linkHow}）⇒ 确切 ask 且 nextCalls===0`,
      s1.ret && s1.ret.kind === 'ask' && s1.nextCalls === 0,
      `kind=${s1.ret && s1.ret.kind} nextCalls=${s1.nextCalls}`);
    check('S reason 写明「符号链接 / junction」',
      typeof s1.ret?.reason === 'string' && s1.ret.reason.includes('链接'),
      s1.ret?.reason && s1.ret.reason.split('\n')[1]);
  } else {
    // ★ NOT RUN：本沙箱造不出链接（Lead 亦得 EPERM）。**不许写成实测**。
    check('S symlink/junction ⇒ **NOT RUN**（沙箱造不出：symlink(file) 与 junction 均失败）', true,
      '标记 NOT RUN；改用**代码级**断言（下一条）');
    const src = readFileSync(PLUGIN, 'utf8');
    check('S 代码级断言：实现含 `lstatSync` + `isSymbolicLink` 守卫，且 `probeCandidate` 已导出',
      src.includes('lstatSync') && src.includes('isSymbolicLink') && typeof mod.probeCandidate === 'function',
      `lstatSync=${src.includes('lstatSync')} isSymbolicLink=${src.includes('isSymbolicLink')} probeCandidate=${typeof mod.probeCandidate}`);
  }

  // 正向对照：**有效普通文件仍能过**（否则就是"恒 ask"）
  //
  // ★★ R4.4（Lead 复核抓出的回归）：原先这里只断言 `nextCalls === 1 && ret === NEXT_SENTINEL`，
  //   而 **fail-open 分支也调用 `next()` 并原样返回** ⇒ 该断言**对 `pass` 与 `fail-open` 不具区分力**。
  //   所以 R4.3 的 pass 分支里残留 `existing` 抛 `ReferenceError` 时，这里**照样全绿**（假绿）。
  //   一般规律：**存在 fail-open 时，「`next` 被调用」不能证明「判定为 pass」**
  //   —— 必须断言**组件自身的输出**（`action`/`basis`）或**日志里的 `action`**。
  rmSync(LOG, { force: true });
  const greenArgs = { bitstream: 'top.bit' };

  // (1) ★ 直接调**纯函数**：断言 `action` 本身；并把"不抛异常"显式断言出来
  let direct = null; let directThrew = null;
  try {
    direct = mod.classifyBurnCall({ toolName: 'mcp__vivado__program_device', args: greenArgs, root: CG_ROOT, evidenceDir: 'gate/evidence' });
  } catch (err) { directThrew = err; }
  check('正向对照(1) **绿路径不抛异常**（R4.4 回归就是在这里红的：`ReferenceError: existing is not defined`）',
    directThrew === null, directThrew ? `${directThrew.constructor.name}: ${directThrew.message}` : 'threw=null');
  check('正向对照(2) 纯函数 `action === "pass"`（不是 ask/deny，也不是被兜住）',
    direct !== null && direct.action === 'pass', `action=${direct && direct.action}`);
  check('正向对照(3) `basis` 含「已绑定产物」（证明它真的走完了判定）',
    !!(direct && typeof direct.basis === 'string' && direct.basis.includes('已绑定产物')),
    direct && direct.basis);

  // (2) 经 handler 走一遍，并断言**日志那一行的 action 是 "pass"、不是 "fail-open"**
  const pos = await invoke(h, { name: 'mcp__vivado__program_device', arguments: greenArgs });
  check('正向对照(4) handler 放行（nextCalls===1）—— **必要但不充分**：单靠它区分不了 fail-open',
    pos.nextCalls === 1 && deepEq(pos.ret, NEXT_SENTINEL), `nextCalls=${pos.nextCalls}`);
  let lastRec = null;
  try {
    const lines = readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    lastRec = JSON.parse(lines[lines.length - 1]);
  } catch { /* 日志缺失 ⇒ 下面断言会红 */ }
  check('正向对照(5) **日志 `action` === "pass"**（而不是 "fail-open"）⟹ 这才是可判别的证据',
    lastRec !== null && lastRec.action === 'pass',
    lastRec ? `action=${JSON.stringify(lastRec.action)}；basis=${String(lastRec.basis).slice(0, 56)}` : '(日志缺失或不可解析)');
  check('正向对照(6) 日志 `action` **明确不是** "fail-open"',
    lastRec !== null && lastRec.action !== 'fail-open', lastRec && `action=${lastRec.action}`);

  // ---------- A3：fail-open ----------
  console.log('\n--- A3 fail-open：注入异常 ⇒ 必须放行 ---');
  rmSync(LOG, { force: true });
  h = mountPlugin(mod);
  const bomb = { name: 'mcp__vivado__program_device' };
  Object.defineProperty(bomb, 'arguments', { get() { throw new Error('INJECTED-PLUGIN-FAULT'); } });
  r = await invoke(h, bomb);
  check('failopen 调用了 next（放行，不是拦住）', r.nextCalls === 1, `nextCalls=${r.nextCalls}`);
  check('failopen 返回 next() 的返回值', deepEq(r.ret, NEXT_SENTINEL), JSON.stringify(r.ret));
  let logAll = '';
  try { logAll = readFileSync(LOG, 'utf8'); } catch { /* 日志没写成也要继续判其余 */ }
  check('failopen 日志出现 action:"fail-open" 与注入标记',
    logAll.includes('"action":"fail-open"') && logAll.includes('INJECTED-PLUGIN-FAULT'),
    logAll.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '(日志为空)');

  // ---------- A3b：逃生舱 ----------
  console.log('\n--- A3b 逃生舱 GATEGUARD_OFF=1 ⇒ 整层关（无证据也放行）---');
  rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });   // 无任何证据
  rmSync(LOG, { force: true });
  h = mountPlugin(mod, { env: { GATEGUARD_OFF: '1' } });
  r = await invoke(h, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'top.bit' } });
  check('off 调用了 next（放行）', r.nextCalls === 1, `nextCalls=${r.nextCalls}`);
  let logOff = ''; try { logOff = readFileSync(LOG, 'utf8'); } catch { /* 忽略 */ }
  check('off 日志出现 action:"off"', logOff.includes('"action":"off"'), logOff.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '(空)');

  // ---------- A4：不误伤 ----------
  console.log('\n--- A4 不误伤：常见工具与"有意排除"的工具零拦截 ---');
  rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });  // 无证据：若有误伤一定会 ask/deny
  // ★ 必须**重新 mount 一个干净 handler**：上面 A3b 挂的是 GATEGUARD_OFF=1 的实例，
  //   复用它会让 A4.1「零拦截」永远成立 —— 那是**假通过**（实测踩过：A4.1 全绿、而 A4.2 露馅）。
  h = mountPlugin(mod);
  const benign = [
    'mcp__vivado__report_timing_summary', 'mcp__vivado__get_project_info', 'mcp__vivado__run_tcl',
    'mcp__fpga-mcp__viv_list_flash_parts', 'mcp__fpga-mcp__viv_readback_flash', 'mcp__fpga-mcp__viv_verify_flash',
    'mcp__fpga-mcp__viv_add_flash_config', 'mcp__fpga-mcp__viv_set_flash_property', 'mcp__fpga-mcp__viv_set_hw_device_program_file',
    'mcp__vivado__check_bitstream_readiness',
    'pwsh', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'job_output',
  ];
  let falsePositives = [];
  for (const t of benign) {
    const rr = await invoke(h, { name: t, arguments: {} });
    if (!(rr.nextCalls === 1 && deepEq(rr.ret, NEXT_SENTINEL))) falsePositives.push(`${t} → ${JSON.stringify(rr.ret)}`);
  }
  check(`A4.1 ${benign.length} 个常见/排除工具零拦截`, falsePositives.length === 0,
    falsePositives.length ? falsePositives.join(' | ') : '全部走 next()');

  // 烧板类"只拦该拦的"：名单内的必须拦（无证据 ⇒ ask），且名单是窄的
  let burnUnblocked = [];
  for (const t of mod.BURN_TOOLS) {
    const rr = await invoke(h, { name: t, arguments: {} });
    if (!(rr.ret && rr.ret.kind === 'ask')) burnUnblocked.push(`${t} → ${JSON.stringify(rr.ret)}`);
  }
  check(`A4.2 拦截面 ${mod.BURN_TOOLS.length} 个工具全部拦下（无证据 ⇒ ask）`, burnUnblocked.length === 0,
    burnUnblocked.length ? burnUnblocked.join(' | ') : '全部 ask');
  check('A4.3 拦截面是"窄"的（<= 20 条，且不含读类）',
    mod.BURN_TOOLS.length <= 20 && !mod.BURN_TOOLS.some((t) => /report_|get_|list_|read_|verify_|check_/.test(t)),
    `count=${mod.BURN_TOOLS.length}`);

  // ---------- A4b：watch 日志（只记不拦）----------
  console.log('\n--- A4b 像烧板但不在名单里 ⇒ 只记 watch 日志、不拦 ---');
  rmSync(LOG, { force: true });
  h = mountPlugin(mod);
  r = await invoke(h, { name: 'mcp__fpga-mcp__viv_readback_flash', arguments: {} });
  let logW = ''; try { logW = readFileSync(LOG, 'utf8'); } catch { /* 忽略 */ }
  check('watch：放行', r.nextCalls === 1 && deepEq(r.ret, NEXT_SENTINEL), JSON.stringify(r.ret));
  check('watch：落了一行 action:"watch"', logW.includes('"action":"watch"'), logW.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '(空)');

  // ---------- 新鲜度函数自测（TASK.4 §3.2 要求）----------
  console.log('\n--- 新鲜度函数 isFresh 自测（严格"晚于"）---');
  check('isFresh(证据晚于产物) === true', mod.isFresh(2000, [1000]) === true);
  check('isFresh(证据等于产物) === false（严格晚于）', mod.isFresh(1000, [1000]) === false);
  check('isFresh(证据早于产物) === false', mod.isFresh(500, [1000]) === false);
  check('isFresh(时间戳非法) === false（fail-closed）', mod.isFresh(NaN, [1000]) === false);
  check('isFresh(现在+1h, []) === false 且 isFresh(现在-1h, []) === false（Lead 复现的两条，都必须 false）', mod.isFresh(Date.now() + 3600_000, []) === false && mod.isFresh(Date.now() - 3600_000, []) === false);
  check('isFresh(无产物) === false（★ R4.2：无绑定 ⇒ 不可判新鲜，红队 F3）', mod.isFresh(2000, []) === false);

  // ---------- 一致性：插件与 close.mjs 对同一夹具必须同结论 ----------
  // 为什么需要：插件**不能** import `gate/close.mjs`（那个文件顶层就 `process.exitCode = main()`，
  // import 会执行 CLI），所以是两份实现。两份实现必须靠**检查**而不是靠承诺保持一致。
  console.log('\n--- 一致性 canary：同一夹具，插件 vs close.mjs（spawn）---');
  const CLOSE = join(HERE, 'close.mjs');
  const runClose = (taskId, evRel) => {
    // ★ 捕获 stderr 而不是 stdio:'ignore'：close.mjs 的合法退出码只有 0/2/3/4/5，
    //   若出现 1，那是**未捕获异常**（Node 的默认码），必须把原始报错留下来才能诊断。
    const errFile = join(CANARY, 'close-stderr.txt');
    const outFile = join(CANARY, 'close-stdout.txt');
    const fdE = openSync(errFile, 'w');
    const fdO = openSync(outFile, 'w');
    const r = spawnSync(process.execPath, [CLOSE, '--task', taskId, '--evidence', evRel, '--root', CG_ROOT],
      { cwd: ROOT, stdio: ['ignore', fdO, fdE] });
    closeSync(fdO); closeSync(fdE);
    let err = ''; let out = '';
    try { err = readFileSync(errFile, 'utf8'); } catch { /* 无 stderr */ }
    try { out = readFileSync(outFile, 'utf8'); } catch { /* 无 stdout */ }
    return { code: r.status, err: err.trim(), out: out.trim(), errLen: err.length, outLen: out.length };
  };
  for (const [label, drift, expectClose, expectAction] of [
    ['干净（无漂移）', false, 0, 'pass'],
    ['漂移（pinned 哈希不符）', true, 4, 'deny'],
  ]) {
    rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true });
    const id = `parity-${drift ? 'drift' : 'clean'}`;
    const { rel } = writeGreenClosure({ taskId: id, acceptedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), pinnedFile: pinned, drift });
    const closeRes = runClose(id, rel);
    const closeCode = closeRes.code;
    const hh = mountPlugin(mod);
    const rr = await invoke(hh, { name: 'mcp__vivado__program_device', arguments: { bitstream: 'top.bit' } });
    const pluginAction = rr.ret && rr.ret.kind === 'deny' ? 'deny' : (rr.nextCalls === 1 ? 'pass' : `other:${JSON.stringify(rr.ret)}`);
    check(`parity[${label}] close.mjs 退出码 ${closeCode}（期望 ${expectClose}）`, closeCode === expectClose,
      `actual=${closeCode}；errLen=${closeRes.errLen} outLen=${closeRes.outLen}；stderr=「${(closeRes.err || '(空)').split(/\r?\n/).slice(0, 3).join(' / ')}」`);
    check(`parity[${label}] 插件判定 ${pluginAction}（期望 ${expectAction}）`, pluginAction === expectAction, `actual=${pluginAction}`);
  }

  return finish();
}


function finish() {
  const bad = results.filter((r) => !r.ok);
  console.log('\n== 汇总 ==');
  for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}`);
  // 落一份摘要供 REPRO 生成器读取（别让复现文档手抄数字）
  try {
    mkdirSync(join(HERE, 'evidence'), { recursive: true });
    writeFileSync(join(HERE, 'evidence', 'gateguard-canary-summary.json'), `${JSON.stringify({
      schema: 'gate-gateguard-canary/v0',
      ranAt: new Date().toISOString(),
      node: process.version,
      plugin: 'guards/gate-guard/lib/index.js',
      burnTools: mod && mod.BURN_TOOLS ? mod.BURN_TOOLS.length : null,
      total: results.length,
      failed: bad.length,
      checks: results.map((r) => ({ name: r.name, ok: r.ok })),
    }, null, 2)}\n`, 'utf8');
  } catch { /* 摘要写失败不影响判定 */ }
  rmSync(CANARY, { recursive: true, force: true });
  // 清掉自己用过的空父目录（别的 canary 还在用就保留）
  try { rmdirSync(join(HERE, '.canary')); } catch { /* 非空或不存在：不动 */ }
  if (bad.length > 0) {
    console.log(`GATEGUARD_CANARY: FAIL (${bad.length}/${results.length} 条不符)`);
    return 1;
  }
  console.log(`GATEGUARD_CANARY: PASS (${results.length}/${results.length} 条：分级确切返回值 + 候选有效性（混合/空/目录/链接）+ fail-open 走放行 + 不误伤 + 真 import + 与 close.mjs 一致)`);
  return 0;
}



process.exitCode = await main();
