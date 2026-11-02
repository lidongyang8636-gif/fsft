/**
 * guard-ui「静态可加载性」自检 —— D-D 的前置门禁。
 *
 * 为什么单独一个文件：Lead 落地 profile 条目（`- insert: id guard-ui / name: <绝对路径>`）之后，
 * **Loader 会立刻 import 这个路径**。若那时才发现语法错 / 顶层 import 悬空 / import 期有副作用，
 * 就是「注册即加载失败」——正是 D-D 要避免的顺序错误。
 *
 * 检查：
 *   ① 三个插件入口（guard-ui / role-guard / subagent-sandbox）都能干净 import（含命名导出契约）；
 *   ② `settings.js`（被两个 guard 静态 import 的单一真源）import 期**零副作用**；
 *   ③ 客户端 bundle 缺 `window.__ModuleLoader__` 时不污染全局，给了就自注册；
 *   ④ 主机半在**零 ctx 服务**下 import 期不炸；缺 webServer 时 apply 必须响亮失败。
 *
 * 用法：node guards/guard-ui/test/loadable.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const guardsDir = join(here, '..', '..');

let bad = 0;
const check = (what, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`   ${pass ? 'PASS' : 'FAIL'} ${what}${extra ? `  ${extra}` : ''}`);
};
const importFresh = (rel) => import(`${pathToFileURL(join(guardsDir, rel)).href}?t=${Date.now()}-${Math.random()}`);

console.log('=== 1) 三个插件入口都能干净 import（Lead 落 profile 条目前置）===');
const entries = [
  ['guard-ui', 'guard-ui/lib/index.js', 'guard-ui'],
  ['role-guard', 'role-guard/lib/index.js', 'dsh-role-guard'],
  ['subagent-sandbox', 'subagent-sandbox/lib/index.js', 'subagent-sandbox'],
];
for (const [label, rel, expectedName] of entries) {
  let mod = null;
  let err = null;
  try { mod = await importFresh(rel); } catch (e) { err = e; }
  check(`${label} import 干净`, err === null, err ? `${err.constructor.name}: ${err.message}` : '');
  if (mod === null) continue;
  check(`${label} name 导出 = ${expectedName}`, mod.name === expectedName, String(mod.name));
  check(`${label} apply 是函数`, typeof mod.apply === 'function');
  check(`${label} inject 是数组`, Array.isArray(mod.inject), JSON.stringify(mod.inject));
}

console.log('\n=== 2) settings.js（单一真源）import 期零副作用 ===');
{
  const probe = mkdtempSync(join(tmpdir(), 'loadable-'));
  const before = readdirSync(probe).length;
  const cwdBefore = process.cwd();
  let mod = null;
  let err = null;
  try { mod = await importFresh('guard-ui/lib/settings.js'); } catch (e) { err = e; }
  check('settings.js import 干净', err === null, err ? `${err.constructor.name}: ${err.message}` : '');
  check('import 期不建任何文件', readdirSync(probe).length === before);
  check('import 期不改 cwd', process.cwd() === cwdBefore);
  check('导出契约齐全（三处共用的那些名字）', mod !== null
    && ['KNOBS', 'GUARD_PLUGINS', 'callerWorkspaceRoot', 'resolvePluginConfig', 'mergeFor',
      'readWorkspaceSettings', 'writeWorkspaceSettings', 'deleteWorkspaceSettings',
      'createProblemReporter', 'validatePayload'].every((k) => k in mod),
    mod ? `${Object.keys(mod).length} 个导出` : '');
  check('只依赖 node 内置模块（零 npm 依赖）', (() => {
    const src = readFileSync(join(guardsDir, 'guard-ui/lib/settings.js'), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    return imports.length > 0 && imports.every((s) => s.startsWith('node:'));
  })());
  rmSync(probe, { recursive: true, force: true });
}

console.log('\n=== 3) 客户端 bundle：缺 __ModuleLoader__ 不污染全局；给了就自注册 ===');
{
  const src = readFileSync(join(guardsDir, 'guard-ui/lib/client.js'), 'utf8');
  const prevWin = globalThis.window;
  const registered = [];
  delete globalThis.window;
  let threwNoWindow = false;
  try { await importFresh('guard-ui/lib/client.js'); } catch { threwNoWindow = true; }
  check('无 window 时 import 抛错（而不是静默什么都不做）', threwNoWindow, `threw=${threwNoWindow}`);
  check('抛错后没有污染 globalThis.window', globalThis.window === undefined);
  globalThis.window = { __ModuleLoader__: { load: (spec) => registered.push(spec) } };
  let err = null;
  try { await importFresh('guard-ui/lib/client.js'); } catch (e) { err = e; }
  check('有 __ModuleLoader__ 时 import 不抛', err === null, err ? String(err.message) : '');
  check('自注册 1 次且 id = guard-ui', registered.length === 1 && registered[0].id === 'guard-ui',
    JSON.stringify(registered.map((r) => r.id)));
  if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  check('源文件声明了 id 与 factory', /id:\s*"guard-ui"/.test(src) && /factory:\s*\(require\)/.test(src));
}

console.log('\n=== 4) 主机半「零 ctx 服务」import 期不炸；缺 webServer 时 apply 响亮失败 ===');
{
  let mod = null;
  let err = null;
  try { mod = await importFresh('guard-ui/lib/index.js'); } catch (e) { err = e; }
  check('import 期不炸', err === null, err ? String(err.message) : '');
  check('未调用 apply ⇒ import 期无副作用（apply 是函数）', mod !== null && typeof mod.apply === 'function');
  let applyErr = null;
  try { mod.apply({ effect: (fn) => fn(), get: () => undefined }); } catch (e) { applyErr = e; }
  check('缺 webServer 时 apply 抛（硬依赖，不静默降级）', applyErr !== null);
}

console.log(`\n${bad === 0 ? 'OK 静态可加载性自检全部通过（D-D 前置：可以安全落 profile 条目）' : `FAIL 有 ${bad} 条不符`}`);
process.exit(bad === 0 ? 0 : 1);
