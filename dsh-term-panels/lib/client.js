window.__ModuleLoader__.load({
	id: "dsh-term-panels",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		// React（设置页 section 正规注册用；dsh ModuleLoader 解析，同 dshmarket 方案；try-catch 保护）
		let React = null;
		try { React = require("react"); } catch (e) {}

		// ============================================================
		// DSH 前端插件：终端悬浮面板 + Token 常驻 HUD
		// - 右侧悬浮按钮：>_ 终端（点击弹出，点外部收起；面板可拖拽 + 可调大小）
		// - Token HUD：常驻右上角半透明小框，可拖动，显示当日
		//   输入/输出/缓存命中率/余额（余额经 3081 /api/balance 代理）
		// - hash 通信：#dsh-open-term（客户端托盘/宠物菜单触发）
		// 纯 DOM 实现；主题跟随 dsh web（--dsw-alias-* 变量）
		// ============================================================

		const TERM_WS_URL = "ws://127.0.0.1:3081/ws";
		const XTERM_JS = "http://127.0.0.1:3081/vendor/xterm/xterm.js";
		const XTERM_FIT_JS = "http://127.0.0.1:3081/vendor/fit/addon-fit.js";
		const BALANCE_URL = "http://127.0.0.1:3081/api/balance";
		const MINIMIZE_URL = "http://127.0.0.1:3081/api/minimize";   // L 手势（下→右）最小化客户端
		const DOCK_ID = "dsh-panels-dock";
		const TERM_PANEL_ID = "dsh-term-panel";
		const TERM_HOST_ID = "dsh-term-host";
		const HUD_ID = "dsh-token-hud";
		const HASH_TERM = "#dsh-open-term";
		const HUD_STORAGE_KEY = "dsh-token-hud-daily";
		const PANEL_SIZE_KEY = "dsh-term-panel-size";
		const TERM_SETTINGS_KEY = "dsh-term-panels-settings";
		const TERM_FONTS_JS = [
			{ name: "Consolas", value: 'Consolas, "Cascadia Mono", monospace' },
			{ name: "Cascadia Mono", value: '"Cascadia Mono", Consolas, monospace' },
			{ name: "Courier New", value: '"Courier New", monospace' },
			{ name: "宋体", value: "SimSun, monospace" },
			{ name: "微软雅黑", value: '"Microsoft YaHei", monospace' },
		];
		// 界面字体选项（覆盖 dsh 的 --dsw-font-family；2026-08-27 主需求：字型选择）
		const UI_FONT_OPTIONS = [
			{ name: "系统默认", value: "" },
			{ name: "微软雅黑", value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
			{ name: "宋体", value: '"SimSun", "宋体", serif' },
			{ name: "黑体", value: '"SimHei", "黑体", sans-serif' },
			{ name: "楷体", value: '"KaiTi", "楷体", serif' },
			{ name: "霞鹜文楷", value: '"LXGW WenKai", "霞鹜文楷", "KaiTi", serif' },
			{ name: "苹方", value: '"PingFang SC", "苹方", sans-serif' },
			{ name: "思源黑体", value: '"Noto Sans CJK SC", "Source Han Sans SC", sans-serif' },
			{ name: "Consolas", value: '"Consolas", monospace' },
			{ name: "Cascadia Mono", value: '"Cascadia Mono", monospace' },
			{ name: "JetBrains Mono", value: '"JetBrains Mono", Consolas, monospace' },
		];
		// 界面字体应用（注入 CSS 覆盖字体变量；空值恢复系统默认）
		function applyUiFont(value) {
			let st = document.getElementById("dsh-ui-font-style");
			if (!st) {
				st = document.createElement("style");
				st.id = "dsh-ui-font-style";
				document.head.appendChild(st);
			}
			st.textContent = value
				? ":root{--dsw-font-family:" + value + " !important;--ds-font-family-code:" + value + " !important}"
					+ "body{font-family:" + value + " !important}"
					+ "#" + HUD_ID + ",#" + HUD_ID + " span,#" + HUD_ID + " button{font-family:" + value + " !important}"   // 2026-09-05 HUD（含数字列/终端按钮）字体跟随设置
				: "";
		}
		// 界面字号应用（缩放比例 = 字号/基准14；2026-08-27 主需求）
		// 2026-09-05 主定：HUD 随字号设置同步缩放（与页面一致，两侧设置相同即一致）
		function applyUiFontSize(size) {
			const z = size > 0 ? (size / 14) : 1;
			document.documentElement.style.zoom = String(Math.round(z * 1000) / 1000);
		}

		// 终端宿主/状态提升到模块顶层（2026-08-19：版本更新提示的 typeSudoRestart 在 apply 外需访问）
		const termHost = document.createElement("div");
		const termState = { term: null, fit: null, ws: null, initStarted: false };

		function apply(ctx) {
			const connection = ctx.connection;
			if (document.getElementById(DOCK_ID)) return; // 已注入

			// 注入标记（隐藏，防重复注入；2026-09-05 起终端入口收进 HUD 底部，不再独立悬浮：
			// 独立钮与官方气泡大纲/设置等悬浮 UI 反复撞位）
			const dock = document.createElement("div");
			dock.id = DOCK_ID;
			dock.style.display = "none";
			document.body.appendChild(dock);

			// ---------- 终端面板（内嵌 xterm，直连 3081；可拖拽 + 可调大小，记忆几何） ----------
			const termPanel = panel(TERM_PANEL_ID, ">_ 终端");
			// 默认几何（主 2026-08-16 定稿：937x495 @ (201,110)）
			const savedGeom = loadPanelGeom() || { x: 201, y: 110, w: 937, h: 495 };
			if (savedGeom) {
				termPanel.root.style.width = savedGeom.w + "px";
				termPanel.root.style.height = savedGeom.h + "px";
				termPanel.root.style.right = "auto";
				termPanel.root.style.left = savedGeom.x + "px";
				termPanel.root.style.top = savedGeom.y + "px";
				termPanel.root.style.transform = "";
			}
			// 终端宿主容器（xterm 直接渲染进父页面——不用 iframe，透明/毛玻璃才生效）
			// termHost 已提升为模块顶层变量（2026-08-19）
			termHost.id = TERM_HOST_ID;
			Object.assign(termHost.style, {
				flex: "1", minHeight: "0", position: "relative", overflow: "hidden",
			});
			termPanel.body.appendChild(termHost);
			document.body.appendChild(termPanel.root);
			// 懒初始化终端（首次打开时加载 xterm.js + 建实例 + 连 WS，之后保持会话）
			// termState 已提升为模块顶层变量（2026-08-19）
			injectTermStyle();
			// ---------- 终端设置（⚙：自定义颜色 + 透明度 + 字号 + 字体，右下角按钮） ----------
			const termSettings = loadTermSettings();
			const settingsBtn = document.createElement("button");
			Object.assign(settingsBtn.style, {
				position: "absolute", right: "8px", bottom: "8px", zIndex: "5",
				cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px", lineHeight: "1", padding: "5px 8px", borderRadius: "7px",
				opacity: ".55", transition: "opacity .15s",
			});
			settingsBtn.textContent = "⚙";
			settingsBtn.title = "终端设置";
			settingsBtn.addEventListener("mouseenter", () => { settingsBtn.style.opacity = "1"; });
			settingsBtn.addEventListener("mouseleave", () => { settingsBtn.style.opacity = ".55"; });
			settingsBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				termSettingsPanel.style.display =
					termSettingsPanel.style.display === "none" ? "block" : "none";
			});
			termPanel.root.appendChild(settingsBtn);
			// ---------- 界面字体（系统字库枚举 + 选择即应用；2026-08-27 主需求：放入设置面板）
			// 2026-09-05 并入 termSettings（服务端持久化，客户端重启可记住） ----------
			let uiFont = termSettings.uiFont || "";
			let uiFontSize = termSettings.uiFontSize || 14;
			let sysFonts = null;   // 系统字体列表（懒加载缓存）
			async function loadSystemFonts() {
				if (sysFonts) return sysFonts;
				const names = [];
				try {
					if (window.queryLocalFonts) {
						const fonts = await window.queryLocalFonts();
						const seen = new Set();
						for (const f of fonts) {
							const family = (f.family || "").trim();
							if (family && !seen.has(family)) { seen.add(family); names.push(family); }
						}
					}
				} catch (e) { /* 权限拒绝/不支持 → 回退候选项 */ }
				if (names.length === 0) {
					for (const o of UI_FONT_OPTIONS) if (o.value) names.push(o.name);
				}
				names.sort((a, b) => a.localeCompare(b, "zh"));
				sysFonts = names;
				return names;
			}
			function pickFont(value) {
				uiFont = value;
				termSettings.uiFont = value;
				applyUiFont(uiFont);
				applyTermSettings();   // 2026-09-05 持久化到服务端 + 已开 xterm 同步字体
			}
			// ---------- 设置页"界面字体" section（React 正规注册，同 dshmarket 方案；2026-08-27 主需求） ----------
			function buildSettingsFontEntry() {
				if (!React || !ctx.slots) return;
				try {
					// 字体设置 React 组件（闭包共享 applyUiFont/applyUiFontSize/loadSystemFonts）
					function FontSection() {
						const [font, setFont] = React.useState(uiFont);
						const [size, setSize] = React.useState(uiFontSize);
						const [fonts, setFonts] = React.useState([]);
						React.useEffect(() => { loadSystemFonts().then((f) => setFonts(f)); }, []);
						const sel = React.createElement("select", {
							value: font,
							onChange: (e) => { const v = e.target.value; setFont(v); pickFont(v); },
							style: { width: "100%", padding: "7px 10px", borderRadius: "8px",
								border: "1px solid var(--dsw-alias-border-l2)",
								background: "var(--dsw-alias-bg-layer-2)",
								color: "var(--dsw-alias-label-primary)", fontSize: "14px" },
						}, React.createElement("option", { value: "" }, "系统默认"),
							fonts.map((f) => React.createElement("option",
								{ value: '"' + f + '", sans-serif', style: { fontFamily: '"' + f + '"' } }, f)));
						// 字号下拉（同字型 UI，2026-08-27 主需求：滑动条不好操作改下拉）
						const SIZE_OPTS = [12, 13, 14, 15, 16, 17, 18, 19, 20];
						const range = React.createElement("select", {
							value: String(size),
							onChange: (e) => { const v = parseInt(e.target.value, 10); setSize(v); uiFontSize = v;
								termSettings.uiFontSize = v;
								applyUiFontSize(v);
								saveTermSettings(termSettings); },
							style: { width: "100%", padding: "7px 10px", borderRadius: "8px",
								border: "1px solid var(--dsw-alias-border-l2)",
								background: "var(--dsw-alias-bg-layer-2)",
								color: "var(--dsw-alias-label-primary)", fontSize: "14px" },
						}, SIZE_OPTS.map((n) => React.createElement("option", { value: String(n) }, n + " px")));
						const preview = React.createElement("div",
							{ style: { margin: "1px 0 22px", fontFamily: font || "system-ui, 'Segoe UI', sans-serif", fontSize: size + "px" } },
							size + ": The quick brown fox jumps over the lazy dog");
						const label = (txt) => React.createElement("div",
							{ style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", marginBottom: "8px" } }, txt);
						const fontGroup = React.createElement("div", { style: { marginBottom: "22px" } }, label("字体"), sel);
						const sizeGroup = React.createElement("div", null, label("字号"), range);
						return React.createElement("div", null, fontGroup, preview, sizeGroup);
					}
					ctx.slots.inject("settings.section", () => {
						const off = ctx.slots.register({
							name: "settings.section",
							id: "dsh-ui-font",
							order: 45,
							label: () => "界面",
						}, () => React.createElement(FontSection));
						return off;
					});
				} catch (e) { /* section 注册失败静默（不崩） */ }
			}
			buildSettingsFontEntry();
			// 设置浮层（面板右上方）
			const termSettingsPanel = document.createElement("div");
			termSettingsPanel.id = "dsh-term-settings-panel";
			Object.assign(termSettingsPanel.style, {
				position: "fixed", zIndex: "99996", display: "none",
				width: "240px", padding: "10px 12px",
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "8px",
				boxShadow: "0 8px 24px rgba(0,0,0,.3)",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: 'system-ui, "Segoe UI", sans-serif',
				fontSize: "12px",
			});
			const sRow = (label) => {
				const d = document.createElement("div");
				Object.assign(d.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" });
				const l = document.createElement("span");
				l.style.color = "var(--dsw-alias-label-secondary)";
				l.style.width = "56px";
				l.textContent = label;
				d.appendChild(l);
				return d;
			};
			const TERM_BG_THEMES = [
				{ name: "深色", bg: "#0d1117" },
				{ name: "纯黑", bg: "#000000" },
				{ name: "浅色", bg: "#f6f8fa" },
				{ name: "护眼绿", bg: "#c7edcc" },
				{ name: "琥珀", bg: "#2b1d0e" },
			];
			// 色板
			const bgRow = sRow("背景色");
			const swatches = document.createElement("div");
			Object.assign(swatches.style, { display: "flex", gap: "5px", flexWrap: "wrap", flex: "1" });
			const renderSwatches = () => {
				swatches.textContent = "";
				TERM_BG_THEMES.forEach((t) => {
					const sw = document.createElement("div");
					Object.assign(sw.style, {
						width: "22px", height: "22px", borderRadius: "5px", cursor: "pointer",
						background: t.bg, border: t.bg === termSettings.bg ? "2px solid var(--dsw-alias-state-business-primary)" : "2px solid transparent",
						boxShadow: "inset 0 0 0 1px rgba(128,128,128,.3)",
					});
					sw.title = t.name;
					sw.addEventListener("click", (e) => {
						e.stopPropagation();
						termSettings.bg = t.bg;
						renderSwatches();
						applyTermSettings();
					});
					swatches.appendChild(sw);
				});
				// 自定义色
				const customBgInput2 = document.createElement("input");
				customBgInput2.type = "color";
				customBgInput2.value = termSettings.bg;
				Object.assign(customBgInput2.style, { width: "22px", height: "22px", border: "none", padding: "0", background: "none", cursor: "pointer" });
				customBgInput2.addEventListener("input", (e) => {
					e.stopPropagation();
					termSettings.bg = customBgInput2.value;
					applyTermSettings();
				});
				swatches.appendChild(customBgInput2);
			};
			renderSwatches();
			bgRow.appendChild(swatches);
			// 透明度
			const alphaRow = sRow("透明度");
			const alphaInput = document.createElement("input");
			alphaInput.type = "range";
			alphaInput.min = "0";
			alphaInput.max = "100";
			alphaInput.step = "5";
			alphaInput.value = String(termSettings.alpha);
			const alphaVal = document.createElement("span");
			alphaVal.style.fontFamily = 'Consolas, monospace';
			alphaVal.textContent = String(termSettings.alpha) + "%";
			alphaRow.appendChild(alphaInput);
			alphaRow.appendChild(alphaVal);
			// 字号
			const sizeRow = sRow("字号");
			const sizeInput = document.createElement("input");
			sizeInput.type = "range";
			sizeInput.min = "11";
			sizeInput.max = "20";
			sizeInput.step = "1";
			sizeInput.value = String(termSettings.fontSize);
			const sizeVal = document.createElement("span");
			sizeVal.style.fontFamily = 'Consolas, monospace';
			sizeVal.textContent = String(termSettings.fontSize);
			sizeRow.appendChild(sizeInput);
			sizeRow.appendChild(sizeVal);
			// 字体
			const fontRow = sRow("字体");
			const fontSel = document.createElement("select");
			Object.assign(fontSel.style, { flex: "1", background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "5px", padding: "3px" });
			const TERM_FONTS = TERM_FONTS_JS;
			TERM_FONTS.forEach((f, i) => {
				const op = document.createElement("option");
				op.value = String(i);
				op.textContent = f.name;
				fontSel.appendChild(op);
			});
			fontSel.value = String(termSettings.fontIdx);
			fontRow.appendChild(fontSel);
			// 背景图片（选择/清除）
			const imgRow = sRow("图片");
			const imgPickBtn = document.createElement("button");
			Object.assign(imgPickBtn.style, {
				flex: "1", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
				color: "var(--dsw-alias-label-primary)", borderRadius: "5px", padding: "3px 8px",
			});
			imgPickBtn.textContent = termSettings.bgImage ? "更换图片" : "选择图片";
			const imgClearBtn = document.createElement("button");
			Object.assign(imgClearBtn.style, {
				flex: "1", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
				color: "var(--dsw-alias-label-primary)", borderRadius: "5px", padding: "3px 8px",
			});
			imgClearBtn.textContent = "清除图片";
			const bgFileInput = document.createElement("input");
			bgFileInput.type = "file";
			bgFileInput.accept = "image/*";
			bgFileInput.style.display = "none";
			imgRow.appendChild(imgPickBtn);
			imgRow.appendChild(imgClearBtn);
			// 图片透明度（有图片时可用）
			const imgAlphaRow = sRow("图透明度");
			const imgAlphaInput = document.createElement("input");
			imgAlphaInput.type = "range";
			imgAlphaInput.min = "0";
			imgAlphaInput.max = "100";
			imgAlphaInput.step = "5";
			imgAlphaInput.value = String(termSettings.bgImageAlpha);
			const imgAlphaVal = document.createElement("span");
			imgAlphaVal.style.fontFamily = 'Consolas, monospace';
			imgAlphaVal.textContent = String(termSettings.bgImageAlpha) + "%";
			imgAlphaRow.appendChild(imgAlphaInput);
			imgAlphaRow.appendChild(imgAlphaVal);
			const syncImgUI = () => {
				imgPickBtn.textContent = termSettings.bgImage ? "更换图片" : "选择图片";
				const has = !!termSettings.bgImage;
				imgAlphaInput.disabled = !has;
				imgAlphaVal.style.opacity = has ? 1 : .4;
			};
			syncImgUI();
			imgPickBtn.addEventListener("click", (e) => { e.stopPropagation(); bgFileInput.click(); });
			imgClearBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				termSettings.bgImage = "";
				syncImgUI();
				applyTermSettings();
			});
			bgFileInput.addEventListener("change", (e) => {
				e.stopPropagation();
				const file = bgFileInput.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => {
					const b64 = String(reader.result).split(",")[1];
					const ext = (file.name.split(".").pop() || "png").toLowerCase();
					fetch("http://127.0.0.1:3081/api/background", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ data: b64, ext }),
						mode: "cors",
					})
						.then((r) => r.json())
						.then((j) => {
							if (j.url) {
								// 绝对 URL：相对路径会从 3080 加载导致 404（图片不显示）
								termSettings.bgImage = "http://127.0.0.1:3081" + j.url;
								syncImgUI();
								applyTermSettings();
							}
						})
						.catch(() => {});
				};
				reader.readAsDataURL(file);
			});
			imgAlphaInput.addEventListener("input", () => {
				termSettings.bgImageAlpha = parseInt(imgAlphaInput.value, 10);
				imgAlphaVal.textContent = String(termSettings.bgImageAlpha) + "%";
				applyTermSettings();
			});
			termSettingsPanel.appendChild(bgRow);
			termSettingsPanel.appendChild(alphaRow);
			termSettingsPanel.appendChild(imgRow);
			termSettingsPanel.appendChild(imgAlphaRow);
			termSettingsPanel.appendChild(sizeRow);
			termSettingsPanel.appendChild(fontRow);
			document.body.appendChild(termSettingsPanel);
			// 图片背景层（termHost 内绝对定位，xterm 文字在其上方不透明）
			let bgImgLayer = null;
			const updateBgImage = () => {
				if (termSettings.bgImage) {
					if (!bgImgLayer) {
						bgImgLayer = document.createElement("div");
						Object.assign(bgImgLayer.style, {
							position: "absolute", inset: "0", zIndex: "0",
							backgroundSize: "cover", backgroundPosition: "center",
							backgroundRepeat: "no-repeat", pointerEvents: "none",
						});
						termHost.appendChild(bgImgLayer);
					}
					bgImgLayer.style.backgroundImage =
						"url(" + termSettings.bgImage + "?t=" + Date.now() + ")";
					bgImgLayer.style.opacity = String(termSettings.bgImageAlpha / 100);
				} else if (bgImgLayer) {
					bgImgLayer.remove();
					bgImgLayer = null;
				}
			};
			// 2026-09-05 主更正：终端（xterm 内容）保持自己的字体设置（⚙ 面板 fontIdx 选择），不随界面字体
			// 应用设置：termHost 背景 = 自定义色×透明度 + 图片层（可选，xterm 背景透明）
			const applyTermSettings = () => {
				saveTermSettings(termSettings);
				termHost.style.background = hexToRgba(termSettings.bg, termSettings.alpha / 100);
				updateBgImage();
				if (!termState.term) return;
				termState.term.options.fontSize = termSettings.fontSize;
				termState.term.options.fontFamily = TERM_FONTS[termSettings.fontIdx].value;
				termState.term.options.theme = termTheme();
				if (termState.fit) termState.fit.fit();
				sendResize(termState);
			};
			applyTermSettings();   // 初始背景
			// 启动时从服务端恢复设置/几何（跨重启持久；首次/异常用默认）
			// 服务端为权威（WebView2 localStorage 受缓存目录影响不可靠）
			fetch("http://127.0.0.1:3081/api/term-state", { mode: "cors" })
				.then((r) => r.json())
				.then((st) => {
					if (!st || !st.settings) return;
					const s = st.settings;
					if (typeof s.bg === "string") termSettings.bg = s.bg;
					if (typeof s.alpha === "number") termSettings.alpha = s.alpha;
					if (typeof s.fontSize === "number") termSettings.fontSize = s.fontSize;
					if (typeof s.fontIdx === "number") termSettings.fontIdx = s.fontIdx;
					if (typeof s.bgImage === "string") termSettings.bgImage = s.bgImage;
					if (typeof s.bgImageAlpha === "number") termSettings.bgImageAlpha = s.bgImageAlpha;
					// 2026-09-05 界面字体/字号随服务端恢复（客户端重启可记住）
					if (typeof s.uiFont === "string") termSettings.uiFont = s.uiFont;
					if (typeof s.uiFontSize === "number") termSettings.uiFontSize = s.uiFontSize;
					if (st.geom && st.geom.w >= 320 && st.geom.h >= 200) {
						const g = st.geom;
						termPanel.root.style.width = g.w + "px";
						termPanel.root.style.height = g.h + "px";
						termPanel.root.style.right = "auto";
						termPanel.root.style.left = g.x + "px";
						termPanel.root.style.top = g.y + "px";
						termPanel.root.style.transform = "";
					}
					syncImgUI();
					// 服务端权威恢复后，应用界面字体/字号（覆盖 localStorage 初值）
					uiFont = termSettings.uiFont || "";
					uiFontSize = termSettings.uiFontSize || 14;
					if (uiFont) applyUiFont(uiFont);
					applyUiFontSize(uiFontSize);
					applyTermSettings();
				})
				.catch(() => {});
			alphaInput.addEventListener("input", () => {
				termSettings.alpha = parseInt(alphaInput.value, 10);
				alphaVal.textContent = String(termSettings.alpha) + "%";
				applyTermSettings();
			});
			sizeInput.addEventListener("input", () => {
				termSettings.fontSize = parseInt(sizeInput.value, 10);
				sizeVal.textContent = String(termSettings.fontSize);
				applyTermSettings();
			});
			fontSel.addEventListener("change", () => {
				termSettings.fontIdx = parseInt(fontSel.value, 10);
				applyTermSettings();
			});
			// 设置浮层位置跟随 ⚙ 按钮（按钮上方展开）
			setInterval(() => {
				if (termSettingsPanel.style.display === "none") return;
				const br = settingsBtn.getBoundingClientRect();
				termSettingsPanel.style.right = "auto";
				termSettingsPanel.style.left = Math.max(8, br.right - termSettingsPanel.offsetWidth) + "px";
				termSettingsPanel.style.top = Math.max(8, br.top - termSettingsPanel.offsetHeight) + "px";
			}, 300);
			// （终端开关事件已随按钮收进 HUD 底部，见下方 hud 构建段）
			// 轮询：保存几何 + 面板尺寸变化时 fit 终端
			setInterval(() => {
				const el = document.getElementById(TERM_PANEL_ID);
				if (el && el.style.display !== "none") {
					savePanelGeom(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight);
					if (termState.fit) {
						termState.fit.fit();
						sendResize(termState);
					}
				}
			}, 800);

			// ---------- Token 常驻 HUD（右上角，半透明，可拖动） ----------
			const hud = buildHud();
			document.body.appendChild(hud.root);

			// ---------- HUD 底部：终端快捷按钮行（2026-09-05 主指示：独立悬浮钮
			//      与官方悬浮 UI 反复撞位 → 收进 HUD 下开一行，点击弹出/收起终端） ----------
			const termBtnRow = document.createElement("div");
			Object.assign(termBtnRow.style, {
				display: "flex", gap: "6px", marginTop: "8px", justifyContent: "flex-end",
			});
			const btnOpenTerm = document.createElement("button");
			btnOpenTerm.textContent = ">_ 终端";
			btnOpenTerm.title = "打开/收起终端面板";
			Object.assign(btnOpenTerm.style, {
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
				color: "var(--dsw-alias-label-secondary)", fontSize: "12px",
				width: "100%", textAlign: "center",   // 2026-09-05 占满 HUD 内容宽并居中
				padding: "5px 12px", borderRadius: "8px", cursor: "pointer",
				fontFamily: "Consolas, monospace", lineHeight: "1.5",
				transition: "background .12s",
			});
			btnOpenTerm.addEventListener("mousedown", (e) => e.stopPropagation()); // 防触发 HUD 拖动
			btnOpenTerm.addEventListener("mouseenter", () => { btnOpenTerm.style.background = "var(--dsw-alias-interactive-bg-hover)"; btnOpenTerm.style.color = "var(--dsw-alias-label-primary)"; });
			btnOpenTerm.addEventListener("mouseleave", () => { btnOpenTerm.style.background = "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))"; btnOpenTerm.style.color = "var(--dsw-alias-label-secondary)"; });
			btnOpenTerm.addEventListener("click", (e) => {
				e.stopPropagation();
				if (termPanel.root.style.display === "none") {
					ensureTerminal(termState, termHost);
					openPanel(TERM_PANEL_ID);
				} else {
					closePanel(TERM_PANEL_ID);
				}
			});
			termBtnRow.appendChild(btnOpenTerm);
			hud.root.appendChild(termBtnRow);

			// ---------- 缩放比例浮标（Ctrl+滚轮/键盘缩放时屏幕中央提示） ----------
			buildZoomHud();

			// ---------- 应用界面字体/字号（以服务端 term-state 为权威，客户端重启可记住；fetch 恢复后再覆盖一次） ----------
			if (uiFont) applyUiFont(uiFont);
			applyUiFontSize(uiFontSize || 14);

			// ---------- 鼠标手势（右键：上拖到顶/下拖到底/先上后下刷新） ----------
			buildMouseGesture();

			// ---------- 已归档会话面板（设置按钮上方） ----------
			buildArchivedPanel(ctx);

			// ---------- 点击外部收起面板（设置浮层算面板内部，不收起） ----------
			document.addEventListener("click", (e) => {
				const t = e.target;
				const inPanel = t.closest && (t.closest("#" + TERM_PANEL_ID) ||
					t.closest("#dsh-term-settings-panel"));
				const inBtn = t.closest && t.closest("#" + DOCK_ID);
				if (!inPanel && !inBtn) {
					closePanel(TERM_PANEL_ID);
					termSettingsPanel.style.display = "none";   // 面板关闭时浮层同步收起
				}
			});

			// ---------- hash 通信（客户端菜单触发悬浮终端） ----------
			const handleHash = () => {
				if (location.hash === HASH_TERM) {
					ensureTerminal(termState, termHost);
					openPanel(TERM_PANEL_ID);
					try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
				}
			};
			window.addEventListener("hashchange", handleHash);
			handleHash();

			// ---------- HUD 数据：词元（平台用量接口，回落会话聚合）+ 余额 ----------
			// 2026-08-17 主定稿：六项=输入(命中)/输入(未命中)/命中率/输出/今日消耗/余额。
			// 优先 3081 /api/platform-usage（DeepSeek 平台官方每日用量，含金额），
			// 失败（无平台 token/接口异常）回落 /api/today-usage（本地会话日志，无金额）。
			// 余额走官方 API /api/balance。
			const hudState = { input: 0, output: 0, cacheRead: 0, balance: null, cost: null, costCurrency: "CNY" };
			renderHud(hud, hudState);
			fetchUsage(hud, hudState);
			setInterval(() => fetchUsage(hud, hudState), 10000);
			refreshBalance(hud, hudState);
			setInterval(() => refreshBalance(hud, hudState), 30000); // 余额 30s 刷新（2026-08-21 主定）

			// ---------- 左缘消息大纲条（当前会话我的消息，hover 展开） ----------
			buildMessageOutline(ctx);
			// sessions 服务可能晚于本插件注册（cordis 启动顺序），延迟重试一次
			setTimeout(() => buildMessageOutline(ctx), 1500);
		}

		// ---------- 工具：悬浮按钮 ----------
		// 判断 dsh web 当前主题明暗（供终端页面选玻璃色）
		// 用探测元素 backgroundColor：CSS 自定义属性的 getPropertyValue 返回未展开的
		// var() 字符串，无法直接解析；普通属性 backgroundColor 会解析 var 链得最终色
		function parentTheme() {
			try {
				const probe = document.createElement("div");
				probe.style.background = "var(--dsw-alias-bg-layer-1)";
				probe.style.display = "none";
				document.body.appendChild(probe);
				const v = getComputedStyle(probe).backgroundColor;
				probe.remove();
				const rgb = v.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
				if (rgb) {
					const lum = +rgb[1] * 0.299 + +rgb[2] * 0.587 + +rgb[3] * 0.114;
					return lum > 128 ? "light" : "dark";
				}
			} catch (e) {}
			return "light";
		}

		// ---------- 工具：面板容器（标题栏/关闭/拖拽/resize） ----------
		function panel(id, title) {
			const wrap = document.createElement("div");
			wrap.id = id;
			Object.assign(wrap.style, {
				position: "fixed",
				zIndex: "99995",
				display: "none",
				flexDirection: "column",
				width: "640px", height: "420px",
				minWidth: "320px", minHeight: "200px",
				right: "72px", top: "50%", transform: "translateY(-50%)",
				// 容器半透明毛玻璃（30% 主题色 + blur，与 Token HUD 同款；主 2026-08-19 要求）
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 30%, transparent)",
				backdropFilter: "blur(4px)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				boxShadow: "0 10px 32px rgba(0,0,0,.35)",
				overflow: "hidden",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: 'system-ui, "Segoe UI", sans-serif',
				fontSize: "12px",
				resize: "both",              // 可拖拽调大小（右下角手柄）
			});
			const titleBar = document.createElement("div");
			Object.assign(titleBar.style, {
				display: "flex", alignItems: "center", gap: "8px",
				padding: "8px 12px",
				// 标题栏加深（65%）与内容区区分（主定稿 2026-08-16）
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 65%, transparent)",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				cursor: "move", userSelect: "none", flex: "none",
			});
			const titleText = document.createElement("span");
			titleText.style.fontWeight = "600";
			titleText.textContent = title;
			const closeBtn = document.createElement("button");
			Object.assign(closeBtn.style, {
				marginLeft: "auto", cursor: "pointer", border: "none",
				background: "transparent",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: "14px", lineHeight: "1", padding: "4px 6px", borderRadius: "5px",
			});
			closeBtn.textContent = "✕";
			closeBtn.title = "关闭";
			closeBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				closePanel(wrap.id);
			});
			titleBar.appendChild(titleText);
			titleBar.appendChild(closeBtn);
			const body = document.createElement("div");
			Object.assign(body.style, {
				flex: "1", minHeight: "0", display: "flex", flexDirection: "column", overflow: "hidden",
			});
			wrap.appendChild(titleBar);
			wrap.appendChild(body);
			// 拖拽移动
			let dragging = false, offX = 0, offY = 0;
			titleBar.addEventListener("mousedown", (e) => {
				if (e.target === closeBtn) return;
				dragging = true;
				offX = e.clientX - wrap.offsetLeft;
				offY = e.clientY - wrap.offsetTop;
				wrap.style.transform = "";
				wrap.style.top = wrap.offsetTop + "px";
				wrap.style.left = wrap.offsetLeft + "px";
				wrap.style.right = "auto";
				e.preventDefault();
			});
			document.addEventListener("mousemove", (e) => {
				if (!dragging) return;
				wrap.style.left = (e.clientX - offX) + "px";
				wrap.style.top = (e.clientY - offY) + "px";
			});
			document.addEventListener("mouseup", () => { dragging = false; });
			return { root: wrap, body, titleBar };
		}

		function togglePanel(id) {
			const el = document.getElementById(id);
			if (!el) return;
			// 面板开关不驱动宠物颜色（颜色跟随客户端主窗口状态，客户端本地判断）
			el.style.display = el.style.display === "none" ? "flex" : "none";
		}
		function openPanel(id) {
			const el = document.getElementById(id);
			if (el) el.style.display = "flex";
		}
		function closePanel(id) {
			const el = document.getElementById(id);
			if (el) el.style.display = "none";
		}

		// ---------- 终端设置存取（字号/字体，localStorage） ----------
		function loadTermSettings() {
			// 默认设置（主 2026-08-16 定稿：深色 #0d1117、透明度 60%、字号 16、Consolas）
			// 2026-09-05 界面字体/字号并入本对象（与服务端持久化同通道，WebView2 localStorage 不可靠）
			let s = { bg: "#0d1117", alpha: 60, fontSize: 16, fontIdx: 0, bgImage: "", bgImageAlpha: 100, uiFont: "", uiFontSize: 14 };
			try {
				const raw = JSON.parse(localStorage.getItem(TERM_SETTINGS_KEY) || "null");
				if (raw) {
					if (typeof raw.bg === "string") s.bg = raw.bg;
					if (typeof raw.alpha === "number") s.alpha = raw.alpha;
					if (typeof raw.fontSize === "number") s.fontSize = raw.fontSize;
					if (typeof raw.fontIdx === "number") s.fontIdx = raw.fontIdx;
					if (typeof raw.bgImage === "string") s.bgImage = raw.bgImage;
					if (typeof raw.bgImageAlpha === "number") s.bgImageAlpha = raw.bgImageAlpha;
					if (typeof raw.uiFont === "string") s.uiFont = raw.uiFont;
					if (typeof raw.uiFontSize === "number") s.uiFontSize = raw.uiFontSize;
				}
			} catch (e) {}
			return s;
		}
		function saveTermSettings(s) {
			try { localStorage.setItem(TERM_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
			// 服务端持久化（跨重启保留；WebView2 localStorage 受缓存目录影响不可靠）
			try {
				const el = document.getElementById(TERM_PANEL_ID);
				const geom = el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
				fetch("http://127.0.0.1:3081/api/term-state", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ settings: s, geom }),
					mode: "cors",
				}).catch(() => {});
			} catch (e) {}
		}
		function hexToRgba(hex, alpha) {
			const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
			return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
		}

		// ---------- 内嵌终端（xterm DOM 渲染器直连 3081 WS，透明/毛玻璃在父页面生效） ----------
		function injectTermStyle() {
			if (document.getElementById("dsh-term-style")) return;
			const st = document.createElement("style");
			st.id = "dsh-term-style";
			st.textContent =
				"#dsh-term-host .xterm, #dsh-term-host .xterm-screen, " +
				"#dsh-term-host .xterm-viewport, #dsh-term-host .xterm-scrollable-element, " +
				"#dsh-term-host .xterm-rows { background: transparent !important; }" +
				"#dsh-term-host .xterm { height: 100%; position: relative; z-index: 1; }" +
				"#dsh-term-host .xterm .xterm-viewport { overflow-y: auto; }" +
				"#dsh-term-host .xterm ::-webkit-scrollbar { display: none !important; width: 0 !important; }";
			document.head.appendChild(st);
		}
		function loadScripts(urls) {
			return Promise.all(urls.map((u) => new Promise((resolve, reject) => {
				const s = document.createElement("script");
				s.src = u;
				s.onload = resolve;
				s.onerror = () => reject(new Error("load failed: " + u));
				document.head.appendChild(s);
			})));
		}
		// 终端文字色跟随自定义背景色亮度（暗底浅字 / 亮底深字）
		function termTheme() {
			const bg = loadTermSettings().bg;
			const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
			const light = (r * 0.299 + g * 0.587 + b * 0.114) > 128;
			return light
				? { foreground: "#1f2328", cursor: "#1f2328", cursorAccent: "#ffffff" }
				: { foreground: "#e6edf3", cursor: "#ffffff", cursorAccent: "#1f2328" };
		}
		function ensureTerminal(state, host) {
			if (state.term || state.initStarted) return;
			state.initStarted = true;
			// xterm.css（布局必需）+ xterm.js + fit
			if (!document.getElementById("dsh-xterm-css")) {
				const link = document.createElement("link");
				link.id = "dsh-xterm-css";
				link.rel = "stylesheet";
				link.href = "http://127.0.0.1:3081/vendor/xterm/css/xterm.css";
				document.head.appendChild(link);
			}
			loadScripts([XTERM_JS, XTERM_FIT_JS])
				.then(() => initTerminal(state, host))
				.catch(() => { state.initStarted = false; });
		}
		function initTerminal(state, host) {
			if (!window.Terminal || !window.FitAddon) return;
			const th = termTheme();
			const ts = loadTermSettings();
			const term = new window.Terminal({
				cursorBlink: true,
				fontSize: ts.fontSize,
				fontFamily: TERM_FONTS_JS[ts.fontIdx].value,
				theme: th,
				scrollback: 5000,
				overviewRuler: { width: 0 },
				rendererType: "dom",     // DOM 渲染器：背景 CSS 可清 → 透明
			});
			const fit = new window.FitAddon.FitAddon();
			term.loadAddon(fit);
			term.open(host);
			fit.fit();
			const ws = new WebSocket(TERM_WS_URL);
			ws.onopen = () => {
				sendResize(state);
				term.writeln("\x1b[90m[DSH Terminal] 已连接\x1b[0m");
				term.focus();
			};
			ws.onmessage = (ev) => term.write(ev.data);
			ws.onclose = () => term.write("\x1b[31m[DSH Terminal] 连接断开，点击重开面板重连\x1b[0m\r\n");
			ws.onerror = () => ws.close();
			term.onData((data) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(data);
			});
			state.term = term;
			state.fit = fit;
			state.ws = ws;
			window.__dshTermState = state;   // 供粘贴事件取终端句柄
		}
		function sendResize(state) {
			const t = state.term, ws = state.ws;
			if (!t || !ws || ws.readyState !== WebSocket.OPEN) return;
			ws.send("\x00resize:" + t.cols + ":" + t.rows);
		}
		// 粘贴（Ctrl+Shift+V / 右键粘贴），bracketed paste 包装
		document.addEventListener("paste", (ev) => {
			const host = document.getElementById(TERM_HOST_ID);
			if (!host || host.style.display === "none" || !document.getElementById(TERM_PANEL_ID) ||
				document.getElementById(TERM_PANEL_ID).style.display === "none") return;
			const text = ev.clipboardData.getData("text");
			if (!text) return;
			// 终端实例与 ws 从模块状态拿不到——通过 window 临时句柄传递
			const g = window.__dshTermState;
			if (g && g.ws && g.ws.readyState === WebSocket.OPEN && g.term) {
				if (g.term.bracketedPasteMode) {
					g.ws.send("\x1b[200~" + text.replace(/\r?\n/g, "\r") + "\x1b[201~");
				} else {
					g.ws.send(text.replace(/\r?\n/g, "\r"));
				}
			}
			ev.preventDefault();
		});

		// ---------- 终端面板几何记忆（尺寸 + 位置，localStorage） ----------
		function loadPanelGeom() {
			try {
				const s = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || "null");
				if (s && s.w >= 320 && s.h >= 200 && typeof s.x === "number") return s;
			} catch (e) {}
			return null;
		}
		function savePanelGeom(x, y, w, h) {
			if (w < 320 || h < 200) return;
			try {
				localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ x, y, w, h }));
			} catch (e) {}
			// 服务端持久化（跨重启保留；几何变化时保存设置+几何）
			try {
				const raw = localStorage.getItem(TERM_SETTINGS_KEY);
				let settings = null;
				if (raw) { try { settings = JSON.parse(raw); } catch (e) {} }
				fetch("http://127.0.0.1:3081/api/term-state", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ settings, geom: { x, y, w, h } }),
					mode: "cors",
				}).catch(() => {});
			} catch (e) {}
		}

		// ---------- 缩放比例浮标（Ctrl+滚轮/键盘缩放时屏幕中央显示） ----------
		// WebView2 浏览器缩放（Ctrl+滚轮 / Ctrl+± / Ctrl+0）会改变 window.devicePixelRatio
		// （= 系统 DPI 缩放 × 页面缩放）。记录加载时 DPR 为基准，缩放后相除即得当前比例。
		// 屏幕中央、半透明背景、字体 18px、只显示数字；1.5s 后自动隐藏。
		function buildZoomHud() {
			const el = document.createElement("div");
			el.id = "dsh-zoom-hud";
			Object.assign(el.style, {
				position: "fixed", left: "50%", top: "50%",
				transform: "translate(-50%, -50%)", zIndex: "99999",
				padding: "10px 22px", borderRadius: "12px",
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 30%, transparent)",
				border: "1px solid var(--dsw-alias-border-l2)",
				boxShadow: "0 4px 16px rgba(0,0,0,.22)",
				backdropFilter: "blur(4px)",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: 'system-ui, "Segoe UI", sans-serif',
				fontSize: "18px", fontWeight: "600",
				display: "none",
				pointerEvents: "none",
				userSelect: "none",
			});
			document.body.appendChild(el);
			const baseDPR = window.devicePixelRatio || 1;
			let hideTimer = null;
			let readTimer = null;
			function show() {
				el.style.display = "";
				el.textContent = "…";
				clearTimeout(hideTimer);
				clearTimeout(readTimer);
				// 等 WebView2 缩放生效后再读 DPR（wheel 事件时缩放尚未应用）
				readTimer = setTimeout(() => {
					const dpr = window.devicePixelRatio || 1;
					el.textContent = Math.round((dpr / baseDPR) * 100) + "%";
				}, 120);
				hideTimer = setTimeout(() => { el.style.display = "none"; }, 1500);
			}
			document.addEventListener("wheel", (e) => {
				if (e.ctrlKey) show();
			}, { passive: true });
			document.addEventListener("keydown", (e) => {
				if (e.ctrlKey && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) show();
			});
		}

		// ---------- 鼠标手势（右键拖动）：上拖到页顶 / 下拖到页底 / 先上后下刷新 ----------
		// 浏览器式手势：按住右键拖动，累计位移判定方向；方向反转（先上后下）= 刷新页面。
		// 移动超过阈值才算手势（防误触）；手势中才拦截右键菜单，普通右键点击不影响。
		function buildMouseGesture() {
			const THRESHOLD = 30;      // 手势有效位移（px）
			const REVERSE = 20;        // 反向判定阈值（px）
			const SEG_MIN = 40;         // 刷新手势每段最小长度（px）
			const TAN30 = Math.tan(Math.PI / 6);   // 30° 锥：|dx| <= |dy| * tan30
			const MOVE_MENU = 5;       // 移动超过该值即视为拖动（阻止右键菜单）
			let startX = 0, startY = 0, lastY = 0;
			let totalDy = 0;           // 累计位移（正=向下，最终决定滚顶/滚底）
			let phase = "none";        // none|up|down|reversed
			let active = false;        // 手势进行中（超过阈值后）
			let moved = false;         // 是否已拖动（阻止右键菜单）
			let pressed = false;        // 右键是否按住（手势进行标志）

			// 拖行轨迹：SVG 折线绘制鼠标实际行进路径
			const NS = "http://www.w3.org/2000/svg";
			const trailSvg = document.createElementNS(NS, "svg");
			const path = document.createElementNS(NS, "polyline");
			const BLUE = getComputedStyle(document.documentElement).getPropertyValue("--dsw-alias-state-business-primary").trim() || "#4d6bfe";
			// 不用 viewBox：用户坐标 = 像素坐标（polyline 点直接用 clientX/clientY）
			Object.assign(trailSvg.style, {
				position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh",
				zIndex: "99999", pointerEvents: "none", display: "none",
			});
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", BLUE);
			path.setAttribute("stroke-width", "2");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			path.setAttribute("opacity", "0.7");
			trailSvg.appendChild(path);
			document.body.appendChild(trailSvg);
			let pathPoints = [];   // [[x,y],...] 实际行进点
			function showTrail(x, y) {
				// 节流：与上一个点距离够大才记录（避免密集噪点）
				const last = pathPoints[pathPoints.length - 1];
				if (!last || Math.hypot(x - last[0], y - last[1]) >= 6) {
					pathPoints.push([x, y]);
					path.setAttribute("points", pathPoints.map((p) => p[0] + "," + p[1]).join(" "));
				}
				trailSvg.style.display = "block";
			}
			function hideTrail() {
				trailSvg.style.display = "none";
				pathPoints = [];
				path.setAttribute("points", "");
			}

			// 动作提示：鼠标处显示"到顶部/到底部/刷新"，16px 细体，半透明+模糊，1.5s 消失
			const hint = document.createElement("div");
			Object.assign(hint.style, {
				position: "fixed", zIndex: "99999",
				padding: "6px 14px", borderRadius: "10px",
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent)",
				border: "1px solid var(--dsw-alias-border-l2)",
				boxShadow: "0 4px 16px rgba(0,0,0,.22)",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: 'system-ui, "Segoe UI", sans-serif',
				fontSize: "16px", fontWeight: "400",
				pointerEvents: "none", display: "none",
				whiteSpace: "nowrap",
				transform: "translate(-50%, -50%)",
			});
			document.body.appendChild(hint);
			let hintTimer = null;
			function showHint(x, y, text) {
				hint.textContent = text;
				hint.style.display = "block";
				hint.style.left = x + "px";
				hint.style.top = y + "px";
				clearTimeout(hintTimer);
				hintTimer = setTimeout(() => { hint.style.display = "none"; }, 1500);
			}

			// 找到可滚动的最近容器（优先鼠标所在滚动区，兜底整个页面）
			function findScrollable(el) {
				let cur = el;
				while (cur && cur !== document.documentElement && cur !== document.body) {
					const s = getComputedStyle(cur);
					if (cur.scrollHeight > cur.clientHeight && /(auto|scroll|overlay)/.test(s.overflowY)) return cur;
					cur = cur.parentElement;
				}
				return document.scrollingElement || document.documentElement;
			}

			document.addEventListener("mousedown", (e) => {
				if (e.button !== 2) return;   // 仅右键
				pressed = true;
				startX = e.clientX; startY = lastY = e.clientY;
				totalDy = 0;
				phase = "none";
				active = false;
				moved = false;
				pathPoints = [];
				path.setAttribute("points", "");
			});
			document.addEventListener("mousemove", (e) => {
				if (!pressed) return;   // 右键未按住（用标志，不依赖 e.buttons）
				const dy = e.clientY - lastY;
				lastY = e.clientY;
				totalDy += dy;
				if (Math.abs(e.clientY - startY) >= MOVE_MENU || Math.abs(e.clientX - startX) >= MOVE_MENU) {
					moved = true;
					showTrail(e.clientX, e.clientY);
				}
				// 判活：路径点数足够（先上后下 totalDy 会抵消，改用位移距离）
				if (!active && pathPoints.length >= 6) active = true;
			});
			// 路径分析：严格"先上后下"（每段在 60° 锥内）才刷新
			// 上段：从起点向上累计 >= SEG_MIN，方向在屏幕正上方 60° 锥内（偏差 <= 30°）
			// 下段：上段之后向下累计 >= SEG_MIN，方向在正下方 60° 锥内
			function isRefreshGesture() {
				const pts = pathPoints;
				if (pts.length < 6) return false;
				// 找上段结束点：从起点看，累计向上达到 SEG_MIN 且 |dx|<=|dy|*TAN30
				let upEnd = -1;
				for (let i = 1; i < pts.length; i++) {
					const dy = pts[0][1] - pts[i][1];       // 向上为正
					const dx = Math.abs(pts[i][0] - pts[0][0]);
					if (dy >= SEG_MIN && dx <= dy * TAN30) { upEnd = i; break; }
				}
				if (upEnd < 0) return false;
				// 找下段：上段结束点之后，向下累计达到 SEG_MIN 且 60° 锥内
				for (let j = upEnd + 1; j < pts.length; j++) {
					const dy = pts[j][1] - pts[upEnd][1];   // 向下为正
					const dx = Math.abs(pts[j][0] - pts[upEnd][0]);
					if (dy >= SEG_MIN && dx <= dy * TAN30) return true;
				}
				return false;
			}
			// L 形手势（下→右，各段 ±30° 锥）：先向下累计 >= SEG_MIN（垂直 ±30° 内），
			// 再向右累计 >= SEG_MIN（水平 ±30° 内）→ 最小化客户端（主 2026-08-26 定；08-27 实测 15° 太严改 30°）
			function isLMinimizeGesture() {
				const pts = pathPoints;
				if (pts.length < 6) return false;
				const TAN30 = Math.tan(Math.PI / 6);   // 30° 锥：|dx| <= |dy| * tan30
				// 第一段：向下（屏幕正下方 30° 锥内）累计 >= SEG_MIN
				let downEnd = -1;
				for (let i = 1; i < pts.length; i++) {
					const dy = pts[i][1] - pts[0][1];             // 向下为正
					const dx = Math.abs(pts[i][0] - pts[0][0]);
					if (dy >= SEG_MIN && dx <= dy * TAN30) { downEnd = i; break; }
				}
				if (downEnd < 0) return false;
				// 第二段：向右（屏幕正右方 30° 锥内，dx 确实为正）累计 >= SEG_MIN
				for (let j = downEnd + 1; j < pts.length; j++) {
					const dx = pts[j][0] - pts[downEnd][0];       // 向右为正
					const dy = Math.abs(pts[j][1] - pts[downEnd][1]);
					if (dx >= SEG_MIN && dy <= dx * TAN30) return true;
				}
				return false;
			}
			// 总体方向：起点→终点的位移向量，判断是否在正上/正下 60° 锥内
			// 返回 "up"（正上方锥内）| "down"（正下方锥内）| null（斜向/横向，不动作）
			function overallDirection() {
				const pts = pathPoints;
				if (pts.length < 2) return null;
				const sx = pts[0][0], sy = pts[0][1];
				const ex = pts[pts.length - 1][0], ey = pts[pts.length - 1][1];
				const dy = sy - ey;            // 向上为正
				const dx = Math.abs(ex - sx);
				if (dy >= SEG_MIN && dx <= dy * TAN30) return "up";
				const dyD = ey - sy;           // 向下为正
				if (dyD >= SEG_MIN && dx <= dyD * TAN30) return "down";
				return null;
			}
			document.addEventListener("mouseup", (e) => {
				if (e.button !== 2) return;
				pressed = false;
				// 强制记录终点，供路径分析（hideTrail 会清空 pathPoints，须先分析再清理）
				showTrail(e.clientX, e.clientY);
				if (active) {
					const sc = findScrollable(e.target);
					if (isLMinimizeGesture()) {
						// L 形（下→右 ±15°）→ 最小化客户端（等同点击窗口最小化按钮）
						showHint(e.clientX, e.clientY, "最小化");
						fetch(MINIMIZE_URL, { method: "POST", mode: "cors" }).catch(() => {});
					} else if (isRefreshGesture()) {
						// 严格先上后下（60° 锥内）→ 刷新页面
						showHint(e.clientX, e.clientY, "刷新");
						location.reload();
					} else {
						// 上/下拖需在正上/正下 60° 锥内；斜向/横向不动作
						const dir = overallDirection();
						if (dir === "up") {
							showHint(e.clientX, e.clientY, "到顶部");
							sc.scrollTop = 0;
						} else if (dir === "down") {
							showHint(e.clientX, e.clientY, "到底部");
							sc.scrollTop = sc.scrollHeight;
						}
					}
				}
				hideTrail();
				active = false;
				phase = "none";
			});
			// 拖动中阻止右键菜单；未移动的普通右键放行
			document.addEventListener("contextmenu", (e) => {
				if (moved || active) e.preventDefault();
			});
		}

		// 大纲锁定计数：菜单/设置面板打开时禁止消息大纲 hover 展开，并整体隐藏横杠（2026-08-27 主需求）
		function outlineLock(on) {
			window.__dshOutlineLock = (window.__dshOutlineLock || 0) + (on ? 1 : -1);
			if (window.__dshOutlineLock < 0) window.__dshOutlineLock = 0;
			document.body.classList.toggle("dsh-outline-locked", window.__dshOutlineLock > 0);
		}

		// ---------- 已归档会话面板（侧边栏设置按钮上方，2026-08-27 主需求） ----------
		// dsh 归档 = 会话加入 archivedSessionIds（从列表隐藏、无找回 UI 且无法删除）；
		// 本面板订阅 workspaces.list（归档 id 集合）+ sessions.list（会话详情 byId），
		// 在侧边栏 footArea 的 settingsArea 之前插入"已归档会话"区块：
		// 展开/折叠、打开会话、删除会话（走 3081 /api/session-delete，删除后 dsh 的
		// fs.watch 监听会话目录自动刷新列表）。MutationObserver 兜底 React 重渲染移出后重插。
		function buildArchivedPanel(ctx) {
			const sessions = ctx.sessions || (ctx.get ? ctx.get("sessions") : undefined);
			const workspaces = ctx.workspaces || (ctx.get ? ctx.get("workspaces") : undefined);
			if (!sessions || !workspaces) return;

			const root = document.createElement("div");
			root.id = "dsh-archived-panel";
			Object.assign(root.style, {
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",   // 下方也加分隔线，与"设置"区分（2026-08-27 主需求）
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent)",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: "var(--dsw-font-family)",   // 跟随全局字体设置（2026-08-27 主需求）
				fontSize: "14px", userSelect: "none",   // 对齐"设置"条目字号（2026-08-27 主需求）
			});
			// 标题行（点击折叠/展开）
			const head = document.createElement("div");
			Object.assign(head.style, {
				display: "flex", alignItems: "center", gap: "6px",
				padding: "7px 10px", cursor: "pointer", borderRadius: "8px",
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "14px", fontWeight: "600",
			});
			// 标题行 hover：高亮背景 + 阴影（2026-09-01 主需求：已归档会话这一行滑过也要有阴影）
			head.addEventListener("mouseenter", () => {
				head.style.background = "var(--dsw-alias-interactive-bg-hover)";
				head.style.boxShadow = "0 1px 3px rgba(0,0,0,.12)";
			});
			head.addEventListener("mouseleave", () => {
				head.style.background = "transparent";
				head.style.boxShadow = "none";
			});
			const chevron = document.createElement("span");
			chevron.textContent = "▸";
			chevron.style.display = "inline-block";
			const labelEl = document.createElement("span");
			labelEl.textContent = "已归档会话";
			const countEl = document.createElement("span");
			Object.assign(countEl.style, {
				marginLeft: "auto", fontSize: "12px",
				background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))",
				borderRadius: "8px", padding: "1px 7px",
				color: "var(--dsw-alias-label-tertiary)",
			});
			head.appendChild(chevron);
			head.appendChild(labelEl);
			head.appendChild(countEl);
			const listEl = document.createElement("div");
			Object.assign(listEl.style, {
				maxHeight: "220px", overflowY: "auto",
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				display: "none",
			});
			let expanded = false;
			// 本地已删除集合：删除成功后即时隐藏（不等 dsh host 文件监听推送，2026-08-27 主需求）
			let removedIds = new Set();
			head.addEventListener("click", () => {
				expanded = !expanded;
				chevron.textContent = expanded ? "▾" : "▸";
				listEl.style.display = expanded ? "block" : "none";
			});
			root.appendChild(head);
			root.appendChild(listEl);

			function relTime(ts) {
				if (!ts) return "";
				const d = Date.now() - ts;
				if (d < 60000) return "刚刚";
				if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
				if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
				if (d < 7 * 86400000) return Math.floor(d / 86400000) + " 天前";
				const dt = new Date(ts);
				return (dt.getMonth() + 1) + "-" + dt.getDate();
			}

			function archivedList() {
				let wsSnap = null, sSnap = null;
				try { wsSnap = workspaces.list.getSnapshot(); } catch (e) {}
				try { sSnap = sessions.list.getSnapshot(); } catch (e) {}
				const archived = wsSnap && Array.isArray(wsSnap.archivedSessionIds) ? [...wsSnap.archivedSessionIds] : [];
				const byId = sSnap && sSnap.byId ? sSnap.byId : {};
				// 过滤已删除会话（byId 中已不存在 = 文件已删，host 已剔除；或本地即时移除标记）
				const rows = archived.filter((id) => byId[id] !== undefined && !removedIds.has(id)).map((id) => {
					const s = byId[id];
					return { id, title: s.title || id.slice(0, 8), updatedAt: s.updatedAt || 0 };
				});
				rows.sort((a, b) => b.updatedAt - a.updatedAt);
				return rows;
			}

			function render() {
				const rows = archivedList();
				countEl.textContent = String(rows.length);
				listEl.textContent = "";
				if (rows.length === 0) {
					const empty = document.createElement("div");
					empty.textContent = "无归档会话";
					Object.assign(empty.style, { padding: "8px 12px", color: "var(--dsw-alias-label-tertiary)" });
					listEl.appendChild(empty);
					return;
				}
				for (const row of rows) {
					const item = document.createElement("div");
					Object.assign(item.style, {
						display: "flex", alignItems: "center", gap: "6px",
						height: "32px", padding: "0 8px", borderRadius: "8px",
						cursor: "pointer", color: "var(--dsw-alias-label-primary)",
					});
					// hover：高亮背景 + 轻阴影（对齐原版会话行交互，2026-08-27）
					item.addEventListener("mouseenter", () => {
						item.style.background = "var(--dsw-alias-interactive-bg-hover)";
						item.style.boxShadow = "0 1px 3px rgba(0,0,0,.12)";
					});
					item.addEventListener("mouseleave", () => {
						item.style.background = "transparent";
						item.style.boxShadow = "none";
						// 不移开即关菜单：鼠标移到菜单上时会误触行 mouseleave（2026-08-27 bug 修复）
					});
					const title = document.createElement("span");
					title.textContent = row.title;
					Object.assign(title.style, {
						flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
					});
					// 不设 title 属性：避免 hover 原生悬浮提示（2026-08-27 主需求）
					const time = document.createElement("span");
					time.textContent = relTime(row.updatedAt);
					Object.assign(time.style, { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" });
					// 三点按钮：hover 显示，点击弹出菜单（删除会话）；不设 title 避免悬浮提示（2026-08-27 主需求）
					const moreBtn = document.createElement("button");
					moreBtn.textContent = "⋯";
					Object.assign(moreBtn.style, {
						border: "none", background: "transparent", cursor: "pointer",
						color: "var(--dsw-alias-label-tertiary)", fontSize: "15px",
						lineHeight: "1", padding: "2px 4px", borderRadius: "5px",
						visibility: "hidden",
					});
					item.addEventListener("mouseenter", () => { moreBtn.style.visibility = "visible"; });
					item.addEventListener("mouseleave", () => { moreBtn.style.visibility = "hidden"; });
					moreBtn.addEventListener("mouseenter", () => { moreBtn.style.color = "var(--dsw-alias-label-primary)"; });
					moreBtn.addEventListener("mouseleave", () => { moreBtn.style.color = "var(--dsw-alias-label-tertiary)"; });
					moreBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						showRowMenu(row, moreBtn);
					});
					// 点击行 = 恢复归档会话并访问（dsh 限制：归档会话不可直接打开，
					// 恢复 = 3081 从 workspace.json 移除归档标记 + 重启 web，刷新后回到列表）
					item.addEventListener("click", () => {
						showRestoreDialog(row);
					});
					item.appendChild(title);
					item.appendChild(time);
					item.appendChild(moreBtn);
					listEl.appendChild(item);
				}
			}

			// ---- 三点菜单（仿 dsh Menu 卡片风格）----
			let rowMenuEl = null, rowMenuRow = null;
			function hideRowMenu() {
				if (rowMenuEl) {
					outlineLock(false);   // 菜单关闭 → 解锁大纲
					rowMenuEl.remove();
					rowMenuEl = null;
					rowMenuRow = null;
				}
			}
			function showRowMenu(row, btn) {
				if (rowMenuEl && rowMenuRow && rowMenuRow.id === row.id) { hideRowMenu(); return; }
				hideRowMenu();
				outlineLock(true);   // 菜单打开 → 锁大纲（划过大纲横杠不弹出）
				rowMenuRow = row;
				rowMenuEl = document.createElement("div");
				Object.assign(rowMenuEl.style, {
					position: "fixed", zIndex: "1100", minWidth: "164px", padding: "2px",
					border: "1px solid var(--dsw-alias-border-inverted)",
					borderRadius: "7px",
					background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3))",
					boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.35))",
					fontFamily: 'system-ui, "Segoe UI", sans-serif',
					fontSize: "14px", lineHeight: "22px",   // 对齐面板/设置字号（2026-08-27 主需求）
				});
				// 菜单项：恢复会话（普通色）+ 删除会话（danger 红）
				const mkItem = (text, danger) => {
					const it = document.createElement("div");
					it.textContent = text;
					Object.assign(it.style, {
						display: "flex", alignItems: "center", gap: "6px",
						minHeight: "34px", padding: "5px 8px", borderRadius: "5px",
						cursor: "pointer",
						color: danger ? "var(--dsw-alias-state-danger, #e5484d)" : "var(--dsw-alias-label-primary)",
					});
					it.addEventListener("mouseenter", () => {
						it.style.background = danger
							? "var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover))"
							: "var(--dsw-alias-interactive-bg-hover)";
					});
					it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
					return it;
				};
				const restore = mkItem("恢复会话", false);
				restore.addEventListener("click", (e) => {
					e.stopPropagation();
					hideRowMenu();
					showRestoreDialog(row);
				});
				const del = mkItem("删除会话", true);
				del.addEventListener("click", (e) => {
					e.stopPropagation();
					hideRowMenu();
					showDeleteDialog(row);
				});
				rowMenuEl.appendChild(restore);
				rowMenuEl.appendChild(del);
				document.body.appendChild(rowMenuEl);
				// 定位：按钮右上方弹出（左缘对齐按钮右缘、向上展开），空间不足才向下；
				// 用真实宽高计算，避免菜单高度写死导致底部超屏（2026-09-01 主需求修复）
				const r = btn.getBoundingClientRect();
				const rect = rowMenuEl.getBoundingClientRect();
				const mw = rect.width, mh = rect.height;
				let left = r.right + 4, top = r.top - mh - 4;
				if (top < 8) top = r.bottom + 4;
				if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
				if (left < 8) left = 8;
				rowMenuEl.style.left = left + "px";
				rowMenuEl.style.top = top + "px";
				setTimeout(() => { document.addEventListener("click", hideRowMenu, { once: true }); }, 0);
			}

			// ---- 删除确认对话框（仿 dsh Modal 风格）----
			function showDeleteDialog(row) {
				const overlay = document.createElement("div");
				Object.assign(overlay.style, {
					position: "fixed", inset: "0", zIndex: "1200",
					background: "rgba(0,0,0,.45)",
					display: "flex", alignItems: "center", justifyContent: "center",
				});
				const card = document.createElement("div");
				Object.assign(card.style, {
					width: "360px", maxWidth: "90vw",
					background: "var(--dsw-alias-bg-layer-2)",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "12px",
					boxShadow: "var(--dsw-shadow-lv3, 0 16px 48px rgba(0,0,0,.4))",
					padding: "18px",
					color: "var(--dsw-alias-label-primary)",
					fontFamily: 'system-ui, "Segoe UI", sans-serif',
				});
				const title = document.createElement("div");
				title.textContent = "删除会话";
				Object.assign(title.style, { fontSize: "15px", fontWeight: "600", marginBottom: "8px" });
				const desc = document.createElement("div");
				desc.textContent = "将永久删除会话「" + row.title + "」，包括全部对话记录，此操作不可恢复。";
				Object.assign(desc.style, {
					fontSize: "13px", lineHeight: "1.6",
					color: "var(--dsw-alias-label-secondary)", marginBottom: "16px",
				});
				const btns = document.createElement("div");
				Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
				const mkBtn = (text, danger) => {
					const b = document.createElement("button");
					b.textContent = text;
					Object.assign(b.style, {
						padding: "6px 14px", borderRadius: "8px", cursor: "pointer",
						border: "1px solid var(--dsw-alias-border-l2)",
						background: danger ? "var(--dsw-alias-state-danger, #e5484d)" : "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
						color: danger ? "#fff" : "var(--dsw-alias-label-primary)",
						fontSize: "13px",
					});
					return b;
				};
				const close = () => overlay.remove();
				const cancel = mkBtn("取消", false);
				const confirmBtn = mkBtn("删除", true);
				cancel.addEventListener("click", close);
				confirmBtn.addEventListener("click", () => {
					close();
					fetch("http://127.0.0.1:3081/api/session-delete", {
						method: "POST", mode: "cors",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sessionId: row.id }),
					}).then((r) => r.json()).then((j) => {
						if (j.ok) {
							// 本地即时移除（不等 host 推送），2026-08-27 主需求
							removedIds.add(row.id);
							render();
						} else {
							alert("删除失败：" + (j.error || "未知错误"));
						}
					}).catch(() => alert("删除失败：无法连接终端服务"));
				});
				overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
				btns.appendChild(cancel);
				btns.appendChild(confirmBtn);
				card.appendChild(title);
				card.appendChild(desc);
				card.appendChild(btns);
				overlay.appendChild(card);
				document.body.appendChild(overlay);
			}

			// ---- 恢复归档会话确认（dsh 无取消归档 API，走 3081 改 workspace.json + 重启 web）----
			function showRestoreDialog(row) {
				const overlay = document.createElement("div");
				Object.assign(overlay.style, {
					position: "fixed", inset: "0", zIndex: "1200",
					background: "rgba(0,0,0,.45)",
					display: "flex", alignItems: "center", justifyContent: "center",
				});
				const card = document.createElement("div");
				Object.assign(card.style, {
					width: "360px", maxWidth: "90vw",
					background: "var(--dsw-alias-bg-layer-2)",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "12px",
					boxShadow: "var(--dsw-shadow-lv3, 0 16px 48px rgba(0,0,0,.4))",
					padding: "18px",
					color: "var(--dsw-alias-label-primary)",
					fontFamily: 'system-ui, "Segoe UI", sans-serif',
				});
				const title = document.createElement("div");
				title.textContent = "恢复会话";
				Object.assign(title.style, { fontSize: "15px", fontWeight: "600", marginBottom: "8px" });
				const desc = document.createElement("div");
				desc.textContent = "会话「" + row.title + "」已归档，恢复后才能访问。\n恢复后页面将自动刷新，会话回到会话列表。";
				Object.assign(desc.style, {
					fontSize: "13px", lineHeight: "1.6",
					color: "var(--dsw-alias-label-secondary)", marginBottom: "16px",
				});
				const btns = document.createElement("div");
				Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
				const mkBtn = (text, primary) => {
					const b = document.createElement("button");
					b.textContent = text;
					Object.assign(b.style, {
						padding: "6px 14px", borderRadius: "8px", cursor: "pointer",
						border: "1px solid var(--dsw-alias-border-l2)",
						background: primary ? "var(--dsw-alias-state-business-primary, #4d6bfe)" : "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
						color: primary ? "#fff" : "var(--dsw-alias-label-primary)",
						fontSize: "13px",
					});
					return b;
				};
				const close = () => overlay.remove();
				const cancel = mkBtn("取消", false);
				const confirmBtn = mkBtn("恢复", true);
				cancel.addEventListener("click", close);
				confirmBtn.addEventListener("click", () => {
					confirmBtn.disabled = true;
					confirmBtn.textContent = "恢复中…";
					fetch("http://127.0.0.1:3081/api/session-unarchive", {
						method: "POST", mode: "cors",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sessionId: row.id }),
					}).then((r) => r.json()).then((j) => {
						if (j.ok) {
							close();
							const tip = document.createElement("div");
							Object.assign(tip.style, {
								position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)",
								zIndex: "1300", padding: "8px 16px", borderRadius: "8px",
								background: "var(--dsw-alias-bg-layer-2)",
								border: "1px solid var(--dsw-alias-border-l2)",
								boxShadow: "0 4px 16px rgba(0,0,0,.3)",
								color: "var(--dsw-alias-label-primary)", fontSize: "13px",
								fontFamily: 'system-ui, "Segoe UI", sans-serif',
							});
							tip.textContent = "已恢复，页面即将刷新…";
							document.body.appendChild(tip);
						} else {
							alert("恢复失败：" + (j.error || "未知错误"));
							close();
						}
					}).catch(() => {
						alert("恢复失败：无法连接终端服务");
						close();
					});
				});
				overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
				btns.appendChild(cancel);
				btns.appendChild(confirmBtn);
				card.appendChild(title);
				card.appendChild(desc);
				card.appendChild(btns);
				overlay.appendChild(card);
				document.body.appendChild(overlay);
			}
			render();
			// 订阅归档集合与会话数据变化
			try { if (sessions.list && sessions.list.subscribe) sessions.list.subscribe(render); } catch (e) {}
			try { if (workspaces.list && workspaces.list.subscribe) workspaces.list.subscribe(render); } catch (e) {}

			// 挂载：插到设置按钮上方（footArea 内 settingsArea 之前）
			function findSettingsBtn() {
				const btns = document.querySelectorAll("button");
				for (const b of btns) {
					const aria = (b.getAttribute("aria-label") || "").trim();
					const txt = (b.textContent || "").trim();
					const title = (b.getAttribute("title") || "").trim();
					if (aria === "设置" || aria === "Settings" || txt === "设置" || txt === "Settings" || title === "设置" || title === "Settings") return b;
				}
				return null;
			}
			function mount() {
				if (root.isConnected) return true;
				const btn = findSettingsBtn();
				if (!btn) return false;
				const settingsArea = btn.closest("div");
				const footArea = settingsArea ? settingsArea.parentElement : null;
				if (!footArea) return false;
				footArea.insertBefore(root, settingsArea);
				// 侧边栏折叠成 rail（窄条）时隐藏区块
				const sidebarRoot = footArea.parentElement;
				const applyWidth = () => {
					root.style.display = (sidebarRoot && sidebarRoot.offsetWidth > 80) ? "" : "none";
				};
				applyWidth();
				if (sidebarRoot) { try { new ResizeObserver(applyWidth).observe(sidebarRoot); } catch (e) {} }
				return true;
			}
			// 兜底：React 重渲染可能移除区块，观察并重插
			try {
				const mo = new MutationObserver(() => { if (!root.isConnected) mount(); });
				mo.observe(document.body, { childList: true, subtree: true });
			} catch (e) {}
			// 等待侧边栏渲染完成后挂载（重试 9 秒）
			let tries = 0;
			const timer = setInterval(() => {
				tries += 1;
				if (mount() || tries > 30) clearInterval(timer);
			}, 300);

			// 设置面板打开时锁大纲（dsh 设置菜单在左侧弹出，鼠标划过大纲横杠会误展开遮挡；2026-08-27 主需求）
			let settingsWasOpen = false;
			setInterval(() => {
				const isOpen = !!document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][aria-hidden="false"], [role="dialog"]');
				if (isOpen && !settingsWasOpen) { settingsWasOpen = true; outlineLock(true); }
				else if (!isOpen && settingsWasOpen) { settingsWasOpen = false; outlineLock(false); }
			}, 500);
		}

		// ---------- Token HUD（常驻右上角） ----------
		function buildHud() {
			const root = document.createElement("div");
			root.id = HUD_ID;
			Object.assign(root.style, {
				position: "fixed", top: "14px", right: "14px", zIndex: "99992",
				width: "180px", minWidth: "180px", boxSizing: "border-box",   // 2026-09-05 主调整：160→170
				padding: "10px 12px",
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 30%, transparent)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				boxShadow: "0 4px 16px rgba(0,0,0,.22)",
				backdropFilter: "blur(4px)",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: 'system-ui, "Segoe UI", sans-serif',
				fontSize: "11px", lineHeight: "1.6",
				cursor: "move", userSelect: "none",
			});
			const title = document.createElement("div");
			Object.assign(title.style, {
				fontWeight: "600", fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
				marginBottom: "4px",
			});
			title.textContent = "Token · 今日";
			const grid = document.createElement("div");
			grid.id = HUD_ID + "-grid";
			root.appendChild(title);
			root.appendChild(grid);
			// 整框拖动
			let dragging = false, offX = 0, offY = 0;
			root.addEventListener("mousedown", (e) => {
				dragging = true;
				offX = e.clientX - root.offsetLeft;
				offY = e.clientY - root.offsetTop;
				root.style.right = "auto";
				e.preventDefault();
			});
			document.addEventListener("mousemove", (e) => {
				if (!dragging) return;
				root.style.left = (e.clientX - offX) + "px";
				root.style.top = (e.clientY - offY) + "px";
			});
			document.addEventListener("mouseup", () => { dragging = false; });
			return { root, grid };
		}
		function renderHud(hud, state) {
			hud.grid.textContent = "";
			// 三列：名称 | 数据 | 金额（主定稿 2026-08-17）
			// 列布局用 CSS grid（grid 容器已设 grid-template-columns: 1fr auto auto）
			const row = (label, value, cost, valueColor, costColor) => {
				const d = document.createElement("div");
				// 2026-09-05 主试调定稿：grid 列宽对齐——label 列宽取最长行、value 列随之对齐（上下对齐），金额列右贴
				Object.assign(d.style, {
					display: "grid",
					gridTemplateColumns: "50px auto 1fr",   // 2026-09-05 label 列固定 42px：各行数字起点统一
					columnGap: "6px",
					alignItems: "baseline",
				});
				const l = document.createElement("span");
				l.style.color = "var(--dsw-alias-label-tertiary)";
				l.style.whiteSpace = "nowrap";
				l.textContent = label;
				const v = document.createElement("span");
				v.style.fontFamily = 'Consolas, monospace';
				v.style.color = valueColor || "var(--dsw-alias-label-primary)";
				v.style.textAlign = "left";   // 2026-09-05 数字列左对齐：起点统一成一线
				v.style.whiteSpace = "nowrap";
				v.textContent = value;
				const c = document.createElement("span");
				c.style.fontFamily = 'Consolas, monospace';
				c.style.color = costColor || "var(--dsw-alias-label-primary)";
				c.style.textAlign = "right";
				c.style.whiteSpace = "nowrap";
				c.textContent = cost;
				d.appendChild(l);
				d.appendChild(v);
				d.appendChild(c);
				return d;
			};
			// 六项：输入(命中) / 输入(未命中) / 命中率 / 输出 / 今日消耗 / 余额（主定稿 2026-08-17）
			// 平台接口：inputHit/inputMiss 官方拆分，金额按类型官方精确值；
			// 回落本地日志时命中=cacheRead，未命中=input-cacheRead，无金额
			const hitTotal = state.inputHit !== undefined ? state.inputHit + state.inputMiss : state.input + state.cacheRead;
			const hit = state.inputHit !== undefined ? state.inputHit : state.cacheRead;
			const hitRate = hitTotal > 0 ? Math.round(hit / hitTotal * 100) : 0;
			const money = (n) => (n !== undefined && n !== null ? "¥" + Number(n).toFixed(2) : "—");
			hud.grid.appendChild(row("命中", fmt(hit), money(state.inputHitCost)));
			hud.grid.appendChild(row("未命中", fmt(hitTotal - hit), money(state.inputMissCost)));
			hud.grid.appendChild(row("命中率", hitRate + "%", "—"));
			hud.grid.appendChild(row("输出", fmt(state.output), money(state.outputCost)));
			// 高峰/空闲状态：DeepSeek 峰谷定价（官网：工作日高峰=北京时间 9:00-12:00、14:00-18:00，
			// 其余为空闲；2026-09-01 调价后周末全天为优惠/空闲时段），高峰红色显示（主 2026-08-19/09-01 要求）
			const peak = isDeepSeekPeak();
			hud.grid.appendChild(row("花费", peak ? "高峰" : "空闲", state.cost !== null ? "¥" + state.cost.toFixed(2) : "—", peak ? "#f85149" : undefined));
			// 余额 < 5 元红色警示（主 2026-08-19 要求）
			const bal = state.balance !== null ? parseFloat(state.balance) : null;
			hud.grid.appendChild(row("余额", "—", bal !== null ? "¥" + bal : "…", undefined, bal !== null && bal < 5 ? "#f85149" : undefined));
		}
		function fmt(n) {
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(n);
		}

		// DeepSeek 峰谷定价判定（官网 api-docs.deepseek.com/zh-cn/quick_start/pricing 原文）：
		// "高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）"
		// 2026-09-01 调价：周末全天为优惠/空闲时段（主确认）。
		// 按北京时间（UTC+8，不依赖本机时区），高峰红色显示。
		function isDeepSeekPeak() {
			const bj = new Date(Date.now() + 8 * 3600 * 1000);
			const day = bj.getUTCDay();   // 北京时间星期：0=周日 6=周六
			if (day === 0 || day === 6) return false;   // 周末全天空闲（优惠价）
			const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
			return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
		}

		// ---------- 今日词元：平台用量接口优先，失败回落本地会话聚合 ----------
		function fetchUsage(hud, state) {
			fetch("http://127.0.0.1:3081/api/platform-usage", { mode: "cors" })
				.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
				.then((data) => {
					if (data && typeof data.inputHit === "number") {
						state.inputHit = data.inputHit;
						state.inputHitCost = data.inputHitCost;
						state.inputMiss = data.inputMiss;
						state.inputMissCost = data.inputMissCost;
						state.output = data.output;
						state.outputCost = data.outputCost;
						state.cost = data.cost;
						state.costCurrency = data.costCurrency || "CNY";
					}
				})
				.catch(() => fetchTodayUsage(hud, state))  // 平台不可用 → 回落会话日志
				.finally(() => renderHud(hud, state));
		}
		function fetchTodayUsage(hud, state) {
			fetch("http://127.0.0.1:3081/api/today-usage", { mode: "cors" })
				.then((r) => r.json())
				.then((data) => {
					if (data && typeof data.input === "number") {
						// 回落模式：未命中 = 总输入 - 命中（近似）；无今日消耗与分项金额
						state.inputHit = undefined;   // 标记回落，命中率用 cacheRead 口径
						state.inputHitCost = undefined;
						state.inputMissCost = undefined;
						state.outputCost = undefined;
						state.input = data.input;
						state.output = data.output;
						state.cacheRead = data.cacheRead;
						state.cost = null;
					}
				})
				.catch(() => {})
				.finally(() => renderHud(hud, state));
		}

		// ---------- 余额（经 3081 代理；fetch 失败静默） ----------
		function refreshBalance(hud, state) {
			fetch(BALANCE_URL, { mode: "cors" })
				.then((r) => r.json())
				.then((data) => {
					const info = data && data.balance_infos && data.balance_infos[0];
					if (info && info.total_balance !== undefined) {
						state.balance = String(info.total_balance);
					}
				})
				.catch(() => {})
				.finally(() => renderHud(hud, state));
		}

				// ========== 左缘消息大纲条（当前会话我的消息，hover 展开） ==========
		// 2026-08-17 主定稿（单元素设计，v1 基底）：横杠即面板——平时一列细横杠
		// （每条=我的一条消息），hover 同一元素展开为完整大纲（横杠+行号+文本同一行，
		// 天然垂直对齐）；位置：对话区滚动容器左内缘+4；最多显示 10 条（最近 10 条，
		// 最新在下），多于 10 条展开时 box 内滚动条上下查找；
		// 颜色：默认灰、鼠标划过整行变黑（横杠+文字）、点击行→横杠+文字变蓝并瞬间定位；
		// 字体 14px；数据源 sessions.binding(id).session 快照（订阅驱动，不轮询不重建）；
		// DOM 定位：data-chat-flow-kind="user" 第 n 行 = 第 n 条我的消息（dsh 渲染契约）。
		const OUTLINE_RAIL_ID = "dsh-msg-outline-rail";
		const OUTLINE_FLASH = "dsh-msg-outline-flash";

		function buildMessageOutline(ctx) {
			const sessions = ctx.sessions || (ctx.get ? ctx.get("sessions") : undefined);
			if (!sessions) return;
			if (document.getElementById(OUTLINE_RAIL_ID)) return; // 已注入

			// ---- 单元素：横杠列 = 大纲面板（hover 同一元素展开） ----
			const box = document.createElement("div");
			box.id = OUTLINE_RAIL_ID;
			Object.assign(box.style, {
				position: "fixed", left: "0", top: "50%",
				transform: "translateY(-50%)", zIndex: "1000",   // 2026-08-27：降到菜单(1100)/对话框(1200)之下，菜单可覆盖大纲
				display: "flex", flexDirection: "column", gap: "0",
				padding: "6px", borderRadius: "10px",
				background: "transparent", border: "1px solid transparent",
				cursor: "pointer",
				transition: "background .15s ease, border-color .15s ease",
				maxHeight: "260px", overflowY: "auto",
				fontSize: "14px",
				visibility: "hidden", // 定位到对话区左内缘前不显示
			});

			// ---- 状态（2026-09-05 数据层：host turnOutline 投影全量优先 + DOM 扫描兜底。
			//      新版 dsh 0.1.2-rc.1 移除 session.getSnapshot() 快照 API、对话区改
			//      懒加载窗口（DOM 只含尾部页）——全量大纲只能读 host 投影
			//      projections.get("turnOutline")（每轮一条，全量不受窗口限制）。----
			let sessionId = null;
			let binding = null;          // 新版 sessions.binding(id).session：projections/loadOlder()/hasMore
			let projectionUnsub = null;  // 投影订阅退订（会话切换释放）
			let projTimer = null;        // 投影变更防抖
			let outlineMode = "dom";     // "outline"=turnOutline 投影（每轮一条）| "dom"=DOM 扫描兜底
			let userMsgs = [];           // [{text, turn?, key?}]（大纲条目：投影=轮，兜底=我的消息行）
			let activeIdx = -1;          // 当前点击/选中的消息下标（-1=无，横杠+文字变蓝）
			let rows = [];               // {row, bar, num, txt, idx} 行引用（颜色状态更新用）
			let expanded = false;        // 是否展开（平时只显示横杠，hover 展开显示行号+文本）
			let keyMap = {};             // 官方锚点 key → DOM 行元素（数据/DOM 变化时重建）
			let rowObserver = null;      // 对话区 DOM 观察（新消息/分页/compaction 驱动重扫）
			let observedRoot = null;     // 当前观察的对话区根（根被重建时重挂观察）
			let pendingTarget = null;    // 懒加载定位目标（{turn}|{key}）：等"加载更早"把目标加载进 DOM
			let lastLoadClick = 0;       // 触发"加载更早"节流
			let pendingTimer = null;     // 定位超时保护
			let rebuildTimer = null;     // DOM 变化防抖计时

			function currentSessionId() {
				const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
				return snap && snap.current !== undefined ? snap.current : null;
			}

			function boundSession() {
				try { return binding && binding.session ? binding.session : null; }
				catch (e) { return null; }
			}

			function rebind() {
				const sid = currentSessionId();
				if (sid === sessionId) return;   // 会话未切换：变更由投影订阅/DOM 观察驱动
				// 会话切换：退订旧投影订阅，重新绑定新会话
				if (projectionUnsub) { try { projectionUnsub(); } catch (e) {} projectionUnsub = null; }
				sessionId = sid;
				binding = null;
				if (sid !== null) {
					try { binding = sessions.binding(sid); } catch (e) { binding = null; }
				}
				userMsgs = [];
				rows = [];
				renderRows();
				// 订阅 host 投影：turnOutline 等推送即刷新大纲（新轮次/历史补齐都会推）
				const bs = boundSession();
				const proj = bs && bs.projections ? bs.projections : null;
				if (proj && typeof proj.subscribeAny === "function") {
					try {
						projectionUnsub = proj.subscribeAny(() => {
							clearTimeout(projTimer);
							projTimer = setTimeout(syncOutline, 80);
						});
					} catch (e) {}
				}
				// 新会话数据异步就绪 → 延迟多次同步兜底
				setTimeout(syncOutline, 120);
				setTimeout(syncOutline, 500);
				setTimeout(syncOutline, 1500);
			}

			// 读 host turnOutline 投影（每轮一条：{turn, seq, prompt, response}，全量升序）
			function readProjectionOutline() {
				const bs = boundSession();
				const proj = bs && bs.projections ? bs.projections : null;
				if (!proj) return null;
				try {
					const v = proj.get("turnOutline");
					if (Array.isArray(v) && v.length) return v;
				} catch (e) {}
				return null;
			}
			// ---- 大纲同步入口：host 全量投影优先（不受懒加载窗口限制）；
			//      投影缺失（旧版/未推送）→ DOM 扫描兜底。 ----
			function syncOutline() {
				const outline = readProjectionOutline();
				if (outline) {
					const next = [];
					for (const t of outline) {
						if (typeof t.prompt !== "string" || !t.prompt) continue;
						next.push({ text: t.prompt, turn: t.turn, seq: t.seq });
					}
					applyMsgList(next, "outline");
				} else {
					domScan();
				}
			}
			// 整体替换大纲列表（按 turn/key 序比对，变了才重建行）
			function applyMsgList(next, mode) {
				const keyOf = (m) => (mode === "outline" ? m.turn : m.key);
				let changed = next.length !== userMsgs.length;
				if (!changed) {
					for (let i = 0; i < next.length; i++) {
						if (keyOf(next[i]) !== keyOf(userMsgs[i])) { changed = true; break; }
					}
				}
				if (changed) {
					userMsgs = next;
					outlineMode = mode;
					renderRows();
				}
				afterSync();
			}
			function afterSync() {
				const root = findChatRoot();
				if (root) rebuildKeyMap(root);
				const bs = boundSession();
				numHiddenByLoad = !!(bs && bs.hasMore);   // 加载历史期间隐藏行号（序号前移会跳）
				updateExpanded(expanded);
				checkPending();
			}
			// 点击跳转目标检查：加载出来→立即定位；没加载→继续触发"加载更早"
			function checkPending() {
				if (!pendingTarget) return;
				const el = findTargetEl(pendingTarget);
				if (el) {
					pendingTarget = null;
					clearTimeout(pendingTimer);
					if (el) jumpTo(el);
				} else {
					maybeLoadOlder();
				}
			}
			// 定位目标 DOM 行：outline 模式按轮号 data-chat-turn；DOM 兜底按官方 key 锚点
			function findTargetEl(m) {
				const root = findChatRoot();
				if (!root) return null;
				if (m.turn != null) {
					return root.querySelector('[data-chat-turn="' + m.turn + '"]');
				}
				return m.key ? (keyMap[m.key] || null) : null;
			}
			// ---- DOM 扫描（兜底模式：投影不可用时收集已加载窗口内我的消息行；
			//      key=官方 data-chat-anchor-key，文档序=时间序，文本行内提取）----
			function domScan() {
				const root = findChatRoot();
				if (!root) return;
				const next = [];
				const seen = new Set();
				const els = root.querySelectorAll('[data-chat-anchor-key]');
				for (const el of els) {
					const k = el.getAttribute("data-chat-anchor-key");
					if (!k || seen.has(k)) continue;
					const kind = el.getAttribute("data-chat-flow-kind");
					if (kind !== "user" && kind !== "steering") continue;
					seen.add(k);
					next.push({ text: rowTextOf(el), key: k });
				}
				applyMsgList(next, "dom");
			}

			// 从 DOM 消息行提取文本（排除按钮/图标/aria-hidden 操作区/时间等 UI 噪音）
			function rowTextOf(el) {
				if (!el) return "";
				try {
					const parts = [];
					const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
					let n;
					while ((n = walker.nextNode())) {
						const p = n.parentElement;
						if (!p || !p.closest) continue;
						if (p.closest('button,svg,[aria-hidden="true"],time,style,script')) continue;
						const v = (n.textContent || "").trim();
						if (v) parts.push(v);
					}
					return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
				} catch (e) {
					return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
				}
			}

			// key → DOM 行索引：key 是官方锚点（data-chat-anchor-key），直接按属性查 DOM 行，
			// 零文本匹配、零数量对齐、零顺序假设——最可靠。
			function rebuildKeyMap(root) {
				keyMap = {};
				const r = root || findChatRoot();
				if (!r) return;
				for (const e of r.querySelectorAll('[data-chat-anchor-key]')) {
					const k = e.getAttribute("data-chat-anchor-key");
					if (k) keyMap[k] = e;
				}
			}
			// 触发对话区"加载更早"（懒加载历史）：优先走新版 binding.session.loadOlder()
			//（编程式分页，同官方 ChatView 按钮机制），节流防止连点。
			function maybeLoadOlder() {
				const bs = boundSession();
				const root = findChatRoot();
				const now = Date.now();
				if (now - lastLoadClick < 700) return;
				if (bs && typeof bs.loadOlder === "function" && bs.hasMore && !bs.loadingOlder) {
					lastLoadClick = now;
					try { bs.loadOlder().catch(() => {}); } catch (e) {}
					return;
				}
				// 兜底：模拟点击官方"加载更早"按钮
				if (!root) return;
				const btn = root.querySelector('button[type="button"]');
				if (!btn || btn.disabled) return;
				const label = (btn.textContent || "").trim();
				if (label !== "加载更早" && label !== "Load earlier") return;
				lastLoadClick = now;
				btn.click();
			}
			// 监听对话区 DOM 变化（新消息渲染 / 分页加载历史 / compaction 重建）：
			// 变化即防抖重扫，保证横杠/索引始终最新。对话区根被重建（会话切换/布局）
			// 时自动断开重挂。
			function ensureRowObserver() {
				const root = findChatRoot();
				if (!root) return;
				if (rowObserver && observedRoot === root) return;
				if (rowObserver) { try { rowObserver.disconnect(); } catch (e) {} rowObserver = null; }
				observedRoot = root;
				rowObserver = new MutationObserver(() => {
					clearTimeout(rebuildTimer);
					rebuildTimer = setTimeout(syncOutline, 120);
				});
				rowObserver.observe(root, { childList: true, subtree: true });
			}
			// 占位条不算记录、点击不定位。
			function renderRows() {
				while (box.children.length) box.removeChild(box.lastChild);
				rows = [];
				if (!userMsgs.length) {
					const ph = document.createElement("div");
					ph.style.cssText = "flex:none;width:14px;height:2px;border-radius:1px;background:var(--dsw-alias-border-l3);opacity:.5;margin:0 4px";
					ph.title = "我的消息（等待新消息…）";
					box.appendChild(ph);
					updateExpanded(expanded);
					return;
				}
				userMsgs.forEach((m, i) => {
					const r = buildRow(m, i);
					box.appendChild(r.row);
					rows.push(r);
				});
				updateExpanded(expanded);
				applyActive();
			}

			// 构建一行：横杠 + 行号 + 文本（同一行垂直对齐；hover 整行变黑，点击变蓝）
			// m = { text, key }；key 是官方锚点（data-chat-anchor-key），点击用 key 定位。
			function buildRow(m, idx) {
				const text = m && m.text ? m.text : String(m || "");
				const key = m && m.key;
				const row = document.createElement("div");
				row.style.cssText = "display:flex;align-items:center;gap:8px;min-height:20px;padding:3px 4px;border-radius:6px;cursor:pointer;transition:background .12s ease";
				if (key) row.dataset.msgKey = key;
				const bar = document.createElement("div");
				bar.style.cssText = "flex:none;width:14px;height:2px;border-radius:1px;background:var(--dsw-alias-border-l3);transition:background .12s ease";
				const num = document.createElement("span");
				num.style.cssText = "flex:none;font-family:Consolas,monospace;font-size:12px;min-width:22px;text-align:right;color:var(--dsw-alias-label-tertiary);display:none";
				num.textContent = String(idx + 1);
				const txt = document.createElement("span");
				txt.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;color:var(--dsw-alias-label-secondary);font-size:14px";
				const short = text.length > 60 ? text.slice(0, 60) + "…" : text;
				txt.textContent = short;
				row.appendChild(bar);
				row.appendChild(num);
				row.appendChild(txt);
				// hover：整行变黑（横杠+文字）+ 更暗的行背景（15%，主 2026-08-17 定稿）
				row.addEventListener("mouseenter", () => {
					row.style.background = "color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent)";
					bar.style.background = "var(--dsw-alias-label-primary)";
					num.style.color = "var(--dsw-alias-label-primary)";
					txt.style.color = "var(--dsw-alias-label-primary)";
				});
				row.addEventListener("mouseleave", () => {
					row.style.background = "transparent";
					applyActive();
				});
				row.addEventListener("click", () => scrollToMessage(idx));
				return { row, bar, num, txt, idx };
			}

			// 颜色状态：点击选中 = 蓝（横杠+文字），其余 = 灰
			function applyActive() {
				for (const r of rows) {
					const on = r.idx === activeIdx;
					r.bar.style.background = on
						? "var(--dsw-alias-state-business-primary)"   // 点击选中 = 蓝
						: "var(--dsw-alias-border-l3)";               // 默认 = 灰
					r.num.style.color = on
						? "var(--dsw-alias-state-business-primary)"
						: "var(--dsw-alias-label-tertiary)";
					r.txt.style.color = on
						? "var(--dsw-alias-state-business-primary)"
						: "var(--dsw-alias-label-secondary)";
				}
			}

			// ---- hover 展开 / 收起（同一元素：横杠列 ↔ 完整大纲；只切样式不重建） ----
			// 收起：只显示横杠（行号/文字隐藏）；展开：bar+num+txt 全显示。
			// 用 mouseover/mouseout 冒泡（子元素都触发，热区可靠），收起态 min-width 保证可 hover。
			// num 显隐 = 展开 && 非"加载历史中"（加载时隐藏行号，完成再显示）
			let numHiddenByLoad = false;
			let savedScrollTop = null;   // 收起（鼠标离开）时的面板滚动位置，重新展开时原样还原
			let collapsedWin = null;     // 收起时的可见行窗口（展开面板当前视口），收起态按它显示 10 条
			// 捕获当前可见行窗口：以吸附到行边界的起点开始，恰好 10 条（与展开视口严格对应）
			function captureVisibleWindow() {
				if (!rows.length) return null;
				const rowH = rows[0].row.offsetHeight || 26;
				const start = Math.max(0, Math.min(rows.length - 1, Math.round(box.scrollTop / rowH)));
				const end = Math.min(rows.length - 1, start + 9);
				return { start, end, rowH };
			}
			function updateExpanded(on) {
				const wasExpanded = expanded;
				if (expanded && !on) {
					// 离开前记住：面板滚动位置 + 当前可见行窗口（收起态显示这 10 条，蓝条停在激活消息槽位）
					savedScrollTop = box.scrollTop;
					collapsedWin = captureVisibleWindow();
				}
				expanded = on;
				box.style.background = on
					? "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 96%, transparent)"
					: "transparent";
				box.style.borderColor = on ? "var(--dsw-alias-border-l2)" : "transparent";
				box.style.boxShadow = on ? "0 8px 24px rgba(0,0,0,.25)" : "none";
				box.style.backdropFilter = on ? "blur(8px)" : "none";
				box.style.width = on ? "320px" : "auto";
				box.style.minWidth = on ? "" : "30px";   // 收起态保证可 hover 热区
				box.style.overflowY = on ? "auto" : "hidden";   // 收起态无滚动条
				box.style.maxHeight = on ? "260px" : "";   // 收起态按内容自适应（10 条完整显示）
				// 收起态 = 展开面板当前视口的 10 条窗口（从未展开过则默认最近 10 条）；
				// 蓝条停在激活消息在窗口内的槽位（applyActive 上色）；展开态 = 全部行
				const winStart = collapsedWin ? collapsedWin.start : Math.max(0, userMsgs.length - 10);
				const winEnd = collapsedWin ? collapsedWin.end : userMsgs.length - 1;
				for (const r of rows) {
					const inWin = r.idx >= winStart && r.idx <= winEnd;
					r.row.style.display = (on || inWin) ? "flex" : "none";
					r.num.style.display = (on && !numHiddenByLoad) ? "" : "none";
					r.txt.style.display = on ? "" : "none";
				}
				// 只在"收起→展开"的瞬间还原上次离开时的滚动位置（不居中、不跳底部），
				// 并吸附到行边界（与 captureVisibleWindow 同一取整规则）——收起/展开的横杠严格对齐，不差半格
				if (on && !wasExpanded) {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							const rowH = collapsedWin ? collapsedWin.rowH : (rows.length ? rows[0].row.offsetHeight : 26);
							const target = savedScrollTop != null ? savedScrollTop : box.scrollHeight;
							box.scrollTop = Math.round(target / rowH) * rowH;
						});
					});
				}
			}
			box.addEventListener("mouseover", () => {
				// 菜单/设置面板打开时锁大纲，避免划过大纲横杠弹出遮挡操作（2026-08-27 主需求）
				if (window.__dshOutlineLock) return;
				updateExpanded(true);
			});
			box.addEventListener("mouseout", (e) => {
				if (!box.contains(e.relatedTarget)) updateExpanded(false);
			});

			// ---- 位置：对话区滚动容器左内缘+4（resize 时更新，不轮询） ----
			function placeOutline() {
				const root = findChatRoot();
				if (!root) return;
				const container = findScrollContainer(root) || root;
				try {
					const r = container.getBoundingClientRect();
					if (r.width > 0) {
						box.style.left = Math.max(0, r.left + 4) + "px";
						box.style.visibility = "visible";
					}
				} catch (e) {}
			}

			// ---- DOM 定位（data-chat-flow-kind="user" 第 n 行 = 第 n 条我的消息） ----
			// 2026-09-05 兼容 dsh 0.1.2-rc.1：新版 UI 把对话区滚动容器改为
			// [data-conversation-scroll]（旧 [data-slot="conversation"] 已移除），
			// 双选择器兼容新旧版；消息行锚点 data-chat-anchor-key 两版均保留。
			function findChatRoot() {
				return document.querySelector('[data-slot="conversation"]')
					|| document.querySelector('[data-conversation-scroll]');
			}
			function findScrollContainer(root) {
				const first = root.querySelector("[data-chat-flow-kind]");
				let cur = first ? first.parentElement : null;
				while (cur && cur !== document.body) {
					const s = getComputedStyle(cur);
					if (cur.scrollHeight > cur.clientHeight && /(auto|scroll|overlay)/.test(s.overflowY)) return cur;
					cur = cur.parentElement;
				}
				return null;
			}
			function scrollToMessage(userIndex) {
				activeIdx = userIndex;
				applyActive();
				const m = userMsgs[userIndex];
				if (!m) return;
				// 目标定位：outline 模式按轮号 data-chat-turn，DOM 兜底按官方 key 锚点
				const el = findTargetEl(m);
				if (el) { jumpTo(el); return; }
				// 目标不在 DOM（历史懒加载未载入）：设 pendingTarget，触发"加载更早"循环
				// 直到目标出现（syncOutline/afterSync 检查续推），20s 超时放弃
				pendingTarget = m;
				clearTimeout(pendingTimer);
				pendingTimer = setTimeout(() => { pendingTarget = null; }, 20000);
				maybeLoadOlder();
			}

			// 滚动到目标消息行（瞬间定位 + 黄色闪烁）
			function jumpTo(el) {
				if (!el) return;
				const root = findChatRoot();
				const container = root ? findScrollContainer(root) : null;
				if (container) {
					const cr = container.getBoundingClientRect();
					const tr = el.getBoundingClientRect();
					container.scrollTo({ top: container.scrollTop + tr.top - cr.top - 12 });
				} else {
					el.scrollIntoView({ block: "start" });
				}
				el.classList.add(OUTLINE_FLASH);
				setTimeout(() => el.classList.remove(OUTLINE_FLASH), 1600);
			}

			// ---- 数据刷新：会话切换订阅（会话切换即重扫；会话内新消息由 DOM 观察驱动） ----
			if (sessions.list && sessions.list.subscribe) {
				try { sessions.list.subscribe(() => rebind()); } catch (e) {}
			}
			rebind();
			// 等对话区渲染后定位 + 建立尺寸跟踪（2026-08-27 主需求：新客户端即时显示、侧边栏宽度变化跟随）
			ensureOutlineTracking();
			ensureRowObserver();
			syncOutline();
			// ---- 视口跟随：对话区滚动时同步 activeIdx（事件驱动+节流，非轮询；
			//      点跳转已在 scrollToMessage 里直接设 activeIdx） ----
			function syncActiveFromView() {
				const root = findChatRoot();
				const container = root ? findScrollContainer(root) : null;
				if (!container) return;
				const cr = container.getBoundingClientRect();
				if (cr.height <= 0) return;
				// 取对话区左侧偏中的一点做命中检测（避开左缘横杠/留白）
				const x = cr.left + Math.max(80, cr.width * 0.15);
				const y = cr.top + 48;
				const els = document.elementsFromPoint(x, y);
				for (const el of els) {
					const anc = el.closest ? el.closest('[data-chat-anchor-key]') : null;
					if (!anc) continue;
					let idx = -1;
					if (outlineMode === "outline") {
						// 轮模式：DOM 行带 data-chat-turn（轮号），命中即该轮大纲条目
						const turn = anc.getAttribute("data-chat-turn");
						if (turn != null) idx = userMsgs.findIndex(m => String(m.turn) === turn);
					} else {
						const key = anc.getAttribute("data-chat-anchor-key");
						if (key) idx = userMsgs.findIndex(m => m.key === key);
					}
					if (idx >= 0 && idx !== activeIdx) {
						activeIdx = idx;
						applyActive();
					}
					return;
				}
			}
			{
				const root = findChatRoot();
				const container = root ? findScrollContainer(root) : null;
				if (container) {
					let scrollTmr = null;
					container.addEventListener("scroll", () => {
						if (scrollTmr) return;
						scrollTmr = setTimeout(() => { scrollTmr = null; syncActiveFromView(); }, 300);
					}, { passive: true });
				}
			}
			window.addEventListener("resize", placeOutline);
			// 侧边栏宽度/布局变化 → 对话区尺寸变化 → 重定位横杠；对话区出现前用 MO 等待（2026-08-27 主需求）
			let outlineTracking = false;
			function ensureOutlineTracking() {
				const root = findChatRoot();
				if (!root) return false;
				if (!outlineTracking) {
					outlineTracking = true;
					try {
						const ro = new ResizeObserver(() => placeOutline());
						ro.observe(root);
						// 事件驱动：观察侧边栏根（宽度变化必然触发 RO → 重定位横杠）
						const sb = findSidebarRoot();
						if (sb) ro.observe(sb);
					} catch (e) {}
				}
				placeOutline();
				return true;
			}
			// 侧边栏根元素（含设置按钮，向上取 footArea.parentElement）
			function findSidebarRoot() {
				const btns = document.querySelectorAll("button");
				for (const b of btns) {
					const aria = (b.getAttribute("aria-label") || "").trim();
					const txt = (b.textContent || "").trim();
					if (aria === "设置" || aria === "Settings" || txt === "设置" || txt === "Settings") {
						const settingsArea = b.closest("div");
						const footArea = settingsArea ? settingsArea.parentElement : null;
						const root = footArea ? footArea.parentElement : null;
						if (root) return root;
					}
				}
				return null;
			}
			// MutationObserver 等待对话区出现后开始跟踪（也兜底对话区被重挂载：
			// 重挂后重挂行观察 + 重扫，保证大纲随对话区重建恢复）
			try {
				const trackMo = new MutationObserver(() => {
					ensureOutlineTracking();
					ensureRowObserver();
				});
				trackMo.observe(document.body, { childList: true, subtree: true });
			} catch (e) {}

			// ---- 定位高亮动画样式 ----
			if (!document.getElementById("dsh-msg-outline-style")) {
				const st = document.createElement("style");
				st.id = "dsh-msg-outline-style";
				st.textContent = "." + OUTLINE_FLASH + "{animation:dshOutlineFlash 1.6s ease 1}"
					+ "@keyframes dshOutlineFlash{0%,100%{background:transparent}15%,35%{background:rgba(255,200,0,.35)}}"
					// 菜单/设置面板打开（锁定态）时整体隐藏大纲横杠（2026-08-27 主需求）
					+ "body.dsh-outline-locked #" + OUTLINE_RAIL_ID + "{display:none !important}";
				document.head.appendChild(st);
			}

			document.body.appendChild(box);
		}

			// ---- dsh 版本更新提示（主 2026-08-19 需求：有新版时右下角提示） ----
			function checkDshUpdate() {
				fetch("http://127.0.0.1:3081/api/dsh-version", { mode: "cors" })
					.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
					.then((d) => {
						if (!d || !d.hasUpdate || !d.latest) return;
						try {
							if (localStorage.getItem("dsh-ignored-version") === d.latest) return;
						} catch (e) {}
						showUpdateToast(d.local, d.latest);
					})
					.catch(() => {});
			}
			function showUpdateToast(local, latest) {
				if (document.getElementById("dsh-update-toast")) return;
				const t = document.createElement("div");
				t.id = "dsh-update-toast";
				// 宽度与 Token HUD 一致（主 2026-08-19 要求）
				const hudEl = document.getElementById(HUD_ID);
				const hudW = hudEl ? hudEl.offsetWidth : 210;
				t.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:10px;padding:12px 14px;font:12px/1.7 -apple-system,'Segoe UI',sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25);width:" + hudW + "px;box-sizing:border-box";
				const status = document.createElement("div");
				status.style.cssText = "margin-top:6px;opacity:.85;white-space:pre-line";
				t.innerHTML = '<div style="color:var(--dsw-alias-state-business-primary);font-weight:700;margin-bottom:4px">⬆ dsh 有新版本</div>'
					+ '<div>当前 <b>' + (local || "?") + '</b> → 最新 <b>' + latest + '</b></div>';
				t.appendChild(status);
				const btns = document.createElement("div");
				btns.style.cssText = "margin-top:10px;display:flex;gap:8px;justify-content:flex-end";
				btns.innerHTML = '<button id="dsh-upd-later" style="background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 12px;cursor:pointer">稍后</button>'
					+ '<button id="dsh-upd-update" style="background:var(--dsw-alias-state-business-primary);color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;font-weight:600">更新</button>';
				t.appendChild(btns);
				document.body.appendChild(t);
				t.querySelector("#dsh-upd-later").onclick = () => t.remove();
				t.querySelector("#dsh-upd-update").onclick = () => {
					const btn = t.querySelector("#dsh-upd-update");
					btn.disabled = true;
					btn.textContent = "更新中…";
					status.textContent = "正在安装 @deepseek-ai/dsh，请稍候…";
					fetch("http://127.0.0.1:3081/api/dsh-update", { method: "POST", mode: "cors" })
						.then((r) => r.json())
						.then((d) => {
							if (d && d.ok) {
								if (d.restarted) {
									status.textContent = "✅ 已更新到 " + (d.local || "最新版") + "，服务已重启，页面即将刷新…";
									btn.style.display = "none";
									setTimeout(() => location.reload(), 1800);
								} else {
									status.textContent = "✅ 已更新到 " + (d.local || "最新版") + "\n正在打开终端执行 sudo 重启…";
									btn.style.display = "none";
									typeSudoRestart(status);
								}
							} else {
								status.textContent = "❌ 更新失败：" + ((d && d.error) || "未知错误") + "\n可手动执行：npm install -g @deepseek-ai/dsh";
								btn.textContent = "重试";
								btn.disabled = false;
							}
						})
						.catch((e) => {
							status.textContent = "❌ 更新失败：" + (e && e.message ? e.message : "网络/服务异常") + "\n可手动执行：npm install -g @deepseek-ai/dsh";
							btn.textContent = "重试";
							btn.disabled = false;
						});
				};
			}
			// 打开终端面板并预输入 sudo 重启命令（主 2026-08-19 要求：等用户在终端输 sudo 密码）
			function typeSudoRestart(statusEl) {
				ensureTerminal(termState, termHost);
				openPanel(TERM_PANEL_ID);
				let tries = 0;
				const timer = setInterval(() => {
					const s = window.__dshTermState;
					tries++;
					if (s && s.term && s.ws && s.ws.readyState === WebSocket.OPEN) {
						clearInterval(timer);
						s.term.paste("sudo systemctl restart dsh-web");
						// 回车走 WS 直发（paste 会包 bracketed paste 包装，\r 变普通字符不执行；主 2026-08-19 实测少回车）
						setTimeout(() => {
							const st = window.__dshTermState;
							if (st && st.ws && st.ws.readyState === WebSocket.OPEN) st.ws.send("\r");
						}, 250);
						if (statusEl) statusEl.textContent += "\n请在终端输入 sudo 密码…";
						// 2026-08-20 主要求：手动重启完成后自动刷新页面。
						// 轮询版本接口：hasUpdate 变 false（本地=最新，更新已生效）且 dsh-web 页面可访问时自动刷新；
						// 轮询 3081（独立进程，dsh-web 重启不影响），超时 6 分钟停止等待。
						let pollTries = 0;
						const pollTimer = setInterval(() => {
							pollTries++;
							fetch("http://127.0.0.1:3081/api/dsh-version", { mode: "cors" })
								.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
								.then((d) => {
									if (d && d.local && d.latest && !d.hasUpdate) {
										fetch(location.origin + "/", { cache: "no-store" })
											.then((r) => {
												if (r.ok) {
													clearInterval(pollTimer);
													if (statusEl) statusEl.textContent += "\n✅ 更新已生效，页面即将刷新…";
													setTimeout(() => location.reload(), 1200);
												}
											})
											.catch(() => {});
									} else if (pollTries > 120) {
										clearInterval(pollTimer);
										if (statusEl) statusEl.textContent += "\n⏳ 等待超时，请手动刷新页面";
									}
								})
								.catch(() => {});
						}, 3000);
					} else if (tries > 40) {
						clearInterval(timer);
						if (statusEl) statusEl.textContent += "\n⚠ 终端未就绪，请手动执行：sudo systemctl restart dsh-web";
					}
				}, 300);
			}
			setTimeout(checkDshUpdate, 2500);

exports.apply = apply;
		exports.inject = ["connection", "sessions", "workspaces", "slots"];
		return module.exports;
	}
});
