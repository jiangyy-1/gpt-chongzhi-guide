# Codex 上手第一周：从装 CLI 到跑顺任务的路线图（2026）

> 原文（价格实时更新）：https://gptpro20x.com/blog/codex-shangshou/

先说结论：Codex 是 ChatGPT 订阅**自带**的编程 agent，Plus 就能用，不需要 API key。第一周路线：装 CLI → ChatGPT 账号登录 → 小任务练手 → 云端并行 → 查用量习惯。

## 装机

`npm i -g @openai/codex`，首启选 ChatGPT 账号登录（不用 API key，额度走订阅）。Windows 建议 WSL。国内网络给终端挂代理。

## 第一个任务怎么选

选"改动小、边界清"的：修明确报错的 bug、补测试、写独立脚本。别一上来重构整仓——大任务烧 token 快，你也没法审。

## 本地 vs 云端

本地 CLI 实时交互，适合小步快跑；云端任务在沙箱异步跑，适合修 bug/写测试/提 PR、可并行。共享同一套订阅额度。前五天只用本地，最后两天试云端：睡前扔两个任务，早上看 PR。

## 模型档

日常 Terra；硬骨头 Sol（贵 2 倍推理强）；机械活 Luna（消耗 1/5）。

## 用量管理

CLI 里 `/status` 看窗口剩余，网页 Codex Settings → Usage 看曲线。第一周每天看一眼，一个月吃多少额度数据会告诉你——Plus 够用还是该上 Pro 档（5×/20× 并发上限高得多）。

提醒：永远在有 git 的目录里跑，改完先看 diff 再合并。它是很强的实习生，不是免审的同事。

---

Plus 约 ¥168/月、Pro 5×（Codex 高并发）约 ¥818/月，支付宝微信直充：https://gptpro20x.com/chatgpt/
