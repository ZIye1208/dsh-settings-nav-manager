// 由 client.js 的 DICT 生成 locale/*.json（单一事实来源）。
// 用法：node tools/gen-locale.mjs
// 之后 test/repo.test.mjs 会校验两者一致，防止再次漂移。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "client.js"), "utf8");

let mod = null;
const win = { __ModuleLoader__: { load: (m) => (mod = m) } };
new Function("window", "document", "console", SRC)(win, undefined, console);
const react = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {} };
const plugin = mod.factory((n) => (n === "react" ? react : (() => { throw new Error(n); })()));
const DICT = plugin.__test.DICT;

const META = {
  zh: { title: "设置导航管理", description: "对设置页的导航页签进行排序、显隐与分组管理。" },
  en: { title: "Settings navigation manager", description: "Reorder, hide and group the settings navigation tabs." },
};

for (const lang of Object.keys(DICT)) {
  const out = { meta: META[lang], ...DICT[lang] };
  const file = join(ROOT, "locale", lang + ".json");
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("wrote", file, Object.keys(DICT[lang]).length, "keys");
}
