# dsh-settings-nav-manager

> **DSH 设置页导航管理插件** —— 给设置页左侧分区导航加上「**拖拽排序 · 显隐 · 抽屉收纳**」，一键进入编辑模式随手整理，自动持久保存；还能把**常用分区钉到主界面侧栏，点一下直达**。

适用于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 `web`（网页版）与 `desktop`（桌面版）两个 profile。纯 JavaScript / ESM，**无需构建**。

---

## 产品演示

### 总览：编辑模式 · 拖拽排序 · 显隐 · 抽屉收纳

![产品演示：进入编辑模式、拖拽排序、眼睛显隐、抽屉收纳](https://raw.githubusercontent.com/ZIye1208/dsh-settings-nav-manager/main/assets/demo.gif)

### 1.3.0 新增：分区固定到侧栏

![1.3.0 新版演示：入口页点 ☆ 固定分区，侧栏插件栏立刻多一行，点一下直接打开对应设置，主面板不切走](https://raw.githubusercontent.com/ZIye1208/dsh-settings-nav-manager/main/assets/demo-1.3.gif)

上图是 1.0 – 1.2 的整理能力，下图是 1.3.0 新增的「固定到侧栏」。

### 🆕 1.3.0 更新的功能

| 功能 | 说明 |
|---|---|
| **📌 分区固定到侧栏** | 入口页每行右侧的 ☆ 一点变 ★，该分区就钉到主界面插件栏（最多 5 个，排在「设置导航」入口之后）。点那一行**直接打开设置并选中该分区**，而且当前主面板不会被切走——关掉设置还停在你原来的页面。 |
| **兜底页** | 每个固定行都配一个同名 `main` 页。哪怕布局恢复 / 深链 / 键盘激活绕过了点击拦截，也不会抛 `layout.selectPanel: panel "..." is not registered`，而是看到一个有「打开设置 / 返回」的页。 |
| **隐藏即取消固定** | 已隐藏的分区不能钉（☆ 置灰）；反过来，隐藏一个已钉的分区会自动取消它的固定——入口藏在设置里，钉着也点不到。 |
| **语言无关** | 固定行的标题走实时解析，切到英文界面后标签跟着变，不需要重建注册。 |

---

## 功能特性

| 功能 | 说明 |
|---|---|
| **⚙ 编辑模式** | 设置弹窗标题栏「打开配置文件」左侧新增齿轮。点击进入编辑模式，再点或 `Escape` 退出。齿轮常驻防死锁；编辑模式是临时态，不持久化。齿轮旁的「侧栏入口」开关只在编辑模式出现。 |
| **⇣ 拖拽排序** | 编辑模式下按住条目整行拖动即可排序，实时预览插入位置，松手定序并立即保存。位移阈值 > 6px 判定为拖拽，低于阈值按普通点击放行，**不误触发导航跳转**。拖拽被中断（窗口失焦、触屏手势被系统接管）会自动回滚，不会卡住。 |
| **👁 显隐开关** | 点眼睛切换。隐藏条目在编辑模式内仍可见（置灰 + 划线眼，方便一眼找到恢复入口），非编辑模式下 `display:none`。允许全部隐藏。若隐藏的正是当前浏览的分区，会自动切到第一个可见分区。 |
| **🗄 抽屉收纳** | 新建命名抽屉把条目收进去：**拖入 / 拖出 / 组内排序**，双击抽屉名改名（1–32 字符，可重名），点抽屉头任意位置折叠 / 展开，一键解散（成员回到未分组、保留顺序）。支持空抽屉。 |
| **└ L 型归属线** | 抽屉内条目左侧有 L 型树线，一眼看清条目挂在哪个抽屉下。 |
| **↺ 恢复默认** | 编辑模式底部一键清空抽屉与隐藏、回到宿主默认顺序。整理乱了不用怕。侧栏入口若被隐藏，也会一并恢复显示。 |
| **⌨ 键盘操作** | 编辑模式下：`Alt+↑/↓` 移动条目（或抽屉），`h` 切换显隐，抽屉头上 `Enter` / `Space` 折叠、`F2` 改名，`Escape` 退出（在改名输入框内只取消改名）。 |
| **💬 即时说明** | 编辑模式下齿轮旁显示操作提示（拖拽排序 · 点眼睛隐藏 · 双击改名 · 可收纳），退出即隐藏。 |
| **💾 持久化** | 排序 / 显隐 / 抽屉结构写入 `settings-nav-manager` 命名空间，重启保留、切换语言重建后仍正确。读取异常一律回退默认，不报错；**写入失败会在齿轮旁提示并带上宿主给出的原因**，不再静默丢数据。 |
| **🧭 侧栏入口** | 主界面左侧插件栏新增一行「设置导航」（排在插件市场 / 自动化任务之后）。点进去是一页全部分区清单，**点任意一行直接打开设置并选中该分区**；列表跟随你整理的顺序与抽屉分组，已隐藏的分区折在底部，可展开查看或点进去恢复。深链会回 DOM 核对是否真的选中：失败时页面里显示原因与「重试」，不会点了没反应。 |
| **🙈 入口开关** | 编辑模式下齿轮旁多一个「侧栏入口 显示中 / 已隐藏」开关，点一下就把侧栏那一行收起来（`main` 页面保留在册，不会让宿主指向空面板）；状态随排版一起持久化，重启仍是隐藏，**启动瞬间也不会先闪一下**。想找回来：打开设置 → 齿轮进入编辑模式 → 再点一下开关。切换失败时按钮、磁盘、侧栏三方一起回滚并提示原因。 |
| **📌 固定分区** | 入口页每行右侧的 ☆ 一点，这个分区就钉到主界面插件栏（最多 5 个，排在「设置导航」入口之后）。以后点那一行**直接打开设置并选中该分区**，而且当前主面板不会被切走——关掉设置还停在你原来的页面上。已隐藏的分区不能固定（按钮置灰）：入口藏在设置里，钉上去只会更难找。固定行若是被布局恢复、深链或键盘激活切过去，也有兜底页兜住，不会抛「面板未注册」。 |

---

## 安装

> 安装命令参考社区插件（如 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)、[dsh-market](https://github.com/dsh-market/dsh-market)）的通用写法。包名：`dsh-settings-nav-manager`（已发布到 [npm](https://www.npmjs.com/package/dsh-settings-nav-manager)）。

### 从 npm 安装（推荐）

**网页版（`dsh web`）：**

```sh
dsh plugin --profile web add dsh-settings-nav-manager
```

**桌面版（Desktop 桌面应用）：** `desktop` profile 由桌面应用独占管理，需先让应用初始化它：

1. 启动一次桌面应用（初始化 profile），然后**完全退出**；
2. 执行安装：

```sh
dsh plugin --profile desktop add dsh-settings-nav-manager
```

3. 重新打开桌面应用，进入 **设置** 使用。

安装后重启（网页版 `dsh web` / 桌面版重开应用），打开 **设置** 即可看到齿轮按钮。

### 从 GitHub 安装（tarball）

```sh
# 网页版
dsh plugin --profile web add github:ZIye1208/dsh-settings-nav-manager
# 桌面版
dsh plugin --profile desktop add github:ZIye1208/dsh-settings-nav-manager
```

或用压缩包直链：

```sh
dsh plugin --profile <web|desktop> add https://github.com/ZIye1208/dsh-settings-nav-manager/archive/refs/heads/main.tar.gz
```

### 本地 / 开发安装

```sh
git clone https://github.com/ZIye1208/dsh-settings-nav-manager.git
cd dsh-settings-nav-manager
dsh plugin --profile web add .        # 桌面版把 web 换成 desktop
```

开发时用 `link:` 软链指向本地目录，改 `client.js` 后重启 DSH 即生效，无需重装。

### 卸载

```sh
dsh plugin --profile <web|desktop> remove dsh-settings-nav-manager
```

---

## 使用说明

1. 打开 **设置**，点击标题栏「打开配置文件」左侧的 **⚙ 齿轮**进入编辑模式（齿轮高亮，齿轮旁出现操作提示）。
2. **排序**：按住任意条目整行上下拖动，实时预览位置，松手保存。也可聚焦某行后按 `Alt+↑/↓`。
3. **隐藏**：点条目右侧的 👁 眼睛（或聚焦该行按 `h`）；隐藏后条目置灰、眼睛变划线眼，再点恢复；非编辑模式下直接不显示。
4. **抽屉**：
   - 点底部「＋ 新建抽屉」创建并立即改名；
   - 拖条目到抽屉名**入组**，拖到抽屉外**出组**，组内可继续排序；
   - 点抽屉头任意位置**折叠 / 展开**收纳（`▾` / `▸`）；
   - **双击**抽屉名改名，点 `×` **解散**（成员回未分组、保序）。
5. **恢复默认**：点底部「恢复默认」清空所有整理，回到宿主原始顺序。
6. 按 `Escape` 或再点齿轮**退出**编辑模式。所有改动即时持久化，重启保留。
7. **钉到侧栏（1.3.0）**：主界面插件栏点「设置导航」进入入口页 → 点某行右侧的 **☆**（变 ★）→ 侧栏插件栏立刻多一行，点它直接打开设置并选中该分区；再点 **★** 取消。最多 5 个。
8. **收起入口行**：编辑模式下齿轮旁「侧栏入口」开关可把「设置导航」那行藏起来（页面保留在册，不会指向空面板）；想找回就再进设置点一次。

---

## 数据结构与持久化

数据存放在 DSH 设置命名空间 **`settings-nav-manager`**，形状如下：

```json
{
  "version": 1,
  "order": ["general", "g-1", "models", "plugins"],
  "groups": [
    { "id": "g-1", "name": "常用", "collapsed": false, "items": ["account", "skills"] }
  ],
  "hidden": ["bili-settings"],
  "hideEntry": false,
  "pinned": ["models", "account"]
}
```

- `order`：顶层相对顺序，元素为**未分组的分区 id** 或**抽屉 id（`g-` 前缀）**。
- `groups[]`：抽屉（命名分组）：`id` / `name` / `collapsed`（收纳折叠）/ `items`（组内成员 id，有序）。
- `hidden`：被隐藏的分区 id 数组。
- `hideEntry`：是否隐藏主界面插件栏的「设置导航」入口（缺省 `false`，只有严格 `true` 才算隐藏）。
- `pinned`：固定到插件栏的分区 id 数组（有序，最多 5 个；隐藏的分区会在归一化时自动移出）。

写入前过滤非法元素；读取任何异常一律回退默认值，不报错。

命名空间按条目 id 精确匹配。若宿主把条目 id 改写成别名（`@local/...` 之类），插件会尝试认领**唯一**一个「schema 指纹 + 值形状都吻合」的命名空间；只要候选不唯一或值形状不符，就**一个字都不写**并提示——宁可这次没保存，也不赌一个命名空间去覆盖别人的配置。

> **命名空间必须等于插件条目 id。** 宿主的 `settings.update()` 用 `entries().find(row => row.options.id === ns)` 定位配置项，两者不一致会抛 `No configurable plugin entry`。本仓库的 `cordis.patch.yml` 把条目 id 固定为 `settings-nav-manager`，与 `client.js` 的 `NS` 常量一致；改动任一处都会被 `test/repo.test.mjs` 拦住。

---

## 分区识别

分区 id 取 `settings.section` 槽条目的 `options.id`。导航行（navCell）本身不带 id，靠标题文本与 `options.label` 匹配映射（DOM 序号为主、文本为兜底），因此**切换界面语言后仍能正确认行**。

识别采用双向校验：序号映射要求文本一致（或尚未渲染），并对重复 id 做保护；一旦发现行数与分区数不一致、且文本无法唯一对应，**本次不重排**并在齿轮旁提示「导航结构变化」，而不是硬认错行把顺序写坏。

## 实现约束（React 安全）

- 不改写 React 管理的 nav DOM 结构（`replaceWith` / `removeChild` 会抛 `NotFoundError`）；只加 `data-*` 属性 + 注入 CSS（图标用伪元素 / 描线 SVG mask 绘制，随主题取色）。
- 排序用 CSS `order` 重排，不动 React 节点（nav 容器为 flex column）。
- 抽屉头是插件自有 DOM 节点，配合 `MutationObserver` 自愈重建。
- 观察范围刻意收窄：面板是 `createPortal` 到 `document.body` 的直接子节点，因此只监听 body 的直接 `childList`（感知开关）+ nav 自身（感知行变化），并用 `requestAnimationFrame` 合并同帧回调；**不订阅整个文档子树**，避免流式输出时被 DOM 变更拖慢。
- 拖拽基于起手快照重算（纯函数），`pointercancel` / 失焦 / 页面隐藏都会回滚，不留半截状态。
- 选择器收敛到 `client.js` 头部的 `SEL` / `DATA` 常量表，宿主升级断链只改那一处；**不把 id 拼进选择器**（id 里的引号会让 `querySelector` 抛错），改用属性遍历比对。

## 开发与测试

```sh
npm test          # 纯逻辑单测 + 仓库校验（秒级，无需浏览器）
npm run test:e2e  # 无头 Chrome 端到端（真实 DOM + 真实 PointerEvent）
npm run locale    # 由 client.js 的字典重新生成 locale/*.json

# 改完源码要让它在本机桌面端生效：装好的那份是 node_modules 下的拷贝，不是软链
node tools/sync-profile.mjs desktop      # 同步进已安装副本（会先整份备份）
node tools/sync-profile.mjs desktop -n   # 只演练，看会改哪些文件
```

> `dsh plugin add` 装的是**拷贝**：不重新安装/同步，桌面端跑的还是旧代码。同步脚本按
> `package.json` 的 `files` 白名单走，跳过 `test/`、`tools/`、`assets/`；备份落在
> `~/.dsh/profiles/<profile>/.snm-sync-backup/<时间戳>/`。同步后**必须完全退出并重开应用**。

- `test/unit.test.mjs`：`normalize` / `serialize` / `applyDropTo` / `nudgeState` 等纯函数，包含 1.0.1 那个数据丢失缺陷的回归用例（「分区未知时不得裁剪」）。
- `test/repo.test.mjs`：清单声明（`platform` 必须是 `web`、命名空间必须等于条目 id、兼容范围要有上界）、文案单一来源、源码卫生（无 `innerHTML` / `eval`、无选择器拼接）。
- `test/e2e.mjs`：用无头 Chrome 复刻宿主设置页 DOM + 最小 React 运行时，按出厂方式加载 `client.js`，真实驱动指针 / 键盘事件；同时跑 `git HEAD` 的旧版本做 **A/B 对照**——标注「旧版应失败」的断言若在旧版通过，测试会判定为无效并失败。

## 排障

| 现象 | 处理 |
|---|---|
| 打开设置看不到齿轮 | 确认插件装在**当前 profile**（`web` 还是 `desktop`），装完需重启/重开应用；齿轮挂在 `settings.action` 槽，若被其他插件挤占可临时停用对方排查。 |
| 齿轮旁出现「未能保存排版（…）」 | 括号里是宿主的原始拒绝原因。写入先走 `update`；**只有**宿主报「配置条目/命名空间不存在」时才退到路径式 `mutate`，其它拒绝（校验、配额、只读、权限）原样上报、不再换路重试——刻意不用整份替换的 `replace`，避免认错命名空间时清掉别人的配置。控制台 `[settings-nav-manager]` 有每一条的完整错误。 |
| 齿轮旁出现「导航结构变化，暂未应用整理」 | 认行失配（行数与 `settings.section` 条目对不上）。通常是刚装了新插件、分区还在注册中；关掉重开设置即可。若持续出现，请在 issue 里附上你的分区列表。 |
| 整理后重启又变回去了 | 1.0.0 的已知缺陷，升级到 **1.0.1** 即可。 |
| 侧栏「设置导航」那行不见了 | 编辑模式里齿轮旁的开关被关掉了。打开设置 → 点齿轮 → 再点一下「侧栏入口」开关即可恢复（磁盘里的 `hideEntry` 会被一起复位）。 |
| 点入口页的某一行，设置开了但没选中 | 1.2.1 起页面里会直接显示「未能打开该分区」+「重试」。重试仍失败通常说明宿主改了设置外壳的实现（`sidebar.settings` 的 `openSection` 不在或行为变了），请附上版本号提 issue；临时可先按 `Ctrl+,` 打开设置手动点。 |
| 固定行点了没反应，或设置没打开 | 1.3.0 起点击走「document 捕获拦截 + 深链」：拦不到就退化成普通切面板（会停在兜底页，页里有「打开设置 / 返回」）。若看到兜底页，说明拦截或深链有一层没生效，请附版本号提 issue。 |
| 侧栏固定行个数对不上 | 上限 5 个；隐藏某个分区时它的固定会被自动取消（入口藏在设置里，钉着也点不到）。想恢复：入口页里再点一次 ☆。 |
| 想彻底重置 | 编辑模式底部点「恢复默认」，或删除设置文档里 `settings-nav-manager` 命名空间的 `user` 段。 |

## 兼容性

| 项 | 值 |
|---|---|
| DSH | `>=0.2.1-rc.2 <0.3.0`（`web` / `desktop` profile，实测 0.2.1-rc.2） |
| 运行时 | Node ≥ 20.18 |
| 构建 | 无（纯 JS / ESM） |

> `package.json` 里的 `dsh.client.platform` 必须写 **`"web"`**——宿主的模块系统据此判定「这是浏览器侧包」，桌面版同样读这个值（`platform !== "web"` 会被直接忽略）。别改成 `"desktop"`。

## 项目结构

```
dsh-settings-nav-manager/
├── index.js           # Host 侧：settings 命名空间 Config（volatile）声明
├── client.js          # Client 侧：齿轮 / 编辑模式 / DOM 干预 / 拖拽 / 显隐 / 抽屉 / 持久化 / 侧栏入口页
├── cordis.patch.yml   # 插件注册（id = settings-nav-manager）
├── locale/            # zh.json / en.json（由 client.js 字典生成）
├── icon.svg           # 插件图标
├── assets/            # demo-1.3.gif（分区固定演示）/ demo.gif（总览演示）
├── tools/gen-locale.mjs
└── test/              # unit / repo / e2e（含 harness）
```

## 许可

MIT
