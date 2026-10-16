// Routing eval dataset (steward.md §3.4): a fixed world of threads and labeled utterances.
// Every label is defensible by a human: attach to a specific thread, create a new one,
// ask the user, or just converse. Regress the whole set when model/prompt/candidate
// assembly changes.
//
// Ported verbatim from spike-final (ADR-0001 decision 1: the 106-case set is the regression
// baseline; the spike's 94.3% pass rate on deepseek-flash is the bar this tree must hold).
// Labels A–G and the relay cluster (101–106, spike bug 11) are unchanged; only this header
// and the issue-#7 note below were added.

export interface ThreadSpec {
	id: string;
	title: string;
	goal: string;
	summary?: string;
	/** worker event script to reach the state */
	state: "idle_clean" | "idle_unread" | "running" | "waiting";
	/** how long ago the thread was last active */
	ageH: number; // hours
}

export const THREADS: ThreadSpec[] = [
	// login ambiguity cluster
	{ id: "t_login_bug", title: "修复登录页报错", goal: "token 过期后登录页抛 500", summary: "定位到 refresh 逻辑漏了并发保护，已修复，测试通过", state: "idle_unread", ageH: 2 },
	{ id: "t_login_style", title: "登录页样式调整", goal: "配色改为品牌蓝，间距统一", summary: "按钮和输入框配色已改，间距用 8px 栅格", state: "idle_clean", ageH: 24 },
	{ id: "t_login_rl", title: "登录接口限流", goal: "给登录接口加 IP 级限流", summary: "正在写限流中间件，滑动窗口方案", state: "running", ageH: 0.2 },
	// homepage ambiguity cluster
	{ id: "t_home_speed", title: "优化首页加载速度", goal: "首屏 LCP 降到 2s 以内", summary: "首屏 JS 拆包完成，LCP 从 4.2s 降到 2.8s", state: "idle_clean", ageH: 72 },
	{ id: "t_home_dark", title: "给首页加暗色模式", goal: "主题变量抽取 + 暗色主题", summary: "主题变量已抽出，卡在默认配色选择（深蓝还是纯黑）", state: "waiting", ageH: 1 },
	{ id: "t_home_chart", title: "首页图表组件", goal: "图表库换轻量方案", summary: "echarts 全量引入改为按需，体积降了 60%", state: "idle_clean", ageH: 24 },
	// gateway cluster
	{ id: "t_gw_refactor", title: "api-gateway 重构", goal: "路由层抽成独立包", summary: "正在迁移路由注册逻辑到子包", state: "running", ageH: 0.5 },
	{ id: "t_gw_logs", title: "api-gateway 日志规范化", goal: "结构化日志 + trace id 贯穿", summary: "日志字段已定义，trace id 中间件写完", state: "idle_clean", ageH: 120 },
	// the rest
	{ id: "t_deploy", title: "部署脚本迁移到 GitHub Actions", goal: "Makefile 部署改成 Actions workflow", summary: "build/deploy 两个 job 已拆", state: "idle_clean", ageH: 168 },
	{ id: "t_db", title: "数据库迁移工具选型", goal: "knex / drizzle / 原生 SQL 三选一", summary: "对比文档写了一半，drizzle 倾向", state: "idle_unread", ageH: 48 },
	{ id: "t_mobile", title: "移动端适配", goal: "核心页面移动端可用", summary: "正在调列表页的响应式布局", state: "running", ageH: 0.1 },
	{ id: "t_ci", title: "CI 提速", goal: "流水线从 12 分钟压到 5 分钟", summary: "缓存 node_modules 后降到 8 分钟", state: "idle_clean", ageH: 96 },
	{ id: "t_deps", title: "升级依赖", goal: "清理过期依赖并升级主版本", summary: "已升 14 个包，react 还没动", state: "idle_clean", ageH: 240 },
	{ id: "t_docs", title: "补 API 文档", goal: "OpenAPI 注释补齐", summary: "user 组接口已补，auth 那节还没动", state: "idle_clean", ageH: 144 },
	{ id: "t_pay", title: "支付回调对账", goal: "回调金额与订单对账", summary: "对账脚本跑通，卡在差异阈值策略（差多少拦下来）", state: "waiting", ageH: 3 },
	{ id: "t_email", title: "邮件通知改队列发送", goal: "同步发信改异步队列", summary: "接了 bullmq，重试策略没定", state: "idle_clean", ageH: 24 },
	{ id: "t_cache", title: "加 Redis 缓存", goal: "热点接口缓存", summary: "读多写少的 3 个接口已接缓存", state: "idle_clean", ageH: 48 },
	{ id: "t_seo", title: "SEO 优化", goal: "meta/结构化数据", summary: "meta 模板完成，sitemap 未做", state: "idle_clean", ageH: 336 },
	{ id: "t_perm", title: "权限系统改造", goal: "角色-权限模型", summary: "表结构设计中，RBAC 方案", state: "running", ageH: 0.3 },
	{ id: "t_export", title: "导出 Excel 功能", goal: "订单导出 Excel", summary: "单 sheet 导出可用，样式粗糙", state: "idle_unread", ageH: 8 },
	{ id: "t_cron", title: "定时清理临时文件", goal: "每天清理 /tmp 上传残留", summary: "cron 表达式和清理规则已写", state: "idle_clean", ageH: 48 },
	{ id: "t_i18n", title: "国际化框架接入", goal: "文案抽 key，接入 i18n", summary: "框架没定（vue-i18n 还是自制），等用户拍板", state: "waiting", ageH: 2 },
	{ id: "t_upload", title: "大文件分片上传", goal: "分片 + 断点续传", summary: "分片逻辑写完，续传调试中", state: "running", ageH: 0.25 },
	{ id: "t_toast", title: "全局错误提示组件", goal: "统一错误 toast", summary: "组件写完，错误码映射表差一半", state: "idle_unread", ageH: 0.5 },
	// plan-relay cluster: the thread's deliverable is a plan doc; a follow-up that
	// says "按 X 方案实施" must relay on this thread, not open a new one (live M3
	// finding — a new thread drops the branch base and leg-2 starts from HEAD).
	{ id: "t_search_plan", title: "搜索功能方案调研", goal: "调研站内搜索怎么做，产出 docs/search-plan.md", summary: "方案已写入 docs/search-plan.md：一期 PostgreSQL 全文检索，es 留到数据量上来再上", state: "idle_clean", ageH: 5 },
];

export type Expect =
	| { kind: "attach"; threadId: string }
	| { kind: "new" }
	| { kind: "ask" }
	| { kind: "chat" };

export interface Case {
	id: number;
	text: string;
	expect: Expect;
	note?: string; // why the label is what it is, for the ambiguous ones
}

export const CASES: Case[] = [
	// A. attach by distinctive keywords (30)
	{ id: 1, text: "登录页那个 500 报错修好了吗", expect: { kind: "chat" }, note: "状态询问：账本已有答案，凭记忆答" },
	{ id: 2, text: "登录页报错那个再跑一次测试", expect: { kind: "attach", threadId: "t_login_bug" } },
	{ id: 3, text: "限流那个改到哪了", expect: { kind: "chat" }, note: "进度询问：running 状态可答" },
	{ id: 4, text: "登录接口的限流加上白名单吧", expect: { kind: "attach", threadId: "t_login_rl" } },
	{ id: 5, text: "登录页配色定了吗", expect: { kind: "chat" }, note: "状态询问" },
	{ id: 6, text: "把登录页的间距再调大一点", expect: { kind: "attach", threadId: "t_login_style" } },
	{ id: 7, text: "首页加载速度还能再压一压吗，LCP 争取 2s 以内", expect: { kind: "attach", threadId: "t_home_speed" } },
	{ id: 8, text: "首屏拆包之后懒加载的图也要处理下", expect: { kind: "attach", threadId: "t_home_speed" } },
	{ id: 9, text: "暗色模式做完把截图发我", expect: { kind: "attach", threadId: "t_home_dark" }, note: "挂上并提醒待决问题，合理" },
	{ id: 10, text: "图表组件那个换完了吗", expect: { kind: "chat" }, note: "状态询问" },
	{ id: 11, text: "把图表库的按需引入也做了", expect: { kind: "attach", threadId: "t_home_chart" } },
	{ id: 12, text: "网关重构别把老路由删了，先留着兼容", expect: { kind: "attach", threadId: "t_gw_refactor" } },
	{ id: 13, text: "路由层抽包的时候记得加单测", expect: { kind: "attach", threadId: "t_gw_refactor" } },
	{ id: 14, text: "网关的日志把 trace id 也打到响应头", expect: { kind: "attach", threadId: "t_gw_logs" } },
	{ id: 15, text: "结构化日志加上 user id 字段", expect: { kind: "attach", threadId: "t_gw_logs" } },
	{ id: 16, text: "部署脚本那个 workflows 里加个缓存", expect: { kind: "attach", threadId: "t_deploy" } },
	{ id: 17, text: "GitHub Actions 那个加上单元测试 job", expect: { kind: "attach", threadId: "t_deploy" } },
	{ id: 18, text: "数据库迁移工具定了没", expect: { kind: "chat" }, note: "状态询问：选型结论在汇报里" },
	{ id: 19, text: "迁移工具如果选 drizzle 就把 schema 也迁了", expect: { kind: "attach", threadId: "t_db" } },
	{ id: 20, text: "移动端先适配列表页", expect: { kind: "attach", threadId: "t_mobile" } },
	{ id: 21, text: "CI 那个把 npm ci 换成 pnpm", expect: { kind: "attach", threadId: "t_ci" } },
	{ id: 22, text: "依赖升级那个把 react 也升到 19", expect: { kind: "attach", threadId: "t_deps" } },
	{ id: 23, text: "API 文档先把 auth 那节补了", expect: { kind: "attach", threadId: "t_docs" }, note: "auth 节确实还没补" },
	{ id: 24, text: "支付对账那个，差异小于 1 分钱的自动放过", expect: { kind: "attach", threadId: "t_pay" }, note: "顺带回答了 pending 问题" },
	{ id: 25, text: "邮件通知失败重试 3 次再进死信", expect: { kind: "attach", threadId: "t_email" } },
	{ id: 26, text: "Redis 缓存给热点接口加个开关", expect: { kind: "attach", threadId: "t_cache" } },
	{ id: 27, text: "SEO 那个把 sitemap 生成也加上", expect: { kind: "attach", threadId: "t_seo" } },
	{ id: 28, text: "权限系统先把角色那层做了", expect: { kind: "attach", threadId: "t_perm" } },
	{ id: 29, text: "导出 Excel 支持多 sheet", expect: { kind: "attach", threadId: "t_export" } },
	{ id: 30, text: "全局错误提示加上错误码", expect: { kind: "attach", threadId: "t_toast" } },

	// B. attach via state/context with a qualifier (10)
	{ id: 31, text: "上传那个跑得怎么样了", expect: { kind: "chat" }, note: "进度询问" },
	{ id: 32, text: "让上传那个 worker 确认下断点续传好使不好使", expect: { kind: "attach", threadId: "t_upload" }, note: "明确指令转达" },
	{ id: 33, text: "国际化那个卡在哪了", expect: { kind: "chat" }, note: "卡点在 pending 问题里" },
	{ id: 34, text: "i18n 那个卡住的问题我回了：先用 vue-i18n", expect: { kind: "attach", threadId: "t_i18n" } },
	{ id: 35, text: "定时清理那个任务跑过了吗", expect: { kind: "chat" }, note: "状态询问" },
	{ id: 36, text: "错误提示那个组件看完汇报了吗", expect: { kind: "chat" }, note: "汇报已存在，直接总结" },
	{ id: 37, text: "Excel 导出的汇报发我看看", expect: { kind: "chat" }, note: "汇报已存在，直接转述" },
	{ id: 38, text: "权限那个跑完让它把迁移 SQL 也生成", expect: { kind: "attach", threadId: "t_perm" } },
	{ id: 39, text: "限流那个中间件写完提醒我 review", expect: { kind: "attach", threadId: "t_login_rl" }, note: "转达指令给在跑的 worker，按设计应派发" },
	{ id: 40, text: "网关重构完把包名发我", expect: { kind: "attach", threadId: "t_gw_refactor" }, note: "转达指令给在跑的 worker" },

	// C. clearly new work (20)
	{ id: 41, text: "帮我加一个 webhook 接收 GitHub 的 issue 事件", expect: { kind: "new" } },
	{ id: 42, text: "给用户表加软删除", expect: { kind: "new" } },
	{ id: 43, text: "写一个造测试数据的 faker 脚本", expect: { kind: "new" } },
	{ id: 44, text: "加一个健康检查接口 /healthz", expect: { kind: "new" } },
	{ id: 45, text: "把 README 翻译成英文", expect: { kind: "new" }, note: "与「补 API 文档」不同一件事" },
	{ id: 46, text: "加一个命令行工具方便触发任务", expect: { kind: "new" } },
	{ id: 47, text: "调研一下要不要上 GraphQL", expect: { kind: "new" } },
	{ id: 48, text: "给测试环境加个种子数据", expect: { kind: "new" } },
	{ id: 49, text: "接口加个 v2 版本前缀", expect: { kind: "new" } },
	{ id: 50, text: "做一下静态站点的 CDN 配置", expect: { kind: "new" } },
	{ id: 51, text: "加一个图片压缩的构建步骤", expect: { kind: "new" } },
	{ id: 52, text: "写个脚本统计代码行数", expect: { kind: "new" } },
	{ id: 53, text: "给订单加一个状态机", expect: { kind: "new" } },
	{ id: 54, text: "加一个防重复提交的幂等键", expect: { kind: "new" } },
	{ id: 55, text: "配置一下 sentry 错误监控", expect: { kind: "new" }, note: "监控 ≠ 错误提示组件，考察区分度" },
	{ id: 56, text: "把测试框架从 jest 换成 vitest", expect: { kind: "new" } },
	{ id: 57, text: "加一个灰度发布的开关", expect: { kind: "new" } },
	{ id: 58, text: "写个脚本批量清理 git 孤儿分支", expect: { kind: "new" }, note: "与「定时清理临时文件」区分" },
	{ id: 59, text: "给管理后台加操作审计日志", expect: { kind: "new" }, note: "与「网关日志规范化」区分" },
	{ id: 60, text: "加一个 feature flag 服务", expect: { kind: "new" } },

	// D. genuinely ambiguous, must ask (15)
	{ id: 61, text: "登录那个再改改", expect: { kind: "ask" }, note: "登录簇 x3" },
	{ id: 62, text: "首页的事怎么样了", expect: { kind: "ask" }, note: "首页簇 x3" },
	{ id: 63, text: "网关那边有点慢，帮我看看", expect: { kind: "ask" }, note: "网关簇 x2，日志开销也可能相关" },
	{ id: 64, text: "之前那个任务先停掉吧", expect: { kind: "ask" }, note: "running x5" },
	{ id: 65, text: "那个卡住的怎么回事", expect: { kind: "ask" }, note: "waiting x3" },
	{ id: 66, text: "把报错那个修一下", expect: { kind: "attach", threadId: "t_login_bug" }, note: "祈使句重验可接受" },
	{ id: 67, text: "样式那个再调调", expect: { kind: "attach", threadId: "t_login_style" }, note: "「样式」主要落在登录页样式调整" },
	{ id: 68, text: "优化那个怎么样了", expect: { kind: "ask" }, note: "加载速度/CI 提速/移动端都算优化" },
	{ id: 69, text: "那个等我的事我再想想", expect: { kind: "ask" }, note: "waiting x3" },
	{ id: 70, text: "老任务别丢了", expect: { kind: "chat" }, note: "求安心的话，盘点汇报即可" },
	{ id: 71, text: "接着上次的弄", expect: { kind: "ask" }, note: "无指代" },
	{ id: 72, text: "把登录的几件事都收尾一下", expect: { kind: "ask" }, note: "模型谨慎确认子集，可接受" },
	{ id: 73, text: "那个没跑完的呢", expect: { kind: "ask" }, note: "running x5" },
	{ id: 74, text: "测试那个加一下", expect: { kind: "ask" }, note: "CI/单测/测试数据多义" },
	{ id: 75, text: "把慢的地方都看看", expect: { kind: "new" }, note: "全面性能排查是新工作" },

	// E. pure conversation / status, no dispatch no ask (8)
	{ id: 76, text: "谢谢", expect: { kind: "chat" } },
	{ id: 77, text: "你是谁", expect: { kind: "chat" } },
	{ id: 78, text: "现在都有哪些事在跑", expect: { kind: "chat" } },
	{ id: 79, text: "有哪些事在等我", expect: { kind: "chat" } },
	{ id: 80, text: "今天有什么汇报吗", expect: { kind: "chat" } },
	{ id: 81, text: "在吗", expect: { kind: "chat" } },
	{ id: 82, text: "把目前所有 thread 的状态列一下", expect: { kind: "chat" } },
	{ id: 83, text: "晚安", expect: { kind: "chat" } },

	// F. answers to pending questions / follow-ups (7)
	{ id: 84, text: "支付回调那个：差异超过 1 块的才拦下来", expect: { kind: "attach", threadId: "t_pay" } },
	{ id: 85, text: "暗色模式默认用深蓝，别用纯黑", expect: { kind: "attach", threadId: "t_home_dark" } },
	{ id: 86, text: "i18n 那个定了，用 vue-i18n", expect: { kind: "attach", threadId: "t_i18n" } },
	{ id: 87, text: "支付那个先只对线上环境对账", expect: { kind: "attach", threadId: "t_pay" } },
	{ id: 88, text: "暗色模式还要做个手动切换的开关", expect: { kind: "attach", threadId: "t_home_dark" } },
	{ id: 89, text: "国际化记得把时区也处理了", expect: { kind: "attach", threadId: "t_i18n" } },
	{ id: 90, text: "对账报表每天发我一份", expect: { kind: "new" }, note: "在既有对账之上的新例行事项" },

	// A2. more distinctive-keyword attach (10)
	{ id: 91, text: "CI 那个加上并行分片", expect: { kind: "attach", threadId: "t_ci" } },
	{ id: 92, text: "依赖升级跑完把 lockfile 提交", expect: { kind: "attach", threadId: "t_deps" } },
	{ id: 93, text: "文档补完把 postman collection 也导出", expect: { kind: "attach", threadId: "t_docs" } },
	{ id: 94, text: "邮件队列加上失败告警", expect: { kind: "attach", threadId: "t_email" } },
	{ id: 95, text: "Redis 的 key 加上统一前缀", expect: { kind: "attach", threadId: "t_cache" } },
	{ id: 96, text: "sitemap 提交到百度也做", expect: { kind: "attach", threadId: "t_seo" } },
	{ id: 97, text: "移动端跑完真机测一下", expect: { kind: "attach", threadId: "t_mobile" } },
	{ id: 98, text: "Excel 导出加上进度条", expect: { kind: "attach", threadId: "t_export" } },
	{ id: 99, text: "错误提示组件支持自定义文案", expect: { kind: "attach", threadId: "t_toast" } },
	{ id: 100, text: "定时清理加上保留 7 天的策略", expect: { kind: "attach", threadId: "t_cron" } },

	// G. relay / continuation onto a plan-producing thread (live M3 phrasings)
	{ id: 101, text: "按搜索方案实施", expect: { kind: "attach", threadId: "t_search_plan" }, note: "live 案例：按 X 方案实施 → 接续调研线程，另开线程会丢掉分支接力基础" },
	{ id: 102, text: "在刚才搜索调研的基础上把实现做了", expect: { kind: "attach", threadId: "t_search_plan" } },
	{ id: 103, text: "回到搜索调研那条线程继续", expect: { kind: "attach", threadId: "t_search_plan" }, note: "live 验证过的显式措辞" },
	{ id: 104, text: "搜索方案我看完了，就按 docs/search-plan.md 里的一期做", expect: { kind: "attach", threadId: "t_search_plan" } },
	{ id: 105, text: "按产品发的交互稿把设置页做了", expect: { kind: "new" }, note: "反例：「按 X 做」但 X 是外部产物、无对应线程 → 新工作" },
	{ id: 106, text: "搜索的方案出来了吗", expect: { kind: "chat" }, note: "边界：问方案进度不派发，方案已在汇报里" },
];
