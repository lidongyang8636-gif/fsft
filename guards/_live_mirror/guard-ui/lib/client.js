/**
 * guard-ui / 客户端半（DSH Web GUI 插件）
 *
 * BUILD NOTE（照 `dsh-super-ppts/lib/client.js` 的形态，见 EVIDENCE.1.md R1/R6）：
 * dsh 的 client 模块加载器要求特定 bundle 形态 —— 本文件**手写、无构建步骤**：
 *   · 必须经 `window.__ModuleLoader__.load({ id, factory })` 自注册；
 *   · 经 `exports.apply` / `exports.inject` 暴露扩展并 `return module.exports`；
 *   · **裸 ESM `export` 不会注册**，会触发
 *     `bundle .../client.js loaded without registering "guard-ui" via __ModuleLoader__.load`；
 *   · 一切副作用（含注入 <style>）必须在 factory 闭包内，且资源注册走 apply 里的 ctx.effect。
 *
 * React 由宿主壳作 **seed 模块**注入（`require("react")` 拿到的是与壳同一实例，
 * 故 hooks/context 可共享）。**不用 JSX** ⇒ 免编译器。
 *
 * 设置页「guard 档」一页：
 *   · 经 ctx.slots 注册 `settings.section`（导航 id: guard-ui）；
 *   · 表单**完全由 `/guard/api/settings.get` 返回的 `knobs` 驱动**——客户端不复制任何 schema，
 *     `guards/guard-ui/lib/settings.js` 是唯一真源（P5）；
 *   · 数据面走 `/guard/api/<method>`（POST JSON，{ok,value}/{ok,error} 信封）；
 *   · 双语文案走 ctx.locale（命名空间 guardUi），locale 不可用时中文兜底。
 *
 * ⚠ 本页只能改 7 个主开关；其余旋钮仍由 profile 决定，页面**显式列出**它们（不让人误以为全能改）。
 */

window.__ModuleLoader__.load({
	id: "guard-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		var NS = "guardUi";
		var API = "/guard/api";

		/* ── 双语文案 ─────────────────────────────────────────── */

		var zh = {
			nav: "guard 档",
			title: "guard 档",
			intro: "按工作区调控两个 guard（角色护栏 role-guard / 子代理沙箱 subagent-sandbox）。改动即时生效，不需要重载插件或重启。",
			scopeLabel: "作用域",
			fileLabel: "设置文件",
			statusAbsent: "无覆盖（全部取自 profile）",
			statusOk: "已覆盖",
			statusInvalid: "文件不可用（已降级为 profile）",
			statusUnknown: "—",
			sourceWorkspace: "工作区",
			sourceProfile: "profile",
			sourceBuiltin: "代码默认",
			sourceLabel: "来源",
			save: "保存到本工作区",
			reset: "删除工作区覆盖（回落 profile）",
			refresh: "刷新",
			pluginSandbox: "子代理沙箱（subagent-sandbox）",
			pluginRole: "角色护栏（role-guard）",
			noWorkspace: "取不到工作区列表（ctx.workspaces 不可用），本页暂时无法读写设置。",
			loadFailed: "读取设置失败：",
			saveOk: "已保存。guard 在**下一次判定**就会用上新值（无需重载）。",
			resetOk: "已删除工作区覆盖，回到 profile 默认。",
			resetNone: "本来就没有工作区覆盖。",
			noChanges: "没有改动。",
			routerTitle: "路由接管（rule-router）",
			routerAutoOn: "接管中",
			routerManualOn: "已让位",
			routerAutoDetect: "自动检测",
			routerHint: "你在模型位**手选**后，路由会**让位**（本会话不再切换）。点「接管」恢复按规则路由；点「清除」回到自动检测。",
			routerBtnAuto: "接管（按规则路由）",
			routerBtnManual: "让位（暂停路由）",
			routerBtnClear: "清除（自动检测）",
			routerSaved: "路由状态已更新。",
			extrasTitle: "⚠ 其余旋钮仍由 profile（cordis.patch.yml）决定，本页**不改**它们：",
			defaultsBuiltin: "⚠ 读不到 profile 现值（configEditor 不可用），下方显示的是插件**代码默认值**，未必等于 profile 现配。",
			resultsTitle: "已保存内容",
			unsaved: "有未保存的改动",
			// ── 红队 F2 / F4：不许无条件承诺「下次生效」 ──────────────────
			saveCombinationNotChecked: "⚠ 已保存，但**没有**与 profile 现值做权威组合校验（读不到 profile 现值）⇒ guard 判定期若发现跨文件组合非法，会**整份弃用**本次覆盖。",
			saveUnverified: "⚠ 已保存，但**写入后回读校验未通过** ⇒ 内容可能已被并发写者覆盖，请重新读取核对。",
			saveWithNotes: "⚠ 已写入，但宿主给出了下列限制 —— **不要**据此认为它对所有调用者都会生效：",
			saveScopeCaveat: "生效范围：",
			guaranteeDefault: "仅对**带 session cwd** 的调用者生效；取不到 cwd 的调用者按 profile 默认判定。",
			scopeCaveatTitle: "本工作区覆盖的生效范围",
			conflict: "文件已被其它写者改动（他人在你读取之后改过它）⇒ 已拒绝本次操作，请先刷新再试。",
			notesTitle: "宿主返回的注意事项",
		};
		var en = {
			nav: "Guard profiles",
			title: "Guard profiles",
			intro: "Tune the two guards (role-guard / subagent-sandbox) per workspace. Changes apply immediately — no plugin reload, no restart.",
			scopeLabel: "Scope",
			fileLabel: "Settings file",
			statusAbsent: "no override (all from profile)",
			statusOk: "overridden",
			statusInvalid: "file unusable (fell back to profile)",
			statusUnknown: "—",
			sourceWorkspace: "workspace",
			sourceProfile: "profile",
			sourceBuiltin: "code default",
			sourceLabel: "source",
			save: "Save to this workspace",
			reset: "Delete workspace override (fall back to profile)",
			refresh: "Refresh",
			pluginSandbox: "Subagent sandbox (subagent-sandbox)",
			pluginRole: "Role guard (role-guard)",
			noWorkspace: "Workspace list unavailable (ctx.workspaces missing); this page cannot read or write settings right now.",
			loadFailed: "Failed to read settings: ",
			saveOk: "Saved. The guards pick this up on their next decision — no reload needed.",
			resetOk: "Workspace override deleted; back to the profile default.",
			resetNone: "There was no workspace override.",
			noChanges: "Nothing changed.",
			routerTitle: "Model routing (rule-router)",
			routerAutoOn: "engaged",
			routerManualOn: "yielded",
			routerAutoDetect: "auto-detect",
			routerHint: "After you pick a model manually, routing **stands down** for this session. Click Engage to resume rule-based routing; Clear returns to auto-detect.",
			routerBtnAuto: "Engage (rule routing)",
			routerBtnManual: "Yield (pause routing)",
			routerBtnClear: "Clear (auto-detect)",
			routerSaved: "Routing state updated.",
			saveCombinationNotChecked: "⚠ Saved, but the cross-file invariant was NOT authoritatively checked against the live profile ⇒ if the combination is illegal the guards will DISCARD this whole override at decision time.",
			saveUnverified: "⚠ Saved, but the post-write read-back check failed ⇒ the content may have been overwritten by a concurrent writer; please re-read.",
			saveWithNotes: "⚠ Written, but the host reported the limitations below — do NOT read this as «it applies to every caller»:",
			saveScopeCaveat: "Applies to: ",
			guaranteeDefault: "callers that carry a session cwd only; callers without a cwd fall back to the profile.",
			scopeCaveatTitle: "Scope of this workspace override",
			conflict: "The file was changed by another writer after you read it ⇒ this operation was refused. Refresh and retry.",
			notesTitle: "Notes from the host",
			extrasTitle: "⚠ These remaining knobs are still decided by the profile (cordis.patch.yml) and are NOT editable here:",
			defaultsBuiltin: "⚠ Profile values unavailable (configEditor missing); the values below are plugin code defaults and may differ from the live profile.",
			resultsTitle: "Saved content",
			unsaved: "Unsaved changes",
		};

		function fill(template, params) {
			return String(template).replace(/\{(\w+)\}/g, function (m, key) {
				return params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m;
			});
		}

		/* ── host API（POST JSON，{ok,value}/{ok,error} 信封）── */

		function api(method, body) {
			return fetch(API + "/" + method, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			}).then(function (response) {
				return response.text().then(function (text) {
					var data;
					try { data = text ? JSON.parse(text) : {}; } catch (e) { throw new Error("bad JSON (" + response.status + ")"); }
					if (data && data.ok) return data.value;
					throw new Error(String((data && data.error && data.error.message) || ("HTTP " + response.status)));
				});
			});
		}

		/* ── 样式（adoptedStyleSheets + <style> 双通道，随插件卸载回收）── */

		var CSS = [
			".gu-root{display:flex;flex-direction:column;gap:18px;max-width:760px;color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:1.6;}",
			".gu-intro{color:var(--dsw-alias-label-tertiary,#888);margin:0;font-size:13px;line-height:21px;}",
			".gu-scope{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l3,#c9c9c9);border-radius:12px;}",
			".gu-scope-label{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;}",
			".gu-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#555);word-break:break-all;}",
			".gu-group{display:flex;flex-direction:column;gap:10px;padding:12px;border:0.5px solid var(--dsw-alias-border-l3,#c9c9c9);border-radius:12px;}",
			".gu-group-title{font-weight:600;font-size:13px;margin:0;}",
			".gu-row{display:flex;flex-direction:column;gap:4px;}",
			".gu-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".gu-label{font-weight:500;}",
			".gu-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l3,#c9c9c9);color:var(--dsw-alias-label-tertiary,#888);}",
			".gu-badge-ws{color:var(--dsw-alias-label-primary,#1a1a1a);border-color:var(--dsw-alias-border-l2,#ddd);}",
			".gu-doc{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px;margin:0;}",
			".gu-choices{display:flex;gap:14px;flex-wrap:wrap;align-items:center;}",
			".gu-choice{display:inline-flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;}",
			".gu-text{height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3,#c9c9c9);border-radius:8px;background:transparent;color:inherit;font-size:13px;min-width:200px;}",
			".gu-actions{display:flex;gap:8px;flex-wrap:wrap;}",
			".gu-btn{display:inline-flex;align-items:center;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l3,#c9c9c9);background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:8px;font-size:12px;cursor:pointer;}",
			".gu-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}",
			".gu-btn[disabled]{opacity:.4;cursor:not-allowed;}",
			".gu-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#1a1a1a);color:var(--dsw-alias-label-primary-foreground,#fff);}",
			".gu-msg{font-size:12px;line-height:18px;white-space:pre-wrap;}",
			".gu-ok-msg{color:var(--dsw-alias-label-primary,#1a1a1a);}",
			".gu-err-msg{color:var(--dsw-alias-label-error,#c0392b);}",
			// 第 3 轮红队 F4-NEW-1：warn 必须有**自己的**样式 —— 既不像成功、也不像失败
			".gu-warn-msg{color:var(--dsw-alias-label-warning,#9a6700);}",
			".gu-ok{color:var(--dsw-alias-label-primary,#1a1a1a);}",
			".gu-err{color:var(--dsw-alias-label-error,#c0392b);}",
			".gu-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888);margin:0;}",
			".gu-pre{margin:0;padding:8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));font-size:12px;overflow:auto;max-height:180px;}",
		].join("");

		function ensureStyles() {
			try {
				if (typeof document === "undefined") return null;
				var text = CSS;
				if (typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype
					&& Array.isArray(document.adoptedStyleSheets)) {
					var sheet = new CSSStyleSheet();
					sheet.replaceSync(text);
					document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
					return function () {
						try {
							document.adoptedStyleSheets = document.adoptedStyleSheets.filter(function (s) { return s !== sheet; });
						} catch (e) { /* 回收失败不阻断 */ }
					};
				}
				var tag = document.createElement("style");
				tag.setAttribute("data-dsh-guard-ui", "");
				tag.textContent = text;
				(document.head || document.documentElement).appendChild(tag);
				return function () { try { tag.remove(); } catch (e) { /* ignore */ } };
			} catch (e) {
				return null;
			}
		}

		/* ── 工具 ─────────────────────────────────────────────── */

		var keyOf = function (knob) { return knob.plugin + "::" + knob.path; };

		/**
		 * **纯函数**：把 `settings.set` 的响应翻成「该对用户说什么」（红队 F2/F4）。
		 *
		 * 为什么单独抽出来：文案正确性是安全属性（UI 撒谎比不显示更糟），必须能**离线单测**，
		 * 而组件内部逻辑在没有真 ReactDOM 的环境里测不动。故判决逻辑留在这里，
		 * 组件只负责把结果塞进 state。经 `__testHooks.saveOutcome` 暴露给测试。
		 *
		 * 契约：
		 *   · `combinationCheckedWithProfile !== true` ⇒ **不得**说「已保存、下次生效」，
		 *     要如实说明「组合未与 profile 权威校验，guard 可能整份弃用」；
		 *   · `verified !== true` ⇒ 要如实说明「回读校验未通过，可能被并发覆盖」；
		 *   · **`notes` 非空 ⇒ 同样不得说「已保存、下次生效」**（第 2 轮红队 F4-P2-1 抓到的真回归：
		 *     此前判级只看前两个标志，notes 只是被「附在后面」，于是「有保留意见」也照样显示无条件成功）；
		 *   · notes 一律**逐条呈现**（宿主已经说出了限制，界面不许吞掉）；
		 *   · 任何情况下都带上「生效范围」caveat（`SessionHeader.cwd` 是可选字段）。
		 * 返回 `{ level: 'ok' | 'warn', text }`。
		 */
		function saveOutcome(res, t) {
			var notes = (res && Array.isArray(res.notes)) ? res.notes : [];
			var withProfile = !!(res && res.combinationCheckedWithProfile === true);
			var verified = !!(res && res.verified === true);
			var caveat = (res && res.cwdGuarantee && res.cwdGuarantee.caveat) || t("guaranteeDefault");
			var lines = [];
			var level = "ok";
			if (!verified) { level = "warn"; lines.push(t("saveUnverified")); }
			if (!withProfile) { level = "warn"; lines.push(t("saveCombinationNotChecked")); }
			// ★ 红队 F4-P2-1：notes 非空**必须**参与判级（不能只是附加说明）
			if (notes.length > 0) { level = "warn"; lines.push(t("saveWithNotes")); }
			if (level === "ok") lines.push(t("saveOk"));
			for (var i = 0; i < notes.length; i += 1) lines.push("· " + notes[i]);
			lines.push(t("saveScopeCaveat") + " " + caveat);
			return { level: level, text: lines.join("\n") };
		}

		/**
		 * **纯函数**：把三条互斥通道翻成「真正会渲染出来的文本行」（第 3 轮红队 F4-NEW-1）。
		 *
		 * 为什么必须有它：第 4 轮把 `notes` 非空降级为 `warn`（对的），却把 warn 文本塞进了 `err`
		 * 通道，而渲染层给**所有** `err` 加了 `t("loadFailed")`（=「读取设置失败」）前缀
		 * ⇒ **写成功但有保留**被显示成 **读取失败**。教训：**渲染层**才是判据，
		 * 只验 `level` 或文案字符串验不到这类错误（红队原话）。
		 *
		 * 契约（三条通道语义互斥）：
		 *   · `ok`   = 成功且**无**保留意见 ⇒ 原文渲染，无前缀
		 *   · `warn` = **已写入但有保留**（notes 非空 / 未与 profile 权威校验 / 回读未通过）
		 *              ⇒ 原文渲染，**不加** `loadFailed` 前缀，也不冒充成功
		 *   · `err`  = **真失败**（读取失败 / 写入失败 / 409 冲突…）
		 *              ⇒ **只有这一类**才加 `loadFailed` 前缀
		 *
		 * 返回 `[{ kind: 'err'|'warn'|'ok', text }]`；组件直接按它渲染，
		 * 测试也直接断言它的输出 ⇒ 判据落在**渲染层**，而不是内部状态。
		 */
		function messageRows(msg, t) {
			var rows = [];
			if (!msg) return rows;
			if (msg.err) rows.push({ kind: "err", text: t("loadFailed") + msg.err });
			if (msg.warn) rows.push({ kind: "warn", text: msg.warn });
			if (msg.ok) rows.push({ kind: "ok", text: msg.ok });
			return rows;
		}

		/** 单通道赋值：保证 `ok/warn/err` **同时只有一个**非空（互斥的唯一落点） */
		function singleChannel(kind, text) {
			var next = { ok: "", warn: "", err: "" };
			next[kind] = text || "";
			return next;
		}

		function flashMsg(setMsg, kind, text) { setMsg(singleChannel(kind, text)); }

		/**
		 * `saveOutcome` 的结论 → 消息通道（**纯函数**，组件与测试共用同一条链）。
		 * `level === 'ok'` ⇒ `ok` 通道；否则 ⇒ **`warn`** 通道（**绝不**落进 `err`）。
		 * ⚠ 这正是第 3 轮红队 F4-NEW-1 的修复点：第 4 轮这里写的是
		 * `{ ok: "", err: outcome.text }` ⇒ warn 文本撞上 `err` 的 `loadFailed` 前缀。
		 */
		function msgForOutcome(outcome) {
			return singleChannel(outcome && outcome.level === "ok" ? "ok" : "warn",
				(outcome && outcome.text) || "");
		}

		/** 从 ctx.workspaces 快照里取工作区列表（取不到返回 null，页面会显式提示） */
		function readWorkspaces(ctx) {
			try {
				var svc = ctx && ctx.workspaces;
				if (!svc || !svc.list || typeof svc.list.getSnapshot !== "function") return null;
				var snap = svc.list.getSnapshot();
				var items = (snap && snap.items) || [];
				return items.map(function (w) {
					return { id: w.workspaceId, path: w.path, title: w.title || w.path };
				});
			} catch (e) {
				return null;
			}
		}

		/* ── 设置页组件 ───────────────────────────────────────── */

		function makeSection(t) {
			return function GuardSection() {
				var wsListState = React.useState(null);
				var wsList = wsListState[0];
				var setWsList = wsListState[1];
				var wsIdState = React.useState("");
				var wsId = wsIdState[0];
				var setWsId = wsIdState[1];
				var dataState = React.useState(null);
				var data = dataState[0];
				var setData = dataState[1];
				var draftState = React.useState({});
				var draft = draftState[0];
				var setDraft = draftState[1];
				var busyState = React.useState(false);
				var busy = busyState[0];
				var setBusy = busyState[1];
				var msgState = React.useState({ ok: "", err: "" });
				var msg = msgState[0];
				var setMsg = msgState[1];
				var routerState = React.useState(null);
				var router = routerState[0];
				var setRouter = routerState[1];
				var loadRouter = React.useCallback(function (id) {
					if (!id) return;
					api("router.mode", { workspaceId: id, action: "get" })
						.then(function (value) { setRouter(value); })
						.catch(function () { setRouter(null); });
				}, []);
				var doRouter = function (action) {
					if (!wsId) return;
					api("router.mode", { workspaceId: wsId, action: action })
						.then(function (value) { setRouter(value); flashMsg(setMsg, "ok", t("routerSaved")); })
						.catch(function (e) { flashMsg(setMsg, "err", String(e.message || e)); });
				};

				// 挂载时取工作区列表（并选定默认工作区）
				React.useEffect(function () {
					var list = readWorkspaces(applyCtx);
					setWsList(list);
					if (list && list.length > 0) setWsId(list[0].id);
				}, []);

				var load = React.useCallback(function (id) {
					if (!id) return;
					setBusy(true); flashMsg(setMsg, "ok", "");
					api("settings.get", { workspaceId: id })
						.then(function (value) {
							setData(value);
							var next = {};
							for (var i = 0; i < value.knobs.length; i += 1) next[keyOf(value.knobs[i])] = value.knobs[i].effective;
							setDraft(next);
							loadRouter(id);
						})
						.catch(function (e) { flashMsg(setMsg, "err", String(e.message || e)); setData(null); })
						.then(function () { setBusy(false); });
				}, []);

				React.useEffect(function () { load(wsId); }, [wsId, load]);

				var onChange = function (knob, value) {
					setDraft(function (prev) {
						var next = Object.assign({}, prev);
						next[keyOf(knob)] = value;
						return next;
					});
					flashMsg(setMsg, "ok", "");
				};

				var dirty = function () {
					if (!data) return false;
					for (var i = 0; i < data.knobs.length; i += 1) {
						var k = data.knobs[i];
						if (draft[keyOf(k)] !== k.effective) return true;
					}
					return false;
				};

				var onSave = function () {
					if (!data) return;
					var patch = {};
					var changed = 0;
					for (var i = 0; i < data.knobs.length; i += 1) {
						var k = data.knobs[i];
						var key = keyOf(k);
						if (draft[key] === k.effective) continue;
						changed += 1;
						// 值与 profile 现值相同 ⇒ 从工作区文件里**删掉**该键（回落 profile），而不是写一个同值
						var v = (k.profile !== null && draft[key] === k.profile) ? null : draft[key];
						if (!patch[k.plugin]) patch[k.plugin] = {};
						patch[k.plugin][k.path] = v;
					}
					if (changed === 0) { flashMsg(setMsg, "warn", t("noChanges")); return; }
					setBusy(true); flashMsg(setMsg, "ok", "");
					// 红队 F3：带上「读取时看到的文件令牌」⇒ 期间被他人改过就让宿主拒绝（409 conflict）
					api("settings.set", {
						workspaceId: wsId, patch: patch,
						expect: (data && data.fileToken) || undefined,
					})
						.then(function (res) {
							// 红队 F2/F4：**先**用响应算出该说什么，再刷新视图
							var outcome = saveOutcome(res, t);
							return api("settings.get", { workspaceId: wsId }).then(function (value) {
								setData(value);
								var next = {};
								for (var j = 0; j < value.knobs.length; j += 1) next[keyOf(value.knobs[j])] = value.knobs[j].effective;
								setDraft(next);
								// ⚠ 只有 outcome.level === 'ok' 才允许显示「已保存、下次生效」
								// ⚠ F4-NEW-1：warn 类结论走 **warn 通道**（不再塞进 err，否则会被套上「读取设置失败」前缀）
								setMsg(msgForOutcome(outcome));
							});
						})
						.catch(function (e) {
							var m = String((e && e.message) || e);
							flashMsg(setMsg, "err", /conflict|已被其它写者改动/.test(m) ? t("conflict") + " " + m : m);
						})
						.then(function () { setBusy(false); });
				};

				var onReset = function () {
					setBusy(true); flashMsg(setMsg, "ok", "");
					// 红队 F3：删除同样带令牌 ⇒ 不删掉他人刚写的新文件
					api("settings.reset", { workspaceId: wsId, expect: (data && data.fileToken) || undefined })
						.then(function (r) {
							return api("settings.get", { workspaceId: wsId }).then(function (value) {
								setData(value);
								var next = {};
								for (var j = 0; j < value.knobs.length; j += 1) next[keyOf(value.knobs[j])] = value.knobs[j].effective;
								setDraft(next);
								flashMsg(setMsg, "ok", r.existed ? t("resetOk") : t("resetNone"));
							});
						})
						.catch(function (e) {
							var m = String((e && e.message) || e);
							flashMsg(setMsg, "err", /conflict|已被其它写者改动/.test(m) ? t("conflict") + " " + m : m);
						})
						.then(function () { setBusy(false); });
				};

				var children = [];
				children.push(React.createElement("h2", { key: "title", className: "gu-label" }, t("title")));
				children.push(React.createElement("p", { key: "intro", className: "gu-intro" }, t("intro")));

				// ── 作用域 ──
				var scopeBits = [];
				scopeBits.push(React.createElement("span", { key: "lb", className: "gu-scope-label" }, t("scopeLabel")));
				if (wsList === null) {
					scopeBits.push(React.createElement("span", { key: "nows", className: "gu-err" }, t("noWorkspace")));
				} else {
					scopeBits.push(React.createElement("select", {
						key: "sel", className: "gu-text", value: wsId,
						onChange: function (e) { setWsId(e.target.value); },
					}, wsList.map(function (w) {
						return React.createElement("option", { key: w.id, value: w.id }, (w.title || w.path) + "  —  " + w.path);
					})));
					if (data) {
						scopeBits.push(React.createElement("span", { key: "st", className: "gu-badge" },
							data.workspaceFileStatus === "ok" ? t("statusOk")
								: data.workspaceFileStatus === "invalid" ? t("statusInvalid") : t("statusAbsent")));
					}
				}
				children.push(React.createElement("div", { key: "scope", className: "gu-scope" }, scopeBits));
				if (data && data.workspace) {
					children.push(React.createElement("div", { key: "file", className: "gu-mono" },
						t("fileLabel") + "：" + data.workspace.file));
				}

				// ── 读不到 profile 现值时如实提示 ──
				if (data && data.defaultsSource === "builtin") {
					children.push(React.createElement("p", { key: "dflt", className: "gu-warn" }, t("defaultsBuiltin")));
				}
				// ── 红队 F2：**常显**「生效范围」caveat（`SessionHeader.cwd` 是可选字段，不能无条件承诺）──
				if (data) {
					var cav = (data.cwdGuarantee && data.cwdGuarantee.caveat) || t("guaranteeDefault");
					children.push(React.createElement("p", { key: "caveat", className: "gu-warn" },
						t("scopeCaveatTitle") + "：" + cav));
				}

				// ── 表单：完全由 knobs 驱动（客户端不复制 schema）──
				if (data) {
					var groups = {};
					var order = [];
					for (var i = 0; i < data.knobs.length; i += 1) {
						var k = data.knobs[i];
						if (!groups[k.plugin]) { groups[k.plugin] = []; order.push(k.plugin); }
						groups[k.plugin].push(k);
					}
					order.forEach(function (plugin) {
						var rows = groups[plugin].map(function (k) {
							var key = keyOf(k);
							var val = draft[key];
							var input;
							if (k.control === "radio" && k.values) {
								input = React.createElement("div", { className: "gu-choices" }, k.values.map(function (v) {
									var label = (k.valueLabels && k.valueLabels[v]) || v;
									return React.createElement("label", { key: v, className: "gu-choice" },
										React.createElement("input", {
											type: "radio", name: key, checked: val === v,
											onChange: function () { onChange(k, v); },
										}), label);
								}));
							} else if (k.control === "checkbox") {
								input = React.createElement("label", { className: "gu-choice" },
									React.createElement("input", {
										type: "checkbox", checked: val === true,
										onChange: function (e) { onChange(k, e.target.checked); },
									}), val === true ? "启用" : "关闭");
							} else {
								input = React.createElement("input", {
									className: "gu-text", type: "text", value: String(val === undefined || val === null ? "" : val),
									onChange: function (e) { onChange(k, e.target.value); },
								});
							}
							var srcLabel = k.source === "workspace" ? t("sourceWorkspace")
								: k.source === "profile" ? t("sourceProfile") : t("sourceBuiltin");
							return React.createElement("div", { key: key, className: "gu-row" },
								React.createElement("div", { className: "gu-row-head" },
									React.createElement("span", { className: "gu-label" }, k.path),
									React.createElement("span", {
										className: "gu-badge" + (k.source === "workspace" ? " gu-badge-ws" : ""),
									}, t("sourceLabel") + "：" + srcLabel)),
								React.createElement("p", { className: "gu-doc" }, k.label),
								input,
								React.createElement("p", { className: "gu-doc" }, k.doc));
						});
						children.push(React.createElement("div", { key: plugin, className: "gu-group" },
							React.createElement("p", { className: "gu-group-title" },
								plugin === "subagent-sandbox" ? t("pluginSandbox") : t("pluginRole")),
							rows));
					});

					// ── 显式声明「其余旋钮仍由 profile 决定」──
					var extraLines = Object.keys(data.extras || {}).map(function (p) {
						return p + "：" + (data.extras[p] || []).join(", ");
					});
					if (extraLines.length > 0) {
						children.push(React.createElement("p", { key: "extras", className: "gu-warn" },
							t("extrasTitle") + " " + extraLines.join("；")));
					}

					// ── 操作 ──
					children.push(React.createElement("div", { key: "actions", className: "gu-actions" },
						React.createElement("button", {
							className: "gu-btn gu-btn-primary", disabled: busy || !dirty(), onClick: onSave,
						}, busy ? "…" : t("save") + (dirty() ? " · " + t("unsaved") : "")),
						React.createElement("button", { className: "gu-btn", disabled: busy, onClick: onReset }, t("reset")),
						React.createElement("button", { className: "gu-btn", disabled: busy, onClick: function () { load(wsId); } }, t("refresh"))));

					children.push(React.createElement("pre", { key: "raw", className: "gu-pre" },
						JSON.stringify({
							workspace: data.workspace && data.workspace.path,
							effective: data.knobs.reduce(function (acc, k) { acc[k.plugin + "." + k.path] = { value: k.effective, source: k.source }; return acc; }, {}),
							defaultsSource: data.defaultsSource,
							workspaceFileStatus: data.workspaceFileStatus,
						}, null, 2)));
				}

				children.push(React.createElement("div", { key: "router", className: "gu-group" },
					React.createElement("div", { className: "gu-row-head" },
						React.createElement("h4", { className: "gu-group-title" }, t("routerTitle")),
						React.createElement("span", { className: "gu-badge" },
							router && router.mode === "auto" ? t("routerAutoOn")
								: router && router.mode === "manual" ? t("routerManualOn")
									: t("routerAutoDetect"))),
					React.createElement("p", { className: "gu-doc" }, t("routerHint")),
					React.createElement("div", { className: "gu-actions" },
						React.createElement("button", { className: "gu-btn", onClick: function () { doRouter("auto"); } }, t("routerBtnAuto")),
						React.createElement("button", { className: "gu-btn", onClick: function () { doRouter("manual"); } }, t("routerBtnManual")),
						React.createElement("button", { className: "gu-btn", onClick: function () { doRouter("clear"); } }, t("routerBtnClear")))));

				// 三条互斥通道统一由 `messageRows` 生成（第 3 轮红队 F4-NEW-1）：
				// **只有 err** 会带 `loadFailed` 前缀；warn 用独立样式，既不冒充成功也不冒充失败。
				messageRows(msg, t).forEach(function (row) {
					children.push(React.createElement("div", {
						key: "msg-" + row.kind,
						className: "gu-msg gu-" + row.kind + "-msg",
					}, row.text));
				});

				return React.createElement("div", { className: "gu-root" }, children);
			};
		}

		/* ── 入口 ─────────────────────────────────────────────── */

		// cordis 服务名（与 package.json 的 dsh.client.inject **runtime 包**是两处，
		// 两处缺一即抛 "cannot get property ... without inject"）
		var inject = ["slots", "locale", "workspaces"];

		// 供组件闭包取 ctx（组件不是 cordis 组件，拿不到 ctx 参数）
		var applyCtx = null;

		function apply(ctx) {
			applyCtx = ctx;
			var removeStyles = ensureStyles();
			if (removeStyles !== null && typeof ctx.effect === "function") {
				ctx.effect(function () { return removeStyles; }, "guard-ui: styles");
			}
			var t = (ctx.locale && typeof ctx.locale.bind === "function")
				? ctx.locale.bind(NS)
				: function (key) { return zh[key] || en[key] || key; };
			if (ctx.locale && typeof ctx.locale.register === "function") {
				ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "guard-ui: section dictionaries");
			}

			if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
			var Section = makeSection(t);
			// 防御：设置页注册失败只降级（console 诊断），绝不炸掉插件加载 / boot
			try {
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: "guard-ui",
						order: 30,
						label: function () { return t("nav"); },
						locale: NS,
					}, Section);
				});
			} catch (error) {
				console.error("[guard-ui] settings.section 注册失败（设置页菜单项不可用，其余功能不受影响）:", error);
			}
		}

		// 测试钩子（无 DOM 冒烟用；无运行时副作用）
		exports.__testHooks = { makeSection: makeSection, readWorkspaces: readWorkspaces, saveOutcome: saveOutcome,
			messageRows: messageRows, msgForOutcome: msgForOutcome, singleChannel: singleChannel, flashMsg: flashMsg,
			API: API, NS: NS, zh: zh, en: en };

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
