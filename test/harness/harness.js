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

  var env = { disposers: [], store: null, shell: null, log: [], panel: null };
  var hookState = []; // 旧单挂载点路径保留（副作用只有设置弹窗里的齿轮用）
  var hookCursor = 0;
  var effectRan = {};
  var mounted = { Component: null, container: null, queued: false };
  // 宿主按 `spec.name` 分槽：同一个 key 不能只留最后注册的那个组件（审查 COR-1）
  var regs = { "settings.action": [], "sidebar.panellist": [], main: [] };
  var mounts = {};
  var curMount = null;
  var PLUGIN_ID = "settings-nav-manager.nav";

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

  // ── 宿主 settings 远端 ───────────────────────────────────────
  // 关键：宿主把失败放在 { ok: false, error } 里「正常返回」，不 reject。
  // 假实现必须照这个契约来，否则测不出「把失败当成功」这类 bug。
  function makeStore(initial, revision, opts) {
    opts = opts || {};
    var st = {
      value: initial ? clone(initial) : null,
      revision: typeof revision === "number" ? revision : 1,
      writes: [],
      attempts: [],
      failNext: null,
      rejectMethod: opts.rejectMethod || null,
      rejectAll: !!opts.rejectAll,
      rejectCode: opts.rejectCode || "gateway/internal",
      rejectMessage: opts.rejectMessage || "rejected",
      aliasNs: opts.aliasNs || null,
      schema: opts.schema || null,
    };
    st.decoys = opts.decoys || [];
    st.hideSelf = !!opts.hideSelf;
    st.describe = function () {
      var list = [];
      if (!st.hideSelf) {
        var nsName = st.aliasNs || "settings-nav-manager";
        var view = { ns: nsName, revision: st.revision };
        if (st.value) view.value = clone(st.value);
        if (st.schema) view.schema = clone(st.schema);
        list.push(view);
      }
      // 诱饵命名空间：模拟「别人的插件恰好也叫 order/groups/hidden」
      (st.decoys || []).forEach(function (d) {
        var v = { ns: d.ns, revision: 1 };
        if (d.value !== undefined) v.value = clone(d.value);
        if (d.schema !== undefined) v.schema = clone(d.schema);
        list.push(v);
      });
      // 真实契约：客户端远程统一返回 { ok, value } 信封
      return { ok: true, value: { writable: true, hasDocument: true, namespaces: list } };
    };
    function nsAccepted(ns) {
      var expected = st.aliasNs || "settings-nav-manager";
      return ns === expected;
    }
    function settle(method, expected, build, ns) {
      st.attempts.push({ method: method, expected: expected, ns: ns });
      if (!nsAccepted(ns)) {
        return Promise.resolve({
          ok: false,
          error: { code: "gateway/internal", message: 'No configurable plugin entry "' + ns + '"' },
        });
      }
      if (st.rejectAll || st.rejectMethod === method) {
        return Promise.resolve({ ok: false, error: { code: st.rejectCode, message: st.rejectMessage } });
      }
      if (st.failNext) {
        var f = st.failNext;
        st.failNext = null;
        return Promise.resolve({ ok: false, error: { code: f.code || "gateway/internal", message: f.message || "boom" } });
      }
      if (typeof expected === "number" && expected !== st.revision) {
        return Promise.resolve({ ok: false, error: { code: "SETTINGS_CONFLICT", message: "revision mismatch" } });
      }
      st.value = build();
      st.revision++;
      return Promise.resolve({
        ok: true,
        value: { ns: st.aliasNs || "settings-nav-manager", value: clone(st.value), revision: st.revision },
      });
    }
    st.update = function (ns, patch, expected) {
      return settle("update", expected, function () {
        return clone(patch);
      }, ns);
    };
    st.replace = function (ns, patch, expected) {
      return settle("replace", expected, function () {
        return clone(patch);
      }, ns);
    };
    st.mutate = function (ns, ops, expected) {
      return settle("mutate", expected, function () {
        var next = clone(st.value) || { version: 1, order: [], groups: [], hidden: [] };
        (ops || []).forEach(function (op) {
          if (op && op.op === "set" && op.path && op.path.length === 1) clone(op.value) && (next[op.path[0]] = clone(op.value));
        });
        return next;
      }, ns);
    };
    return st;
  }

  // ── 最小 React 运行时：每个挂载点各有自己的 hook 槽位 ────────
  // 宿主里齿轮、入口页、侧栏图标是三棵独立的组件树；测试台若共用一个
  // hook 数组，后挂的组件会把前一个的状态挤掉（正是 COR-1 的成因）。
  function rerender() {
    Object.keys(mounts).forEach(function (key) {
      var m = mounts[key];
      if (!m || !m.Component || !m.container || m.queued || !m.container.isConnected) return;
      m.queued = true;
      Promise.resolve().then(function () {
        m.queued = false;
        if (!m.Component || !m.container || !m.container.isConnected) return;
        renderMount(key);
      });
    });
  }
  function renderMount(key) {
    var m = mounts[key];
    if (!m || !m.Component || !m.container) return;
    curMount = m;
    m.cursor = 0;
    var node = renderNode(m.Component(m.props));
    curMount = null;
    m.container.textContent = "";
    m.container.appendChild(node);
  }
  function mountInto(key, container, Component, props) {
    if (!mounts[key]) mounts[key] = { key: key, state: [], cursor: 0, effects: {}, cleanups: [], props: null };
    var m = mounts[key];
    m.container = container;
    m.Component = Component;
    m.props = props;
    renderMount(key);
    return m;
  }
  function unmount(key) {
    var m = mounts[key];
    if (!m) return;
    while (m.cleanups.length) {
      try {
        m.cleanups.pop()();
      } catch (e) {
        /* 卸载清理不该让测试挂掉 */
      }
    }
    m.Component = null;
    if (m.container) m.container.textContent = "";
  }
  function activeMount() {
    if (curMount) return curMount;
    // 兜底：不在挂载渲染期间调用 hook（例如组件被直接函数式调用）
    if (!mounts.__loose) mounts.__loose = { key: "__loose", state: hookState, cursor: 0, effects: effectRan, cleanups: [] };
    return mounts.__loose;
  }
  var ReactShim = {
    createElement: function (type, props) {
      var children = [];
      for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);
      return { __el: true, type: type, props: props || {}, children: children };
    },
    useState: function (init) {
      var m = activeMount();
      var i = m.cursor++;
      if (!(i in m.state)) m.state[i] = typeof init === "function" ? init() : init;
      return [
        m.state[i],
        function (next) {
          var val = typeof next === "function" ? next(m.state[i]) : next;
          if (val === m.state[i]) return;
          m.state[i] = val;
          rerender();
        },
      ];
    },
    useEffect: function (fn) {
      var m = activeMount();
      var i = 5000 + m.cursor++;
      if (m.effects[i]) return;
      m.effects[i] = true;
      var cleanup = fn();
      if (typeof cleanup === "function") m.cleanups.push(cleanup);
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
        if (env.shell && env.shell.dead) return; // 假装宿主这次点了没反应
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

  // ── 宿主外壳：左侧插件栏 + 主面板容器 ──────────────────────
  function chrome() {
    var bar = document.getElementById("xx_sidebar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "xx_sidebar";
      bar.className = "xx_panelList";
      document.body.appendChild(bar);
    }
    var main = document.getElementById("xx_main");
    if (!main) {
      main = document.createElement("div");
      main.id = "xx_main";
      main.className = "xx_main";
      document.body.appendChild(main);
    }
    return { bar: bar, main: main };
  }
  function sidebarRows() {
    var bar = document.getElementById("xx_sidebar");
    return bar ? Array.prototype.slice.call(bar.querySelectorAll("[data-panel-id]")) : [];
  }
  function sidebarRow(id) {
    return (
      sidebarRows().filter(function (r) {
        return r.getAttribute("data-panel-id") === id;
      })[0] || null
    );
  }

  // 宿主侧栏：按 order 稳定排序后渲染，点行 → selectPanel(id)
  function mountSidebar() {
    var bar = chrome().bar;
    var sorted = regs["sidebar.panellist"].slice().sort(function (a, b) {
      return (a.spec.order || 0) - (b.spec.order || 0);
    });
    bar.textContent = "";
    sorted.forEach(function (rec) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "xx_panelRow panelRow";
      btn.setAttribute("data-panel-id", rec.spec.id);
      var icon = document.createElement("span");
      icon.className = "xx_panelIcon";
      btn.appendChild(icon);
      var title = document.createElement("span");
      title.className = "xx_panelTitle";
      var label = rec.spec.label;
      title.textContent = typeof label === "function" ? String(label()) : String(label || rec.spec.id);
      btn.appendChild(title);
      btn.addEventListener("click", function () {
        selectPanel(rec.spec.id);
      });
      bar.appendChild(btn);
      // 图标在真机上也是独立组件（宿主单独渲染），这里同样真挂一次
      if (typeof rec.Component === "function") mountInto("icon:" + rec.spec.id, icon, rec.Component);
    });
  }

  // 宿主 layout：没有同名 main 面板就抛错（插件必须注册同 key 的页面）
  function selectPanel(id) {
    env.panel = id;
    var main = chrome().main;
    var rec = null;
    regs.main.forEach(function (r) {
      if (r.spec && r.spec.key === id) rec = r;
    });
    if (!rec) {
      main.textContent = "";
      throw new Error('layout.selectPanel: main panel "' + id + '" is not registered');
    }
    var props = typeof rec.spec.inject === "function" ? rec.spec.inject() : undefined;
    mountInto("main:" + id, main, rec.Component, props);
    return true;
  }

  // ── 装配 ────────────────────────────────────────────────────
  // 面板是「打开设置」时才插进 DOM 的，齿轮只能等容器出现后再挂载
  function mountGear() {
    var list = regs["settings.action"];
    if (!list.length) return false;
    var container = document.querySelector(".xx_actions");
    if (!container) return false;
    mountInto("gear", container, list[list.length - 1].Component);
    return true;
  }

  function ensurePanel() {
    if (!panelEl()) document.body.appendChild(buildPanel());
    return panelEl();
  }

  async function openPanel() {
    ensurePanel();
    await sleep(60);
    mountGear();
    await sleep(60);
  }

  // 假设置 shell：深链要调 openSection(id)，它只改 activeId + open
  function makeShell() {
    var sh = {
      calls: [],
      dead: false,
      open: function () {
        ensurePanel();
      },
      close: function () {},
      select: function (id) {
        ensurePanel();
        selectRow(id);
      },
      openSection: function (id) {
        sh.calls.push(id);
        if (sh.dead) return; // 宿主不校验 id：改了 activeId 却什么都没渲染出来
        ensurePanel();
        selectRow(id);
      },
    };
    return sh;
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
        // 设置 shell 把「活实例」暴露在这里，插件的深链走这条路
        entriesOfSlot: function (key) {
          if (key !== "sidebar.settings") return [];
          return [
            {
              options: { id: "settings" },
              store: {
                create: function () {
                  return { actions: env.shell };
                },
              },
            },
          ];
        },
        inject: function (name, cb) {
          return cb();
        },
        register: function (spec, Component) {
          var name = (spec && spec.name) || "";
          if (!regs[name]) regs[name] = [];
          var rec = { spec: spec || {}, Component: Component };
          var id = spec && (spec.id || spec.key);
          regs[name].push(rec);
          env.log.push({ op: "register", name: name, id: id });
          if (name === "settings.action") mountGear();
          if (name === "sidebar.panellist") mountSidebar();
          if (name === "main" && env.panel === (spec && spec.key)) selectPanel(spec.key);
          return function () {
            var i = regs[name].indexOf(rec);
            if (i >= 0) regs[name].splice(i, 1);
            env.log.push({ op: "dispose", name: name, id: id });
            if (name === "settings.action") {
              unmount("gear");
              mountGear();
            }
            if (name === "sidebar.panellist") {
              unmount("icon:" + id);
              mountSidebar();
            }
          };
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
    chrome();
    env.shell = makeShell();
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
    Object.keys(mounts).forEach(function (k) {
      var m = mounts[k];
      if (!m) return;
      while (m.cleanups && m.cleanups.length) {
        try {
          m.cleanups.pop()();
        } catch (e) {
          /* 忽略 */
        }
      }
    });
    mounts = {};
    curMount = null;
    regs = { "settings.action": [], "sidebar.panellist": [], main: [] };
    env.log = [];
    env.panel = null;
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
    name: "命名空间被别名改写时，按 schema 认领后仍能写入",
    oldFails: true,
    run: async function () {
      env.store = makeStore(SAVED, 3, {
        aliasNs: "@local/dsh-settings-nav-manager",
        schema: { type: "object", dict: { version: {}, order: {}, groups: {}, hidden: {} } },
      });
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(220);
      var w = env.store.value || {};
      assert((w.hidden || []).indexOf("models") >= 0, "没认领到真实命名空间：" + JSON.stringify(w.hidden));
      var used = env.store.attempts.map(function (a) {
        return a.ns;
      });
      assert(
        used[used.length - 1] === "@local/dsh-settings-nav-manager",
        "写入仍打在假设的 id 上：" + used.join(","),
      );
      return "写入 ns=" + used[used.length - 1];
    },
  });

  scenarios.push({
    name: "别名安装 + 首次使用（命名空间还没有值）也应能写入",
    oldFails: true,
    run: async function () {
      // 失败关闭不能把「首次使用」也关掉：此时没有别人的文档可被覆盖，
      // 唯一候选 + schema 指纹吻合就应该放行。
      env.store = makeStore(null, 1, {
        aliasNs: "@local/dsh-settings-nav-manager",
        schema: { type: "object", dict: { version: {}, order: {}, groups: {}, hidden: {} } },
      });
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(220);
      var w = env.store.value || {};
      assert((w.hidden || []).indexOf("models") >= 0, "首次使用就被失败关闭挡住了：" + JSON.stringify(w));
      var used = env.store.attempts.map(function (a) {
        return a.ns;
      });
      assert(used[used.length - 1] === "@local/dsh-settings-nav-manager", "写入 ns 不对：" + used.join(","));
      return "写入 ns=" + used[used.length - 1];
    },
  });

  scenarios.push({
    name: "宿主用 {ok:false} 拒写时不能当成功，并换路重试",
    oldFails: true,
    run: async function () {
      // 只拒 update（模拟宿主那侧对这条写入口的拒绝），mutate 仍然可用
      env.store = makeStore(SAVED, 3, {
        rejectMethod: "update",
        rejectCode: "gateway/internal",
        rejectMessage: 'No configurable plugin entry "settings-nav-manager"',
      });
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(200);
      var w = env.store.value || {};
      assert((w.hidden || []).indexOf("models") >= 0, "分路重试后仍未写进去：" + JSON.stringify(w.hidden));
      var methods = env.store.attempts.map(function (a) {
        return a.method;
      });
      assert(methods.indexOf("update") >= 0 && methods.indexOf("mutate") >= 0, "没有换路重试：" + methods.join(","));
      assert(methods.indexOf("replace") < 0, "不该再走整份替换（会覆写同命名空间的其他字段）：" + methods.join(","));
      assert(!document.querySelector("[data-snm-notice]"), "最终写成功了却还留着告警");
      return "路径=" + methods.join("→");
    },
  });

  scenarios.push({
    name: "非「条目不存在」的拒写不得换路重试（不许升权重试）",
    oldFails: true,
    run: async function () {
      // 校验/配额类拒绝：换 replace / mutate 重试等于用更大的权限绕过宿主校验
      env.store = makeStore(SAVED, 3, {
        rejectMethod: "update",
        rejectCode: "gateway/quota",
        rejectMessage: "settings document quota exceeded",
      });
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(200);
      var methods = env.store.attempts.map(function (a) {
        return a.method;
      });
      assert(methods.length === 1 && methods[0] === "update", "被合法拒绝后仍在换路重试：" + methods.join(","));
      assert(document.querySelector("[data-snm-notice]"), "被拒后没有可见提示");
      return "只尝试了 " + methods.join(",");
    },
  });

  scenarios.push({
    name: "命名空间歧义时失败关闭（一个字都不写）",
    oldFails: true,
    run: async function () {
      var schema = { type: "object", dict: { version: {}, order: {}, groups: {}, hidden: {} } };
      env.store = makeStore(SAVED, 3, {
        hideSelf: true,
        decoys: [
          { ns: "other-layout-plugin", schema: schema, value: { order: ["a"], groups: [], hidden: [] } },
          { ns: "another-board-plugin", schema: schema, value: { order: ["b"], groups: [], hidden: [] } },
        ],
      });
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(220);
      assert(env.store.attempts.length === 0, "歧义时仍发起了写入：" + JSON.stringify(env.store.attempts));
      assert(document.querySelector("[data-snm-notice]"), "失败关闭却没有任何提示");
      return "attempts=0，已提示";
    },
  });

  scenarios.push({
    name: "唯一候选但值形状不符时也不认领",
    oldFails: true,
    run: async function () {
      var schema = { type: "object", dict: { version: {}, order: {}, groups: {}, hidden: {} } };
      env.store = makeStore(SAVED, 3, {
        hideSelf: true,
        decoys: [{ ns: "lookalike", schema: schema, value: { order: "not-an-array", groups: [], hidden: [] } }],
      });
      applyFresh();
      await openPanel();
      await enterEditing();
      var cell = cellBySection("models");
      var r = cell.getBoundingClientRect();
      clickAt(cell, r.right - 10, r.top + r.height / 2);
      await sleep(220);
      assert(env.store.attempts.length === 0, "值形状不符仍被认领：" + JSON.stringify(env.store.attempts));
      return "attempts=0";
    },
  });

  // 注意：这条不能标 oldFails —— 1.0.0 在 pointermove 里同步结算落点，本来是通过的；
  // 落点丢失是 1.0.1 引入「按帧合并预览」时带来的回归。用 1.0.0 做 A/B 基线测不出它。
  scenarios.push({
    name: "同帧抬手（最后一次 move 与 pointerup 同帧）落点也必须生效",
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
      // 三次 dispatch 在同一个任务里完成 —— 中间不可能有空帧，重现「快速甩动释放」
      pointer("pointerdown", from, x, fr.top + fr.height / 2);
      pointer("pointermove", from, x, fr.top + fr.height / 2 + 20);
      pointer("pointermove", from, x, tr.top + 2);
      pointer("pointerup", from, x, tr.top + 2);
      await sleep(150);
      var order = (env.store.value || {}).order || [];
      assert(order[0] === "models", "同帧抬手丢了拖拽落点：" + JSON.stringify(order));
      return "order=" + JSON.stringify(order);
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
      env.store.rejectAll = true;
      env.store.rejectMessage = 'No configurable plugin entry "settings-nav-manager"';
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

  // ── 1.1.0 / 1.2.0 新功能的端到端覆盖（审查 COR-1'：新槽位必须有 e2e）──
  scenarios.push({
    name: "侧栏入口：点行进页面，点分区直接打开设置并选中",
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await sleep(120);
      var row = sidebarRow(PLUGIN_ID);
      assert(row, "侧栏没出现「设置导航」入口行");
      row.click(); // 宿主 selectPanel → 入口页挂载
      await sleep(80);
      var page = document.querySelector("[data-snm-page]");
      assert(page, "点入口行后主面板没渲染入口页");
      var target = page.querySelector('[data-snm-page-row][data-snm-page-id="models"]');
      assert(target, "入口页里没有 models 这一行");
      target.click();
      await sleep(600);
      assert(env.shell.calls.indexOf("models") >= 0, "深链没调用 openSection(models)：" + JSON.stringify(env.shell.calls));
      assert(cellBySection("models").getAttribute("aria-current") === "true", "设置里没选中 models");
      assert(!document.querySelector("[data-snm-page-error]"), "深链成功却显示了错误横幅");
      return "openSection=" + JSON.stringify(env.shell.calls);
    },
  });

  scenarios.push({
    name: "深链失败：入口页显示错误并可重试",
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await sleep(120);
      env.shell.dead = true; // 宿主改了 activeId 但界面毫无反应
      sidebarRow(PLUGIN_ID).click();
      await sleep(80);
      var target = document.querySelector('[data-snm-page-row][data-snm-page-id="models"]');
      target.click();
      await sleep(1500); // 轮询窗（8×40ms）+ DOM 兜底也要跑完
      var box = document.querySelector("[data-snm-page-error]");
      assert(box, "深链失败后入口页没有任何错误提示（静默失效）");
      assert(box.textContent.length > 0, "错误提示没有文案");
      assert(document.querySelector("[data-snm-page-error-retry]"), "错误态没有重试入口");
      return "错误可见";
    },
  });

  scenarios.push({
    name: "入口开关：齿轮旁切换注册/注销，并落盘",
    run: async function () {
      env.store = makeStore(SAVED, 3);
      applyFresh();
      await sleep(120);
      assert(sidebarRow(PLUGIN_ID), "初始应有入口行");
      await openPanel();
      await enterEditing();
      var toggle = document.querySelector("[data-snm-entry-toggle]");
      assert(toggle, "齿轮旁没有入口开关");
      var before = env.log.filter(function (r) {
        return r.name === "sidebar.panellist" && r.op === "register";
      }).length;
      toggle.click();
      await sleep(150);
      assert(!sidebarRow(PLUGIN_ID), "隐藏后侧栏仍有入口行");
      assert((env.store.value || {}).hideEntry === true, "hideEntry 没写进磁盘");
      var toggle2 = document.querySelector("[data-snm-entry-toggle]");
      assert(toggle2, "隐藏后开关自己也不见了");
      toggle2.click();
      await sleep(150);
      assert(sidebarRow(PLUGIN_ID), "再点一次没有恢复入口行");
      assert((env.store.value || {}).hideEntry === false, "恢复后 hideEntry 未回写 false");
      var regs2 = env.log.filter(function (r) {
        return r.name === "sidebar.panellist" && r.op === "register";
      }).length;
      assert(regs2 > before, "恢复时没有重新注册（注册次数 " + before + " → " + regs2 + "）");
      return "注册 " + before + " → " + regs2;
    },
  });

  scenarios.push({
    name: "入口隐藏状态跨重启生效（且启动瞬间不闪）",
    run: async function () {
      var saved = clone(SAVED);
      saved.hideEntry = true;
      env.store = makeStore(saved, 3);
      applyFresh();
      // 门闩：describe 还没回来时不能按默认态先把入口注册出来
      assert(!sidebarRow(PLUGIN_ID), "启动瞬间就渲染了应隐藏的入口（闪烁）");
      await sleep(200);
      assert(!sidebarRow(PLUGIN_ID), "describe 回来之后入口仍然出现了");
      var mainReg = env.log.filter(function (r) {
        return r.name === "main" && r.op === "register";
      });
      assert(mainReg.length >= 1, "页面注册被一起摘掉了（会导致 selectPanel 抛错）");
      return "隐藏生效，main 仍在册";
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
