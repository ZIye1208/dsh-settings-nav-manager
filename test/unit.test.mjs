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
    assert.deepEqual(s, { version: 1, order: [], groups: [], hidden: [] });
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
