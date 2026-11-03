/**
 * gate/lib/runner.mjs —— Gate 收口协议 v0 公共 runner（执行 / 判定 / 落盘）。
 *
 * 设计口径见 gate/SPEC.md §3.2–§3.5。三条不可让渡的硬约束：
 *   1. 取【真实退出码】，绝不接受自述的 exit（自述只作为"声明"，与实测比对）；
 *   2. 适配器只做「任务 → 断言数组」的映射，**不得**自己判 PASS；
 *   3. 没跑 / 跑不了 / 未声明 ⟹ UNVERIFIED，**显式出现**，不得静默当通过。
 *
 * ★ 本沙箱实测：Node 的 spawnSync 带管道一律 EPERM（execSync/execFileSync 同）。
 *   因此捕获输出**只能**用 fd 重定向到临时文件（stdio:['ignore', fd, fd]）。
 *   临时文件放在 `<工作区根>/.scratch/run/` 下（工作区内，不越界），用完即删。
 *   ★ 临时区**不在** `gate/evidence/` 里：evidence 只放证据（R1.1 修正）。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { runtimeFacts, scratchDir } from './env.mjs';

// 四态：语义互斥（SPEC §3.2）
export const STATES = Object.freeze(['PASS', 'HONEST_FAIL', 'MISMATCH', 'UNVERIFIED']);

// 退出码契约：0 = 收口通过；1 = harness 自检失败；2 = 判据未过（含 MISMATCH）；
// 3 = runner 无法裁决（用法/前置/描述符非法）。见 SPEC §3.6。
export const EXIT = Object.freeze({ PASS: 0, HARNESS: 1, GATE_RED: 2, CANT_DECIDE: 3 });

/**
 * 由真实退出码 + 声明退出码判定断言状态。
 * @param {{ status:number|null, error:null|{code?:string}, signal?:string|null }} real
 * @param {{ exit?:number|string|null, envFailCodes?:number[] }} decl
 */
export function decideExitState(real, decl) {
  const envFail = new Set(Array.isArray(decl.envFailCodes) ? decl.envFailCodes : []);

  // 跑不起来：spawn 自身失败（ENOENT/EACCES/EPERM…）或没有 status 且不是被信号打断
  if (real.error || real.status === null) {
    if (real.signal) {
      return { state: 'UNVERIFIED', reason: `被信号打断 signal=${real.signal} ⟹ 未跑完，不计为判据结果` };
    }
    const code = real.error && real.error.code ? real.error.code : 'NO_STATUS';
    return { state: 'UNVERIFIED', reason: `命令未能启动（${code}）⟹ 未跑，不得当通过` };
  }

  if (envFail.has(real.status)) {
    return {
      state: 'UNVERIFIED',
      reason: `真实退出码 ${real.status} 命中 envFailCodes ⟹ 判为工具/环境失败（TOOL_ENV_FAIL），`
        + '不是"判据未过"，也不是"通过"；未取得结论',
    };
  }

  const declared = decl.exit;
  if (declared === undefined || declared === null) {
    return {
      state: 'UNVERIFIED',
      reason: `未声明退出码，实测 ${real.status} ⟹ 无判据可比（未声明视为未验证）`,
    };
  }
  const want = Number(declared);
  if (!Number.isInteger(want)) {
    return { state: 'UNVERIFIED', reason: `声明的 exit 不是整数（${JSON.stringify(declared)}）⟹ 描述符非法，未取得结论` };
  }

  if (want !== real.status) {
    return {
      state: 'MISMATCH',
      reason: `声明 exit=${want} 而实测 exit=${real.status} ⟹ 声明与实测不符，打回`,
    };
  }
  if (real.status === 0) {
    return { state: 'PASS', reason: `声明 exit=0 且实测 exit=0` };
  }
  return {
    state: 'HONEST_FAIL',
    reason: `声明 exit=${real.status} 且实测 exit=${real.status} ⟹ 诚实声明失败，同样不得宣告完成`,
  };
}

/** 任务级裁定：只在"全部执行"后才可能通过；任何未执行 / 不一致都判红。 */
export function verdictOf(states) {
  const n = states.length;
  const count = (s) => states.filter((x) => x === s).length;
  // ★ 一条断言都没有 = 这个域**什么都没被验证** ⟹ UNVERIFIED，不是"无事可做所以过"。
  //   只有 notRun 声明的域走这条路：exit 非零 + verdict=UNVERIFIED（禁止降级成 exit 0）。
  if (n === 0) return 'UNVERIFIED';
  if (count('PASS') === n) return 'PASS';
  if (count('UNVERIFIED') > 0) return 'UNVERIFIED';
  if (count('MISMATCH') > 0) return 'MISMATCH';
  if (count('HONEST_FAIL') > 0) return 'HONEST_FAIL';
  return 'NOTHING_DECLARED';
}

export function sha256File(p, n = 16) {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, n);
  } catch (err) {
    return `UNAVAILABLE(${err.code || err.message})`;
  }
}

/** 路径存在性：必须能 stat 到（目录也算存在）。 */
export function pathExists(p) {
  try { statSync(p); return true; } catch { return false; }
}

/**
 * 路径基准解析（SPEC §3.1）。写者直觉是"相对**工作区根**"，但描述符可能被复制到别处；
 * 因此规则是**确定性**的、不靠猜：
 *   ① 绝对路径 → 原样；
 *   ② 相对描述符目录能解析到 → 用描述符目录（可携带自己的夹具）；
 *   ③ 否则用 `--root`（工作区根）。
 * 解析结果与所用的基准都写进证据，事后可复算。
 */
export function resolveTarget(p, dw, root) {
  if (!p) return { abs: resolve(root, '.'), base: 'root', rel: p };
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(p)) return { abs: resolve(p), base: 'absolute', rel: p };
  const a = resolve(dw, p);
  if (pathExists(a)) return { abs: a, base: 'descriptor-dir', rel: p };
  return { abs: resolve(root, p), base: 'root', rel: p };
}

// 证据里的输出摘要上限。★ 踩过的坑：最初用 4000，而 redteam.3.mjs / settings.mjs 的 stdout
// 超过 4000 字符 —— 被截掉的**正好是末尾那行终判串**，于是"结论串佐证"全部落空，
// 三条断言被误判成 HONEST_FAIL。截断必须**保留首尾**，否则证据在最需要它的地方失效。
const DEFAULT_OUT_MAX = 20000;
const KEEP_TAIL = 3000;

export function clamp(s, max = DEFAULT_OUT_MAX) {
  const t = String(s ?? '');
  if (t.length <= max) return { text: t, truncated: false, bytes: Buffer.byteLength(t) };
  const headN = Math.max(0, max - KEEP_TAIL);
  return {
    text: `${t.slice(0, headN)}\n…[中段省略 ${t.length - max} 字符]…\n${t.slice(-KEEP_TAIL)}`,
    truncated: true,
    fullLength: t.length,
    bytes: Buffer.byteLength(t),
    kept: { head: headN, tail: KEEP_TAIL },
  };
}

/**
 * 内联求值断言算子 —— **不过 shell**（SPEC §3.5 之 2）。
 * 支持：exists: / not_exists: / path_contains:<路径>::<子串> / stdout_contains:<子串>
 */
export function evalAssert(expr, ctx) {
  const colon = typeof expr === 'string' ? expr.indexOf(':') : -1;
  // ★ 算子名**不带冒号**（曾经把 "exists:xxx" 切成 op="exists" 却去比 "exists:"，
  //   结果每一条 exists: 都判成"未知算子"——自测第一轮就是这么红的）。
  const op = colon > 0 ? expr.slice(0, colon).trim() : '(none)';
  const rest = colon > 0 ? expr.slice(colon + 1) : '';
  const pick = (p) => resolveTarget(p, ctx.dw, ctx.root);

  if (op === 'exists' || op === 'not_exists') {
    const target = rest.trim();
    if (!target) return { ok: false, detail: `exists/not_exists 缺少路径` };
    const { abs, base } = pick(target);
    const there = pathExists(abs);
    const ok = op === 'exists' ? there : !there;
    return { ok, detail: `${op}: ${target} ⟹ ${there ? '存在' : '不存在'} (${abs}；基准=${base})`, values: { abs, base, exists: there, sha256: there ? sha256File(abs) : null } };
  }

  if (op === 'path_contains') {
    const sep = rest.indexOf('::');
    if (sep < 0) return { ok: false, detail: 'path_contains: 缺少 :: 分隔符（形态：path_contains:<路径>::<子串>）' };
    const target = rest.slice(0, sep).trim();
    const needle = rest.slice(sep + 2);
    const norm = (s) => s.replace(/\\/g, '/');
    const { abs, base } = pick(target);
    const normAbs = norm(abs);
    const ok = norm(target).includes(needle) || normAbs.includes(needle);
    return { ok, detail: `路径串 "${norm(target)}"（绝对 "${normAbs}"，基准=${base}）${ok ? '包含' : '不包含'} "${needle}"（比对的是【路径字面】，不读文件内容）`, values: { abs, base } };
  }

  if (op === 'stdout_contains') {
    const needle = rest;
    const hay = String(ctx.stdout || '');
    const ok = hay.includes(needle);
    return { ok, detail: `stdout+stderr ${ok ? '包含' : '不包含'} "${needle}"` };
  }

  return { ok: false, detail: `未知算子 "${op}:"（v0 白名单：exists: / not_exists: / path_contains: / stdout_contains:）` };
}

// ---------------------------------------------------------------------------
// 只读性自检（SPEC §3.5 之 5「判据是否只读」的机械版）
// ---------------------------------------------------------------------------
const WRITE_VERB_RE = /(^|[\s;&|/\\])(set|set-content|add-content|out-file|write|writefile|append|new-item|mkdir|md|cp|copy|copy-item|mv|move|move-item|del|rm|remove|remove-item|rd|rmdir|add|commit|apply|reset|restore|program|flash|erase|generate|synth|build|install|init)([\s;&|]|$)/i;

export function readOnlyNote(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (WRITE_VERB_RE.test(cmd)) {
    return 'SUSPECT_NON_READONLY：命令行里出现写动词（启发式，仅提示，不作为判定依据）⟹ 须人工确认它不属于"改状态"类，否则不得进 acceptance';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 执行一步（真跑，取真实退出码）
// ---------------------------------------------------------------------------
export function runStep(step, ctx) {
  const cmd = step.cmd;
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { ran: false, status: null, error: { code: 'NO_COMMAND' }, stdout: '', stderr: '', ms: 0, cwd: ctx.cwd, capture: 'none' };
  }
  const cwd = resolve(ctx.root, step.cwd || '.');
  const argList = (Array.isArray(step.args) ? step.args : []).map(String);
  const shell = step.shell !== false; // 默认过 shell（现场命令是命令行形态）
  const argv = argList.map((s) => (/[\s"'&|<>^()%]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s));
  const line = [cmd, ...argv].join(' ');
  const dir = join(ctx.scratch, 'run');
  mkdirSync(dir, { recursive: true });
  const tag = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const oF = join(dir, `${tag}.out`), eF = join(dir, `${tag}.err`);
  const timeoutMs = Number.isInteger(step.timeoutMs) ? step.timeoutMs : 600000;

  const baseEnv = {
    ...process.env,
    // ★ 沙箱下"管道即 EPERM"，所以子进程的临时目录必须留在工作区内。
    TEMP: join(ctx.scratch, 'tmp'),
    TMP: join(ctx.scratch, 'tmp'),
    ...(step.env || {}),
  };
  baseEnv.TEMP = resolve(ctx.root, baseEnv.TEMP);
  baseEnv.TMP = resolve(ctx.root, baseEnv.TMP);
  mkdirSync(baseEnv.TEMP, { recursive: true });

  const spawnOpts = (stdio) => ({
    cwd, env: baseEnv, windowsHide: true, timeout: timeoutMs,
    ...(shell ? { shell: true, stdio } : { shell: false, stdio }),
  });
  const invoke = (stdio) => (shell ? spawnSync(line, spawnOpts(stdio)) : spawnSync(cmd, argList, spawnOpts(stdio)));

  // 第一优先：inherit（Lead 硬要求；也避开本沙箱的管道/句柄限制）。
  // 但 inherit 拿不到 stdout，所以默认走 fd 重定向；fd 被环境拒绝时**回落 inherit**。
  let r = null; let capture = 'fd'; let oFd = null; let eFd = null;
  const t0 = Date.now();
  try {
    oFd = openSync(oF, 'w');
    eFd = openSync(eF, 'w');
    r = invoke(['ignore', oFd, eFd]);
  } catch (err) {
    r = { status: null, error: err, signal: null };
  } finally {
    if (oFd !== null) closeSync(oFd);
    if (eFd !== null) closeSync(eFd);
  }
  // fd 捕获本身失败（句柄/权限类）⟹ 回落 inherit，只取真实退出码，不声称有输出
  if (r && r.error && ['EPERM', 'EACCES', 'ENOTSUP', 'EBADF'].includes(r.error.code)) {
    try {
      r = invoke('inherit');
      capture = 'inherit';
    } catch (err) {
      r = { status: null, error: err, signal: null };
      capture = 'none';
    }
  }
  const ms = Date.now() - t0;

  const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  const stdout = capture === 'fd' ? read(oF) : '';
  const stderr = capture === 'fd' ? read(eF) : '';
  // 不留临时文件
  rmSync(oF, { force: true });
  rmSync(eF, { force: true });

  return {
    ran: true,
    line,
    cwd,
    capture,
    status: r.status,
    signal: r.signal ?? null,
    error: r.error ? { code: r.error.code || null, message: r.error.message } : null,
    // ★ harness 字段（SPEC §3.3）：把"工具/环境失败"从"判据未过"里**分开记**。
    //   现场代价（INVENTORY §2）：二代脚本里 exit 2（前置不满足）、exit $LASTEXITCODE（转发）、
    //   throw（异常）三种语义混在一起，调用方无法区分"判据没通过"与"根本没跑起来"。
    harness: r.error ? 'spawn_error'
      : (r.status === null ? (r.signal ? 'signal' : 'no_status') : 'exited'),
    ms,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// 描述符校验
// ---------------------------------------------------------------------------
export function validateTask(task) {
  const errs = [];
  if (!task || typeof task !== 'object') return ['描述符不是对象'];
  if (typeof task.taskId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(task.taskId)) {
    errs.push('taskId 缺失或含非法字符（只允许 [A-Za-z0-9._-]）');
  }
  if (!Array.isArray(task.acceptance)) {
    errs.push('acceptance 必须是数组');
    return errs;
  }
  // notRun[]：本沙箱跑不了的域**必须**在这里声明（含前置条件与真命令），
  // 且**不许**把它们写进 acceptance 去换一个 exit 0（TASK.2 §1）。
  const notRun = Array.isArray(task.notRun) ? task.notRun : [];
  if (task.notRun !== undefined && !Array.isArray(task.notRun)) {
    errs.push('notRun 必须是数组');
  }
  for (const nr of notRun) {
    if (!nr || typeof nr.id !== 'string') { errs.push('notRun 条目缺 id'); continue; }
    if (typeof nr.what !== 'string' || !nr.what) errs.push(`notRun ${nr.id}：缺 what（它是什么检查）`);
    if (typeof nr.why !== 'string' || !nr.why) errs.push(`notRun ${nr.id}：缺 why（为什么跑不了）`);
    if (typeof nr.precondition !== 'string' || !nr.precondition) {
      errs.push(`notRun ${nr.id}：缺 precondition（前置条件必须写明，TASK.2 §1）`);
    }
  }
  // 一个域要么有可判的断言，要么有 notRun 声明；两者皆空 = 空壳描述符，拒收
  if (task.acceptance.length === 0 && notRun.length === 0) {
    errs.push('acceptance 为空且 notRun 为空 ⟹ 空壳描述符：要么给可判断言，要么声明为什么跑不了');
  }
  // 反绕过：跑不了的域不许把"真命令"塞进 acceptance 换个退出码
  if (notRun.length > 0 && task.acceptance.length === 0) {
    // 合法形态（notRun-only）：不做额外处理，runTask 会给出 verdict=UNVERIFIED
  }
  const covered = [];
  for (const a of task.acceptance) {
    if (!a || typeof a.id !== 'string') { errs.push('acceptance 条目缺 id'); continue; }
    covered.push(a.id);
    const hasAssert = typeof a.assert === 'string' && a.assert.length > 0;
    const hasCmd = typeof a.cmd === 'string' && a.cmd.length > 0;
    const hasExit = Number.isInteger(a.exit);

    if (!hasAssert && !hasCmd) {
      errs.push(`断言 ${a.id}：既没有 assert 串也没有 cmd ⟹ 无判据，拒收（未验证不得当通过）`);
    } else if (!hasAssert) {
      // SPEC §3.1 的主形态：{ cmd, exit } —— 判据就是**真实退出码 vs 声明退出码**。
      if (!hasExit) {
        errs.push(`断言 ${a.id}：有 cmd 但没有 assert，也没有整数 exit ⟹ 没有可比的判据`
          + '（要么给 exit，要么给 assert；两者都缺 = 未声明，拒收）');
      }
    } else {
      const ops = ['exists:', 'not_exists:', 'path_contains:', 'stdout_contains:'];
      if (!ops.some((p) => a.assert.startsWith(p))) {
        errs.push(`断言 ${a.id}：未知算子（v0 白名单 ${ops.join(' / ')}）`);
      }
      if (a.assert.startsWith('stdout_contains:') && !hasCmd) {
        errs.push(`断言 ${a.id}：stdout_contains: 需要一个 cmd`);
      }
    }
    if (a.exit !== undefined && a.exit !== null && !Number.isInteger(a.exit)) {
      errs.push(`断言 ${a.id}：exit 必须是整数（收到 ${JSON.stringify(a.exit)}）`);
    }
    if (a.envFailCodes !== undefined
      && (!Array.isArray(a.envFailCodes) || a.envFailCodes.some((n) => !Number.isInteger(n)))) {
      errs.push(`断言 ${a.id}：envFailCodes 必须是整数数组`);
    }
  }
  if (Array.isArray(task.coveredBy)) {
    for (const id of task.coveredBy) {
      if (!covered.includes(id)) errs.push(`coveredBy 引用了不存在的断言 id：${id}`);
    }
  } else if (Array.isArray(task.files) && task.files.length > 0 && covered.length === 0 && notRun.length === 0) {
    // notRun-only 的域允许 files 非空（那是"本该被验、但本轮没验"的文件清单）
    errs.push('files 非空但 acceptance 为空且没有 notRun 声明：没有断言可判，不收');
  }
  if (task.level !== undefined && !['L1', 'L2-S', 'L2-F', 'L3'].includes(task.level)) {
    errs.push(`level 非法：${JSON.stringify(task.level)}（白名单 L1 / L2-S / L2-F / L3）`);
  }
  // hashFiles[]：收口判"证据是否过期"的显式文件清单（R3a）
  if (task.hashFiles !== undefined
    && (!Array.isArray(task.hashFiles) || task.hashFiles.some((x) => typeof x !== 'string' || !x))) {
    errs.push('hashFiles 必须是"非空字符串"数组');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// 主流程：真跑 → 四态 → 证据 JSON
// ---------------------------------------------------------------------------
export function runTask({ task, taskPath, root, outDir }) {
  // ★ 临时区在**工作区根的 .scratch**（不在 evidence 里）：evidence 只放证据（R1.1 修正）。
  const scratch = scratchDir(root);
  const outMax = Number.isInteger(task.evidenceMaxChars) ? task.evidenceMaxChars : DEFAULT_OUT_MAX;
  const ctx = { root, scratch, cwd: root };
  const dw = dirname(taskPath);
  const startedAt = new Date();
  const t0 = Date.now();

  // 被验文件 = 断言里按路径点名的目标（SPEC §3.3「被验文件哈希」）
  const hashTargets = [];
  for (const a of task.acceptance) {
    if (typeof a.assert !== 'string') continue;
    if (a.assert.startsWith('exists:') || a.assert.startsWith('not_exists:')) {
      hashTargets.push(a.assert.slice(a.assert.indexOf(':') + 1).trim());
    } else if (a.assert.startsWith('path_contains:')) {
      const body = a.assert.slice(a.assert.indexOf(':') + 1);
      const sep = body.indexOf('::');
      if (sep > 0) hashTargets.push(body.slice(0, sep).trim());
    }
  }
  // ★ R3a：`hashFiles[]`（描述符显式声明）—— "这份证据钉住哪些文件"。
  //   与断言自动收集的 hashTargets 合并；close.mjs 收口时逐条重算。
  const declaredHashFiles = (Array.isArray(task.hashFiles) ? task.hashFiles : []).map(String);
  const uniqTargets = [...new Set([...hashTargets, ...declaredHashFiles])];
  const pre = new Map(uniqTargets.map((r) => {
    const t = resolveTarget(r, dw, root);
    return [r, { ...t, sha256: sha256File(t.abs), exists: pathExists(t.abs) }];
  }));

  // noWrite 前置快照（SPEC §3.5 之 4：默认只读、幂等）
  // 快照**内容**（size+mtime+sha），不是只看"在不在"。
  // ★ 关键：解析不到目标的 noWrite 条目要**显式记为未解析**——
  //   否则"什么都没快照到"会伪装成"零变化"，那是 A5 里最容易出现的假绿。
  const noWrite = Array.isArray(task.noWrite) ? task.noWrite : [];
  const noWritePre = new Map(noWrite.map((p) => {
    const t = resolveTarget(p, dw, root);
    const files = snapshotPath(t.abs);
    return [p, { ...t, files, unresolved: files.length === 0 }];
  }));

  const evaluated = [];
  for (const a of task.acceptance) {
    const rec = {
      id: a.id,
      what: typeof a.what === 'string' ? a.what : null,
      declaration: {
        assert: typeof a.assert === 'string' ? a.assert : null,
        cmd: typeof a.cmd === 'string' ? a.cmd : null,
        args: Array.isArray(a.args) ? a.args : [],
        cwd: a.cwd || '.',
        exit: a.exit === undefined ? null : a.exit,
        envFailCodes: Array.isArray(a.envFailCodes) ? a.envFailCodes : [],
        env: a.env || {},
      },
      real: { exit: null, stdout: null, stderr: null, ms: null, signal: null },
      oracle: null,
      files: [],
      state: 'UNVERIFIED',
      basis: '',
      notes: [],
    };

    const declaredCmd = typeof a.cmd === 'string' && a.cmd.trim().length > 0;
    const asserted = typeof a.assert === 'string' ? a.assert : '';
    const hasDeclaredExit = a.exit !== undefined && a.exit !== null;
    const isCommandOracle = declaredCmd || asserted.startsWith('stdout_contains:');

    if (isCommandOracle && declaredCmd) {
      const r = runStep(a, ctx);
      rec.real.exit = r.status;
      rec.real.signal = r.signal ?? null;
      rec.real.ms = r.ms;
      rec.real.cwd = r.cwd;
      rec.real.line = r.line;
      rec.real.capture = r.capture;
      rec.real.harness = r.harness;
      rec.real.error = r.error;
      rec.real.stdout = clamp(r.stdout, outMax);
      rec.real.stderr = clamp(r.stderr, outMax);
      rec.real.outputNote = '截断保留【首+尾】（尾 = 终判串所在处）；outMax=' + outMax;
      errIf(rec, r);
    } else if (isCommandOracle) {
      // stdout_contains: 但没有 cmd（validateTask 已拦，这里兜底）
      rec.state = 'UNVERIFIED';
      rec.basis = 'stdout_contains: 缺少 cmd ⟹ 未跑';
      evaluated.push(rec);
      continue;
    }

    if (isCommandOracle) {
      rec.oracle = hasDeclaredExit ? 'exit_code'
        : (asserted.startsWith('stdout_contains:') ? 'stdout_contains' : 'path');
      if (declaredCmd) {
        const d = decideExitState(
          { status: rec.real.exit, error: rec.real.error, signal: rec.real.signal },
          { exit: a.exit, envFailCodes: a.envFailCodes },
        );
        rec.state = d.state;
        rec.basis = d.reason;
      }
      if (asserted.startsWith('stdout_contains:')) {
        const ev = evalAssert(asserted, { dw, root, stdout: `${rec.real.stdout ? rec.real.stdout.text : ''}${rec.real.stderr ? rec.real.stderr.text : ''}` });
        if (!declaredCmd) {
          rec.oracle = 'stdout_contains';
          rec.state = ev.ok ? 'PASS' : 'HONEST_FAIL';
          rec.basis = `仅按 stdout 判据（未声明退出码）：${ev.detail}`;
        } else if (ev.ok && rec.state === 'PASS') {
          rec.basis += `；且 ${ev.detail}（结论串佐证）`;
          rec.oracle = 'exit_code + stdout_contains';
        } else if (!ev.ok) {
          rec.notes.push('结论串未命中：' + ev.detail
            + ' ⟹ 退出码说"过"而文本判据说"没看到结论串"，按更强者取红（禁止只看退出码就宣告通过）');
          if (rec.state === 'PASS') rec.state = 'HONEST_FAIL';
          rec.basis += `；但 ${ev.detail}`;
        }
      }
    } else {
      // 纯文件/路径判据（**不产生退出码** —— SPEC §3.3；只进 evaluated[]，不伪造 exit）
      const ev = evalAssert(asserted, { dw, root, stdout: '' });
      rec.oracle = asserted.startsWith('path_contains:') ? 'path_string' : 'path';
      rec.state = ev.ok ? 'PASS' : 'HONEST_FAIL';
      rec.basis = `文件/路径判据（不产生退出码）：${ev.detail}`;
      // ★ 靶子（operand）由**下面统一的哈希循环**补进 rec.files —— 那里用的是真路径。
      //   踩过的坑（R3a，由 close.mjs 的 canary 抓出）：这里曾经 `path: asserted`，
      //   把**整条断言串**（`exists:xxx`）当成路径记进 files[].path。
      //   从 R1 起就这么记，**一直没人发现**，因为 R1/R2 没有任何消费者读 `files[].path`；
      //   R3a 的 close.mjs 第一次真读它，于是每条 `exists:` 断言都多出一个**永远解析不到**的
      //   phantom pin ⟹ close 变成**恒红**（"恒红也不算过"）。
      //   教训：**没人读的字段不算被验证过**。
    }

    // 被验文件哈希（实测，跑完后取；带 base 便于复算）
    for (const t of uniqTargets) {
      if (rec.declaration.assert && (rec.declaration.assert.endsWith(t) || rec.declaration.assert.includes(`${t}::`))) {
        const rt = resolveTarget(t, dw, root);
        const now = { sha256: sha256File(rt.abs), exists: pathExists(rt.abs) };
        const before = pre.get(t);
        rec.files.push({ path: t, abs: rt.abs, base: rt.base, sha256: now.sha256, exists: now.exists, changedByCommand: before.exists !== now.exists || before.sha256 !== now.sha256 });
      }
    }

    const note = readOnlyNote(rec.declaration.cmd);
    if (note) rec.notes.push(note);

    evaluated.push(rec);
  }

  // noWrite 实测
  // noWrite 实测：内容快照逐条比对；"解析不到"必须响亮，不得静默当 CLEAN
  const noWriteResults = [];
  for (const [p, before] of noWritePre) {
    const after = snapshotPath(before.abs);
    const changed = JSON.stringify(before.files) !== JSON.stringify(after);
    const verdict = changed ? 'VIOLATED' : (before.files.length === 0 ? 'UNRESOLVED' : 'CLEAN');
    noWriteResults.push({
      path: p, resolved: before.abs, base: before.base,
      files: after.length, changed, verdict,
      note: verdict === 'UNRESOLVED'
        ? 'noWrite 目标解析不到任何文件 ⟹ 本条**没有验证能力**（不是"干净"），请修描述符或去掉该条'
        : null,
    });
  }

  const states = evaluated.map((e) => e.state);
  const verdict = verdictOf(states);
  const failed = evaluated.filter((e) => e.state !== 'PASS');
  // notRun：**第一类**声明（TASK.2 §1/§3-A3）。这些域只有这一处出现：
  // 它们**不产生任何 PASS 断言**，也不曾被塞进求值数组去换一个退出码。
  const notRun = Array.isArray(task.notRun) ? task.notRun.map((nr) => ({
    id: nr.id,
    what: nr.what,
    why: nr.why,
    precondition: nr.precondition,
    realCommand: nr.realCommand ?? null,
    cwd: nr.cwd ?? null,
    exitSemantics: nr.exitSemantics ?? null,
  })) : [];
  const noWriteViolated = noWriteResults.filter((r) => r.verdict === 'VIOLATED');
  const noWriteUnresolved = noWriteResults.filter((r) => r.verdict === 'UNRESOLVED');
  const gateOk = verdict === 'PASS' && noWriteViolated.length === 0 && noWriteUnresolved.length === 0;

  // ---------------------------------------------------------------------------
  // pins：收口（`gate/close.mjs`）用来判"这份证据是否已过期"的哈希集合。
  //
  // ★ 为什么必须**自动**钉住判据机器与描述符：R2 的证据里，文件哈希只来自
  //   `exists:`/`path_contains:` 这类**按路径点名**的断言；像 `docs` 域那样全靠
  //   `stdout_contains:` 的任务，`evaluated[].files[]` 是**空的** ——
  //   于是"哈希漂移"这条拒绝路径在那些域上**无哈希可查**，等于不可达。
  //   自动钉住「描述符 + runner/env/gate 三个文件」让每个域都有漂移判据。
  //   代价（有意接受并写进 SPEC）：**改了判据机器，旧证据一律作废，必须重跑**。
  // ---------------------------------------------------------------------------
  const GATE_DIR = resolve(import.meta.dirname, '..');
  const relOf = (p) => relative(root, p).replace(/\\/g, '/');
  const pin = (abs, note) => ({
    path: relOf(abs), abs, exists: pathExists(abs), sha256: sha256File(abs, 64), note,
  });
  const pins = {
    policy: '收口时（gate/close.mjs）逐条重算；任一不符 ⟹ 证据已过期，拒绝收口。改了判据机器/描述符就必须重跑。',
    descriptor: pin(resolve(taskPath), '任务描述符：改了它，旧证据即作废'),
    machinery: [
      join(GATE_DIR, 'gate.mjs'),
      join(GATE_DIR, 'lib', 'runner.mjs'),
      join(GATE_DIR, 'lib', 'env.mjs'),
    ].map((p) => pin(p, '判据机器：改了它，旧证据即作废（换机器 / 升级 runner 后必须重跑）')),
    declared: declaredHashFiles.map((d) => pin(resolveTarget(d, dw, root).abs, '描述符 hashFiles[] 声明')),
  };

  const evidence = {
    schema: 'gate-evidence/v0',
    taskId: task.taskId,
    taskPath: resolve(taskPath),
    level: task.level ?? null,
    claimsWhat: task.claimsWhat ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cwd: process.cwd(),
      root: resolve(root),
      runtimes: runtimeFacts(process.env),
      note: 'spawnSync 管道在本沙箱下 EPERM ⟹ runner 用 fd 重定向捕获输出（被拒时回落 inherit）；TEMP/TMP 已钉进工作区并在收尾清理',
    },
    taskState: { gateOk, verdict, counts: countBy(states) },
    // ★ notRun 的**唯一**落点：只有声明、没有断言。跑不了的域不会出现在 evaluated[] 里，
    //   因此不可能贡献 PASS（TASK.2 §3-A3：零 PASS 断言）。
    notRun,
    notRunCount: notRun.length,
    pins,
    noWriteDeclared: task.noWrite || [],
    noWriteResults,
    noWriteUnresolved,
    evaluated,
    failed,
  };

  mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const outPath = join(outDir, `gate-${task.taskId}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
  // 一行索引：便于 grep 与"证据在哪"的追问
  appendFileSync(join(outDir, 'GATES.log'), `${gateRef(evidence)}\t${outPath}\n`, 'utf8');

  // A5：本次运行产生的临时区（含子进程 TEMP/TMP）在收尾一律清掉
  const scratchCleaned = cleanupScratch(scratch);

  return {
    evidence, outPath, gateLine: gateRef(evidence), scratchCleaned,
    exit: gateOk ? EXIT.PASS : EXIT.GATE_RED,
  };
}

function errIf(rec, r) {
  if (r.error) rec.notes.push(`真实错误：${r.error.code} ${r.error.message}`);
}

export function countBy(states) {
  const c = { PASS: 0, HONEST_FAIL: 0, MISMATCH: 0, UNVERIFIED: 0 };
  for (const s of states) c[s] = (c[s] || 0) + 1;
  return c;
}

/** 一行人类可读 GATE（SPEC §3.3）。 */
export function gateRef(ev) {
  const c = ev.taskState.counts;
  const nw = ev.noWriteResults.length === 0
    ? 'noWrite=(none-declared)'
    : (ev.noWriteResults.some((r) => r.verdict === 'VIOLATED')
      ? `noWrite=VIOLATED:${ev.noWriteResults.filter((r) => r.verdict === 'VIOLATED').map((r) => r.path).join(',')}`
      : (ev.noWriteResults.some((r) => r.verdict === 'UNRESOLVED')
        ? `noWrite=UNRESOLVED:${ev.noWriteResults.filter((r) => r.verdict === 'UNRESOLVED').map((r) => r.path).join(',')}`
        : `noWrite=clean:${ev.noWriteResults.length}`));
  // ★ 不写 `RED(PASS)` 这种自相矛盾的串：断言裁定与门级裁定分开报。
  // ★★ 踩过的坑：gateOk 挂在 `ev.taskState` 上，早先写成 `ev.gateOk` ⇒ 恒 undefined ⇒
  //     GATE 行**永远**印 gateOk=false，连 12/12 全 PASS 的干净运行也印"门没过"。
  //     一行汇总串如果恒报同一个值，它就不再是证据，是装饰。
  const head = ev.taskState.gateOk ? 'PASS' : `gateOk=false(assertions=${ev.taskState.verdict})`;
  return `GATE ${ev.taskId} ${head}`
    + ` assertions=${ev.evaluated.length}`
    + ` PASS=${c.PASS} HONEST_FAIL=${c.HONEST_FAIL} MISMATCH=${c.MISMATCH} UNVERIFIED=${c.UNVERIFIED}`
    + ` ran=${ev.evaluated.filter((e) => e.real.exit !== null).length} ${nw}`;
}

/** 目录/文件快照：文件 → (size, mtimeMs, sha256[:16])；目录 → 全部文件。 */
export function snapshotPath(p) {
  if (!existsSync(p)) return [];
  const out = [];
  const st = statSync(p);
  if (st.isFile()) {
    out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, sha256: sha256File(p) });
    return out;
  }
  const walk = (d) => {
    for (const e of readDirSafe(d)) {
      const c = join(d, e.name);
      if (e.isDirectory()) walk(c);
      else if (e.isFile()) {
        const s = statSync(c);
        out.push({ path: c, size: s.size, mtimeMs: s.mtimeMs, sha256: sha256File(c) });
      }
    }
  };
  walk(p);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readDirSafe(d) {
  try { return readdirSync(d, { withFileTypes: true }); } catch { return []; }
}

/** 删掉本次运行产生的临时区（A5：不留临时文件；工作区外写入也算违规）。 */
export function cleanupScratch(scratch) {
  try { rmSync(scratch, { recursive: true, force: true }); return true; } catch { return false; }
}
