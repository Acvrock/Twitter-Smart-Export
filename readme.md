# Twitter Smart Export - 推特智能导出工具

## 简介
Twitter Smart Export 是一个浏览器用户脚本，支持智能导出推特内容，包含日期筛选、流式 ZIP 打包和图片下载等功能。适用于 `twitter.com` 和 `x.com`。

## 功能
- 智能滚动加载推文
- 支持按日期筛选导出
- 支持导出为 ZIP 包（包含推文文本和图片）
- 支持导出为纯文本
- 失败文件自动生成错误日志
- 进度与状态提示
- 支持调试信息导出

## 安装方法
1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 插件
2. 新建脚本，将 `twitter.js` 代码粘贴进去并保存

## 使用方法
1. 打开任意推特用户主页
2. 页面右下角会出现“推特智能导出”工具
3. 选择日期，点击“流式导出”或“导出为文本”按钮
4. 等待导出完成，自动下载文件

## 注意事项
- 建议在网络良好时使用，导出大量推文时请耐心等待
- 若遇到导出失败，可点击“调试信息”按钮导出日志反馈

## 许可协议
MIT License

---

如需反馈或贡献，请访问 [GitHub 项目主页](https://github.com/acvrock/Twitter-Smart-Export)。
