// dsh-settings-nav-manager — client (web)
// P1: 齿轮编辑模式 + 拖拽排序 + 条目显隐 + 持久化。
//
// 设计约束（来自 dsh-pet / dshmarket 实证）：
//  * 绝不改写 React 管理的 nav DOM 结构（replaceWith / removeChild 会抛 NotFoundError）。
//  * 只加 data-* 属性 + 注入 CSS（伪元素画字形），交互走坐标命中 + 事件委托。
//  * 认行靠 label 文本 / DOM 序号映射到 settings.section 的 options.id。
//  * 选择器全部收敛到 SEL 常量表，升级断链只改这一处。
window.__ModuleLoader__.load({
  id: "dsh-settings-nav-manager",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    var NS = "settings-nav-manager";

    // ── 选择器常量表（升级断链只改这一处）────────────────────────
    var SEL = {
      panel: '[data-shortcut-modal="settings"]',
      navList: '[class*="navList"]',
      navCell: '[class*="navCell"]',
      navLabel: '[class*="navLabel"]',
    };
    // 命中分区（相对行右侧，单位 px）：handle 在最右，eye 紧邻其左。
    var ZONE_EYE = 40;
    // 描线 SVG 图标（mask + background-color:currentColor，随主题变色，与设置页线性图标一致）。
    // 用 ::after 画，彻底避开 dsh-pet/dshmarket 占用的 ::before（见 nav-icon 注释）。
    var ICON_EYE =
      "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'/><circle cx='12' cy='12' r='2.5'/></svg>";
    var ICON_EYE_OFF =
      "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'/><circle cx='12' cy='12' r='2.5'/><line x1='3.5' y1='3.5' x2='20.5' y2='20.5'/></svg>";
    var DRAG_THRESHOLD = 6; // >6px 判拖拽，低于阈值放行普通点击
    var STYLE_TAG = "settings-nav-manager-style";

    // ── 运行时文案（走 Client locale）────────────────────────────
    var zh = {
      gear: "编辑导航",
      gearExit: "退出编辑导航",
      editHint: "拖拽排序 · 点眼睛隐藏 · 双击改名 · 可收纳",
      hidden: "已隐藏",
      show: "显示",
      hide: "隐藏",
      handle: "拖动以排序",
      reset: "恢复默认",
      newGroup: "新抽屉",
      addGroup: "＋ 新建抽屉",
      dissolve: "解散抽屉",
    };
    var en = {
      gear: "Edit navigation",
      gearExit: "Exit navigation editing",
      editHint: "Drag to reorder · Click eye to hide · Double-click to rename · Collect into drawers",
      hidden: "Hidden",
      show: "Show",
      hide: "Hide",
      handle: "Drag to reorder",
      reset: "Reset to default",
      newGroup: "New drawer",
      addGroup: "+ New drawer",
      dissolve: "Dissolve drawer",
    };

    // ── 模块态（临时态，不持久化；持久化只有 order/hidden）──────
    var editing = false;
    var state = { order: [], groups: [], hidden: [] }; // 持久化态
    var groupSeq = 1; // 抽屉 id 自增（"g-N"）
    var sections = []; // [{id, order, label}] 由 entries 投影
    var editingSubs = [];
    var ctxRef = null;
    var t = null;

    function notifyEditing() {
      for (var i = 0; i < editingSubs.length; i++) {
        try {
          editingSubs[i](editing);
        } catch (e) {}
      }
    }

    // ── 样式注入（幂等，data-plugin-css 查重）───────────────────
    function injectStyles() {
      if (!document || !document.head) return;
      var existing = document.querySelector(
        'style[data-plugin-css="' + STYLE_TAG + '"]',
      );
      if (existing) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = STYLE_TAG;
      var eyeOpen = 'url("data:image/svg+xml,' + encodeURIComponent(ICON_EYE) + '")';
      var eyeOff = 'url("data:image/svg+xml,' + encodeURIComponent(ICON_EYE_OFF) + '")';
      tag.textContent = [
        // 容器：确保 flex column，order 生效
        "[data-snm-nav]{display:flex;flex-direction:column;}",
        // 行定位上下文（伪元素锚点）
        "[data-snm-row]{position:relative;}",
        // 编辑模式：眼睛（::after，描线 SVG + currentColor 随主题）。
        // pet/market 只用 ::before，故用 ::after 不撞，::before 完全让给它们。
        '[data-snm-editing="1"] [data-snm-row]::after{',
        '  content:"";position:absolute;right:20px;top:0;bottom:0;width:18px;',
        "  background-color:currentColor;opacity:.72;pointer-events:none;",
        "  -webkit-mask:" + eyeOpen + " center/contain no-repeat;",
        "  mask:" + eyeOpen + " center/contain no-repeat;",
        "}",
        // 隐藏：换“划线眼”，眼睛常驻（保留可见、可点回），不再消失
        '[data-snm-editing="1"] [data-snm-row][data-snm-hidden="1"]::after{',
        "  -webkit-mask:" + eyeOff + " center/contain no-repeat;",
        "  mask:" + eyeOff + " center/contain no-repeat;",
        "  opacity:.9;",
        "}",
        // 隐藏：只置灰内容（标签/导航图标），眼睛保持亮，方便一眼看到恢复按钮
        '[data-snm-row][data-snm-hidden="1"] [class*="navLabel"],',
        '[data-snm-row][data-snm-hidden="1"] [class*="navIcon"]{opacity:.42;}',
        '[data-snm-editing="0"] [data-snm-row][data-snm-hidden="1"]{display:none;}',
        // 编辑模式：预留右侧眼睛位 + 标签截断（长名字不盖眼睛）
        '[data-snm-editing="1"] [data-snm-row]{padding-right:52px;}',
        '[data-snm-editing="1"] [class*="navLabel"]{',
        "  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        "  min-width:0;flex:1 1 auto;",
        "}",
        // 拖拽中的视觉反馈
        '[data-snm-row][data-snm-dragging="1"]{',
        "  opacity:.6;outline:1px dashed var(--dsw-alias-accent,#247bbf);",
        "  outline-offset:-1px;cursor:grabbing;",
        "}",
        '[data-snm-editing="1"] [data-snm-row]{cursor:grab;}',
        // ── 抽屉（命名分组）：头 =「▾ 抽屉名 … ×」插件自有节点 ──
        "[data-snm-group]{",
        "  display:flex;align-items:center;gap:8px;margin:2px 0;height:40px;",
        "  padding:0 12px;border-radius:6px;cursor:grab;position:relative;",
        "  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));",
        "  font-family:inherit;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary,#ccc);",
        "}",
        '[data-snm-group][data-snm-dragging="1"]{opacity:.6;outline:1px dashed var(--dsw-alias-accent,#247bbf);outline-offset:-1px;cursor:grabbing;}',
        '[data-snm-group-toggle]{cursor:pointer;user-select:none;flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;}',
        '[data-snm-group-name]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary,#ccc);}',
        '[data-snm-group-input]{flex:1 1 auto;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#222);border:1px solid var(--dsw-alias-accent,#247bbf);border-radius:4px;padding:2px 4px;}',
        '[data-snm-group-dissolve]{flex:none;opacity:0;cursor:pointer;background:transparent;border:none;color:var(--dsw-alias-label-secondary,#888);font-size:14px;line-height:1;padding:2px 5px;border-radius:4px;}',
        '[data-snm-editing="1"] [data-snm-group]:hover [data-snm-group-dissolve]{opacity:1;}',
        '[data-snm-group-dissolve]:hover{background:var(--dsw-alias-state-error-primary,#c33);color:#fff;}',
        // 组内条目：L 型归属线（竖线贯穿 + 横拐到内容）+ 缩进，标明归属哪个抽屉
        '[data-snm-row][data-snm-in-group]{',
        "  padding-left:30px;",
        "  background-image:",
        "    linear-gradient(to bottom, var(--dsw-alias-border,rgba(128,128,128,.4)), var(--dsw-alias-border,rgba(128,128,128,.4))),",
        "    linear-gradient(to right, var(--dsw-alias-border,rgba(128,128,128,.4)), var(--dsw-alias-border,rgba(128,128,128,.4)));",
        "  background-size:1.5px 100%, 12px 1.5px;",
        "  background-position:12px 0, 12px 50%;",
        "  background-repeat:no-repeat, no-repeat;",
        "}",
        // 折叠收纳：组内成员隐藏（任何模式）
        '[data-snm-row][data-snm-collapsed="1"]{display:none;}',
        // 拖入抽屉的落点高亮（dragover 时标 data-snm-drop）
        '[data-snm-group][data-snm-drop="1"]{',
        "  background:var(--dsw-alias-state-accent-bg,rgba(36,123,191,.16));",
        "  outline:1.5px solid var(--dsw-alias-accent,#247bbf);outline-offset:-1px;",
        "}",
        // 新建抽屉按钮（编辑模式，nav 底部）
        "[data-snm-add-group]{",
        "  margin:4px 0;padding:6px 8px;cursor:pointer;text-align:center;font-size:12px;",
        "  border:1px dashed var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:6px;",
        "  color:var(--dsw-alias-label-secondary,#888);",
        "}",
        "[data-snm-add-group]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}",
      ].join("\n");
      document.head.appendChild(tag);
    }

    // ── sections 投影（entries -> [{id, order, label}]）──────────
    function projectSections(ctx) {
      var out = [];
      try {
        var entries = ctx.slots.entries("settings.section");
        for (var i = 0; i < entries.length; i++) {
          var o = entries[i] && entries[i].options ? entries[i].options : {};
          var lbl = o.label;
          if (typeof lbl === "function") {
            try {
              lbl = lbl();
            } catch (e) {
              lbl = "";
            }
          }
          out.push({
            id: o.id ? String(o.id) : "",
            order: typeof o.order === "number" ? o.order : 0,
            label: lbl ? String(lbl) : "",
          });
        }
      } catch (e) {}
      out.sort(function (a, b) {
        return a.order - b.order;
      });
      return out;
    }

    // ── DOM 认行：navCell -> section id ──────────────────────────
    function navCells(nav) {
      if (!nav) return [];
      var list = nav.querySelectorAll(":scope > " + SEL.navCell);
      return Array.prototype.slice.call(list);
    }

    function markRows(ctx) {
      var nav = findNav();
      if (!nav) return;
      nav.setAttribute("data-snm-nav", "1");
      nav.setAttribute("data-snm-editing", editing ? "1" : "0");
      sections = projectSections(ctx);
      var cells = navCells(nav);
      // 主映射：DOM 序号 ↔ sections（同源 rows.map，React 按 options.order 渲染）。
      // 校验：label 文本一致则确信；不一致则按 label 兜底查找。
      var byLabel = {};
      for (var s = 0; s < sections.length; s++) {
        var key = (sections[s].label || "").trim();
        if (key && !byLabel[key]) byLabel[key] = sections[s].id;
      }
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var id = null;
        var idxEntry = sections[i];
        if (idxEntry) {
          var lblEl = cell.querySelector(SEL.navLabel);
          var txt = lblEl ? (lblEl.textContent || "").trim() : "";
          if (!txt || txt === (idxEntry.label || "").trim()) {
            id = idxEntry.id;
          }
        }
        if (!id) {
          var lblEl2 = cell.querySelector(SEL.navLabel);
          var txt2 = lblEl2 ? (lblEl2.textContent || "").trim() : "";
          id = byLabel[txt2] || (idxEntry ? idxEntry.id : "") || "";
        }
        if (id) {
          cell.setAttribute("data-snm-row", "1");
          cell.setAttribute("data-snm-id", id);
        }
      }
    }

    function findNav() {
      if (!document) return null;
      var panel = document.querySelector(SEL.panel);
      if (!panel) return null;
      return panel.querySelector(SEL.navList);
    }

    // ── 应用 order / groups / hidden / editing 到 DOM ───────────
    function applyDom() {
      var nav = findNav();
      if (!nav) return;
      nav.setAttribute("data-snm-editing", editing ? "1" : "0");
      var hiddenSet = {};
      for (var k = 0; k < state.hidden.length; k++) hiddenSet[state.hidden[k]] = 1;
      var groupById = {};
      for (var gi = 0; gi < state.groups.length; gi++) groupById[state.groups[gi].id] = state.groups[gi];
      var cellById = {};
      var cells = navCells(nav);
      for (var ci = 0; ci < cells.length; ci++) {
        var cid = cells[ci].getAttribute("data-snm-id");
        if (cid) cellById[cid] = cells[ci];
      }
      syncGroupHeaders(nav);
      var counter = 0;
      for (var ti = 0; ti < state.order.length; ti++) {
        var top = state.order[ti];
        var g = groupById[top];
        if (g) {
          var header = nav.querySelector('[data-snm-group-id="' + top + '"]');
          if (header) header.style.order = String(counter++);
          for (var mi = 0; mi < g.items.length; mi++) {
            var mid = g.items[mi];
            var mcell = cellById[mid];
            if (mcell) {
              mcell.style.order = String(counter++);
              mcell.setAttribute("data-snm-in-group", g.id);
              if (g.collapsed) mcell.setAttribute("data-snm-collapsed", "1");
              else mcell.removeAttribute("data-snm-collapsed");
              if (hiddenSet[mid]) mcell.setAttribute("data-snm-hidden", "1");
              else mcell.removeAttribute("data-snm-hidden");
            }
          }
        } else {
          var cell = cellById[top];
          if (cell) {
            cell.style.order = String(counter++);
            cell.removeAttribute("data-snm-in-group");
            cell.removeAttribute("data-snm-collapsed");
            if (hiddenSet[top]) cell.setAttribute("data-snm-hidden", "1");
            else cell.removeAttribute("data-snm-hidden");
          }
        }
      }
      for (var bi = 0; bi < cells.length; bi++) {
        if (!cells[bi].style.order) cells[bi].style.order = String(1000 + bi);
      }
      buildAddButton(nav, counter);
    }

    // ── 持久化（remote.settings describe/update，无需 scope）──────
    // 读：describe().namespaces.find(ns) → .value / .revision。
    // 写：update(ns, patch, expectedRevision)。expectedRevision 省略=无条件写
    //（本插件独占 settings-nav-manager 命名空间，无并发写，省略 revision 更稳）。
    function findNs(res) {
      var arr = res && res.namespaces;
      if (!Array.isArray(arr)) return null;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].ns === NS) return arr[i];
      }
      return null;
    }

    function remote() {
      return ctxRef && ctxRef.remote ? ctxRef.remote.settings : null;
    }

    function knownIds() {
      var set = {};
      for (var i = 0; i < sections.length; i++) if (sections[i].id) set[sections[i].id] = 1;
      return set;
    }

    // 写前过滤非法元素（只保留已知 section id；groups.items 同）
    function persist() {
      var rm = remote();
      if (!rm || typeof rm.update !== "function") return Promise.resolve(false);
      var known = knownIds();
      var order = state.order.filter(function (id) {
        return known[id] || isGroupTop(id);
      });
      var groups = state.groups.map(function (g) {
        return {
          id: g.id,
          name: g.name,
          collapsed: !!g.collapsed,
          items: g.items.filter(function (id) {
            return known[id];
          }),
        };
      });
      var hidden = state.hidden.filter(function (id) {
        return known[id];
      });
      try {
        return Promise.resolve(
          rm.update(NS, { order: order, groups: groups, hidden: hidden }),
        ).then(
          function () {
            return true;
          },
          function () {
            return false;
          },
        );
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    // 异步读取 + 回退默认（任何异常 → 空 = 原生默认顺序）。
    // 读到后 refresh 一次，让认行/排序/显隐落到位。
    function loadStateAsync() {
      var def = { order: [], groups: [], hidden: [] };
      var rm = remote();
      if (!rm || typeof rm.describe !== "function") {
        state = def;
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(function () {
          return rm.describe();
        })
        .then(function (res) {
          var ns = findNs(res);
          var v = ns && ns.value;
          state = {
            order: v && Array.isArray(v.order) ? v.order.filter(isStr) : [],
            groups:
              v && Array.isArray(v.groups)
                ? v.groups
                    .filter(function (g) {
                      return g && isStr(g.id);
                    })
                    .map(function (g) {
                      return {
                        id: String(g.id),
                        name: isStr(g.name) ? String(g.name) : "抽屉",
                        collapsed: !!g.collapsed,
                        items: Array.isArray(g.items) ? g.items.filter(isStr) : [],
                      };
                    })
                : [],
            hidden: v && Array.isArray(v.hidden) ? v.hidden.filter(isStr) : [],
          };
          updateGroupSeq();
          if (ctxRef) refresh(ctxRef);
        })
        .catch(function () {
          state = def;
          if (ctxRef) refresh(ctxRef);
        });
    }

    function isStr(x) {
      return typeof x === "string";
    }

    // 归一化：补全缺失 id（新分区）到末尾；保证 id 唯一（顶层 或 某组，不重复）
    function normalize() {
      var known = knownIds();
      var placed = {};
      var gi, ii, id, oi, top;
      for (gi = 0; gi < state.groups.length; gi++) {
        var g = state.groups[gi];
        var ng = [];
        for (ii = 0; ii < g.items.length; ii++) {
          id = g.items[ii];
          if (known[id] && !placed[id]) {
            placed[id] = 1;
            ng.push(id);
          }
        }
        g.items = ng;
      }
      var newOrder = [];
      var seenTop = {};
      for (oi = 0; oi < state.order.length; oi++) {
        top = state.order[oi];
        if (isGroupTop(top)) {
          if (!seenTop[top]) {
            seenTop[top] = 1;
            newOrder.push(top);
          }
        } else if (known[top] && !placed[top]) {
          placed[top] = 1;
          seenTop[top] = 1;
          newOrder.push(top);
        }
      }
      for (var si = 0; si < sections.length; si++) {
        id = sections[si].id;
        if (id && known[id] && !placed[id]) {
          placed[id] = 1;
          newOrder.push(id);
        }
      }
      for (var gj = 0; gj < state.groups.length; gj++) {
        if (!seenTop[state.groups[gj].id]) {
          seenTop[state.groups[gj].id] = 1;
          newOrder.push(state.groups[gj].id);
        }
      }
      state.order = newOrder;
      state.hidden = state.hidden.filter(function (id2) {
        return known[id2];
      });
    }

    // ── 抽屉（命名分组）辅助 ───────────────────────────────────
    function isGroupTop(id) {
      for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return true;
      return false;
    }
    function findGroup(id) {
      for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
      return null;
    }
    function removeItemEverywhere(id) {
      var oi = state.order.indexOf(id);
      if (oi >= 0) state.order.splice(oi, 1);
      for (var i = 0; i < state.groups.length; i++) {
        var gi = state.groups[i].items.indexOf(id);
        if (gi >= 0) state.groups[i].items.splice(gi, 1);
      }
    }
    function updateGroupSeq() {
      for (var i = 0; i < state.groups.length; i++) {
        var m = /^g-(\d+)$/.exec(state.groups[i].id);
        if (m) {
          var n = parseInt(m[1], 10);
          if (n >= groupSeq) groupSeq = n + 1;
        }
      }
    }

    // ── 抽屉操作 ───────────────────────────────────────────────
    function addGroup() {
      var g = { id: "g-" + groupSeq++, name: t ? t("newGroup") : "新抽屉", collapsed: false, items: [] };
      state.groups.push(g);
      state.order.push(g.id);
      applyDom();
      persist();
      // 建完即改名（方案 P2 交互）
      var nav = findNav();
      if (nav) {
        var h = nav.querySelector('[data-snm-group-id="' + g.id + '"]');
        if (h) startRename(h, g.id, h.querySelector("[data-snm-group-name]"));
      }
      return g;
    }
    function dissolveGroup(gid) {
      var g = findGroup(gid);
      if (!g) return;
      var pos = state.order.indexOf(gid);
      var members = g.items.slice();
      if (pos >= 0) {
        state.order.splice(pos, 1);
        for (var i = 0; i < members.length; i++) state.order.splice(pos + i, 0, members[i]);
      } else {
        for (var j = 0; j < members.length; j++) state.order.push(members[j]);
      }
      var gi = state.groups.indexOf(g);
      if (gi >= 0) state.groups.splice(gi, 1);
      applyDom();
      persist();
    }
    function toggleCollapsed(gid) {
      var g = findGroup(gid);
      if (!g) return;
      g.collapsed = !g.collapsed;
      applyDom();
      persist();
    }
    function renameGroup(gid, name) {
      var g = findGroup(gid);
      if (!g) return;
      name = String(name == null ? "" : name).trim().slice(0, 32) || (t ? t("newGroup") : "抽屉");
      g.name = name;
      applyDom();
      persist();
    }

    // ── 抽屉头 DOM（插件自有节点，可自由增删，非 React 拥有）────
    function syncGroupHeaders(nav) {
      var existing = {};
      var olds = nav.querySelectorAll("[data-snm-group]");
      for (var i = 0; i < olds.length; i++) existing[olds[i].getAttribute("data-snm-group-id")] = olds[i];
      var seen = {};
      for (var gi = 0; gi < state.groups.length; gi++) {
        var g = state.groups[gi];
        seen[g.id] = 1;
        var h = existing[g.id];
        if (!h) h = createGroupHeader(nav, g);
        updateGroupHeader(h, g);
      }
      Object.keys(existing).forEach(function (id) {
        if (!seen[id]) {
          try {
            existing[id].remove();
          } catch (e) {}
        }
      });
    }
    function createGroupHeader(nav, g) {
      var h = document.createElement("div");
      h.setAttribute("data-snm-group", "1");
      h.setAttribute("data-snm-group-id", g.id);
      var toggle = document.createElement("span");
      toggle.setAttribute("data-snm-group-toggle", "1");
      toggle.textContent = g.collapsed ? "▸" : "▾";
      var nameEl = document.createElement("span");
      nameEl.setAttribute("data-snm-group-name", "1");
      nameEl.textContent = g.name;
      var dis = document.createElement("button");
      dis.setAttribute("data-snm-group-dissolve", "1");
      dis.setAttribute("title", t ? t("dissolve") : "解散抽屉");
      dis.textContent = "×";
      h.appendChild(toggle);
      h.appendChild(nameEl);
      h.appendChild(dis);
      // 整个抽屉头都可点击折叠/展开（不再只有 ▾▸ 小触点）。
      // 单击延迟 220ms 判定：期间第二次点击（=双击改名）则取消折叠。
      var clickTimer = null;
      h.addEventListener("click", function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute("data-snm-group-input")) return;
        e.stopPropagation();
        e.preventDefault();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          return;
        }
        clickTimer = setTimeout(function () {
          clickTimer = null;
          toggleCollapsed(g.id);
        }, 220);
      });
      h.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        startRename(h, g.id, nameEl);
      });
      dis.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        if (editing) dissolveGroup(g.id);
      });
      nav.appendChild(h);
      return h;
    }
    function updateGroupHeader(h, g) {
      if (h.getAttribute("data-snm-renaming") === "1") return;
      var toggle = h.querySelector("[data-snm-group-toggle]");
      if (toggle) toggle.textContent = g.collapsed ? "▸" : "▾";
      var nameEl = h.querySelector("[data-snm-group-name]");
      if (nameEl && nameEl.textContent !== g.name) nameEl.textContent = g.name;
    }
    function startRename(header, gid, nameEl) {
      if (!editing) return;
      var g = findGroup(gid);
      if (!g) return;
      header.setAttribute("data-snm-renaming", "1");
      var input = document.createElement("input");
      input.type = "text";
      input.value = g.name;
      input.setAttribute("data-snm-group-input", "1");
      input.maxLength = 32;
      nameEl.style.display = "none";
      header.appendChild(input);
      input.focus();
      input.select();
      var done = false;
      function commit() {
        if (done) return;
        done = true;
        header.removeAttribute("data-snm-renaming");
        var val = input.value;
        try {
          input.remove();
        } catch (e) {}
        nameEl.style.display = "";
        renameGroup(gid, val);
      }
      function cancel() {
        if (done) return;
        done = true;
        header.removeAttribute("data-snm-renaming");
        try {
          input.remove();
        } catch (e2) {}
        nameEl.style.display = "";
      }
      input.addEventListener("click", function (e) {
        e.stopPropagation();
      });
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      });
    }
    function buildAddButton(nav, order) {
      var btn = nav.querySelector("[data-snm-add-group]");
      if (!editing) {
        if (btn) btn.remove();
        return;
      }
      if (!btn) {
        btn = document.createElement("div");
        btn.setAttribute("data-snm-add-group", "1");
        btn.textContent = t ? t("addGroup") : "＋ 新建抽屉";
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          e.preventDefault();
          if (editing) addGroup();
        });
        nav.appendChild(btn);
      }
      btn.style.order = String(order);
    }

    // ── 编辑模式切换 ───────────────────────────────────────────
    function setEditing(v) {
      v = !!v;
      if (editing === v) return;
      editing = v;
      applyDom();
      notifyEditing();
    }

    // ── 刷新（认行 + 应用态）────────────────────────────────────
    function refresh(ctx) {
      injectStyles();
      markRows(ctx);
      normalize();
      applyDom();
    }

    // ── 拖拽 + 眼睛：事件委托（坐标命中，不注入节点）────────────
    var drag = null;

    function clearDropMarks(nav) {
      if (!nav) return;
      var marked = nav.querySelectorAll('[data-snm-drop="1"]');
      for (var i = 0; i < marked.length; i++) marked[i].removeAttribute("data-snm-drop");
    }
    function collectSlots(nav, excludeId) {
      var els = [];
      var cells = navCells(nav);
      for (var i = 0; i < cells.length; i++) {
        var id = cells[i].getAttribute("data-snm-id");
        if (id && id !== excludeId) els.push({ el: cells[i], kind: "row", id: id });
      }
      var heads = nav.querySelectorAll("[data-snm-group]");
      for (var j = 0; j < heads.length; j++) {
        var gid = heads[j].getAttribute("data-snm-group-id");
        if (gid && gid !== excludeId) els.push({ el: heads[j], kind: "group", id: gid });
      }
      for (var k = 0; k < els.length; k++) {
        var r = els[k].el.getBoundingClientRect();
        els[k].top = r.top;
        els[k].bottom = r.bottom;
        els[k].mid = r.top + r.height / 2;
      }
      els.sort(function (a, b) {
        return a.top - b.top;
      });
      return els;
    }

    // 统一 drop 目标：hover 抽屉头→入组；否则按视觉槽位插入（组内 / 顶层）
    function computeDrop(nav, clientY, drag) {
      if (!drag.isGroup) {
        var heads = nav.querySelectorAll("[data-snm-group]");
        for (var i = 0; i < heads.length; i++) {
          var hr = heads[i].getBoundingClientRect();
          if (clientY >= hr.top && clientY <= hr.bottom) {
            return { type: "into-group", groupId: heads[i].getAttribute("data-snm-group-id") };
          }
        }
      }
      var els = collectSlots(nav, drag.id);
      var ref = null;
      for (var s = 0; s < els.length; s++) {
        if (clientY < els[s].mid) {
          ref = els[s];
          break;
        }
      }
      if (!ref) return { type: "insert-end" };
      if (ref.kind === "group") return { type: "insert-before", refType: "group", refId: ref.id };
      var gid = ref.el.getAttribute("data-snm-in-group");
      return { type: "insert-before", refType: "row", refId: ref.id, refGroup: gid || null };
    }

    function applyDrop(drag, drop) {
      if (drag.isGroup) {
        // 被拖的是抽屉：只在顶层排序（成员跟随），不入组
        var gid = drag.id;
        var cur = state.order.indexOf(gid);
        if (drop.type === "insert-end") {
          if (cur >= 0) state.order.splice(cur, 1);
          state.order.push(gid);
        } else if (drop.type === "insert-before") {
          var refTop = drop.refId;
          if (drop.refType === "row" && drop.refGroup) refTop = drop.refGroup;
          var pos = state.order.indexOf(refTop);
          if (cur >= 0) state.order.splice(cur, 1);
          if (pos < 0) pos = state.order.length;
          else if (cur >= 0 && cur < pos) pos--;
          state.order.splice(pos, 0, gid);
        }
        return;
      }
      // 被拖的是条目：从原位置移除，再插入目标
      removeItemEverywhere(drag.id);
      if (drop.type === "into-group") {
        var g = findGroup(drop.groupId);
        if (g) g.items.push(drag.id);
      } else if (drop.type === "insert-end") {
        state.order.push(drag.id);
      } else if (drop.type === "insert-before") {
        if (drop.refType === "group") {
          var p = state.order.indexOf(drop.refId);
          if (p < 0) p = state.order.length;
          state.order.splice(p, 0, drag.id);
        } else if (drop.refGroup) {
          var g2 = findGroup(drop.refGroup);
          if (g2) {
            var ip = g2.items.indexOf(drop.refId);
            if (ip < 0) ip = g2.items.length;
            g2.items.splice(ip, 0, drag.id);
          }
        } else {
          var p2 = state.order.indexOf(drop.refId);
          if (p2 < 0) p2 = state.order.length;
          state.order.splice(p2, 0, drag.id);
        }
      }
    }

    function onPointerDown(ctx, e) {
      if (!editing) return;
      var nav = findNav();
      if (!nav) return;
      var row = closestRow(e.target);
      var header = closestGroupHeader(e.target);
      if (row) {
        var rect = row.getBoundingClientRect();
        var offRight = rect.right - e.clientX;
        if (offRight <= ZONE_EYE) {
          drag = null;
          return;
        }
        drag = {
          id: row.getAttribute("data-snm-id"),
          isGroup: false,
          startX: e.clientX,
          startY: e.clientY,
          zone: "body",
          active: false,
          nav: nav,
          row: row,
        };
      } else if (header) {
        drag = {
          id: header.getAttribute("data-snm-group-id"),
          isGroup: true,
          startX: e.clientX,
          startY: e.clientY,
          zone: "group",
          active: false,
          nav: nav,
          row: header,
        };
      }
    }

    function onPointerMove(e) {
      if (!drag) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        drag.row.setAttribute("data-snm-dragging", "1");
        try {
          e.preventDefault();
        } catch (err) {}
      }
      if (!drag.active) return;
      try {
        e.preventDefault();
      } catch (err2) {}
      var drop = computeDrop(drag.nav, e.clientY, drag);
      clearDropMarks(drag.nav);
      if (drop && drop.type === "into-group") {
        var th = drag.nav.querySelector('[data-snm-group-id="' + drop.groupId + '"]');
        if (th) th.setAttribute("data-snm-drop", "1");
      }
      applyDrop(drag, drop);
      applyDom(); // 实时预览插入位置
    }

    function onPointerUp() {
      if (!drag) return;
      var wasDrag = drag.active;
      var row = drag.row;
      if (row) row.removeAttribute("data-snm-dragging");
      if (drag.nav) clearDropMarks(drag.nav);
      if (wasDrag) {
        normalize();
        applyDom();
        persist();
        justActed = true;
      }
      drag = null;
    }

    var justActed = false; // 拖拽/眼睛操作后吞掉紧随的 click（防误触发导航）

    function onClickCapture(e) {
      if (justActed) {
        justActed = false;
        try {
          e.preventDefault();
          e.stopPropagation();
        } catch (err) {}
        return;
      }
      if (!editing) return;
      var row = closestRow(e.target);
      if (!row) return;
      var rect = row.getBoundingClientRect();
      var offRight = rect.right - e.clientX;
      if (offRight <= ZONE_EYE) {
        // 眼睛分区：吞掉导航，单击即切换显隐（不置 justActed，避免吞掉下一次点击）
        try {
          e.preventDefault();
          e.stopPropagation();
        } catch (err2) {}
        toggleHidden(row.getAttribute("data-snm-id"));
      }
      // body 分区：普通点击 → 放行导航（不拦截）
    }

    function toggleHidden(id) {
      if (!id) return;
      var idx = state.hidden.indexOf(id);
      if (idx >= 0) state.hidden.splice(idx, 1);
      else state.hidden.push(id);
      applyDom();
      persist();
    }

    function closestRow(target) {
      if (!target || !target.closest) return null;
      return target.closest(SEL.navCell);
    }
    function closestGroupHeader(target) {
      if (!target || !target.closest) return null;
      return target.closest("[data-snm-group]");
    }

    // ── Escape 退出编辑 ─────────────────────────────────────────
    function onKeyDown(e) {
      if (e.key === "Escape" && editing) {
        setEditing(false);
      }
    }

    // ── 监听绑定（nav / document，随 apply 挂，return cleanup）───
    function bindEvents(ctx) {
      if (!document) return function () {};
      function pd(e) {
        onPointerDown(ctx, e);
      }
      function pm(e) {
        onPointerMove(e);
      }
      function pu() {
        onPointerUp();
      }
      function kc(e) {
        onKeyDown(e);
      }
      document.addEventListener("pointerdown", pd, true);
      document.addEventListener("pointermove", pm, true);
      document.addEventListener("pointerup", pu, true);
      document.addEventListener("click", onClickCapture, true);
      document.addEventListener("keydown", kc, true);
      return function () {
        document.removeEventListener("pointerdown", pd, true);
        document.removeEventListener("pointermove", pm, true);
        document.removeEventListener("pointerup", pu, true);
        document.removeEventListener("click", onClickCapture, true);
        document.removeEventListener("keydown", kc, true);
      };
    }

    // ── MutationObserver 自愈（React 重建 / 面板出现）────────────
    function observe(ctx) {
      if (!document || typeof MutationObserver === "undefined") return function () {};
      var mo = new MutationObserver(function () {
        var nav = findNav();
        if (nav) {
          if (nav.getAttribute("data-snm-nav") !== "1") {
            refresh(ctx);
          } else {
            // 行数变化时重新认行（切语言 / 分区增删）
            var marked = nav.querySelectorAll("[data-snm-row]").length;
            if (marked !== navCells(nav).length) refresh(ctx);
          }
        } else {
          // 面板关闭 → 编辑态复位（临时态不持久化）
          if (editing) setEditing(false);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return function () {
        mo.disconnect();
      };
    }

    // ── 齿轮按钮（settings.action 槽，order:-1 排「打开配置文件」左）──
    function GearButton() {
      var st = react.useState(editing);
      var isEditing = st[0];
      var setLocal = st[1];
      react.useEffect(function () {
        editingSubs.push(setLocal);
        return function () {
          var i = editingSubs.indexOf(setLocal);
          if (i >= 0) editingSubs.splice(i, 1);
        };
      }, []);
      var gearBtn = h(
        "button",
        {
          type: "button",
          "data-snm-gear": "1",
          "data-snm-active": isEditing ? "1" : "0",
          title: t ? (isEditing ? t("gearExit") : t("gear")) : "Edit navigation",
          onClick: function () {
            setEditing(!editing);
          },
          style: {
            background: isEditing ? "var(--dsw-alias-accent,#247bbf)" : "transparent",
            color: isEditing ? "#fff" : "inherit",
            border: "1px solid var(--dsw-alias-border,rgba(128,128,128,.35))",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            lineHeight: "1",
            padding: "5px 8px",
          },
        },
        "⚙",
      );
      // 编辑模式：齿轮左侧显示操作说明（退出即隐藏）。根元素恒为 div，避免按钮/容器切换重挂。
      return h(
        "div",
        {
          "data-snm-gear-wrap": "1",
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            minWidth: 0,
            marginLeft: "6px",
          },
        },
        isEditing
          ? h(
              "span",
              {
                "data-snm-hint": "1",
                style: {
                  fontSize: "12px",
                  lineHeight: "1.3",
                  color: "var(--dsw-alias-label-secondary,#888)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "280px",
                },
              },
              t ? t("editHint") : "拖拽排序 · 点眼睛隐藏 · 可收纳",
            )
          : null,
        gearBtn,
      );
    }

    // ── apply(ctx) ─────────────────────────────────────────────
    function apply(ctx) {
      t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, NS + ": dictionaries");

      ctxRef = ctx;
      // 先用默认态标 DOM，再异步拉真实 order/hidden（异常回退默认）。
      state = { order: [], groups: [], hidden: [] };
      refresh(ctx);
      loadStateAsync();

      // 齿轮按钮：settings.action 槽 order:-1
      ctx.effect(function () {
        return ctx.slots.inject("settings.action", function () {
          return ctx.slots.register(
            {
              name: "settings.action",
              id: NS + "-gear",
              order: -1,
              locale: NS,
            },
            GearButton,
          );
        });
      }, NS + ": gear");

      var unbind = bindEvents(ctx);
      var unobserve = observe(ctx);
      ctx.effect(function () {
        return function () {
          unbind();
          unobserve();
        };
      }, NS + ": dom");
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote", "remote.settings"];
    return module.exports;
  },
});
