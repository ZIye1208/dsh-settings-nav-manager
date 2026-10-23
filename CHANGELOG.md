# Changelog

## 1.0.1

修复 1.0.0 的持久化缺陷与一批健壮性 / 可访问性问题。**强烈建议升级**：1.0.0 会在每次冷启动后清空已保存的分组、隐藏与排序，并在下一次操作时把这份空状态写回磁盘。

### 修复

- **冷启动后丢失全部排版（数据丢失）**：`sections` 投影原先写在「导航是否挂载」的判断之后，设置面板未打开时 `sections` 恒为空，随后的 `normalize()` 拿空 id 集去过滤，把 `order` / `groups[].items` / `hidden` 一起清空。现在投影无条件先算，且分区未知时 `normalize()` 直接返回、`persist()` 直接拒写（双保险）。
- **持久化失败静默**：保存失败、设置冲突、认行失配都会 `console.debug` 一次并在齿轮旁显示提示，不再「看起来存住了」。
- **并发写覆盖**：写入携带 `revision`；撞上 `SETTINGS_CONFLICT` 时重读一次后重放，不再盲目覆盖另一窗口的改动。
- **拖拽卡死**：补 `pointercancel` / 窗口失焦 / 页面隐藏兜底；拖拽过程改为「基于起手快照重算」，中断时完整回滚，不会出现「松开鼠标还在乱跳」。
- **Escape 语义冲突**：改名输入框内按 Escape 只取消改名，不再顺带退出编辑模式。
- **隐藏当前分区后内容区仍显示它**：隐藏正在浏览的分区时自动切到第一个可见分区。
- **拖拽后的下一次点击被吞**：`justActed` 改为 350ms 时间窗，不再吃掉无关点击。

### 改进

- **性能**：`MutationObserver` 从「整个 `document.body` 子树」收敛为「body 直接子节点（面板开合）+ nav 自身」，并用 `requestAnimationFrame` 合并同帧回调；拖拽中的重排同样按帧合并。
- **选择器安全**：不再拼接触点数据到 CSS 选择器（`[data-snm-group-id="…"]`），改为属性遍历比对，id 里带引号也不会抛 `DOMException`。
- **集合容器**：内部 id/label 字典改用 `Object.create(null)`，`constructor` / `__proto__` 之类的 id 不会误判。
- **无障碍**：齿轮补 `aria-label` / `aria-pressed`；抽屉头补 `role="button"` / `tabindex` / `aria-expanded`；新增状态播报 `aria-live`；焦点环可见。
- **键盘操作**：`Alt+↑/↓` 排序、`h` 切换显隐、`Enter` / `Space` 折叠抽屉、`F2` 改名。
- **新增「恢复默认」**：编辑模式底部一键清空抽屉与隐藏、回到宿主默认顺序（之前只有文案没有功能）。
- **卸载清理**：移除注入的 `<style>`、`data-snm-*` 属性与自有节点，不再污染宿主 DOM。
- **文案单一来源**：`locale/*.json` 由 `client.js` 的字典生成（`npm run locale`），并加测试校验一致性；删掉 5 个从未使用的键。
- **认行更稳**：序号映射增加双向校验与重复 id 保护，失配时放弃本次重排并提示，而不是硬认错行。

### 工程

- 新增测试：`test/unit.test.mjs`（纯逻辑 15 条）、`test/repo.test.mjs`（清单 / 文案 / 源码卫生）、`test/e2e.mjs`（无头 Chrome + CDP 真实 DOM 端到端 11 条，含对旧版本的 A/B 对照）。
- `@deepseek-ai/cosmokit`、`@standard-schema/spec` 移除（代码从未引用）；`@deepseek-ai/schemastery` **保留为显式依赖**——profile 里的 `@deepseek-ai/*` 是指向桌面端 `app.asar` 内路径的断链符号链接，改成 peer 会导致 `index.js` 解析失败、整个插件加载不上。
- 兼容范围由 `>=0.1.0-rc.6` 收紧为 `>=0.2.1-rc.2 <0.3.0`（实测版本带）。

## 1.0.0

首个公开版本：齿轮编辑模式、拖拽排序、条目显隐、抽屉收纳（拖入/拖出/组内排序/改名/折叠/解散）、L 型归属线、持久化。
