# AlphaDesk 对照报告：别人在做什么，我们差在哪

> 2026-09-19。参照物：Alpaca 官方博客的案例研究 *Building AlphaDesk: A Multi-Agent AI Trading System*（作者 Yuvraj Singh Hajari，VIT 计算机专业应届生），链接见 §9。关于 AlphaDesk 的每个事实都来自该文；文中没有的（业绩数字、成本、真实盘）就写"没有"，不猜。"我们"指 Kairos 工作台（`KairosPan/Evolving-Alpha-US`）和它的支付子模块 agentpay（本仓库）。

## 1. 一句话结论

AlphaDesk 是一条**每 5 分钟跑一次、把技术指标和新闻情绪塞进一次 LLM 调用、输出 BUY/SELL/HOLD、再往 Alpaca 模拟盘下市价单**的流水线，重点是"把系统跑起来"；它没有回测、没有业绩数字、没有成本模型，"多 agent"实际是一个进程里的五个顺序函数。Kairos 是一个**研究工作台**：agent 在有前视防护的 PIT 数据上做策略研究，人保留最终判断，下单能力双重门禁且从未启用。agentpay 解决的是 AlphaDesk 根本没碰的问题——**agent 自己花钱买数据和服务时，钱从哪来、谁批的、花了多少、链上对不对得上**。两者重叠的只有 Alpaca 模拟账户和"用 LLM 做决策"这层皮；真正的分水岭是：他们让 LLM 直接产出交易动作，我们让 LLM 产出可证伪的研究结论。

## 2. AlphaDesk 在做什么（按原文）

### 2.1 架构

LangGraph `StateGraph` 组成的确定性状态机，cron 每 5 分钟触发一次，五个节点顺序执行，共享一个 `TypedDict` 状态（`symbol, market_data, technical_signals, risk_approved, sentiment_context, decision`）：

| 节点 | 原文角色 | 做什么 | 输出 |
|---|---|---|---|
| Signal | "The Quant" | 从 Alpaca Market Data 拉 5 分钟 K 线（AAPL / NVDA / TSLA / MSFT / AMZN 五只），算 RSI、SMA、EMA、布林带 | 超卖、交叉等信号旗标 |
| Risk | "The Bouncer" | 查 Alpaca 模拟账户的购买力、持仓、回撤，套硬编码规则，**独立于 LLM 输出** | `risk_approved` 布尔 |
| Sentiment | "The Qualitative Engine" | 全天摄入财经新闻 → 向量化存 Pinecone → 查每只票 24 小时内的相关文章 → LLM 打 bullish / bearish / neutral | 情绪上下文字符串 |
| Decision | "The Brain" | 把技术信号、风控约束、情绪拼成 prompt，走 Groq 上的 Llama-3.3-70b（为了亚秒推理） | JSON `{action, quantity, rationale}` |
| Execution | — | 仅当 action ∈ {BUY, SELL} 且 `risk_approved` 为真：alpaca-py 提交 `MarketOrderRequest`（DAY）到 paper API，成交记入 TimescaleDB | 订单 id、成交价、数量、理由 |

周边：PostgreSQL + TimescaleDB 超表（`market_bars` / `trade_fills` / `agent_logs`），Redis pub/sub 广播节点完成事件，FastAPI 订阅后经 WebSocket 推给 Next.js 15 仪表盘（"Cognitive Console"，展示模型理由）。托管：Railway（后端）+ Vercel（前端）。

### 2.2 风控

- 硬规则在 Risk 节点，LLM 说什么都绕不过它：RSI 极端、板块风险预算用尽、持仓逻辑不成立（无持仓却要卖）都拦。
- 程序性约束：只下市价单（DAY）、固定 5 只票的宇宙、任何下单都要 `risk_approved`。原文强调 LLM 的决策是编排的输入，不是自主执行者。
- 计划中的：ATR / GARCH 动态波动率仓位。

### 2.3 结果与教训

- **没有任何量化业绩**：文中只有模拟输出截图（信号、情绪打分、一次 HOLD）和"风控按设计拦住了无效交易"的定性描述。Alpaca 的免责声明写明全部来自模拟盘，不反映真实交易；模拟不含市场冲击、流动性、滑点、延迟、监管限制。
- 部署占了大头：作者花了 48 小时调 Docker、数据库超时、Redis 掉线，重写了 SQLAlchemy 异步连接池；担心免费托管层扛不住 5 分钟一次的 cron。
- 作者自述"是 CS 学生，不是量化研究员，信号数学（RSI、均线）很初级"——基础设施扎实，alpha 模型刚起步。
- 后续计划：REST 轮询改 Alpaca WebSocket；找领域专家做更深的 alpha；波动率仓位；在更多市场环境下回测之后"再评估是否适合实盘"。
- 成本、预算、token 费用、agent 付费：**全文没有提**。行情来自 Alpaca 免费层，LLM 和向量库用 API key 直连。

## 3. 优点——值得承认的

1. **确定性风控独立于 LLM，且放在执行之前。** 这是正确的形状，和我们"签名前过策略闸"、"下单双重门禁"是同一种直觉。
2. **决策是结构化 JSON 且带 rationale，全部落库。** 每一次 HOLD / BUY 都能回看"为什么"，比多数 agent demo 的自由文本强。
3. **跑起来了。** cron → 数据 → 决策 → 模拟下单 → 仪表盘，闭环每 5 分钟真的在转。作为一个人的项目，端到端可运行本身是成果。
4. **观测面。** Redis → WebSocket → 仪表盘的实时轨迹，对调试 agent 行为有用。
5. **诚实的自我定位。** 作者明说信号初级、没回测、只是模拟；Alpaca 的免责把边界画清了。

## 4. 弱点——按重要性

1. **没有证据它有 alpha，也没有机制去证明。** 没有回测，没有前视防护，没有成本模型（市价单加 5 分钟频率，滑点和费用在真实盘里会吃掉 RSI / 均线这种级别的信号），没有预先登记的证伪条件。"看着它实时输出 HOLD 很满足"是系统在运转的证据，不是策略有效的证据。
2. **"多 agent"是命名，不是结构。** 五个节点是同一进程、同一状态字典里的顺序函数，只有 Decision（和 Sentiment 的打分）真的调 LLM；没有独立上下文、没有不同视角、没有分歧，就没有"多"能带来的东西。Quant / Bouncer / Brain 是比喻。
3. **LLM 站在交易动作的位置上。** 把指标和情绪拼成 prompt 让 70B 模型选 BUY / SELL，等于把不可解释、不可复现的判断放在管线最关键的一步，风控只能事后否决。这样的系统几乎无法回测（模型输出不确定，prompt 即策略），也就永远给不出第 1 条要的证据。
4. **新闻情绪没有时间纪律。** 全天摄入加 24 小时窗口检索，实时跑没问题；一旦想回测，新闻的可得时刻、修订、去重都是前视泄漏的入口，系统里没有任何护栏。
5. **基础设施对一个人太重。** Pinecone + TimescaleDB + Redis + FastAPI + Next.js + 两家托管，48 小时花在连接池和掉线上。作者自己列的教训里，运维远多于研究。
6. **钱是隐形的。** agent 的"预算"只有 Alpaca 模拟盘的购买力；它调用的每个外部服务（Groq、Pinecone、行情）都是 env 里的长期 API key，没有额度、没有账本、没有人批准过"这个 agent 可以花多少"。今天它们免费所以问题不显；一旦数据源按调用收费，这条管线没有任何位置放"付费"。
7. 细节：文中说拉 5 分钟 K 线，代码片段却用 `TimeFrame.Minute`；宇宙固定 5 只巨型股；REST 轮询。都是小事，但说明"跑通"排在"跑对"前面。

## 5. 我们是什么（对照所需的最小描述）

**Kairos**（`KairosPan/Evolving-Alpha-US`）：一个操作者、一台机器、一个主 agent（跑在 DeepSeek Harness 里，face 在 `127.0.0.1:3090`）。三层：MARKET（Alpaca + EDGAR + 两个离线 PIT 数据床，约 800 只票，前视防护写在代码里并被元测试钉住）、STRATEGY（`strategies/<name>/`：论点与证伪条件、可执行筛选、回测、日志、生命周期状态，git 是审计轨迹）、ACCOUNT（Alpaca 模拟账户，默认只读；下单代码存在但双重门禁，从未在真实 harness home 里启用）。五条诚实评估规则约束每次回测：只走 PIT 通道；退市按 −1 计入、不剔除；毛收益，加成本模型要在 THESIS 里声明；不做当日往返；缺数据丢弃并计数。bots 是操作者写的持续视角，在"房间"里由 Kairos 派发（并行或串行），"一个声音是证据，不是裁决"，每条操作者消息最多 3 轮、10 条 bot 消息。章程明写：不是自动交易系统，没有自治阶梯，没有东西无人值守地运行。一个策略已经按自己预先登记的证伪条件走到退役（2026-09-02；目录尚未提交）。

**agentpay**（`payment/` 子模块，本仓库）：Kairos 作为付款方的钱包。协议是 x402 V2 / `exact` / EIP-3009，实现用官方 `@x402/*` 包；我们加的是 **intent mandate**（人批一次：用途、上限、有效期、允许的 host）、签名前的策略闸和同步预留、JSONL 账本、按链时间的 `reconcile()`、给 agent 的 CLI + SKILL.md。每次付费调用一笔链上 USDC 结算；付款方只需持有 USDC，不需要 ETH。2026-09-19 在 Base Sepolia 实跑：串行每笔约 1 s，账本与链上分毫不差（README "Base Sepolia" 一节）。尚未接进 `face/`。

## 6. 逐项对比

| 维度 | AlphaDesk | Kairos + agentpay |
|---|---|---|
| 目标 | 自动产出模拟交易动作 | 研究结论加人的判断；不自动交易 |
| 循环 | cron 5 分钟，无人值守 | 操作者在场；日跑节奏在路线图里，未做 |
| "多 agent" | 一进程五函数，一次 LLM 决策 | 主 agent + 独立会话的 bots（各自人格、工具掩码、只读），派发—回收—Kairos 下结论 |
| LLM 的位置 | 输出 BUY / SELL / HOLD | 输出论点、筛选代码、回测、日志；动作要过人 |
| 风控 | Risk 节点硬规则，与 LLM 同进程 | 两道下单门禁（注册旗标 + 逐单审批卡）；旗标放在 agent 写不到的 harness home，第二道门的代码在工作区内，章程债务表里点名 |
| 数据纪律 | 实时拉取，无 PIT，无回测 | PIT 床 + 代码级前视防护 + 五条规则；AKShare 明标无防护 |
| 评估 | 无（截图） | 预登记证伪条件、回测 JSON（样本、命中率、最差、丢弃计数）；已有策略被证伪退役 |
| 新闻 / 情绪 | Pinecone 向量库 + LLM 打分 | 没有 |
| 成本模型 | 无 | 默认毛收益；加成本模型要声明 |
| agent 的钱 | 不存在（env 里的 API key） | intent mandate 预算 + USDC 每笔链上结算 + 账本对账 |
| 观测 | Redis → WebSocket 仪表盘 | face 里的轨迹、git diff、`/market` `/account` 两块只读仪表 |
| 基础设施 | 六个托管组件、两家云 | 一台机器、loopback、git 是账本和回滚 |
| 执行 | Alpaca paper 市价单 | Alpaca paper，门禁从未启用 |
| 成熟度 | 端到端已跑通 | 研究环闭合；前向测试、支付接入、日跑都还没做 |

## 7. 差在哪——本质上的四条

**7.1 他们在做"决策自动化"，我们在做"研究诚实"。** AlphaDesk 的整条管线是为了让机器替人按按钮；Kairos 的每条规则（PIT 防护、证伪条件、退市计损、人是稳态）都是为了让结论经得起追问。这不是谁更先进，是两个问题。但对"有没有 alpha"这个所有交易系统最终都要回答的问题，他们的架构给不出答案，我们的架构至少能说出"这个策略被自己的条件证伪了"。

**7.2 LLM 站的位置不同。** 他们把 LLM 放在动作输出端，风控只能否决；我们把 LLM 放在研究端，动作端是确定性门禁和人。前者一旦上真钱，每一笔都在赌模型；后者的代价是慢——章程自己承认"操作者的注意力是系统的限速器"。

**7.3 "多 agent"的含义不同。** 他们的多 agent 是把一个函数拆成五个；我们的 bots 是为了制造**分歧**——并行先答、串行互看、Kairos 点名分歧再下结论，并且有轮次上限防止讨论无限膨胀。分歧是多 agent 唯一能带来的新东西，他们的结构里没有。

**7.4 钱：他们没有这一层，我们有，而且是我们最不一样的地方。** AlphaDesk 里 agent 消耗的所有外部资源都靠长期密钥、免费额度和作者的信用卡，没有任何一处能回答"这个 agent 今天花了多少、谁批的、能不能对账"。agentpay 把这件事做成协议：人批一张 mandate，agent 在里面按调用付 USDC，链上一笔一结，账本按链时间对账；预算拒绝发生在签名之前。今天这还只是一条能力（示例 payee 是我们自己的），但当数据源和模型服务开始按 x402 收费——x402 生态的托管 facilitator 已经在跑，我们今天在 Base Sepolia 上用的就是——这是 AlphaDesk 类系统必须补、而我们已经有的那块。

## 8. 他们领先的地方，以及我们该拿什么

诚实地说，有三处他们在前面：

- **系统在无人值守地转。** 我们的日跑节奏（路线图第 2 项）和模拟前向测试（第 3 项）都标着 deferred。
- **新闻 / 情绪是一路输入。** Kairos 只有 EDGAR 和行情，没有新闻管线。
- **agent 的每次决策都有结构化记录**（action、quantity、rationale 落 TimescaleDB）。我们的 journal 和轨迹是自由文本加 git。

建议（不改章程的前提下）：

1. **不学的**：LLM 出交易动作；六件套托管基础设施；Pinecone。章程 §7.3 已经把"无托管 face、无额外记忆存储"写死，AlphaDesk 恰好是那 48 小时的反面教材。
2. **可学的**：(a) 把 dsh schedule 的日跑做起来，但输出是研究工件不是订单；(b) 如果加新闻源，第一天就带时间戳纪律——新闻的"可得时刻"进 PIT 床，回测只能看当日之前的，否则就是 AlphaDesk 那种回测不了的情绪；(c) 策略日志里给"决策记录"一个结构化最小集（日期、信号、结论、依据、下一步），沿用 `status.yaml` 里 `one_line / next / numbers` 的做法就够。
3. **发挥我们有的**：agentpay 接进 face 的第一个真实 payee 应该就是一个按调用收费的数据源（新闻或另类数据），这样"agent 花钱买输入"在 Kairos 里第一次有了实物；`docs/design/kairos-intro.html` 里那些 pay 卡片正是这个形状（还画着 AEP2，要按 x402 重画）。

## 9. 来源

- Alpaca Learn, *Building AlphaDesk: A Multi-Agent AI Trading System — Case Study*, https://alpaca.markets/learn/building-alphadesk-a-multi-agent-ai-trading-system-case-study （2026-09-19 读取）
- 本仓库：`README.md`、`docs/technical-report.md`
- Kairos：`Kairos-Design.md` §1–§3、§7.3、§8；`AGENTS.md`；`docs/backtest-rules.md`；`CLAUDE.md`；`ROADMAP.md`
