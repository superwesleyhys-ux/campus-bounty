# Campus Bounty · 美国大学悬赏令

私有开发仓库。面向高校社区的任务申请、团队协作、履约及商品交易应用，英文界面。

这是当前开发源码的可复现快照。真实付款、外部邮件及完整生产验收尚未完成；本地模拟数据不代表真实交易。

## Current development checkpoint

This repository now includes in-progress transaction and agreement-change work. Read [current development status](docs/github-development-status.md) before using it. A sync commit is not a release or deployment; real login, payments and final acceptance remain incomplete. Historical verification sections below refer only to their named increments.

### Latest backend checkpoint — 2026-10-18

The scoped Astra High amendment-money fix1 re-review returned **Spec PASS / Quality PASS**: all three Important findings were addressed, with no new finding. Root accepted this bounded backend/API increment. Final16 focused tests, typecheck and isolated build passed on the same477-file source snapshot; the original failing counterexamples and previous46-test evidence remain separately attributed.

Task2C remains in progress. Preparation17 passed six focused synthetic service cases, including original unknown Checkout recovery across a material configuration refresh with the same attempt/operation and exactly one hosted session. Lifecycle02 passed four cases covering both release choices, exact team totals, goods receipt gating, nonmonetary changes and review holds. No-webhook reconciliation01 passed after the normal scheduled 30-second delay (no clock repair); goods-recovery01 passed unpaid cancellation release and late/unknown payment stock holds. These are historical focused runs, not a final source-bound suite.

Account03 used ordinary local email authentication: a lost recipient-onboarding response survived logout and another account login; only the original actor could recover it, using the identical request path/body/key and operation. This does not prove bounty eligibility or external email delivery. Amendment05 reached exact separate original9950 + added950 =10900-cent synthetic settlement, including old work submitted before amendment activation; it then failed the final screenshot selector. Amendment07 separately reauthenticated those same actors and viewed the historical amendment via its explicit URL, submitted a refund-review request (not_executed) and opened a dispute (pending). Failed runs remain preserved; direct URL history visibility is not proof of ordinary history-control discoverability.

Fee04 now reaches visible all-person fee reconfirmation, explicit150-cent supplement and settled400-cent combined actual fee through synthetic transport. The missing payer controls were repaired by deriving payer identity independently from the agreement publisher/order buyer; expanded fee-panel state now survives refresh and read errors have a retry display. A remaining current-status issue is under repair: old initial-policy/quote blockers and reserve wording can remain after a current settled fee revision. Do not treat the fee journey as fully accepted.

Team02 shows visible three-person fee confirmation, a nonmonetary amendment retaining the original payment, zero transfers after the first accepted stage under final-completion release, and exact5970/3980-cent member transfers after the final stage. Team/application/allocation setup used authenticated HTTP. The script subsequently failed a history-control selector; history discoverability remains pending. Lifecycle03 separately passed five service cases including a1-cent shortfall below a50-cent minimum, with no invented charge. These evolving-source results are not final review or an independent skill trial.

Browser12 used fresh local-email identities and synthetic hosted onboarding, visible bounty/application/financial confirmation/payment/work submission and acceptance. A deliberately lost payment response was recovered across reload and a second tab with the original path/body/key/attempt. Local signed synthetic callbacks yielded10055-cent funding,100-cent processing fee,5-cent payer restitution and9950-cent recipient transfer after work acceptance. Allocation/invitation setup still used ordinary authenticated HTTP routes. A missing transaction-terms binding in the acceptance UI was repaired after browser11 returned409. Browser-goods01 separately completed visible product/reservation/consents/payment/pickup/buyer-receipt and9950-cent seller transfer; pickup alone transferred0. These are synthetic local flows, not actual Stripe/bank acceptance.

Browser12 recorded one header/payment heading at320/390/768/1024/1440 widths; root inspected1440/390 viewport images without the repetition in an earlier full-page capture. Automated main-content WCAG checks found0violations; this is not full accessibility/manual trial. Final typecheck/build, independent Task2C review and full skill trial remain pending. Initial quoted-payment recovery after material configuration changes remains an explicit unresolved requirement; a blocked screen is not completion.

Private GitHub export is not a Polsia connection: the user-provided Polsia response explicitly states its chat cannot access or synchronize this repository. Keep it private. Real external email/provider integration, bank payout and production deployment remain unfinished. No source has been deployed. See [current development status](docs/github-development-status.md) for the accepted backend boundary.

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
