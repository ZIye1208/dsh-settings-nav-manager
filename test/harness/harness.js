// 端到端测试台：用真实 Chrome 复刻宿主设置页 DOM + 最小 React 运行时，
// 让插件以「出厂方式」跑起来（__ModuleLoader__ → factory → apply(ctx)），
// 再用真实 PointerEvent / KeyboardEvent 驱动交互。
// 目的：把「重启后丢数据」「拖拽卡死」「键盘不可达」这类只能在真浏览器里
// 暴露的问题变成可断言的结果，并对旧版本做 A/B 对照。
(function () {
  "use strict";

  var SECTIONS = [
    { id: "general", order: 0, label: "通用" },
    { id: "account", order: 1, label: "账户" },
    { id: "models", order: 2, label: "模型" },
    { id: "plugins", order: 3, label: "插件" },
  ];
  // 磁盘上「上次保存」的排版：拖过序、有抽屉、隐藏了一项
  var SAVED = {
    version: 1,
    order: ["general", "g-1", "models"],
    groups: [{ id: "g-1", name: "常用", collapsed: false, items: ["account"] }],
    hidden: ["plugins"],
  };

  var env = { disposers: [], store: null };
  var hookState = [];
  var hookCursor = 0;
  var effectRan = {};
  var mounted = { Component: null, container: null, queued: false };

  function clone(x) {
    return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  // ── 宿主 settings 远端（带 revision + 冲突语义）──────────────
  function makeStore(initial, revision) {
    var st = {
      value: initial ? clone(initial) : null,
      revision: typeof revision === "number" ? revision : 1,
      writes: [],
      attempts: [],
      failNext: null,
    };
    st.describe = function () {
      return {
        writable: true,
        hasDocument: true,
        namespaces: [
          { ns: "settings-nav-manager", value: st.value ? clone(st.value) : undefined, revision: st.revision },
        ],
      };
    };
    st.update = function (ns, patch, expected) {
      st.writes.push(clone(patch));
      st.attempts.push({ expected: expected });
      if (st.failNext) {
        var f = st.failNext;
        st.failNext = null;
        var err = new Error(f.message || "boom");
        if (f.code) err.code = f.code;
        return Promise.reject(err);
      }
      if (typeof expected === "number" && expected !== st.revision) {
        var ce = new Error("settings namespace changed");
        ce.code = "SETTINGS_CONFLICT";
        return Promise.reject(ce);
      }
      st.value = clone(patch);
      st.revision++;
      return Promise.resolve({ ns: ns, value: clone(patch), revision: st.revision });
    };
    return st;
  }

  // ── 最小 React 运行时：能 render / useState / useEffect ──────
  function rerender() {
    if (!mounted.Component || !mounted.container) return;
    if (mounted.queued) return;
    mounted.queued = true;
    Promise.resolve().then(function () {
      mounted.queued = false;
      hookCursor = 0;
      var node = renderNode(mounted.Component());
      mounted.container.textContent = "";
      mounted.container.appendChild(node);
    });
  }
  var ReactShim = {
    createElement: function (type, props) {
      var children = [];
      for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);
      return { __el: true, type: type, props: props || {}, children: children };
    },
    useState: function (init) {
      var i = hookCursor++;
      if (!(i in hookState)) hookState[i] = typeof init === "function" ? init() : init;
      return [
        hookState[i],
        function (next) {
          var val = typeof next === "function" ? next(hookState[i]) : next;
          if (val !== hookState[i]) {
            hookState[i] = val;
            rerender();
          }
        },
      ];
    },
    useEffect: function (fn) {
      var i = 5000 + hookCursor++;
      if (!effectRan[i]) {
        effectRan[i] = true;
        var cleanup = fn();
        if (typeof cleanup === "function") env.disposers.push(cleanup);
      }
    },
  };

  function renderNode(node) {
    if (node === null || node === undefined || node === false || node === true) return document.createTextNode("");
    if (typeof node === "string" || typeof node === "number") return document.createTextNode(String(node));
    if (Array.isArray(node)) {
      var frag = document.createDocumentFragment();
      node.forEach(function (child) {
        frag.appendChild(renderNode(child));
      });
      return frag;
    }
    var el = document.createElement(node.type);
    Object.keys(node.props).forEach(function (k) {
      var v = node.props[k];
      if (k === "children") return;
      if (k === "style") {
        Object.keys(v).forEach(function (p) {
          el.style[p] = v[p];
        });
        return;
      }
      if (k === "onClick") {
        el.addEventListener("click", v);
        return;
      }
      if (k === "className") {
        el.className = v;
        return;
      }
      el.setAttribute(k, v);
    });
    node.children.forEach(function (child) {
      el.appendChild(renderNode(child));
    });
    return el;
  }

  // ── 假设置面板（结构与宿主一致：portal 到 body 的直接子节点）──
  function buildPanel() {
    var panel = document.createElement("div");
    panel.setAttribute("data-shortcut-modal", "settings");
    var nav = document.createElement("div");
    nav.className = "xx_nav";
    var title = document.createElement("div");
    title.className = "xx_navTitle";
    title.textContent = "设置";
    var list = document.createElement("div");
    list.className = "xx_navList";
    SECTIONS.forEach(function (sec) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "xx_navCell";
      btn.setAttribute("data-section", sec.id);
      var icon = document.createElement("span");
      icon.className = "xx_navIcon";
      icon.style.width = "16px";
      icon.style.height = "16px";
      var label = document.createElement("span");
      label.className = "xx_navLabel";
      label.textContent = sec.label;
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener("click", function () {
        selectRow(sec.id);
      });
      list.appendChild(btn);
    });
    nav.appendChild(title);
    nav.appendChild(list);
    var content = document.createElement("div");
    content.className = "xx_content";
    var header = document.createElement("div");
    header.className = "xx_header";
    var actions = document.createElement("div");
    actions.className = "xx_actions";
    header.appendChild(actions);
    content.appendChild(header);
    panel.appendChild(nav);
    panel.appendChild(content);
    return panel;
  }
  function selectRow(id) {
    panelCells().forEach(function (c) {
      c.removeAttribute("aria-current");
    });
    var hit = panelCells().filter(function (c) {
      return c.getAttribute("data-section") === id;
    })[0];
    if (hit) hit.setAttribute("aria-current", "true");
  }

  function panelEl() {
    return document.querySelector('[data-shortcut-modal="settings"]');
  }
  function navList() {
    var p = panelEl();
    return p ? p.querySelector('[class*="navList"]') : null;
  }
  function panelCells() {
    var n = navList();
    if (!n) return [];
    return Array.prototype.slice.call(n.querySelectorAll(':scope > [class*="navCell"]'));
  }
  function cellBySection(id) {
    return panelCells().filter(function (c) {
      return c.getAttribute("data-section") === id;
    })[0];
  }
  function gearBtn() {
    return document.querySelector("[data-snm-gear]");
  }

  // ── 事件模拟 ────────────────────────────────────────────────
  function pointer(type, el, x, y) {
    var r = el.getBoundingClientRect();
    var ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: typeof x === "number" ? x : r.left + r.width / 2,
      clientY: typeof y === "number" ? y : r.top + r.height / 2,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    });
    el.dispatchEvent(ev);
  }
  function clickAt(el, x, y) {
    var r = el.getBoundingClientRect();
    var cx = typeof x === "number" ? x : r.left + r.width / 2;
    var cy = typeof y === "number" ? y : r.top + r.height / 2;
    pointer("pointerdown", el, cx, cy);
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0 }),
    );
    pointer("pointerup", el, cx, cy);
  }
  function keyOn(el, key, opts) {
    var o = opts || {};
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: key,
        code: o.code || key,
        bubbles: true,
        cancelable: true,
        altKey: !!o.altKey,
        ctrlKey: !!o.ctrlKey,
        metaKey: !!o.metaKey,
      }),
    );
  }

  // ── 装配 ────────────────────────────────────────────────────
  // 面板是「打开设置」时才插进 DOM 的，齿轮只能等容器出现后再挂载
  function mountGear() {
    if (!mounted.Component) return false;
    var container = document.querySelector(".xx_actions");
    if (!container) return false;
    if (mounted.container === container && container.firstChild) return true;
    mounted.container = container;
    hookCursor = 0;
    container.textContent = "";
    container.appendChild(renderNode(mounted.Component()));
    return true;
  }

  async function openPanel() {
    document.body.appendChild(buildPanel());
    await sleep(60);
    mountGear();
    await sleep(60);
  }

  function makeCtx() {
    return {
      locale: {
        bind: function () {
          return function (k) {
            return k;
          };
        },
        register: function () {
          return function () {};
        },
      },
      effect: function (fn) {
        var d = fn();
        if (typeof d === "function") env.disposers.push(d);
      },
      slots: {
        entries: function () {
          return SECTIONS.map(function (s) {
            return { options: { id: s.id, order: s.order, label: s.label } };
          });
        },
        inject: function (name, cb) {
          return cb();
        },
        register: function (spec, Component) {
          mounted.Component = Component;
          mountGear();
          return function () {};
        },
      },
      remote: { settings: env.store },
    };
  }

  function applyFresh() {
    var mod = window.__mod;
    if (!mod) throw new Error("client 未加载：" + (window.__loadError || "unknown"));
    var ex = mod.factory(function (name) {
      if (name === "react") return ReactShim;
      throw new Error("unexpected require: " + name);
    });
    ex.apply(makeCtx());
    return ex;
  }

  async function resetEnv() {
    while (env.disposers.length) {
      try {
        env.disposers.pop()();
      } catch (e) {
        /* 旧版本没有 dispose，忽略 */
      }
    }
    var p = panelEl();
    if (p) p.remove();
    Array.prototype.slice.call(document.querySelectorAll("style[data-plugin-css]")).forEach(function (s) {
      s.remove();
    });
    hookState = [];
    hookCursor = 0;
    effectRan = {};
    mounted.Component = null;
    mounted.container = null;
  }

  async function enterEditing() {
    mountGear();
    var g = gearBtn();
    assert(g, "齿轮按钮未渲染");
    g.click();
    await sleep(40);
  }

  // ── 场景 ────────────────────────────────────────────────────
  var scenarios = [];

  scenarios.push({
    name: "P0 · 冷启动后不改写已保存的排版",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh(); // 面板尚未挂载 —— 等价于 DSH 刚启动
      await sleep(80);
      await openPanel(); // 用户打开设置
      await enterEditing();
      var cell = panelCells()[0];
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2); // 点第一行眼睛
      await sleep(120);
      var w = env.store.value || {};
      var items = w.groups && w.groups[0] ? w.groups[0].items : [];
      assert(items.indexOf("account") >= 0, "抽屉成员 account 被丢了：" + JSON.stringify(w.groups));
      assert((w.hidden || []).indexOf("plugins") >= 0, "隐藏项 plugins 被丢了：" + JSON.stringify(w.hidden));
      assert((w.order || []).indexOf("models") >= 0, "自定义顺序被丢了：" + JSON.stringify(w.order));
      return "写入=" + JSON.stringify(w);
    },
  });

  scenarios.push({
    name: "眼睛开关：点右侧切换 data-snm-hidden",
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("general");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(80);
      assert(cell.getAttribute("data-snm-hidden") === "1", "点眼睛后该行未标隐藏");
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(80);
      assert(cell.getAttribute("data-snm-hidden") !== "1", "再点一次未恢复显示");
      return "hidden=" + JSON.stringify(env.store.value.hidden);
    },
  });

  scenarios.push({
    name: "拖拽排序：把「模型」拖到第一位",
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var from = cellBySection("models");
      var to = cellBySection("general");
      var fr = from.getBoundingClientRect();
      var tr = to.getBoundingClientRect();
      var x = fr.left + 40;
      pointer("pointerdown", from, x, fr.top + fr.height / 2);
      pointer("pointermove", from, x, fr.top + fr.height / 2 + 20);
      await sleep(40);
      pointer("pointermove", from, x, tr.top + 2);
      await sleep(60);
      pointer("pointerup", from, x, tr.top + 2);
      await sleep(120);
      var order = (env.store.value || {}).order || [];
      assert(order[0] === "models", "拖到首位后 order[0] 应为 models，实际 " + JSON.stringify(order));
      return "order=" + JSON.stringify(order);
    },
  });

  scenarios.push({
    name: "拖拽被中断（窗口失焦）要回滚且不留拖拽态",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var from = cellBySection("models");
      var to = cellBySection("general");
      var fr = from.getBoundingClientRect();
      var tr = to.getBoundingClientRect();
      var x = fr.left + 40;
      var before = from.style.order;
      pointer("pointerdown", from, x, fr.top + fr.height / 2);
      pointer("pointermove", from, x, fr.top + fr.height / 2 + 20);
      await sleep(40);
      pointer("pointermove", from, x, tr.top + 2);
      await sleep(60);
      window.dispatchEvent(new Event("blur")); // 中途失焦（无 pointerup）
      await sleep(120);
      assert(!document.querySelector("[data-snm-dragging]"), "失焦后仍残留 data-snm-dragging（拖拽卡死）");
      assert(from.style.order === before, "取消后顺序未回滚：" + before + " → " + from.style.order);
      return "order 回滚到 " + from.style.order;
    },
  });

  scenarios.push({
    name: "键盘：Alt+↑/↓ 可排序",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("plugins");
      cell.focus();
      keyOn(cell, "ArrowUp", { altKey: true });
      await sleep(120);
      var order = (env.store.value || {}).order || [];
      var iPlugins = order.indexOf("plugins");
      var iModels = order.indexOf("models");
      assert(iPlugins >= 0 && iModels >= 0, "order 缺项：" + JSON.stringify(order));
      assert(iPlugins < iModels, "Alt+↑ 未把 plugins 移到 models 之前：" + JSON.stringify(order));
      return "order=" + JSON.stringify(order);
    },
  });

  scenarios.push({
    name: "键盘：h 切换显隐",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      cell.focus();
      keyOn(cell, "h");
      await sleep(120);
      assert(cell.getAttribute("data-snm-hidden") === "1", "按 h 后该行未隐藏");
      return "hidden=" + JSON.stringify(env.store.value.hidden);
    },
  });

  scenarios.push({
    name: "改名输入框内按 Escape 只取消改名、不退出编辑",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var addBtn = document.querySelector("[data-snm-add-group]");
      assert(addBtn, "编辑模式下未出现「新建抽屉」");
      addBtn.click();
      await sleep(120);
      var input = document.querySelector("[data-snm-group-input]");
      assert(input, "新建抽屉后未进入改名态");
      input.value = "临时名";
      input.focus();
      keyOn(input, "Escape");
      await sleep(80);
      assert(!document.querySelector("[data-snm-group-input]"), "Escape 后输入框未收起");
      assert(navList().getAttribute("data-snm-editing") === "1", "Escape 把编辑模式也退掉了");
      return "编辑态保留=" + navList().getAttribute("data-snm-editing");
    },
  });

  scenarios.push({
    name: "恢复默认：清空抽屉与隐藏、回到宿主顺序",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      var resetBtn = document.querySelector("[data-snm-reset]");
      assert(resetBtn, "编辑模式下未出现「恢复默认」");
      resetBtn.click();
      await sleep(120);
      var w = env.store.value || {};
      assert((w.groups || []).length === 0, "未清空抽屉：" + JSON.stringify(w.groups));
      assert((w.hidden || []).length === 0, "未清空隐藏：" + JSON.stringify(w.hidden));
      assert(
        JSON.stringify(w.order) === JSON.stringify(["general", "account", "models", "plugins"]),
        "顺序未回到宿主默认：" + JSON.stringify(w.order),
      );
      return "order=" + JSON.stringify(w.order);
    },
  });

  scenarios.push({
    name: "持久化失败要可见（齿轮旁提示）",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      env.store.failNext = { message: "No configurable plugin entry" };
      var cell = cellBySection("general");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(150);
      var notice = document.querySelector("[data-snm-notice]");
      assert(notice, "保存失败后没有任何可见提示（静默失败）");
      return "提示=" + (notice.textContent || "").slice(0, 40);
    },
  });

  scenarios.push({
    name: "revision 冲突：重读后重放成功",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      await enterEditing();
      env.store.revision++; // 另一个窗口抢先改过
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(250);
      var w = env.store.value || {};
      assert((w.hidden || []).indexOf("models") >= 0, "冲突后未成功重放：" + JSON.stringify(w.hidden));
      // 必须「带 revision 写 → 撞冲突 → 重读后重放」，而不是无条件覆盖
      assert(env.store.attempts.length >= 2, "未检测到冲突重试（尝试次数 " + env.store.attempts.length + "）");
      assert(
        typeof env.store.attempts[env.store.attempts.length - 1].expected === "number",
        "重放时仍未携带 revision",
      );
      return "尝试 " + env.store.attempts.length + " 次，最终 rev=" + env.store.revision;
    },
  });

  scenarios.push({
    name: "卸载：样式与 data-snm-* 痕迹清理干净",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await openPanel();
      while (env.disposers.length) env.disposers.pop()();
      await sleep(60);
      assert(!document.querySelector("style[data-plugin-css]"), "卸载后样式未移除");
      assert(!document.querySelector("[data-snm-row]"), "卸载后仍残留 data-snm-row");
      assert(!document.querySelector("[data-snm-group]"), "卸载后仍残留抽屉头");
      return "clean";
    },
  });

  // 供视觉抽查用：把环境摆到「打开设置 + 编辑态 + 一个抽屉」的样子，且不清场
  window.__demo = async function () {
    await resetEnv();
    env.store = makeStore(SAVED, 3);
    applyFresh();
    await sleep(90);
    await openPanel();
    await enterEditing();
    var addBtn = document.querySelector("[data-snm-add-group]");
    if (addBtn) addBtn.click();
    await sleep(120);
    var input = document.querySelector("[data-snm-group-input]");
    if (input) {
      input.value = "常用工具";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await sleep(200);
    return "demo-ready";
  };

  // ── 入口 ────────────────────────────────────────────────────
  window.__runAll = async function () {
    var out = [];
    var v = new URLSearchParams(location.search).get("v") || "new";
    for (var i = 0; i < scenarios.length; i++) {
      var sc = scenarios[i];
      await resetEnv();
      var t0 = Date.now();
      try {
        var detail = await sc.run();
        out.push({ name: sc.name, version: v, pass: true, oldFails: !!sc.oldFails, detail: detail, ms: Date.now() - t0 });
      } catch (e) {
        out.push({
          name: sc.name,
          version: v,
          pass: false,
          oldFails: !!sc.oldFails,
          detail: (e && e.message) || String(e),
          ms: Date.now() - t0,
        });
      }
      await resetEnv();
    }
    return { version: v, errors: window.__errors, results: out };
  };
})();
