/**
 * effort-check —— DSH 启动时做一次「思考挡位声明自检」，**只告警，不自动改配置**
 *
 * 用户 2026-10-20 决策 1：触发点 = DSH 启动时；发现缺口只告警。
 * 决策 3：族匹配不上的模型默认跳过（不猜档位）。
 *
 * 判据与实现全在 `scripts/check-efforts.mjs` + `config/effort-families.json`，
 * 本文件只是一层启动钩子（不重复实现判定）。
 *
 * 设计铁律（沿用 guards/ 既有教训）：
 *   · apply 期**绝不 throw** —— 抛异常会让宿主组合降级（历史上因此坏过客户端 UI）；
 *   · 用**动态 import()**，模块解析失败也只记一行错误日志，不连带插件加载失败；
 *   · 必须留**可检测信号** —— `.effort-check/startup.log` 每启动追加一行 JSONL
 *     （含时间戳），否则无法区分"跑了但没缺口"与"根本没跑"。
 *   · 报告本体 `last-report.txt` 保持**确定性**（无时间戳，两次逐字一致）；
 *     时间戳只出现在 startup.log。
 *
 * 回滚：profile patch 里给该条目加 `disabled: true`，或删掉整个 insert 块，然后重启。
 */

export const name = 'effort-check';

/** 无硬依赖：不向任何服务注入，纯文件读取。 */
export const inject = [];

const DEFAULT_CONFIG = {
  enabled: true,
  /** 报告是否全量列出（默认同 CLI：前 10 条） */
  all: false,
  /** 报告目录；默认 <workspace>/.effort-check */
  outDir: '',
  /** profile 目录；默认 $USERPROFILE/.dsh/profiles/desktop */
  profileDir: '',
};

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  if (cfg.enabled === false) return;

  // 不 await：apply 必须立刻返回，不得阻塞宿主启动
  void (async () => {
    let outDir = cfg.outDir;
    try {
      const { runCheck, WORKSPACE } = await import('../../../scripts/check-efforts.mjs');
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');

      const dir = outDir || join(WORKSPACE, '.effort-check');
      mkdirSync(dir, { recursive: true });

      const t0 = Date.now();
      const r = runCheck({
        all: cfg.all === true,
        write: true,
        outDir: dir,
        profileDir: cfg.profileDir || undefined,
      });
      const dt = Date.now() - t0;

      appendFileSync(join(dir, 'startup.log'), `${JSON.stringify({
        t: new Date().toISOString(),
        event: 'startup-check',
        exit: r.code,
        verdict: r.verdict,
        counts: r.counts,
        ms: dt,
        patch: r.patchPath,
      })}\n`, 'utf8');

      // 宿主启动日志里留一行，便于跟 startup.log 对照
      console.log(`[effort-check] ${r.summary} result=${r.verdict} ${dt}ms`);
    } catch (e) {
      try {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = outDir || join(process.cwd(), '.effort-check');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'startup.log'), `${JSON.stringify({
          t: new Date().toISOString(),
          event: 'startup-check-error',
          error: e && e.message ? e.message : String(e),
        })}\n`, 'utf8');
      } catch {
        /* 连日志都写不了就彻底沉默 —— 绝不让自检拖垮宿主 */
      }
      console.error('[effort-check] 自检失败（不影响会话）：', e && e.message ? e.message : e);
    }
  })();
}
