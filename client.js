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
        editHint: "拖拽排序 · 点眼睛隐藏 · 双击改名 · 可收纳",
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
      },
      en: {
        gear: "Edit navigation",
        gearExit: "Exit navigation editing",
        editHint: "Drag to reorder · Click eye to hide · Double-click to rename · Collect into drawers",
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
      };
    }
    function findGroup(state, id) {
      for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
      return null;
    }
    function isGroupTop(state, id) {
      return findGroup(state, id) !== null;
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
      // findNs() 会按 schema 指纹认领真实 id 并记在这里。
      var nsId = NS;
      var groupSeq = 1;
      var t = null;
      var drag = null;
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
        var nav = findNav();
        var mapped = nav ? markRows(nav) : 0;
        var total = nav ? navCells(nav).length : 0;
        state = normalizeState(state, knownIdsFrom(sections), sectionIds(sections));
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
        ];
      }
      function persist() {
        var payload = serializeState(state, knownIdsFrom(sections));
        if (!payload) return Promise.resolve(false); // 分区未知（面板没开）→ 不写，防覆盖
        var ops = payloadOps(payload);
        // 三条路都落在宿主的同一个写入口，但校验层次不同：update 走合并、
        // replace 走整体替换、mutate 走路径校验。前一条被拒就换下一条。
        return writeVia("update", payload).then(function (r1) {
          if (r1.ok) return settleOk(r1.res);
          dbg("update rejected", r1.error);
          if (isConflict(r1.error)) {
            return reloadRevision().then(function () {
              return writeVia("update", payload).then(function (r1b) {
                if (r1b.ok) return settleOk(r1b.res);
                dbg("update retry rejected", r1b.error);
                return tryFallbacks(payload, ops, r1b.error);
              });
            });
          }
          return tryFallbacks(payload, ops, r1.error);
        });
      }
      function tryFallbacks(payload, ops, firstError) {
        return writeVia("replace", payload).then(function (r2) {
          if (r2.ok) return settleOk(r2.res);
          dbg("replace rejected", r2.error);
          return writeVia("mutate", payload, ops).then(function (r3) {
            if (r3.ok) return settleOk(r3.res);
            dbg("mutate rejected", r3.error);
            report("save", r3.error || firstError);
            return false;
          });
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
            var ns = findNs(unwrapValue(res) || {});
            revision = ns && typeof ns.revision === "number" ? ns.revision : undefined;
            return revision;
          })
          .catch(function (e) {
            dbg("describe(retry)", e);
            revision = undefined;
            return undefined;
          });
      }
      // 我们的字段指纹：schema 里同时有这四个键，基本只可能是本插件
      function looksLikeOurs(entry) {
        var schema = entry && entry.schema;
        var fields = (schema && (schema.dict || schema.properties)) || null;
        if (!fields) return false;
        return "order" in fields && "groups" in fields && "hidden" in fields;
      }
      function findNs(res) {
        var arr = res && res.namespaces;
        if (!Array.isArray(arr)) return null;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].ns === NS) {
            nsId = NS;
            return arr[i];
          }
        }
        // 条目 id 被别名/前缀改写时，按 schema 指纹认领自己的命名空间
        for (var j = 0; j < arr.length; j++) {
          if (arr[j] && looksLikeOurs(arr[j])) {
            nsId = String(arr[j].ns);
            dbg("namespace alias", NS + " -> " + nsId);
            return arr[j];
          }
        }
        return null;
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
            var ns = findNs(view);
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
        scheduleFrame(function () {
          if (!drag || !drag.active) return;
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
        var wasActive = drag.active;
        var el = drag.el;
        if (el) el.removeAttribute(DATA.dragging);
        if (drag.nav) clearDropMarks(drag.nav);
        if (wasActive && !commit && drag.base) state = drag.base; // 取消 → 回滚
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

      sync(); // 先用默认态标一次，随后异步拉真实排版
      loadState();
      bindEvents();
      observe();

      ctx.effect(function () {
        return function () {
          disposed = true;
          if (rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
          rafId = 0;
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
    };
    return module.exports;
  },
});
