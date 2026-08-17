window.__ModuleLoader__.load({
	id: "dsh-term-panels",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

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

		function apply(ctx) {
			const connection = ctx.connection;
			if (document.getElementById(DOCK_ID)) return; // 已注入

			// ---------- 右侧悬浮按钮块（终端） ----------
			const dock = document.createElement("div");
			dock.id = DOCK_ID;
			Object.assign(dock.style, {
				position: "fixed", right: "12px", top: "50%",
				transform: "translateY(-50%)", zIndex: "99990",
				display: "flex", flexDirection: "column", gap: "10px",
			});
			const btnTerm = dockButton(">_", "打开终端");
			dock.appendChild(btnTerm);
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
			const termHost = document.createElement("div");
			termHost.id = TERM_HOST_ID;
			Object.assign(termHost.style, {
				flex: "1", minHeight: "0", position: "relative", overflow: "hidden",
			});
			termPanel.body.appendChild(termHost);
			document.body.appendChild(termPanel.root);
			// 懒初始化终端（首次打开时加载 xterm.js + 建实例 + 连 WS，之后保持会话）
			const termState = { term: null, fit: null, ws: null, initStarted: false };
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
			btnTerm.addEventListener("click", (e) => {
				e.stopPropagation();
				if (termPanel.root.style.display === "none") {
					ensureTerminal(termState, termHost);
					openPanel(TERM_PANEL_ID);
				} else {
					closePanel(TERM_PANEL_ID);
				}
			});
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
			setInterval(() => refreshBalance(hud, hudState), 120000); // 余额 2 分钟刷新

			// ---------- 左侧历史会话栏（DeepSeek 网页版样式） ----------
			buildHistoryBar(ctx);
			// sessions 服务可能晚于本插件注册（cordis 启动顺序），延迟重试一次
			setTimeout(() => buildHistoryBar(ctx), 1500);
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
		function dockButton(label, title) {
			const b = document.createElement("button");
			b.title = title;
			Object.assign(b.style, {
				width: "44px", height: "44px", borderRadius: "12px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
				color: "var(--dsw-alias-label-primary)", fontSize: "16px",
				fontFamily: 'Consolas, monospace',
				cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,.25)",
				transition: "background .12s, transform .12s",
			});
			b.addEventListener("mouseenter", () => {
				b.style.background = "var(--dsw-alias-interactive-bg-hover)";
				b.style.transform = "scale(1.06)";
			});
			b.addEventListener("mouseleave", () => {
				b.style.background = "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))";
				b.style.transform = "scale(1)";
			});
			b.textContent = label;
			return b;
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
				// 容器透明 + 轻微模糊（4px）：自定义背景色半透明 + 透出内容带一点磨砂
				background: "transparent",
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
			let s = { bg: "#0d1117", alpha: 60, fontSize: 16, fontIdx: 0, bgImage: "", bgImageAlpha: 100 };
			try {
				const raw = JSON.parse(localStorage.getItem(TERM_SETTINGS_KEY) || "null");
				if (raw) {
					if (typeof raw.bg === "string") s.bg = raw.bg;
					if (typeof raw.alpha === "number") s.alpha = raw.alpha;
					if (typeof raw.fontSize === "number") s.fontSize = raw.fontSize;
					if (typeof raw.fontIdx === "number") s.fontIdx = raw.fontIdx;
					if (typeof raw.bgImage === "string") s.bgImage = raw.bgImage;
					if (typeof raw.bgImageAlpha === "number") s.bgImageAlpha = raw.bgImageAlpha;
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

		// ---------- Token HUD（常驻右上角） ----------
		function buildHud() {
			const root = document.createElement("div");
			root.id = HUD_ID;
			Object.assign(root.style, {
				position: "fixed", top: "14px", right: "14px", zIndex: "99992",
				minWidth: "190px", padding: "10px 12px",
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
			const row = (label, value, cost, valueColor) => {
				const d = document.createElement("div");
				Object.assign(d.style, {
					display: "grid",
					gridTemplateColumns: "1fr auto auto",
					columnGap: "10px",
					alignItems: "baseline",
				});
				const l = document.createElement("span");
				l.style.color = "var(--dsw-alias-label-tertiary)";
				l.textContent = label;
				const v = document.createElement("span");
				v.style.fontFamily = 'Consolas, monospace';
				v.style.color = valueColor || "var(--dsw-alias-label-primary)";
				v.style.textAlign = "right";
				v.textContent = value;
				const c = document.createElement("span");
				c.style.fontFamily = 'Consolas, monospace';
				c.style.color = "var(--dsw-alias-label-primary)";
				c.style.textAlign = "right";
				c.style.minWidth = "52px";
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
			hud.grid.appendChild(row("花费", "—", state.cost !== null ? "¥" + state.cost.toFixed(2) : "—"));
			hud.grid.appendChild(row("余额", "—", state.balance !== null ? "¥" + state.balance : "…"));
		}
		function fmt(n) {
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(n);
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

		// ========== 左侧历史会话栏（DeepSeek 网页版样式） ==========
		// 2026-08-17 主定稿：位置=左侧悬浮（工作区右侧/对话框左侧中间空间）；
		// 交互参考 DeepSeek 网页版——hover 会话项显示该会话我发送的消息（一条一条），
		// 当前会话蓝色、其余灰色、hover 灰变黑；按天分组（今天/昨天/更早），
		// 昨天以前的折叠可点开；点击会话项切换会话（sessions.open）。
		const HIST_DOCK_ID = "dsh-panels-hist-dock";
		const HIST_PANEL_ID = "dsh-panels-hist-panel";
		const HIST_HOVER_ID = "dsh-panels-hist-hover";

		function buildHistoryBar(ctx) {
			const connection = ctx.connection;
			// sessions 服务：优先 ctx.sessions（inject 注入），兜底 ctx.get（dsh-client-runtime
			// 注册的服务，cordis 标准读取；不依赖 boot manifest 的 inject 声明，避免改 package.json
			// 后需重启 dsh web 才生效）
			const sessions = ctx.sessions || (ctx.get ? ctx.get("sessions") : undefined);
			if (!connection || !sessions) return;
			if (document.getElementById(HIST_DOCK_ID)) return; // 已注入

			// ---- 左侧 dock 按钮（☰） ----
			const dock = document.createElement("button");
			dock.id = HIST_DOCK_ID;
			dock.textContent = "☰";
			dock.title = "历史会话";
			Object.assign(dock.style, {
				position: "fixed", left: "10px", top: "50%",
				transform: "translateY(-50%)", zIndex: "99990",
				width: "44px", height: "44px", borderRadius: "12px",
				border: "1px solid var(--dsw-alias-border-l2)",
				cursor: "pointer",
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 30%, transparent)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "18px",
				display: "flex", alignItems: "center", justifyContent: "center",
				backdropFilter: "blur(4px)",
				boxShadow: "0 4px 16px rgba(0,0,0,.22)",
			});

			// ---- 左侧面板 ----
			const panel = document.createElement("div");
			panel.id = HIST_PANEL_ID;
			Object.assign(panel.style, {
				position: "fixed", left: "12px", top: "50%",
				transform: "translateY(-50%)", zIndex: "99991",
				width: "250px", maxHeight: "72vh",
				display: "flex", flexDirection: "column",
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 92%, transparent)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "12px",
				boxShadow: "0 8px 24px rgba(0,0,0,.25)",
				backdropFilter: "blur(8px)",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: 'system-ui, "Segoe UI", sans-serif',
				fontSize: "12px",
			});
			panel.hidden = true;

			// 头部
			const head = document.createElement("div");
			Object.assign(head.style, {
				display: "flex", justifyContent: "space-between", alignItems: "center",
				padding: "10px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)",
			});
			const headTitle = document.createElement("span");
			headTitle.style.cssText = "font-weight:600;font-size:12px";
			headTitle.textContent = "历史会话";
			const closeBtn = document.createElement("button");
			closeBtn.textContent = "✕";
			Object.assign(closeBtn.style, {
				border: "none", background: "transparent", cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)", fontSize: "13px",
				padding: "2px 6px", borderRadius: "6px",
			});
			closeBtn.onmouseover = () => { closeBtn.style.background = "var(--dsw-alias-interactive-bg-hover)"; };
			closeBtn.onmouseout = () => { closeBtn.style.background = "transparent"; };
			head.appendChild(headTitle);
			head.appendChild(closeBtn);

			// 列表容器
			const listEl = document.createElement("div");
			Object.assign(listEl.style, { overflowY: "auto", padding: "6px", flex: "1" });

			panel.appendChild(head);
			panel.appendChild(listEl);

			// ---- hover 浮层（显示该会话我发送的消息） ----
			const hover = document.createElement("div");
			hover.id = HIST_HOVER_ID;
			Object.assign(hover.style, {
				position: "fixed", zIndex: "99995", display: "none",
				minWidth: "220px", maxWidth: "320px", maxHeight: "60vh",
				overflowY: "auto", padding: "10px 12px",
				background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 96%, transparent)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				boxShadow: "0 8px 24px rgba(0,0,0,.25)",
				backdropFilter: "blur(8px)",
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px", lineHeight: "1.5",
				pointerEvents: "none",
			});

			// ---- 状态 ----
			let sessionsCache = [];    // [{sessionId, title, updatedAt, running, blank}]
			let currentId = null;
			let hoverTimer = null;
			let hoverShown = null;     // 当前浮层绑定的会话 id
			const msgCache = new Map(); // sessionId -> string[]

			function histLabel(ms) {
				const now = new Date(), d = new Date(ms);
				const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
				const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
				const diff = Math.round((today0 - day0) / 86400000);
				if (diff === 0) return { g: "today", t: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
				if (diff === 1) return { g: "yesterday", t: "昨天" };
				return { g: "earlier", t: `${d.getMonth() + 1}月${d.getDate()}日` };
			}

			function itemTitle(it) {
				const t = it.title || it.displayTitle;
				if (t && String(t).trim()) return String(t).trim();
				if (it.cwd) return String(it.cwd).split(/[\\/]/).pop();
				return "新会话";
			}

			async function refreshList() {
				try {
					const { result } = await connection.api.sessions.list({});
					if (!result || !result.ok) return;
					sessionsCache = (result.value && result.value.items) || [];
					const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
					currentId = (snap && snap.current) || null;
					renderList();
				} catch (e) {}
			}

			function renderList() {
				listEl.textContent = "";
				if (!sessionsCache.length) {
					const empty = document.createElement("div");
					empty.style.cssText = "padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary)";
					empty.textContent = "暂无会话";
					listEl.appendChild(empty);
					return;
				}
				const groups = { today: [], yesterday: [], earlier: [] };
				for (const it of sessionsCache) {
					const { g } = histLabel(typeof it.updatedAt === "number" ? it.updatedAt : Date.now());
					groups[g].push(it);
				}
				let earlierOpen = false;
				const groupMeta = [
					{ key: "today", label: "今天" },
					{ key: "yesterday", label: "昨天" },
					{ key: "earlier", label: "更早", collapsible: true },
				];
				for (const meta of groupMeta) {
					const items = groups[meta.key];
					if (!items.length) continue;
					const gTitle = document.createElement("div");
					Object.assign(gTitle.style, {
						padding: "6px 8px 2px", fontSize: "11px",
						color: "var(--dsw-alias-label-tertiary)",
						cursor: "default", userSelect: "none",
					});
					gTitle.textContent = meta.label;
					if (meta.collapsible) {
						gTitle.textContent += earlierOpen ? " ▾" : " ▸";
						gTitle.style.cursor = "pointer";
						gTitle.onclick = (e) => {
							e.stopPropagation();
							earlierOpen = !earlierOpen;
							renderList();
						};
					}
					listEl.appendChild(gTitle);
					if (meta.key === "earlier" && !earlierOpen) continue;
					for (const it of items) listEl.appendChild(buildItem(it));
				}
			}

			function buildItem(it) {
				const el = document.createElement("div");
				const isCurrent = it.sessionId === currentId;
				Object.assign(el.style, {
					display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px",
					padding: "7px 9px", borderRadius: "8px", cursor: "pointer",
					marginBottom: "2px",
					color: isCurrent ? "var(--dsw-alias-label-primary-foreground)" : "var(--dsw-alias-label-secondary)",
					background: isCurrent ? "var(--dsw-alias-brand-primary)" : "transparent",
					fontWeight: isCurrent ? "600" : "400",
				});
				const name = document.createElement("span");
				name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
				name.textContent = itemTitle(it);
				name.title = name.textContent;
				const tm = document.createElement("span");
				tm.style.cssText = "flex:none;font-size:10px;opacity:.75";
				const { t } = histLabel(typeof it.updatedAt === "number" ? it.updatedAt : Date.now());
				tm.textContent = t;
				el.appendChild(name);
				el.appendChild(tm);

				el.addEventListener("mouseenter", (e) => {
					if (!isCurrent) el.style.background = "var(--dsw-alias-interactive-bg-hover)";
					clearTimeout(hoverTimer);
					hoverTimer = setTimeout(() => showHover(it.sessionId, el), 350);
				});
				el.addEventListener("mouseleave", () => {
					if (!isCurrent) el.style.background = "transparent";
					clearTimeout(hoverTimer);
					hideHover();
				});
				el.addEventListener("click", () => {
					if (it.sessionId === currentId) return;
					try { sessions.open(it.sessionId); } catch (e) {}
				});
				return el;
			}

			async function loadMyMessages(sessionId) {
				if (msgCache.has(sessionId)) return msgCache.get(sessionId);
				try {
					const { result } = await connection.api.sessions.history({ sessionId });
					if (!result || !result.ok) return [];
					const msgs = [];
					for (const entry of (result.value && result.value.events) || []) {
						const ev = entry && (entry.event || entry);
						if (!ev || ev.type !== "user/message") continue;
						const dd = ev.data || {};
						let text = dd.text;
						if (typeof text !== "string" || !text.trim()) {
							const msg = dd.message || {};
							text = typeof msg.text === "string" ? msg.text : "";
						}
						if (typeof text === "string" && text.trim()) msgs.push(text.trim());
					}
					msgCache.set(sessionId, msgs);
					return msgs;
				} catch (e) { return []; }
			}

			function positionHover(anchorEl) {
				const r = anchorEl.getBoundingClientRect();
				let left = r.right + 10;
				let top = r.top;
				if (left + 320 > window.innerWidth) left = r.left - 330;
				if (top + 400 > window.innerHeight) top = Math.max(8, window.innerHeight - 420);
				hover.style.left = left + "px";
				hover.style.top = top + "px";
			}

			function hideHover() {
				hoverShown = null;
				hover.style.display = "none";
			}

			async function showHover(sessionId, anchorEl) {
				hideHover();
				hoverShown = sessionId;
				hover.textContent = "加载中…";
				hover.style.display = "block";
				positionHover(anchorEl);
				const msgs = await loadMyMessages(sessionId);
				if (hoverShown !== sessionId) return; // 已移开
				hover.textContent = "";
				if (!msgs.length) {
					hover.textContent = "（该会话暂无我的消息）";
					return;
				}
				const cap = document.createElement("div");
				cap.style.cssText = "font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px;font-weight:600";
				cap.textContent = `我发送的消息（${msgs.length}）`;
				hover.appendChild(cap);
				for (const m of msgs) {
					const line = document.createElement("div");
					line.style.cssText = "margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-word";
					line.textContent = m.length > 200 ? m.slice(0, 200) + "…" : m;
					hover.appendChild(line);
				}
			}

			function toggle() {
				if (panel.hidden) {
					panel.hidden = false;
					refreshList();
					if (sessions.list && sessions.list.subscribe) {
						try { sessions.list.subscribe(() => refreshList()); } catch (e) {}
					}
				} else {
					panel.hidden = true;
					hideHover();
				}
			}

			dock.addEventListener("click", toggle);
			closeBtn.addEventListener("click", () => { panel.hidden = true; hideHover(); });

			// 点击外部收起
			document.addEventListener("click", (e) => {
				if (panel.hidden) return;
				const t = e.target;
				if (!t.closest) return;
				if (t.closest("#" + HIST_PANEL_ID) || t.closest("#" + HIST_DOCK_ID)) return;
				panel.hidden = true;
				hideHover();
			});

			// 面板打开时轮询刷新
			setInterval(() => { if (!panel.hidden) refreshList(); }, 30000);

			document.body.appendChild(dock);
			document.body.appendChild(panel);
			document.body.appendChild(hover);
		}

		exports.apply = apply;
		exports.inject = ["connection", "sessions"];
		return module.exports;
	}
});
