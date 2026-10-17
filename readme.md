# koishi-plugin-chatluna-sticker

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-sticker?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-sticker)

ChatLuna 扩展插件，让模型自主判断、收藏、发送群聊表情包。支持 pHash 去重、多模态模型判断、本地文件存储，以及可选的 embedding 语义匹配。

## 功能

- **自动追踪**：监听群聊中的图片/表情，用 64-bit pHash 去重，全局累计出现次数
- **自动收藏**：一张图出现次数达到阈值后，由 ChatLuna 多模态模型判断是否值得收藏为表情包
- **本地库**：图片按 pHash 前两位分桶存本地文件系统，元数据存数据库，不依赖 QQ 收藏夹
- **自主发送**：注册 ChatLuna 工具 `sticker_send`，AI 根据表达意图自主选图并发送
- **语义匹配（可选）**：用 ChatLuna embedding 模型把 `intent` 和表情包描述编码成向量，通过 [luna-vdb](https://github.com/ChatLunaLab/luna-vdb) 做余弦相似度检索；未启用或未命中时自动回退到关键词匹配
- **过期淘汰**：
- 未被收藏的追踪记录超过 `occurrenceTtlDays`（默认 10 天）未再出现 → 清理记录与本地图片
- 已收藏超过 `maxSendableImages`（默认 1000 张）→ 按最后使用时间淘汰最久未使用的
- **崩溃恢复**：判断过程带占用令牌与超时检测，进程崩溃残留的 `judging` 记录会在下次启动或定时扫描时自动重置并重新判断

## 安装

```bash
npm install koishi-plugin-chatluna koishi-plugin-chatluna-sticker

## 常见问题与进阶配置

### ⚠️ 关于 luna-vdb 的并发冲突

本插件依赖 `@chatluna/luna-vdb` 进行语义向量检索。
由于 `luna-vdb` 底层是编译为 WASM 的 Rust 模块，在 Node.js 单进程环境下，如果 ChatLuna 核心（例如启用了 RAG 知识库、长期记忆等插件）或其它插件同时使用了 `luna-vdb`，会触发底层的并发借用冲突，导致日志报错：

> `recursive use of an object detected which would lead to unsafe aliasing in rust`

#### 简易解决方案：使用 isolate-loader 进行实例隔离

建议安装并启用 `koishi-plugin-isolate-loader` 插件，将本插件放入独立的加载环境中运行，从而让本插件拥有完全独立的 WASM 实例，彻底解决跨插件的并发冲突。

**操作步骤：**

1. **安装隔离插件：**
   在控制台插件市场搜索安装，或在终端执行：
   ```bash
   npm install koishi-plugin-isolate-loader
2. **添加并启用插件：**
   在 Koishi 控制台的「插件配置」页面，点击「添加插件」，搜索并添加 isolate-loader。确保该插件处于启用状态（左侧栏显示绿灯）。
3. **创建独立分组：**
   打开 Koishi 控制台，在左侧插件列表中，新建一个分组（例如命名为 sticker-isolate）。
4. **移动插件：**
   将 chatluna-sticker 插件拖入刚才新建的分组中。
5. **转换为 Isolated 分组：**
   选中该分组，在右侧的 isolate-loader 配置面板中，点击 “将本分组转换为 Isolated 分组” 按钮。
6. **重新启用此插件**
   分组转换完成后插件会被默认关闭，重新启用即可。