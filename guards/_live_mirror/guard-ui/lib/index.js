/**
 * guard-ui / 主机半（DSH/Cordis 插件入口）
 *
 * 职责：注册 `/guard/api/*` 三个路由，作为**每工作区 guard 设置的唯一写者**。
 *   POST /guard/api/settings.get    {workspaceId}          → {knobs, effective, defaults, source, extras}
 *   POST /guard/api/settings.set    {workspaceId, patch}   → 校验后原子写 <workspace>/.dsh-guard.json
 *   POST /guard/api/settings.reset  {workspaceId}          → 删除工作区文件（回落 profile 默认）
 *
 * ── 纪律（照 `dsh-super-ppts/lib/routes.js` 的骨架，见 EVIDENCE.1.md R2/R3）────────
 *   · 注册必须包在 `ctx.effect(...)` 里（fiber 释放时回收路由）；
 *   · 围栏三道：Host loopback/trustedHosts + Origin 同源 + `application/json` content-type；
 *   · 信封 `{ok:true,value}` / `{ok:false,error:{code,message}}`；未知异常**不回传 message**；
 *   · **不信任客户端送的路径**：只用 `workspaceRegistry.list()` 里存在的 id 反查 path，
 *     并显式拒绝 `%MAIN_REPO%`（主仓库只读）；
 *   · 零 npm 依赖（只用 node 内置模块 + ctx 服务）。
 *
 * ── 与两个 guard 的关系（裁决 D-A：**拉取式 pull**，本插件不推送）────────────────
 *   guard 在判定期自己按 `agent.session.header.cwd` 读工作区文件（见 settings.js）。
 *   所以本插件**不需要**在启动时广播任何东西，也不存在「没推送过 ⇒ 静默失效」的窗口。
 *   本插件唯一与 guard 的间接耦合：共用同一份 `settings.js`（单一真源，P5）。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GUARD_PLUGINS, KNOBS, SETTINGS_FILE_NAME, deleteWorkspaceSettings, fileToken, getPath,
  isForbiddenWorkspacePath, knobsOf, readWorkspaceSettings, settingsPathFor, writeWorkspaceSettings,
} from './settings.js';

/** 稳定 Cordis 插件名（= package.json 的 name） */
export const name = 'guard-ui';

/** `webServer` 是硬依赖：拿不到它本插件就没有存在意义（应当挂载失败，而不是静默降级） */
export const inject = ['webServer'];

const API_PREFIX = '/guard/api';
const MAX_BODY_BYTES = 1 << 20;

/** wire 层可预期失败（code 会原样回给客户端；message 是给自己人看的） */
class GuardRouteError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ─────────────────────────── 围栏（照 super-ppts 骨架）───────────────────────────

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 信任围栏：Host header loopback / trustedHosts 精确匹配才放行 */
function fenceRequest(req, trustedHosts) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  let authority;
  try {
    authority = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (isLoopbackHostname(authority.hostname)) return true;
  return trustedHosts.some((entry) => entry === host || entry === authority.hostname);
}

/** 同源粗校验（CSRF 纵深防御）。无 Origin（curl 等非浏览器客户端）放行，Host 围栏仍然生效。 */
function originAllowed(req, trustedHosts) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  let authority;
  try {
    authority = new URL(origin);
  } catch {
    return true;
  }
  if (authority.protocol !== 'http:' && authority.protocol !== 'https:') return true;
  const host = req.headers.host;
  if (typeof host === 'string' && host !== '' && authority.host === host) return true;
  if (isLoopbackHostname(authority.hostname)) return true;
  return trustedHosts.some((entry) => entry === authority.host || entry === authority.hostname);
}

/** content-type 契约：跨站 `<form>` 只能发 urlencoded/multipart/text-plain ⇒ 要求 JSON 即天然不可达 */
function isJsonContentType(req) {
  const header = req.headers['content-type'];
  if (typeof header !== 'string' || header === '') return false;
  const mediaType = (header.split(';')[0] ?? '').trim().toLowerCase();
  return mediaType === 'application/json';
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
const writeOk = (res, value) => writeJson(res, 200, { ok: true, value });
const writeForbidden = (res) => writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });

function writeError(res, error) {
  if (error instanceof GuardRouteError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  // 未知异常不回传 message（可能含绝对路径等内部细节）：详情只进 host 日志
  console.error('[guard-ui] internal error:', error);
  writeJson(res, 500, { ok: false, error: { code: 'internal', message: 'internal error' } });
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new GuardRouteError('too-large', 'request body too large', 413);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GuardRouteError('bad-request', '请求体不是合法 JSON');
  }
}

function requireString(payload, key) {
  const value = payload?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GuardRouteError('bad-request', `缺少或非法的 "${key}"`);
  }
  return value;
}

// ─────────────────────── 工作区解析（不信任客户端送的路径）───────────────────────

/**
 * 由 `workspaceId` 反查工作区根路径。三重校验：
 *   ① `workspaceRegistry` 服务必须可用；
 *   ② id 必须出现在 `list()` 里（不接受客户端直接送 path）；
 *   ③ 路径不得命中 `%MAIN_REPO%` 黑名单。
 */
function resolveWorkspace(ctx, workspaceId) {
  const registry = (() => {
    try {
      return ctx.get?.('workspaceRegistry') ?? undefined;
    } catch {
      return undefined;
    }
  })();
  if (!registry || typeof registry.list !== 'function') {
    throw new GuardRouteError('service-missing', 'workspaceRegistry 服务不可用，无法解析工作区路径（拒绝按客户端送的路径写盘）', 503);
  }
  let items;
  try {
    items = registry.list() ?? [];
  } catch (e) {
    throw new GuardRouteError('service-missing', `workspaceRegistry.list() 失败：${e?.message ?? e}`, 503);
  }
  const hit = items.find((w) => w?.id === workspaceId);
  if (hit === undefined) {
    throw new GuardRouteError('workspace-not-found', `工作区不在注册表里：${workspaceId}`, 404);
  }
  const path = hit.path;
  if (typeof path !== 'string' || path.trim() === '') {
    throw new GuardRouteError('workspace-not-found', `工作区 ${workspaceId} 没有可用路径`, 404);
  }
  if (isForbiddenWorkspacePath(path)) {
    throw new GuardRouteError('forbidden-workspace', `拒绝对该路径写设置（主仓库只读）：${path}`, 403);
  }
  return { id: hit.id, path, title: hit.title ?? null };
}

// ─────────────────────── profile 现值（尽力读取，读不到就说读不到）───────────────────────

/**
 * 读 profile 里两个 guard 的**当前生效配置**。
 *
 * 来源：`ctx.get('configEditor').configuration()` → `[{ entry, inherited, override }]`
 *   （host Service 契约："Read inherited and explicit profile values for the active entries"）
 *   `entry.options.id` = patch id（我们的两个 guard 就是 `role-guard` / `subagent-sandbox`）。
 *
 * ⚠ 本读取是**尽力而为**：entry 不一定出现在 `configuration()` 里（它只列 `include` 下的条目），
 *   服务也可能不在。读不到 ⇒ `used:false`，调用方**如实**把 defaults 标成 'builtin'，
 *   绝不假装已经知道 profile 现值（否则界面会撒谎）。
 */
function readProfileConfigs(ctx) {
  const out = { used: false, reason: null, byPlugin: {}, sources: {} };
  let editor;
  try {
    editor = ctx.get?.('configEditor') ?? undefined;
  } catch {
    editor = undefined;
  }
  if (!editor || typeof editor.configuration !== 'function') {
    out.reason = 'configEditor 服务不可用';
    return out;
  }
  let rows;
  try {
    rows = editor.configuration() ?? [];
  } catch (e) {
    out.reason = `configEditor.configuration() 失败：${e?.message ?? e}`;
    return out;
  }
  for (const plugin of GUARD_PLUGINS) {
    const row = rows.find((r) => {
      const id = r?.entry?.options?.id;
      const mod = r?.entry?.options?.name;
      return id === plugin
        || (typeof mod === 'string' && mod.replace(/\\/g, '/').includes(`guards/${plugin}/`));
    });
    if (row === undefined) continue;
    const override = row.override;
    const inherited = row.inherited;
    const pick = (override && Object.keys(override).length > 0) ? override
      : (inherited && Object.keys(inherited).length > 0) ? inherited : null;
    if (pick === null) continue;
    out.byPlugin[plugin] = pick;
    out.sources[plugin] = (override && Object.keys(override).length > 0) ? 'profile-override' : 'profile-inherited';
    out.used = true;
  }
  if (!out.used) {
    out.reason = `configuration() 里没有 ${GUARD_PLUGINS.join(' / ')} 条目（可能不在 include 树里）`;
  }
  return out;
}

// ─────────────────────── 只读投影：把 schema + 现值拼成 UI 可直接渲染的形状 ───────────────────────

/**
 * 返回给 UI 的 knob 列表（客户端**不复制 schema**，一律按这里画表单 ⇒ settings.js 是唯一真源）。
 * `source` 逐键如实标注来源，避免「界面显示的值 ≠ guard 真正用的值」。
 */
function projectKnobs(workspacePath, profileByPlugin) {
  const read = workspacePath === null ? { status: 'absent', value: {}, problems: [] } : readWorkspaceSettings(workspacePath);
  const workspaceView = (read.status === 'ok') ? read.value : {};
  const rows = [];
  for (const knob of KNOBS) {
    const wsSection = workspaceView[knob.plugin];
    const fromWorkspace = getPath(wsSection ?? {}, knob.path);
    const profileConfig = profileByPlugin[knob.plugin];
    const fromProfile = getPath(profileConfig ?? {}, knob.path);
    let effective;
    let source;
    if (fromWorkspace !== undefined) {
      effective = fromWorkspace;
      source = 'workspace';
    } else if (fromProfile !== undefined) {
      effective = fromProfile;
      source = 'profile';
    } else {
      effective = knob.builtin;
      source = 'builtin';
    }
    rows.push({
      plugin: knob.plugin, path: knob.path, label: knob.label, control: knob.control,
      values: knob.values ?? null, valueLabels: knob.valueLabels ?? null, doc: knob.doc,
      builtin: knob.builtin,
      workspace: fromWorkspace === undefined ? null : fromWorkspace,
      profile: fromProfile === undefined ? null : fromProfile,
      effective, source,
    });
  }
  return { rows, read };
}

/** 不在 UI 的旋钮（"其余仍由 profile 决定"要有据可查，不能只是嘴上说） */
function projectExtras(profileByPlugin) {
  const extras = {};
  for (const plugin of GUARD_PLUGINS) {
    const cfg = profileByPlugin[plugin];
    if (cfg === undefined) continue;
    const known = new Set(knobsOf(plugin).map((k) => k.path.split('.')[0]));
    const keys = Object.keys(cfg).filter((k) => !known.has(k));
    if (keys.length > 0) extras[plugin] = keys;
  }
  return extras;
}

// ─────────────────────────── 路由 ───────────────────────────

const handlers = {
  'settings.get': (ctx) => (payload) => {
    const ws = resolveWorkspace(ctx, requireString(payload, 'workspaceId'));
    const profile = readProfileConfigs(ctx);
    const { rows, read } = projectKnobs(ws.path, profile.byPlugin);
    const anyWorkspace = rows.some((r) => r.source === 'workspace');
    return {
      workspace: { id: ws.id, path: ws.path, title: ws.title, file: settingsPathFor(ws.path), fileName: SETTINGS_FILE_NAME },
      knobs: rows,
      // 兼容 TASK.2 §2.2 的聚合口径；逐键来源见 knobs[].source
      source: { key: anyWorkspace ? 'workspace' : 'profile' },
      // `defaults` = profile 现值（读不到时用插件代码默认兜底，并如实标 defaultsSource）
      defaults: Object.fromEntries(GUARD_PLUGINS.map((p) => [p, profile.byPlugin[p] ?? {}])),
      defaultsSource: profile.used ? 'profile' : 'builtin',
      defaultsDetail: { used: profile.used, reason: profile.reason, perPlugin: profile.sources },
      extras: projectExtras(profile.byPlugin),
      workspaceFileStatus: read.status,
      problems: read.problems ?? [],
      // ── 红队 F2：让 UI 能说真话 ────────────────────────────────────────
      // 「本工作区覆盖对谁生效」这件事**不能无条件承诺**：`SessionHeader.cwd` 是**可选**字段。
      // ⚠ 第 2 轮红队 F2-P2-1：两类回落**行为不同**，文案必须分开说，不能并列成一句 ——
      //    ① 无 agent（宿主级调用）⇒ reason=host-level-call，**设计内降级、静默**（problems 为空）；
      //    ② 有 agent 但缺 header.cwd ⇒ reason=agent-cwd-missing，**响亮记录**（warn + 事件 + problems）。
      //    并列会让读者以为宿主级调用也会告警 ⇒ UI 对「静默」撒谎。
      cwdGuarantee: {
        scoped: true,
        level: 'conditional',
        caveat: '仅对**带 session cwd** 的调用者生效。取不到 cwd 时有两类情况，**行为不同**：'
          + '① **无 agent 的宿主级调用** ⇒ 按设计降级为 profile 默认，**静默**（不告警、不记事件）；'
          + '② **有 agent 但取不到 agent.session.header.cwd** ⇒ 同样回落 profile 默认，但会**响亮记录**'
          + ' `agent-cwd-missing`（guard 日志 + 事件 + problems）。两类情况下本工作区覆盖都**不生效**。',
      },
      // 红队 F3：把文件现状令牌给客户端，提交/删除时回传 ⇒ 乐观并发控制
      fileToken: fileToken(ws.path),
      note: '第一版只开放 knobs 里这些开关；extras 列出的键仍由 profile（cordis.patch.yml）决定。',
    };
  },

  /**
   * 路由接管 / 让位（2026-10-21）：写 <workspace>/.rule-router/mode.json。
   * 这是**唯一**写入口；UI 只传 action（get / auto / manual / clear）。
   * 放这里而不是 rule-router 内部：guard-ui 已是"每工作区 guard 设置的唯一写者"，
   * 沿用同一围栏（loopback + origin + JSON）与同一路由前缀，避免开第二条写通道。
   */
  'router.mode': (ctx) => (payload) => {
    const ws = resolveWorkspace(ctx, requireString(payload, 'workspaceId'));
    const action = typeof payload?.action === 'string' ? payload.action : 'get';
    if (!['get', 'auto', 'manual', 'clear'].includes(action)) {
      throw new GuardRouteError('bad-action', `未知 action：${action}`, 400);
    }
    const file = join(ws.path, '.rule-router', 'mode.json');
    if (action === 'auto' || action === 'manual') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ mode: action, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    } else if (action === 'clear') {
      try { unlinkSync(file); } catch { /* 本来就没有 */ }
    }
    let mode = null;
    let at = null;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j?.mode === 'auto' || j?.mode === 'manual') mode = j.mode;
      at = j?.at ?? null;
    } catch { /* 文件不存在或不是合法 JSON ⟹ 视为自动检测 */ }
    return { mode, at, file, exists: existsSync(file) };
  },
  'settings.set': (ctx) => (payload) => {
    const ws = resolveWorkspace(ctx, requireString(payload, 'workspaceId'));
    const patch = payload?.patch;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new GuardRouteError('bad-request', '缺少或非法的 "patch"');
    }
    const profile = readProfileConfigs(ctx);
    // ⚠ F4：读不到 profile 现值时**必须传 null**，不能传 `{}` ——
    //    `{}` 会被 `isPlainObject` 当成「读到了但为空」，于是组合校验被当成权威校验、
    //    notes 为空，界面据此显示成功，而 guard 判定期会整份弃用该覆盖（UI 与实际相反）。
    const profileForCheck = profile.used ? profile.byPlugin : null;
    const expect = payload?.expect ?? undefined;
    const result = writeWorkspaceSettings(ws.path, patch, profileForCheck, { expect });
    if (!result.ok) {
      if (result.conflict === true) {
        throw new GuardRouteError('conflict', result.errors.join('；') || '文件已被其它写者改动', 409);
      }
      throw new GuardRouteError('invalid-settings', result.errors.join('；') || '设置校验失败');
    }
    const withProfile = Object.values(result.combinationChecked ?? {}).every((v) => v === 'with-profile');
    return {
      file: result.file,
      value: result.value,
      // F4：这两项必须被客户端消费（否则 UI 会与 guard 的实际行为相反）
      notes: result.notes ?? [],
      combinationChecked: result.combinationChecked ?? {},
      combinationCheckedWithProfile: profile.used && withProfile,
      combinationCheckedDetail: profile.used
        ? (withProfile ? '全部插件都已与 profile 现值做权威组合校验' : 'profile 可用，但部分插件没有 profile 现值 ⇒ 那些插件只做了文件内部校验')
        : `读不到 profile 现值（${profile.reason ?? '未知原因'}）⇒ 组合不变式只做了「文件内部」尽力校验`,
      // F3：回读校验结论（写完立刻读回比对）
      verified: result.verified === true,
      // F2：同样把「生效保证」带上，客户端据此决定文案（与 settings.get 的文案保持一致）
      cwdGuarantee: {
        level: 'conditional',
        caveat: '仅对带 session cwd 的调用者生效。取不到 cwd 有两类、行为不同：'
          + '① 无 agent 的宿主级调用 ⇒ 设计内降级，**静默**；'
          + '② 有 agent 但缺 agent.session.header.cwd ⇒ **响亮记录** agent-cwd-missing。'
          + '两类都回落 profile 默认，本工作区覆盖对它们不生效。',
      },
      fileToken: fileToken(ws.path),
    };
  },

  'settings.reset': (ctx) => (payload) => {
    const ws = resolveWorkspace(ctx, requireString(payload, 'workspaceId'));
    // F3：客户端把「它看到的那一版」令牌回传 ⇒ 文件被改过就拒绝删除
    const r = deleteWorkspaceSettings(ws.path, { expect: payload?.expect ?? undefined });
    if (!r.ok) {
      if (r.conflict === true) throw new GuardRouteError('conflict', r.errors.join('；') || '文件已被其它写者改动', 409);
      throw new GuardRouteError('invalid-settings', r.errors.join('；') || '删除失败');
    }
    return { deleted: true, existed: r.existed, file: r.file };
  },
};

/**
 * 注册 `/guard/api`（prefix）。返回组合 disposer 交给 effect 回收。
 * 与 super-ppts 同构：一个 prefix 路由 + `method` 从 pathname 尾部解析。
 */
export function registerGuardUiRoutes(ctx) {
  const webRuntime = (() => {
    try {
      return ctx.get?.('webRuntime') ?? undefined;
    } catch {
      return undefined;
    }
  })();
  // ⚠ webRuntime **不在** host Service 目录里（EVIDENCE.1 R2）：取不到就空数组，
  //   而空数组下 loopback 仍然放行（fenceRequest 先判 loopback），故不依赖它。
  const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? webRuntime.trustedHosts : [];
  const disposers = [];
  disposers.push(ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!fenceRequest(req, trustedHosts)) {
        writeForbidden(res);
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
        return;
      }
      if (!originAllowed(req, trustedHosts)) {
        writeForbidden(res);
        return;
      }
      if (!isJsonContentType(req)) {
        writeJson(res, 415, { ok: false, error: { code: 'method-error', message: 'content-type must be application/json' } });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : undefined;
      if (method === undefined || method.includes('/')) {
        writeError(res, new GuardRouteError('not-found', 'unknown api method', 404));
        return;
      }
      try {
        const factory = handlers[method];
        if (factory === undefined) throw new GuardRouteError('not-found', `unknown api method "${method}"`, 404);
        writeOk(res, await factory(ctx)(await readJsonBody(req)));
      } catch (error) {
        writeError(res, error);
      }
    },
  }), 'guard-ui: /guard/api routes'));
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch { /* 回收失败不阻断卸载 */ }
    }
  };
}

/** 插件入口。返回 disposer（cordis fiber 释放时回收）。 */
export function apply(ctx) {
  const dispose = registerGuardUiRoutes(ctx);
  const log = ctx.logger?.('guard-ui') ?? console;
  log.info?.(`[guard-ui] 设置通道已注册：POST ${API_PREFIX}/settings.{get,set,reset}（每工作区文件：<workspace>/${SETTINGS_FILE_NAME}）`);
  return dispose;
}

// 供离线自测直接调（不必起真 HTTP server）：测试用 stub req/res 喂 handler。
export const __test = { handlers, resolveWorkspace, readProfileConfigs, projectKnobs, GuardRouteError, API_PREFIX };
