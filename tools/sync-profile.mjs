// 把当前源码同步进本机 DSH profile 的已安装副本（开发用，不随 npm 包发布）。
//
// 背景：`dsh plugin add` 把插件装成 node_modules 下的**拷贝**（不是软链），
// 所以改完源码不重新安装，桌面端跑的还是旧代码。这个脚本按 package.json 的
// `files` 白名单做增量同步，避开 test/ tools/ assets/ node_modules/。
//
// 用法：
//   node tools/sync-profile.mjs              # 同步到 desktop（默认）
//   node tools/sync-profile.mjs web          # 同步到 web
//   node tools/sync-profile.mjs desktop -n   # 只看会改什么，不落地
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const args = process.argv.slice(2);
const dryRun = args.includes("-n") || args.includes("--dry-run");
const profile = args.find((a) => !a.startsWith("-")) || "desktop";

const target = join(homedir(), ".dsh", "profiles", profile, "node_modules", PKG.name);

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

if (!existsSync(target)) {
  die(
    "找不到已安装的 " + PKG.name + "：\n  " + target + "\n" +
      "先执行：dsh plugin --profile " + profile + " add " + ROOT + "\n" +
      "（或者确认 profile 名是不是 " + profile + "）",
  );
}

// ── 收集要同步的文件（package.json 的 files 白名单 + 清单本身）──
const wanted = [];
function expand(rel) {
  const abs = join(ROOT, rel);
  if (rel.includes("*")) {
    const dir = join(ROOT, dirname(rel));
    const suffix = rel.slice(rel.indexOf("*") + 1); // 例如 "/zh.json" 或 ".json"
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!suffix || name.endsWith(suffix.replace(/^\*/, ""))) wanted.push(join(rel.slice(0, rel.indexOf("*")), name));
    }
    return;
  }
  if (existsSync(abs) && statSync(abs).isFile()) wanted.push(rel);
}
for (const entry of PKG.files || []) expand(entry);
// npm 打包时总会带上这几个，files 白名单里通常不写，但要一起同步
for (const rel of ["package.json", "README.md", "LICENSE"]) expand(rel);

// ── 备份整份已安装副本（小目录，图个安心）──
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const backupRoot = join(homedir(), ".dsh", "profiles", profile, ".snm-sync-backup", stamp);

function md5(file) {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

function copyTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

if (!dryRun) {
  copyTree(target, backupRoot);
  console.log("备份 → " + backupRoot);
}

// ── 同步 + 差异表 ──
const rows = [];
for (const rel of wanted.sort()) {
  const src = join(ROOT, rel);
  const dst = join(target, rel.split("/").join(sep));
  const before = existsSync(dst) ? md5(dst) : "(不存在)";
  const after = md5(src);
  const same = before === after;
  rows.push({ rel, same, before: before.slice(0, 8), after: after.slice(0, 8) });
  if (same || dryRun) continue;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
console.log("\n" + pad("文件", 22) + pad("状态", 10) + "md5");
for (const r of rows) {
  console.log(pad(r.rel, 22) + pad(r.same ? "一致" : dryRun ? "待更新" : "已更新", 10) + r.before + " → " + r.after);
}
const changed = rows.filter((r) => !r.same).length;
console.log(
  "\n" + (dryRun ? "（演练，未落地）" : "") + "目标：" + target + "\n" +
    "版本 " + PKG.version + "，共 " + rows.length + " 个文件，需更新 " + changed + " 个" +
    (changed && !dryRun ? "\n下一步：完全退出并重开 DSH 桌面应用，再打开 设置 验证。" : ""),
);
