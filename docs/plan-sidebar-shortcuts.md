# 侧栏设置快捷入口 — 实施方案（阶段 1 · 阶段 2）

> 状态：**阶段 1 已实现（v1.1.0 → v1.2.0 加入入口开关）**；阶段 2 设计完成、未开工
> 目标版本：1.1.0（阶段 1 ✅）→ 1.2.0（入口开关 ✅）→ 1.3.0（阶段 2）
> 适用宿主：DSH 0.2.1-rc.2 桌面端（`dsh.compatibility.dsh = ">=0.2.1-rc.2 <0.3.0"`）
> 关联需求：把设置页的页签以快捷方式放到主界面侧栏，点击直接打开对应设置分区；支持单独标记某几个页签。

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
| 拦截 | `document.addEventListener("click", handler, true)`，命中 `[data-snm-pin]` 时 `e.preventDefault(); e.stopPropagation(); openSettingsSection(id)`。React 监听器挂在 `#root` 容器上，document 捕获阶段先于它执行，因此 `selectPanel` 不会触发 |
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

### 3.6 事件顺序的实证（开工第一步）

这是整份方案里**唯一没有实测证据**的环节，必须先做 spike 再写产品代码：

1. 构造一个最小 HTML：一层 `#root`，React 18 渲染 `<button onClick=...>`，document 捕获监听器 `stopPropagation`。
2. 用本机 Chrome（需一次性 `danger-full-access` 审批，沙箱内 Chrome 启动即死）加载，点按钮，确认 `onClick` 没有被调用。
3. 通过后，再在真实侧栏上验证：点击固定行 → 设置打开、主面板未切换、控制台无 `layout.selectPanel` 报错。
4. 不通过 → 立刻切备选 A（§3.7），方案文档同步修订。

### 3.7 备选 A：底部操作区（不拦截点击）

放弃「插件栏」，改用官方 `sidebar.footer.action` list 槽：条目自己拥有 onClick，只收 `{wide}`，可以渲染紧凑图标按钮，点击直接 `openSection`。

| 维度 | 插件栏直连（主选） | 底部操作区（备选 A） |
|---|---|---|
| 契约清洁度 | 依赖 DOM 定位 + document 监听 | 纯 slot 契约 |
| 位置 | 插件这栏（符合原始需求） | 侧栏底部，设置齿轮旁边 |
| 失败概率 | ~15% | ~5% |
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
| 5 | **阶段 2 事件顺序 spike**（§3.6） | — | 0.5h | Go / No-Go 结论 |
| 6 | schema `pinned` + normalize/serialize + 单测 | 5 | 1.0h | 写盘不丢字段 |
| 7 | 页面 ☆ 按钮 + 上限/隐藏冲突规则 | 6 | 1.5h | 能标记 |
| 8 | 动态注册管理器 + 徽标图标 + 兜底页 | 5,7 | 2.0h | 侧栏出现固定行 |
| 9 | 点击拦截 + 卸载清理 | 8 | 1.5h | 直连打开 |
| 10 | 真机回归 + e2e + CHANGELOG + 版本 1.3.0 | 9 | 1.5h | 可发布 |

合计约 **13 小时**（阶段 1 约 5h，阶段 2 约 8h）。任务 5 是关卡：不通过就切 §3.7 备选 A，任务 7~9 相应减 ~1h（不需要拦截与兜底页）。

---

## 5. 测试计划

| 层 | 内容 |
|---|---|
| 单元（`test/unit.test.mjs`） | `flattenNav`：未整理=宿主顺序、抽屉成员连续展开、组内与顶层不重复、隐藏标记、未知 id 不丢；`pinned`：去重、上限、隐藏拒绝、known 为空不裁剪 |
| 仓库（`test/repo.test.mjs`） | 现有 DICT↔locale 一致性自动覆盖新键；新增一条「`Config` 声明包含 `pinned`」断言，防止 schema 与 client 漂移 |
| e2e（`test/e2e.mjs`，需 Chrome） | 主题 1：页面渲染 N 行、点行调用注入的 `openSection` 桩；主题 2：固定后出现 panellist 条目、注销后消失（用 harness 的 slots 桩） |
| 真机手动 | §2.5 六条 + §3.8 八条，逐条打勾后才发版 |

注意：`test/harness` 目前是 DOM 桩，阶段 1 的页面组件需要 React 才能跑；e2e 用 `react-dom/server` 只做「标记行渲染数量」这类静态断言，交互断言留在真机清单里，避免 e2e 变成维护负担。

---

## 6. 风险登记表

| # | 风险 | 概率 | 影响 | 缓解 | 验证方式 |
|---|---|---|---|---|---|
| 1 | `store.create().create` 半内部 API 被 0.2.2+ 改动 | 30% | 深链失效 | 三层降级；兼容区间锁 `<0.3.0`；升级时必跑 §2.5 | 版本升级回归 |
| 2 | React 事件顺序与预期不符 | 15% | 点击仍切面板 | 任务 5 spike 先验；不通过切备选 A | spike + 真机 |
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
