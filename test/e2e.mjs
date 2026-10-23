// 端到端测试驱动：本地静态服务 + 无头 Chrome + CDP。
// 用法：node test/e2e.mjs [--keep]
//
// 会做两轮：v=old（git HEAD 的 client.js）与 v=new（工作区 client.js），
// 并要求「新版全绿」且「标注 oldFails 的用例在旧版上确实 FAIL」——
// 否则说明断言没有咬住问题，属于无效测试。
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const HARNESS = join(ROOT, "test", "harness");
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function log(s) {
  process.stdout.write(s + "\n");
}

// ── 准备待测文件 ──────────────────────────────────────────────
async function prepare() {
  await mkdir(HARNESS, { recursive: true });
  await writeFile(join(HARNESS, "under-test.js"), await readFile(join(ROOT, "client.js"), "utf8"), "utf8");
  // 基线用「初始提交」（对外的 1.0.0），而不是 HEAD —— 否则 A/B 变成跟上一版自己比
  const baseRef =
    process.env.BASE_REF ||
    execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n")[0];
  let legacy;
  try {
    legacy = execFileSync("git", ["show", baseRef + ":client.js"], { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    throw new Error("无法从基线 " + baseRef + " 取 client.js：" + e.message);
  }
  log("基线版本: " + baseRef.slice(0, 7) + "（初始提交）");
  await writeFile(join(HARNESS, "legacy.js"), legacy, "utf8");
}

// ── 静态服务 ─────────────────────────────────────────────────
function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = join(ROOT, rel);
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port }));
  });
}

// ── 极简 CDP 客户端 ──────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) fn(msg.params);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", () => fail(new Error("CDP 连接失败")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitPort(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("CDP 端口未就绪: " + url);
}

async function runRound(cdp, port, version) {
  const url = `http://127.0.0.1:${port}/test/harness/index.html?v=${version}`;
  const loaded = new Promise((ok) => cdp.on("Page.loadEventFired", ok));
  await cdp.send("Page.navigate", { url });
  await loaded;
  // 等 client 脚本就位
  for (let i = 0; i < 60; i++) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: "!!window.__mod || window.__loadError || false",
      returnByValue: true,
    });
    if (r.result.value) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const res = await cdp.send("Runtime.evaluate", {
    expression: "window.__runAll()",
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  if (res.exceptionDetails) throw new Error("页面内异常: " + JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

async function main() {
  const keep = process.argv.includes("--keep");
  await prepare();
  const { server, port } = await serve();

  const profile = join(tmpdir(), "snm-e2e-" + Date.now());
  await mkdir(profile, { recursive: true });
  const dbgPort = 9333 + Math.floor(Math.random() * 200);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--window-size=1200,900",
      "--remote-debugging-port=" + dbgPort,
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let exitCode = 1;
  let cdp = null;
  try {
    const targets = await waitPort(`http://127.0.0.1:${dbgPort}/json/list`);
    const page = targets.find((t) => t.type === "page") || targets[0];
    if (!page) throw new Error("没有可用的页面 target");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const print = (r) => {
      for (const c of r.results) log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "\n        → " + c.detail}`);
    };
    log("\n== 旧版（git HEAD，应大面积 FAIL）==");
    const old = await runRound(cdp, port, "old");
    print(old);
    log("\n== 新版（工作区，应全 PASS）==");
    const now = await runRound(cdp, port, "new");
    print(now);
    if (now.errors && now.errors.length) log("  页面报错: " + now.errors.join(" | "));

    const oldMap = new Map(old.results.map((c) => [c.name, c]));
    const newFails = now.results.filter((c) => !c.pass);
    const missed = now.results.filter((c) => {
      if (!c.oldFails) return false;
      const o = oldMap.get(c.name);
      return o && o.pass; // 标注了「旧版应失败」却在旧版通过了 → 断言无效
    });

    log("\n== 汇总 ==");
    log(`  新版通过 ${now.results.length - newFails.length}/${now.results.length}`);
    log(`  A/B 有效断言：${now.results.filter((c) => c.oldFails).length - missed.length} 条标注，${
      now.results.filter((c) => c.oldFails && oldMap.get(c.name) && !oldMap.get(c.name).pass).length
    } 条在旧版确实失败`);

    if (newFails.length) {
      log("\n新版仍有失败用例 → 退出码 1");
      exitCode = 1;
    } else if (missed.length) {
      log("\n以下断言在旧版也通过，说明没咬住问题：" + missed.map((c) => c.name).join(" / "));
      exitCode = 1;
    } else {
      log("\n全部通过，且 A/B 对照有效。");
      exitCode = 0;
    }
  } catch (e) {
    log("E2E 执行失败: " + (e && e.stack ? e.stack : e));
    exitCode = 1;
  } finally {
    if (cdp && !keep) cdp.close();
    try {
      chrome.kill();
    } catch {}
    server.close();
    if (!keep) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      await rm(join(HARNESS, "under-test.js"), { force: true }).catch(() => {});
      await rm(join(HARNESS, "legacy.js"), { force: true }).catch(() => {});
    }
    setTimeout(() => process.exit(exitCode), 200);
  }
}

main();
