# 容器作 HTTP 客户端/服务端，最大并发各是多少？—— 两张 min() 公式、六道墙与一套校核命令

撰写日期：2026-08-24。性质：方法论笔记。内容基于 Linux 网络栈的公开机制（四元组、临时端口、conntrack、backlog、TIME_WAIT 等）整理推导，用于容量估算与压测规划，非实验报告。

---

## 结论摘要

**容器作 HTTP 客户端**（主动外连）：第一道墙是**临时端口**，默认配置对单一目标（IP:port）上限约 **2.8 万条并发连接**；调优后 C100k 可行。

**容器作 HTTP 服务端**（监听收连）：**不存在端口墙**（固定监听端口靠客户端四元组区分），第一道墙通常是 **fd 上限或应用线程模型**，默认数万、调优后 C100k–C1M。

两个方向的稳态上限都收敛为同一条公式形态：

```
max_并发 = min(墙1, 墙2, 墙3, ...)
```

差别只在墙的种类和顺序。需求侧两个方向都用**利特尔法则（Little's Law）**：

```
所需并发连接数 = 目标QPS × 平均响应时间(秒)
```

| 维度 | 客户端容器 | 服务端容器 |
|---|---|---|
| 首要瓶颈 | 临时端口 ~28k/目标 | fd 上限（Docker 默认百万级） |
| 次要瓶颈 | TIME_WAIT 速率墙 ~470 conn/s | 内存、conntrack、线程模型 |
| 单对端限制 | 对每对「源IP→目标IP:port」28k | 每个客户端 IP 限 28k，客户端够多即无上限 |
| 稳态上限量级 | 默认 2.8 万，调优 10 万+ | 默认数万，调优 10 万–100 万 |
| conntrack | 走 MASQUERADE 出站才消耗 | 发布端口走 DNAT 才消耗 |

---

## 零、预备知识：四元组决定一切

一条 TCP 连接在内核里由**四元组**唯一标识：

```
(源IP, 源端口, 目标IP, 目标端口)
```

由此推出全文的两个基石：

1. **主动发起方**每新建一条连接，必须消耗自己一个**临时端口**（ephemeral port）。对固定的「我的源IP → 某个目标IP:port」，能用的源端口数量就是连接数上限——**端口墙只砸在主动发起方头上**。
2. **被动监听方**的 (目标IP, 目标端口) 固定（如 0.0.0.0:80），四元组里变化的是**客户端那一半**。所以服务端单端口可以承载的连接数与本地端口数量无关——**服务端没有端口墙**，它的墙在别处。

另一个贯穿全文的事实：**容器共享宿主机内核**。`ip_local_port_range`、ulimit 等可以按容器（netns / 进程）独立，但 **conntrack 表是宿主机全局共享**的；且默认 bridge 网络出站走 MASQUERADE 时，源地址会被改写成宿主机 IP:port，此时端口池也变成宿主机维度共享。

---

## 一、客户端场景：容器向外发起 HTTP 请求

### 1.1 端口墙（第一道墙）

内核为出站连接分配临时端口的范围：

```
net.ipv4.ip_local_port_range = 32768  60999    # 大多数发行版默认
→ 可用端口 60999 - 32768 + 1 = 28,232 个
```

对**单一目标 IP:port**，单源 IP 的并发连接上限即 **28,232**。通用公式：

```
客户端并发上限(端口维度) = 端口范围跨度 × 源IP数量 × 目标IP:port组合数
```

调优手段：

- 调宽范围：`net.ipv4.ip_local_port_range = 1024 65535` → **64,512** 个（翻了 2.3 倍）；
- 给容器/宿主机挂多个源 IP（IP alias、macvlan 多地址），每多一个源 IP 上限翻一倍；
- 目标侧多个 IP/端口（如 LB 后端多实例）同样线性放大。

### 1.2 TIME_WAIT 速率墙（短连接场景的第二道墙）

主动关闭方进入 TIME_WAIT，**Linux 固定 60 秒**（2MSL，MSL=30s）内该四元组的端口不可复用。于是短连接（不复用 keep-alive）对单目标的**新建速率**存在硬上限：

```
最大新建速率 ≈ 端口数 ÷ 60秒
默认：28,232 ÷ 60 ≈ 470 conn/s
调宽后：64,512 ÷ 60 ≈ 1,075 conn/s
```

注意这堵墙限制的是**速率**不是并发——总并发可能只有几百，端口却被 TIME_WAIT 耗光，报错形如 `cannot assign requested address`。

破解：

- **首选：HTTP keep-alive 长连接复用**，速率墙直接消失（连接不新建）；
- `net.ipv4.tcp_tw_reuse = 1`：允许出站侧复用 TIME_WAIT 端口（仅对主动发起方有效，需开启 TCP timestamps，默认已开）。**客户端侧安全，服务端监听方向无效**；
- 加源 IP / 调宽端口范围，同上线性放大；
- `tcp_max_tw_buckets` 只是防 tw 爆炸的保险丝，不是提速手段。

### 1.3 fd 墙

每条已建立连接占 1 个文件描述符。Docker 目前默认 `nofile = 1048576`（老版本/老配置可能 soft=1024）：

```
cat /proc/self/limits | grep "open files"
docker run --ulimit nofile=1048576:1048576 ...
```

百万级默认上限意味着 fd 通常**不是**客户端的第一道墙，但老配置 1024 会直接锁死在三位数，排查时值得先看一眼。

### 1.4 内存墙

每条连接的内存占用 = 内核侧 + 应用侧：

- 内核侧：tcp_sock 结构 + 读写缓冲，空闲连接约 **4–8 KB**（`tcp_rmem`/`tcp_wmem` 按需动态扩展，打满流量时另算）；
- 应用侧：以 Go 为例，一条 keep-alive 空闲连接 = http.Transport 的读写 bufio 缓冲 + goroutine 栈，约 **10–30 KB**。

```
内存维度上限 ≈ 可用内存 ÷ 每连接(内核+应用)占用
例：1GB 容器 ÷ 20KB ≈ 5 万条空闲连接
```

### 1.5 conntrack 墙（容器特有，容易被漏算）

默认 bridge 网络出站经 **MASQUERADE**，每条连接在**宿主机** conntrack 表占一项：

```
net.netfilter.nf_conntrack_max    # 常见默认 262,144，全宿主所有容器共享
conntrack -C                      # 当前占用
```

两个放大器：

1. **共享**：宿主机上所有走 NAT 的容器、以及宿主机自己的 NAT 连接，抢同一张表；
2. **超时极长**：`nf_conntrack_tcp_timeout_established` 默认 **432000 秒（5 天）**。空闲 keep-alive 连接若无流量，conntrack 项要 5 天才老化（有流量则刷新）。TIME_WAIT 状态 120 秒。

表满的症状是新连接随机丢包/超时，且报错在客户端表现为网络问题而非应用问题。`--network host`、macvlan 直挂或路由型 CNI 可绕开 NAT，不进此表。

### 1.6 CPU 墙（TLS 场景先撞）

明文 HTTP 的连接维持几乎不耗 CPU；但 **TLS 握手**（非对称加解密）是 CPU 密集操作。短连接 HTTPS 场景下，CPU 往往先于任何内核参数成为瓶颈。粗略校核：单核每秒能完成的 TLS 握手在数百到数千量级（算法与密钥长度而异），乘以核数与期望新建速率对比即可。长连接 + session resumption 可把它压到接近零。

### 1.7 客户端合成公式与算例

```
max_并发(客户端) = min(
    端口范围跨度 × 源IP数 × 目标组合数,
    nofile,
    可用内存 ÷ 每连接内存,
    nf_conntrack_max(走NAT时, 全宿主共享),
    CPU 可持续服务的活跃连接数
)

短连接附加校核：
    新建速率 ≤ min(端口范围 × 源IP数 × 目标组合数 ÷ 60s,  CPU TLS 握手能力)
    （开 tcp_tw_reuse 后端口项放宽）
```

**算例 A**：Go 爬虫容器，默认配置，抓单一站点。
`min(28,232, 1,048,576, 1GB÷20KB≈5万, 262,144)` → **28,232，端口先撞**。对爬虫业务通常富余。

**算例 B**：压测客户端，目标 50,000 QPS、平均延迟 100ms。
需求侧：50,000 × 0.1 = **5,000 并发**（Little's Law）。供给侧默认 28,232 > 5,000 → **一个默认容器就够**，前提 keep-alive。

**算例 C**：短连接打单目标，想要 5,000 conn/s。
速率墙：默认 470/s，调宽+tw_reuse 后也仅 ~1,075/s → **不达标**。解法：改长连接；或挂 5 个源 IP（5×1,075≈5,375/s 擦线达标）；或多容器分摊。

---

## 二、服务端场景：容器内跑 HTTP 服务

### 2.1 为什么没有端口墙

监听 socket 绑定固定端口（如 :8080），accept 出的每条连接四元组形如：

```
(客户端IP, 客户端临时端口, 服务器IP, 8080)
```

客户端侧 (IP:port) 的组合空间近乎无限，服务端自己**不消耗任何临时端口**。所以理论上限被推到 fd/内存/CPU 层面，数量级从「万」跳到「十万~百万」。

推论（常被误读）：**单个客户端 IP 最多连你约 28k–64k 条**（客户端自己的端口范围）。这是客户端的限制，不是服务的；但压测含义重大——**压 C100k 必须用多个客户端 IP**，默认范围约需 ⌈100,000 ÷ 28,232⌉ = 4 个源 IP，调宽后 2 个。

### 2.2 fd 墙（服务端第一道内核墙）

每条 accept 的连接 = 1 个 fd，外加监听 fd、epoll fd、日志文件等零头。Docker 默认 1,048,576 通常够用；注意两点：

- **容器内应用自己的配置**可能远低于 fd 上限：nginx `worker_connections` 默认仅 512–1024（发行版配置而异），Java Tomcat `maxConnections` 默认 8192——**先撞应用配置，后撞 nofile**；
- 老镜像/老运行时 nofile soft 可能是 1024。

### 2.3 内存墙

与客户端同构：`可用内存 ÷ 每连接(内核+应用)`。差别在应用侧开销因栈而异：

- nginx：空闲连接应用侧仅几 KB，1GB 可撑**十万级**；
- Go：每连接十几到几十 KB（goroutine + bufio），1GB 约 **3–6 万条**空闲连接；
- Java 线程模型：每连接一个线程 ≈ **1 MB 栈**，几千条即封顶——**这是线程模型墙，比所有内核墙都先到**。

### 2.4 conntrack 墙（发布端口才吃）

`-p 80:8080` 发布端口走 **DNAT**，每条入站连接占宿主机 conntrack 一项（共享 262,144、established 超时 5 天，同 1.5 节）。`--network host` 或路由型网络不进表。Ingress/NodePort 场景注意 Kubernetes 的 kube-proxy 同样过 conntrack。

### 2.5 backlog 墙（限制突发吸收，不限制稳态并发）

TCP 三次握手到应用 accept 之间有两条队列：

```
SYN 队列(半连接)：net.ipv4.tcp_max_syn_backlog    # 默认随内存缩放，1024+
accept 队列(全连接)：min(应用listen backlog, net.core.somaxconn)
                  # somaxconn 内核 5.4+ 默认 4096，更早 128
```

估算口径：

```
所需 backlog ≥ 突发新建连接峰值(条/秒) × 应用 accept 平均耗时(秒)
实用取值：流量有突发就拉到 8192–65535，配合 ss -lnt 观察 Recv-Q 不持续积压即可
```

队列满的行为：`tcp_abort_on_overflow=0`（默认）时静默丢 ACK 让客户端重试（表现为偶发延迟毛刺），=1 时直接 RST。**它决定"扛不扛得住秒杀式突发"，与稳态并发数无关。**老内核 somaxconn=128 是著名隐患：稳态只有几百并发的服务也会在突发下翻车。

### 2.6 accept 吞吐与 SO_REUSEPORT

单监听 socket 单线程 accept，新建速率上限在**数万条/秒**量级；多数业务到不了。真到这一层（如四层 LB、海量短连接），开 `SO_REUSEPORT` 让多进程/多线程各自持有监听 socket，内核做四元组哈希分流，accept 能力随核数线性扩展。nginx `reuseport`、Go 需第三方库或自调 syscall。

### 2.7 服务端 TIME_WAIT 堆积公式

HTTP 下若**服务端先关连接**（短连接且服务端发 `Connection: close`），TIME_WAIT 堆在服务端：

```
TIME_WAIT 堆积数 ≈ 新建速率 × 60秒
例：10,000 conn/s 短连接 → 稳态约 60 万个 tw socket
```

TIME_WAIT 不占 fd（close 后 fd 已释放），但占内核内存（每个百余字节）与 conntrack（120 秒超时）。主要风险是内存与 conntrack 表压力，不是端口。规避：让客户端先关（服务端 keep-alive 超时设长、响应不带 close），或干脆长连接。

### 2.8 服务端合成公式与算例

```
max_并发(服务端) = min(
    nofile,
    应用连接数配置(worker_connections / maxConnections / 线程池),
    可用内存 ÷ 每连接内存,
    nf_conntrack_max(发布端口走DNAT时, 全宿主共享),
    CPU 可持续服务的活跃连接数
)

突发附加校核：
    backlog ≥ 突发新建峰值 × accept 耗时
    accept 速率 ≤ 单socket数万/秒(不够则 SO_REUSEPORT)
短连接附加校核（服务端先关）：
    内存/conntrack 能承受 新建速率 × 60s 的 TIME_WAIT 堆积
```

**算例 D**：nginx 容器，`-p 80:80` 发布，2 vCPU、2GB，默认 `worker_connections=1024`、4 worker。
`min(1,048,576, 1024×4=4096, 2GB÷几KB≈几十万, 262,144)` → **4,096，应用配置先撞**。把 `worker_connections` 提到 65535 后，下一个瓶颈变成内存/conntrack 的十万级。

**算例 E**：Java Spring 容器，线程池 200 线程、maxConnections 8192。
真实并发 = **200**（每个请求占一线程处理中）——accept 的 8,000 条连接大多在排队。线程模型决定一切，内核参数全是背景板。这类栈谈"C10k"没有意义，要么加线程（内存换），要么换异步/reactive 模型。

**算例 E2**：Go 服务容器，`--network host`，8GB，目标 C100k 长连接。
`min(1,048,576, 8GB÷20KB≈40万, 无DNAT不吃conntrack)` → 内存维度 40 万 > 10 万 → **达标**。注意 fd 至少调到 20 万以上留余量，且压测端需要 ≥4 个默认范围源 IP。

---

## 三、需求侧统一公式：利特尔法则

无论客户端还是服务端，先算"需要多少并发"，再核"供得上多少"：

```
所需并发连接数 L = 到达速率 λ(QPS) × 单请求驻留时间 W(秒)
```

- 5,000 QPS × 200ms = 1,000 并发 → 默认客户端/服务端容器都轻松；
- 100,000 QPS × 50ms = 5,000 并发 → 依然单机容器量级；
- 真正把人推进 C10k+ 调优区的，通常是**长连接常驻**（WebSocket、gRPC 流、SSE）而非 QPS——那时 W 变成连接生命周期（分钟~小时级），L 爆炸。

---

## 四、校核命令清单

| 查什么 | 命令 | 看什么 |
|---|---|---|
| 临时端口范围 | `sysctl net.ipv4.ip_local_port_range` | 跨度即单目标连接上限 |
| fd 上限 | `cat /proc/<pid>/limits \| grep files` | Max open files |
| conntrack 上限/占用 | `sysctl net.netfilter.nf_conntrack_max`；`conntrack -C` | 占用逼近上限即危险 |
| 当前连接分布 | `ss -s`；`ss -ant state time-wait \| wc -l` | established / time-wait 数量 |
| 端口耗尽症状 | 客户端报错 `cannot assign requested address` | 触发端口墙或速率墙 |
| accept 队列 | `ss -lnt` 的 Recv-Q 列 | 持续 >0 说明 accept 跟不上 |
| backlog 参数 | `sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog` | 老内核 128 是坑 |
| tw 复用 | `sysctl net.ipv4.tcp_tw_reuse net.ipv4.tcp_max_tw_buckets` | 客户端短连接提速 |
| conntrack 超时 | `sysctl net.netfilter.nf_conntrack_tcp_timeout_established` | 默认 432000s(5天) |
| NAT 形态 | 容器是否 `-p` 发布 / 出站是否 MASQUERADE | 决定吃不吃 conntrack 与宿主端口池 |

---

## 五、常见误判

1. **「服务端也要调大 ip_local_port_range」**——无效。服务端监听不消耗临时端口；该参数只对主动出站方向有意义。（例外：服务端同时大量回调外连，那时它是客户端角色。）
2. **「压测打不上去是服务不行」**——先查压测客户端：单源 IP 默认只有 28k 端口，短连接还有 470/s 速率墙，很多"服务端瓶颈"其实是客户端端口耗尽。
3. **「TIME_WAIT 太多会占满端口/占满 fd」**——服务端方向不占端口；任何方向都不占 fd（close 已释放）。真实代价是内核内存 + conntrack。
4. **「容器限制等于这些数字」**——容器默认不限制连接数，限制来自内核参数（可独立）与宿主共享资源（conntrack、NAT 端口池、CPU/内存配额）。cgroup 的 CPU/内存限额会通过内存墙、CPU 墙间接生效。
5. **「somaxconn 调大能提升并发」**——它只管突发吸收队列，稳态并发一毫秒都不会因此变多。
6. **「conntrack 表 26 万很大」**——全宿主共享 + established 5 天超时，长连接场景几万常驻连接 × 几个容器就能顶满，且表满症状（随机丢包）极具迷惑性。

---

## 六、一页速查

```
需求（两个方向通用）：并发 = QPS × 响应秒数

客户端：min(端口跨度×源IP×目标数, nofile, 内存÷每连接, conntrack共享表, CPU)
        默认对单目标 ≈ 28,232；短连接速率墙 ≈ 端口数÷60s

服务端：min(nofile, 应用连接配置, 内存÷每连接, conntrack共享表(DNAT时), CPU)
        无端口墙；单客户端IP限28k；backlog只管突发；
        服务端先关的短连接 TIME_WAIT ≈ 速率×60s

容器特有：bridge NAT 让端口池/conntrack 退化为宿主共享；--network host 绕开
```
