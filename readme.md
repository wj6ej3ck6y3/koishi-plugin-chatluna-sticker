# koishi-plugin-chatluna-sticker

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-sticker?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-sticker)

chatluna擴展，給予了模型根據自身判斷收藏、發送表情的能力

## 功能

- **自动追踪**：监听群聊中的图片/表情，用 pHash（64-bit）去重后全局统计出现次数
- **自動去重**：从数据库加载 pHash 進行汉明距离计算
- **自动收藏**：出现次数达到阈值后，由 Chatluna 多模态模型判断是否收藏
- **本地库**：图片存本地文件系统，元数据存数据库，不依赖 QQ 收藏夹
- **容量上限**：可发送图片超过 `maxSendableImages`（默认 10000）时，按收藏时间淘汰最旧的
- **自主发送**：注册 Chatluna 工具 `sticker_send`，AI 根据表达意图自主选图并发送
- **过期淘汰**：超过一定时间的未收藏非活跃表情包，与超过一定数量的以收藏未活跃表情包自动清理

## 安装

```bash
npm install koishi-plugin-chatluna-sticker