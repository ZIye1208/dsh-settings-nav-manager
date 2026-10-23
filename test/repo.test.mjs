// 仓库级校验：清单声明、文案一致性、源码卫生。
// 这些断言都很便宜，但它们守住的是「一改就静默失效」的那几处：
// platform 必须写 web、命名空间必须等于条目 id、文案不能两套、别再用 innerHTML。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const SRC = read("client.js");
const PKG = readJson("package.json");
const PATCH = read("cordis.patch.yml");

function loadDict() {
  let mod = null;
  const win = { __ModuleLoader__: { load: (m) => (mod = m) } };
  new Function("window", "document", "console", SRC)(win, undefined, console);
  const react = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {} };
  return mod.factory((n) => (n === "react" ? react : (() => { throw new Error(n); })())).__test.DICT;
}
const DICT = loadDict();

test("manifest：platform 必须写 web（桌面版也读这个值）", () => {
  assert.equal(PKG.dsh.client.platform, "web");
});

test("manifest：client 入口与 files 白名单齐全", () => {
  assert.equal(PKG.exports["./client"], "./client.js");
  assert.equal(PKG.dsh.bundle.patch, "./cordis.patch.yml");
  for (const f of ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]) {
    assert.ok(PKG.files.includes(f), "files 缺少 " + f);
  }
  assert.ok(PKG.files.includes("assets/demo.gif"), "README 用的演示图应随包发布");
});

test("manifest：兼容范围必须收紧到实测过的版本带", () => {
  const range = PKG.dsh.compatibility.dsh;
  assert.ok(/<\s*0\.3\.0/.test(range), "缺少上界：" + range);
});

test("manifest：运行时依赖只留真正用到的（不多装、不少装）", () => {
  const deps = Object.keys(PKG.dependencies || {});
  assert.deepEqual(deps, ["@deepseek-ai/schemastery"], "依赖清单不对：" + deps.join(", "));
  // 这两个从未被引用；schemastery 不能降级成 peer —— profile 里那份 @deepseek-ai/*
  // 是断链符号链接，宿主也没有可解析副本，peer 会让 index.js 直接加载失败。
  for (const unused of ["@deepseek-ai/cosmokit", "@standard-schema/spec"]) {
    assert.ok(!deps.includes(unused), unused + " 已不再使用，应移除");
  }
});

test("命名空间必须等于 cordis.patch.yml 的条目 id（否则写设置会抛错）", () => {
  const m = /id:\s*([\w.-]+)/.exec(PATCH);
  assert.ok(m, "cordis.patch.yml 里没找到 id");
  assert.equal(m[1], "settings-nav-manager");
  assert.ok(SRC.includes('var NS = "settings-nav-manager"'));
});

test("文案单一来源：locale/*.json 与 client.js 的 DICT 完全一致", () => {
  for (const lang of ["zh", "en"]) {
    const json = readJson("locale/" + lang + ".json");
    const { meta, ...dict } = json;
    assert.ok(meta && meta.title, lang + ".json 缺 meta.title");
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(DICT[lang]).sort(), lang + ".json 键集合漂移，请跑 npm run locale");
    for (const k of Object.keys(DICT[lang])) {
      assert.equal(dict[k], DICT[lang][k], lang + "." + k + " 文案不一致，请跑 npm run locale");
    }
  }
});

test("源码卫生：没有 DOM 注入与动态求值", () => {
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "new Function", "document.write"]) {
    assert.ok(!SRC.includes(bad), "client.js 不应出现 " + bad);
  }
});

test("源码卫生：不拼接用户数据的 CSS 选择器", () => {
  const risky = /\[data-snm-[\w-]+="'?\s*\+/.test(SRC);
  assert.equal(risky, false, "仍存在属性选择器拼接，id 里的引号会让 querySelector 抛错");
});

test("源码卫生：集合容器必须无原型（避免 id 撞 constructor/__proto__）", () => {
  assert.ok(SRC.includes("Object.create(null)"), "缺少无原型字典工具");
  assert.equal(/=\s*\{\};\s*\/\/[^\n]*集合/.test(SRC), false);
});

test("健壮性：拖拽中断与冲突处理的关键代码在", () => {
  assert.ok(SRC.includes('"pointercancel"'), "缺少 pointercancel 兜底");
  assert.ok(SRC.includes("SETTINGS_CONFLICT"), "缺少设置冲突处理");
  assert.ok(SRC.includes("if (!known") || SRC.includes("countKeys(known) === 0"), "缺少「分区未知不裁剪」的守卫");
});

test("无障碍：齿轮与抽屉头带可访问名与键盘语义", () => {
  assert.ok(SRC.includes('"aria-pressed"'), "齿轮缺 aria-pressed");
  assert.ok(SRC.includes('"aria-label"'), "缺 aria-label");
  assert.ok(SRC.includes('header.setAttribute("role", "button")'), "抽屉头缺 role=button");
  assert.ok(SRC.includes('"aria-expanded"'), "抽屉头缺 aria-expanded");
  assert.ok(SRC.includes("aria-live"), "缺 aria-live 状态播报");
});

test("安全：源码不出现凭据类字样", () => {
  for (const bad of ["Bearer ", "apiKey", "api_key", "password", "accessToken", "secretKey"]) {
    assert.ok(!SRC.includes(bad), "疑似凭据痕迹：" + bad);
  }
});

test("CHANGELOG 版本号与 package.json 一致", () => {
  const log = read("CHANGELOG.md");
  assert.ok(log.includes("## " + PKG.version), "CHANGELOG 未记录当前版本 " + PKG.version);
});
