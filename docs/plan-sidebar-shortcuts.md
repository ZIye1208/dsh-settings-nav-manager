# 侧栏设置快捷入口 — 实施方案（阶段 1 · 阶段 2）

> 状态：**阶段 1 已实现（v1.1.0 → v1.2.0 加入入口开关 → v1.2.1 按评审返工）；阶段 2 已实现（v1.3.0）**
> 目标版本：1.1.0（阶段 1 ✅）→ 1.2.0（入口开关 ✅）→ 1.2.1（A+B 返工 ✅）→ 1.3.0（阶段 2 ✅）
> 适用宿主：DSH 0.2.1-rc.2 桌面端（`dsh.compatibility.dsh = ">=0.2.1-rc.2 <0.3.0"`）
> 关联需求：把设置页的页签以快捷方式放到主界面侧栏，点击直接打开对应设置分区；支持单独标记某几个页签。
>
> 1.2.1 起两处实现细节与下文早期描述不同，以代码为准：面板 id 由 `settings-nav` 改为
> **`settings-nav-manager.nav`**（命名空间化，避免占宿主短名），排序位抽成常量 **`ENTRY_ORDER = 20`**。

---

## 0. 目标拆成两级

| 级别 | 交付物 | 一句话验收 |
|---|---|---|
| **阶段 1** | 侧栏插件栏多一行「设置导航」，点开是一个页面，列出全部设置分区，点任意行直接打开设置并选中 | 侧栏点两下就能到任意设置分区 |
| **阶段 2** | 在阶段 1 的页面上给单个分区打「固定到侧栏」标记，被标记的分区在侧栏插件栏各占一行，点一下直接打开 | 常用设置不用进页面，一键直达 |

阶段 1 是阶段 2 的地基（页面、深链、状态字段都在阶段 1 成型），所以两份工作排成一条线，不做成两个互不相干的插件。

---

## 1. 宿主契约取证（决定方案边界的事实）

以下均已在 0.2.1-rc.2 的 `H:\DEEPSEEK\resources\app.asar` 内实测确认，是本方案的地基：

| 事实 | 证据 | 对方案的影响 |
|---|---|---|
| 侧栏插件栏的数据源是 `sidebar.panellist` 槽，按 `options.order` 排序 | `dsh-client-ui-sidebar/lib/client.js:452-470` | 加一行 = 注册一条 panellist 条目 |
| 该槽是响应式的：`ctx.slots.subscribe("sidebar.panellist", syncPanels)` | 同上 :469 | 运行时可动态注册/注销，不用重启 |
| 行点击写死为切换主面板，没有自定义回调入口 | `:184-186` `onClick: () => selectPanel(id)`；`:478-481` → `ctx.layout.selectPanel(id)` | **「点一行直接弹设置」无法靠配置实现** |
| 主面板没注册会抛错 | `dsh-client-ui-layout/lib/client.js:468` `throw new Error('layout.selectPanel: main panel "..." is not registered')` | 任何出现在 panellist 里的 id 都必须有 `main` 页兜底 |
| 图标组件渲染在行按钮**内部** | `:187-193` `span.panelGlyph > renderSlot("sidebar.panellist", {size, active}, {only:id})` | 图标可以向上定位到父行、并拦截点击 |
| `sidebar.footer.action` 是 list 槽，条目自己拥有 onClick，只收 `{wide}` | `:399-407`、`:515-518` | 干净投放点（备选方案） |
| 设置弹窗的 shell store 暴露 `openSection(id)`，且 `create()` 被覆写成固定单例 | `dsh-client-ui-settings-general/lib/client.js:19-41`、`:1181-1186` | `entriesOfSlot("sidebar.settings")[0].store.create().actions.openSection(id)` 可一步打开并选中 |
| 分区清单唯一权威：`settings.section` 槽条目 | 插件现有 `projectSections()` `client.js:178-208` | 不自造分区列表 |
| 不能往别人的 children 里塞槽位 | `dsh-client-ui-renderer/lib/client.js:342-360` `SlotOwnershipError` | **绝不改 `sidebar.settings` 的 children**，只注册自己的 `main` + `sidebar.panellist` |
| `slots.register()` 返回 disposer，绑定调用方 fiber | `renderer:1813` `return this.ctx.effect(() => this._register(...))` | 阶段 2 动态注册与卸载可行 |
| React **18.3.1**，根容器 `#root`，挂载用 `createRoot(container)` | `dsh-web-frontend/.../index-CN7NIWNw.js` 内 `getElementById("root")` → `uiRenderer.mount`；`renderer client.js:1850-1857` | document 捕获阶段先于 React 的 `onClick` → 拦截可行（§3.6 已实证） |

结论：阶段 1 走标准契约（低风险）；阶段 2 必须「动态注册 panellist 行 + 捕获阶段拦截点击」，这是唯一能保持原生外观的路径。

---

## 2. 阶段 1：单一入口页

### 2.1 总体结构

```
插件 apply
  ├─ sync() ──► sections = projectSections(ctx)         ← settings.section 槽条目
  │            state   = normalizeState(...)            ← 已有持久化 order/groups/hidden
  │            publish() ──► uiSubs 触发 React 重渲染
  ├─ 注册 sidebar.panellist(id=NS, order=20, label=t("panel"))
  └─ 注册 main(key=NS)  ← 页面组件，layout 用它承载主体内容

点击行 → openSettingsSection(sectionId)
  ① entriesOfSlot("sidebar.settings")[0].store.create().actions.openSection(sectionId)
  ② 失败 → 下一帧查 [data-shortcut-modal="settings"]，按 label 命中 navCell 后 .click()
  ③ 再失败 → 齿轮旁提示「请用 Ctrl+, 打开设置后重试」
```

### 2.2 文件级改动清单

不新增源文件，全部落在现有文件（`client.js` 无构建、走 `window.__ModuleLoader__`，新增文件要处理 require 解析，收益不值）。

| 文件 | 位置 | 改动 | 约行数 |
|---|---|---|---|
| `client.js` | :28 常量区 | `PANEL_ID = NS`；`DATA.page`、`DATA.rowBtn` | +4 |
| `client.js` | :69-106 `DICT` | 新增 `panel` / `pageHint` / `empty` / `retry` / `openFailed` / `hiddenCount`（中英各 6 键） | +14 |
| `client.js` | :342-433 纯函数区 | `flattenNav(sections, state)`：按 `state.order` 展开（抽屉按 items 连续展开）→ 未落位分区按宿主 order 追加 → 返回 `[{id,label,hidden,group}]` | +30 |
| `client.js` | :434-522 `buildCss()` | `.snm-page` / `.snm-row` / `.snm-badge` / `.snm-empty`，颜色全用 `--dsw-alias-*` | +40 |
| `client.js` | :553 后 | `openSettingsSection(id)`（三层降级）+ `settingsHandle()` | +35 |
| `client.js` | :760-774 `sync()` | 末尾（**在 `if (!nav) return` 之前**）比对 sections 指纹，变了就 `publish()` | +8 |
| `client.js` | :1600 `GearButton` 前 | `SettingsNavIcon`（收 `{size, active}`）、`SettingsNavPage`（收 `{openSection}`） | +70 |
| `client.js` | :1731-1757 装配区 | 两个 `ctx.effect`：注册 `sidebar.panellist`（order 20）与 `main`（key=NS） | +18 |
| `client.js` | :1811 `__test` | 暴露 `flattenNav` | +2 |
| `locale/zh.json` `en.json` | — | `node tools/gen-locale.mjs` 生成，不手改 | 自动 |
| `test/unit.test.mjs` | 末尾 | +5 条 `flattenNav` 用例 | +60 |

`exports.inject` **不变**（slots/locale 已够），`test/repo.test.mjs` 里「inject 与官方一致」不会被撞。

### 2.3 深链三层降级

```js
function openSettingsSection(id) {
  var entry = null;
  try { entry = ctx.slots.entriesOfSlot("sidebar.settings")[0]; } catch (e) { dbg("deeplink entry", e); }
  var shell = entry && entry.store && entry.store.create ? entry.store.create() : null;
  if (shell && shell.actions && typeof shell.actions.openSection === "function") {
    try { shell.actions.openSection(id); return true; } catch (e2) { dbg("deeplink call", e2); }
  }
  setTimeout(function () { domFallback(id); }, 0);
  setNotice(t("openFailed"));
  return false;
}
```

- ① 是主路径，成功即返回，不写死任何 DOM 假设。
- ② `domFallback` 只在弹窗已存在时生效（`SEL.panel` 存在 → `SEL.navCell` 里按 `rowLabel(cell)` 命中 → `.click()`）。
- ③ 是诚实降级：给提示，不静默失败。

### 2.4 页面交互

| 元素 | 行为 |
|---|---|
| 标题行 | `t("panel")` + `sections.length` 徽标 + `t("pageHint")` |
| 分区行 | `button[data-snm-row-btn][data-snm-id]`：首字圆形徽标 + label + 「已隐藏」小标 |
| 点行 | `openSection(id)`，立即返回，不加 loading |
| 已隐藏分区 | 默认不渲染，底部一行「N 个已隐藏分区 ›」点击展开（本地 `useState`） |
| 空态 | `sections.length === 0` → 空态文案 +「重试」（`sync(); publish();`） |
| 键盘 | 用原生 `<button>`，Tab/Enter/Space 天然可达；`focus-visible` 用宿主焦点环变量 |
| 订阅 | `useEffect(() => { uiSubs.push(force); return () => {...} }, [])`（与 `GearButton` 同款） |

### 2.5 阶段 1 验收

1. 冷启动后侧栏插件栏出现「设置导航」（排在「自动化任务」之后），深/浅色主题都可读。
2. 点「设置导航」→ 主体切到页面；再点「插件市场」能切回去。
3. 点页面里的「通用设置」→ 设置弹窗打开且左侧选中「通用设置」。
4. 在设置页把「技能」拖到第一位 → 回本页，「技能」在第一行。
5. 隐藏「费用」→ 本页不显示它，底部出现「1 个已隐藏分区」。
6. 停用插件 → 侧栏行消失，`data-snm-page` 无残留，设置页回到宿主默认顺序。

### 2.6 1.2.1 返工追加的验收（评审 A+B 档）

| # | 场景 | 期望 |
|---|---|---|
| 7 | 宿主 `openSection` 存在但不渲染（模拟失效） | 页面显示「未能打开该分区」+「重试」，不出现静默无反应 |
| 8 | 点一个已被删除的陈旧分区 id | 不假装成功，直接给失败提示 |
| 9 | 入口开关切换时 `persist` 失败 | 按钮恢复原状态、磁盘值不变、齿轮旁给出原因 |
| 10 | `hideEntry: true` 后冷启动 | 启动过程中侧栏**从未**出现该行（无闪烁），`main` 页仍在册 |
| 11 | 插件卸载 | 定时器全清、`data-snm-*` 全摘、样式节点移除 |

对应自动化：`test/e2e.mjs` 22 条（其中 4 条专测 7–10），单测 31 条。

---

## 3. 阶段 2：单独标记 → 侧栏快捷（接下来开发计划）

### 3.1 目标交互

1. 在「设置导航」页面，每行右侧一个 ☆ 按钮（`固定到侧栏` / `取消固定`）。
2. 被固定的分区在侧栏插件栏各占一行，图标是首字徽标，hover 显示分区名。
3. 点这一行 → 直接打开设置并选中该分区；点击**不应**切换主面板、不应出现页面闪烁。
4. 取消固定 / 分区消失 / 插件停用 → 行立即消失。

### 3.2 为什么不走「配置」而必须拦截点击

`PanelRow` 的点击是 `selectPanel(id)` → `layout.selectPanel(id)`，没有注入回调的口子（见 §1）。所以：

- 如果只注册行、不拦截 → 点击切到一个没有 `main` 页的 id → **抛错**。
- 如果为每个行注册 `main` 页让它切过去 → 主体会闪一下空白页，关掉设置后用户停在空白页 → 体验不可接受。

因此阶段 2 采用「保留行语义，劫持点击」：

| 层 | 做法 |
|---|---|
| 定位父行 | 图标组件 `ref.current.closest('button[class*="panelRow"]')` 打 `data-snm-pin="<sectionId>"`（不猜哈希类名全称，只做包含匹配；匹配不到就只标图标本身，图标点击仍有效） |
| 拦截 | `document.addEventListener("click", handler, true)`，命中 `[data-snm-pin]` 时 `e.preventDefault(); e.stopPropagation(); openSettingsSection(id)`。React 监听器挂在 `#root` 容器上，document 捕获阶段先于它执行，因此 `selectPanel` 不会触发（**已实证，见 §3.6**） |
| 兜底 | 同时为每个 pin id 注册极简 `main` 页（「该分区已在设置中打开」+ 返回按钮），只为在极端路径（如布局恢复）不触发 `hasMainPanel` 抛错 |
| 失败降级 | 若父行定位失败（宿主改类名），退回「把图标本身做成可点击」；若 event 顺序不符合预期，退回备选 A（见 §3.7） |

### 3.3 数据模型与 schema 变更

```js
// index.js —— 必改，否则 update() 会把未知字段丢掉
const Config = z.object({
  version: z.number().default(1),
  order: z.array(z.string()).default([]),
  groups: z.array(z.object({ ... })).default([]),
  hidden: z.array(z.string()).default([]),
  pinned: z.array(z.string()).default([]),   // 新增：固定到侧栏的分区 id
}).volatile();
```

`client.js` 对应改动：

| 函数 | 改动 |
|---|---|
| `createState(raw)` :222-243 | 读出 `pinned`（只保留 string） |
| `normalizeState(...)` :248-317 | `pinned` 去重；**不因「此刻没见到这个分区」而丢**（与 order 同策略）；`known` 为空时原样返回 |
| `serializeState(...)` :319-340 | 写盘前按 `known` 过滤 `pinned`；`known` 为空仍返回 `null` 拒写 |
| `looksLikeOurValue` :168-175 | 不动（`pinned` 是可选字段，老数据仍认） |
| `exports.__test` | 暴露新纯函数（`togglePinned` / `pinnedIds`） |

约束：

- **pinned 上限 5 个**。`panelList` 是 `flex:none`，固定再多会把下面的会话列表挤扁；到限时给 `setNotice`，不静默截断。
- **隐藏分区不能固定**：`togglePinned` 遇到 `hidden` 里的 id 直接拒绝并提示；已经固定的分区被隐藏时，自动取消固定。
- **分区消失**（插件卸载）：`serializeState` 过滤 + 动态注册管理器按 `known` 重建，行自动消失。
- **与入口开关互不干扰**：1.2.0 的 `hideEntry`（隐藏「设置导航」侧栏入口）与 `pinned` 是两件事 —— 隐藏入口**不**取消固定，固定行消失只由「取消固定 / 分区消失 / 停用插件」触发。
- **同一份 state 写盘，字段不能互相覆盖**：`serializeState` / `payloadOps` 必须每次同时带上 `hideEntry` 与 `pinned`（1.2.0 就是在这条上踩过：只写部分字段导致另一字段被清空）。

### 3.4 动态注册管理器

```js
var pinDisposers = [];           // 每次重建先全部 dispose
function rebuildPins() {
  for (var i = 0; i < pinDisposers.length; i++) { try { pinDisposers[i](); } catch (e) { dbg("unpin", e); } }
  pinDisposers.length = 0;
  var ids = pinnedIds(state, knownIdsFrom(sections));
  for (var k = 0; k < ids.length; k++) {
    (function (sid, index) {
      var row = sections.find(function (s) { return s.id === sid; });
      if (!row) return;
      var Glyph = makeGlyph(sid, row.label);
      pinDisposers.push(ctx.slots.register(
        { name: "sidebar.panellist", id: "snm-pin-" + sid, order: 100 + index, locale: NS,
          label: function () { return row.label; } }, Glyph));
      pinDisposers.push(ctx.slots.register(
        { name: "main", key: "snm-pin-" + sid, locale: NS }, PinLandingPage));
    })(ids[k], k);
  }
}
```

触发重建的时机：`sync()` 里 sections 指纹变化、`state.pinned` 变化、`loadState()` 完成、插件卸载（disposer 随 fiber 自动回收，仍显式清一遍保险）。

### 3.5 标记入口的放置

| 入口 | 阶段 | 说明 |
|---|---|---|
| 「设置导航」页面每行 ☆ | 阶段 2 | 主入口，零 DOM hack |
| 设置弹窗内行尾 ☆ | 阶段 2.1（可选） | 需向 React 管理的 `navCell` 追加子节点，有 reconciliation 风险，等主入口稳定后再评估 |
| 右键设置行 → 「固定到侧栏」 | v3 候选 | 走现有 `onClickCapture` 委托，成本中等 |

### 3.6 事件顺序的实证（已完成 · 结论 Go）

**结论：Go。** 2026-10-24 在真实 React 18.3.1 上跑完 10/10 断言，宿主的挂载点也已从 `app.asar` 取证，机制成立。本节的三张表是实现阶段的**契约**，不是背景介绍。

#### 3.6.1 宿主侧取证（机制成立的前提）

| 事实 | 证据 |
|---|---|
| 宿主 React 版本 = **18.3.1** | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 内 `version:"18.3.1"` |
| React 根容器是 **`#root`** | 同文件启动段：`const e = document.getElementById("root"); if (e === null) throw new Error("web app: missing #root"); const t = new TZ(e)` → `new TZ(e)` 末尾 `uiRenderer.mount(this.container)` |
| 真正挂载调用是 `createRoot(container)` | `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1850-1857`（带 boot 时走 `hydrateRoot`，否则 `createRoot`） |
| 推论 | React 18 把事件监听器绑在这个容器上，所以 `document` 的**捕获阶段始终先于** React 的 `onClick` |

#### 3.6.2 实证结果（spike 10/10 PASS）

产物：`C:\Users\Administrator\Desktop\gz\spike-events\{spike.html, react.js, react-dom.js, dom3.txt}`（本机 18.3.1 UMD，离线可重跑；`--dump-dom` 抓结果，`virtual-time-budget` 会提前截断 rAF，改用 `setTimeout` + `flushSync`）。

| 断言 | 实测值 |
|---|---|
| T1 对照组：不拦截点行 → React `onClick` 执行、主面板被切走 | `activePanel=snm-pin-models`，日志 `react.onClick → selectPanel(...)` |
| T2 拦截后 React `onClick` **未执行** | 只有 `doc.capture → intercepted → stopPropagation → openSettings(models)` |
| T2 拦截后主面板**未切换** | `activePanel=conversation` |
| T2 设置被打开且选中正确分区 | `opened=models` |
| T3 监听器在点击前一刻才注册，也能拦住 | 同 T2 |
| T4 非固定行不受影响，仍正常切面板 | `activePanel=insight` |
| T5 连点 3 次不抛错、每次都开设置、面板始终未切 | `opened=models,models,models`，`activePanel=conversation` |

#### 3.6.3 实现约束（照着写，别自作聪明）

1. 监听必须挂 `document` 且 `capture: true` —— 冒泡阶段无效（T2 与 T3 已对比证明）。
2. 判定用 `event.target.closest('button[class*="panelRow"]')` 再读 `data-snm-pin`；不猜哈希类名全称，点在图标/文字上同样命中。
3. 顺序固定为 `preventDefault()` → `stopPropagation()` → `openSettingsSection(id)`。**不要** `stopImmediatePropagation`（会误伤宿主自己的 document 委托）。
4. 拦截器必须幂等：`rebuildPins()` 重建时**不得重复** `addEventListener`；模块级只注册一个 `clickHandler`，卸载时 `removeEventListener`。
5. `openSettingsSection` 失败必须 `setNotice(t("openFailed"))`，禁止静默 —— 否则用户看到的是“点了没反应”。
6. 兜底 `main` 页不能省（§3.2）：布局恢复、深链极端路径仍会走 `selectPanel`。
7. 键盘激活（Enter / Space）产生的就是同一个 `click`，天然被覆盖；**不要**额外拦 `keydown`，否则会和设置页自己的快捷键打架。

#### 3.6.4 边界（这套实证覆盖不到什么）

- 合成 click（`dispatchEvent`）在 Chromium 里走完整传播路径，故结论对真实点击成立；但**不覆盖**「宿主未来把切换改到 `pointerdown`/`mousedown`」这类变化。
- 若某天真改成指针按下即切换，本方案失效 → 触发 §3.7 备选 A，同时本插件必须在 CHANGELOG 里标注不兼容版本。

#### 3.6.5 未闭环的一项（阶段 2 实现时补，不得省略）

「在**真实**侧栏点固定行」这一步此刻做不了 —— 固定行要等实现之后才存在。曾尝试起独立端口的临时 web 实例来验，被 `EPERM: rmSync ...\.dsh\profiles\web\.dsh-module-fallback` 挡住，而 `profiles\web` 是禁碰区，不碰。

改为在阶段 2 第一轮 e2e 内补验，断言写成：真实侧栏 + `selectPanel` 桩 + 拦截器 → 点击固定行后 ① 主面板 activePanel 不变 ② 设置被打开 ③ 无 `layout.selectPanel` 抛错。**这条不过，任务 9 不算完成。**

### 3.7 备选 A：底部操作区（不拦截点击）

放弃「插件栏」，改用官方 `sidebar.footer.action` list 槽：条目自己拥有 onClick，只收 `{wide}`，可以渲染紧凑图标按钮，点击直接 `openSection`。

| 维度 | 插件栏直连（主选） | 底部操作区（备选 A） |
|---|---|---|
| 契约清洁度 | 依赖 DOM 定位 + document 监听 | 纯 slot 契约 |
| 位置 | 插件这栏（符合原始需求） | 侧栏底部，设置齿轮旁边 |
| 失败概率 | **~4%**（事件顺序已实证，残下 DOM 定位与宿主改指针事件） | ~5% |
| 上限 | 5 个 | 3~4 个（横向空间） |

### 3.8 阶段 2 验收

1. 页面里给「模型」打固定 → 侧栏出现「模」徽标行；hover 显示「模型」。
2. 点该行 → 设置弹窗打开并选中「模型」；主面板仍是原来的面板，没有闪屏。
3. 再点一次同一行 → 仍然正常（不重复弹、不报错）。
4. 关闭设置 → 侧栏高亮不出现「伪激活」状态。
5. 取消固定 → 行立刻消失；重启后不复现。
6. 把已固定分区隐藏 → 该行消失，计数提示「已取消固定」。
7. 固定到 5 个后再点第 6 个 → 提示上限，不新增。
8. 停用插件 → 所有 pin 行消失，无残留。

---

## 4. 开发计划（按顺序执行）

| # | 任务 | 依赖 | 估时 | 交付 |
|---|---|---|---|---|
| 1 | 阶段 1 文案 + `flattenNav` + 单测 | — | 1.0h | `npm test` 绿 |
| 2 | 阶段 1 `openSettingsSection` 三层降级 | 1 | 1.0h | 真机点行能开设置 |
| 3 | 阶段 1 页面组件 + 样式 + 注册两槽 | 1,2 | 2.0h | 侧栏入口 + 页面可用 |
| 4 | 阶段 1 真机回归 + CHANGELOG + 版本 1.1.0 | 3 | 1.0h | 可发布 ✅ |
| 5 | **阶段 2 事件顺序 spike**（§3.6） | — | 0.5h | ✅ **Go**（10/10 实证，React 18.3.1 + `#root` 挂载点已取证） |
| 6 | schema `pinned` + normalize/serialize + 单测 | 5 | 1.0h | 写盘不丢字段 |
| 7 | 页面 ☆ 按钮 + 上限/隐藏冲突规则 | 6 | 1.5h | 能标记 |
| 8 | 动态注册管理器 + 徽标图标 + 兜底页 | 5,7 | 2.0h | 侧栏出现固定行 |
| 9 | 点击拦截 + 卸载清理 | 8 | 1.5h | 直连打开 |
| 10 | 真机回归 + e2e + CHANGELOG + 版本 1.3.0 | 9 | 1.5h | 可发布 |

合计约 **12.5 小时**（阶段 1 约 5h，阶段 2 约 7.5h，任务 5 已完成）。任务 9 的收尾条件是 §3.6.5 那条真实侧栏 e2e 断言；若 §3.6.3 任一约束在实现中无法满足，立刻切 §3.7 备选 A，任务 7~9 相应减 ~1h（不需要拦截与兜底页）。

---

## 5. 测试计划

| 层 | 内容 |
|---|---|
| 单元（`test/unit.test.mjs`） | `flattenNav`：未整理=宿主顺序、抽屉成员连续展开、组内与顶层不重复、隐藏标记、未知 id 不丢；`pinned`：去重、上限、隐藏拒绝、known 为空不裁剪 |
| 仓库（`test/repo.test.mjs`） | 现有 DICT↔locale 一致性自动覆盖新键；新增一条「`Config` 声明包含 `pinned`」断言，防止 schema 与 client 漂移 |
| e2e（`test/e2e.mjs`，需 Chrome） | 主题 1：页面渲染 N 行、点行调用注入的 `openSection` 桩；主题 2：固定后出现 panellist 条目、注销后消失（用测试台 slots 桩）；主题 3（**§3.6.5 必做**）：真实侧栏行 + `selectPanel` 桩 + 拦截器 → 点固定行后 activePanel 不变、设置打开、无 `layout.selectPanel` 抛错 |
| 真机手动 | §2.5 六条 + §3.8 八条，逐条打勾后才发版 |

注意：测试台已在 1.2.1 的 A1 档重构成「宿主外壳 + 真 React 挂载」（`mounts` 按 key 分桶、独立 hook 槽位、`env.shell.dead` 模拟布局失联），所以**交互断言可以进 e2e**，不再局限于 `react-dom/server` 的静态渲染；但真机清单仍要人工过，e2e 只保证机制。

---

## 6. 风险登记表

| # | 风险 | 概率 | 影响 | 缓解 | 验证方式 |
|---|---|---|---|---|---|
| 1 | `store.create().create` 半内部 API 被 0.2.2+ 改动 | 30% | 深链失效 | 三层降级；兼容区间锁 `<0.3.0`；升级时必跑 §2.5 | 版本升级回归 |
| 2 | React 事件顺序与预期不符 | **~4%**（已实证） | 点击仍切面板 | §3.6 已证：document 捕获 + `stopPropagation` 可切断 `#root` 上的 React `onClick`；残下风险是宿主改用指针事件触发切换 | spike（已完成）+ 真机 |
| 3 | 宿主把 `panelRow` 类名重构 | 10% | 定位不到父行 | 退回只标图标；图标仍可点击 | 真机点图标 |
| 4 | `settings.section` 首次渲染未注册完 | 中 | 页面/条目为空 | `sync()` 指纹 `publish()` + 空态重试 | 冷启动真机 |
| 5 | `publish` 过频导致重渲染 | 低 | 卡顿 | 指纹比较，只在 id/order/label 真变时触发 | devtools Performance |
| 6 | 固定项挤占会话列表 | 中 | 布局难看 | 上限 5 + 超限提示 | 真机固定 5 个 |
| 7 | 与「隐藏分区」状态打架 | 中 | 打开一个导航里看不到的分区 | 隐藏时自动取消固定 | 真机 |

---

## 7. 发布与回滚

1. `node tools/gen-locale.mjs`（DICT 单一事实来源）
2. `npm test`（unit + repo）
3. 可选 `node test/e2e.mjs`（需 Chrome；沙箱内需一次性审批）
4. `node tools/sync-profile.mjs desktop`（会先把已安装副本整份备份到 `~/.dsh/profiles/desktop/.snm-sync-backup/<时间戳>`）
5. 版本号与 CHANGELOG 更新后，**由用户完全退出并重开 DSH 桌面端**（本插件不自行重启宿主）
6. 回滚：把 `.snm-sync-backup/<时间戳>` 拷回 `~/.dsh/profiles/desktop/node_modules/dsh-settings-nav-manager/`，重启验证

npm 发布（`dsh-plugin-release` 流程）留到阶段 1 真机验收通过之后再做，不阻塞开发。

---

## 8. 明确不做（v3 候选）

- 页面内拖拽重排 / 显隐开关（设置页里已经能改，双写容易打架）
- 与设置弹窗的双向实时同步（切页时刷新即可）
- 固定项分组收纳、右键上下文菜单、搜索框
- 把设置弹窗的 `sidebar.settings` children 改写/移动（触碰 `SlotOwnershipError`，红线）
- 自定义图标（首字徽标够用，避免引入资源文件与 `files` 白名单变更）
