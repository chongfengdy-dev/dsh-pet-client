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

			// ---------- 缩放比例浮标（Ctrl+滚轮/键盘缩放时屏幕中央提示） ----------
			buildZoomHud();

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
				transform: "translateY(-50%)", zIndex: "99989",
				display: "flex", flexDirection: "column", gap: "5px",
				padding: "6px", borderRadius: "10px",
				background: "transparent", border: "1px solid transparent",
				cursor: "pointer",
				transition: "background .15s ease, border-color .15s ease",
				maxHeight: "300px", overflowY: "auto",
				fontSize: "14px",
				visibility: "hidden", // 定位到对话区左内缘前不显示
			});

			// ---- 状态 ----
			let sessionId = null;
			let binding = null;      // { session: { getSnapshot, subscribe } }
			let unsubscribe = null;  // 当前会话订阅退订函数（会话切换时释放）
			let userMsgs = [];       // string[]（我的消息首行文本，服务端持久化）
			let activeIdx = -1;      // 当前点击/选中的消息下标（-1=无，横杠+文字变蓝）
			let rows = [];           // {row, bar, num, txt, idx} 行引用（颜色状态更新用）
			let expanded = false;    // 是否展开（平时只显示横杠，hover 展开显示行号+文本）
			const OUTLINE_HISTORY_URL = "http://127.0.0.1:3081/api/outline-history";

			// 持久化：服务端文件（3081，跨重启保留——WebView2 localStorage 受缓存目录
			// 影响不可靠，主定稿走服务端，关机也能找回来）。加载异步：先本地渲染已有，
			// 服务端返回后补齐（防止重启后丢失）；保存节流，来一条写一条。
			let loadTimer = null;
			function loadStored(sid, cb) {
				fetch(OUTLINE_HISTORY_URL + "?sessionId=" + encodeURIComponent(sid), { mode: "cors" })
					.then((r) => r.json())
					.then((data) => { cb(Array.isArray(data.list) ? data.list : []); })
					.catch(() => { cb([]); });
			}
			let saveTimer = null;
			function saveStored(sid) {
				clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					try {
						fetch(OUTLINE_HISTORY_URL, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ sessionId: sid, list: userMsgs }),
							mode: "cors",
						}).catch(() => {});
					} catch (e) {}
				}, 300);
			}

			function currentSessionId() {
				const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
				return snap && snap.current !== undefined ? snap.current : null;
			}

			function rebind() {
				const sid = currentSessionId();
				if (sid === sessionId && binding) return;
				// 会话切换：退订旧会话订阅，重新绑定新会话（记录按会话持久化）
				if (unsubscribe) { try { unsubscribe(); } catch (e) {} unsubscribe = null; }
				sessionId = sid;
				if (sid === null) { binding = null; userMsgs = []; rows = []; renderRows(); return; }
				userMsgs = [];
				rows = [];
				try { binding = sessions.binding(sid); } catch (e) { binding = null; }
				if (binding && binding.session && binding.session.subscribe) {
					try { unsubscribe = binding.session.subscribe(onSessionEvent); } catch (e) {}
				}
				renderRows();
				// 从服务端恢复该会话历史（关机重启也能找回）
				loadStored(sid, (list) => {
					if (sid !== sessionId) return; // 已切走，忽略
					if (!list.length) return;
					// 服务端有记录：合并（跳过已存在的），补齐渲染
					let added = false;
					for (const t of list) {
						if (userMsgs.includes(t)) continue;
						userMsgs.push(t);
						const r = buildRow(t, userMsgs.length - 1);
						box.appendChild(r.row);
						rows.push(r);
						added = true;
					}
					if (added) { updateExpanded(expanded); applyActive(); }
					// 服务端记录补齐后再同步快照增量
					onSessionEvent();
				});
			}

			// 事件驱动：订阅回调 → 读快照 → 与已记录对比，只 append 更新的消息。
			// 锚点 = 已记录条数；快照 user 消息数更多 → 尾部新增（新消息总是 append 在尾部）。
			// 无论有无新增都重建索引（持久化记录可能比 compaction 后快照多，提前 return 会漏建索引）。
			function onSessionEvent() {
				if (!binding || !binding.session) return;
				let snapList = [];
				try {
					snapList = collectUserMessages(binding.session.getSnapshot());
				} catch (e) { return; }
				if (snapList.length > userMsgs.length) {
					// 从已记录位置起 append 新增
					for (let i = userMsgs.length; i < snapList.length; i++) {
						appendRow(snapList[i]);
					}
				}
				rebuildRowMap();
			}

			// 文本 → DOM user 行号索引：数据/DOM 变化时重建（点击时 O(1) 查表，不遍历）
			let rowMap = {};
			let cachedEls = [];
			let rowObserver = null;
			let pendingTarget = null;   // 懒加载定位目标：点击后等待"加载更早"把目标加载进 DOM
			let lastLoadClick = 0;      // 触发"加载更早"节流
			let pendingTimer = null;    // 定位超时保护
			function rebuildRowMap() {
				rowMap = {};
				const root = findChatRoot();
				if (!root) return;
				cachedEls = Array.from(root.querySelectorAll('[data-chat-flow-kind="user"]'));
				cachedEls.forEach((e, i) => {
					const t = (e.textContent || "").trim().split("\n", 1)[0] || "";
					if (t) rowMap[t] = i;
				});
				// 懒加载定位：目标刚被加载出来 → 立即定位
				if (pendingTarget && rowMap[pendingTarget] !== undefined) {
					const el = cachedEls[rowMap[pendingTarget]];
					pendingTarget = null;
					clearTimeout(pendingTimer);
					if (el) jumpTo(el);
					return;
				}
				// 目标还没出现 → 继续触发"加载更早"（有更早按钮且非加载中）
				if (pendingTarget) maybeLoadOlder();
			}
			// 触发对话区"加载更早"（懒加载历史）：优先走官方 binding.session.loadOlder()
			// 编程式分页加载（dsh 官方 ChatView 按钮同机制），节流防止连点。
			function maybeLoadOlder() {
				if (binding && binding.session && typeof binding.session.loadOlder === "function") {
					const now = Date.now();
					if (now - lastLoadClick < 600) return;
					lastLoadClick = now;
					try { binding.session.loadOlder().catch(() => {}); } catch (e) {}
					return;
				}
				// 兜底：模拟点击"加载更早"按钮
				const root = findChatRoot();
				if (!root) return;
				const btn = root.querySelector('button[type="button"]');
				if (!btn || btn.disabled) return;
				const label = (btn.textContent || "").trim();
				if (label !== "加载更早" && label !== "Load earlier") return;
				const now = Date.now();
				if (now - lastLoadClick < 600) return;
				lastLoadClick = now;
				btn.click();
			}
			// 监听对话区 DOM 变化（新消息渲染 / 点击"加载更早"加载历史 / compaction 重建），
			// 变化即重建索引（防抖），保证横杠点击总能找到最新行号。
			function ensureRowObserver() {
				const root = findChatRoot();
				if (!root || rowObserver) return;
				rowObserver = new MutationObserver(() => {
					clearTimeout(rebuildTimer);
					rebuildTimer = setTimeout(rebuildRowMap, 150);
				});
				rowObserver.observe(root, { childList: true, subtree: true });
			}
			let rebuildTimer = null;

			function collectUserMessages(snap) {
				const out = [];
				const nodes = snap && snap.nodes;
				if (!Array.isArray(nodes)) return out;
				for (const node of nodes) {
					if (node.kind !== "user" && node.kind !== "steering") continue;
					const blocks = node.content || node.blocks || [];
					let text = "";
					for (const b of blocks) {
						if ((b.type === "text" || b.kind === "text") && typeof b.text === "string") {
							text += b.text + "\n";
						}
					}
					const t = text.trim().split("\n", 1)[0] || "";
					if (t) out.push(t);
				}
				return out;
			}

			// 追加一行记录（来一条记一条），并持久化
			function appendRow(text) {
				userMsgs.push(text);
				const r = buildRow(text, userMsgs.length - 1);
				box.appendChild(r.row);
				rows.push(r);
				saveStored(sessionId);
				updateExpanded(expanded);
				applyActive();
			}

			function collectUserMessages(snap) {
				const out = [];
				const nodes = snap && snap.nodes;
				if (!Array.isArray(nodes)) return out;
				for (const node of nodes) {
					if (node.kind !== "user" && node.kind !== "steering") continue;
					const blocks = node.content || node.blocks || [];
					let text = "";
					for (const b of blocks) {
						if ((b.type === "text" || b.kind === "text") && typeof b.text === "string") {
							text += b.text + "\n";
						}
					}
					const t = text.trim().split("\n", 1)[0] || "";
					if (t) out.push(t);
				}
				return out;
			}

			// 渲染全部行（展开时全部显示+滚动条；收起时只显示最近 10 条横杠，见 updateExpanded）
			// 空状态（开会话还没收到新消息）：显示一条占位横杠，保证导航条可见可 hover，
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
				userMsgs.forEach((text, i) => {
					const r = buildRow(text, i);
					box.appendChild(r.row);
					rows.push(r);
				});
				updateExpanded(expanded);
				applyActive();
			}

			// 构建一行：横杠 + 行号 + 文本（同一行垂直对齐；hover 整行变黑，点击变蓝）
			function buildRow(text, idx) {
				const row = document.createElement("div");
				row.style.cssText = "display:flex;align-items:center;gap:8px;min-height:20px;padding:0 4px;border-radius:6px;cursor:pointer;transition:background .12s ease";
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
				// hover：整行变黑（横杠+文字）
				row.addEventListener("mouseenter", () => {
					row.style.background = "var(--dsw-alias-interactive-bg-hover)";
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
			function updateExpanded(on) {
				expanded = on;
				box.style.background = on
					? "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 96%, transparent)"
					: "transparent";
				box.style.borderColor = on ? "var(--dsw-alias-border-l2)" : "transparent";
				box.style.boxShadow = on ? "0 8px 24px rgba(0,0,0,.25)" : "none";
				box.style.backdropFilter = on ? "blur(8px)" : "none";
				box.style.width = on ? "320px" : "auto";
				box.style.minWidth = on ? "" : "30px";   // 收起态保证可 hover 热区
				for (const r of rows) {
					const recent = userMsgs.length - r.idx <= 10;   // 最近 10 条
					r.row.style.display = (on || recent) ? "flex" : "none";
					r.num.style.display = on ? "" : "none";
					r.txt.style.display = on ? "" : "none";
				}
			}
			box.addEventListener("mouseover", () => updateExpanded(true));
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
			function findChatRoot() {
				return document.querySelector('[data-slot="conversation"]');
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
				const text = userMsgs[userIndex];
				if (!text) return;
				// 索引查表定位（数据变化时已重建 rowMap）：O(1) 取 DOM 行号，不遍历。
				const row = rowMap[text];
				if (row !== undefined && cachedEls[row]) { jumpTo(cachedEls[row]); return; }
				// 目标不在 DOM（对话区懒加载，"加载更早"的历史还没加载）：
				// 设 pendingTarget，触发"加载更早"循环直到目标出现（rebuildRowMap 里续推）
				pendingTarget = text;
				clearTimeout(pendingTimer);
				pendingTimer = setTimeout(() => { pendingTarget = null; }, 15000); // 15s 超时放弃
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

			// ---- 数据刷新：会话切换订阅（无轮询，来一条加一条由订阅驱动） ----
			if (sessions.list && sessions.list.subscribe) {
				try { sessions.list.subscribe(() => rebind()); } catch (e) {}
			}
			rebind();
			placeOutline();
			ensureRowObserver();
			rebuildRowMap();
			window.addEventListener("resize", placeOutline);

			// ---- 定位高亮动画样式 ----
			if (!document.getElementById("dsh-msg-outline-style")) {
				const st = document.createElement("style");
				st.id = "dsh-msg-outline-style";
				st.textContent = "." + OUTLINE_FLASH + "{animation:dshOutlineFlash 1.6s ease 1}"
					+ "@keyframes dshOutlineFlash{0%,100%{background:transparent}15%,35%{background:rgba(255,200,0,.35)}}";
				document.head.appendChild(st);
			}

			document.body.appendChild(box);
		}

exports.apply = apply;
		exports.inject = ["connection", "sessions"];
		return module.exports;
	}
});
