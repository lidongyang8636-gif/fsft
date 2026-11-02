/**
 * guard-ui 主机半自测 —— 用 stub ctx + stub req/res 走**真路由处理器**（连围栏一起测）。
 *
 * 覆盖：
 *   · V2 UI 改一项 ⇒ `.dsh-guard.json` 落盘且内容正确（原子写）
 *   · V4 优先级：工作区文件 > profile；删除后回落
 *   · V5 坏文件不炸、降级、改名 `*.corrupt-*`、响亮
 *   · 围栏：Host 非 loopback / Origin 异源 / content-type 非 JSON / 非 POST / 未知 method
 *   · 不信任客户端送的路径：只认注册表里的 workspaceId；主仓库路径被拒
 *   · 插件可 apply（静态可加载性）且路由进 effect 回收
 *
 * 用法：node guards/guard-ui/test/routes.mjs
 * 只写系统 temp，绝不写工作区根 / profile。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);
const { __test } = mod;

let bad = 0;
const check = (what, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`   ${pass ? '✅' : '❌'} ${what}${extra ? `  ${extra}` : ''}`);
};
const mkws = () => mkdtempSync(join(tmpdir(), 'gui-ws-'));
const settingsFileIn = (p) => join(p, '.dsh-guard.json');
const body = (p) => (existsSync(settingsFileIn(p)) ? JSON.parse(readFileSync(settingsFileIn(p), 'utf8')) : null);

const PROFILE_SANDBOX = { mode: 'set', childPreset: 'fpga-locked', writerExempt: true, eventLog: 'X:/ev.jsonl' };
const PROFILE_ROLE = { roleScope: { enabled: true, unknownPolicy: 'guard', serviceMissingPolicy: 'guard' }, shellScope: { enabled: true } };

/** stub ctx：workspaceRegistry / configEditor / effect / logger / webServer */
function makeCtx({ workspaces = [], profileRows = null, webServer = true } = {}) {
  const registered = [];
  const disposers = [];
  const logs = [];
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(`INFO ${m}`),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    }),
    effect: (fn) => { const d = fn(); disposers.push(d); return d; },
    get: (k) => {
      if (k === 'workspaceRegistry') return { list: () => workspaces, get: (id) => workspaces.find((w) => w.id === id) };
      if (k === 'configEditor') {
        if (profileRows === null) return undefined;
        return { configuration: () => profileRows };
      }
      return undefined;
    },
    webServer: webServer ? { register: (route) => { registered.push(route); return () => { registered.splice(registered.indexOf(route), 1); }; } } : undefined,
    _registered: registered,
    _disposers: disposers,
    _logs: logs,
  };
  return ctx;
}

const profileRows = () => ([
  { entry: { options: { id: 'role-guard', name: '%MAIN_REPO%-dsh/guards/role-guard/lib/index.js' } }, inherited: {}, override: PROFILE_ROLE },
  { entry: { options: { id: 'subagent-sandbox', name: '%MAIN_REPO%-dsh/guards/subagent-sandbox/lib/index.js' } }, inherited: {}, override: PROFILE_SANDBOX },
]);

/** 直接调 handler（绕过 HTTP 层，测业务） */
const call = (ctx, method, payload) => __test.handlers[method](ctx)(payload);

console.log('=== 1) 静态可加载性 + 注册形态 ===');
check('name = guard-ui', mod.name === 'guard-ui');
check('inject = [webServer]（硬依赖）', Array.isArray(mod.inject) && mod.inject.join() === 'webServer');
check('apply 是函数', typeof mod.apply === 'function');
{
  const ctx = makeCtx({ webServer: false });
  let threw = null;
  try { mod.apply(ctx); } catch (e) { threw = e; }
  check('★ webServer 缺失 ⇒ apply 抛（硬依赖，不静默降级）', threw !== null, threw ? String(threw.message).slice(0, 60) : '未抛');
}
{
  const ctx = makeCtx();
  const dispose = mod.apply(ctx);
  check('apply 后注册了 1 条 prefix 路由 /guard/api',
    ctx._registered.length === 1 && ctx._registered[0].kind === 'prefix' && ctx._registered[0].path === '/guard/api',
    JSON.stringify(ctx._registered.map((r) => `${r.kind}:${r.path}`)));
  check('注册被包在 effect 里（disposer 已收集）', ctx._disposers.length === 1);
  dispose();
  check('disposer 可回收路由', ctx._registered.length === 0);
}

console.log('\n=== 2) V2 落盘：set ⇒ 文件内容正确 + 原子写 ===');
{
  const ws = mkws();
  const ctx = makeCtx({ workspaces: [{ id: 'w1', path: ws, title: 'T' }], profileRows: profileRows() });
  const r = call(ctx, 'settings.set', { workspaceId: 'w1', patch: { 'subagent-sandbox': { mode: 'observe' } } });
  check('set 成功', r.file === settingsFileIn(ws), JSON.stringify(r));
  check('★ 落盘内容正确', body(ws).version === 1 && body(ws)['subagent-sandbox'].mode === 'observe', JSON.stringify(body(ws)));
  check('★ 原子写：无 .tmp 残留', readdirSync(ws).filter((f) => f.includes('.tmp')).length === 0, JSON.stringify(readdirSync(ws)));
  check('★ 组合已与 profile 权威校验过', r.combinationCheckedWithProfile === true);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 3) V4 优先级：get 反映工作区覆盖 → 删除后回落 profile ===');
{
  const ws = mkws();
  const ctx = makeCtx({ workspaces: [{ id: 'w1', path: ws }], profileRows: profileRows() });
  const g0 = call(ctx, 'settings.get', { workspaceId: 'w1' });
  const knobOf = (g, path) => g.knobs.find((k) => k.path === path);
  check('无文件：mode 取自 profile（set），source=profile',
    knobOf(g0, 'mode').effective === 'set' && knobOf(g0, 'mode').source === 'profile');
  check('无文件：聚合 source.key = profile', g0.source.key === 'profile');
  check('defaultsSource = profile（读到了 configEditor）', g0.defaultsSource === 'profile', JSON.stringify(g0.defaultsDetail));
  check('extras 如实列出「不在 UI 的键」（其余仍由 profile 决定）',
    JSON.stringify(g0.extras['subagent-sandbox']) === JSON.stringify(['eventLog']), JSON.stringify(g0.extras));
  check('knobs 恰好 7 个', g0.knobs.length === 7);

  call(ctx, 'settings.set', { workspaceId: 'w1', patch: { 'subagent-sandbox': { mode: 'off' } } });
  const g1 = call(ctx, 'settings.get', { workspaceId: 'w1' });
  check('★ 有文件：mode=off，source=workspace', knobOf(g1, 'mode').effective === 'off' && knobOf(g1, 'mode').source === 'workspace');
  check('★ 未覆盖的键仍标 profile（逐键来源，不撒谎）', knobOf(g1, 'childPreset').source === 'profile'
    && knobOf(g1, 'childPreset').effective === 'fpga-locked');
  check('聚合 source.key = workspace', g1.source.key === 'workspace');

  const r = call(ctx, 'settings.reset', { workspaceId: 'w1' });
  check('reset 删除文件（existed=true）', r.deleted === true && r.existed === true && !existsSync(settingsFileIn(ws)));
  const g2 = call(ctx, 'settings.get', { workspaceId: 'w1' });
  check('★ 删除后回落 profile（mode=set / source=profile）',
    knobOf(g2, 'mode').effective === 'set' && knobOf(g2, 'mode').source === 'profile');
  const r2 = call(ctx, 'settings.reset', { workspaceId: 'w1' });
  check('reset 幂等（existed=false）', r2.deleted === true && r2.existed === false);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 4) V5 坏文件：不炸、降级 profile、改名 *.corrupt-* ===');
{
  const ws = mkws();
  const ctx = makeCtx({ workspaces: [{ id: 'w1', path: ws }], profileRows: profileRows() });
  writeFileSync(settingsFileIn(ws), '{ totally broken', 'utf8');
  let threw = null;
  let g;
  try { g = call(ctx, 'settings.get', { workspaceId: 'w1' }); } catch (e) { threw = e; }
  check('坏文件时 get 不炸', threw === null, threw ? String(threw.message) : '');
  check('★ 坏文件 ⇒ 降级 profile（mode=set）+ 状态如实报 invalid',
    g.knobs.find((k) => k.path === 'mode').effective === 'set' && g.workspaceFileStatus === 'invalid',
    JSON.stringify({ status: g.workspaceFileStatus, mode: g.knobs.find((k) => k.path === 'mode').effective }));
  check('★ 且响亮（workspaceFileStatus invalid）', g.workspaceFileStatus === 'invalid');

  const r = call(ctx, 'settings.set', { workspaceId: 'w1', patch: { 'subagent-sandbox': { mode: 'set' } } });
  check('★ 坏文件后写入：改名留底 + 重建成功', r.file === settingsFileIn(ws)
    && (r.notes ?? []).some((n) => n.includes('改名留底')), JSON.stringify(r.notes));
  check('★ 留底文件名含 .corrupt-', readdirSync(ws).some((f) => f.includes('.corrupt-')));
  check('重建后的内容正确', body(ws)['subagent-sandbox'].mode === 'set');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 5) 写边界严格拒绝（D-B 响亮拒绝）+ 不信任客户端路径 ===');
{
  const ws = mkws();
  const ctx = makeCtx({ workspaces: [{ id: 'w1', path: ws }], profileRows: profileRows() });
  const rejects = [
    ['未知键（拼错）', { 'subagent-sandbox': { mod: 'set' } }],
    ['枚举外取值 enforce', { 'subagent-sandbox': { mode: 'enforce' } }],
    ['未知插件段', { 'nope': { mode: 'set' } }],
    ['类型不符', { 'subagent-sandbox': { writerExempt: 'yes' } }],
  ];
  for (const [what, patch] of rejects) {
    let err = null;
    try { call(ctx, 'settings.set', { workspaceId: 'w1', patch }); } catch (e) { err = e; }
    check(`拒绝：${what}（且零落盘）`, err !== null && err.code === 'invalid-settings' && !existsSync(settingsFileIn(ws)),
      err ? `${err.code}: ${err.message}` : '未拒');
  }
  // ★ 跨文件（工作区 × profile）非法组合：profile shellScope=true，工作区关 roleScope ⇒ 必须写前就拒
  let xerr = null;
  try { call(ctx, 'settings.set', { workspaceId: 'w1', patch: { 'role-guard': { 'roleScope.enabled': false } } }); } catch (e) { xerr = e; }
  check('★ 跨文件非法组合被写前权威拒绝（否则 UI 会显示已覆盖、guard 却整份弃用）',
    xerr !== null && xerr.message.includes('组合非法') && !existsSync(settingsFileIn(ws)),
    xerr ? xerr.message.slice(0, 70) : '未拒');

  let werr = null;
  try { call(ctx, 'settings.get', { workspaceId: 'does-not-exist' }); } catch (e) { werr = e; }
  check('未知 workspaceId ⇒ 404 workspace-not-found', werr?.code === 'workspace-not-found' && werr.status === 404);

  // 主仓库 path 即使被“注册”也拒（双保险）
  const badCtx = makeCtx({ workspaces: [{ id: 'bad', path: '%MAIN_REPO%' }], profileRows: profileRows() });
  let berr = null;
  try { call(badCtx, 'settings.get', { workspaceId: 'bad' }); } catch (e) { berr = e; }
  check('★ 主仓库路径被拒（forbidden-workspace）', berr?.code === 'forbidden-workspace' && berr.status === 403, berr?.message);
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 6) profile 读不到时如实降级（defaults 用 builtin，不假装知道）===');
{
  const ws = mkws();
  const ctx = makeCtx({ workspaces: [{ id: 'w1', path: ws }], profileRows: null });  // 无 configEditor
  const g = call(ctx, 'settings.get', { workspaceId: 'w1' });
  check('defaultsSource = builtin（如实）', g.defaultsSource === 'builtin');
  check('defaultsDetail 说明原因', typeof g.defaultsDetail.reason === 'string' && g.defaultsDetail.reason.length > 0, g.defaultsDetail.reason);
  check('★ 此时 mode 的 effective 只能是 builtin 值，且 source 如实标 builtin（不冒充 profile）',
    g.knobs.find((k) => k.path === 'mode').source === 'builtin'
    && g.knobs.find((k) => k.path === 'mode').effective === 'observe',
    JSON.stringify({ s: g.knobs.find((k) => k.path === 'mode').source, e: g.knobs.find((k) => k.path === 'mode').effective }));
  check('写仍然可用（只是组合校验没有 profile 参与 ⇒ 如实回报 false）', (() => {
    const r = call(ctx, 'settings.set', { workspaceId: 'w1', patch: { 'subagent-sandbox': { mode: 'off' } } });
    return r.file === settingsFileIn(ws) && r.combinationCheckedWithProfile === false;
  })());
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n=== 7) 围栏（走真 handler：stub req/res 喂 /guard/api）===');
{
  const ws = mkws();
  const ctx = makeCtx({ workspaces: [{ id: 'w1', path: ws }], profileRows: profileRows() });
  const route = (() => { mod.apply(ctx); return ctx._registered[0]; })();

  /** 造 stub req/res；`once` 是读取顺序：'data' → 'end' */
  const mkReqRes = ({ method = 'POST', url = '/guard/api/settings.get', host = '127.0.0.1:19387', origin, contentType = 'application/json', payload = '{}' } = {}) => {
    const req = {
      method, url,
      headers: { host, ...(origin ? { origin } : {}), ...(contentType ? { 'content-type': contentType } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload, 'utf8'); },
    };
    const out = { status: null, headers: null, body: '' };
    const res = {
      writeHead: (s, h) => { out.status = s; out.headers = h; },
      end: (b) => { if (b !== undefined) out.body = String(b); },
    };
    return { req, res, out };
  };
  const hit = async (opts) => { const { req, res, out } = mkReqRes(opts); await route.handler(req, res); return { ...out, json: out.body ? JSON.parse(out.body) : null }; };

  const okRes = await hit({ payload: JSON.stringify({ workspaceId: 'w1' }) });
  check('loopback Host + 同源 + JSON ⇒ 200 且 ok:true', okRes.status === 200 && okRes.json.ok === true,
    `${okRes.status} ${JSON.stringify(okRes.json).slice(0, 80)}`);
  check('响应头是 application/json', String(okRes.headers['content-type']).startsWith('application/json'));

  check('非法 Host（非 loopback 且不在 trustedHosts）⇒ 403', (await hit({ host: 'evil.example.com' })).status === 403);
  check('Origin 异源 ⇒ 403', (await hit({ origin: 'http://evil.example.com' })).status === 403);
  check('content-type 非 JSON ⇒ 415', (await hit({ contentType: 'text/plain' })).status === 415);
  check('非 POST ⇒ 405', (await hit({ method: 'GET' })).status === 405);
  check('未知 method ⇒ 404', (await hit({ url: '/guard/api/nope' })).status === 404);
  check('两级路径 ⇒ 404', (await hit({ url: '/guard/api/settings/get' })).status === 404);
  check('前缀外路径不走本路由（handler 只对 /guard/api 负责，这里直接喂也应是 404）',
    (await hit({ url: '/other/api/settings.get' })).status === 404);
  const badJson = await hit({ payload: '{ nope' });
  check('请求体不是 JSON ⇒ 400 bad-request', badJson.status === 400 && badJson.json.error.code === 'bad-request');
  const oversize = await hit({ payload: 'x'.repeat((1 << 20) + 10) });
  check('请求体超限 ⇒ 413 too-large', oversize.status === 413 && oversize.json.error.code === 'too-large');
  // ⚠ 未知异常不得回传内部 message（不泄露绝对路径）
  const missWs = await hit({ url: '/guard/api/settings.get', payload: JSON.stringify({}) });
  check('缺 workspaceId ⇒ 400 且 message 不含路径', missWs.status === 400
    && !String(missWs.json.error.message).includes(':\\'), JSON.stringify(missWs.json));
  rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${bad === 0 ? '✅ guard-ui 主机半自测全部通过' : `❌ 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
