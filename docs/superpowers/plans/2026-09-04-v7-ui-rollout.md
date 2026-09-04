# V7.4 UI Rollout Implementation Plan（两仓）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已封版的设计稿（`toolfront-design/mockups/v7-final-all-pages.html` + `toolfront-design/UI-SPEC.md`）把 toolfront（主站）与 toolfront-monitor（认证/工作台）升级到 V7.4：后端三层缓存根修 compare 慢、compare 先到先画、Rankings 新页、Report 升级、monitor 三页（Login/Signup/Dashboard）V6.4 皮肤、全站双语。

**Architecture:** toolfront 是单个 Cloudflare Worker（worker.js + public/*.html 静态页 + D1 SCAN_DB + KV）；monitor 是独立 Worker（src/*.ts + D1 DB + Resend）。分层缓存改在 `scanPublicReport()`；compare 先到先画是纯前端改造（拆两个并行 /api/scan）；Rankings 新页复用 monitor 已公开的 `/api/rankings`；monitor 三页改 `monitor-pages.ts` 的 `loginPage/signupPage/panelPage`。

**Tech Stack:** Cloudflare Workers (ESM)、D1、KV、 vanilla JS 前端（无框架）、自托管字体（fonts.css 机制已有）、双语（toolfront 现无 i18n 层——新建轻量 PAIRS/TreeWalker 方案，monitor 已有 I18N_EN 机制——增量词条）。

**Spec:** `toolfront-design/UI-SPEC.md`（公开版）+ `toolfront-design/mockups/v7-final-all-pages.html`（交互稿）+ `toolfront-cfg/competitive-benchmark/UI-DESIGN-SPEC-internal.md`（内部对照，仅供执行者理解意图，禁止将其内容带入任何 PUBLIC 仓）。

## Global Constraints

- **PUBLIC 仓（toolfront）纪律**：commit message / PR / 代码注释 / 文案 **不出现任何竞品名**，写"行业惯例/参考设计稿 v7"
- 部署门槛：本地预览用户确认 → secret-scan + UI 回归双门禁 → commit → PR → **用户人工合并** → 部署
- 视觉 token（V6.4）：`--paper:#FCFCFD --ink:#16181D --accent:#2F5FE0`；标题 sans 700；mono 仅数据数字；衬线仅 grade 锚
- 双语：EN/ZH 全覆盖，类目术语（WebMCP、llms.txt）保留英文
- 字体：只用 toolfront-design/fonts 自托管五款，禁止引入第三方字体
- 测试基线：toolfront `npm test`（现全绿）与 monitor `npm test`（42/42）不得回归

## Out of Scope（本期不做，诚实记录）

- Scanner 首页整体结构改版（转化入口，风险大，单独 plan；本期只对齐 token/导航）
- Readiness profiles 四视角（需评分引擎新增 profile 概念，依赖引擎，单独 plan）
- 用户上传头像/团队协作等 V7 稿未包含项

---

### Phase 1：后端三层缓存（toolfront，根修 compare 7.2s）

**Files:**
- Modify: `toolfront/worker.js`（`scanPublicReport()`，~line 1228）
- Test: `toolfront/tests/cache-tier.test.mjs`（新建，mock env）

**Interfaces:**
- Produces: `scanPublicReport(domain, forceFresh, env)` 返回 body 增加 `cached_at`（数字，epoch ms；KV 热命中=现在，D1 温命中=row.scanned_at）；D1 温层命中同时回填 KV
- Consumes: 现有 `env.SCAN_DB`（D1 binding）、`scan_history` 表（domain, detail_json, scanned_at, scoring_version）

- [ ] **Step 1: 写失败测试** `tests/cache-tier.test.mjs`：mock `env.SCAN_DB.prepare().bind().first()` 返回 12h 前的 `{detail_json, scanned_at}`；断言 `scanPublicReport('example.com', false, env)` 返回 `body.cached===true && body.cached_at===row.scanned_at` 且**未**调用实时扫描（mock scanDomainCore 计数=0）；再断言 KV miss+D1 无行 → 走实时。
- [ ] **Step 2: 跑测试确认失败**（`node tests/cache-tier.test.mjs` → 现实现无 D1 层）
- [ ] **Step 3: 实现**：`scanPublicReport` 在 KV miss 后、实时扫描前插入 D1 查询（≤24h 且 detail_json 可解析 → 剥离 `report_json/tool_surface_hash` → 回填 KV TTL 300 → 返回）；try/catch 包裹 D1（失败落实时）
- [ ] **Step 4: 全量 `npm test` 无回归 + 新测试 PASS**
- [ ] **Step 5: Commit** `perf(cache): add D1 warm tier between KV and live scan`

**Phase 1 验收：** 同域名第二次 scan（KV 过期后）命中 D1 不再实时抓取；compare 端到端复测（同参二连发第二次 <300ms 量级）。

---

### Phase 2：Compare 先到先画 + 阶段化进度（toolfront/public/compare.html）

**Files:**
- Modify: `toolfront/public/compare.html`（替换 fetch 逻辑与渲染区，~line 355-420）
- Test: `toolfront/tests/compare.test.mjs` 增补断言（DOM 渲染函数可测）

**Interfaces:**
- Consumes: `/api/scan?domain=X`（已存在，返回单一报告 JSON）
- Produces: 页面行为——两侧独立 `fetch('/api/scan?…')`，谁先返回谁先渲染分数卡；等待侧显示 6 阶段垂直时间线伪进度（前端按 650ms/阶段推进，纯动画零后端改动）；保留 shareable URL 与 i18n

- [ ] **Step 1: 改数据流**：删除单次 `/api/compare` 调用，改 `Promise` 两个独立 `/api/scan`；每侧独立 render 容器（先到先画）
- [ ] **Step 2: 加阶段时间线**：等待侧 DOM 插入垂直 checklist（6 类目，650ms/步推进，fetch resolve 后跳"完成"）；CSS 单色纪律（绿勾/蓝环/灰环）
- [ ] **Step 3: 保留 /api/compare 端点**（旧链接兼容，不改后端）
- [ ] **Step 4: 本地 wrangler dev 双站验证**（toolfront 8788 + monitor 8787），compare 三连发体验
- [ ] **Step 5: 测试 + 双门禁 + Commit** `feat(compare): render each side independently with staged progress`

**Phase 2 验收：** 打开 compare 不再整页空白等待；先返回的一侧先出现；i18n 往返不回归。

---

### Phase 3：Rankings 新页（toolfront /rankings）

**Files:**
- Modify: `toolfront/worker.js`（路由 + `rankingsPage()` HTML 字符串函数，放 worker.js 尾部 helpers 区）
- Modify: `toolfront/public/index.html`（nav 加 Rankings 链接，指向本站 /rankings）
- Test: `toolfront/tests/rankings-page.test.mjs`（页面含统计卡/过滤器骨架/表格结构断言）

**Interfaces:**
- Consumes: monitor 公开 `GET https://monitor.toolfront.dev/api/rankings`（已带 CORS `*`；CSP 已放行该域）
- Produces: `/rankings` 路由（HTML；数据客户端 fetch + 客户端过滤渲染，零服务端聚合）

- [ ] **Step 1: 路由+页面骨架**：`GET /rankings` 返回静态 HTML（统计卡 4 格 + 行业 pill + 搜索 + 类目/档位 seg + 表格容器 + 分页占位），内联 JS fetch rankings API 渲染（mini bars + HIGHLIGHTS + 右对齐分数）
- [ ] **Step 2: 客户端过滤**（行业/类目/档位/搜索全真过滤；空结果显示 "the board never invents a row" 同款）
- [ ] **Step 3: nav 接线**：index.html nav 的 Rankings 链接从 monitor 域改本站 /rankings（data-monitor-link 逻辑保留语言传递）
- [ ] **Step 4: 双语**：页面文案进轻量 i18n（EN/ZH PAIRS + TreeWalker，机制与 mockup 相同）
- [ ] **Step 5: 测试 + 双门禁 + Commit** `feat(rankings): public leaderboard page with triple filtering`

**Phase 3 验收：** /rankings 三维过滤真交互；统计卡随过滤联动；390 无溢出；CSP 无报错。

---

### Phase 4：Report 升级（toolfront/public/report.html）

**Files:**
- Modify: `toolfront/public/report.html`（动作按钮组 + 新增区块）
- Test: `toolfront/tests/report-dom.test.mjs` 增补

**Interfaces:**
- Consumes: `/api/scan-history?domain=`（已存在，返回历史行含 detail 摘要）

- [ ] **Step 1: 动作按钮组升级**：+ Share on LinkedIn / 𝕏 Post / 🖨 Save as PDF（window.print + print CSS）
- [ ] **Step 2: 诊断区**：checkpoints passed/partial/failed/na 行列表（从现有 checks 数组聚合，零新后端）
- [ ] **Step 3: 历史勾选对比**：渲染 scan-history 行（checkbox），勾两条 → 底部深色 Compare 条 → 跳 `/compare?a=…&b=…`（同站跨时间对比复用现有 compare）
- [ ] **Step 4: 单色刻度 + YOU 游标微调**（现有标尺换 V6.4 单色版）
- [ ] **Step 5: 测试 + 双门禁 + Commit** `feat(report): share actions, diagnostics, history pair-compare`

**Phase 4 验收：** 三键 toast/跳转正确；勾两条出对比条且链接参数正确；390 无溢出；现有 report 测试无回归。

---

### Phase 5：monitor 三页 V6.4 皮肤（toolfront-monitor/src/monitor-pages.ts）

**Files:**
- Modify: `toolfront-monitor/src/monitor-pages.ts`（`loginPage()` / `signupPage` / `panelPage`）

**Interfaces:**
- Consumes: 现有 I18N_EN 字典机制（PAird 增量词条）、现有 panel 数据接口（域名列表/删除/登出——**逻辑零改动，只换皮**）

- [ ] **Step 1: loginPage 裸双门**：去边框卡 → 裸排版 + 门顶引导语（`<b>` 加粗，走 data-i18n-html 通道——I18N_EN 值本身可含 HTML，现有机制即 innerHTML 替换 ✓）+ 中轴竖线 + Lost your password? 右对齐 + 黑全宽按钮（弃蓝渐变）
- [ ] **Step 2: signupPage**：窄卡 + 信任行（✓无需信用卡/随时退订/不出售数据）
- [ ] **Step 3: panelPage 工作台**：whoami 行 + 添加域名表单 + 监控行（状态 pill + 告警 + **sparkline SVG**（分数历史已有数据）+ 删除）+ 空状态
- [ ] **Step 4: I18N_EN 增量词条**（新增 UI 元素全部双语；黑体标题字体栈确认 = Noto Sans SC 700 via 现有 fonts.css）
- [ ] **Step 5: `npm test`（42+）+ `npm run check` + 本地 wrangler dev 三页截图验收 + 双门禁 + Commit/PR** `feat(ui): v6.4 visual refresh for auth and panel pages`

**Phase 5 验收：** 三页双语切换零残缺；登录双门裸排版与设计稿一致；panel 添加/删除真交互（真后端）；42+ 测试无回归。

---

### Phase 6：验收收口

- [ ] **Step 1: toolfront 部署前本地预览**（用户确认）→ secret-scan + UI 回归 → PR（去来源化 message）→ 用户合并 → `wrangler deploy`
- [ ] **Step 2: monitor 同流程**（PR #18/#19 若仍未合并，与本 Phase 同批提醒用户）
- [ ] **Step 3: 生产验收**：compare 二连发计时、/rankings 公开页、双语、390 视口
- [ ] **Step 4: 工作日志 + QA 脚本归档**（qa 脚本进两仓 tests/ 作为长期回归）

---

## Self-Review

**1. Spec coverage：** UI-SPEC 七页 → Scanner（Phase 3 nav + token 对齐，结构改版 Out of Scope 已声明）/ Rankings（Phase 3）/ Compare（Phase 2+V6.3 结果区已在 mockup，落地随 Phase 2 增量）/ Report（Phase 4）/ Login+Signup+Dashboard（Phase 5）/ 双语（Phase 4/5 + mockup 机制移植）/ 三层缓存根修（Phase 1）。profiles 四视角 Out of Scope 已声明。**无遗漏未声明项。**

**2. Placeholder 扫描：** 无 TBD/TODO；所有 Step 有具体文件/命令/断言；Phase 4 Step 2 数据来源明确（现有 checks 聚合）。

**3. 接口/类型一致性：** `scanPublicReport` 签名不变（内部增强）；Phase 2 前端改用 `/api/scan`（已存在）；Phase 3 消费 monitor `/api/rankings`（CORS/CSP 已验证通）；Phase 5 只换皮不动数据接口。✓

## Execution Handoff

Plan 已保存。两种执行方式：

1. **Subagent-Driven**（每 task 派发新 subagent，任务间 review）
2. **Inline Execution**（本 session 按 Phase 批次执行 + checkpoint 汇报）

按当前上下文（本 session 已持有两仓全部现状上下文），**选 Inline** 最快——直接开始执行 Phase 1。
