# WaveMusic Connect

WaveMusic Connect 是一个 Windows 桌面音乐聚合客户端，提供统一界面连接网易云音乐与汽水音乐。项目使用 Electron、Vue 3 和 TypeScript；没有自建后端或数据库，平台请求由本机桌面进程发起。

本项目为非官方第三方软件，与网易云音乐、汽水音乐及其运营方无隶属关系。登录、搜索、歌单和播放能力受平台接口、账号权限、地区和版权限制影响；不绕过会员、DRM、风控或平台访问控制。

## AI 开发说明

本项目在 AI 辅助下开发；部分源代码、文档和问题修复由 AI 生成或协助修改，并由项目维护者整合。AI 生成内容可能存在错误，使用者应自行审查并验证。

## 功能

- 网易云音乐和汽水音乐扫码登录（具体可用性可能随平台接口变化）。
- 跨平台搜索、平台歌单查看与管理，以及桌面内播放授权音频。
- 仅保存在本机的混合喜欢列表；红心不会调用平台收藏接口。
- 独立的平台会话、账号切换清理和本机脱敏诊断日志。

汽水音乐登录集成使用 `vendor/` 中的 `qishui-api` 与 `qishui-core` 包快照。第三方来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开发

环境要求：Node.js 20.18 或更高版本，以及 pnpm。

```powershell
pnpm install
pnpm typecheck
pnpm build
```

运行开发版：

```powershell
pnpm dev
```

Windows 安装包可在本机通过 `pnpm package:win` 构建。安装包、打包目录和编译输出均由 `.gitignore` 排除，不属于本仓库发布内容。

## 使用与隐私

- 账号会话和本地喜欢保存在本机应用数据目录，不会同步到项目服务器（本项目不提供服务器）。
- 日志会隐藏 Cookie、验证码、票据及其他凭据。反馈问题时请勿公开二维码、Cookie 或带授权参数的媒体地址。
- 平台可能调整接口、限流或拒绝第三方客户端请求；类型检查和本地构建通过不代表平台登录或播放已得到保证。
- 播放仅使用平台授权且直接返回的普通音频地址；不提供音频下载、上传、解密或版权限制绕过功能。

## 项目结构

```text
apps/desktop/src/main/       Electron 主进程与平台适配
apps/desktop/src/preload/    受限的界面桥接
apps/desktop/src/renderer/   Vue 桌面界面
vendor/                      构建所需的汽水登录依赖包
docs/                        开发路线与项目记录
```
