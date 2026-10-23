// dsh-settings-nav-manager — client (web)
// 齿轮编辑模式 + 拖拽排序 + 条目显隐 + 抽屉收纳 + 持久化。
//
// 设计约束（来自 dsh-pet / dshmarket 实证）：
//  * 绝不改写 React 管理的 nav DOM 结构（replaceWith / removeChild 会抛 NotFoundError）。
//  * 只加 data-* 属性 + 注入 CSS（伪元素画字形），交互走坐标命中 + 事件委托。
//  * 认行靠 label 文本 / DOM 序号双向校验映射到 settings.section 的 options.id。
//  * 选择器全部收敛到 SEL / DATA 常量表，升级断链只改这一处。
//
// v1.0.1 修复（详见 CHANGELOG.md）：
//  * P0 冷启动丢数据：sections 投影不再依赖 nav 是否挂载；分区未知时 normalize 不裁剪、
//    persist 直接拒写。
//  * 持久化失败可见：save / conflict / 认行失配都会 report 一次（console.debug + 齿轮旁提示）。
//  * 写入带 revision，撞 SETTINGS_CONFLICT 时重读重放一次。
//  * 拖拽补 pointercancel / blur 兜底，拖拽中按快照重算，取消可完整回滚。
//  * MutationObserver 从「全文档子树」收敛到「body 直接子节点 + nav 自身」，并 rAF 合并。
//  * 键盘可达：Alt+↑/↓ 排序、h 显隐、Enter/Space 折叠、F2 改名、Escape 让路给输入框。
//  * 新增「恢复默认」入口；抽屉名与状态全部走 textContent，不再拼接选择器。
window.__ModuleLoader__.load({
  id: "dsh-settings-nav-manager",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    var NS = "settings-nav-manager";
    var STYLE_TAG = "settings-nav-manager-style";
    // 侧栏插件栏入口与 main 页面的同一个 id：
    //  * layout 用 `main` 槽里 key === id 的条目判断面板存在（否则 selectPanel 抛错）；
    //  * sidebar 用 `sidebar.panellist` 里的 id 渲染行、点击时切过去。
    var PANEL_ID = "settings-nav";

    // ── 选择器 / 数据属性常量表（升级断链只改这一处）──────────────
    var SEL = {
      panel: '[data-shortcut-modal="settings"]',
      navList: '[class*="navList"]',
      navCell: '[class*="navCell"]',
      navLabel: '[class*="navLabel"]',
    };
    var DATA = {
      nav: "data-snm-nav",
      editing: "data-snm-editing",
      row: "data-snm-row",
      id: "data-snm-id",
      hidden: "data-snm-hidden",
      inGroup: "data-snm-in-group",
      collapsed: "data-snm-collapsed",
      dragging: "data-snm-dragging",
      group: "data-snm-group",
      groupId: "data-snm-group-id",
      groupName: "data-snm-group-name",
      groupToggle: "data-snm-group-toggle",
      groupInput: "data-snm-group-input",
      groupDissolve: "data-snm-group-dissolve",
      renaming: "data-snm-renaming",
      addGroup: "data-snm-add-group",
      reset: "data-snm-reset",
      drop: "data-snm-drop",
      gear: "data-snm-gear",
      notice: "data-snm-notice",
      sr: "data-snm-sr",
      page: "data-snm-page",
      pageRow: "data-snm-page-row",
      pageId: "data-snm-page-id",
    };

    var ZONE_EYE = 40; // 命中眼睛分区（相对行右侧，px）
    var DRAG_THRESHOLD = 6; // >6px 判拖拽，低于阈值放行普通点击
    var RENAME_MAX = 32;
    var TAP_GUARD_MS = 350; // 拖拽后吞掉紧随 click 的时间窗
    var NOTICE_MS = 4000;

    // ── 文案（单一事实来源：locale/*.json 由 test/locale.test.mjs 校验一致性）──
    var DICT = {
      zh: {
        gear: "编辑导航",
        gearExit: "退出编辑导航",
        editHint: "拖拽排序 · 点眼睛隐藏 · 双击改名 · 可收纳 · 齿轮旁开关控制侧栏入口",
        keyboardHint: "Alt+↑/↓ 排序 · h 显隐 · Enter 折叠 · F2 改名",
        hidden: "已隐藏",
        show: "显示",
        hide: "隐藏",
        handle: "拖动以排序",
        reset: "恢复默认",
        resetDone: "已恢复默认顺序",
        saved: "已保存",
        saveFailed: "未能保存排版，重启后可能丢失",
        recognizeFailed: "导航结构变化，暂未应用整理",
        newGroup: "新抽屉",
        addGroup: "＋ 新建抽屉",
        dissolve: "解散抽屉",
        panel: "设置导航",
        pageHint: "点击任意分区，直接打开对应设置",
        empty: "设置分区尚未注册完成",
        retry: "重试",
        openFailed: "未能打开设置，请按 Ctrl+, 打开后再试",
        showHidden: "显示已隐藏分区",
        hideHidden: "收起已隐藏分区",
        entry: "侧栏入口",
        entryOn: "显示中",
        entryOff: "已隐藏",
        entryShowHint: "隐藏左侧插件栏的「设置导航」入口",
        entryHideHint: "重新显示左侧插件栏的「设置导航」入口",
        entryFailed: "侧栏入口切换失败，请稍后重试",
      },
      en: {
        gear: "Edit navigation",
        gearExit: "Exit navigation editing",
        editHint: "Drag to reorder · Eye hides · Double-click renames · Drawers collect · Switch by the gear hides the sidebar entry",
        keyboardHint: "Alt+↑/↓ reorder · h hide · Enter collapse · F2 rename",
        hidden: "Hidden",
        show: "Show",
        hide: "Hide",
        handle: "Drag to reorder",
        reset: "Reset to default",
        resetDone: "Default order restored",
        saved: "Saved",
        saveFailed: "Layout not saved — it may be lost after restart",
        recognizeFailed: "Navigation changed; layout not applied yet",
        newGroup: "New drawer",
        addGroup: "+ New drawer",
        dissolve: "Dissolve drawer",
        panel: "Settings navigation",
        pageHint: "Pick a section to open its settings directly",
        empty: "Settings sections are not registered yet",
        retry: "Retry",
        openFailed: "Could not open settings — press Ctrl+, and try again",
        showHidden: "Show hidden sections",
        hideHidden: "Hide hidden sections",
        entry: "Sidebar entry",
        entryOn: "Shown",
        entryOff: "Hidden",
        entryShowHint: "Hide the “Settings navigation” row in the left sidebar",
        entryHideHint: "Show the “Settings navigation” row in the left sidebar again",
        entryFailed: "Could not toggle the sidebar entry — try again",
      },
    };

    // ── 纯工具 ────────────────────────────────────────────────
    function isStr(x) {
      return typeof x === "string";
    }
    // 无原型链的字典：id / label 作键时不会被 constructor、__proto__ 命中
    function dict() {
      return Object.create(null);
    }
    function own(map, key) {
      return key !== undefined && key !== null && Object.prototype.hasOwnProperty.call(map, key);
    }
    function num(x) {
      return typeof x === "number" && isFinite(x) ? x : 0;
    }
    function dbg(where, err) {
      try {
        console.debug("[settings-nav-manager] " + where, err);
      } catch (e) {}
    }
    function countKeys(map) {
      var n = 0;
      for (var k in map) n++;
      return n;
    }
    function cloneState(s) {
      return {
        version: 1,
        order: s.order.slice(),
        groups: s.groups.map(function (g) {
          return { id: g.id, name: g.name, collapsed: !!g.collapsed, items: g.items.slice() };
        }),
        hidden: s.hidden.slice(),
        hideEntry: s.hideEntry === true,
      };
    }
    function findGroup(state, id) {
      for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
      return null;
    }
    function isGroupTop(state, id) {
      return findGroup(state, id) !== null;
    }

    // ── 宿主契约判定（纯函数，可单测）──────────────────────────
    // 「宿主的配置条目不存在」这一类错误才允许换写入口重试。
    function isMissingEntry(err) {
      if (!err) return false;
      var code = String(err.code || (err.error && err.error.code) || "");
      if (/NO_ENTRY|NOT_FOUND|NO_SUCH|MISSING/i.test(code)) return true;
      var msg = String(err.message || (err.error && err.error.message) || "");
      return /no configurable plugin entry|no such namespace|no volatile fields/i.test(msg);
    }
    // 我们的字段指纹：schema 里同时有这三个键，基本只可能是本插件
    function looksLikeOurs(entry) {
      var schema = entry && entry.schema;
      var fields = (schema && (schema.dict || schema.properties)) || null;
      if (!fields) return false;
      return "order" in fields && "groups" in fields && "hidden" in fields;
    }
    // 光字段名像还不够：值也得长成我们的样子，否则一个「恰好也叫 order/groups/hidden」
    // 的插件命名空间会被误认，而误认的代价是覆写别人的配置。
    function looksLikeOurValue(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      if (!Array.isArray(value.order) || !Array.isArray(value.hidden) || !Array.isArray(value.groups)) return false;
      if (value.version !== undefined && num(value.version) !== 1) return false;
      for (var i = 0; i < value.hidden.length; i++) if (!isStr(value.hidden[i])) return false;
      for (var j = 0; j < value.order.length; j++) if (!isStr(value.order[j])) return false;
      return true;
    }

    // ── sections 投影：只依赖 ctx，与 DOM 是否挂载无关（P0 根因）────
    function projectSections(ctx) {
      var out = [];
      var entries;
      try {
        entries = ctx.slots.entries("settings.section");
      } catch (e) {
        dbg("entries", e);
        return out;
      }
      for (var i = 0; i < entries.length; i++) {
        var o = entries[i] && entries[i].options ? entries[i].options : {};
        var lbl = o.label;
        if (typeof lbl === "function") {
          try {
            lbl = lbl();
          } catch (e2) {
            dbg("label", e2);
            lbl = "";
          }
        }
        out.push({
          id: o.id ? String(o.id) : "",
          order: num(o.order),
          label: lbl ? String(lbl) : "",
        });
      }
      out.sort(function (a, b) {
        return a.order - b.order;
      });
      return out;
    }

    function knownIdsFrom(sections) {
      var set = dict();
      for (var i = 0; i < sections.length; i++) if (sections[i].id) set[sections[i].id] = 1;
      return set;
    }
    function sectionIds(sections) {
      var out = [];
      for (var i = 0; i < sections.length; i++) if (sections[i].id) out.push(sections[i].id);
      return out;
    }

    // ── 页面行投影（纯函数）：把 order / groups / hidden 摊平成一维可点列表 ──
    // 抽屉里的成员紧跟着抽屉名连续出现（页面不是设置导航，不做折叠）；
    // 未落位的分区按宿主 order 追加，保证「新装插件立刻可点」。
    function flattenNav(sections, state) {
      var byId = dict();
      var hidden = dict();
      var rows = [];
      var placed = dict();
      var i;
      var j;
      for (i = 0; i < sections.length; i++) if (sections[i].id) byId[sections[i].id] = sections[i];
      for (i = 0; i < state.hidden.length; i++) hidden[state.hidden[i]] = 1;
      function push(id, groupName) {
        var s = byId[id];
        if (!s || own(placed, id)) return;
        placed[id] = 1;
        rows.push({ id: id, label: s.label, hidden: own(hidden, id), group: groupName || "" });
      }
      for (i = 0; i < state.order.length; i++) {
        var g = findGroup(state, state.order[i]);
        if (g) {
          for (j = 0; j < g.items.length; j++) push(g.items[j], g.name);
        } else {
          push(state.order[i], "");
        }
      }
      for (i = 0; i < sections.length; i++) push(sections[i].id, "");
      return rows;
    }

    // sections 指纹：id / order / label 任一变化就要通知页面重渲染
    function sectionsSignature(sections) {
      var parts = [];
      for (var i = 0; i < sections.length; i++) {
        parts.push(sections[i].id + "\u0001" + sections[i].order + "\u0001" + sections[i].label);
      }
      return parts.join("\u0002");
    }

    // 行的首字徽标：按码点取首字符（emoji/中文都不会被截成半个代理对）
    function glyphOf(label) {
      var s = label === undefined || label === null ? "" : String(label);
      if (!s) return "?";
      var chars = typeof Array.from === "function" ? Array.from(s) : s.split("");
      return chars[0] || "?";
    }

    // ── 持久化态：读取归一化（纯函数，异常输入一律回退默认）─────────
    function createState(raw) {
      var v = raw && typeof raw === "object" ? raw : {};
      var groups = [];
      if (Array.isArray(v.groups)) {
        for (var i = 0; i < v.groups.length; i++) {
          var g = v.groups[i];
          if (!g || !isStr(g.id) || !g.id) continue;
          groups.push({
            id: String(g.id),
            name: isStr(g.name) ? String(g.name) : "",
            collapsed: !!g.collapsed,
            items: Array.isArray(g.items) ? g.items.filter(isStr) : [],
          });
        }
      }
      return {
        version: 1,
        order: Array.isArray(v.order) ? v.order.filter(isStr) : [],
        groups: groups,
        hidden: Array.isArray(v.hidden) ? v.hidden.filter(isStr) : [],
        // 旧版本没有这个字段：缺省 = 显示，绝不把老用户入口藏掉
        hideEntry: v.hideEntry === true,
      };
    }

    // ── 归一化（纯函数）：known 为空时原样返回，绝不裁剪 ───────────
    // v1.0.0 的数据丢失就发生在这里：设置面板未挂载时 sections 为空，
    // 旧实现拿空 known 去过滤，把 order / groups.items / hidden 全清掉。
    function normalizeState(state, known, sectionOrder) {
      var next = cloneState(state);
      if (countKeys(known) === 0) return next; // 不知道合法 id 域 → 什么都不动

      var placed = dict();
      var gi, ii, id, oi, top;

      // 1) 组内成员：只去重，不因为「此刻没见到这个分区」就丢掉。
      //    分区是各插件在各自 apply 里注册的，启动早期 sections 可能只到一半；
      //    此时裁剪 = 又一次静默丢数据。真正的非法 id 由写盘前的 serializeState 过滤。
      for (gi = 0; gi < next.groups.length; gi++) {
        var g = next.groups[gi];
        var ng = [];
        for (ii = 0; ii < g.items.length; ii++) {
          id = g.items[ii];
          if (!own(placed, id)) {
            placed[id] = 1;
            ng.push(id);
          }
        }
        g.items = ng;
      }

      // 2) 顶层顺序：抽屉保序、分区保序、去重（未知 id 原样保留在原位）
      var newOrder = [];
      var seenTop = dict();
      for (oi = 0; oi < next.order.length; oi++) {
        top = next.order[oi];
        if (isGroupTop(next, top)) {
          if (!own(seenTop, top)) {
            seenTop[top] = 1;
            newOrder.push(top);
          }
        } else if (!own(placed, top) && !own(seenTop, top)) {
          placed[top] = 1; // 标记已落位，避免第 3 步重复追加
          seenTop[top] = 1;
          newOrder.push(top);
        }
      }

      // 3) 新分区：按宿主 options.order 追加到末尾
      var hostOrder = sectionOrder || [];
      for (gi = 0; gi < hostOrder.length; gi++) {
        id = hostOrder[gi];
        if (own(known, id) && !own(placed, id)) {
          placed[id] = 1;
          newOrder.push(id);
        }
      }

      // 4) 有抽屉但不在 order 里的，补到末尾
      for (gi = 0; gi < next.groups.length; gi++) {
        var gid = next.groups[gi].id;
        if (!own(seenTop, gid)) {
          seenTop[gid] = 1;
          newOrder.push(gid);
        }
      }

      next.order = newOrder;
      // 隐藏表同样只去重；已卸载插件的 id 留到写盘时再清
      var seenHidden = dict();
      next.hidden = next.hidden.filter(function (id2) {
        if (own(seenHidden, id2)) return false;
        seenHidden[id2] = 1;
        return true;
      });
      return next;
    }

    // ── 写前序列化（纯函数）：known 为空时返回 null = 拒绝写入 ──────
    function serializeState(state, known) {
      if (countKeys(known) === 0) return null; // 不知道合法 id 域时，宁可不写
      return {
        order: state.order.filter(function (id) {
          return own(known, id) || isGroupTop(state, id);
        }),
        groups: state.groups.map(function (g) {
          return {
            id: g.id,
            name: g.name,
            collapsed: !!g.collapsed,
            items: g.items.filter(function (id) {
              return own(known, id);
            }),
          };
        }),
        hidden: state.hidden.filter(function (id) {
          return own(known, id);
        }),
        // 布尔开关：跟着写盘走，但不受 known id 域影响
        hideEntry: state.hideEntry === true,
      };
    }

    // ── 拖拽落点应用（纯函数：基于快照重算，天然可回滚）─────────────
    function removeIdEverywhere(state, id) {
      var oi = state.order.indexOf(id);
      if (oi >= 0) state.order.splice(oi, 1);
      for (var i = 0; i < state.groups.length; i++) {
        var gi = state.groups[i].items.indexOf(id);
        if (gi >= 0) state.groups[i].items.splice(gi, 1);
      }
    }

    function applyDropTo(state, drag, drop) {
      var next = cloneState(state);
      if (!drop) return next;
      if (drag.isGroup) {
        var gid = drag.id;
        var cur = next.order.indexOf(gid);
        var target = null;
        if (drop.type === "insert-end") target = next.order.length;
        else if (drop.type === "insert-before") {
          var refTop = drop.refType === "row" && drop.refGroup ? drop.refGroup : drop.refId;
          target = next.order.indexOf(refTop);
          if (target < 0) target = next.order.length;
          else if (cur >= 0 && cur < target) target -= 1;
        } else if (drop.type === "into-group") {
          // 抽屉不能嵌抽屉 → 视作插到该抽屉前
          target = next.order.indexOf(drop.groupId);
          if (target < 0) target = next.order.length;
          else if (cur >= 0 && cur < target) target -= 1;
        }
        if (target === null) return next;
        if (cur >= 0) next.order.splice(cur, 1);
        if (target > next.order.length) target = next.order.length;
        if (target < 0) target = 0;
        next.order.splice(target, 0, gid);
        return next;
      }

      removeIdEverywhere(next, drag.id);
      if (drop.type === "into-group") {
        var g = findGroup(next, drop.groupId);
        if (g) g.items.push(drag.id);
        else next.order.push(drag.id);
      } else if (drop.type === "insert-end") {
        next.order.push(drag.id);
      } else if (drop.type === "insert-before") {
        if (drop.refType === "group") {
          var p = next.order.indexOf(drop.refId);
          if (p < 0) p = next.order.length;
          next.order.splice(p, 0, drag.id);
        } else if (drop.refGroup) {
          var g2 = findGroup(next, drop.refGroup);
          if (g2) {
            var ip = g2.items.indexOf(drop.refId);
            if (ip < 0) ip = g2.items.length;
            g2.items.splice(ip, 0, drag.id);
          } else {
            next.order.push(drag.id);
          }
        } else {
          var p2 = next.order.indexOf(drop.refId);
          if (p2 < 0) p2 = next.order.length;
          next.order.splice(p2, 0, drag.id);
        }
      }
      return next;
    }

    // 键盘微调：在同一容器内与邻居交换（无容器则不动）
    function nudgeState(state, id, delta) {
      var next = cloneState(state);
      var list = null;
      var idx = next.order.indexOf(id);
      if (idx >= 0) list = next.order;
      else {
        for (var i = 0; i < next.groups.length; i++) {
          var gi = next.groups[i].items.indexOf(id);
          if (gi >= 0) {
            list = next.groups[i].items;
            idx = gi;
            break;
          }
        }
      }
      if (!list) return next;
      var to = idx + delta;
      if (to < 0 || to >= list.length) return next;
      var tmp = list[to];
      list[to] = list[idx];
      list[idx] = tmp;
      return next;
    }

    // ── 样式（纯字符串，便于测试）────────────────────────────────
    function buildCss() {
      var eyeOpen =
        "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'/><circle cx='12' cy='12' r='2.5'/></svg>";
      var eyeOff =
        "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'/><circle cx='12' cy='12' r='2.5'/><line x1='3.5' y1='3.5' x2='20.5' y2='20.5'/></svg>";
      var on = 'url("data:image/svg+xml,' + encodeURIComponent(eyeOpen) + '")';
      var off = 'url("data:image/svg+xml,' + encodeURIComponent(eyeOff) + '")';
      return [
        // 容器：确保 flex column，order 生效
        "[data-snm-nav]{display:flex;flex-direction:column;}",
        "[data-snm-row]{position:relative;}",
        // 编辑模式：眼睛（::after，描线 SVG + currentColor 随主题）
        '[data-snm-editing="1"] [data-snm-row]::after{',
        '  content:"";position:absolute;right:20px;top:0;bottom:0;width:18px;',
        "  background-color:currentColor;opacity:.72;pointer-events:none;",
        "  -webkit-mask:" + on + " center/contain no-repeat;",
        "  mask:" + on + " center/contain no-repeat;",
        "}",
        // 隐藏：换「划线眼」，眼睛常驻（保留可见、可点回）
        '[data-snm-editing="1"] [data-snm-row][data-snm-hidden="1"]::after{',
        "  -webkit-mask:" + off + " center/contain no-repeat;",
        "  mask:" + off + " center/contain no-repeat;",
        "  opacity:.9;",
        "}",
        // 隐藏：只置灰内容，眼睛保持亮
        '[data-snm-row][data-snm-hidden="1"] [class*="navLabel"],',
        '[data-snm-row][data-snm-hidden="1"] [class*="navIcon"]{opacity:.42;}',
        '[data-snm-editing="0"] [data-snm-row][data-snm-hidden="1"]{display:none;}',
        // 编辑模式：预留眼睛位 + 标签截断
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
        // 抽屉头
        "[data-snm-group]{",
        "  display:flex;align-items:center;gap:8px;margin:2px 0;height:40px;",
        "  padding:0 12px;border-radius:6px;cursor:grab;position:relative;",
        "  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));",
        "  font-family:inherit;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary,#ccc);",
        "}",
        '[data-snm-group][data-snm-dragging="1"]{opacity:.6;outline:1px dashed var(--dsw-alias-accent,#247bbf);outline-offset:-1px;cursor:grabbing;}',
        "[data-snm-group-toggle]{cursor:pointer;user-select:none;flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;}",
        "[data-snm-group-name]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary,#ccc);}",
        "[data-snm-group-input]{flex:1 1 auto;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#222);border:1px solid var(--dsw-alias-accent,#247bbf);border-radius:4px;padding:2px 4px;}",
        "[data-snm-group-dissolve]{flex:none;opacity:0;cursor:pointer;background:transparent;border:none;color:var(--dsw-alias-label-secondary,#888);font-size:14px;line-height:1;padding:2px 5px;border-radius:4px;}",
        '[data-snm-editing="1"] [data-snm-group]:hover [data-snm-group-dissolve]{opacity:1;}',
        "[data-snm-group-dissolve]:hover{background:var(--dsw-alias-state-error-primary,#c33);color:#fff;}",
        // 组内条目：L 型归属线 + 缩进
        "[data-snm-row][data-snm-in-group]{",
        "  padding-left:30px;",
        "  background-image:",
        "    linear-gradient(to bottom, var(--dsw-alias-border,rgba(128,128,128,.4)), var(--dsw-alias-border,rgba(128,128,128,.4))),",
        "    linear-gradient(to right, var(--dsw-alias-border,rgba(128,128,128,.4)), var(--dsw-alias-border,rgba(128,128,128,.4)));",
        "  background-size:1.5px 100%, 12px 1.5px;",
        "  background-position:12px 0, 12px 50%;",
        "  background-repeat:no-repeat, no-repeat;",
        "}",
        '[data-snm-row][data-snm-collapsed="1"]{display:none;}',
        '[data-snm-group][data-snm-drop="1"]{',
        "  background:var(--dsw-alias-state-accent-bg,rgba(36,123,191,.16));",
        "  outline:1.5px solid var(--dsw-alias-accent,#247bbf);outline-offset:-1px;",
        "}",
        // 底部：新建抽屉 / 恢复默认
        "[data-snm-add-group],[data-snm-reset]{",
        "  margin:4px 0;padding:6px 8px;cursor:pointer;text-align:center;font-size:12px;",
        "  border:1px dashed var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:6px;",
        "  color:var(--dsw-alias-label-secondary,#888);",
        "}",
        "[data-snm-add-group]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}",
        "[data-snm-reset]{border-style:solid;border-color:transparent;margin-top:2px;}",
        "[data-snm-reset]:hover{color:var(--dsw-alias-state-error-primary,#c33);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}",
        // 键盘焦点可见
        "[data-snm-group]:focus-visible,[data-snm-add-group]:focus-visible,[data-snm-reset]:focus-visible{",
        "  outline:2px solid var(--dsw-alias-accent,#247bbf);outline-offset:1px;",
        "}",
        // ── 侧栏入口对应的 main 页面（纯自有节点，不依赖宿主类名）──
        "[data-snm-page]{height:100%;overflow:auto;box-sizing:border-box;padding:24px 28px;",
        "  color:var(--dsw-alias-label-primary,#ccc);font-family:inherit;}",
        "[data-snm-page-head]{display:flex;align-items:center;gap:10px;margin:0 0 6px;}",
        "[data-snm-page-title]{margin:0;font-size:16px;line-height:24px;font-weight:600;}",
        "[data-snm-page-count]{flex:none;padding:1px 8px;border-radius:999px;font-size:12px;",
        "  border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));",
        "  color:var(--dsw-alias-label-secondary,#888);}",
        "[data-snm-page-hint]{margin:0 0 16px;font-size:12px;line-height:1.4;",
        "  color:var(--dsw-alias-label-secondary,#888);}",
        "[data-snm-page-list]{display:flex;flex-direction:column;gap:4px;max-width:640px;}",
        "[data-snm-page-row]{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;",
        "  min-height:36px;padding:7px 12px;border:1px solid transparent;border-radius:8px;",
        "  background:transparent;color:inherit;font:inherit;font-size:14px;text-align:left;cursor:pointer;}",
        "[data-snm-page-row]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}",
        "[data-snm-page-row]:focus-visible{outline:2px solid var(--dsw-alias-accent,#247bbf);outline-offset:1px;}",
        "[data-snm-page-glyph]{flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;",
        "  align-items:center;justify-content:center;font-size:12px;line-height:1;",
        "  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));",
        "  color:var(--dsw-alias-label-secondary,#888);}",
        "[data-snm-page-label]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-snm-page-group]{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#888);}",
        "[data-snm-page-badge]{flex:none;padding:1px 6px;border-radius:999px;font-size:11px;",
        "  border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));",
        "  color:var(--dsw-alias-label-secondary,#888);}",
        '[data-snm-page-row][data-snm-page-hidden="1"]{opacity:.55;}',
        "[data-snm-page-foot]{margin-top:10px;display:flex;gap:8px;max-width:640px;}",
        "[data-snm-page-foot] button{margin:0;padding:6px 10px;cursor:pointer;font:inherit;font-size:12px;",
        "  border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:6px;",
        "  background:transparent;color:var(--dsw-alias-label-secondary,#888);}",
        "[data-snm-page-foot] button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}",
        "[data-snm-page-foot] button:focus-visible{outline:2px solid var(--dsw-alias-accent,#247bbf);outline-offset:1px;}",
        "[data-snm-page-empty]{margin:12px 0;font-size:13px;color:var(--dsw-alias-label-secondary,#888);}",
        // 屏读文本
        "[data-snm-sr]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;",
        "  overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}",
      ].join("\n");
    }

    // ══ 实例：所有可变状态都在这个闭包里，模块层面保持无状态 ══════
    function createPlugin(ctx) {
      var editing = false;
      var state = { version: 1, order: [], groups: [], hidden: [] };
      var sections = [];
      var revision;
      // 实际用于写入的命名空间：默认 NS；若宿主把条目 id 改写（别名安装等），
      // findNs() 会认领真实 id 并记在这里。
      var nsId = NS;
      // nsResolved=false 表示「describe 明确告诉我们自己的命名空间不存在」——
      // 此时一律不写（失败关闭）。默认 true：describe 尚未返回前保持旧行为。
      var nsResolved = true;
      var groupSeq = 1;
      var t = null;
      var drag = null;
      var dragGen = 0; // 拖拽世代号：抬手后排队的帧回调必须自动作废
      var justActedAt = 0;
      var notice = "";
      var noticeTimer = null;
      var reported = dict();
      var disposed = false;
      var uiSubs = [];
      var styleEl = null;
      var bodyMo = null;
      var navMo = null;
      var navNode = null;
      var lastFingerprint = "";
      var lastSectionsSig = "";
      var rafId = 0;
      var cleanups = [];

      // ── 通知（齿轮组件订阅）──────────────────────────────────
      function publish() {
        for (var i = 0; i < uiSubs.length; i++) {
          try {
            uiSubs[i](function (n) {
              return n + 1;
            });
          } catch (e) {
            dbg("ui notify", e);
          }
        }
      }
      function setNotice(msg) {
        notice = msg || "";
        if (noticeTimer) {
          clearTimeout(noticeTimer);
          noticeTimer = null;
        }
        if (notice) {
          noticeTimer = setTimeout(function () {
            noticeTimer = null;
            notice = "";
            publish();
          }, NOTICE_MS);
        }
        publish();
      }
      // 同一类故障只报一次，避免刷屏
      function report(kind, err, msgKey) {
        if (reported[kind]) return;
        reported[kind] = 1;
        dbg(kind, err);
        var key = msgKey || "saveFailed";
        var base = t ? t(key) : DICT.zh[key] || DICT.zh.saveFailed;
        var reason = kind === "save" ? reasonOf(err) : "";
        setNotice(reason ? base + "（" + reason + "）" : base);
      }
      // 把宿主/RPC 的错误压成一小段可读文本，方便用户直接截图反馈
      function reasonOf(err) {
        if (!err) return "";
        if (typeof err === "string") return err.slice(0, 40);
        var code = err.code || (err.error && err.error.code);
        var msg = err.message || (err.error && err.error.message) || "";
        var short = String(msg).split("\n")[0].slice(0, 40);
        return code && short ? code + ": " + short : short || (code ? String(code) : "");
      }
      function okOf(res) {
        // 网关把失败放在 { ok: false, error } 里返回，不会 reject —— 必须显式判断
        if (res && typeof res === "object" && res.ok === false) return false;
        return true;
      }
      // 客户端远程的返回是 { ok: true, value } / { ok: false, error } 信封。
      // 直接当裸对象读（res.namespaces）会永远读到 undefined —— 1.0.x 的
      //「重启就恢复默认」就是这么来的：每次启动都拿空状态覆盖自己。
      function unwrapValue(res) {
        if (res && typeof res === "object" && Object.prototype.hasOwnProperty.call(res, "ok")) {
          if (res.ok === false) {
            var e = res.error || {};
            var err = new Error(e.message || "remote call rejected");
            err.code = e.code;
            throw err;
          }
          return res.value;
        }
        return res;
      }
      function clearReport(kind) {
        if (reported[kind]) delete reported[kind];
      }

      // ── 深链：打开设置并选中某个分区（三层降级）───────────────
      // ① 设置弹窗的 shell store（sidebar.settings 条目注册时带的 store handle）
      //    暴露 openSection(id)：一步「打开 + 选中」。create() 在 0.2.1 里被
      //    settings-general 覆写成固定单例，所以直接 create() 拿到的就是 React
      //    正在用的那个实例 —— 失败也只可能是不存在，不会污染状态。
      // ② DOM 兜底：弹窗已在，按 label 命中 navCell 后 .click()（走宿主自己的 select）。
      // ③ 都失败：齿轮旁提示，绝不静默。
      function shellActionsOf() {
        var entry = null;
        try {
          var list = ctx.slots.entriesOfSlot("sidebar.settings");
          entry = list && list[0];
        } catch (e) {
          dbg("settings entry", e);
        }
        var handle = entry && entry.store;
        if (!handle || typeof handle.create !== "function") return null;
        try {
          var instance = handle.create();
          return instance && instance.actions ? instance.actions : null;
        } catch (e2) {
          dbg("settings store", e2);
          return null;
        }
      }
      function labelOfSection(id) {
        for (var i = 0; i < sections.length; i++) if (sections[i].id === id) return sections[i].label;
        return "";
      }
      // 按 data 属性线性查找 + label 兜底（不拼接选择器）
      function clickNavCell(id) {
        var nav = findNav();
        if (!nav) return false;
        var cells = navCells(nav);
        var label = labelOfSection(id);
        for (var i = 0; i < cells.length; i++) {
          if (cells[i].getAttribute(DATA.id) === id) {
            cells[i].click();
            return true;
          }
        }
        if (!label) return false;
        for (var j = 0; j < cells.length; j++) {
          if (rowLabel(cells[j]) === label) {
            cells[j].click();
            return true;
          }
        }
        return false;
      }
      function failOpen() {
        setNotice(t ? t("openFailed") : DICT.zh.openFailed);
      }
      function openSettingsSection(id) {
        var sid = id === undefined || id === null ? "" : String(id);
        if (!sid) return false;
        var actions = shellActionsOf();
        if (actions && typeof actions.openSection === "function") {
          try {
            actions.openSection(sid);
            return true;
          } catch (e) {
            dbg("openSection", e);
          }
        }
        // 没有 openSection：先只打开弹窗，再等分区渲染出来后点一下
        var opened = false;
        if (actions && typeof actions.open === "function") {
          try {
            actions.open();
            opened = true;
          } catch (e2) {
            dbg("open settings", e2);
          }
        }
        var attempts = 0;
        (function retry() {
          if (disposed) return;
          if (clickNavCell(sid)) return;
          if (!opened && !findNav()) {
            if (attempts === 0) failOpen(); // 弹窗根本打不开：立刻报，别假装成功
            return;
          }
          attempts++;
          if (attempts <= 5) {
            setTimeout(retry, 60);
            return;
          }
          failOpen();
        })();
        return true;
      }

      // ── 侧栏入口的显隐（编辑模式里齿轮旁的开关）─────────────────
      // 只摘「侧栏那一行」，main 页面始终留在册：layout 指向一个不存在的主面板
      // 会直接抛错，而隐藏入口时用户可能正停在该页面上。
      var entryRendered = false;
      var entryDisposers = [];
      function entryHidden() {
        return state && state.hideEntry === true;
      }
      function disposeEntry() {
        while (entryDisposers.length) {
          var d = entryDisposers.pop();
          try {
            if (typeof d === "function") d();
          } catch (e) {
            dbg("entry dispose", e);
          }
        }
      }
      function renderEntry() {
        entryDisposers.push(
          ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 20,
                locale: NS,
                label: function () {
                  return t ? t("panel") : DICT.zh.panel;
                },
              },
              SettingsNavIcon,
            );
          }),
        );
      }
      function syncEntry() {
        var want = !entryHidden();
        if (want === entryRendered) return; // 幂等：状态没变就不动 DOM，免得侧栏闪
        disposeEntry();
        entryRendered = false;
        if (!want) return;
        try {
          renderEntry();
          entryRendered = true;
        } catch (e) {
          // 宿主槽位拒绝注册时不能把异常甩进点击处理器里：退回「入口仍在」的状态
          dbg("entry register", e);
          report("entry", e, "entryFailed");
        }
      }
      function setEntryHidden(hidden) {
        var next = hidden === true;
        if (entryHidden() === next) return;
        state = cloneState(state);
        state.hideEntry = next;
        syncEntry();
        publish();
        persist();
      }

      // ── 样式注入 / 清理 ─────────────────────────────────────
      function ensureStyles() {
        if (!document || !document.head) return;
        if (styleEl && styleEl.parentNode) return;
        var existing = document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]');
        if (existing) {
          styleEl = existing;
          return;
        }
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin", NS);
        tag.setAttribute("data-plugin-css", STYLE_TAG);
        tag.textContent = buildCss();
        document.head.appendChild(tag);
        styleEl = tag;
      }
      function removeStyles() {
        if (styleEl && styleEl.parentNode) {
          try {
            styleEl.parentNode.removeChild(styleEl);
          } catch (e) {
            dbg("remove style", e);
          }
        }
        styleEl = null;
      }

      // ── 定位 ────────────────────────────────────────────────
      function findNav() {
        if (!document) return null;
        var panel = document.querySelector(SEL.panel);
        if (!panel) return null;
        return panel.querySelector(SEL.navList);
      }
      function navCells(nav) {
        if (!nav) return [];
        var list = nav.querySelectorAll(":scope > " + SEL.navCell);
        return Array.prototype.slice.call(list);
      }
      function rowLabel(cell) {
        var el = cell.querySelector(SEL.navLabel);
        return el ? (el.textContent || "").trim() : "";
      }
      // 按数据属性线性查找（不再拼接选择器，id 里有引号也不会炸 querySelector）
      function findByAttr(root, attr, value) {
        if (!root || value === null || value === undefined) return null;
        var all = root.querySelectorAll("[" + attr + "]");
        for (var i = 0; i < all.length; i++) {
          if (all[i].getAttribute(attr) === String(value)) return all[i];
        }
        return null;
      }

      // ── 认行：序号为主、label 为兜底，双向校验 ─────────────────
      function markRows(nav) {
        var cells = navCells(nav);
        var byLabel = dict();
        for (var s = 0; s < sections.length; s++) {
          var key = sections[s].label;
          if (key && !own(byLabel, key)) byLabel[key] = sections[s].id;
        }
        var sameLen = cells.length === sections.length;
        var used = dict();
        var mappedCount = 0;
        for (var i = 0; i < cells.length; i++) {
          var cell = cells[i];
          var label = rowLabel(cell);
          var id = null;
          if (sameLen && sections[i] && sections[i].id) {
            // 文本一致（或还没渲染出文本）→ 按序号确认
            if (!label || label === sections[i].label) id = sections[i].id;
          }
          if (!id && label && own(byLabel, label)) id = byLabel[label];
          if (id && own(used, id)) id = null; // 重复 id 不认
          if (!id && sameLen && sections[i] && sections[i].id && !own(used, sections[i].id)) {
            id = sections[i].id; // 序号兜底
          }
          if (id) {
            used[id] = 1;
            mappedCount++;
            cell.setAttribute(DATA.row, "1");
            cell.setAttribute(DATA.id, id);
          } else {
            cell.removeAttribute(DATA.row);
            cell.removeAttribute(DATA.id);
          }
        }
        return mappedCount;
      }

      // ── 应用 order / groups / hidden / editing ─────────────────
      function applyDom(nav) {
        nav.setAttribute(DATA.nav, "1");
        nav.setAttribute(DATA.editing, editing ? "1" : "0");
        var hiddenSet = dict();
        for (var k = 0; k < state.hidden.length; k++) hiddenSet[state.hidden[k]] = 1;
        var cellById = dict();
        var cells = navCells(nav);
        for (var ci = 0; ci < cells.length; ci++) {
          var cid = cells[ci].getAttribute(DATA.id);
          if (cid) cellById[cid] = cells[ci];
        }
        syncGroupHeaders(nav);
        var counter = 0;
        for (var ti = 0; ti < state.order.length; ti++) {
          var top = state.order[ti];
          var g = findGroup(state, top);
          if (g) {
            var header = findByAttr(nav, DATA.groupId, top);
            if (header) header.style.order = String(counter++);
            for (var mi = 0; mi < g.items.length; mi++) {
              var mid = g.items[mi];
              var mcell = cellById[mid];
              if (!mcell) continue;
              mcell.style.order = String(counter++);
              mcell.setAttribute(DATA.inGroup, g.id);
              if (g.collapsed) mcell.setAttribute(DATA.collapsed, "1");
              else mcell.removeAttribute(DATA.collapsed);
              if (own(hiddenSet, mid)) mcell.setAttribute(DATA.hidden, "1");
              else mcell.removeAttribute(DATA.hidden);
            }
          } else {
            var cell = cellById[top];
            if (!cell) continue;
            cell.style.order = String(counter++);
            cell.removeAttribute(DATA.inGroup);
            cell.removeAttribute(DATA.collapsed);
            if (own(hiddenSet, top)) cell.setAttribute(DATA.hidden, "1");
            else cell.removeAttribute(DATA.hidden);
          }
        }
        for (var bi = 0; bi < cells.length; bi++) {
          if (!cells[bi].style.order) cells[bi].style.order = String(1000 + bi);
        }
        buildTail(nav, counter);
      }

      // ── 一次同步：投影 → 认行 → 归一化 → 应用 ──────────────────
      function sync() {
        if (disposed) return;
        ensureStyles();
        sections = projectSections(ctx); // 永远先算，不看 DOM（P0）
        // 入口页的行数据 = 这里的投影 + normalized state：两者都更新完再通知
        var sig = sectionsSignature(sections);
        var sigChanged = sig !== lastSectionsSig;
        lastSectionsSig = sig;
        var nav = findNav();
        var mapped = nav ? markRows(nav) : 0;
        var total = nav ? navCells(nav).length : 0;
        state = normalizeState(state, knownIdsFrom(sections), sectionIds(sections));
        if (sigChanged) publish();
        // 入口显隐跟着 state 走：这里是唯一的注册/注销时机（含启动与恢复默认后）
        syncEntry();
        if (!nav) return;
        // 尽力应用：认不全也要把认出来的排好，而不是整体不生效
        applyDom(nav);
        if (total > 0 && mapped < total && sections.length) {
          report("recognize", "unmapped rows " + mapped + "/" + total, "recognizeFailed");
        }
      }

      // ── 持久化 ──────────────────────────────────────────────
      function remote() {
        return ctx && ctx.remote ? ctx.remote.settings : null;
      }
      // 一次写入尝试：返回 { ok, res, error }，不抛异常
      function writeVia(method, payload, ops) {
        var rm = remote();
        if (!rm || typeof rm[method] !== "function") {
          return Promise.resolve({ ok: false, error: new Error(method + " unavailable") });
        }
        var args = method === "mutate" ? [nsId, ops] : [nsId, payload];
        if (typeof revision === "number") args.push(revision);
        var p;
        try {
          p = Promise.resolve(rm[method].apply(rm, args));
        } catch (e) {
          p = Promise.reject(e);
        }
        return p.then(
          function (res) {
            if (!okOf(res)) {
              return { ok: false, res: res, error: (res && res.error) || { message: method + " rejected" } };
            }
            return { ok: true, res: res };
          },
          function (err) {
            return { ok: false, error: err };
          },
        );
      }
      // 路径式 ops：与宿主设置页自己写表单的方式一致
      function payloadOps(payload) {
        return [
          { op: "set", path: ["order"], value: payload.order },
          { op: "set", path: ["groups"], value: payload.groups },
          { op: "set", path: ["hidden"], value: payload.hidden },
          { op: "set", path: ["hideEntry"], value: payload.hideEntry === true },
        ];
      }
      function persist() {
        // describe 已确认「自己的命名空间不存在」→ 失败关闭：一个字节都不写。
        // 旧实现会拿默认 NS 无脑往下写，正是靠失败换来的重试把写打到了别人的 ns 上。
        if (!nsResolved) {
          dbg("save", "namespace unresolved: " + NS + " 不在 describe() 里");
          report("save", null, "saveFailed"); // 不把内部 token 甩给用户看
          return Promise.resolve(false);
        }
        var payload = serializeState(state, knownIdsFrom(sections));
        if (!payload) return Promise.resolve(false); // 分区未知（面板没开）→ 不写，防覆盖
        var ops = payloadOps(payload);
        return writeVia("update", payload).then(function (r1) {
          if (r1.ok) return settleOk(r1.res);
          dbg("update rejected", r1.error);
          if (isConflict(r1.error)) {
            return reloadRevision().then(function () {
              return writeVia("update", payload).then(function (r1b) {
                if (r1b.ok) return settleOk(r1b.res);
                dbg("update retry rejected", r1b.error);
                if (!isMissingEntry(r1b.error)) {
                  report("save", r1b.error);
                  return false;
                }
                return tryMutate(ops, r1b.error);
              });
            });
          }
          // 只有「条目/命名空间不存在」值得换写入口重试。校验失败、配额、只读、
          // 权限拒绝都必须原样上报 —— 拿 replace 重试一个已被合法拒绝的写，
          // 等于用更大的权限绕过宿主的校验层次。
          if (!isMissingEntry(r1.error)) {
            report("save", r1.error);
            return false;
          }
          return tryMutate(ops, r1.error);
        });
      }
      // 唯一的降级目标：路径式写入（逐字段 set，宿主按路径校验，不会整份覆盖）。
      // 刻意不再使用 replace —— 它是整份替换，一旦命名空间认错就是清掉别人的配置。
      function tryMutate(ops, firstError) {
        return writeVia("mutate", null, ops).then(function (r2) {
          if (r2.ok) return settleOk(r2.res);
          dbg("mutate rejected", r2.error);
          report("save", r2.error || firstError);
          return false;
        });
      }
      function settleOk(res) {
        clearReport("save");
        var view;
        try {
          view = unwrapValue(res) || {};
        } catch (e) {
          view = {};
        }
        revision = typeof view.revision === "number" ? view.revision : undefined;
        if (notice && reported.save) {
          reported.save = 0;
          setNotice("");
        }
        return true;
      }
      function isConflict(err) {
        return !!err && (err.code === "SETTINGS_CONFLICT" || (err.error && err.error.code === "SETTINGS_CONFLICT"));
      }
      function reloadRevision() {
        var rm = remote();
        if (!rm || typeof rm.describe !== "function") return Promise.resolve(undefined);
        return Promise.resolve()
          .then(function () {
            return rm.describe();
          })
          .then(function (res) {
            // 只取 revision，不改写入目标（nsResolved / nsId 由 loadState 决定）
            var located = locateNs(unwrapValue(res) || {});
            revision = located.entry && typeof located.entry.revision === "number" ? located.entry.revision : undefined;
            return revision;
          })
          .catch(function (e) {
            dbg("describe(retry)", e);
            revision = undefined;
            return undefined;
          });
      }
      // 纯查询：只回答「我们的命名空间在哪」，不碰实例状态。
      // （写状态会带来一个坑：冲突重试时的 reloadRevision 也会查一次，
      //   一次瞬时失败就会把 nsResolved 永久打成 false，之后再也不写。）
      // 返回 { resolved, ns, entry }：resolved=false 表示确认「这里没有我们的命名空间」。
      function locateNs(res) {
        var arr = res && res.namespaces;
        if (!Array.isArray(arr)) return { resolved: false, ns: null, entry: null };
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].ns === NS) return { resolved: true, ns: NS, entry: arr[i] };
        }
        // 条目 id 被别名/前缀改写时才走到这里。认领必须「唯一且可验证」：
        // 候选多于一个就放弃 —— 与其猜，不如不写（写错 ns 会毁掉别的插件的数据）。
        var cand = null;
        for (var j = 0; j < arr.length; j++) {
          var e = arr[j];
          if (!e || !looksLikeOurs(e)) continue;
          // 有值就必须长成我们的样子；本来就没有值（首次使用）才允许认领，
          // 因为「覆盖一份已存在的别人的文档」才是真正的破坏。
          var hasValue = e.value !== undefined && e.value !== null;
          if (hasValue && !looksLikeOurValue(e.value)) continue;
          if (cand) {
            dbg("namespace alias ambiguous", String(e.ns));
            return { resolved: false, ns: null, entry: null };
          }
          cand = e;
        }
        if (!cand) return { resolved: false, ns: null, entry: null };
        return { resolved: true, ns: String(cand.ns), entry: cand };
      }
      // 采用查询结果（只在 loadState 里调用：以 describe 为准更新写入目标）
      function adoptNs(located) {
        if (!located || !located.resolved || !located.entry) {
          nsResolved = false;
          return null;
        }
        nsId = located.ns;
        nsResolved = true;
        if (nsId !== NS) dbg("namespace alias", NS + " -> " + nsId);
        return located.entry;
      }
      function loadState() {
        var rm = remote();
        if (!rm || typeof rm.describe !== "function") return Promise.resolve();
        return Promise.resolve()
          .then(function () {
            return rm.describe();
          })
          .then(function (res) {
            var view = unwrapValue(res) || {};
            var ns = adoptNs(locateNs(view));
            if (!ns) dbg("namespace missing", "settings.describe 里没有 " + NS);
            state = createState(ns && ns.value);
            revision = ns && typeof ns.revision === "number" ? ns.revision : undefined;
            updateGroupSeq();
            sync();
          })
          .catch(function (err) {
            dbg("describe", err);
            state = createState(null);
            revision = undefined;
            updateGroupSeq();
            sync();
          });
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

      // ── 抽屉头（插件自有节点）──────────────────────────────────
      function syncGroupHeaders(nav) {
        var existing = dict();
        var olds = nav.querySelectorAll("[" + DATA.group + "]");
        for (var i = 0; i < olds.length; i++) {
          existing[olds[i].getAttribute(DATA.groupId)] = olds[i];
        }
        var seen = dict();
        for (var gi = 0; gi < state.groups.length; gi++) {
          var g = state.groups[gi];
          seen[g.id] = 1;
          var header = own(existing, g.id) ? existing[g.id] : createGroupHeader(nav, g);
          updateGroupHeader(header, g);
        }
        Object.keys(existing).forEach(function (id) {
          if (!own(seen, id)) {
            try {
              existing[id].remove();
            } catch (e) {
              dbg("remove header", e);
            }
          }
        });
      }

      function createGroupHeader(nav, g) {
        var header = document.createElement("div");
        header.setAttribute(DATA.group, "1");
        header.setAttribute(DATA.groupId, g.id);
        header.setAttribute("role", "button");
        header.setAttribute("tabindex", "0");
        header.setAttribute("aria-expanded", g.collapsed ? "false" : "true");
        var toggle = document.createElement("span");
        toggle.setAttribute(DATA.groupToggle, "1");
        toggle.textContent = g.collapsed ? "▸" : "▾";
        var nameEl = document.createElement("span");
        nameEl.setAttribute(DATA.groupName, "1");
        nameEl.textContent = g.name;
        var dis = document.createElement("button");
        dis.setAttribute(DATA.groupDissolve, "1");
        dis.setAttribute("type", "button");
        dis.setAttribute("title", t ? t("dissolve") : DICT.zh.dissolve);
        dis.setAttribute("aria-label", t ? t("dissolve") : DICT.zh.dissolve);
        dis.textContent = "×";
        header.appendChild(toggle);
        header.appendChild(nameEl);
        header.appendChild(dis);

        // 整头可点：单击延迟 220ms，期间第二次点击（=双击改名）取消折叠
        var clickTimer = null;
        header.addEventListener("click", function (e) {
          if (e.target && e.target.getAttribute && e.target.getAttribute(DATA.groupInput)) return;
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
        header.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          e.preventDefault();
          if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
          }
          startRename(header, g.id, header.querySelector("[" + DATA.groupName + "]"));
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
        nav.appendChild(header);
        return header;
      }

      function updateGroupHeader(header, g) {
        if (header.getAttribute(DATA.renaming) === "1") return;
        var toggle = header.querySelector("[" + DATA.groupToggle + "]");
        if (toggle) toggle.textContent = g.collapsed ? "▸" : "▾";
        header.setAttribute("aria-expanded", g.collapsed ? "false" : "true");
        var nameEl = header.querySelector("[" + DATA.groupName + "]");
        if (nameEl && nameEl.textContent !== g.name) nameEl.textContent = g.name;
      }

      function startRename(header, gid, nameEl) {
        if (!editing || !header || !nameEl) return;
        var g = findGroup(state, gid);
        if (!g) return;
        if (header.getAttribute(DATA.renaming) === "1") return;
        header.setAttribute(DATA.renaming, "1");
        var input = document.createElement("input");
        input.type = "text";
        input.value = g.name;
        input.maxLength = RENAME_MAX;
        input.setAttribute(DATA.groupInput, "1");
        input.setAttribute("aria-label", t ? t("newGroup") : DICT.zh.newGroup);
        nameEl.style.display = "none";
        header.appendChild(input);
        try {
          input.focus();
          input.select();
        } catch (e) {
          dbg("focus rename", e);
        }
        var done = false;
        function finish(commit) {
          if (done) return;
          done = true;
          header.removeAttribute(DATA.renaming);
          var val = input.value;
          try {
            input.remove();
          } catch (e) {
            dbg("remove input", e);
          }
          nameEl.style.display = "";
          if (commit) renameGroup(gid, val);
        }
        input.addEventListener("click", function (e) {
          e.stopPropagation();
        });
        input.addEventListener("blur", function () {
          finish(true);
        });
        input.addEventListener("keydown", function (e) {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        });
      }

      function buildTail(nav, order) {
        var addBtn = nav.querySelector("[" + DATA.addGroup + "]");
        var resetBtn = nav.querySelector("[" + DATA.reset + "]");
        if (!editing) {
          if (addBtn) addBtn.remove();
          if (resetBtn) resetBtn.remove();
          return;
        }
        if (!addBtn) {
          addBtn = document.createElement("div");
          addBtn.setAttribute(DATA.addGroup, "1");
          addBtn.setAttribute("role", "button");
          addBtn.setAttribute("tabindex", "0");
          addBtn.textContent = t ? t("addGroup") : DICT.zh.addGroup;
          bindActivate(addBtn, function () {
            if (editing) addGroup();
          });
          nav.appendChild(addBtn);
        }
        addBtn.style.order = String(order);
        if (!resetBtn) {
          resetBtn = document.createElement("div");
          resetBtn.setAttribute(DATA.reset, "1");
          resetBtn.setAttribute("role", "button");
          resetBtn.setAttribute("tabindex", "0");
          resetBtn.textContent = t ? t("reset") : DICT.zh.reset;
          bindActivate(resetBtn, function () {
            if (editing) resetAll();
          });
          nav.appendChild(resetBtn);
        }
        resetBtn.style.order = String(order + 1);
      }

      // div 补 role=button 后，键盘 Enter/Space 也要能激活
      function bindActivate(el, fn) {
        el.addEventListener("click", function (e) {
          e.stopPropagation();
          e.preventDefault();
          fn();
        });
        el.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault();
            e.stopPropagation();
            fn();
          }
        });
      }

      // ── 抽屉操作 ───────────────────────────────────────────
      function addGroup() {
        var g = {
          id: "g-" + groupSeq++,
          name: t ? t("newGroup") : DICT.zh.newGroup,
          collapsed: false,
          items: [],
        };
        state.groups.push(g);
        state.order.push(g.id);
        sync();
        persist();
        var nav = findNav();
        if (nav) {
          var header = findByAttr(nav, DATA.groupId, g.id);
          if (header) startRename(header, g.id, header.querySelector("[" + DATA.groupName + "]"));
        }
        return g;
      }
      function dissolveGroup(gid) {
        var g = findGroup(state, gid);
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
        sync();
        persist();
      }
      function toggleCollapsed(gid) {
        var g = findGroup(state, gid);
        if (!g) return;
        g.collapsed = !g.collapsed;
        sync();
        persist();
      }
      function renameGroup(gid, name) {
        var g = findGroup(state, gid);
        if (!g) return;
        var clean = String(name === null || name === undefined ? "" : name)
          .trim()
          .slice(0, RENAME_MAX);
        g.name = clean || (t ? t("newGroup") : DICT.zh.newGroup);
        sync();
        persist();
      }
      function resetAll() {
        state = createState(null);
        groupSeq = 1;
        sync();
        persist();
        setNotice(t ? t("resetDone") : DICT.zh.resetDone);
      }

      // ── 显隐 ───────────────────────────────────────────────
      function toggleHidden(id) {
        if (!id) return;
        var cell = findRow(id);
        var wasActive = !!cell && cell.getAttribute("aria-current") === "true";
        var idx = state.hidden.indexOf(id);
        if (idx >= 0) state.hidden.splice(idx, 1);
        else state.hidden.push(id);
        sync();
        persist();
        // 隐藏了当前分区 → 切到第一个可见分区，避免「左边没高亮、右边还有内容」
        if (wasActive && idx < 0) focusVisibleRow(id);
      }
      function focusVisibleRow(excludeId) {
        var nav = findNav();
        if (!nav) return;
        var cells = navCells(nav);
        for (var i = 0; i < cells.length; i++) {
          var rid = cells[i].getAttribute(DATA.id);
          if (!rid || rid === excludeId) continue;
          if (cells[i].getAttribute(DATA.hidden) === "1") continue;
          if (cells[i].getAttribute(DATA.collapsed) === "1") continue;
          try {
            cells[i].click();
          } catch (e) {
            dbg("focus row", e);
          }
          return;
        }
      }
      function findRow(id) {
        var nav = findNav();
        if (!nav) return null;
        var cells = navCells(nav);
        for (var i = 0; i < cells.length; i++) {
          if (cells[i].getAttribute(DATA.id) === id) return cells[i];
        }
        return null;
      }

      // ── 编辑模式 ───────────────────────────────────────────
      function setEditing(v) {
        v = !!v;
        if (editing === v) return;
        editing = v;
        if (!v) endDrag(false);
        sync();
        publish();
      }

      // ── 拖拽 ───────────────────────────────────────────────
      function closestRow(target) {
        if (!target || !target.closest) return null;
        return target.closest(SEL.navCell);
      }
      function closestGroupHeader(target) {
        if (!target || !target.closest) return null;
        return target.closest("[" + DATA.group + "]");
      }
      function clearDropMarks(nav) {
        if (!nav) return;
        var marked = nav.querySelectorAll("[" + DATA.drop + "]");
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(DATA.drop);
      }
      function collectSlots(nav, excludeId) {
        var els = [];
        var cells = navCells(nav);
        for (var i = 0; i < cells.length; i++) {
          var id = cells[i].getAttribute(DATA.id);
          if (id && id !== excludeId) els.push({ el: cells[i], kind: "row", id: id });
        }
        var heads = nav.querySelectorAll("[" + DATA.group + "]");
        for (var j = 0; j < heads.length; j++) {
          var gid = heads[j].getAttribute(DATA.groupId);
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
      function computeDrop(nav, clientY, dragState) {
        if (!dragState.isGroup) {
          var heads = nav.querySelectorAll("[" + DATA.group + "]");
          for (var i = 0; i < heads.length; i++) {
            var hr = heads[i].getBoundingClientRect();
            if (clientY >= hr.top && clientY <= hr.bottom) {
              return { type: "into-group", groupId: heads[i].getAttribute(DATA.groupId) };
            }
          }
        }
        var els = collectSlots(nav, dragState.id);
        var ref = null;
        for (var s = 0; s < els.length; s++) {
          if (clientY < els[s].mid) {
            ref = els[s];
            break;
          }
        }
        if (!ref) return { type: "insert-end" };
        if (ref.kind === "group") return { type: "insert-before", refType: "group", refId: ref.id };
        var gid = ref.el.getAttribute(DATA.inGroup);
        return { type: "insert-before", refType: "row", refId: ref.id, refGroup: gid || null };
      }

      function onPointerDown(e) {
        if (!editing || disposed) return;
        if (e.button !== undefined && e.button !== 0) return;
        var nav = findNav();
        if (!nav) return;
        var row = closestRow(e.target);
        var header = closestGroupHeader(e.target);
        var onControl = e.target.closest
          ? e.target.closest("[" + DATA.groupInput + "],[" + DATA.groupDissolve + "]")
          : null;
        if (row) {
          var rect = row.getBoundingClientRect();
          if (rect.right - e.clientX <= ZONE_EYE) return; // 眼睛分区：交给 click
          drag = {
            id: row.getAttribute(DATA.id),
            isGroup: false,
            startX: e.clientX,
            startY: e.clientY,
            lastY: e.clientY,
            active: false,
            nav: nav,
            el: row,
            base: null,
            pointerId: e.pointerId,
          };
        } else if (header && !onControl) {
          drag = {
            id: header.getAttribute(DATA.groupId),
            isGroup: true,
            startX: e.clientX,
            startY: e.clientY,
            lastY: e.clientY,
            active: false,
            nav: nav,
            el: header,
            base: null,
            pointerId: e.pointerId,
          };
        }
        // 新一轮拖拽：作废上一轮可能还排队的帧回调，避免它把落点写进新的一轮
        if (drag) dragGen++;
      }

      function onPointerMove(e) {
        if (!drag) return;
        var dx = e.clientX - drag.startX;
        var dy = e.clientY - drag.startY;
        if (!drag.active) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          drag.active = true;
          drag.base = cloneState(state); // 快照：取消时可完整回滚
          drag.el.setAttribute(DATA.dragging, "1");
          if (drag.pointerId !== undefined && drag.el.setPointerCapture) {
            try {
              drag.el.setPointerCapture(drag.pointerId);
            } catch (err) {
              dbg("pointer capture", err);
            }
          }
        }
        drag.lastY = e.clientY;
        try {
          e.preventDefault();
        } catch (err2) {}
        // 同一帧内多次 move 只算一次（合并到最新落点）
        var gen = dragGen;
        scheduleFrame(function () {
          if (!drag || !drag.active || dragGen !== gen) return;
          var drop = computeDrop(drag.nav, drag.lastY, drag);
          clearDropMarks(drag.nav);
          if (drop && drop.type === "into-group") {
            var th = findByAttr(drag.nav, DATA.groupId, drop.groupId);
            if (th) th.setAttribute(DATA.drop, "1");
          }
          state = applyDropTo(drag.base, drag, drop);
          applyDom(drag.nav); // 实时预览
        });
      }

      function endDrag(commit) {
        if (!drag) return;
        var finished = drag;
        var wasActive = finished.active;
        dragGen++; // 抬手即作废已排队的帧回调
        if (finished.el) finished.el.removeAttribute(DATA.dragging);
        if (finished.nav) clearDropMarks(finished.nav);
        // 落点必须在这一刻同步结算：预览走的是 rAF 合并，若「最后一次 pointermove」
        // 与「pointerup」落在同一帧（快速甩动、高刷屏、尾帧抖动），帧回调还没跑、
        // drag 已被清空 —— 落点就这么丢了，而且会把未改动的布局写回盘。
        if (wasActive && finished.base) {
          if (commit && finished.nav) {
            state = applyDropTo(finished.base, finished, computeDrop(finished.nav, finished.lastY, finished));
          } else {
            state = finished.base; // 取消 → 回滚
          }
        }
        drag = null;
        if (wasActive) {
          justActedAt = Date.now();
          sync();
          if (commit) persist();
        }
      }

      // ── 事件 ───────────────────────────────────────────────
      function onClickCapture(e) {
        var elapsed = Date.now() - justActedAt;
        if (justActedAt && elapsed >= 0 && elapsed < TAP_GUARD_MS) {
          justActedAt = 0;
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch (err) {}
          return;
        }
        if (!editing || disposed) return;
        var row = closestRow(e.target);
        if (!row) return;
        var rect = row.getBoundingClientRect();
        if (rect.right - e.clientX <= ZONE_EYE) {
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch (err2) {}
          toggleHidden(row.getAttribute(DATA.id));
        }
      }

      function onKeyDown(e) {
        if (disposed) return;
        // 改名输入框内：Escape 交给输入框自己（捕获阶段必须先让路）
        if (e.target && e.target.getAttribute && e.target.getAttribute(DATA.groupInput)) return;
        if (!editing) return;
        if (e.key === "Escape") {
          if (e.target && e.target.closest && e.target.closest("input,textarea,[contenteditable]")) return;
          setEditing(false);
          return;
        }
        var row = closestRow(e.target);
        var header = closestGroupHeader(e.target);
        if (header && !row) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault();
            e.stopPropagation();
            toggleCollapsed(header.getAttribute(DATA.groupId));
            return;
          }
          if (e.key === "F2") {
            e.preventDefault();
            e.stopPropagation();
            startRename(header, header.getAttribute(DATA.groupId), header.querySelector("[" + DATA.groupName + "]"));
            return;
          }
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            e.stopPropagation();
            state = nudgeState(state, header.getAttribute(DATA.groupId), e.key === "ArrowUp" ? -1 : 1);
            sync();
            persist();
          }
          return;
        }
        if (!row) return;
        var id = row.getAttribute(DATA.id);
        if (!id) return;
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          e.stopPropagation();
          state = nudgeState(state, id, e.key === "ArrowUp" ? -1 : 1);
          sync();
          persist();
          return;
        }
        if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "h" || e.key === "H")) {
          e.preventDefault();
          e.stopPropagation();
          toggleHidden(id);
        }
      }

      function bindEvents() {
        function pd(e) {
          onPointerDown(e);
        }
        function pm(e) {
          onPointerMove(e);
        }
        function pu() {
          endDrag(true);
        }
        function pc() {
          endDrag(false);
        }
        function bl() {
          endDrag(false);
        }
        function kc(e) {
          onKeyDown(e);
        }
        document.addEventListener("pointerdown", pd, true);
        document.addEventListener("pointermove", pm, true);
        document.addEventListener("pointerup", pu, true);
        document.addEventListener("pointercancel", pc, true);
        document.addEventListener("click", onClickCapture, true);
        document.addEventListener("keydown", kc, true);
        window.addEventListener("blur", bl);
        document.addEventListener("visibilitychange", bl);
        cleanups.push(function () {
          document.removeEventListener("pointerdown", pd, true);
          document.removeEventListener("pointermove", pm, true);
          document.removeEventListener("pointerup", pu, true);
          document.removeEventListener("pointercancel", pc, true);
          document.removeEventListener("click", onClickCapture, true);
          document.removeEventListener("keydown", kc, true);
          window.removeEventListener("blur", bl);
          document.removeEventListener("visibilitychange", bl);
        });
      }

      // ── 观察：body 直接子节点（面板出现/消失）+ nav 自身 ─────────
      function fingerprint(nav) {
        var cells = navCells(nav);
        var parts = [String(cells.length)];
        for (var i = 0; i < cells.length; i++) parts.push(rowLabel(cells[i]));
        return parts.join("\u0001");
      }
      function scheduleFrame(fn) {
        if (typeof requestAnimationFrame !== "function") {
          fn();
          return;
        }
        if (rafId) return; // 合并同帧
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          try {
            fn();
          } catch (e) {
            dbg("frame", e);
          }
        });
      }
      function scheduleTick() {
        if (disposed) return;
        scheduleFrame(tick);
      }
      function tick() {
        if (disposed) return;
        var nav = findNav();
        if (!nav) {
          detachNavObserver();
          if (editing) setEditing(false);
          lastFingerprint = "";
          return;
        }
        attachNavObserver(nav);
        var fp = fingerprint(nav);
        if (nav.getAttribute(DATA.nav) !== "1" || fp !== lastFingerprint) {
          lastFingerprint = fp;
          sync();
        }
      }
      function attachNavObserver(nav) {
        if (navNode === nav && navMo) return;
        detachNavObserver();
        navNode = nav;
        if (typeof MutationObserver === "undefined") return;
        navMo = new MutationObserver(scheduleTick);
        navMo.observe(nav, { childList: true, characterData: true, subtree: true });
      }
      function detachNavObserver() {
        if (navMo) {
          try {
            navMo.disconnect();
          } catch (e) {
            dbg("disconnect nav", e);
          }
        }
        navMo = null;
        navNode = null;
      }
      function observe() {
        if (!document || typeof MutationObserver === "undefined") return;
        // 面板是 createPortal 到 document.body 的直接子节点：
        // 只听 body 的直接 childList 就够，不必订阅整棵子树。
        bodyMo = new MutationObserver(scheduleTick);
        bodyMo.observe(document.body, { childList: true });
        cleanups.push(function () {
          if (bodyMo) {
            try {
              bodyMo.disconnect();
            } catch (e) {
              dbg("disconnect body", e);
            }
          }
          bodyMo = null;
          detachNavObserver();
        });
      }

      // ── 侧栏入口图标（只有字形，不带外层 wrapper：行自身负责水平对齐）──
      function SettingsNavIcon(props) {
        var size = props && props.size ? props.size : 18;
        return h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            focusable: "false",
          },
          h("path", { key: "l1", d: "M3 6h9" }),
          h("circle", { key: "c1", cx: 16.5, cy: 6, r: 2.5 }),
          h("path", { key: "l2", d: "M3 12h4" }),
          h("circle", { key: "c2", cx: 11, cy: 12, r: 2.5 }),
          h("path", { key: "l3", d: "M3 18h11" }),
          h("circle", { key: "c3", cx: 18.5, cy: 18, r: 2.5 }),
        );
      }

      // ── 侧栏入口页：列出全部分区，点一行直达设置 ───────────────
      // 行数据来自 sync() 的 sections 投影，经 uiSubs 订阅刷新；
      // 不自造分区列表，也不往设置弹窗的 children 里塞任何东西。
      function SettingsNavPage(props) {
        var tickState = react.useState(0);
        var force = tickState[1];
        var hiddenState = react.useState(false);
        var showHidden = hiddenState[0];
        var setShowHidden = hiddenState[1];
        react.useEffect(function () {
          uiSubs.push(force);
          return function () {
            var i = uiSubs.indexOf(force);
            if (i >= 0) uiSubs.splice(i, 1);
          };
        }, []);
        var tr =
          t ||
          function (key) {
            return DICT.zh[key] || key;
          };
        var open =
          props && typeof props.openSection === "function"
            ? props.openSection
            : function () {
                return false;
              };
        var rows = flattenNav(sections, state);
        var visible = [];
        var hiddenCount = 0;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].hidden && !showHidden) {
            hiddenCount++;
            continue;
          }
          visible.push(rows[i]);
        }
        var items = [];
        for (var r = 0; r < visible.length; r++) {
          var row = visible[r];
          items.push(
            h(
              "button",
              {
                key: row.id,
                type: "button",
                "data-snm-page-row": "1",
                "data-snm-page-id": row.id,
                "data-snm-page-hidden": row.hidden ? "1" : "0",
                onClick: (function (id) {
                  return function () {
                    open(id);
                  };
                })(row.id),
              },
              h("span", { key: "g", "data-snm-page-glyph": "1", "aria-hidden": "true" }, glyphOf(row.label)),
              h("span", { key: "l", "data-snm-page-label": "1" }, row.label || row.id),
              row.group ? h("span", { key: "gr", "data-snm-page-group": "1" }, row.group) : null,
              row.hidden ? h("span", { key: "b", "data-snm-page-badge": "1" }, tr("hidden")) : null,
            ),
          );
        }
        var foot = [];
        if (hiddenCount > 0) {
          foot.push(
            h(
              "button",
              {
                key: "toggle-hidden",
                type: "button",
                onClick: function () {
                  setShowHidden(!showHidden);
                },
              },
              showHidden ? tr("hideHidden") : tr("showHidden"),
            ),
          );
        }
        if (visible.length === 0) {
          foot.push(
            h(
              "button",
              {
                key: "retry",
                type: "button",
                onClick: function () {
                  sync();
                  publish();
                },
              },
              tr("retry"),
            ),
          );
        }
        return h(
          "div",
          { "data-snm-page": "1" },
          h(
            "div",
            { "data-snm-page-head": "1" },
            h("h2", { "data-snm-page-title": "1" }, tr("panel")),
            h("span", { "data-snm-page-count": "1" }, String(visible.length)),
          ),
          h("p", { "data-snm-page-hint": "1" }, tr("pageHint")),
          visible.length === 0
            ? h("p", { "data-snm-page-empty": "1" }, tr("empty"))
            : h("div", { "data-snm-page-list": "1" }, items),
          foot.length ? h("div", { "data-snm-page-foot": "1" }, foot) : null,
        );
      }

      // ── 齿轮按钮 ───────────────────────────────────────────
      function GearButton() {
        var tickState = react.useState(0);
        var force = tickState[1];
        react.useEffect(function () {
          uiSubs.push(force);
          return function () {
            var i = uiSubs.indexOf(force);
            if (i >= 0) uiSubs.splice(i, 1);
          };
        }, []);
        var label = t ? (editing ? t("gearExit") : t("gear")) : DICT.zh.gear;
        var gearBtn = h(
          "button",
          {
            type: "button",
            "data-snm-gear": "1",
            "data-snm-active": editing ? "1" : "0",
            "aria-label": label,
            "aria-pressed": editing ? "true" : "false",
            title: label,
            onClick: function () {
              setEditing(!editing);
            },
            style: {
              background: editing ? "var(--dsw-alias-accent,#247bbf)" : "transparent",
              color: editing ? "#fff" : "inherit",
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
        // 侧栏入口开关：只在编辑模式出现，紧挨齿轮（用户要求「开关放到齿轮旁边」）
        var off = entryHidden();
        var entryLabel = t ? t("entry") : DICT.zh.entry;
        var entryStateText = t ? (off ? t("entryOff") : t("entryOn")) : off ? DICT.zh.entryOff : DICT.zh.entryOn;
        var entryTitle = t
          ? off
            ? t("entryHideHint")
            : t("entryShowHint")
          : off
            ? DICT.zh.entryHideHint
            : DICT.zh.entryShowHint;
        var entryBtn = editing
          ? h(
              "button",
              {
                type: "button",
                "data-snm-entry-toggle": "1",
                "data-snm-entry-off": off ? "1" : "0",
                "aria-pressed": off ? "true" : "false",
                "aria-label": entryLabel + " · " + entryStateText,
                title: entryTitle,
                onClick: function () {
                  setEntryHidden(!entryHidden());
                },
                style: {
                  background: off ? "transparent" : "var(--dsw-alias-interactive-bg-secondary,rgba(128,128,128,.16))",
                  color: off ? "var(--dsw-alias-label-secondary,#888)" : "inherit",
                  border: "1px solid var(--dsw-alias-border,rgba(128,128,128,.35))",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "12px",
                  lineHeight: "1",
                  padding: "5px 8px",
                  whiteSpace: "nowrap",
                  textDecoration: off ? "line-through" : "none",
                },
              },
              entryLabel + " " + entryStateText,
            )
          : null;
        var hint = editing
          ? h(
              "span",
              {
                "data-snm-hint": "1",
                title: t ? t("keyboardHint") : DICT.zh.keyboardHint,
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
              t ? t("editHint") : DICT.zh.editHint,
            )
          : null;
        var noticeEl = notice
          ? h(
              "span",
              {
                "data-snm-notice": "1",
                role: "status",
                style: {
                  fontSize: "12px",
                  lineHeight: "1.3",
                  color: "var(--dsw-alias-state-error-primary,#c33)",
                  whiteSpace: "nowrap",
                },
              },
              notice,
            )
          : null;
        var live = h("span", { "data-snm-sr": "1", role: "status", "aria-live": "polite" }, notice || "");
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
          hint,
          noticeEl,
          live,
          gearBtn,
          entryBtn,
        );
      }

      // ── 装配 ───────────────────────────────────────────────
      t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT);
      }, NS + ": dictionaries");
      ctx.effect(function () {
        ensureStyles();
        return removeStyles;
      }, NS + ": styles");
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
      // 侧栏插件栏入口在 syncEntry() 里按 hideEntry 动态注册/注销
      // （顺序 20 排在「插件」(0) /「插件市场」/「自动化任务」(10) 之后）。
      // 该入口对应的页面：没有它，layout.selectPanel 会抛
      // `main panel "settings-nav" is not registered`。
      // 页面始终在册，隐藏入口只摘侧栏那一行。
      ctx.effect(function () {
        return ctx.slots.inject("main", function () {
          return ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              locale: NS,
              inject: function () {
                return { openSection: openSettingsSection };
              },
            },
            SettingsNavPage,
          );
        });
      }, NS + ": sidebar page");

      sync(); // 先用默认态标一次，随后异步拉真实排版
      loadState();
      bindEvents();
      observe();

      ctx.effect(function () {
        return function () {
          disposed = true;
          if (rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
          rafId = 0;
          disposeEntry(); // 侧栏入口是动态注册的，得自己摘
          if (noticeTimer) clearTimeout(noticeTimer);
          noticeTimer = null;
          while (cleanups.length) {
            var fn = cleanups.pop();
            try {
              fn();
            } catch (e) {
              dbg("cleanup", e);
            }
          }
          // 摘掉挂在宿主 DOM 上的痕迹
          try {
            var nav = findNav();
            if (nav) {
              nav.removeAttribute(DATA.nav);
              nav.removeAttribute(DATA.editing);
              var injected = nav.querySelectorAll(
                "[" + DATA.group + "],[" + DATA.addGroup + "],[" + DATA.reset + "]",
              );
              for (var i = 0; i < injected.length; i++) injected[i].remove();
              var marked = nav.querySelectorAll("[" + DATA.row + "]");
              for (var j = 0; j < marked.length; j++) {
                marked[j].removeAttribute(DATA.row);
                marked[j].removeAttribute(DATA.id);
                marked[j].removeAttribute(DATA.hidden);
                marked[j].removeAttribute(DATA.inGroup);
                marked[j].removeAttribute(DATA.collapsed);
                marked[j].removeAttribute(DATA.dragging);
                marked[j].style.order = "";
              }
            }
            removeStyles();
          } catch (e2) {
            dbg("cleanup dom", e2);
          }
          uiSubs.length = 0;
        };
      }, NS + ": lifecycle");
    }

    function apply(ctx) {
      createPlugin(ctx);
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote", "remote.settings"];
    // 测试接缝：只暴露纯函数与文案表，供 node --test 直接调用
    exports.__test = {
      NS: NS,
      PANEL_ID: PANEL_ID,
      DICT: DICT,
      buildCss: buildCss,
      createState: createState,
      normalizeState: normalizeState,
      serializeState: serializeState,
      applyDropTo: applyDropTo,
      nudgeState: nudgeState,
      projectSections: projectSections,
      knownIdsFrom: knownIdsFrom,
      sectionIds: sectionIds,
      flattenNav: flattenNav,
      sectionsSignature: sectionsSignature,
      glyphOf: glyphOf,
      isMissingEntry: isMissingEntry,
      looksLikeOurs: looksLikeOurs,
      looksLikeOurValue: looksLikeOurValue,
    };
    return module.exports;
  },
});
