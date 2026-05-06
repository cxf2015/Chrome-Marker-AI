# Chrome 网页划词一键翻译与 Markdown 转换插件

[English](README.md) | 中文

![Version](https://img.shields.io/badge/version-1.0.0-0A7F28)
![Manifest](https://img.shields.io/badge/Manifest-MV3-1F6FEB)
![Platform](https://img.shields.io/badge/Browser-Chrome-DB4437)
![AI](https://img.shields.io/badge/AI-Kimi%20Moonshot-111111)

面向任意网页的轻量 AI 助手：选中文字，点击一次，即可获得流式输出结果。

![alt text](attachment/image.png)

本扩展基于选中文本和页面内容，提供三个快捷操作：

- AI Explain：用简明中文解释选中文本
- To Chinese：将选中文本翻译为简洁中文
- To MD：将当前网页内容整理为干净、紧凑的 Markdown 摘要

适用于阅读、检索和快速做笔记等场景，直接在浏览器内完成。

## 为什么使用这个扩展

- 无需切换标签页：解释、翻译、转 Markdown 均可在页面内完成
- 流式输出：边生成边展示，响应更直接
- 轻量工作流：划词工具条 + 悬浮结果面板
- 复制友好：Markdown 结果可直接粘贴到文档、Wiki 或笔记中

## 三步快速安装

1. 打开 Chrome，访问 chrome://extensions/
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 chorme_marker_AI 文件夹

## 首次配置

1. 打开扩展详情页
2. 进入扩展选项（Options）
3. 粘贴你的 Kimi API Key 并点击 Save
4. 可选：点击 Test 验证认证是否成功

## 使用方法

1. 打开任意网页
2. 选中文本，显示悬浮工具条
3. 点击 AI Explain、To Chinese 或 To MD
4. 在结果卡片中查看流式输出，并按需复制

## 功能亮点

- 面向选中文本的悬浮操作工具条
- 基于 Kimi API 的流式生成
- 模型自动探测与回退优先级
- 请求失败时在结果卡片中给出错误反馈
- 通过扩展选项持久化保存 API Key

## 项目结构

- [manifest.json](manifest.json)：Chrome 扩展清单（MV3）
- [background.js](background.js)：Kimi API 调用、模型解析、流式处理管线
- [content.js](content.js)：工具条交互、动作分发、结果渲染
- [content.css](content.css)：工具条与结果卡片样式
- [options.html](options.html)：配置页面
- [options.js](options.js)：API Key 保存与测试逻辑

## API 与权限

- API endpoint: https://api.moonshot.cn/v1/chat/completions
- Model list endpoint: https://api.moonshot.cn/v1/models
- Permissions: storage
- Host permissions: https://api.moonshot.cn/*
- Content script match: all urls

## GitHub 检索关键词

chrome extension, kimi, moonshot, ai explain, translate to chinese, markdown generator, webpage to markdown, browser productivity, mv3, selection toolbar, streaming ai output

## 中文检索关键词

Chrome 插件, Kimi 插件, 网页翻译, 网页解释, 网页转 Markdown, 划词工具, 浏览器 AI 助手, 流式输出, Moonshot API, MV3 扩展

## 许可证

MIT License，详见 [LICENSE](LICENSE)。
