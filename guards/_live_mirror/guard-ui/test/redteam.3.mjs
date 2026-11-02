/**
 * 第 3 轮修复验证：红队 F1–F4（**改完之后**跑；改之前的行为见 `slices/guard-ui/REPRO.3.md`）。
 *
 * 每节都先写「修前是什么样」（引 REPRO.3.md 的断言），再断言「修后应该是什么样」——
 * 不许只证明「现在没报错」。
 *
 * ⚠ 环境事实（实测，见 REPRO.3.md §0）：
 *   · 只能 `cmd /c mklink /J` + `stdio:'inherit'` 建 junction；`stdio:'pipe'` 会被沙箱 EPERM。
 *   · reparse point 的**目标必须在可写根内** ⇒ 指不到主仓库，故用**替身禁用根**（TASK.3 §1 要求）。
 *   · `fs.realpathSync` **不解析 junction**，只有 `.native` 会 ⇒ F1 的修复必须用 `.native`。
 *
 * 用法：node guards/guard-ui/test/redteam.3.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GUARDS = join(here, '..', '..');
const S = await import(pathToFileURL(join(here, '..', 'lib', 'settings.js')).href);
const HOST = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);

let bad = 0;
const check = (what, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`   ${pass ? 'PASS' : 'FAIL'} ${what}${extra ? `  ${extra}` : ''}`);
};
const mkws = () => mkdtempSync(join(tmpdir(), 'rt3-'));
const mklinkJ = (link, target) => execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'inherit' });
const rmdir = (link) => execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'inherit' });
const PROFILE_SB = { mode: 'set', childPreset: 'fpga-locked' };
const PROFILE_RG = { roleScope: { enabled: true, unknownPolicy: 'guard' }, shellScope: { enabled: true } };

// ══════════════════════════ F1 ══════════════════════════
console.log('=== F1 · HIGH · 黑名单必须基于 realpath（junction 不得绕过）===');
{
  // 保留原有的「前缀陷阱」用例（必须继续通过）
  check('前缀陷阱：%MAIN_REPO%-dsh **不**被误拦', !S.isForbiddenWorkspacePath('%MAIN_REPO%-dsh'));
  check('禁用根本身被拦', S.isForbiddenWorkspacePath('%MAIN_REPO%'));
  check('禁用根的子目录被拦', S.isForbiddenWorkspacePath('%MAIN_REPO%\\sub\\x'));
  const plainTmp = mkws();
  check('普通临时目录不被拦', !S.isForbiddenWorkspacePath(plainTmp));
  rmSync(plainTmp, { recursive: true, force: true });

  // 替身禁用根（本机沙箱不允许把 reparse point 指向主仓库 ⇒ 用替身，TASK.3 §1 要求）
  const root = mkdirSync ? mkdtempSync(join(tmpdir(), 'rt3-j-')) : null;
  const standin = join(root, 'standin-forbidden-root');
  mkdirSync(standin, { recursive: true });
  writeFileSync(join(standin, 'marker.txt'), 'x');
  const alias = join(root, 'alias-to-standin');
  mklinkJ(alias, standin);
  const plain = join(root, 'plain-dir');
  mkdirSync(plain, { recursive: true });
  const aliasPlain = join(root, 'alias-to-plain');
  mklinkJ(aliasPlain, plain);
  try {
    check('junction 已建成（前置）', existsSync(alias) && existsSync(aliasPlain));

    // ★ 修前：`isForbiddenWorkspacePath(alias)` 只看字面 ⇒ 返回 false（放行）。见 REPRO.3.md §1 ②。
    //   修后：真身落在替身禁用根内 ⇒ 必须判禁。
    check('★ F1 修复：指向禁用根的 junction **被判禁**', S.isForbiddenWorkspacePath(alias, [standin]) === true);
    check('★ F1 修复：junction 下的**不存在**子路径同样被判禁（走最近已存在祖先）',
      S.isForbiddenWorkspacePath(join(alias, 'not-yet', '.dsh-guard.json'), [standin]) === true);
    check('F1 未过度拦截：指向**非**禁用根的 junction 仍放行',
      S.isForbiddenWorkspacePath(aliasPlain, [standin]) === false);
    check('F1 未过度拦截：替身根之外的普通目录放行', S.isForbiddenWorkspacePath(root, [standin]) === false);

    // fail-closed：解析不出来的路径必须判禁（而不是放行）
    const unresolvable = 'Z:\\definitely\\not\\a\\drive\\x';
    let threw = false;
    try { S.resolveRealPath(unresolvable); } catch { threw = true; }
    check('★ F1：resolveRealPath 对无法解析的路径抛（不静默返回原文）', threw);
    check('★ F1 fail-closed：解析失败 ⇒ 判禁（不是放行）', S.isForbiddenWorkspacePath(unresolvable) === true);

    // 写/删的目标也必须基于 realpath
    const w = S.writeWorkspaceSettings(alias, { 'subagent-sandbox': { mode: 'off' } }, null, { forbiddenRoots: [standin] });
    check('★ F1：写路径拒绝 junction→禁用根，且**零落盘**',
      !w.ok && !existsSync(join(standin, '.dsh-guard.json')), JSON.stringify(w.errors));
    const d = S.deleteWorkspaceSettings(alias, { forbiddenRoots: [standin] });
    check('★ F1：删除路径同样拒绝', !d.ok, JSON.stringify(d.errors));

    // 允许的 junction：写到**真实落点**（而不是别名那一层）
    const okw = S.writeWorkspaceSettings(aliasPlain, { 'subagent-sandbox': { mode: 'observe' } }, null, { forbiddenRoots: [standin] });
    check('★ F1：允许的 junction ⇒ 写入落到 realpath（目标目录里能看到文件）',
      okw.ok && existsSync(join(plain, '.dsh-guard.json')), JSON.stringify(okw.file));
    check('★ F1：返回的 file 是**解析后**的路径（不含别名段）',
      okw.ok && !okw.file.includes('alias-to-plain'), okw.file);
    check('★ F1：经别名读回也拿到同一份（读路径同样解析）',
      S.readWorkspaceSettings(aliasPlain).status === 'ok'
      && S.readWorkspaceSettings(aliasPlain).value['subagent-sandbox'].mode === 'observe');
  } finally {
    for (const l of [aliasPlain, alias]) { try { if (existsSync(l)) rmdir(l); } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true });
  }
}

// ══════════════════════════ F2 ══════════════════════════
console.log('\n=== F2 · HIGH · 「意外缺 cwd」必须与「P6 有意降级」分开且响亮 ===');
{
  const ws = mkws();
  const unexpected = S.resolvePluginConfig('subagent-sandbox', PROFILE_SB, { id: 'a', session: { id: 's' } });
  const hostLevel = S.resolvePluginConfig('subagent-sandbox', PROFILE_SB, undefined);
  check('★ F2：有 agent 缺 cwd ⇒ reason=agent-cwd-missing', unexpected.reason === 'agent-cwd-missing', unexpected.reason);
  check('★ F2：且 problems 非空（修前是 []，见 REPRO.3.md §2）', unexpected.problems.length > 0);
  check('★ F2：无 agent ⇒ reason=host-level-call（有意降级，保持静默）',
    hostLevel.reason === 'host-level-call' && hostLevel.problems.length === 0, hostLevel.reason);
  check('★ F2：两个 reason 可区分', unexpected.reason !== hostLevel.reason);
  check('★ F2：有 agent 但无 session ⇒ 同样按 agent-cwd-missing 响亮',
    S.resolvePluginConfig('subagent-sandbox', PROFILE_SB, { id: 'a' }).reason === 'agent-cwd-missing');

  // guard 侧：缺 cwd 必须发声
  const logs = [];
  const mod = await import(`${pathToFileURL(join(GUARDS, 'role-guard', 'lib', 'index.js')).href}?t=${Date.now()}`);
  const guards = [];
  const ctx = {
    logger: () => ({ info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }),
    tools: { guard: (fn) => { guards.push(fn); return () => {}; }, schemas: () => [], restrict: () => () => {} },
    effect: (fn) => fn(), on: () => {},
    get: (k) => (k === 'agentTeams' ? { tryMembership: (a) => (a?.id === 's-rev' ? { name: 'reviewer', role: 'teammate' } : undefined) } : undefined),
  };
  mod.apply(ctx, { mode: 'enforce', agentScope: { enabled: false },
    roleScope: { enabled: true, writerNamePatterns: ['writer'], unknownPolicy: 'guard', serviceMissingPolicy: 'guard' },
    shellScope: { enabled: false, toolNames: ['pwsh'], allowPatterns: [] } });
  const wsWarnings = () => logs.filter((l) => l.includes('工作区设置')).length;
  // 有 agent（reviewer）但 session 里**没有** header.cwd
  guards[0]({ name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x', agent: { id: 's-rev', session: { id: 's1' } } });
  check('★ F2：缺 cwd 时 guard **发声**（修前零告警，见 REPRO.3.md §2）',
    wsWarnings() > 0, JSON.stringify(logs.filter((l) => l.includes('工作区设置')).slice(-1)));
  const before = wsWarnings();
  guards[0]({ name: 'mcp__vivado__run_tcl', arguments: {}, callId: 'x' });   // 宿主级调用（无 agent）
  check('★ F2：宿主级调用**保持静默**（有意降级，不刷屏；此处只看「工作区设置」类告警）',
    wsWarnings() === before, `before=${before} after=${wsWarnings()}`);
  rmSync(ws, { recursive: true, force: true });
}

// ══════════════════════════ F2 / F4 · UI 文案 ══════════════════════════
console.log('\n=== F2 / F4 · UI 文案必须条件化、notes 必须被消费 ===');
{
  const registry = new Map();
  globalThis.window = { __ModuleLoader__: { load: (spec) => registry.set(spec.id, spec) } };
  await import(`${pathToFileURL(join(here, '..', 'lib', 'client.js')).href}?t=${Date.now()}`);
  const t = (k) => ({ saveOk: 'SAVED_OK', saveCombinationNotChecked: 'WARN_COMBINATION', saveUnverified: 'WARN_VERIFY',
    saveWithNotes: 'WARN_NOTES', saveScopeCaveat: 'SCOPE', guaranteeDefault: 'CAVEAT' }[k] ?? k);
  const hooks = registry.get('guard-ui').factory((n) => { if (n === 'react') return { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }; throw new Error(n); }).__testHooks;
  check('__testHooks.saveOutcome 存在（纯函数，可离线单测）', typeof hooks.saveOutcome === 'function');

  const good = hooks.saveOutcome({ combinationCheckedWithProfile: true, verified: true, notes: [], cwdGuarantee: { caveat: 'CAVEAT' } }, t);
  check('全绿 ⇒ level=ok 且含成功文案', good.level === 'ok' && good.text.includes('SAVED_OK'), JSON.stringify(good));
  check('★ F4：全绿时也带「生效范围」caveat（cwd 可选，不能无条件承诺）', good.text.includes('CAVEAT'));

  const noProfile = hooks.saveOutcome({ combinationCheckedWithProfile: false, verified: true, notes: [], cwdGuarantee: { caveat: 'CAVEAT' } }, t);
  check('★ F4：组合未与 profile 校验 ⇒ level=warn', noProfile.level === 'warn');
  check('★ F4：且**不出现**「下次生效」式成功文案（修前无条件出现，见 REPRO.3.md §2）',
    !noProfile.text.includes('SAVED_OK'), JSON.stringify(noProfile.text));
  check('★ F4：且明确说明 guard 会整份弃用', noProfile.text.includes('WARN_COMBINATION'));

  const unverified = hooks.saveOutcome({ combinationCheckedWithProfile: true, verified: false, notes: [], cwdGuarantee: { caveat: 'CAVEAT' } }, t);
  check('★ F3：回读校验未通过 ⇒ level=warn 且如实告知可能被并发覆盖',
    unverified.level === 'warn' && unverified.text.includes('WARN_VERIFY'));

  const withNotes = hooks.saveOutcome({ combinationCheckedWithProfile: false, verified: true, notes: ['NOTE_A', 'NOTE_B'], cwdGuarantee: { caveat: 'CAVEAT' } }, t);
  check('★ F4：notes **逐条呈现**（修前完全丢弃，见 REPRO.3.md §2）',
    withNotes.text.includes('NOTE_A') && withNotes.text.includes('NOTE_B'), JSON.stringify(withNotes.text));

  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
  check('★ F4：客户端源码确实引用这两个字段', src.includes('combinationCheckedWithProfile') && src.includes('notes'));
  check('★ F3：客户端提交/删除时带上文件令牌', src.includes('fileToken') && /expect:/.test(src));

  // ★★ 第 2 轮红队 F4-P2-1：**这个组合上一轮漏测了**（两标志为真 + notes 非空）。
  //     旧实现判级只看 !verified / !withProfile ⇒ 仍输出 saveOk（见 REPRO.4.md 第一段）。
  const bothTrueWithNotes = hooks.saveOutcome(
    { combinationCheckedWithProfile: true, verified: true, notes: ['LIMIT_X'], cwdGuarantee: { caveat: 'CAVEAT' } }, t);
  check('★ F4-P2-1：两标志为真 + notes 非空 ⇒ **不得**输出无条件成功文案',
    bothTrueWithNotes.level === 'warn' && !bothTrueWithNotes.text.includes('SAVED_OK'), JSON.stringify(bothTrueWithNotes));
  check('★ F4-P2-1：且给的是「有限定语」而非静默成功', bothTrueWithNotes.text.includes('WARN_NOTES'));
  check('★ F4-P2-1：notes 内容仍逐条呈现', bothTrueWithNotes.text.includes('LIMIT_X'));
  // 反向守卫：notes 为空且两标志为真 ⇒ 仍须成功文案，别把正常路径也压成 warn
  check('★ F4-P2-1 反向：notes 为空且两标志为真 ⇒ 仍 level=ok + 成功文案',
    good.level === 'ok' && good.text.includes('SAVED_OK'));

  // ★★ 第 2 轮红队 F2-P2-1：页面 caveat 必须把两类回落**分开说**，且与 settings.js 行为一致
  const idx = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');
  const caveatRegion = idx.slice(idx.indexOf('cwdGuarantee'), idx.indexOf('fileToken: fileToken(ws.path)'));
  check('★ F2-P2-1：caveat 明说宿主级调用是**静默**的',
    /宿主级调用[^。]{0,60}(静默|不告警|不记录|不会告警)/.test(caveatRegion), '未找到「宿主级调用…静默」');
  check('★ F2-P2-1：caveat 明说 agent-cwd-missing 是**响亮**的',
    /agent-cwd-missing[^。]{0,40}(响亮|warn|事件)/.test(caveatRegion) || /响亮记录[^。]{0,40}agent-cwd-missing/.test(caveatRegion));
  // 与 settings.js 的真实行为逐字对照
  const hostSilent = S.resolvePluginConfig('subagent-sandbox', { mode: 'set' }, undefined);
  const cwdLoud = S.resolvePluginConfig('subagent-sandbox', { mode: 'set' }, { id: 'a', session: {} });
  check('★ F2-P2-1：文案与行为一致（host-level-call 确为静默 / agent-cwd-missing 确为响亮）',
    hostSilent.reason === 'host-level-call' && hostSilent.problems.length === 0
    && cwdLoud.reason === 'agent-cwd-missing' && cwdLoud.problems.length > 0);

  // ★★ 第 2 轮红队 F1-P2-2：禁用根解析失败**仅 ENOENT 退化**，其它 fail-closed
  const badRoot = 'E:\\\u0000bad-root';
  let badRootCode = null;
  try { S.resolveRealPath(badRoot); } catch (e) { badRootCode = e?.code; }
  check('✓ 前置：坏根确实抛非 ENOENT', badRootCode !== null && badRootCode !== 'ENOENT', String(badRootCode));
  check('★ F1-P2-2：坏根（非 ENOENT）⇒ **fail-closed 判禁**（修前退化成字面比较后放行，见 REPRO.4.md）',
    S.isForbiddenWorkspacePath('%MAIN_REPO%-dsh', [badRoot]) === true);
  check('★ F1-P2-2：正当退化仍保留 —— 不存在的禁用根（ENOENT）不得把全部工作区全拒',
    S.isForbiddenWorkspacePath('%MAIN_REPO%-dsh', ['%MAIN_REPO%']) === false);
  check('★ F1-P2-2：正常根行为不变（前缀陷阱 + 真禁用根仍拦）',
    !S.isForbiddenWorkspacePath('%MAIN_REPO%-dsh', ['%MAIN_REPO%'])
    && S.isForbiddenWorkspacePath('%MAIN_REPO%\\sub', ['%MAIN_REPO%']));
}

// ══════════ 第 3 轮红队 F4-NEW-1：**渲染层**判据（只验 level 不算） ══════════
console.log('\n=== F4-NEW-1 · 渲染层：warn 不得带 loadFailed 前缀；err 必须带 ===');
{
  // 用**预置 state 的 fake React** 真渲染组件，读「会显示给用户的文本」。
  // ⚠ fake React 必须在 factory **之前**建好：组件闭包在 factory 执行时就捕获了 React（本次踩过）。
  const harness = { seed: [], cursor: 0, React: null };
  harness.React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => { const i = harness.cursor++; return [i < harness.seed.length ? harness.seed[i] : init, () => {}]; },
    useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }),
  };
  const registry2 = new Map();
  globalThis.window = { __ModuleLoader__: { load: (spec) => registry2.set(spec.id, spec) } };
  await import(`${pathToFileURL(join(here, '..', 'lib', 'client.js')).href}?t=render-${Date.now()}`);
  let Section = null;
  const cmod = registry2.get('guard-ui').factory((n) => {
    if (n === 'react') return harness.React;
    throw new Error(`unstubbed ${n}`);
  });
  cmod.apply({
    effect: (fn) => fn(),
    slots: { inject: (s, f) => f(), register: (d, C) => { Section = C; return () => {}; } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  });
  const H = cmod.__testHooks;
  const LOAD_FAILED = H.zh.loadFailed;
  const T = (k) => (k === 'loadFailed' ? LOAD_FAILED : { saveOk: 'SAVED_OK', saveWithNotes: 'WARN_NOTES',
    saveScopeCaveat: 'SCOPE', guaranteeDefault: 'CAVEAT' }[k] ?? k);

  const flat2 = (node, out = []) => {
    if (node === null || node === undefined || node === false) return out;
    if (Array.isArray(node)) { for (const n of node) flat2(n, out); return out; }
    if (typeof node !== 'object') { out.push(node); return out; }
    out.push(node);
    if (node.children) for (const c of node.children) flat2(c, out);
    return out;
  };
  /** 把给定 msg 状态真渲染一遍，返回消息区**真正会显示**的文本 */
  const renderMsg = (msg) => {
    const ws = '%MAIN_REPO%-dsh';
    const data = {
      workspace: { id: 'w1', path: ws, title: 'T', file: join(ws, '.dsh-guard.json'), fileName: '.dsh-guard.json' },
      knobs: [{ plugin: 'subagent-sandbox', path: 'mode', label: '模式', control: 'radio', values: ['off', 'observe', 'set'],
        valueLabels: { off: '关', observe: '只观察', set: '真落档' }, doc: '', builtin: 'observe',
        workspace: null, profile: 'set', effective: 'set', source: 'profile' }],
      source: { key: 'profile' }, defaults: {}, defaultsSource: 'profile',
      defaultsDetail: { used: true, reason: null }, extras: {}, workspaceFileStatus: 'absent', problems: [],
      cwdGuarantee: { caveat: 'CAVEAT' }, fileToken: { exists: false },
    };
    harness.seed = [[{ id: 'w1', path: ws, title: 'T' }], 'w1', data, { 'subagent-sandbox::mode': 'set' }, false, msg];
    harness.cursor = 0;
    const tree = Section();
    const nodes = flat2(tree).filter((n) => typeof n === 'object'
      && typeof n.props?.className === 'string' && n.props.className.includes('gu-msg'));
    return nodes.flatMap((n) => flat2(n).filter((c) => typeof c === 'string')).join('\n');
  };

  // ★ 判据 1：notes 非空 ⇒ 渲染文本**不含** loadFailed 前缀（走完整链：响应 → saveOutcome → 通道 → 渲染）
  const resWithNotes = { combinationCheckedWithProfile: true, verified: true, notes: ['LIMIT_X'], cwdGuarantee: { caveat: 'CAVEAT' } };
  const warnMsg = H.msgForOutcome(H.saveOutcome(resWithNotes, T));
  const warnRendered = renderMsg(warnMsg);
  check('★ F4-NEW-1：notes 非空 ⇒ 渲染文本**不含** loadFailed 前缀',
    !warnRendered.includes(LOAD_FAILED), JSON.stringify(warnRendered));
  check('★ F4-NEW-1：且仍如实说明「有保留」（不是静默成功）', warnRendered.includes('WARN_NOTES'));
  check('★ F4-NEW-1：互斥 —— warn 类结论只占 warn 通道（ok/err 均为空）',
    warnMsg.warn !== '' && warnMsg.ok === '' && warnMsg.err === '', JSON.stringify(warnMsg));

  // ★ 判据 2：真失败 ⇒ 渲染文本**含** loadFailed 前缀
  const errRendered = renderMsg(H.singleChannel('err', 'REAL_FAILURE'));
  check('★ F4-NEW-1：真失败 ⇒ 渲染文本**含** loadFailed 前缀',
    errRendered.includes(LOAD_FAILED) && errRendered.includes('REAL_FAILURE'), JSON.stringify(errRendered));

  // 判据 3：成功无保留 ⇒ 不带前缀
  const okRendered = renderMsg(H.singleChannel('ok', 'SAVED_OK'));
  check('★ F4-NEW-1：成功无保留 ⇒ 渲染文本不带 loadFailed 前缀', !okRendered.includes(LOAD_FAILED), JSON.stringify(okRendered));

  // 判据 4：三条通道互斥（单通道赋值器只点亮一个）
  check('★ F4-NEW-1：singleChannel 保证互斥',
    ['ok', 'warn', 'err'].every((k) => {
      const m = H.singleChannel(k, 'x');
      return Object.values(m).filter((v) => v !== '').length === 1 && m[k] === 'x';
    }));
  // 判据 5：warn 有自己的样式类，不冒充成功也不冒充失败
  const csrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
  check('★ F4-NEW-1：warn 通道有自己的样式类（gu-warn-msg）', /gu-warn-msg/.test(csrc));
  check('★ F4-NEW-1：渲染层统一由 messageRows 生成（只有 err 加前缀）',
    /messageRows\(msg, t\)\.forEach/.test(csrc));
}

// ══════════════════════════ F3 ══════════════════════════
console.log('\n=== F3 · MEDIUM · 回读校验 + 读删一致性预检 ===');
{
  const ws = mkws();
  const w1 = S.writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'off' } }, null);
  check('★ F3：写入后回读校验通过（verified=true）', w1.ok && w1.verified === true, JSON.stringify({ v: w1.verified }));

  const tok = S.fileToken(ws);
  check('fileToken 反映现状', tok.exists === true && typeof tok.mtimeMs === 'number' && typeof tok.size === 'number', JSON.stringify(tok));

  // 令牌过期（别人改过）⇒ 拒绝写入，且不动文件
  const stale = { exists: true, mtimeMs: tok.mtimeMs - 12345, size: tok.size };
  const beforeRaw = readFileSync(join(ws, '.dsh-guard.json'), 'utf8');
  const w2 = S.writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'set' } }, null, { expect: stale });
  check('★ F3：令牌过期 ⇒ 拒绝写入并报 conflict', !w2.ok && w2.conflict === true, JSON.stringify(w2.errors));
  check('★ F3：拒绝时文件**未被改动**', readFileSync(join(ws, '.dsh-guard.json'), 'utf8') === beforeRaw);

  // 令牌新鲜 ⇒ 放行
  const w3 = S.writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'set' } }, null, { expect: S.fileToken(ws) });
  check('令牌新鲜 ⇒ 写入成功', w3.ok === true, JSON.stringify(w3.errors));

  // reset：令牌过期 ⇒ 拒绝删除（修前会直接删掉，见 REPRO.3.md §3b）
  const curTok = S.fileToken(ws);
  const d1 = S.deleteWorkspaceSettings(ws, { expect: { exists: true, mtimeMs: curTok.mtimeMs - 1, size: curTok.size } });
  check('★ F3：reset 令牌过期 ⇒ 拒绝删除且文件仍在', !d1.ok && d1.conflict === true && existsSync(join(ws, '.dsh-guard.json')), JSON.stringify(d1.errors));
  const d2 = S.deleteWorkspaceSettings(ws, { expect: S.fileToken(ws) });
  check('reset 令牌新鲜 ⇒ 删除成功', d2.ok === true && !existsSync(join(ws, '.dsh-guard.json')));

  // 不存在时的令牌语义
  check('文件不存在时 fileToken.exists=false', S.fileToken(ws).exists === false);
  const w4 = S.writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'set' } }, null, { expect: { exists: false, mtimeMs: null, size: null } });
  check('令牌说「不存在」且确实不存在 ⇒ 放行（首次写）', w4.ok === true);
  const w5 = S.writeWorkspaceSettings(ws, { 'subagent-sandbox': { mode: 'off' } }, null, { expect: { exists: false, mtimeMs: null, size: null } });
  check('★ 令牌说「不存在」但文件已被他人创建 ⇒ 拒绝（不覆盖）', !w5.ok && w5.conflict === true);
  rmSync(ws, { recursive: true, force: true });
}

// ══════════════════════════ F4 ══════════════════════════
console.log('\n=== F4 · MEDIUM · 读不到 profile 现值不得冒充「已权威校验」 ===');
{
  const ws1 = mkws();
  const ctxNoEditor = {
    get: (k) => (k === 'workspaceRegistry' ? { list: () => [{ id: 'w1', path: ws1 }], get: () => ({ id: 'w1', path: ws1 }) } : undefined),
    effect: (fn) => fn(), logger: () => ({ info() {}, warn() {}, error() {} }), webServer: { register: () => () => {} },
  };
  // ★ 修前：传 `{}` 被 isPlainObject 当成「权威校验」⇒ notes 为 []、combinationCheckedWithProfile=false 却无解释
  const r1 = HOST.__test.handlers['settings.set'](ctxNoEditor)({ workspaceId: 'w1', patch: { 'subagent-sandbox': { mode: 'off' } } });
  check('★ F4：读不到 profile ⇒ notes **非空**（修前是 []，见 REPRO.3.md §4）', (r1.notes ?? []).length > 0, JSON.stringify(r1.notes));
  check('★ F4：combinationCheckedWithProfile=false 且 combinationChecked 标 file-internal-only',
    r1.combinationCheckedWithProfile === false && r1.combinationChecked['subagent-sandbox'] === 'file-internal-only',
    JSON.stringify(r1.combinationChecked));
  check('★ F4：给出可读的 detail 理由', typeof r1.combinationCheckedDetail === 'string' && r1.combinationCheckedDetail.length > 0);
  check('★ F3：set 响应回带 fileToken（供下次提交做 CAS）', r1.fileToken && r1.fileToken.exists === true);
  check('★ F2：set 响应回带 cwdGuarantee（客户端据此条件化文案）', typeof r1.cwdGuarantee?.caveat === 'string');

  // profile 可用 ⇒ 权威校验，且跨文件非法组合被**写前拒绝**
  const ws2 = mkws();
  const ctxWithEditor = {
    get: (k) => {
      if (k === 'workspaceRegistry') return { list: () => [{ id: 'w2', path: ws2 }], get: () => ({ id: 'w2', path: ws2 }) };
      if (k === 'configEditor') return { configuration: () => [
        { entry: { options: { id: 'role-guard', name: 'guards/role-guard/lib/index.js' } }, inherited: {}, override: PROFILE_RG },
        { entry: { options: { id: 'subagent-sandbox', name: 'guards/subagent-sandbox/lib/index.js' } }, inherited: {}, override: PROFILE_SB },
      ] };
      return undefined;
    },
    effect: (fn) => fn(), logger: () => ({ info() {}, warn() {}, error() {} }), webServer: { register: () => () => {} },
  };
  let rejected = null;
  try {
    HOST.__test.handlers['settings.set'](ctxWithEditor)({ workspaceId: 'w2', patch: { 'role-guard': { 'roleScope.enabled': false } } });
  } catch (e) { rejected = e; }
  check('★ F4：profile 可用 ⇒ 跨文件非法组合被**写前权威拒绝**', rejected !== null && /组合非法/.test(rejected.message), rejected?.code);
  check('★ F4：被拒绝时零落盘', !existsSync(join(ws2, '.dsh-guard.json')));
  const r2 = HOST.__test.handlers['settings.set'](ctxWithEditor)({ workspaceId: 'w2', patch: { 'subagent-sandbox': { mode: 'off' } } });
  check('★ F4：profile 可用且组合合法 ⇒ combinationCheckedWithProfile=true 且 notes 为空（除了「无该插件现值」类说明）',
    r2.combinationCheckedWithProfile === true && r2.combinationChecked['subagent-sandbox'] === 'with-profile',
    JSON.stringify(r2.combinationChecked));
  rmSync(ws1, { recursive: true, force: true });
  rmSync(ws2, { recursive: true, force: true });
}

console.log(`\n${bad === 0 ? 'OK 红队 F1–F4 修复验证全部通过' : `FAIL 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
