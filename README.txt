客户管理助手 PWA V5.6

- 公开初始数据库：0 客户 / 0 联系人 / 0 拜访。
- 页面顶部明确显示 V5.6。
- JSON 导入兼容：V4/V5 主数据数组、V4/V5 完整备份 data 数组，以及 customers/customerList/clients/records 等常见结构。
- 导入前显示识别到的客户/联系人/拜访数量，确认后才替换本机数据库。
- app.js 不包含任何客户资料。
- Service Worker 使用 V5.6 独立缓存，并清理旧 crm-pwa-* 缓存。
