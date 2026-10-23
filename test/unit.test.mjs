// 纯逻辑单测：不需要浏览器，node --test 秒级跑完。
// 直接加载出厂产物 client.js 里的 __test 接缝，测的是真代码而不是复制品。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "client.js"), "utf8");

function load() {
  let mod = null;
  const win = {
    __ModuleLoader__: {
      load(m) {
        mod = m;
      },
    },
  };
  // eslint-disable-next-line no-new-func
  const run = new Function("window", "document", "console", SRC);
  run(win, undefined, console);
  const react = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {} };
  return mod.factory((name) => {
    if (name === "react") return react;
    throw new Error("unexpected require: " + name);
  });
}

const plugin = load();
const T = plugin.__test;

const SAVED = {
  version: 1,
  order: ["general", "g-1", "models"],
  groups: [{ id: "g-1", name: "常用", collapsed: false, items: ["account"] }],
  hidden: ["plugins"],
};
const SECTIONS = [
  { id: "general", order: 0, label: "通用" },
  { id: "account", order: 1, label: "账户" },
  { id: "models", order: 2, label: "模型" },
  { id: "plugins", order: 3, label: "插件" },
];
const KNOWN = T.knownIdsFrom(SECTIONS);
const ORDER = T.sectionIds(SECTIONS);

test("createState：脏数据一律回退默认，不抛异常", () => {
  for (const bad of [null, undefined, 42, "x", [], { order: "nope", groups: {}, hidden: 1 }]) {
    const s = T.createState(bad);
    assert.deepEqual(s, { version: 1, order: [], groups: [], hidden: [], hideEntry: false, pinned: [] });
  }
  const s = T.createState({
    order: ["a", 1, "b"],
    groups: [{ id: "g-1", items: ["x", 2] }, { name: "无 id 的脏组" }, null],
    hidden: ["c", false],
  });
  assert.deepEqual(s.order, ["a", "b"]);
  assert.equal(s.groups.length, 1, "没有 id 的组必须被丢弃");
  assert.deepEqual(s.groups[0].items, ["x"]);
  assert.deepEqual(s.hidden, ["c"]);
});

test("P0 回归：分区未知时 normalize 不得裁剪已保存状态", () => {
  // 这就是冷启动（设置面板还没挂载）时的调用形态：known = {}
  const out = T.normalizeState(T.createState(SAVED), {}, []);
  assert.deepEqual(out.order, SAVED.order, "顶层顺序被改动了");
  assert.deepEqual(out.groups[0].items, ["account"], "抽屉成员被清空了");
  assert.deepEqual(out.hidden, ["plugins"], "隐藏项被清空了");
});

test("P0 回归：分区未知时 serialize 拒写（返回 null）", () => {
  assert.equal(T.serializeState(T.createState(SAVED), {}), null);
});

test("normalize：去重 + 把新分区追加到末尾", () => {
  const input = T.createState({
    order: ["general", "g-1", "general", "models"],
    groups: [{ id: "g-1", name: "常用", items: ["account", "account"] }],
    hidden: ["plugins", "plugins"],
  });
  const out = T.normalizeState(input, KNOWN, ORDER);
  assert.deepEqual(out.order, ["general", "g-1", "models", "plugins"]);
  assert.deepEqual(out.groups[0].items, ["account"], "重复成员要清掉");
  assert.deepEqual(out.hidden, ["plugins"], "重复隐藏项要清掉");
});

test("normalize：同一 id 同时出现在顶层与抽屉里时，以抽屉为准", () => {
  const input = T.createState({
    order: ["account", "general"],
    groups: [{ id: "g-1", items: ["account"] }],
    hidden: [],
  });
  const out = T.normalizeState(input, KNOWN, ORDER);
  assert.equal(out.order.indexOf("account"), -1, "已在抽屉里的 id 不该再占顶层的位置");
  assert.deepEqual(out.groups[0].items, ["account"]);
});

test("P0 同类隐患：只见到部分分区时，不得删掉尚未注册的分区", () => {
  // 启动早期 sections 只到一半（其它插件还没 apply）——此时裁剪就是静默丢数据
  const partial = T.knownIdsFrom([{ id: "general" }, { id: "account" }]);
  const saved = T.createState({
    order: ["models", "general", "g-1"],
    groups: [{ id: "g-1", items: ["plugins"] }],
    hidden: ["plugins"],
  });
  const out = T.normalizeState(saved, partial, ["general", "account"]);
  assert.deepEqual(out.order, ["models", "general", "g-1", "account"], "未见到的分区被误删了");
  assert.deepEqual(out.groups[0].items, ["plugins"], "未见到的抽屉成员被误删了");
  assert.deepEqual(out.hidden, ["plugins"], "未见到的隐藏项被误删了");

  // 而写盘时仍然只保留「此刻确实存在」的 id，已卸载插件的痕迹不会永久留存
  const payload = T.serializeState(out, KNOWN);
  assert.deepEqual(payload.order, ["models", "general", "g-1", "account"]);
  assert.deepEqual(payload.groups[0].items, ["plugins"]);
});

test("normalize：不在 order 里的抽屉补到末尾", () => {
  const input = T.createState({
    order: ["general"],
    groups: [{ id: "g-2", name: "B", items: ["models"] }],
    hidden: [],
  });
  const out = T.normalizeState(input, KNOWN, ORDER);
  assert.ok(out.order.includes("g-2"), "游离抽屉丢了：" + JSON.stringify(out.order));
  assert.ok(out.order.indexOf("g-2") > out.order.indexOf("general"));
});

test("serialize：只写已知 id，抽屉 id 不算脏数据", () => {
  const payload = T.serializeState(T.createState(SAVED), KNOWN);
  assert.deepEqual(payload.order, ["general", "g-1", "models"]);
  assert.deepEqual(payload.groups[0].items, ["account"]);
  assert.deepEqual(payload.hidden, ["plugins"]);

  // 未知 id 一律被写前过滤掉
  const dirty = T.serializeState(
    T.createState({ order: ["general", "ghost"], groups: [{ id: "g-1", items: ["ghost"] }], hidden: ["ghost"] }),
    KNOWN,
  );
  assert.deepEqual(dirty.order, ["general"]);
  assert.deepEqual(dirty.groups[0].items, []);
  assert.deepEqual(dirty.hidden, []);
});

test("applyDropTo：条目拖进抽屉", () => {
  const st = T.createState({ order: ["general", "models"], groups: [{ id: "g-1", items: [] }], hidden: [] });
  const out = T.applyDropTo(st, { id: "models", isGroup: false }, { type: "into-group", groupId: "g-1" });
  assert.deepEqual(out.order, ["general"]);
  assert.deepEqual(out.groups[0].items, ["models"]);
  assert.deepEqual(st.order, ["general", "models"], "入参状态不能被就地改动");
});

test("applyDropTo：条目插到某条目之前（顶层）", () => {
  const st = T.createState({ order: ["a", "b", "c"], groups: [], hidden: [] });
  const out = T.applyDropTo(st, { id: "c", isGroup: false }, { type: "insert-before", refType: "row", refId: "a", refGroup: null });
  assert.deepEqual(out.order, ["c", "a", "b"]);
});

test("applyDropTo：抽屉整体移动，成员跟随", () => {
  const st = T.createState({
    order: ["g-1", "a", "b"],
    groups: [{ id: "g-1", items: ["x"] }],
    hidden: [],
  });
  const out = T.applyDropTo(st, { id: "g-1", isGroup: true }, { type: "insert-before", refType: "row", refId: "b", refGroup: null });
  assert.deepEqual(out.order, ["a", "g-1", "b"]);
  assert.deepEqual(out.groups[0].items, ["x"], "抽屉成员不该被拖散");
});

test("applyDropTo：抽屉不能嵌抽屉（落点在抽屉头上→移到其前面）", () => {
  const st = T.createState({ order: ["g-1", "g-2"], groups: [{ id: "g-1", items: [] }, { id: "g-2", items: [] }], hidden: [] });
  const out = T.applyDropTo(st, { id: "g-2", isGroup: true }, { type: "into-group", groupId: "g-1" });
  assert.deepEqual(out.order, ["g-2", "g-1"]);
});

test("nudgeState：容器内换位，越界不动", () => {
  const st = T.createState({ order: ["a", "b"], groups: [{ id: "g-1", items: ["x", "y"] }], hidden: [] });
  assert.deepEqual(T.nudgeState(st, "b", -1).order, ["b", "a"]);
  assert.deepEqual(T.nudgeState(st, "a", -1).order, ["a", "b"], "首位上移应无变化");
  assert.deepEqual(T.nudgeState(st, "x", 1).groups[0].items, ["y", "x"], "组内也要能换位");
});

test("原型键安全：constructor / __proto__ 不能让真实分区被误判", () => {
  const known = T.knownIdsFrom([{ id: "general" }, { id: "models" }]);
  const st = T.createState({
    order: ["constructor", "general", "__proto__", "models"],
    groups: [{ id: "g-1", items: ["toString", "models"] }],
    hidden: ["constructor", "general"],
  });
  // 关键：不抛异常；真实 id 的判定不受原型键影响
  const out = T.normalizeState(st, known, ["general", "models"]);
  assert.ok(out.order.includes("general"), "general 被原型键顶掉了：" + JSON.stringify(out.order));
  assert.equal(out.order.indexOf("models"), -1, "models 应在抽屉里而不是顶层");
  assert.deepEqual(out.groups[0].items, ["toString", "models"], "组内成员不该被误删");
  assert.ok(out.hidden.includes("general"), "general 应仍被记为隐藏");

  // 写盘时把非真实分区（含原型键）一律过滤
  const payload = T.serializeState(out, known);
  assert.equal(payload.order.indexOf("constructor"), -1);
  assert.equal(payload.order.indexOf("__proto__"), -1);
  assert.deepEqual(payload.groups[0].items, ["models"]);
  assert.deepEqual(payload.hidden, ["general"]);
});

test("buildCss：关键选择器齐全（升级断链能靠这条守住）", () => {
  const css = T.buildCss();
  for (const sel of [
    "[data-snm-nav]",
    "[data-snm-editing=\"1\"] [data-snm-row]::after",
    "[data-snm-editing=\"0\"] [data-snm-row][data-snm-hidden=\"1\"]{display:none;}",
    "[data-snm-row][data-snm-in-group]",
    "[data-snm-add-group]",
    "[data-snm-reset]",
    "[data-snm-sr]",
  ]) {
    assert.ok(css.includes(sel), "CSS 缺少 " + sel);
  }
});

test("文案表：中英双语键集合一致", () => {
  assert.deepEqual(Object.keys(T.DICT.zh).sort(), Object.keys(T.DICT.en).sort());
});

test("inject 声明与宿主官方插件一致", () => {
  assert.deepEqual(plugin.inject, ["slots", "locale", "remote", "remote.settings"]);
});

test("isMissingEntry：只有「条目/命名空间不存在」类错误才允许换路重试", () => {
  // 允许：宿主换了条目 id、条目被移除、Config 丢了 volatile 字段
  for (const e of [
    { code: "SETTINGS_NO_ENTRY" },
    { code: "NOT_FOUND" },
    { error: { code: "NO_SUCH_NS" } },
    { message: 'No configurable plugin entry "settings-nav-manager"' },
    { message: "plugin entry has no volatile fields" },
  ]) {
    assert.equal(T.isMissingEntry(e), true, "应允许换路：" + JSON.stringify(e));
  }
  // 不允许：校验失败 / 配额 / 只读 / 权限 —— 换 replace 重试等于绕过宿主校验
  for (const e of [
    null,
    undefined,
    {},
    { code: "gateway/quota", message: "settings document quota exceeded" },
    { code: "SETTINGS_CONFLICT", message: "revision mismatch" },
    { code: "EACCES", message: "permission denied" },
    { message: "schema validation failed: order[0] must be string" },
  ]) {
    assert.equal(T.isMissingEntry(e), false, "不该换路：" + JSON.stringify(e));
  }
});

test("looksLikeOurValue：值形状不符的候选不得被认领", () => {
  const ok = { version: 1, order: ["a"], groups: [{ id: "g-1", name: "x", items: [] }], hidden: ["b"] };
  assert.equal(T.looksLikeOurValue(ok), true);
  assert.equal(T.looksLikeOurValue({ order: [], groups: [], hidden: [] }), true, "没有 version 也应认");
  for (const bad of [
    null,
    [],
    "x",
    { order: "not-an-array", groups: [], hidden: [] },
    { order: [], groups: {}, hidden: [] },
    { order: [], groups: [] },
    { version: 2, order: [], groups: [], hidden: [] },
    { order: [1], groups: [], hidden: [] },
    { order: [], groups: [], hidden: [null] },
  ]) {
    assert.equal(T.looksLikeOurValue(bad), false, "不该认：" + JSON.stringify(bad));
  }
});

test("looksLikeOurs：schema 指纹必须三键齐全", () => {
  assert.equal(T.looksLikeOurs({ schema: { dict: { order: {}, groups: {}, hidden: {} } } }), true);
  assert.equal(T.looksLikeOurs({ schema: { properties: { order: {}, groups: {}, hidden: {} } } }), true);
  assert.equal(T.looksLikeOurs({ schema: { dict: { order: {}, groups: {} } } }), false, "缺 hidden 不算");
  assert.equal(T.looksLikeOurs({ schema: {} }), false);
  assert.equal(T.looksLikeOurs(null), false);
  assert.equal(T.looksLikeOurs({}), false);
});

// ── 侧栏入口页：行投影 ─────────────────────────────────────────
test("flattenNav：未整理时按宿主 order 列出全部分区", () => {
  const rows = T.flattenNav(SECTIONS, T.createState(null));
  assert.deepEqual(
    rows.map((r) => r.id),
    ["general", "account", "models", "plugins"],
    "空状态必须回落到宿主 order",
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    ["通用", "账户", "模型", "插件"],
  );
  assert.ok(
    rows.every((r) => r.hidden === false && r.group === ""),
    "空状态不该带隐藏/抽屉标记",
  );
});

test("flattenNav：抽屉成员紧跟抽屉连续展开，并带上抽屉名", () => {
  const st = T.createState({
    order: ["general", "g-1", "plugins"],
    groups: [{ id: "g-1", name: "常用", items: ["models", "account"] }],
  });
  const rows = T.flattenNav(SECTIONS, st);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["general", "models", "account", "plugins"],
  );
  assert.equal(rows[1].group, "常用");
  assert.equal(rows[2].group, "常用");
  assert.equal(rows[0].group, "", "抽屉外的条目不该被标成组内");
});

test("flattenNav：隐藏标记透传，未知 id 被跳过，未落位分区追加到末尾", () => {
  const st = T.createState({
    order: ["ghost", "plugins"],
    groups: [],
    hidden: ["plugins", "also-gone"],
  });
  const rows = T.flattenNav(SECTIONS, st);
  assert.ok(!rows.some((r) => r.id === "ghost"), "宿主不存在的 id 不该渲染");
  assert.equal(rows[0].id, "plugins", "已落位的排在最前");
  assert.equal(rows[0].hidden, true);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["plugins", "general", "account", "models"],
    "未落位的按宿主 order 追加",
  );
});

test("flattenNav：同一个 id 在 order 里出现两次也只渲染一行", () => {
  const st = T.createState({ order: ["general", "general", "models"], groups: [] });
  const rows = T.flattenNav(SECTIONS, st);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["general", "models", "account", "plugins"],
  );
});

test("glyphOf：按码点取首字，中文与 emoji 都不会被截断", () => {
  assert.equal(T.glyphOf("通用设置"), "通");
  assert.equal(T.glyphOf("🤖 模型"), "🤖");
  assert.equal(T.glyphOf(""), "?");
  assert.equal(T.glyphOf(null), "?");
});

test("buildCss：侧栏入口页的选择器齐全", () => {
  const css = T.buildCss();
  for (const sel of [
    "[data-snm-page]{",
    "[data-snm-page-row]{",
    "[data-snm-page-row]:focus-visible",
    "[data-snm-page-glyph]",
    "[data-snm-page-badge]",
    "[data-snm-page-empty]",
    "[data-snm-page-item]",
    "[data-snm-page-pin]",
    '[data-snm-page-pin][data-snm-page-pin-state="1"]',
  ]) {
    assert.ok(css.includes(sel), "CSS 缺少 " + sel);
  }
});

test("侧栏入口 id：main 与 sidebar.panellist 必须用同一个 key", () => {
  // layout 用 `entries("main").some(e => e.options.key === id)` 判定面板存在，
  // sidebar 用 panellist 的 id 切过去 —— 两者一旦不一致就是点击抛错。
  assert.equal(T.PANEL_ID, "settings-nav-manager.nav", "id 要带命名空间，别占用宿主的短名");
  assert.equal(T.ENTRY_ORDER, 20, "order 要排在 plugins(0)/schedules(10) 之后，且不抢 30+ 的位置");
  assert.ok(SRC.includes('"sidebar.panellist"'), "缺少侧栏入口注册");
  assert.ok(SRC.includes('name: "main"'), "缺少 main 页面注册");
  assert.ok(SRC.includes("key: PANEL_ID"), "main 注册必须带 key: PANEL_ID");
  assert.ok(SRC.includes("id: PANEL_ID"), "panellist 注册必须带 id: PANEL_ID");
});

test("cleanText：分区名是宿主给的，双向控制符必须被去掉", () => {
  // 尖括号由 React 当文本转义，不归这里管；这里只压控制符 ——
  // U+202E 这类字符能让「模型」显示成反序，属于实打实的伪装（审查 SEC-4）。
  assert.equal(T.cleanText("通用设置"), "通用设置");
  assert.equal(T.cleanText("通\u202e用"), "通用", "U+202E 必须剔除");
  assert.equal(T.cleanText("a\u200bb"), "ab", "零宽字符必须剔除");
  assert.equal(T.cleanText("a\u0007b"), "ab", "C0 控制字符必须剔除");
  assert.equal(T.cleanText(null), "", "非字符串不崩");
  assert.equal(T.cleanText(123), "", "非字符串一律返回空串");
});


// ── 侧栏入口开关：hideEntry 要能存、能读、不误伤老数据 ──────────
test("hideEntry：缺省为 false，只有严格 true 才算隐藏", () => {
  assert.equal(T.createState(null).hideEntry, false);
  assert.equal(T.createState({}).hideEntry, false, "老版本没有这个字段 → 显示");
  assert.equal(T.createState({ hideEntry: true }).hideEntry, true, "重启后要能记住隐藏态");
  assert.equal(T.createState({ hideEntry: 1 }).hideEntry, false, "脏值不当作隐藏，避免入口消失后找不回");
  assert.equal(T.createState({ hideEntry: "true" }).hideEntry, false);
});

test("hideEntry：归一化与写盘都要带上，且不受 known id 域影响", () => {
  const st = T.createState({ hideEntry: true, order: ["general", "ghost"] });
  const known = { general: 1, account: 1 };
  const normalized = T.normalizeState(st, known, ["general", "account"]);
  assert.equal(normalized.hideEntry, true, "归一化不能把开关丢了");

  const payload = T.serializeState(normalized, known);
  assert.equal(payload.hideEntry, true);
  assert.deepEqual(payload.order, ["general", "account"], "未知 id 被过滤，未落位分区按宿主顺序补齐");
  // known 为空 = 拒绝写入，这条老规则不能被新字段绕过
  assert.equal(T.serializeState(normalized, {}), null);
});

test("hideEntry：恢复默认后入口必须重新出现", () => {
  assert.equal(T.createState({ hideEntry: true }).hideEntry, true);
  assert.equal(T.createState(null).hideEntry, false, "恢复默认 = 侧栏入口重新显示");
});

// ── 阶段 2：固定分区到侧栏 ─────────────────────────────────────
test("pinnedIds：去重、去隐藏、去未知，已知集合为空时不裁剪", () => {
  const st = T.createState({ pinned: ["general", "general", "plugins", "ghost"], hidden: ["plugins"] });
  assert.deepEqual(T.pinnedIds(st, KNOWN), ["general"], "plugins 被隐藏、ghost 不存在，都该剔掉");
  assert.deepEqual(
    T.pinnedIds(st, {}),
    ["general", "ghost"],
    "冷启动 known 为空：只按隐藏剔除，不误删还没注册的分区",
  );
  assert.deepEqual(T.pinnedIds(T.createState(null), KNOWN), [], "老数据没有 pinned 也不能崩");
  assert.deepEqual(T.pinnedIds({ pinned: "nope" }, KNOWN), [], "非数组容错");
});

test("togglePinnedState：切换要返回新对象，不改原状态", () => {
  const base = T.createState({ order: ["general", "models"] });
  const on = T.togglePinnedState(base, "models", KNOWN);
  assert.equal(on.reason, "pinned");
  assert.deepEqual(on.state.pinned, ["models"]);
  assert.deepEqual(base.pinned, [], "原状态被就地改了（会破坏 publish/undo 的一致性）");
  assert.deepEqual(on.state.order, base.order, "固定不该动顺序");

  const off = T.togglePinnedState(on.state, "models", KNOWN);
  assert.equal(off.reason, "unpinned");
  assert.deepEqual(off.state.pinned, []);
});

test("togglePinnedState：上限、隐藏、未知三种拒绝都要带 reason", () => {
  const five = ["general", "account", "models", "plugins", "a"];
  const known5 = { general: 1, account: 1, models: 1, plugins: 1, a: 1, b: 1 };
  const hitLimit = T.togglePinnedState(T.createState({ pinned: five }), "b", known5);
  assert.equal(hitLimit.reason, "limit", "第 6 个就该被上限拦下");
  assert.equal(hitLimit.state.pinned.length, 5, "拒绝时不能悄悄写进去");

  const hidden = T.togglePinnedState(T.createState({ hidden: ["plugins"] }), "plugins", KNOWN);
  assert.equal(hidden.reason, "hidden");

  const unknown = T.togglePinnedState(T.createState(null), "ghost", KNOWN);
  assert.equal(unknown.reason, "unknown");

  const emptyKnown = T.togglePinnedState(T.createState(null), "ghost", {});
  assert.equal(emptyKnown.reason, "pinned", "分区还没注册完时不该把固定操作判死");
});

test("togglePinnedState：上限就是 MAX_PINNED，别写死第二个数", () => {
  const ids = ["general", "account", "models", "plugins", "a", "b"];
  const known = {};
  for (const id of ids) known[id] = 1;
  let st = T.createState(null);
  let accepted = 0;
  for (const id of ids) {
    const res = T.togglePinnedState(st, id, known);
    if (res.reason === "pinned") {
      accepted++;
      st = res.state;
    }
  }
  assert.equal(accepted, T.MAX_PINNED);
  assert.equal(st.pinned.length, T.MAX_PINNED);
});

test("labelOf：按 id 实时取名字，取不到就退回 id", () => {
  assert.equal(T.labelOf(SECTIONS, "models"), "模型");
  assert.equal(T.labelOf(SECTIONS, "ghost"), "ghost");
  assert.equal(T.labelOf([], "models"), "models", "分区还没注册时不能抛");
});

test("固定行的注册契约：id/order 都得让开宿主短名与入口位", () => {
  assert.ok(T.PIN_ORDER_BASE > T.ENTRY_ORDER, "固定行要排在「设置导航」入口之后");
  assert.ok(T.PIN_ID_PREFIX.length > 0);
  assert.ok(!T.PIN_ID_PREFIX.startsWith("settings-nav-manager."), "固定行 id 不该冒充面板 id");
  assert.ok(SRC.includes('ctx.slots.inject("main"'), "固定行必须配兜底 main 页，否则 selectPanel 会抛");
  assert.ok(SRC.includes('ctx.slots.inject("sidebar.panellist"'), "缺少固定行的侧栏注册");
  assert.ok(SRC.includes('document.addEventListener("click"'), "缺少点击拦截");
});

test("pinned 也要进写盘载荷：否则固定行重启就没了", () => {
  const st = T.normalizeState(T.createState({ pinned: ["models", "ghost"] }), KNOWN, ORDER);
  assert.deepEqual(st.pinned, ["models", "ghost"], "与 order 同策略：没见到的分区先留着，写盘前再清");
  const payload = T.serializeState(st, KNOWN);
  assert.deepEqual(payload.pinned, ["models"], "未知分区不落盘");
});

test("pinned：被隐藏的分区自动取消固定", () => {
  const st = T.normalizeState(
    T.createState({ pinned: ["plugins", "models"], hidden: ["plugins"] }),
    KNOWN,
    ORDER,
  );
  assert.deepEqual(st.pinned, ["models"], "隐藏项不能留在侧栏上（方案 §3.3）");
  assert.equal(T.serializeState(st, KNOWN).pinned.length, 1);
});


