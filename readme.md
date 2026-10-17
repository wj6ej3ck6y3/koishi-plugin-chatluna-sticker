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