/**
 * rule-router —— 任务类型 → 固定 (provider, model, effort) 的**确定性**模型路由
 *
 * 为什么要它：原来装着第三方 `@neptune810/dsh-model-router`，它**每个 step 重新路由**
 * （关键词 + 每模型权重 + 迟滞），决策不可解释、同一会话里模型会来回跳。
 * 用户 2026-10-20 裁定：停用旧插件，改用「任务类型 → 固定 provider+model」的规则版，
 * **不做每步随机**。计划与证据见 docs/rule-router-plan.md。
 *
 * 两种模式（config.mode）：
 *   · `observe`（默认，**只读**）：只在 `.rule-router/decisions.jsonl` 记录
 *     「本该选谁」与「实际用了谁」，**不碰任何会话状态**。A-P0 的验收形态。
 *   · `apply`：命中规则后调 `ctx.sessionController.agents.selectForNextRequest(agent, sel)`
 *     —— 这是宿主 `/model` 命令走的**同一条**路径（写法照抄 api-session-controller 的
 *     `selectModel`），因此「提示词变量 / 请求路由 / 会话日志 / UI 投影」四处自动一致；
 *     ⚠ 它**不写 agentDefaultModel**（不覆盖用户默认模型），与 `selectModel` 的唯一区别。
 *   · `off`：挂载但不动作。
 *
 * 四条铁律：
 *   1. **sticky**：同一会话命中一次后不再逐 step 重算（只有规则文件变了才允许切换，
 *      并在日志里写 switch_reason），sticky 是"不随机跳"的制度化。
 *   2. **绝不 throw**：apply / agent/created / pre-step / request 四处全部 try-catch。
 *      插件抛异常会打断轮次甚至让 agent 创建失败。
 *   3. **显式优先**：创建时调用方**点名指定**了 provider+model 的 agent（判据见
 *      `explicitRouteOf`：`agent.options` 与默认选择不同），规则**不接管**，只记
 *      `action: skip-explicit-route`。这就是"在哪个档 spawn 就在哪个档跑"。
 *   4. **能自证**：每行 JSONL 都带 rule / why / route / action，`action=switch` 时才真改。
 *
 * 端口（config）：
 *   mode        off | observe | apply          默认 observe
 *   rulesPath   规则表（JSON；路径相对 workspace 或绝对）  默认 config/rule-router.json
 *   logPath     审计日志（JSONL）               默认 .rule-router/decisions.jsonl
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'rule-router';

/** 全部服务都是可选取：取不到就退化为 observe（不静默失效，会写 no-controller）。 */
export const inject = [];

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEFAULTS = {
  mode: 'observe',
  rulesPath: 'config/rule-router.json',
  logPath: '.rule-router/decisions.jsonl',
  /** 预览长度上限：日志里只留最后一个用户消息的前 N 字，避免把长文写进审计 */
  previewChars: 120,
  /**
   * ★ 2026-10-21 额度兜底（用户要求）：**上游返回 402 额度超限时**，把后续请求路由到
   * %PAYG_PROVIDER% 的**按量**档，避免整轮失败。
   *
   * 判据来源：`agent/request` 的 `next()` 抛错（那是唯一能看到上游状态码的地方）。
   * ⚠ 思考挡位（effort）必须**手写**，不继承原档位：不同 provider/model 的可用挡位不同，
   *   继承会把一个非法值塞给 %PAYG_PROVIDER% 侧（effort-check 的 `missing=9` 正是这类风险）。
   */
  quotaFallback: {
    enabled: false,
    statusCodes: [402, 429],
    provider: null,
    model: null,
    effort: null,
    ttlMs: 15 * 60 * 1000,
  },
  /**
   * ★ 手动让位（2026-10-21 用户要求；语义照 @neptune810/dsh-model-router 的 yieldOnManual）：
   *
   * 现象：用户在 composer 手选了模型，本插件下一次 pre-step 仍按规则拉回 —— 用户"选了东西它也要卡我"。
   * 语义：**检测到用户手选 ⟹ 本会话让位**（不再切换），直到**显式接管**（不是"下一条命令自动恢复"）。
   *
   * 接管入口：`.rule-router/mode.json` = {"mode":"auto"}（后续可由 guard-ui 加按钮）；
   *           写 {"mode":"manual"} 可强制让位（排障用）。
   * 检测来源：会话投影 `modelSelection.pending`（宿主 /model 命令与 UI 手选都走它）；
   *           取不到投影时**不猜**（宁可不让位，也不误判）。
   */
  manualOverride: {
    yieldOnManual: true,
    modeFile: '.rule-router/mode.json',
  },
};

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

const abs = (p) => (isAbsolute(p) ? p : join(WORKSPACE, p));

/**
 * 从错误对象里取 HTTP 状态码（不同层可能放在不同字段；也兼容 message 里带 "402"）。
 * ★ 只用于**额度兜底**判据，不参与任何安全判断。
 */
function statusOfError(e) {
  if (!e) return null;
  const cand = [
    e.status, e.statusCode, e.code,
    e.response?.status, e.response?.statusCode,
    e.cause?.status, e.cause?.statusCode,
    e.data?.status, e.error?.status,
  ];
  for (const c of cand) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  const m = String(e.message ?? e).match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * 额度超限的**文本信号**。
 *
 * 为什么不能只看状态码（2026-10-21 实测）：上游返回的是
 *   { "type":"rate_limit_error", "code":"rate_limit_exceeded",
 *     "message":"每日额度超限：当前 $64.4832 USD（限制：$60.0000 USD）…",
 *     "limit_type":"daily_quota", "reset_time":"…" }
 * —— **没有任何数值字段装 402**，message 里也没有 "402" 字样 ⟹ 旧判据（只看状态码）永远命中不了，
 * 于是"额度兜底"形同不存在，而且**静默**。这条是那次事故的直接教训。
 */
const QUOTA_TEXT_SIGNALS = [
  'rate_limit', 'rate-limit', 'ratelimit',
  'insufficient_quota', 'daily_quota', 'quota_exceeded', 'quota',
  '额度超限', '超出额度', '额度已用完', '配额超限',
];

/** 取"什么时候恢复"（上游若给 reset_time 就按它，避免 ttl 到期后又撞墙） */
function resetAtOf(e) {
  const cand = [e?.reset_time, e?.data?.reset_time, e?.error?.reset_time];
  for (const c of cand) {
    if (typeof c === 'string' || typeof c === 'number') {
      const t = typeof c === 'number' ? c : Date.parse(c);
      if (Number.isFinite(t) && t > 0) return t;
    }
  }
  return null;
}

/**
 * 是否属于「额度超限」：**状态码集合** 或 **语义信号**（任一命中即可）。
 * 返回 {hit, status, reason}，reason 进审计日志（解释"为什么/为什么没"降级）。
 */
function isQuotaError(e, codes) {
  const set = new Set((Array.isArray(codes) ? codes : []).map(Number).filter(Number.isFinite));
  const st = statusOfError(e);
  if (st !== null && set.has(st)) return { hit: true, status: st, reason: `status:${st}` };
  const parts = [
    e?.code, e?.type, e?.limit_type, e?.error?.code, e?.error?.type,
    e?.data?.code, e?.data?.type, e?.data?.limit_type,
    e?.message, e?.error?.message,
  ].map((x) => (x == null ? '' : String(x).toLowerCase()));
  const sig = QUOTA_TEXT_SIGNALS.find((k) => parts.some((p) => p.includes(k)));
  if (sig) return { hit: true, status: st, reason: `text:${sig}` };
  return { hit: false, status: st, reason: st === null ? 'no-signal' : `status:${st}` };
}

function textOf(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const c = m && m.content;
    if (typeof c === 'string') { out.push(c); continue; }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && part.type === 'text' && typeof part.text === 'string') out.push(part.text);
      }
    }
  }
  return out.join('\n');
}

function hasImage(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) if (part && part.type === 'image') return true;
  }
  return false;
}

/**
 * 取"本步最后一个**真** user 消息"。
 *
 * ⚠ 这是被实测打出来的两处修正，两次都表现为「读文件的探针被判成 fpga-rtl」：
 *   ① 第一版用**整批 messages**（含 system prompt）匹配 ⇒ 关键词 `ila` 命中系统提示里的
 *      "avai**la**ble"。修完仍误判，因为——
 *   ② 平台会在末尾追加 **user 角色**的注入块：`source.kind = 'runtime-context'`
 *      （实测 `{r:'user', s:'runtime-context/snapshot', n:1116}`），而真正的用户消息是
 *      `{r:'user', s:'user/', n:611}`。拿"最后一个 user 消息"必然拿到注入块。
 *
 *   所以必须按 `source.kind` 认人：只认 `kind === 'user'`（无 source 时兼容按真用户处理）；
 *   一层退路是排除已知注入 kind。宁可漏判（落到 default）也不误判。
 */
const INJECTED_SOURCE_KINDS = new Set([
  'runtime-context', 'model-selection', 'skill-catalog', 'agent-team', 'system-reminder', 'memory',
]);

function lastUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const usable = (m) => m && m.role === 'user'
    && ((typeof m.content === 'string' && m.content.trim() !== '') || (Array.isArray(m.content) && m.content.length > 0));

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!usable(m)) continue;
    const kind = m?.source?.kind;
    if (kind === undefined || kind === 'user') return m;
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!usable(m)) continue;
    if (!INJECTED_SOURCE_KINDS.has(m?.source?.kind)) return m;
  }
  return null;
}

const routeKey = (r) => `${r.provider}/${r.model}@${r.effort === undefined ? '' : r.effort}`;

/* ── 插件本体 ─────────────────────────────────────────────────────────────── */

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (cfg.mode === 'off') return;

  const logPath = abs(cfg.logPath);
  const rulesPath = abs(cfg.rulesPath);

  // ★ 额度兜底状态（内存态：插件重载即复位，符合"一次会话内的临时降级"语义）
  const quotaFallback = { ...DEFAULTS.quotaFallback, ...(cfg.quotaFallback || {}) };
  const manualOverride = { ...DEFAULTS.manualOverride, ...(cfg.manualOverride || {}) };

  /** 显式模式文件（按 mtime 缓存）：'auto' | 'manual' | null */
  let modeCache = { mtimeMs: -1, mode: null };
  function modeFileMode() {
    try {
      const p = abs(manualOverride.modeFile);
      const st = statSync(p);
      if (st.mtimeMs === modeCache.mtimeMs) return modeCache.mode;
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const m = j && (j.mode === 'auto' || j.mode === 'manual') ? j.mode : null;
      modeCache = { mtimeMs: st.mtimeMs, mode: m };
      return m;
    } catch { return null; }
  }

  /**
   * 用户**尚未被使用**的手选：会话投影 `modelSelection.pending`。
   * 为什么只看 pending：`lastUsed` 是"上一个请求实际用的"，那正是**我们自己**设的，
   * 拿整份投影比较会把每次路由都误判成用户手选（旧插件踩过，见其注释）。
   */
  function pendingPickOf(agent) {
    try {
      const proj = ctx.get?.('sessionProjections');
      if (!proj || typeof proj.stateOf !== 'function' || !agent?.session) return null;
      const raw = proj.stateOf(agent.session, 'modelSelection');
      if (!raw || typeof raw !== 'object' || !('pending' in raw)) return null;
      const pick = raw.pending;
      if (!pick || typeof pick !== 'object') return null;
      return typeof pick.provider === 'string' && typeof pick.model === 'string' ? pick : null;
    } catch { return null; }
  }
  let quotaUntil = 0;   // 时间戳；0 = 未触发
  let quotaCode = null; // 触发时的状态码，仅用于审计

  /** 每个 agent 的会话级状态（sticky 的落点） */
  const state = new WeakMap();
  const disposers = new Map();

  /* 规则表：按 mtime 热加载（改规则不用重启，但仍由 sticky 决定是否切） */
  let rulesCache = { mtimeMs: -1, doc: null, err: null };
  function loadRules() {
    try {
      const st = statSync(rulesPath);
      if (rulesCache.doc !== null && st.mtimeMs === rulesCache.mtimeMs) return rulesCache.doc;
      const doc = JSON.parse(readFileSync(rulesPath, 'utf8'));
      rulesCache = { mtimeMs: st.mtimeMs, doc, err: null };
      return doc;
    } catch (e) {
      rulesCache = { ...rulesCache, err: e && e.message ? e.message : String(e) };
      return rulesCache.doc; // 读坏了就继续用上一版（不因规则文件出错而中断会话）
    }
  }

  function emit(row) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...row })}\n`, 'utf8');
    } catch { /* 审计写不了也不能影响会话 */ }
  }

  /** 日志里只留用户消息的开头若干字，避免把长文写进审计 */
  function lastUserPreview(msg) {
    const t = textOf(msg ? [msg] : []).replace(/\s+/g, ' ').trim();
    return t.slice(0, cfg.previewChars);
  }

  /** 首个命中规则；没命中 → default。返回 { rule, why, target, preview } */
  function pick(userMessage) {
    const doc = loadRules();
    const preview = lastUserPreview(userMessage);
    if (!doc) return { rule: 'rules-unavailable', why: rulesCache.err || 'no-rules', target: null, preview };

    const batch = userMessage ? [userMessage] : [];
    const text = textOf(batch).toLowerCase();
    const img = hasImage(batch);

    for (const r of Array.isArray(doc.rules) ? doc.rules : []) {
      const hitKw = (Array.isArray(r.any) ? r.any : []).find((k) => k && text.includes(String(k).toLowerCase()));
      if (hitKw !== undefined) {
        return {
          rule: r.id || 'unnamed',
          why: `keyword:${hitKw}`,
          preview,
          target: { provider: r.provider, model: r.model, effort: r.effort === null ? undefined : r.effort },
        };
      }
      if (r.image === true && img) {
        return {
          rule: r.id || 'unnamed',
          why: 'image',
          preview,
          target: { provider: r.provider, model: r.model, effort: r.effort === null ? undefined : r.effort },
        };
      }
    }
    const d = doc.default || {};
    return {
      rule: 'default',
      why: 'no-rule-match',
      preview,
      target: { provider: d.provider, model: d.model, effort: d.effort === null ? undefined : d.effort },
    };
  }

  /**
   * 把目标路由解析成宿主认可的调用配置。
   * 用 `ctx.llm.resolveCallConfig` —— 与 `/model` 命令**同一个**校验器（它会按模型声明的
   * 档位校验 effort）。effort 不合法时**降级为不带 effort**，并记 `effort_dropped`：
   * 这正好把 B 方案（档位声明缺口）与 A 方案连起来，而不是让一次非法 effort 打断会话。
   */
  async function resolveTarget(target) {
    const llm = ctx.get?.('llm') ?? ctx.llm;
    if (!llm || typeof llm.resolveCallConfig !== 'function') return { resolved: null, error: 'no-llm-service' };
    try {
      const r = await llm.resolveCallConfig({
        provider: target.provider,
        model: target.model,
        ...(target.effort === undefined ? {} : { reasoningEffort: target.effort }),
      });
      return {
        resolved: {
          provider: r.provider,
          model: r.model,
          ...(r.reasoningEffort === undefined ? {} : { reasoningEffort: String(r.reasoningEffort) }),
        },
        droppedEffort: false,
      };
    } catch (e) {
      if (target.effort !== undefined) {
        try {
          const r = await llm.resolveCallConfig({ provider: target.provider, model: target.model });
          return {
            resolved: {
              provider: r.provider,
              model: r.model,
              ...(r.reasoningEffort === undefined ? {} : { reasoningEffort: String(r.reasoningEffort) }),
            },
            droppedEffort: true,
            error: e && e.message ? e.message : String(e),
          };
        } catch (e2) {
          return { resolved: null, error: e2 && e2.message ? e2.message : String(e2) };
        }
      }
      return { resolved: null, error: e && e.message ? e.message : String(e) };
    }
  }

  function currentRouteOf(agent) {
    try {
      const c = agent?.session?.requestHeader?.()?.config;
      if (!c) return null;
      return {
        provider: c.provider,
        model: c.model,
        ...(c.reasoningEffort === undefined ? {} : { reasoningEffort: String(c.reasoningEffort) }),
      };
    } catch { return null; }
  }

  const sessionIdOf = (agent) => {
    try { return agent?.session?.header?.id ?? agent?.id ?? null; } catch { return null; }
  };

  /**
   * apply 模式的核心：只在「目标 ≠ 当前」时才落一次选择。
   * 落法是宿主自己的路径（--why 可回放的唯一真源）。
   */
  async function enforce(agent, decision, step) {
    const s = state.get(agent) || { rule: null, route: null, switched: 0, engaged: true, disengageReason: '' };
    state.set(agent, s);

    // ★★ 手动让位（2026-10-21）：优先级 = 显式模式文件 > 自动检测手选。
    const fm = modeFileMode();
    if (fm === 'manual' && s.engaged) {
      s.engaged = false;
      s.disengageReason = 'manual-file';
      emit({ event: 'router-yield', session: sessionIdOf(agent), step, reason: 'manual-file' });
    } else if (fm === 'auto' && !s.engaged) {
      s.engaged = true;
      s.disengageReason = '';
      emit({ event: 'router-resume', session: sessionIdOf(agent), step, reason: 'mode-file-auto' });
    }
    if (s.engaged && manualOverride.yieldOnManual) {
      const pick = pendingPickOf(agent);
      if (pick) {
        const applied = s.route
          ? routeKey({ provider: s.route.provider, model: s.route.model, effort: s.route.reasoningEffort ?? s.route.effort })
          : null;
        const picked = routeKey({ provider: pick.provider, model: pick.model, effort: pick.reasoningEffort ?? pick.effort });
        if (applied !== picked) {
          s.engaged = false;
          s.disengageReason = 'manual-pick';
          emit({
            event: 'router-yield', session: sessionIdOf(agent), step, reason: 'manual-pick',
            pick: `${pick.provider}/${pick.model}`, applied,
          });
        }
      }
    }
    if (!s.engaged) {
      emit({
        event: 'decision', session: sessionIdOf(agent), step, rule: decision.rule,
        why: `yielded:${s.disengageReason}`, action: 'yield', preview: decision.preview,
      });
      return;
    }

    // ★ 额度兜底（2026-10-21）：402 之后的一段时间内，**强制**走 %PAYG_PROVIDER% 按量档。
    //   思考挡位是**手写**的（quotaFallback.effort），不继承原档位。
    if (quotaFallback.enabled && Date.now() < quotaUntil
        && quotaFallback.provider && quotaFallback.model) {
      decision = {
        ...decision,
        rule: 'quota-fallback',
        why: `quota-exhausted(status=${quotaCode ?? '?'}) until ${new Date(quotaUntil).toISOString()}`,
        target: {
          provider: quotaFallback.provider,
          model: quotaFallback.model,
          ...(quotaFallback.effort === null ? {} : { effort: quotaFallback.effort }),
        },
      };
    }

    const target = decision.target;
    if (!target || !target.provider || !target.model) {
      emit({ event: 'decision', session: sessionIdOf(agent), step, rule: decision.rule, why: decision.why, action: 'skip', note: 'no-target' });
      return;
    }

    const current = currentRouteOf(agent);
    const same = current && routeKey({ provider: current.provider, model: current.model, effort: current.reasoningEffort }) === routeKey(target);

    // sticky：**已命中过非 default 规则**且规则表未变 ⇒ 一律 hold。
    // 语义来自计划 §5.3「命中后整个 session 保持」：后续消息不再匹配也**不切回**默认模型，
    // 否则会把同一会话在模型间来回搬（正是旧插件的老毛病）。
    // default 不 sticky —— 第一次没命中很常见（如"你好"），要允许后续真任务把路由提上去。
    const rulesUnchanged = rulesCache.mtimeMs === s.rulesMtimeMs;
    const stickyHold = s.route !== null && s.rule !== 'default' && s.rule !== null
      && s.rule !== 'quota-fallback' && rulesUnchanged;

    if (same || stickyHold) {
      const before = s.route;
      s.route = s.route || target;
      s.rule = s.rule || decision.rule;

      // ⚠ 日志报**实际**路由，不报缓存：用户可能在面板手选换了模型，而 `s.route` 仍是
      //   切换那一刻的值。2026-10-20 实测过这个 bug —— `hold` 行写 `gpt-6.1-sol`，
      //   同期 `request` 行全是 `deepseek-flash`（方向安全，但审计与事实不符）。
      const actual = current ?? s.route;
      const actualSource = current ? 'header' : 'cache';
      const drift = before !== null && routeKey({
        provider: before.provider, model: before.model, effort: before.effort,
      }) !== routeKey({ provider: actual.provider, model: actual.model, effort: actual.effort });

      if (drift) s.route = actual; // 缓存回真，否则这条会话会永远带着一个假路由记账

      emit({
        event: 'decision', session: sessionIdOf(agent), step, rule: s.rule, why: decision.why,
        model: `${actual.provider}/${actual.model}`,
        effort: actual.effort ?? null,
        action: 'hold',
        hold_reason: same ? 'route-already-current' : 'sticky-session',
        actual_source: actualSource,
        ...(drift ? { drift: true, cached_before: `${before.provider}/${before.model}` } : {}),
        preview: decision.preview,
      });
      return;
    }

    const { resolved, droppedEffort, error } = await resolveTarget(target);
    if (!resolved) {
      emit({ event: 'decision', session: sessionIdOf(agent), step, rule: decision.rule, why: decision.why, action: 'error', error: error || 'unresolved' });
      return;
    }

    const controller = ctx.get?.('sessionController') ?? ctx.sessionController;
    const applyFn = controller?.agents?.selectForNextRequest;
    if (typeof applyFn !== 'function') {
      emit({ event: 'decision', session: sessionIdOf(agent), step, rule: decision.rule, why: decision.why, action: 'no-controller', model: `${resolved.provider}/${resolved.model}` });
      return;
    }

    applyFn.call(controller.agents, agent, resolved);
    s.rule = decision.rule;
    s.route = resolved;
    s.rulesMtimeMs = rulesCache.mtimeMs;
    s.switched += 1;

    emit({
      event: 'decision', session: sessionIdOf(agent), step, rule: decision.rule, why: decision.why,
      model: `${resolved.provider}/${resolved.model}`,
      effort: resolved.reasoningEffort ?? null,
      action: 'switch',
      switch_reason: current ? 'rule-wants-different-route' : 'first-route',
      preview: decision.preview,
      ...(droppedEffort ? { effort_dropped: true, effort_error: error } : {}),
    });
  }

  /** observe 模式：只记录宿主的实际路由 */
  function observeRequest(agent, payload, resolved) {
    const s = state.get(agent) || { rule: null, route: null };
    state.set(agent, s);
    emit({
      event: 'request', session: sessionIdOf(agent), step: payload?.step ?? null, turn: payload?.turn ?? null,
      actual: resolved ? `${resolved.provider}/${resolved.model}` : null,
      effort: resolved?.reasoningEffort ?? null,
      mode: cfg.mode,
    });
  }

  /**
   * 判「创建时是否**显式**指定了 provider+model」——显式的就不接管。
   *
   * 为什么不能用 `agent.options.provider/model` 存在性判断：实测两者**都存在**。
   *   · 显式 spawn（`provider: %PAYG_PROVIDER%2, model: gpt-5.6-terra`）→ options={provider,model,subagentDepth}
   *   · 不指定 → options={provider:deepseek-account, model:deepseek-flash, reasoningEffort, subagentDepth}
   * 即 options 里装的是**解析后的生效值**，不是"用户有没有说"。
   *
   * 可用的判据：**与默认模型选择比对**。等于默认 ⇒ 没人显式指定（只是继承了默认）⇒ 规则照常接管；
   * 不等于默认 ⇒ 一定是调用方点名要的 ⇒ 不接管（保住「在哪个档 spawn 就在哪个档跑」的老口径）。
   * 代价：显式点名"恰好就是默认模型"时分辨不出，会被规则接管 —— 已知且可接受。
   */
  function explicitRouteOf(agent) {
    try {
      const opts = agent?.options;
      if (!opts || typeof opts.provider !== 'string' || typeof opts.model !== 'string') return null;
      const svc = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel;
      const def = svc?.currentSelection?.();
      if (!def || typeof def.provider !== 'string') return null; // 拿不到默认 ⇒ 不跳过（保持原行为）
      if (def.provider === opts.provider && def.model === opts.model) return null;
      return { provider: opts.provider, model: opts.model };
    } catch { return null; }
  }

  function attach(agent) {
    if (!agent || typeof agent !== 'object') return;
    if (disposers.has(agent)) return;
    const agentCtx = agent.ctx;
    if (!agentCtx || typeof agentCtx.on !== 'function') return;

    // 显式指定了模型 ⇒ 本 agent 的**路由**让位（仍保留只读观测，便于对账）
    const explicit = explicitRouteOf(agent);
    const offPre = agentCtx.on('agent/pre-step', async (payload, next) => {
      let decision;
      try { decision = await next(); } catch (e) { throw e; }
      try {
        if (decision && decision.kind !== 'reject' && Array.isArray(decision.messages) && decision.messages.length > 0) {
          const lastUser = lastUserMessage(decision.messages);
          if (lastUser !== null) {
            const picked = pick(lastUser);
            if (explicit !== null) {
              // 显式指定过模型 ⇒ 不接管，只记账（用户 2026-10-20 裁定：
              // 「创建时已显式指定 provider+model 的 agent，规则不接管」）
              emit({
                event: 'decision', session: sessionIdOf(agent), step: payload?.step ?? null,
                rule: picked.rule, why: picked.why,
                model: `${explicit.provider}/${explicit.model}`,
                effort: null,
                action: 'skip-explicit-route',
                note: 'agent.options 与 agentDefaultModel 不同 ⇒ 调用方点名指定',
                preview: picked.preview,
              });
            } else if (cfg.mode === 'apply') {
              // ⚠ 必须 await：不 await 的话切换可能晚于本步的 `system-prompt/assemble`
              //   ⇒ 切换要等下一步才生效（观感是"慢一拍"）。resolveCallConfig 是**进程内**
              //   校验（无网络），实测耗时 ~1ms；enforce 自身绝不抛。
              await enforce(agent, picked, payload?.step ?? null).catch(() => {});
            } else {
              emit({
                event: 'decision', session: sessionIdOf(agent), step: payload?.step ?? null,
                rule: picked.rule, why: picked.why,
                model: picked.target ? `${picked.target.provider}/${picked.target.model}` : null,
                effort: picked.target?.effort ?? null,
                action: 'would-apply', mode: 'observe',
                preview: picked.preview,
                // debug:true 时才展开消息形态（排查"注入块被当成用户消息"这类问题用）
                ...(cfg.debug === true
                  ? {
                    shapes: (decision.messages || []).slice(-5).map((m) => ({
                      r: m?.role ?? null,
                      s: m?.source ? `${m.source.kind}/${m.source.form ?? ''}` : null,
                      n: textOf([m]).length,
                    })),
                  }
                  : {}),
              });
            }
          }
        }
      } catch { /* 观察失败绝不影响步骤 */ }
      return decision;
    });

    const offReq = agentCtx.on('agent/request', async (payload, next) => {
      let resolved;
      try {
        resolved = await next();
      } catch (e) {
        // ★ 额度超限检测（2026-10-21）：`next()` 抛错是**唯一**能看到上游状态码的地方。
        //   命中配置的状态码 ⟹ 记下到期时间，后续 pre-step 走 %PAYG_PROVIDER% 按量兜底。
        const q = quotaFallback.enabled ? isQuotaError(e, quotaFallback.statusCodes) : { hit: false, reason: 'disabled' };
        if (q.hit) {
          const ttl = Number(quotaFallback.ttlMs) || 0;
          const reset = resetAtOf(e);
          // 上游给了恢复时间就用到那时（封顶 24h），否则用配置的 ttl
          quotaUntil = reset && reset > Date.now()
            ? Math.min(reset, Date.now() + 24 * 3600e3)
            : Date.now() + ttl;
          quotaCode = q.status ?? q.reason;
          try {
            emit({
              event: 'quota-exhausted', session: sessionIdOf(agent), step: payload?.step ?? null,
              status: q.status, reason: q.reason, until: new Date(quotaUntil).toISOString(),
              resetAt: reset ? new Date(reset).toISOString() : null,
              fallback: `${quotaFallback.provider}/${quotaFallback.model}`,
              effort: quotaFallback.effort ?? null,
            });
          } catch { /* 审计失败不影响原错误 */ }
        } else {
          // ★ 未命中也要留痕：否则"兜底没生效"是静默的（2026-10-21 事故的第二个教训）
          try {
            emit({
              event: 'quota-miss', session: sessionIdOf(agent), step: payload?.step ?? null,
              status: q.status, reason: q.reason,
              message: String(e?.message ?? e).slice(0, 140),
            });
          } catch { /* ignore */ }
        }
        throw e; // 必须原样抛回：不改变原有失败语义
      }
      try { observeRequest(agent, payload, resolved); } catch { /* ignore */ }
      return resolved; // 只读：原样返回
    });

    const dispose = () => { try { offPre(); } catch {} try { offReq(); } catch {} };
    disposers.set(agent, dispose);

    // 证据行：把「为什么接管/不接管」的依据写下来（不靠猜字段）
    let diag;
    try {
      const svc = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel;
      const def = svc?.currentSelection?.() ?? null;
      diag = {
        options: { provider: agent?.options?.provider ?? null, model: agent?.options?.model ?? null },
        default: def ? { provider: def.provider, model: def.model } : null,
        explicit: explicit === null ? null : `${explicit.provider}/${explicit.model}`,
        routing: explicit === null ? 'managed' : 'skipped(explicit-model)',
      };
    } catch (e) { diag = `err:${e && e.message}`; }

    emit({ event: 'attach', session: sessionIdOf(agent), agent: agent?.id ?? null, mode: cfg.mode, listener: 'registered', diag });
  }

  // 插件自己的 effect：卸载时把**所有** agent 上的注册一起摘掉（practices 要求两处都兜）
  ctx.effect(() => () => {
    for (const d of disposers.values()) { try { d(); } catch { /* ignore */ } }
    disposers.clear();
  }, 'rule-router: detach agent listeners');

  ctx.on('agent/created', ({ agent } = {}) => {
    try { attach(agent); } catch { /* 绝不 throw：会让 agent 创建失败 */ }
  });

  /**
   * 补挂**已存在**的 agent。
   *
   * ⚠ 这条是被实测逼出来的：插件经 HMR 重载（改一行代码就重载一次）后，`agent/created`
   *   早就发生过、**不会再触发** ⟹ 当前会话的 agent 永远挂不上监听器 ⟹ 路由与观测
   *   **静默失效**（2026-10-20 23:39 实测：重载后整轮 19 个 step 一行日志都没有）。
   *   失败方向必须可观测：拿不到 `agents` 服务就记 `no-agents-registry`，绝不假装挂着。
   */
  function attachLiveAgents() {
    try {
      const reg = ctx.get?.('agents') ?? ctx.agents;
      const store = reg?.store;
      if (!store || typeof store.forEach !== 'function') {
        emit({ event: 'attach-live', ok: false, note: 'no-agents-registry' });
        return;
      }
      let attached = 0;
      for (const value of store.values()) {
        const agent = value?.agent ?? value; // 兼容「条目包着 agent」与「直接存 agent」两种形态
        if (!agent || !agent.ctx) continue;
        const before = disposers.size;
        attach(agent);
        if (disposers.size > before) attached += 1;
      }
      emit({ event: 'attach-live', ok: true, scanned: store.size, attached });
    } catch (e) {
      emit({ event: 'attach-live', ok: false, note: e && e.message ? e.message : String(e) });
    }
  }

  attachLiveAgents();

  // 自证：插件确实被 apply 了（不靠"看起来加载了"判断）
  emit({ event: 'apply', mode: cfg.mode, rules: rulesPath, log: logPath, workspace: WORKSPACE });
}
