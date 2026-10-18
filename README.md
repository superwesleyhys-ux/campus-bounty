# Campus Bounty · 美国大学悬赏令

私有开发仓库。面向高校社区的任务申请、团队协作、履约及商品交易应用，英文界面。

这是当前开发源码的可复现快照。真实付款、外部邮件及完整生产验收尚未完成；本地模拟数据不代表真实交易。

## Current development checkpoint

This repository now includes in-progress transaction and agreement-change work. Read [current development status](docs/github-development-status.md) before using it. A sync commit is not a release or deployment; real login, payments and final acceptance remain incomplete. Historical verification sections below refer only to their named increments.

### Latest development checkpoint — 2026-10-18

The scoped Astra High amendment-money fix1 review returned Spec PASS / Quality PASS and was accepted for its bounded backend/API scope. The participant payment UI is still being implemented and is not independently accepted or deployed.

New local synthetic evidence: fee reconfirmation/supplement now presents the settled current fee separately from historical initial quotes (400-cent combined fee, 5-cent source refund, 9800-cent recipient transfer in one scenario). Team final-completion mode transferred nothing after the first accepted stage, then exactly5970/3980 cents after the last; ordinary history navigation passed. Changed original financial premises visibly block a stale amendment plan and permit a fresh unsigned plan.

Issued-unpaid goods cancellation now submits the current payment revision and terms digest through the shared durable monetary command. After a deliberately lost successful response, reload recovery used the identical path/body/key. Authoritative state showed cancelled, no active attempt, no received funds, and stock restored. The initial terminal screenshot was captured while loading. A later loaded capture exposed misleading disabled payment controls on the cancelled order; the UI now shows the quote/requirement as history and removes new initial-payment controls. A same-order continuation verified that repair. Own-account onboarding-link renewal after visiting the synthetic page created a new operation and link, while bank-payout capability remained unknown. Actual provider-link expiry was not tested.

Earlier focused browser flows covered personal funding/work acceptance, goods receipt-gated seller release, funded monetary amendment activation/old-new settlement, account-switch recovery, fee read errors/retry, and responsive layouts. These use local synthetic provider transport and local email; they do not prove actual Stripe, real university-email delivery or bank receipts. The latest visual retry encountered real local sign-in throttling; failures were retained and limits were not bypassed.

Additional visible synthetic checks verified unknown Checkout cancellation retains stock until the same operation resolves unpaid; late10000-cent payment after cancellation remains held with stock reserved and no seller transfer. A1-cent amendment against a50-cent minimum shows exact amounts and creates no quote/attempt. Engineering-final01 passed15 focused tests with512 source hashes unchanged during execution; later UI changes have a separate passing typecheck. Final build, natural-expiry browser branches, independent Spec+Quality review, fresh skill trial and initial-obligation replacement remain unfinished. This commit is a development snapshot, not a release. The original development checkout and evidence are preserved.

Private GitHub export is not a Polsia connection: the user-provided Polsia response states its chat cannot access or synchronize this private repository. No new sharing link, collaborator access, source deployment or production activation is included. See [current development status](docs/github-development-status.md) for accepted earlier boundaries.

## 已接通的主要流程

- 悬赏顶部 Apply、个人/团队申请、成员同意、邀请接受、退出及历史保留。
- Messages 统一查看有权访问的申请、协议和订单对话；可见页面约每三秒自动检查新消息，保留草稿、搜索和阅读位置。
- 申请阶段沟通：未同意成员可以先问问题；聊天不会自动变成同意或更改条款。
- 接受申请后进入准确的协作协议，旧申请聊天保留只读；消息不会自动复制。
- 消息历史、参与人、搜索、通知定位、草稿保留及未知发送状态恢复。
- 成果版本、要求修改、再次提交、验收和协作完成；完成不表示已付款。
- 校园资格、本地审核、团队管理、商品报价/订单及未付款取消。
- Workspace五类历史和Saved完整分页、准确旧收藏状态，以及手机收藏底部翻页。
- 发布后编辑、暂停和重新发布；申请人与冻结成员明确确认新版本，已有协议和订单保留原条款。
- 旧页返回恢复原卡片阅读位置，条款审阅关闭恢复焦点；配送方式变化后明确刷新报价。

最新入口和双向聊天实测见 [Apply 与消息修复](docs/apply-chat-fix-delivery.md)。自动接收采用轮询，未验收生产推送或大规模容量。

完整范围与未完成项目见 [交互清单](docs/interaction-completion.md)，本轮证据与限制见 [第十二轮交付](docs/interaction-round12-delivery.md)。

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

第十二轮已完成有边界本地验收及独立限定复审，五项最终修复全部确认解决。最终两份定向后端测试11/11、类型检查和隔离构建通过；修后工程页面操作与修前独立试用分别保留证据。构建中的SQLite实验性警告仍在。没有重新运行完整套件或进行生产验收。

本轮实际使用的验证命令：

```sh
node --test tests/backend/listing-lifecycle.test.mjs tests/backend/listing-index.test.mjs
npm run typecheck
CAMPUS_BUILD_DIR=.next-release CAMPUS_BACKEND=postgres CAMPUS_DEMO=0 npm run build
```

不要直接运行未过滤的完整后端套件。历史受限的强制撤权、暂停锁和原始业务插入诊断仅保留作证据，不应执行或换方式重建。历史测试执行偏差、失败记录和未取得视频证据均在交付说明中披露。其他测试应按具体修改范围选择，不能用历史总数声称当前全站通过。

浏览器测试需要 Playwright；环境未安装时用 `PLAYWRIGHT_MODULE` 指定现有模块路径。额外的 OpenAPI 语义检查使用 Python `jsonschema`：`python3 tests/conversation-openapi-schema.test.py`。数据库测试使用隔离本地测试库。

## 配置与资料

- [接口定义](docs/backend-openapi.json)
- [申请沟通合同](docs/evidence/interaction-round10/backend-contract.md)
- [源产品方案](docs/backend-source-plan.md)
- [术语说明](GLOSSARY.md)

仓库不包含本地数据库、会话、邮箱验证码、密钥、构建产物、代理工作目录或原始截图/运行日志。交付说明中指向这些本地证据的路径需在原工作区查阅。历史 Git 提交未上传；本仓库从经过检查的当前源码快照开始。原工作区和证据仍保留。

没有授予开源许可证；请仅按仓库所有者授予的权限使用。
