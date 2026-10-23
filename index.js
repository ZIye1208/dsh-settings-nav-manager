import z from "@deepseek-ai/schemastery";

const name = "dsh-settings-nav-manager";
const NS = "settings-nav-manager";

// volatile Config: 持久化字段（settings-nav-manager 命名空间）。
// order = 全局相对顺序（section id 数组，含分组内条目）。
// groups = 自定义分组（P2 预留，P1 恒为空数组）。
// hidden = 隐藏分区 id 数组。
// hideEntry = 是否隐藏主界面侧栏的「设置导航」入口（编辑模式里齿轮旁开关）。
const Config = z.object({
  version: z.number().default(1),
  order: z.array(z.string()).default([]),
  groups: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        collapsed: z.boolean().default(false),
        items: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  hidden: z.array(z.string()).default([]),
  hideEntry: z.boolean().default(false),
}).volatile();

// P1 纯 client 侧 DOM 干预 + remote.settings 持久化；Host 只持有 volatile Config schema
// （settings 服务的 write() 要求 Config 存在且有 volatile 字段，否则 update() 抛
// "No configurable plugin entry" / "has no volatile fields"）。
function apply(ctx, _config) {
  // 供未来 Host 侧读写钩子使用；当前留空，避免引入副作用。
}

export { Config, NS, apply, name };
