# AWS API Gateway IP 分配机制调研报告

> **生成日期**：2026-08-08 · **调研方式**：18 个只读 Agent（6 路并发检索 + 10 个对抗性验证 + 1 个完整性批判 + 1 个专项补查），统计经 python/node 双独立复核 · **数据快照**：ip-ranges.json（syncToken 1786081625，2026-08-07，仅 IPv4）· **面向**：需要给 API Gateway 做 IP 白名单 / 防火墙策略的 AWS 用户

> **取证边界**：每条关键发现经 ≥2 个不同视角的独立反驳验证后才采信；可信度分三级：
>
> - **【官方】** = AWS 官方文档 / 官方知识库原文（逐字核对）
> - **【多源】** = 多个独立来源互证，或本地数据多套独立复核
> - **【存疑】** = 官方文档空白或单一来源，未能完全核实

---

## 一、最核心结论：三个问题一次说清

| 问题 | 结论 | 可信度 |
|---|---|---|
| **官方会限制单个 API Gateway 只用哪些 IP 吗？** | **不会**。没有「专属分配」这回事：同一区域所有 API Gateway 共享该区域的出口 IP 池，官方从未承诺按 API / 按账号划分固定子集，反向检索零命中任何此类来源 | 【多源】官方口径 + 专家答案 + 反向检索 |
| **92,320 个 IP 是随机用吗？** | **不是随机，是区域共享池内动态轮换**。且这 214 条前缀官方标注 **"egress only"**——只是 API Gateway 调你公网后端时的**源 IP 池**，不是客户端访问 API 时看到的入站 IP。轮换粒度（每请求/每连接）是官方文档空白 | 【官方】egress-only 与 frequently change 均逐字核实；粒度【存疑】 |
| **IP 是怎么分配的？** | 从 `AMAZON` 大块中**按区域切出小前缀**（/21~/27）叠加 `API_GATEWAY` 标签写进 ip-ranges.json；214/214 条全部嵌套在**同区域 EC2 前缀**内；变更经 SNS 推送，可订阅自动同步防火墙 | 【多源】本地三独立复核 + 官方文档 |

一句话：**官方不限制单个网关用哪些 IP（区域共享池）；92,320 个 IP 在区域池内动态轮换、且只用于出站方向；分配上是从 AMAZON 大段按区域切小块、打服务标签、写进 ip-ranges.json 并持续通告变更。**

---

## 二、这 92,320 个 IP 到底是什么

### 1. 关键前提：API_GATEWAY 标签 = 仅出站【官方】

官方 [ip-ranges.json 语法文档](https://docs.aws.amazon.com/vpc/latest/userguide/aws-ip-syntax.html) 逐字写道："The addresses listed for `API_GATEWAY` are egress only."

官方知识库 [api-gateway-manage-ip-changes](https://repost.aws/knowledge-center/api-gateway-manage-ip-changes) 进一步逐字说明："The published API Gateway IP address ranges are only for outbound traffic, and they frequently change." 以及 "For Regional endpoints and HTTP APIs, API_GATEWAY is only an outbound IP address. For inbound IP addresses, use AMAZON or EC2."

含义拆解：

* **出站方向**（API Gateway → 你的公网 HTTP 后端）：后端看到的源 IP 来自该区域的 API_GATEWAY 前缀，这才是这 214 条前缀的用途。
* **入站方向**（客户端 → API Gateway）：不要用 API_GATEWAY 列表过滤；区域型端点用 `AMAZON`/`EC2` 列表，边缘优化型用 `CLOUDFRONT` 列表【官方】。

该标签 2019-09-26 才加入官方清单，此前社区只能靠 EC2 段猜。

### 2. 清单本体【多源，python/node 双独立复核】

* 214 条 IPv4 前缀、92,320 个地址；IPv6 中 **0 条**；214 条之间无重复、两两不重叠。
* 覆盖 **39 个区域**，无任何 GLOBAL 前缀。
* 掩码分布：/21×2、/22×26、/23×77、/24×70、/25×28、/26×10、/27×1——以 /23、/24 小块为主。
* 池子大小与区域体量正相关：us-east-1 最大（16 条 / 13,312 地址），其后 us-west-2（14 条）、eu-west-1（13 条）；新区域 / 小区域只给 1 条 /24，后续按需追加——「按需分配、只增不减」的直接证据。

---

## 三、IP 是怎么分配的

1. **分层结构**【官方】：ip-ranges.json 顶层含 `syncToken`（版本戳）、`createDate`，每条前缀带 `ip_prefix`、`region`、`service`。
2. **AMAZON 是超集**【多源】：`service=AMAZON` 是 AWS 全部公网 IP 的母集；服务专属段是从大块中**切出子前缀、叠加单一服务标签**。官方明言 "AWS may advertise a prefix in more specific ranges"。实测 214/214 条全部 ⊂ AMAZON 超集。
3. **嵌套在区域 EC2 前缀内**【多源】：214/214 条全部落在**同区域** `EC2` 前缀之内——出口基础设施直接复用各区域 EC2 网络资源，不是独立的全球地址池。
4. **发布与订阅**【官方】：变更通过固定 SNS 主题通知（常年固定 us-east-1）：`arn:aws:sns:us-east-1:806199016981:AmazonIpSpaceChanged`，订阅后可用 Lambda 自动刷新防火墙规则。
5. **历史演变**【多源】：2019-09-26 官方发布标签 → 最早可观测快照 2019-10-28 为 31 条 → 2026-08 共 214 条，**前缀级零删除、纯追加**。变更节奏：2026-08 实测每日 1~11 次（以 syncToken 变化计）；第三方追踪仓库 [seligman/aws-ip-ranges](https://github.com/seligman/aws-ip-ranges) 可作旁证（2026-08-03/04/06 仍有增删）。

---

## 四、单个 API 有专属 IP 吗：没有

1. **官方口径**【官方】：所有官方表述都是「区域级/服务级池 + 频繁变化」；官方 FAQ 现行版甚至没有「静态 IP」相关问答（2026-08-07 全文解析确认）。
2. **专家答案**【多源】：re:Post 帖 [API Gateway - Outbound static IP](https://repost.aws/questions/QUCpx-dJdOTOC2GCjOXJGJcg/api-gateway-outbound-static-ip) 被采纳答案（EXPERT Brettski 作答，AWS 专家审核）逐字："You cannot configure API Gateway with a static IP address. Instead, the method you describe (Lambda, VPC, NAT Gateway) is the way to achieve this."（注意：这是 re:Post 专家采纳答案，**不是官方 FAQ 原文**）
3. **社区共识**【多源】：[StackOverflow q/60259641](https://stackoverflow.com/questions/60259641/) 最高票答案："You cannot get a static IP if you are using a public API Gateway endpoint (Regional or Edge-optimized). The IPs allocated for APIs in any AWS region can be changed at any time and are a very wide range."
4. **轮换粒度是文档空白**【存疑】：Developer Guide 全站 408 页全文扫描，对「后端连接是否复用（keep-alive/连接池）」零提及；`Connection`/`Keep-Alive` 是保留头、用户不可配置，只能推出连接层由网关内部控制。官方唯一留的观测口子：**HTTP API 会把出口 IP 写进转发给后端的 `Forwarded` 头**【官方】（[Known issues 页](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-known-issues.html) 原文："HTTP APIs translate incoming `X-Forwarded-*` headers into a standard `Forwarded` header and will append the egress IP, Host, and protocol."）。

---

## 五、安全告诫：放行网段 ≈ 授权全区域

re:Post EXPERT（兼 AWS 员工徽章）Uri Segev 在 [IP-ranges.json update changes inquiry](https://repost.aws/questions/QUBYdZTf2uR2CynOUOqxe8zQ/ip-ranges-json-update-changes-inquiry) 帖中的原文（两个验证 Agent 独立逐字核实）：

> "However, it is not a good practice to use the IP range to allow some service running on AWS to access some endpoint somewhere else. If you do that, everyone that has a workload in the same region, will be able to access your endpoint."

注意两点：这是**专家观点而非官方文档**；精确含义是——放行 API_GATEWAY 网段 ≈ **授权全区域所有 API Gateway**（任何租户都能在同区域创建网关并从这些 IP 出站），无法定位到「你的 API」。普通 EC2 等工作负载并不能任意伪造这些源 IP（有防欺骗机制），但安全结论不变：**IP 段不构成账号级 / API 级身份识别**。【多源】

---

## 六、想要静态 IP / 身份证明的官方路线

| 需求 | 路线 | 可信度 |
|---|---|---|
| 稳定出口 IP（路线一） | **Lambda 代理集成**：API Gateway → VPC 内 Lambda → NAT Gateway（绑 EIP），防火墙放行该 EIP | 【官方】KC [api-gateway-ip-address-firewall](https://repost.aws/knowledge-center/api-gateway-ip-address-firewall) |
| 稳定出口 IP（路线二） | **EC2 代理集成**：分配 EIP，API Gateway 经 `http://YOUR_ELASTIC_IP_ADDRESS/{proxy}` 转发，防火墙放行该 EIP | 【官方】同上 KC |
| 源 IP 完全可控 | **VPC Link 私有集成**：API Gateway 在你账号 VPC 内建托管 ENI，源 IP 即你指定子网的 ENI——官方唯一「源 IP 可控」路径。注意：**60 天无流量 → 转 INACTIVE → ENI 全删，期间依赖它的请求会失败，流量恢复才重建** | 【官方】 |
| 验证「请求真的来自 API Gateway」 | **客户端证书**：API Gateway 生成 SSL 证书，后端用公钥校验来源。支持 REST / WebSocket，**HTTP API 不支持**。文档已改版，现行页为 [getting-started-client-side-ssl-authentication](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-client-side-ssl-authentication.html) | 【官方】 |
| 后端是 Lambda | **资源策略**：限 `lambda:InvokeFunction` + `AWS:SourceArn`/`AWS:SourceAccount` 条件，比 IP 白名单更强的身份绑定 | 【官方】 |

⚠️ 方向别混淆：NLB、Global Accelerator 的静态 IP workaround 是**客户端 → API Gateway 入向**的，不改变 Gateway → 后端方向的源 IP【官方】。NLB+NGINX 前置代理变通仅社区来源，无官方背书【存疑】。另：AWS 托管前缀列表截至 2026-08 覆盖 9 项服务（CloudFront、DynamoDB、EC2 Instance Connect、Ground Station、Route 53、S3、S3 Express One Zone、Secrets Manager、VPC Lattice），**其中没有 API Gateway**【官方】。

---

## 七、对抗性验证中被推翻或降级的说法（精选）

| 原说法 | 裁决 |
|---|---|
| "the egress IP address is random" 是 StackOverflow 社区共识 | **主体错位**：该句是 SO 54710518 提问者本人在问题正文的自述，且场景是「不在 VPC 的 Lambda」，被采纳答案明言 "API Gateway seems to be irrelevant to this discussion" |
| 源 IP 逐请求轮换 | **降级**：官方仅说 "frequently change"，「逐请求」粒度无任何官方出处，社区亦无可核实实测 |
| 托管前缀列表只有 CloudFront 与 Route 53 | **推翻**：现行官方表格 9 项服务（2023 年前的旧况）；「无 API Gateway」部分仍成立 |
| aws-samples/update-aws-ip-ranges 「只建不删」 | **证伪**：源码按 100 条一批双向增删条目，仅资源对象（IPSet/前缀列表本身）只建不删 |
| 中国区 IP 归属单一注册 | **修正为双注册**：IANA 权威委派归 ARIN，APNIC 同时维护 SINNET（北京/光环新网）与 WESTCLOUDDATA（宁夏/西云数据）记录 |

另有：WebSearch 多次返回 AI 拼凑伪摘要（含伪造 re:Post URL），全部弃用；两个验证 Agent 对 Uri Segev 引文结论冲突时，以能给出可复核 URL 的一方为准（最终逐字命中）。

---

## 八、运维建议（综合官方口径）

1. **不要依赖 IP 白名单做身份识别**——用客户端证书或 Lambda 资源策略。
2. 必须 IP 放行时，**订阅 SNS + Lambda 自动同步**（参考官方示例仓库 [aws-samples/update-aws-ip-ranges](https://github.com/aws-samples/update-aws-ip-ranges)），并把放行范围理解为「全区域所有 API Gateway」。
3. 需要稳定出口 IP → Lambda+NAT(EIP) 或 EC2 代理(EIP) 或 VPC Link，**别无官方路线**。
4. 想观测实际出口 IP → HTTP API 场景读后端收到的 `Forwarded` 头；或自建回显源 IP 的 echo 端点实测。
5. 中国区用户注意双注册现象：北京区（光环新网）与宁夏区（西云数据）的前缀同样在清单内（cn-north-1 5 条 / cn-northwest-1 4 条），订阅同步时别漏。

---

> 本报告由 18 个只读 Agent（官方文档 / 社区实践 / 历史溯源 / RIR 归属 / 自动化工具链 / 安全告诫 6 路检索，10 个不同视角对抗性验证，1 个完整性批判，1 个连接复用专项补查）汇总而成，统计经 python/node 双独立复核，主 Agent 亲自裁决并撰写。所有结论以 AWS 官方文档与逐字核对为准。
