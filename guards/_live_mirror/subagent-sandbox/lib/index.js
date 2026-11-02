/**
 * subagent-sandbox — 把**子会话**钉进指定权限档（只读边界的"文件沙箱"那一半）
 *
 * ⚠ 本插件**会真的落档（enforce）**，不是只观察的探针。
 *   当前形态：Manual 档 + 命名→档位规则表（`childPresetRules`），见 README。
 *   （历史：它最初是阶段 0 的插桩探针，名叫 `<本名>-probe`；2026-10-14 正名为
 *     `subagent-sandbox`，profile 的 `id` / `name` 已同步。）
 *
 * 做什么：`agent/created` 时（serial，且在子代理**首次工具调用之前**被 await 完），
 *   若新 agent 是**子代理**（能查出创建者），就 `permissionPresets.set(child.session, <档>)`。
 *   父/Lead **永不**落档。
 *
 * 三种 mode：'observe'（只看不写）/ 'set'（观察 + 落档）/ 'off'（挂载但不动作）
 *
 * ⚠ 设计铁律（三次事故换来）：
 *   · 挂载期**绝不 throw** —— 那时服务还没就绪，抛异常会让 apply 中断 ⇒ **监听器从未注册** ⇒ 假只读；
 *   · `agent/created` 里也**绝不 throw** —— 抛异常会让**子代理创建失败**；
 *   · 配置配错 ⇒ **响亮记录 + 跳过**，绝不静默；
 *   · 必须留**可检测信号**（`listener-registered` / `effectiveConfig` / `probe-start`），
 *     因为"日志看起来像已加载"骗过一次。
 */

import { appendFileSync } from 'node:fs';

// ⚠ 与 role-guard **共用同一个写手判定**（静态 import，不是复制）——
//   2026-10-14 已因"两处口径漂移"踩过一次（role-guard 与 agentScope 各写一份）。
//   该模块只导出纯函数与常量，import 无副作用。
import { isWriterName, DEFAULT_WRITER_PATTERNS } from '../../role-guard/lib/index.js';

// ── 每工作区设置（guard-ui，PLAN §9.1 裁决 D-A：**拉取式 pull**）────────────
// 单一真源模块（P5）：与 role-guard / guard-ui 共用**同一份**，禁止复制粘贴。
// ⚠ 该模块 import 期零副作用（无 I/O、不注册服务）；但它一旦解析失败，本插件会**连带加载失败**
//   ⇒ 护栏消失（最坏的 fail-open）。故 `guards/guard-ui/test/settings.mjs` 同时充当它的
//   「可加载 + 契约」门禁，两个 guard 的 stub 自测也会在 import 期立刻暴露问题。
// ⚠ 绝不回落 process.cwd()（P1）：stub 自测的 cwd 就是仓库根，一旦回落，
//   验收时落下的 <仓库根>/.dsh-guard.json 会改写自测行为、污染 V6 回归证据。
import { createProblemReporter, resolvePluginConfig } from '../../guard-ui/lib/settings.js';

export const name = 'subagent-sandbox';

/** 没有硬依赖：所有服务都用 ctx.get 可选取，取不到就退化为观察。 */
export const inject = [];

const DEFAULTS = {
  mode: 'observe',
  childPreset: 'fpga-locked',
  eventLog: '',
  /** 只对"能查出创建者"的 agent 落档（即子代理）；父/Lead 永不落档 */
  onlyChildren: true,
  /** 惰性预检预设名（首次真要用时）；配错则响亮记录并跳过落档（绝不 throw） */
  strictPreset: true,
  // ── 阶段 1（Manual 模式）：成员豁免 ──────────────────────────────────────
  /**
   * 写手成员豁免：名字命中写手模式的**团队成员**保留原档（不被钉只读）。
   * 依据团队口径「单一 writer」：写手本人要能写；但**写权限不可委派**——
   * 写手派生出来的子代理**不是**团队成员 ⇒ 仍会被钉只读。
   */
  writerExempt: false,
  /** 写手名模式：与 role-guard **共用同一个 isWriterName**（静态 import，避免两处口径漂移） */
  writerNamePatterns: DEFAULT_WRITER_PATTERNS,
  /** 除写手外的额外豁免名模式（团队成员才适用），如 ['audit'] */
  exemptNamePatterns: [],
  // ── Auto 的**确定性替代**：命名 → 档位 规则表 ───────────────────────────
  /**
   * 按成员**名字**给不同档位（按序求值，**首个命中生效**）。
   * 每一项：`{ namePatterns: string[], preset: string | null }`
   *   · `preset: null` ⇒ **豁免**（不落档，保留原档）
   *   · `preset: '<档名>'` ⇒ 钉该档
   *
   * 为什么这样做而不是"参数式 Auto"：见 README §2.3 —— 内置委派工具
   * （`subagent`/`spawn_teammate`）的请求体**没有沙箱字段**，参数式必须自建工具，
   * 而模型仍可继续用内置工具 ⇒ **静默不生效**（本项目最忌的失败形态）。
   * 名字由 Lead 指定且不可变 ⇒ 用名字分档同样实现"父代理按需设置"，但是**确定的**。
   */
  childPresetRules: [],
};

/** 正式配置键（用于甄别拼错的键；`preset` 是 childPreset 的兼容别名） */
const KNOWN_KEYS = new Set([
  'mode', 'childPreset', 'preset', 'eventLog', 'onlyChildren', 'strictPreset',
  'writerExempt', 'writerNamePatterns', 'exemptNamePatterns', 'childPresetRules',
]);

/**
 * 规范化 + 校验配置（**绝不 throw**：挂载期抛异常会让整个插件不加载，
 * 2026-10-14 已因此出过一次"探针自炸、监听器从未注册"）
 * 返回 { cfg, warnings }，warnings 供 probe-start 留痕。
 */
export function normalizeConfig(config = {}) {
  const warnings = [];
  const cfg = { ...DEFAULTS, ...config };

  // 别名：preset → childPreset（老配置继续可用）
  if (config.preset !== undefined && config.childPreset === undefined) {
    cfg.childPreset = config.preset;
    warnings.push('preset 是 childPreset 的兼容别名，建议改用 childPreset');
  } else if (config.preset !== undefined && config.childPreset !== undefined
             && config.preset !== config.childPreset) {
    warnings.push(`preset(${config.preset}) 与 childPreset(${config.childPreset}) 冲突，以 childPreset 为准`);
  }

  // 未知键：拼错要能看见（但不阻断加载）
  for (const k of Object.keys(config)) {
    if (!KNOWN_KEYS.has(k)) warnings.push(`未知配置键：${k}（会被忽略）`);
  }

  // 类型与取值
  if (!['off', 'observe', 'set'].includes(cfg.mode)) {
    warnings.push(`mode=${JSON.stringify(cfg.mode)} 非法，回退 observe`);
    cfg.mode = 'observe';
  }
  if (typeof cfg.childPreset !== 'string' || cfg.childPreset.trim() === '') {
    warnings.push('childPreset 必须是非空字符串，回退 fpga-locked');
    cfg.childPreset = DEFAULTS.childPreset;
  }
  const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '') : []);
  if (cfg.mode === 'set' && asArray(cfg.writerNamePatterns).length === 0 && cfg.writerExempt) {
    warnings.push('writerExempt=true 但 writerNamePatterns 为空 ⇒ 豁免永不命中');
  }
  cfg.writerNamePatterns = asArray(cfg.writerNamePatterns);
  cfg.exemptNamePatterns = asArray(cfg.exemptNamePatterns);
  // childPresetRules：逐项规范化；坏条目**丢弃并告警**（绝不 throw，也绝不静默）
  cfg.childPresetRules = (Array.isArray(cfg.childPresetRules) ? cfg.childPresetRules : [])
    .map((r, i) => {
      const pats = asArray(r?.namePatterns);
      if (pats.length === 0) {
        warnings.push(`childPresetRules[${i}] 缺少 namePatterns，已忽略`);
        return null;
      }
      const raw = r?.preset;
      if (raw !== null && raw !== undefined && (typeof raw !== 'string' || raw.trim() === '')) {
        warnings.push(`childPresetRules[${i}].preset 类型非法（应为字符串或 null），已忽略该项`);
        return null;
      }
      // preset: null / 缺省 ⇒ 豁免
      const preset = (raw === null || raw === undefined) ? null : raw;
      return { namePatterns: pats, preset };
    })
    .filter(Boolean);
  if (cfg.mode === 'set' && cfg.childPresetRules.length > 0) {
    const dup = cfg.childPresetRules.length > 1;
    if (dup) warnings.push('childPresetRules 有多条规则：**按序求值、首个命中生效**（后面的不会再看）');
  }
  cfg.onlyChildren = cfg.onlyChildren !== false;
  cfg.strictPreset = cfg.strictPreset !== false;
  cfg.writerExempt = cfg.writerExempt === true;

  return { cfg, warnings };
}

export function apply(ctx, rawConfig = {}) {
  const { cfg, warnings } = normalizeConfig(rawConfig);
  // profile 生效配置的**别名**：`agent/created` 处理函数里会用一个局部 `cfg` 遮蔽它
  // （拉取式 effective），那时这个名字用来取回「无工作区文件时要用的那份」。
  // 与 `cfg` 是**同一个对象引用** ⇒ 默认路径行为与改动前逐项一致。
  const cfgProfile = cfg;
  const log = ctx.logger?.('sandbox-probe') ?? console;

  // ── 诊断通道：JSONL 写工作区（诊断失败绝不影响主功能）────────────────────
  let emit = () => {};
  if (cfg.eventLog) {
    emit = (obj) => {
      try {
        appendFileSync(cfg.eventLog, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
      } catch { /* 诊断失败不影响任何功能 */ }
    };
  }

  // ── 工作区设置问题的**响亮**通道（P4）────────────────────────────────────
  // P2 要求每次判定都重读盘 ⇒ 一个坏文件会在每次 agent/created 时产生同一条错误；
  // 去重键 = 消息本身，同一条只吼一次（**日志去重，不是取值缓存**——取值永不缓存）。
  const reportProblems = createProblemReporter((msg, info) => {
    log.warn(`[sandbox-probe] 工作区设置：${msg}${info?.cwd ? `（cwd=${info.cwd}）` : ''}`);
    emit({ event: 'workspace-settings-problem', message: msg, reason: info?.reason ?? null, cwd: info?.cwd ?? null });
  });

  const getPP = () => { try { return ctx.get?.('permissionPresets') ?? undefined; } catch { return undefined; } };
  const getAgents = () => { try { return ctx.get?.('agents') ?? undefined; } catch { return undefined; } };
  const getTeams = () => { try { return ctx.get?.('agentTeams') ?? undefined; } catch { return undefined; } };

  // ── 启动预检（E3 的前半：预设名是否存在于进程目录）──────────────────────
  const pp0 = getPP();
  let presetOk = false;
  let presetErr = null;
  if (pp0 && cfg.mode === 'set') {
    try {
      pp0.resolve(cfg.childPreset);          // 契约：名字不存在则抛
      presetOk = true;
    } catch (e) {
      presetErr = String(e?.message ?? e);
    }
  }
  emit({
    event: 'probe-start', mode: cfg.mode, childPreset: cfg.childPreset,
    // 规范化后的**完整生效配置**（Road A：让"我到底配成了什么"可核）
    effectiveConfig: {
      mode: cfg.mode, childPreset: cfg.childPreset,
      onlyChildren: cfg.onlyChildren, strictPreset: cfg.strictPreset,
      writerExempt: cfg.writerExempt, writerNamePatterns: cfg.writerNamePatterns,
      exemptNamePatterns: cfg.exemptNamePatterns, childPresetRules: cfg.childPresetRules,
    },
    // 配置告警（未知键 / 非法值 / 别名冲突）：**不阻断加载**，但要看得见
    configWarnings: warnings,
    permissionPresetsAvailable: pp0 !== undefined,
    agentsAvailable: getAgents() !== undefined,
    presetResolved: presetOk, presetError: presetErr,
    // 进程级目录（若有）：便于核对可用档名
    catalog: (() => { try { return pp0?.catalog?.() ?? null; } catch { return null; } })(),
  });
  for (const w of warnings) log.warn(`[sandbox-probe] 配置告警：${w}`);
  log.info(`[sandbox-probe] mode=${cfg.mode} childPreset=${cfg.childPreset} `
    + `writerExempt=${cfg.writerExempt} pp=${pp0 ? 'ok' : 'MISSING'} presetResolved=${presetOk}`);

  // ⚠ 2026-10-14 实测教训（阶段 0 第一次跑就栽在这）：
  //   挂载时刻 `permissionPresets` **尚未挂载**（probe-start 里 permissionPresetsAvailable:false），
  //   于是"启动时预检预设名 + 不合格就 throw"变成了**自己把自己炸掉**：
  //   apply 中断 ⇒ 监听器从未注册 ⇒ 无任何落档 ⇒ 子代理照常写文件（假 FAIL）。
  //   修法：挂载期**绝不 throw**；预检推迟到**第一次真正要用的时候**（见 listener 内），
  //   且那里也**绝不 throw**——`agent/created` 抛异常会**让子代理创建失败**（官方语义：
  //   "A throw or rejection fails creation and skips later listeners"）。
  //   配错时的正确行为：**响亮记录 + 跳过落档**，而不是炸掉自己或炸掉别人的创建。

  // ── 工具函数 ─────────────────────────────────────────────────────────────
  const presetOf = (agent) => {
    const pp = getPP();
    if (!pp || !agent?.session) return null;
    try { return pp.current(agent.session); } catch (e) { return `ERR:${e?.message ?? e}`; }
  };

  /** 找出该 agent 的创建者（用运行时所有权判定）。返回 undefined 表示它不是子代理。 */
  const findParent = (agent) => {
    const agents = getAgents();
    if (!agents?.list || !agents?.isOwnedBy || !agent?.id) return undefined;
    let list = [];
    try { list = agents.list() ?? []; } catch { return undefined; }
    for (const cand of list) {
      if (!cand || cand.id === agent.id) continue;
      try { if (agents.isOwnedBy(agent.id, cand)) return cand; } catch { /* next */ }
    }
    return undefined;
  };

  /** 全量快照：每个活 agent 的 id / 是否子代理 / 当前档（E5 用：确认父没被动过） */
  const roster = () => {
    const agents = getAgents();
    let list = [];
    try { list = agents?.list?.() ?? []; } catch { return null; }
    return list.map((a) => ({
      id: a?.id ?? null,
      hasSession: a?.session !== undefined,
      preset: presetOf(a),
      parent: findParent(a)?.id ?? null,
    }));
  };

  // ── 挂钩：agent/created（serial；在子代理开始干活之前被 await 完）────────
  const checkedPresets = new Set();  // 已校验过的档名：工作区覆盖换了档名时补校验新出现的
  const invalidPresets = new Set(); // 解析失败的档名（只跳这些档，其余照常）
  let listenerOk = false;
  let listenerErr = null;

  const onAgentCreated = ({ agent, source }) => {
    try {
      // ── 拉取式 effective（PLAN §9.1 裁决 D-A + P1/P2/P3/P4/P6）────────────
      // 判定期按 `agent.session.header.cwd` 读工作区覆盖；拿不到会话 cwd ⇒ profile 默认（P6）。
      // ⚠ 这里用**局部遮蔽**重新绑定 `cfg`：下面所有 `cfg.*` 读法一字未改，
      //   默认路径（无工作区文件）下 `pull.source==='profile'` ⇒ cfg 仍是**同一个对象**
      //   ⇒ 「无工作区文件时判定行为与改动前逐项一致」是**构造性成立**的，不靠跑测试碰运气。
      const pull = resolvePluginConfig('subagent-sandbox', rawConfig, agent);
      reportProblems(pull.problems, { reason: pull.reason, cwd: pull.cwd });
      const cfg = pull.source === 'workspace' ? normalizeConfig(pull.config).cfg : cfgProfile;

      const before = presetOf(agent);
      const parent = findParent(agent);
      const isChild = parent !== undefined;
      const hasSession = agent?.session !== undefined;

      // E1：能否拿到子会话 + 读出当前档
      emit({
        event: 'agent-created', agent: agent?.id ?? null, source: source ?? null,
        hasSession, presetBefore: before,
        parentId: parent?.id ?? null, isChild,
        mode: cfg.mode,
        // 新增（只增字段，不改旧字段语义）：这一档是从哪来的，便于事后核对「设了到底有没有生效」
        settingsSource: pull.source, settingsReason: pull.reason, settingsCwd: pull.cwd,
      });

      if (cfg.mode !== 'set') return;
      if (cfg.onlyChildren && !isChild) {
        emit({ event: 'skip-not-child', agent: agent?.id ?? null });
        return;
      }
      if (!hasSession) {
        emit({ event: 'skip-no-session', agent: agent?.id ?? null });
        return;
      }

      // ── 阶段 1（Manual）：成员豁免 + 命名→档位 规则表 ────────────────────
      // 仅对**团队成员**（spawn_teammate 派生的）按名字判定；子代理不是成员 ⇒ 不适用
      // ⇒ 与 role-guard 的「写权限不可委派」口径保持一致。
      // 优先级（自上而下，首个生效）：
      //   ① writerExempt + writerNamePatterns  → 豁免
      //   ② exemptNamePatterns                 → 豁免
      //   ③ childPresetRules（按序）           → 该规则指定的档位（preset=null 亦为豁免）
      //   ④ childPreset                        → 默认档
      let membership = null;
      const needMembership = cfg.writerExempt || cfg.exemptNamePatterns.length > 0
        || cfg.childPresetRules.length > 0;
      if (needMembership) {
        try { membership = getTeams()?.tryMembership?.(agent) ?? null; } catch { membership = null; }
      }
      let chosen = cfg.childPreset;
      let chosenBy = 'childPreset';
      if (membership) {
        const byWriter = cfg.writerExempt && isWriterName(membership.name, cfg.writerNamePatterns);
        const byExtra = cfg.exemptNamePatterns.length > 0
          && isWriterName(membership.name, cfg.exemptNamePatterns);   // 同一套匹配语义（前缀/整词）
        if (byWriter || byExtra) {
          emit({ event: byWriter ? 'skip-writer-exempt' : 'skip-name-exempt',
            agent: agent?.id ?? null, name: membership.name, role: membership.role,
            presetBefore: before, matchedBy: byWriter ? 'writerNamePatterns' : 'exemptNamePatterns' });
          log.info(`[sandbox-probe] 豁免（${byWriter ? '写手' : '额外名'}）：${membership.name} 保持 ${before}`);
          return;
        }
        // ③ 命名 → 档位 规则表（按序、首个命中生效）
        for (let i = 0; i < cfg.childPresetRules.length; i++) {
          const rule = cfg.childPresetRules[i];
          if (isWriterName(membership.name, rule.namePatterns)) {
            chosen = rule.preset;             // 可能是 null ⇒ 豁免
            chosenBy = `childPresetRules[${i}]`;
            break;
          }
        }
        if (chosen === null) {
          emit({ event: 'skip-rule-exempt', agent: agent?.id ?? null, name: membership.name,
            role: membership.role, presetBefore: before, matchedBy: chosenBy,
            patterns: cfg.childPresetRules.find((r) => r.preset === null)?.namePatterns ?? null });
          log.info(`[sandbox-probe] 豁免（命名规则 ${chosenBy}）：${membership.name} 保持 ${before}`);
          return;
        }
      }

      const parentBefore = parent ? presetOf(parent) : null;
      const pp = getPP();
      if (!pp?.set) {
        emit({ event: 'skip-no-service', agent: agent?.id ?? null });
        return;
      }

      // ── 惰性预检（E3）：第一次真要用的时候才校验**所有会用到的档名** ──────
      // 挂载期服务还没上（实测 permissionPresetsAvailable:false），所以只能在这里做。
      // ⚠ 绝不 throw：`agent/created` 抛异常会让**子代理创建失败**。
      // 坏档名 ⇒ 记入 invalidPresets，**只跳该档**（其它档照常），并响亮记录。
      // 【只增】工作区覆盖可能中途换档名 ⇒ 改成「校验**还没校验过**的档名」：
      //   默认路径下待校验集合第一次就是全集、之后为空 ⇒ 与改动前**逐项一致**（同样的
      //   emit 次数与顺序）；只有覆盖变了档名时才补校验新出现的那些。
      const usedPresets = new Set([cfg.childPreset,
        ...cfg.childPresetRules.map((r) => r.preset).filter((p) => typeof p === 'string')]);
      const unchecked = [...usedPresets].filter((p) => !checkedPresets.has(p));
      if (cfg.strictPreset && unchecked.length > 0) {
        for (const p of unchecked) {
          checkedPresets.add(p);
          try {
            pp.resolve(p);
            emit({ event: 'preset-ok', preset: p,
              catalog: (() => { try { return pp.catalog?.() ?? null; } catch { return null; } })() });
          } catch (e) {
            invalidPresets.add(p);
            emit({ event: 'preset-invalid', preset: p, error: String(e?.message ?? e) });
            log.error(`[sandbox-probe] 预设名无法解析：${p}（${e?.message ?? e}）⇒ 该档将被跳过（不炸创建流程）`);
          }
        }
      }
      if (invalidPresets.has(chosen)) {
        emit({ event: 'skip-invalid-preset', agent: agent?.id ?? null, preset: chosen, matchedBy: chosenBy });
        return;
      }

      // ★ 核心动作：只对子会话落档
      let setErr = null;
      try { pp.set(agent.session, chosen); } catch (e) { setErr = String(e?.message ?? e); }

      const after = presetOf(agent);
      const parentAfter = parent ? presetOf(parent) : null;

      // E2：写入后立刻回读 current()，看是否生效（以及随后的 delegation append 会不会覆盖）
      emit({
        event: setErr ? 'set-failed' : 'set-applied',
        agent: agent?.id ?? null, preset: chosen,
        // 可审计：这一档是**谁决定的**（默认档 / 第几条命名规则）
        presetChosenBy: chosenBy, memberName: membership?.name ?? null,
        presetBefore: before, presetAfter: after, setError: setErr,
        // E5：父会话的档**必须不变**
        parentId: parent?.id ?? null, parentPresetBefore: parentBefore, parentPresetAfter: parentAfter,
        parentUnchanged: parentBefore === parentAfter,
      });
      log.info(`[sandbox-probe] ${setErr ? 'SET-FAILED' : 'SET'} child=${agent?.id} `
        + `${before} → ${after}（by ${chosenBy}；parent ${parentBefore} → ${parentAfter}）`);

      // 全量快照留档，便于事后核对"谁被改了"
      emit({ event: 'roster-snapshot', trigger: 'after-set', roster: roster() });
    } catch (e) {
      // 铁律：探针不得影响会话
      try { emit({ event: 'probe-error', error: String(e?.message ?? e) }); } catch { /* ignore */ }
      log.error(`[sandbox-probe] 观察/落档失败（不影响会话）：${e?.message ?? e}`);
    }
  };

  // 监听器注册本身也要留痕：阶段 0 第一次跑就是"apply 提前炸掉 ⇒ 监听器从未注册"，
  // 而当时唯一的线索是"日志里没有 startup 快照"。把注册结果显式记下来。
  try {
    if (typeof ctx.on !== 'function') throw new Error('ctx.on 不是函数（该上下文不支持事件监听）');
    ctx.on('agent/created', onAgentCreated);
    listenerOk = true;
  } catch (e) {
    listenerErr = String(e?.message ?? e);
    log.error(`[sandbox-probe] 监听器注册失败：${listenerErr}`);
  }
  emit({ event: 'listener-registered', ok: listenerOk, error: listenerErr });

  // 启动时打一次全量快照，作为"改前基线"
  emit({ event: 'roster-snapshot', trigger: 'startup', roster: roster() });
}

