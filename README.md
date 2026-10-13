# Campus Bounty · 校园悬赏令

私有开发仓库。面向高校社区的任务申请、团队协作、履约及商品交易应用，英文界面。

这是当前开发源码的可复现快照。真实付款、外部邮件及完整生产验收尚未完成；本地模拟数据不代表真实交易。

## 已接通的主要流程

- 悬赏顶部 Apply、个人/团队申请、成员同意、邀请接受、退出及历史保留。
- Messages 统一查看有权访问的申请、协议和订单对话；可见页面约每三秒自动检查新消息，保留草稿、搜索和阅读位置。
- 申请阶段沟通：未同意成员可以先问问题；聊天不会自动变成同意或更改条款。
- 接受申请后进入准确的协作协议，旧申请聊天保留只读；消息不会自动复制。
- 消息历史、参与人、搜索、通知定位、草稿保留及未知发送状态恢复。
- 成果版本、要求修改、再次提交、验收和协作完成；完成不表示已付款。
- 校园资格、本地审核、团队管理、商品报价/订单及未付款取消。

最新入口和双向聊天实测见 [Apply 与消息修复](docs/apply-chat-fix-delivery.md)。自动接收采用轮询，未验收生产推送或大规模容量。

完整范围与未完成项目见 [交互清单](docs/interaction-completion.md)，本轮证据与限制见 [第十轮交付](docs/interaction-round10-delivery.md)。

## 运行当前 PostgreSQL 交互演示

需要 Node.js 24、Docker，以及可用的本地端口。先安装依赖并准备本地测试数据库：

```sh
npm ci
npm run backend:db
npm run interaction:preview
```

默认入口为 `http://127.0.0.1:3020`。演示只绑定本机，创建隔离测试数据。测试身份使用 `campus.example.test` 域名；可以直接使用页面上的 Alex、Sam、Professor 固定示例身份按钮，不必读取本地验证码；身份切换仅在严格匹配的本地测试预览中开放。真实大学邮箱外部发信尚未接通；测试邮件接收器仍仅用于本地检查。预览运行目录是 `.data/backend/interaction/`，不能提交到 Git。

该预览是可丢弃测试实例，进程退出会清理其数据库。不要将其用于真实业务数据。

`npm run dev` / `npm start` 仍提供较早的独立 SQLite 演示模式（3010端口），它不等同于上述共享 PostgreSQL 交互模式，也不代表当前云端部署。

## 验证

```sh
npm test
npm run typecheck
CAMPUS_BUILD_DIR=.next-release npm run build
```

需要完整允许后端检查时，使用明确排除历史受限场景的命令：

```sh
node --test --test-skip-pattern='^send gate remains held during key wait and rechecks clock expiry before releasing a cached receipt$' tests/backend/*.test.mjs tests/independent/*/*.test.mjs
```

不要在此次验收范围内直接运行未过滤的 `npm run test:backend`。独立目录中保留的非 `.test` 强制撤权诊断源文件仅作历史证据，不应执行或换方式重建。历史测试执行偏差和未取得视频证据均在交付说明中披露。

浏览器测试需要 Playwright；环境未安装时用 `PLAYWRIGHT_MODULE` 指定现有模块路径。额外的 OpenAPI 语义检查使用 Python `jsonschema`：`python3 tests/conversation-openapi-schema.test.py`。数据库测试使用隔离本地测试库。

## 配置与资料

- [接口定义](docs/backend-openapi.json)
- [申请沟通合同](docs/evidence/interaction-round10/backend-contract.md)
- [源产品方案](docs/backend-source-plan.md)
- [术语说明](GLOSSARY.md)

仓库不包含本地数据库、会话、邮箱验证码、密钥、构建产物、代理工作目录或原始截图/运行日志。交付说明中指向这些本地证据的路径需在原工作区查阅。历史 Git 提交未上传；本仓库从经过检查的当前源码快照开始。原工作区和证据仍保留。

没有授予开源许可证；请仅按仓库所有者授予的权限使用。
