# Kiro 到底算不算 prompt caching？—— 四层答案、一份 credit 计费公式，以及一个伪造的 thinking 通道

调研日期：2026-08-12。方法：官方文档与社区实现交叉验证 + 经自建网关的受控实验 + 直连上游对照实验。

---

## 结论摘要

「Kiro 是不是完全不计算 prompt caching」这个问题里藏着四个层次，答案不统一。**前三层「完全不算」成立，第四层不成立。**

| # | 层次 | 答案 | 状态 |
|---|---|---|---|
| 1 | 客户端能否声明缓存（`cache_control`） | **不能**，被网关剥离，上游协议无处表达 | 已验证（代码级） |
| 2 | 响应是否回传 cache token 计数 | **从不**，字段在 schema 里但恒空 | 已验证（三方独立实测） |
| 3 | 计费层是否有 token 或 cache 项 | **没有**，纯 credit，官方明说「按请求不按 token」 | 已验证（官方原文） |
| 4 | credit 数额本身是否体现缓存节省 | **体现了**，逐字节重复约打 53% 折 | 已验证（受控实验） |

一句话：Kiro 对用户**完全不暴露、不上报、不让你控制** prompt caching，但它的 credit 计量**并非对重复内容无感**。所以「完全不算」对于可观测性和可控性是对的，对于实际扣费是错的。

---

## 一、请求侧：缓存意图在网关就被丢掉

以 jwadow/kiro-gateway 这类 Anthropic→Kiro 转换网关为例，`kiro/converters_anthropic.py:90` 的注释原文就是：

> We extract only the text, ignoring cache_control (not supported by Kiro).

更彻底的是最终上行 payload 的字段全集（`kiro/converters_core.py:1630`）：

```
conversationState {
  chatTriggerType, conversationId,
  currentMessage.userInputMessage { content, modelId, origin, images, userInputMessageContext { tools, toolResults } },
  history[...]
}
profileArn
```

没有 `cachePoint`、没有 `cache_control`、没有任何缓存断点标记。system prompt 只是纯文本拼进首条 `userInputMessage`。**即便网关不剥离，也无处安放。**

顺带一个值得注意的字段顺序问题：序列化后的字节偏移是 `conversationId`=52、`currentMessage`=89、`history`=212。也就是易变的 `currentMessage` 排在稳定的 `history` **之前** —— 这是对前缀缓存最不友好的布局。

## 二、响应侧：字段存在，但永远是空的

一个值得区分的细节：**不是没有字段，是字段从来不填。**

独立 Go 实现 [d-kuro/kirocc](https://github.com/d-kuro/kirocc) 完整枚举了 `metadataEvent.tokenUsage{uncachedInputTokens, outputTokens, totalTokens, cacheReadInputTokens, cacheWriteInputTokens}` —— 协议层确实声明了缓存计数。但该项目的 usage 解析优先级最终落到估算，说明 metadata 帧实测拿不到。

三份独立实测一致：

- 本机网关累计 1,100 次请求，`cache_read_input_tokens=0`、`cache_creation_input_tokens=0`、命中率 0.0
- [opencodex](https://github.com/lidge-jun/opencodex) 的 devlog 分析 5,691 条 usage 行，缓存字段命中 0 条，并排除了「字段改名」的替代假设
- 网关维护者提交 `742d9ac`：「Verified against the live Kiro endpoint: it does NOT return prompt-cache fields」

能从上游挖到的 `meteringEvent` 原始形态只有：

```json
{"unit":"credit","unitPlural":"credits","usage":6.700177922321725,"usedTools":["grep_search"]}
```

只有 credit 标量和工具名，没有任何 token 明细。注意它以 `{"unit":` 开头而非 `{"usage":` —— 早期网关的事件正则只匹配后者，导致 metering 帧被全部丢弃。

连带一个后果：**网关报给你的 `input_tokens` 是反推的估算值**，不是上游真值（`kiro/streaming_core.py:354` 用 `context_usage_percentage × max_input` 倒算）。同一 payload 两次会有 ±1 抖动，别拿它做精确对账。

## 三、计费层：官方明确「按请求不按 token」

[Kiro 官方账单文档](https://kiro.dev/docs/billing/related-questions/) 原文：

> Kiro is engineered to minimize redundant LLM work. Kiro reuses context where possible and applies provider-level efficiencies, such as token-efficient tool use and prompt caching when available, to cut underlying token spend without adding friction to your workflow. **You pay by request, not by token**, and efficiency gains are passed through Kiro's pricing plan design rather than asking you to micromanage prompts.

这段话是整件事的钥匙：官方**承认服务端在用 prompt caching**，同时明确表示收益走定价设计消化，不做成用户可见的折扣项。

配套证据：[FAQ](https://kiro.dev/faq/) 定义 credit 为「a unit of work in response to user prompts」，计量到小数点后两位；企业用量报告 CSV 只有 `Credits_Used`、`Total_Messages`、分模型 message 数，**没有任何 token 列**。

## 四、实测反例：credit 确实对重复内容打折

这一层推翻了我最初的结论。以下全部经自建网关、`claude-sonnet-5`、小 `max_tokens`。

### 实验 A：A/B/A/B 对照（关键控制组，完全不带 `cache_control`）

约 4,000 token 的稳定前缀，A 与 B 内容不同：

| 序 | 内容 | credits | 相对首次 |
|---|---|---|---|
| A1 | A 首发 | 0.1314 | 100% |
| A2 | A 逐字节重复 | 0.0711 | 54% |
| B1 | 换成 B（A 已「热」） | 0.1323 | **回到全价** |
| A3 | 回到 A | 0.0741 | 56% |
| B2 | B 第二次 | 0.0959 | 73% |

B1 在 A 已经热过之后回到全价，**排除了连接预热、账户预热这类解释**：折扣跟内容绑定。

八组独立实验里这个模式稳定复现，比值分别是 53.0 / 54.1 / 57.9 / 54.5 / 52.8 / 53.6 / 53.9 / 53.6%，收敛在 **53–54%**。而且重复值会**精确相同**（如 0.0614/0.0614），说明是确定性计算而非噪声。

### 实验 B：这不是前缀缓存

同一前缀换问题：

| 序 | 内容 | credits |
|---|---|---|
| 1 | 前缀 P + 问题 q1（首发） | 0.0897 |
| 2 | P + q1 逐字节重复 | 0.0519 |
| 3 | **同前缀 P** + 新问题 q2 | 0.1165（全价） |
| 4 | **同前缀 P** + 新问题 q3 | 0.1785（更贵） |

若是标准前缀缓存，共享的 4,000 token 前缀应命中、只有短后缀全价，第 3、4 行该显著便宜。**它们没有。** 加上实验 A 的 B1（换前缀、问题相同 → 全价），可判定：折扣要求**整个 payload 近乎逐字节一致**，共享前缀或共享后缀单独都不触发。

这也意味着折扣是**扁平的约 47% off**，而非按 token 比例的缓存节省。

### 实验 C：尺度无关

42k input token / 507KB 的大 payload 同样命中：1.410388 → 0.744678 = 52.8%。早期「小尺度结论不能外推到大会话」的限定因此撤销。

### 实验 D：conversationId 与折扣无关

网关每个请求都发**全新随机 UUID** 作为 `conversationId`，折扣照样命中。为了排除「随机 ID 只是没有*完全*阻断折扣、但稳定化能*加深*折扣」这种可能，我直连上游做了固定 ID 对照：热内容 + 随机 ID 得到 `0.048117`，与固定 ID **六位小数完全一致**。

结论：**稳定化 conversationId 换不来任何收益。** 网关里 `generate_conversation_id()` 的随机行为是有意为之（源码注释写明 `random UUID, not used for tracking`），不是 bug。

真正的死代码在别处：`kiro/streaming_anthropic.py` 与 `streaming_openai.py` 都声明了 `conversation_id: Optional[str] = None`，docstring 写「Stable conversation ID for truncation recovery」，但**函数体内一次都没引用**，routes 也从不传。当初规划了稳定 ID 方案但没接线。

### 实验 E：history[] 位置也无关

大内容放在 `currentMessage` 还是被推进 `history[]`，折扣一致（53.6% vs 53.9%）。我此前推测「history 每轮重排会击穿折扣」，**已被自己的数据证伪**。

---

## credit 计费公式

综合实测斜率，得到：

```
credits ≈ M × E × D × (input_tokens + 15 × output_tokens) / 63,000
```

- **M** 模型倍率：Opus 5 = 2.2，Sonnet 5 = 1.3，Auto/Terra = 1.0，Sol = 2.4，Luna = 0.1，开源权重模型 0.05–0.5
- **E** effort 系数：默认 1.0，medium 约 1.35
- **D** 折扣：正常 1.0，逐字节重复 0.53

等价说法：1 credit 约等于 1.0× 下的 63,000 input token；Sonnet 5 约 48,000，Opus 5 约 29,000。output 权重约为 input 的 15 倍。

实测每 input token 的 credit 消耗：**opus-5 ≈ 3.48e-5，sonnet-5 ≈ 2.08e-5**。两者比值 1.67，与官方倍率比 2.2/1.3 = 1.69 独立吻合 —— 这是公式可信度的一个侧面印证。

---

## 后续验证：官方 multiplier 表与第三方量级印证（2026-08-16）

本文发表后补了一轮网络验证，结论：**M 倍率从「实测反推」升级为「官方公开数据」；`63,000` 这个绝对换算仍无官方口径，但有第三方量级印证。**

### 一、模型倍率是官方公开数据

[官方 models 文档](https://kiro.dev/docs/models/) 给出完整 credit multiplier 表（相对 Auto 1.0x），逐项对照本文的 M 倍率全部命中：

| 模型 | 官方 multiplier | 本文 M | 结论 |
|---|---:|---:|:--:|
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | 2.2x | 2.2 | 一致 |
| Claude Sonnet 5 / 4.6 / 4.5 / 4.0 | 1.3x | 1.3 | 一致 |
| GPT-5.6 Sol | 2.4x | 2.4 | 一致 |
| GPT-5.6 Terra | 1.0x | 1.0 | 一致 |
| GPT-5.6 Luna | 0.1x | 0.1 | 一致 |
| Auto | 1.0x | 1.0 | 一致 |
| Haiku 4.5 / DeepSeek 3.2 / GLM-5 / MiniMax M2.5 / M2.1 / Qwen3 | 0.4 / 0.25 / 0.5 / 0.25 / 0.15 / 0.05 | 0.05–0.5 | 一致 |

官方 [GPT-5.6 降价公告](https://kiro.dev/blog/gpt-5-6-pricing/)（2026-07-31）与 [classmethod 实测](https://dev.classmethod.jp/en/articles/kiro-gpt56-terra-luna-credit-price-cut/) 独立确认 Terra 1.2x→1.0x、Luna 0.6x→0.1x。

所以本文的 opus-5=2.2 / sonnet-5=1.3 / Sol=2.4 / Terra=1.0 / Luna=0.1 全部是官方数字，不是反推值。**反推的只有 `63,000` 这个分母。**

### 二、官方故意不公布绝对换算

官方 models 文档明确 credit 是「相对 Auto 1.0x」的相对量，并注明「实际消耗取决于模型生成的 token 数、thinking 深度、tokenizer 差异」。全站没有「1 credit = N token」的官方口径——与本文「按请求不按 token」一致。

### 三、第三方量级印证 63,000

[jishuzhan 实测](https://jishuzhan.net/article/2037135241685565442)：同一任务用 Opus 4.6，Claude Code（官方 API）花 **$0.51**，Kiro 花 **4.18 credits**。反推 4.18 × 63,000/2.2 ≈ 12 万 input token，与 $0.51 ÷ $5/M ≈ 10 万 token 量级吻合（差约 17%）。

反面证据被证伪：某「1 credit ≈ 100–500 token」的博客其套餐价格全错（Power 写成 $99/5000，官方是 $200/10000），弃用。AWS 官方 [agent-cost-bench](https://github.com/aws-samples/sample-agent-cost-bench) 也侧面印证：Kiro 的成本只读 `Credits: X` telemetry 行按 `usd_per_credit` 折算，没有 token 输出。

### 四、修正后的「$200 能跑多少 token」

| 模型 | 10,000 credits 等价 input token |
|---|---:|
| Opus 5（2.2x）| ≈ 2.86 亿 |
| Sonnet 5（1.3x）| ≈ 4.85 亿 |
| GPT-5.6 Sol（2.4x）| ≈ 2.63 亿 |

诚实边界不变：这仍是「纯 input 等价量」的反推，官方只承诺 $200 = 10,000 credits。真实 agent 会话按 89.1% 缓存 / 9.9% 输入 / 1% 输出的综合口径折算约 2.5 亿综合 token（Opus 5）。

---

## 与官方 API 定价比较

Kiro 各档位价格：FREE $0 / 50 credits，PRO $20 / 1,000，PRO+ $40 / 2,000，PRO MAX $100 / 5,000，POWER $200 / 10,000。**所有档位都是计划内 $0.02/credit**，超额加购统一 **$0.04/credit**（是计划内的 2 倍，未用完的加购 credit 12 个月后过期）。

官方 Anthropic API：Opus 5 $5.00 / $25.00 每百万 token，Sonnet 5 $3.00 / $15.00（引入期 $2.00 / $10.00，至 2026-08-31）。

把实测 credit/token 乘上 credit 单价即可对齐：

| | Kiro 计划内 $0.02 | Kiro 超额 $0.04 | 官方原价 |
|---|---|---|---|
| Opus 5 input | $0.70 /M | $1.39 /M | $5.00 /M |
| Opus 5 output | $10.44 /M | $20.88 /M | $25.00 /M |
| Sonnet 5 input | $0.42 /M | $0.83 /M | $3.00 /M |
| Sonnet 5 output | $6.24 /M | $12.48 /M | $15.00 /M |

**输入侧省约 86%，输出侧只省约 58%。** 原因是两套定价对 output 的加权不同：官方是 input 的 5 倍，Kiro 实测约 15 倍。一旦用超额加购，output 那头只剩 16% 折扣，几乎等于原价。

换个说法：10,000 credits/月 按 Opus 5 约等于 **2.87 亿 input token**，官方原价买同样的量要 $1,435，而计划价是 $200。

### 但这个比较有个大前提

上表比的是**官方原价、不开缓存**。真实 agent 会话不会这么用 —— 官方 API 的 prompt caching 是能用的，缓存读只要 0.1× input 价，缓存写 1.25×（5 分钟 TTL）或 2×（1 小时）。

按一次真实会话的形状估算（见下节，95.5% 的 input 是上一轮已发过的内容）：

```
95.5% × $0.50（缓存读）+ 4.5% × $6.25（缓存写）≈ $0.76 每百万 input token
```

而 Kiro 计划内是 $0.70。**基本持平，Kiro 只便宜 8%。** 如果用超额加购的 $1.39，反而比官方开缓存**贵 80%**。

整场会话对账（32 轮，累计 2,297,317 input token）：

- Kiro 实际消耗：约 80–110 credits ≈ **$1.6–2.2**
- 官方 + 正常缓存：约 **$1.74**
- 官方原价无缓存：约 **$11.5**

**Kiro 的便宜几乎全部来自「按次不按 token」把重复输入的钱吃掉了 —— 而这正是官方 prompt caching 干的同一件事。** 谁的缓存能命中，谁就便宜。

---

## thinking：一个伪造的推理通道

这是调研里最意外的结构性发现。

**网关不向上游传任何 thinking 参数。** 它往你的输入里注入一段提示词，让模型自己用 `<thinking>...</thinking>` 包住推理，再把这段文本从输出流里解析出来、伪装成 `thinking` 块返回给客户端（`FAKE_REASONING_HANDLING=as_reasoning_content`，默认开启，见 `kiro/config.py:474`）。

注入的内容形如：

```
<thinking_mode>enabled</thinking_mode>
<max_thinking_length>10000</max_thinking_length>
<thinking_instruction>Think in English for better reasoning quality...</thinking_instruction>
```

所以对上游 Kiro 来说，**thinking 就是普通输出文本，无法区分**，按 output 计费。两侧都按 output 计价，于是 thinking 的折扣和普通 output 完全一致：

| | Kiro 计划内 | Kiro 超额 | 官方原价 |
|---|---|---|---|
| Opus 5 thinking | $10.44 /M | $20.88 /M | $25.00 /M |
| Sonnet 5 thinking | $6.24 /M | $12.48 /M | $15.00 /M |

但有三处结构性差异，其中一处能反转结论：

**一、thinking 预算不可强制执行。** 官方 `budget_tokens` / `adaptive` 是采样器层面的硬上限；这里的 `max_thinking_length` 只是一句写在提示词里的**建议**。模型想写多少写多少，你照单付钱。

量化后果：10.44/25 = 0.42，**盈亏平衡点在 2.4×** —— 伪 thinking 只要比原生 adaptive 多写 2.4 倍 token，58% 的优势就归零。而注入的 instruction 恰恰在鼓励多想（「consider multiple approaches」「challenge your initial assumptions」「Take the time you need」）。缓解因素是 `FAKE_REASONING_BUDGET_CAP` 默认 10,000 在生效，比官方 adaptive 能放到的量小得多 —— 但**要求不等于约束**。

**二、历史 thinking 两侧都不重复计费（这一点持平）。** 我原以为这里有差异，查代码不是：`extract_text_from_content` 只保留 `type == "text"` 的块（`kiro/converters_anthropic.py:68`），客户端回传的 thinking 块在进上游前就被丢掉；官方 API 同样剥离往轮 thinking 不计入 input。

**三、注入开销可忽略。** 每请求多约 400 个 input token，折合 0.014 credit。32 轮累计不到 0.5 credit。

还有一处无法量化：伪 thinking 是模型在输出通道里「扮演」思考，不是训练进去的推理机制，每 token 的实际效用大概率低于原生 extended thinking。这会让「每单位有效推理的成本」比上表更差，但差多少无从测量。

---

## 为什么真实会话永远吃不到那个折扣

实测一次真实 agent 会话：32 个不同轮次，input 从 43,729 涨到 103,766 token，**31 次增长转移，0 次相同**，`cache_read` 全程为 0。而其中 95.5% 的 input 是上一轮已经发过的内容。

折扣要求整个 payload 逐字节一致，而 agent 会话每轮都在追加内容 —— **payload 从不重复，所以折扣从不命中**。这不是网关的缺陷，网关侧也没有任何改法能救（稳定 conversationId 无效、调整 history 位置无效）。想省下那 95% 的重复输入，只能指望上游提供真正的前缀缓存。

---

## 我在这次调研里犯的错（修正记录）

留着，因为每一条都指向一类容易踩的坑：

1. **最初结论过强。** 仅凭「`cache_control` 被剥离 + cache 字段全 0」就断言缓存在计费上毫无体现。实测推翻 —— 可观测性为零不等于计费无感。
2. **「大 payload 不发 meteringEvent」是错的。** 五次大请求返回 `credits=None`，我据此以为 payload 尺寸会抑制 metering。真因是上游**偶发**返回空流（`stream ended without completion signals, length=1 chars`），与尺寸无关。
3. **把 `generate_conversation_id()` 的随机行为当成 bug。** 源码注释明写是有意为之。
4. **推测「history 每轮重排击穿折扣」。** 被自己的对照实验证伪。
5. **transcript 统计重复计数。** 朴素遍历得 93 条 usage / 6,692,330 token；按 `message.id` 去重后是 32 轮 / 2,297,317。

**实验方法的两条硬教训：**

- **必须校验 `stop_reason` 与回复正文。** 只看 `credits_used` 会被上游偶发空流坑到 —— 此时 credits 为 None、正文为空，极易误判成机制性差异。脚本要带校验 + 重试。
- **别把网关报的 `input_tokens` 当真值。** 它是反推估算。

---

## 误差声明与未验证项

**误差传导：** output 的 15× 系数只有 3 个数据点，实际区间 9–16×，直接传导到所有 output / thinking 行 —— 按 9× 算折扣是 75%，按 16× 算是 55%。所以**输出侧折扣应读作 55–75%，58% 只是中值**。effort 系数 E≈1.35 是粗略比值。`meteringEvent` 报 6 位小数而计费按 2 位舍入、最低 0.01。上述百分比当量级看，别当精确账。

**未验证：**

1. **机制未证实。** 只能说 credit 对逐字节重复打折，无法证明机制就是 prompt caching（也可能是响应缓存或请求去重）。
2. **伪 thinking 的实际 token 量未实测。** 2.4× 盈亏平衡点是算出来的阈值，不是实测比值。要判断实际是赚是亏，需要固定输入、对比同一问题在伪 thinking 与原生 adaptive 下各写多少 token。
3. **配额扣减关系未精确对账。** 订阅配额确实会动（会话期间观察到 used 从 7448.8 涨到 7598.4），但跨重置周期的精确对账没做。
4. **单模型为主。** 折扣在 sonnet-5 与 opus-5 均验证，但 Auto 模式、Kiro IDE 第一方通道未测。
5. **上游是否曾返回过缓存计数。** 「`tokenUsage` 帧恒空」是当前观测窗口的结论，不排除特定账号类型、区域或后续版本会填充。

---

## 主要来源

官方：[账单相关问答](https://kiro.dev/docs/billing/related-questions/)、[FAQ](https://kiro.dev/faq/)、[定价](https://kiro.dev/pricing/)、[Auto 与 credit blog](https://kiro.dev/blog/making-credits-go-further/)

社区实现：[d-kuro/kirocc](https://github.com/d-kuro/kirocc)（协议枚举）、[opencodex](https://github.com/lidge-jun/opencodex)（5,691 行 usage 实测）、[TsinHzl/kiro2cc-proxy](https://github.com/TsinHzl/kiro2cc-proxy)（独立提出「缓存命中按全价 50% 计费」，与本文实测量级吻合，但其方法非受控实验）、[jwadow/kiro-gateway](https://github.com/jwadow/kiro-gateway)（本文代码引用的网关）
