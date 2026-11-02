/**
 * guard-ui 客户端半冒烟自测 —— 不需要 DSH、不需要浏览器、不需要 DOM。
 *
 * 覆盖：
 *   · 自注册形态：`window.__ModuleLoader__.load({id, factory})` + `exports.apply` / `exports.inject`
 *     （形态写错会触发 "loaded without registering ... via __ModuleLoader__.load"）
 *   · `settings.section` 注册契约：name/id/order/label/locale 与 catalogue 一致
 *   · apply 的**降级纪律**：slots 缺失 / 注册抛错 / locale 缺失，都不得炸掉插件加载
 *   · `readWorkspaces` 的取数与缺服务兜底
 *   · 组件**渲染路径**至少能跑通一次（用 fake React + fake ReactDOM 无关的树断言）
 *
 * ⚠ 诚实边界：本脚本用 **fake React**（只有 createElement + 桩 hooks）驱动渲染，
 *   它证明不了「真 React 下渲染正确」——那是 V1，需要 Lead 落 profile 条目后在真页面看。
 *
 * 用法：node guards/guard-ui/test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(here, '..', 'lib', 'client.js');

let bad = 0;
const check = (what, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`   ${pass ? '✅' : '❌'} ${what}${extra ? `  ${extra}` : ''}`);
};

/** fake React：createElement + 桩 hooks（足够驱动一次渲染） */
function makeFakeReact({ runEffects = false } = {}) {
  const states = [];
  const effects = [];
  let idx = 0;
  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      return { type, props: props || {}, children };
    },
    useState(init) {
      const i = idx++;
      if (!(i in states)) states[i] = init;
      const set = (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; };
      return [states[i], set];
    },
    useEffect(fn) { effects.push(fn); if (runEffects) fn(); },
    useCallback(fn) { return fn; },
    useRef(v) { return { current: v }; },
    __reset() { idx = 0; },
  };
  return React;
}

/** 造一个「像宿主那样」的模块加载器 + 把 client.js 喂进去，返回注册表 */
function loadClientBundle({ fakeReact, fetchImpl } = {}) {
  const registry = new Map();
  const loadCalls = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loadCalls.push(spec);
        registry.set(spec.id, spec);
      },
    },
  };
  const prevFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  // client.js 顶部直接调用 window.__ModuleLoader__.load，故用动态 import 触发执行
  return import(pathToFileURL(CLIENT_PATH).href + `?t=${Date.now()}-${Math.random()}`).then(() => {
    if (fetchImpl !== undefined) globalThis.fetch = prevFetch;
    return { registry, loadCalls };
  });
}

/** 取出 factory 的 exports（宿主 materialize 的同义动作） */
function materialize(spec, fakeReact) {
  const require = (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`未 stub 的模块：${name}`);
  };
  return spec.factory(require);
}

// ─────────────────────────────────────────────────────────────

console.log('=== 0) 源文件形态：必须是 __ModuleLoader__.load 自注册，且无裸 ESM export ===');
{
  const src = readFileSync(CLIENT_PATH, 'utf8');
  check('含 window.__ModuleLoader__.load(', src.includes('window.__ModuleLoader__.load('));
  check('含 factory: (require) =>', /factory:\s*\(require\)\s*=>/.test(src));
  check('含 require("react")', src.includes('require("react")'));
  check('含 exports.apply / exports.inject / return module.exports',
    src.includes('exports.apply = apply') && src.includes('exports.inject = inject') && src.includes('return module.exports'));
  // 裸 ESM export 会让加载器报「未注册」
  const bareExports = src.split('\n').filter((l) => /^\s*export\s+(default|const|function|class|\{)/.test(l));
  check('★ 没有裸 ESM export 语句', bareExports.length === 0, JSON.stringify(bareExports));
  // JSX 检查：必须先把**注释与字符串**剥掉，否则注释里的 `<method>` / `<style>` 会假阳性
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')   // 行注释
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")       // 单引号字符串
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');      // 双引号字符串
  check('★ 代码里没有 JSX（无构建步骤的前提）', !/<[A-Za-z][^>]*>/.test(stripped),
    JSON.stringify((stripped.match(/<[A-Za-z][^>]*>/g) || []).slice(0, 3)));
  check('★ 用 React.createElement 构造元素（免编译）', src.includes('React.createElement'));
  check('不依赖 jsx runtime', !src.includes('react/jsx-runtime') && !/\b_jsxs?\(/.test(src));
}

console.log('\n=== 1) 自注册 + exports 形态 ===');
let registry;
{
  const fakeReact = makeFakeReact();
  const r = await loadClientBundle({ fakeReact });
  registry = r.registry;
  check('注册了一次，且 id = "guard-ui"', r.loadCalls.length === 1 && r.loadCalls[0].id === 'guard-ui',
    JSON.stringify(r.loadCalls.map((c) => c.id)));
  check('factory 是函数', typeof r.loadCalls[0].factory === 'function');
}

console.log('\n=== 2) settings.section 注册契约 ===');
{
  const fakeReact = makeFakeReact();
  const mod = materialize(registry.get('guard-ui'), fakeReact);
  check('exports.apply 是函数', typeof mod.apply === 'function');
  check('exports.inject 是数组且含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject));
  check('inject 含 locale / workspaces', mod.inject.includes('locale') && mod.inject.includes('workspaces'));
  check('★ 不含 react（R1：react 由宿主 seed 注入，不进 inject）', !mod.inject.includes('react'));

  const registered = [];
  const disposed = [];
  const ctx = {
    effect: (fn, label) => { const d = fn(); disposed.push({ label, d }); return d; },
    locale: {
      bind: () => (key) => `T:${key}`,
      register: (ns, dicts) => { registered.push({ ns, dicts }); return () => {}; },
    },
    slots: {
      inject: (slot, factory) => { registered.push({ slot, ret: factory() }); },
      register: (descriptor, Component) => { registered.push({ descriptor, Component }); return () => {}; },
    },
  };
  // 给一个最小 fake DOM：走 `<style>` 兜底分支（无 CSSStyleSheet/adoptedStyleSheets），
  // 从而真的验证「样式经 ctx.effect 注册 + disposer 能摘掉 <style>」这条路径。
  const tags = [];
  const prevDoc = globalThis.document;
  globalThis.document = {
    head: { appendChild: (t) => tags.push(t) },
    createElement: () => ({ setAttribute() {}, remove() { this.removed = true; }, textContent: '' }),
  };
  try {
    mod.apply(ctx);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
  const inj = registered.find((r) => r.slot === 'settings.section');
  check('★ 经 ctx.slots.inject("settings.section", …) 注册', inj !== undefined);
  const desc = registered.find((r) => r.descriptor)?.descriptor;
  check('descriptor.name = settings.section', desc?.name === 'settings.section');
  check('★ descriptor.id = "guard-ui"（新 id 只是并列新增，不覆盖壳层条目）', desc?.id === 'guard-ui');
  check('descriptor.order = 30', desc?.order === 30);
  check('descriptor.label 是**函数**（thunk，跟语言）', typeof desc?.label === 'function' && desc.label() === 'T:nav');
  check('descriptor.locale = guardUi', desc?.locale === 'guardUi');
  check('★ 只用了 catalogue 里有的字段（id/order/label）+ 生产已验证的 locale',
    JSON.stringify(Object.keys(desc).sort()) === JSON.stringify(['id', 'label', 'locale', 'name', 'order']),
    JSON.stringify(Object.keys(desc).sort()));
  const comp = registered.find((r) => r.Component)?.Component;
  check('组件是函数（React 函数组件）', typeof comp === 'function');
  check('locale 字典已注册（zh/en）', registered.some((r) => r.ns === 'guardUi' && r.dicts?.zh && r.dicts?.en));
  const styleFx = disposed.find((d) => d.label === 'guard-ui: styles');
  check('★ 样式经 ctx.effect 注册（随 fiber 回收）', styleFx !== undefined);
  check('★ 样式标签已插入 <head>', tags.length === 1);
  check('★ 调用 disposer 能摘掉 <style>（卸载不留残留）', (() => {
    styleFx.d();
    return tags[0].removed === true;
  })());
}

console.log('\n=== 3) 降级纪律：apply 绝不炸插件加载 ===');
{
  const fakeReact = makeFakeReact();
  const mod = materialize(registry.get('guard-ui'), fakeReact);
  const noSlots = { effect: (fn) => fn() };
  let e1 = null;
  try { mod.apply(noSlots); } catch (e) { e1 = e; }
  check('slots 缺失 ⇒ 不抛', e1 === null, e1 ? String(e1.message) : '');

  const slotsThrows = { effect: (fn) => fn(), slots: { inject: () => { throw new Error('host has no settings.section'); } } };
  let e2 = null;
  try { mod.apply(slotsThrows); } catch (e) { e2 = e; }
  check('★ slots.inject 抛错 ⇒ **只降级**、不炸（否则整插件加载失败）', e2 === null, e2 ? String(e2.message) : '');

  const noLocale = { effect: (fn) => fn(), slots: { inject: () => {}, register: () => () => {} } };
  let e3 = null;
  try { mod.apply(noLocale); } catch (e) { e3 = e; }
  check('locale 缺失 ⇒ 中文兜底、不抛', e3 === null, e3 ? String(e3.message) : '');
}

console.log('\n=== 4) readWorkspaces：取数 + 缺服务兜底 ===');
{
  const fakeReact = makeFakeReact();
  const mod = materialize(registry.get('guard-ui'), fakeReact);
  const hooks = mod.__testHooks;
  check('__testHooks 暴露（无运行时副作用）', !!hooks && typeof hooks.readWorkspaces === 'function');
  const full = hooks.readWorkspaces({ workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: 'E:\\a', title: 'A' }, { workspaceId: 'w2', path: 'E:\\b' }] }) } } });
  check('映射成 {id,path,title}', full.length === 2 && full[0].id === 'w1' && full[0].path === 'E:\\a');
  check('缺 title 时用 path 兜底', full[1].title === 'E:\\b');
  check('无 workspaces 服务 ⇒ null（页面显式提示，不假装空列表）', hooks.readWorkspaces({}) === null);
  check('getSnapshot 抛错 ⇒ null（不炸渲染）',
    hooks.readWorkspaces({ workspaces: { list: { getSnapshot: () => { throw new Error('x'); } } } }) === null);
}

console.log('\n=== 5) 组件渲染路径能跑通（fake React；真渲染是 V1 / NOT RUN）===');
{
  const fakeReact = makeFakeReact();
  const mod = materialize(registry.get('guard-ui'), fakeReact);
  // apply 一次让组件闭包拿到 ctx（并注册组件）
  let Component = null;
  mod.apply({
    effect: (fn) => fn(),
    slots: { inject: (s, f) => f(), register: (d, C) => { Component = C; return () => {}; } },
  });
  check('apply 捕获到组件', typeof Component === 'function');
  fakeReact.__reset();
  let tree = null;
  let threw = null;
  try { tree = Component(); } catch (e) { threw = e; }
  check('★ 首次渲染不抛', threw === null, threw ? String(threw.message) : '');
  check('返回元素树（div.gu-root）', tree && tree.type === 'div' && tree.props.className === 'gu-root');
  const flat = JSON.stringify(tree);
  check('★ 含标题文案（locale 缺失 ⇒ 中文兜底「guard 档」）', flat.includes('guard 档'));
  check('★ 含「取不到工作区列表」提示（workspaces 服务缺失时如实说明）', flat.includes('取不到工作区列表'));
  check('渲染不含 undefined 字符串', !flat.includes('undefined'));
}

console.log(`\n${bad === 0 ? '✅ guard-ui 客户端半冒烟全部通过' : `❌ 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
