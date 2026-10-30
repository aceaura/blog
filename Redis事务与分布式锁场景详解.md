# Redis 事务与分布式锁:场景详解(Single / Cluster 分列)

> 本文所有行为结论均在 **Redis 8.10.3** 上实测验证:
> - 单实例:Docker 容器 `redis-lab`,无持久化
> - 集群:临时搭建 3 主节点集群,槽位 `0-5460` / `5461-10922` / `10923-16383`
>
> 代码示例基于本项目实际使用的客户端:**go-redis v9.5.1**(`github.com/redis/go-redis/v9`)。
> 本项目通过 `internal/generic/global/global.go` 中的 `redis.Cmdable` 抽象,
> 依据配置项 `redis.player.mode` 在 single / cluster 之间切换,因此两种模式的差异是真实工程约束,而非理论讨论。

---

## 目录

1. [一条规则决定一切](#一条规则决定一切)
2. [选型决策表总览](#选型决策表总览)
3. [场景详解](#场景详解)
   - [场景 1:单 key 条件更新(CAS)](#场景-1单-key-条件更新cas)
   - [场景 2:单 key 的 Lua(计数器/限流/令牌桶)](#场景-2单-key-的-lua计数器限流令牌桶)
   - [场景 3:跨 key 读-改-写 Lua](#场景-3跨-key-读-改-写-lua)
   - [场景 4:WATCH + 重试乐观锁](#场景-4watch--重试乐观锁)
   - [场景 5:MULTI/EXEC 打包多写](#场景-5multiexec-打包多写)
   - [场景 6:Pipeline 减少 RTT](#场景-6pipeline-减少-rtt)
   - [场景 7:单实例分布式锁](#场景-7单实例分布式锁)
   - [场景 8:同时锁多个资源](#场景-8同时锁多个资源)
   - [场景 9:Redlock](#场景-9redlock)
   - [场景 10:强一致互斥](#场景-10强一致互斥)
4. [两类错误,两种命运](#两类错误两种命运)
5. [本项目落地建议](#本项目落地建议)
6. [附录:实验环境复现](#附录实验环境复现)

---

## 一条规则决定一切

Cluster 下,**事务和 Lua 脚本涉及的所有 key 必须落在同一个 hash slot**。

注意是"同一个 slot",不是"同一个节点"。这是最容易误解的地方。实测证明:两个 key 物理上都在 `redis-c2` 这一个节点上,但槽位分别是 10778 和 6777,`EVAL` 依然报错:

```
$ docker exec redis-c2 redis-cli EVAL 'return 1' 2 user:1 user:2
CROSSSLOT Keys in request don't hash to the same slot
```

槽位计算规则:`HASH_SLOT = CRC16(key) mod 16384`。若 key 中含有 `{...}`,则只用大括号内的内容计算。

```
$ redis-cli CLUSTER KEYSLOT user:1      → 10778
$ redis-cli CLUSTER KEYSLOT user:2      → 6777      # 不同 slot
$ redis-cli CLUSTER KEYSLOT {u}:1       → 11826
$ redis-cli CLUSTER KEYSLOT {u}:2       → 11826     # 同 slot,可用
```

### 报错时机的三种形态

单实例下只有"入队期错误"和"运行期错误"两类。Cluster 引入了第三种,而且它最隐蔽:

| 形态 | 触发时机 | 后果 |
|---|---|---|
| 入队期错误 | `MULTI` 后命令入队时 | `EXEC` 返回 `EXECABORT`,整单不执行 |
| 运行期错误 | `EXEC` 执行单条命令时 | 该条返回错误,**其余命令照样执行** |
| **`CROSSSLOT`(集群独有)** | **`EXEC` 期一次性否决** | **整单废弃,但入队时毫无征兆** |

实测对比:

```
# 跨 slot:入队时一声不响
MULTI                → OK
SET user:1 Alice     → QUEUED      ← 注意:没有报错!
SET user:2 Bob       → QUEUED
EXEC                 → (error) CROSSSLOT Keys in request don't hash to the same slot
```

这意味着:**如果测试用例只检查入队是否成功,这个错误会一路漏到生产环境**。从单实例迁移到集群时,这是最大的风险点。

---

## 选型决策表总览

| 场景 | Single | Cluster | 关键约束 |
|---|:--:|:--:|---|
| 1. 单 key 条件更新 `SET IFEQ` / `DELEX IFEQ` | 可用 | **可用** | 单 key 天然同 slot,无差异 |
| 2. 单 key 的 Lua | 可用 | **可用** | 同上 |
| 3. 跨 key 读-改-写 Lua | 可用 | **需 hash tag** | 否则 `CROSSSLOT`;key 必须经 `KEYS` 传入 |
| 4. `WATCH` + 重试乐观锁 | 可用 | **需 hash tag** | `WATCH` 是 single-slot 命令,跨 slot 当场报错 |
| 5. `MULTI`/`EXEC` 打包多写 | 可用 | **需 hash tag** | 跨 slot 时 `EXEC` 期整单废弃 |
| 6. Pipeline 减少 RTT | 可用 | **可用但需按节点拆** | 客户端自动分组,但不再是一次 RTT |
| 7. 单实例锁 `SET NX PX` + 校验释放 + 看门狗 | 可用 | **可用** | 锁 key 单个,不受 slot 限制 |
| 8. 同时锁多个资源 | 可用 | **需 hash tag 或逐个加锁** | 一个 Lua 原子拿多把锁要求同 slot |
| 9. Redlock | 可用(N 个独立实例) | **不适用** | 集群 ≠ N 个独立 master |
| 10. 强一致互斥 | 都不够 | 都不够 | 需 fencing token,或换 etcd/ZooKeeper |

---

## 场景详解

### 场景 1:单 key 条件更新(CAS)

**适用性:Single 可用 / Cluster 可用**

只涉及一个 key,天然落在同一个 slot,两种模式完全无差异。这是最安全的一类操作。

#### Redis 8.4+ 原生命令

```
SET cas:v v2 IFEQ v1        # 旧值等于 v1 才写入,否则返回 nil
DELEX key IFEQ my_token     # 值匹配才删除,返回 1;不匹配返回 0
```

实测:

```
$ SET cas:v v1              → OK
$ SET cas:v v2 IFEQ wrong   → (nil)      # 旧值不匹配,拒绝写入
$ SET cas:v v2 IFEQ v1      → OK
$ GET cas:v                 → "v2"
```

同系列还有 `IFNE`(不等于才写)、`IFDEQ`、`IFDNE` 变体。

#### 8.4 之前:用 Lua

```lua
-- KEYS[1]=key, ARGV[1]=期望旧值, ARGV[2]=新值
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
else
  return 0
end
```

#### Go 代码(go-redis v9.5.1)

**注意:v9.5.1 的 `SetArgs` 结构体只有 `Mode`/`TTL`/`ExpireAt`/`Get`/`KeepTTL` 字段,不支持 `IFEQ`。** 需要用通用 `Do()` 裸发命令:

```go
// Redis 8.4+ 原生 IFEQ(v9.5.1 需用 Do)
func casSet(ctx context.Context, rdb redis.Cmdable, key, oldVal, newVal string) (bool, error) {
    // 注意:Cmdable 接口没有 Do 方法,需断言到具体类型
    doer, ok := rdb.(interface {
        Do(ctx context.Context, args ...interface{}) *redis.Cmd
    })
    if !ok {
        return false, fmt.Errorf("client does not support Do")
    }
    res, err := doer.Do(ctx, "SET", key, newVal, "IFEQ", oldVal).Result()
    if err == redis.Nil {
        return false, nil // 旧值不匹配
    }
    if err != nil {
        return false, err
    }
    return res == "OK", nil
}

// 兼容低版本:Lua 实现
var casScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
end
return 0
`)

func casSetLua(ctx context.Context, rdb redis.Scripter, key, oldVal, newVal string) (bool, error) {
    n, err := casScript.Run(ctx, rdb, []string{key}, oldVal, newVal).Int()
    return n == 1, err
}
```

#### 坑

- `SET ... IFEQ` 对不存在的 key 返回 nil(不等于任何值),不会当作空字符串匹配。
- `redis.Nil` 必须单独判断,否则会被当成错误吞掉正常的"CAS 失败"语义。

---

### 场景 2:单 key 的 Lua(计数器/限流/令牌桶)

**适用性:Single 可用 / Cluster 可用**

单 key 脚本是两种模式的最大公约数。设计时把一个原子操作涉及的全部状态收进一个 key(通常用 Hash),代码可以在 single 和 cluster 之间零改动迁移。

#### 示例:固定窗口限流

```lua
-- KEYS[1]=限流key  ARGV[1]=窗口秒数  ARGV[2]=阈值
local cur = redis.call("INCR", KEYS[1])
if cur == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
if cur > tonumber(ARGV[2]) then
  return 0        -- 拒绝
end
return 1          -- 放行
```

#### 示例:令牌桶(状态全在一个 Hash 里)

```lua
-- KEYS[1]=桶key  ARGV[1]=容量 ARGV[2]=每秒速率 ARGV[3]=本次取用量
local cap  = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local need = tonumber(ARGV[3])

local now  = tonumber(redis.call("TIME")[1])
local data = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(data[1]) or cap
local ts     = tonumber(data[2]) or now

-- 按时间差补充令牌
tokens = math.min(cap, tokens + (now - ts) * rate)

if tokens < need then
  redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
  redis.call("EXPIRE", KEYS[1], math.ceil(cap / rate) + 1)
  return 0
end

tokens = tokens - need
redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
redis.call("EXPIRE", KEYS[1], math.ceil(cap / rate) + 1)
return 1
```

这里用了 `TIME` 这个非确定性命令。**这在现代 Redis 上是安全的**:3.2 引入 effects replication(只复制写效果),5.0 成为默认,7.0 彻底移除了 verbatim 复制。老文章里"脚本必须确定性"的要求已经过期。

#### Go 代码

```go
var tokenBucket = redis.NewScript(`...上面的脚本...`)

func allow(ctx context.Context, rdb redis.Scripter, key string, cap, rate, need int) (bool, error) {
    n, err := tokenBucket.Run(ctx, rdb, []string{key}, cap, rate, need).Int()
    return n == 1, err
}
```

`redis.NewScript` 会自动先试 `EVALSHA`,遇到 `NOSCRIPT` 再回退 `EVAL`,这个重试逻辑客户端已经处理好了。

#### 坑:脚本阻塞整个实例

脚本执行期间**整个服务器被阻塞**。实测让脚本空转 2 秒,另一个连接的 `PING` 立刻收到:

```
BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.
```

Cluster 下只阻塞该分片,但对那个分片的所有客户端一样是 `BUSY`。

更严重的是:**只读脚本可以 `SCRIPT KILL`,写过数据的杀不掉**。实测:

```
$ SCRIPT KILL
UNKILLABLE Sorry the script already executed write commands against the dataset.
You can either wait the script termination or kill the server in a hard way using
the SHUTDOWN NOSAVE command.
```

只能等它跑完,或者 `SHUTDOWN NOSAVE`(丢数据)。**慢写脚本 = 生产事故**。

#### 坑:maxmemory 边界

若脚本第一条写命令不增加内存(例如 `DEL`),Redis 为保证原子性会让整个脚本跑完,过程中后续写入**可能突破 maxmemory**。建议 `maxmemory-policy` 不要用 `noeviction`。

---

### 场景 3:跨 key 读-改-写 Lua

**适用性:Single 可用 / Cluster 需 hash tag**

#### Single:随便用

```lua
-- 转账:从 A 扣,给 B 加
local from = tonumber(redis.call("GET", KEYS[1]))
if from == nil or from < tonumber(ARGV[1]) then
  return 0
end
redis.call("DECRBY", KEYS[1], ARGV[1])
redis.call("INCRBY", KEYS[2], ARGV[1])
return 1
```

#### Cluster:必须同 slot

实测跨 slot 直接拒绝:

```
$ EVAL 'return 1' 2 user:1 user:2
CROSSSLOT Keys in request don't hash to the same slot
```

加 hash tag 后正常(连对节点):

```
$ EVAL 'return {redis.call("GET",KEYS[1]),redis.call("GET",KEYS[2])}' 2 '{u}:1' '{u}:2'
1) "X"
2) "Bob"
```

改造方法:把需要一起操作的 key 用相同的 hash tag 包起来。

```
# 改造前(跨 slot,集群下不可用)
balance:user:1001
balance:user:2002

# 改造后(同 slot)——前提是这两个账户本就属于同一个逻辑分组
balance:{wallet:1001}:main
balance:{wallet:1001}:frozen
```

#### 两条硬性要求

1. **所有访问的 key 必须通过 `KEYS` 显式传入**。不能用程序拼的键名,也不能从数据里读出键名再访问。否则集群下客户端无法判断路由,会出错。

   ```lua
   -- 错误:集群下会出问题
   local other = redis.call("GET", "some:other:key")
   local dyn   = redis.call("GET", "prefix:" .. ARGV[1])

   -- 正确:经 KEYS 传入
   local other = redis.call("GET", KEYS[2])
   ```

2. **带 `#!` shebang 的脚本更严格**。无 shebang 的脚本可以访问不同 slot 的 key(单实例),带 `#!` 的继承默认 flags 后不行。**迁移到集群时给老脚本加 shebang 可能反而把它弄坏。**

#### 坑:hash tag 不是免费的

把 key 强行收进同一 slot,等于把这批数据钉在同一个节点上:

- 放弃了这部分数据的水平扩展能力
- 可能造成热点槽位(某个 slot 的读写量远超其他)

官方给的优先级是:**先重构数据模型减少跨 key 操作,hash tag 是手段而非目标**。对锁来说通常无所谓(锁 key 小且分散),对业务数据要仔细掂量。

---

### 场景 4:WATCH + 重试乐观锁

**适用性:Single 可用 / Cluster 需 hash tag**

`WATCH` 本身就是官方分类里的 **single-slot 命令**,比 `MULTI` 更早暴露问题。实测跨 slot 当场报错:

```
$ WATCH user:1 user:2
(error) CROSSSLOT Keys in request don't hash to the same slot
```

这其实是好事:错误在 `WATCH` 时就暴露,不会像 `MULTI` 那样拖到 `EXEC`。

#### 基本用法

```
WATCH mykey
val = GET mykey          # 在事务外读
MULTI
SET mykey <新值>
EXEC                     # 被改过则返回 nil,自己重试
```

#### 实测确认的四个边界

**边界 1:他人改动 → `EXEC` 返回 nil,事务内命令一条不执行**

```
# 窗口1                      # 窗口2
SET k 10
WATCH k
MULTI
SET k 99
                            SET k 777
EXEC     → (nil)
GET k    → "777"            # 事务确实没执行
```

**边界 2:自己改也会中止**(最反直觉的一条)

```
SET w 1       → OK
WATCH w       → OK
SET w 2       → OK          ← 自己改的,在 MULTI 之前
MULTI         → OK
SET w 3       → QUEUED
EXEC          → (nil)       ← 同样中止!
GET w         → "2"
```

`WATCH` **不区分是谁改的**。只要被监视的 key 在 `WATCH` 之后、`EXEC` 之前发生过修改,事务就会中止。

**边界 3:key 自然过期/被驱逐也算"被改动"**

```
SET e v PX 300    → OK
WATCH e           → OK
MULTI             → OK
SET other 1       → QUEUED
# 等待 800ms,让 e 自然过期
EXEC              → (nil)
```

注意这是 **6.0.9 起**的行为,之前版本过期不会中止事务。

**边界 4:事务内的命令不触发 WATCH 条件**。它们只是排队,`EXEC` 时才执行。

#### WATCH 的生命周期

- `EXEC` 一旦执行(无论成功还是中止)**自动清空所有 WATCH**
- 连接关闭也清空
- 中途放弃用 `UNWATCH`

#### Go 代码:重要的工程约束

**本项目的 `global.RedisClient` 类型是 `redis.Cmdable`,而 `Watch` 方法不在 `Cmdable` 接口里。** 实测确认:

```
# Cmdable 接口内只有这些事务相关方法:
Pipeline() Pipeliner
TxPipelined(ctx, fn) ([]Cmder, error)
TxPipeline() Pipeliner

# Watch 定义在具体类型上:
func (c *Client) Watch(ctx, fn, keys...) error          // tx.go
func (c *ClusterClient) Watch(ctx, fn, keys...) error   // osscluster.go
func (c *Ring) Watch(ctx, fn, keys...) error            // ring.go
```

所以要用 `WATCH`,必须断言到具体类型:

```go
type watcher interface {
    Watch(ctx context.Context, fn func(*redis.Tx) error, keys ...string) error
}

func incrWithRetry(ctx context.Context, rdb redis.Cmdable, key string, maxRetry int) error {
    w, ok := rdb.(watcher)
    if !ok {
        return fmt.Errorf("client does not support WATCH")
    }

    txf := func(tx *redis.Tx) error {
        n, err := tx.Get(ctx, key).Int()
        if err != nil && err != redis.Nil {
            return err
        }
        n++
        // 事务内的命令通过 TxPipelined 提交
        _, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
            p.Set(ctx, key, n, 0)
            return nil
        })
        return err
    }

    for i := 0; i < maxRetry; i++ {
        err := w.Watch(ctx, txf, key)
        if err == nil {
            return nil                  // 成功
        }
        if err == redis.TxFailedErr {
            continue                    // 被别人改了,重试
        }
        return err                      // 真错误
    }
    return fmt.Errorf("incr %s: 超过最大重试次数 %d", key, maxRetry)
}
```

`redis.TxFailedErr` 对应 `EXEC` 返回 nil 的情况,必须单独识别并重试,不能当失败。

#### 坑:重试必须有上限

乐观锁在高冲突下会活锁。务必设置最大重试次数,并考虑加随机退避:

```go
time.Sleep(time.Duration(rand.Intn(10)+1) * time.Millisecond)
```

---

### 场景 5:MULTI/EXEC 打包多写

**适用性:Single 可用 / Cluster 需 hash tag**

#### 先明确:Redis 事务到底保证什么

**保证:**
- **串行隔离**:事务内命令连续执行,中间不会插入其他客户端的命令
- **全有或全无(仅连接层面)**:`EXEC` 前断线则一条都不执行;`EXEC` 发出则全部执行
- AOF 下整个事务用单次 `write(2)` 落盘

**不保证:**
- **没有回滚**。官方理由是回滚会显著牺牲简洁性和性能

所以 Redis 事务只有 ACID 里的 **I**,没有严格意义的 A 和 C。

#### Cluster 下的行为

同 slot(连对节点)正常:

```
MULTI              → OK
SET {u}:1 Alice    → QUEUED
SET {u}:2 Bob      → QUEUED
EXEC               → 1) OK  2) OK
MGET {u}:1 {u}:2   → 1) "Alice"  2) "Bob"
```

跨 slot 在 `EXEC` 期整单废弃(见[一条规则决定一切](#一条规则决定一切))。

#### MULTI 内的限制(实测)

```
MULTI 内再 MULTI    → ERR MULTI calls can not be nested
MULTI 内 WATCH      → ERR WATCH inside MULTI is not allowed
无 MULTI 时 EXEC    → ERR EXEC without MULTI
无 MULTI 时 DISCARD → ERR DISCARD without MULTI
```

`SUBSCRIBE` 实测**可以**入队并执行,但不同版本行为有差异,不要依赖。

#### 坑:阻塞命令在事务里退化成非阻塞

```
MULTI
BLPOP emptylist 0    → QUEUED
EXEC                 → 1) (nil)        ← 立即返回,不阻塞
```

原因很直白:阻塞整个事务就等于阻塞整个服务器,没人能 push 进来。官方文档的说法是"想象 MULTI/EXEC 块内时间以无限速度流动"。

`BRPOPLPUSH`、`BLMOVE`、`WAIT` 同理。

#### Go 代码

go-redis 用 `TxPipeline` 表达 `MULTI`/`EXEC`:

```go
// 单实例:随便用
func batchWrite(ctx context.Context, rdb redis.Cmdable) error {
    _, err := rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
        p.Set(ctx, "user:1", "Alice", 0)
        p.Set(ctx, "user:2", "Bob", 0)
        p.Incr(ctx, "counter")
        return nil
    })
    return err
}

// 集群:用 hash tag 保证同 slot
func batchWriteCluster(ctx context.Context, rdb redis.Cmdable, groupID string) error {
    tag := "{" + groupID + "}"
    _, err := rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
        p.Set(ctx, tag+":user:1", "Alice", 0)
        p.Set(ctx, tag+":user:2", "Bob", 0)
        return nil
    })
    return err
}
```

`TxPipelined` 在 `Cmdable` 接口里,所以本项目的 `global.RedisClient` 可以直接调用,不需要类型断言。

---

### 场景 6:Pipeline 减少 RTT

**适用性:Single 可用 / Cluster 可用但需按节点拆**

Pipeline 和事务是两件事:Pipeline 只是把多条命令打包发送省 RTT,**不提供任何原子性保证**,中间可以插入其他客户端的命令。

官方把 Cluster 下的 pipeline 也列为 single-slot。实践中 go-redis 的 `ClusterClient` 会自动按节点分组并并发发送,但那就不是一次 RTT 了,而是 N 个节点各一次。

```go
// 单实例:一次 RTT
pipe := rdb.Pipeline()
for i := 0; i < 1000; i++ {
    pipe.Set(ctx, fmt.Sprintf("k:%d", i), i, 0)
}
cmds, err := pipe.Exec(ctx)

// 集群:go-redis 自动按节点拆成多批并发
// 行为正确,但 RTT 次数 = 涉及的节点数
```

#### 坑:错误处理

`Exec` 返回的 `err` 是"第一个出错的命令的错误"。要逐条检查必须遍历 `cmds`:

```go
cmds, err := pipe.Exec(ctx)
if err != nil && err != redis.Nil {
    // 注意:即使 err != nil,前面的命令可能已经执行成功了
}
for _, cmd := range cmds {
    if e := cmd.Err(); e != nil && e != redis.Nil {
        log.Warnf("命令 %v 失败: %v", cmd.Args(), e)
    }
}
```

#### 坑:pipeline 里的 EVALSHA

**在 pipeline 里 `NOSCRIPT` 无法处理**。因为客户端没机会在中途回退到 `EVAL`。此时应该直接用 `EVAL` 发送完整脚本。

---

### 场景 7:单实例分布式锁

**适用性:Single 可用 / Cluster 可用**

锁 key 是单个,不受 slot 限制,**两种模式写法完全一致**。实测集群下 `NX` 互斥、`DELEX IFEQ` 全部正常:

```
$ redis-cli -c SET lock:order tokenA NX PX 30000   → OK
$ redis-cli -c SET lock:order tokenB NX PX 30000   → (nil)    # 抢不到
$ redis-cli -c DELEX lock:order IFEQ tokenB        → 0        # 删不掉别人的
$ redis-cli -c DELEX lock:order IFEQ tokenA        → 1        # 自己的可以删
```

#### 正确实现

```
# 加锁
SET resource_name <random_token> NX PX 30000

# 解锁(Redis 8.4+)
DELEX resource_name IFEQ <random_token>

# 解锁(8.4 之前,用 Lua)
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

#### 三个要素,缺一不可

| 要素 | 少了会怎样 |
|---|---|
| `NX` | 不互斥,锁失效 |
| `PX`(**必须与 SET 同一条命令**) | 持有者崩溃则死锁 |
| 随机 token + 校验删除 | **会删掉别人的锁** |

**`SETNX` + 单独 `EXPIRE` 是经典错误**:两条命令之间崩溃就是永久死锁。必须用 `SET key val NX PX ttl` 一条命令完成。

**误删别人的锁**实测演示:

```
# A 持有锁
$ SET lock:order tokenA NX PX 30000   → OK

# B 直接 DEL —— 删成功了!这就是事故
$ DEL lock:order                      → 1

# 改用 Lua 校验:
$ SET lock:order tokenA NX PX 30000   → OK
# B 尝试释放(token 不匹配)
$ EVAL '...' 1 lock:order tokenB      → 0      ← 拒绝
# A 释放(token 匹配)
$ EVAL '...' 1 lock:order tokenA      → 1      ← 成功
```

token 必须全客户端、全请求唯一。官方建议 `/dev/urandom` 取 20 字节。时间戳 + 客户端 ID 不够严谨,但多数场景够用。

#### 看门狗(自动续期)

续期也必须带 token 校验,否则会给别人的锁续期。实测:

```
$ SET lock:w tokenA PX 2000     → OK
$ PTTL lock:w                   → 1817
$ EVAL 'if redis.call("get",KEYS[1])==ARGV[1] then
         return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end' 1 lock:w tokenA 30000
$ PTTL lock:w                   → 29815      ← 续期成功
```

#### 完整 Go 实现

```go
package lock

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

var ErrNotAcquired = errors.New("lock: 未获得锁")

// 释放:仅当 token 匹配
var releaseScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`)

// 续期:仅当 token 匹配
var renewScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`)

type Lock struct {
    rdb    redis.Scripter
    key    string
    token  string
    ttl    time.Duration
    cancel context.CancelFunc
}

func newToken() (string, error) {
    b := make([]byte, 20) // 官方建议 20 字节
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return hex.EncodeToString(b), nil
}

// Acquire 尝试加锁。withWatchdog=true 时后台自动续期。
func Acquire(ctx context.Context, rdb redis.Cmdable, key string,
    ttl time.Duration, withWatchdog bool) (*Lock, error) {

    token, err := newToken()
    if err != nil {
        return nil, err
    }

    ok, err := rdb.SetNX(ctx, key, token, ttl).Result()
    if err != nil {
        return nil, err
    }
    if !ok {
        return nil, ErrNotAcquired
    }

    scripter, ok2 := rdb.(redis.Scripter)
    if !ok2 {
        return nil, fmt.Errorf("lock: client 不支持脚本")
    }

    l := &Lock{rdb: scripter, key: key, token: token, ttl: ttl}

    if withWatchdog {
        wctx, cancel := context.WithCancel(context.Background())
        l.cancel = cancel
        go l.watchdog(wctx)
    }
    return l, nil
}

// watchdog 每 ttl/3 续期一次。
// 续期返回 0 说明锁已不属于自己,必须立即停止工作。
func (l *Lock) watchdog(ctx context.Context) {
    t := time.NewTicker(l.ttl / 3)
    defer t.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-t.C:
            n, err := renewScript.Run(ctx, l.rdb,
                []string{l.key}, l.token, l.ttl.Milliseconds()).Int()
            if err != nil || n == 0 {
                // 关键:拿不到确认就不能假设"锁还在"
                // 生产代码应在此通知业务逻辑中止
                return
            }
        }
    }
}

func (l *Lock) Release(ctx context.Context) error {
    if l.cancel != nil {
        l.cancel()
    }
    n, err := releaseScript.Run(ctx, l.rdb, []string{l.key}, l.token).Int()
    if err != nil {
        return err
    }
    if n == 0 {
        return errors.New("lock: 锁已不属于当前持有者(可能已过期)")
    }
    return nil
}
```

使用:

```go
l, err := lock.Acquire(ctx, global.RedisClient, "lock:order:1001", 30*time.Second, true)
if errors.Is(err, lock.ErrNotAcquired) {
    return  // 没抢到,按业务决定重试或放弃
}
if err != nil {
    return err
}
defer l.Release(ctx)

// 临界区
```

#### 续期间隔怎么定

`ttl/3` 是常见取值。推理:允许连续失败 2 次仍有机会补救。Redisson 的做法是 `lockWatchdogTimeout/3`,默认 30 秒 TTL、10 秒续期一次。

#### 坑:Cluster 下多一条风险

| 风险 | Single | Cluster |
|---|---|---|
| 异步复制导致故障切换后双持有 | 有 | **有**(每个 slot 的主从同样异步) |
| 墙上时钟跳变导致 TTL 提前失效 | 有 | 有 |
| 锁过期但持有者还在跑 | 有 | 有 |
| **resharding / slot 迁移期间的 `MOVED`/`ASK`/`TRYAGAIN`** | 无 | **有** |

最后一条是集群独有:迁移窗口内加锁或续期可能失败,客户端必须能重试并跟随重定向。**续期失败时绝不能当成"锁还在"**,拿不到确认就应当主动放弃临界区。

#### 坑:为什么主从方案本身就不安全

Redis 复制是**异步**的,存在这条竞态:

1. 客户端 A 在 master 上拿到锁
2. master 还没把写同步给 replica 就崩了
3. replica 升为新 master
4. 客户端 B 在新 master 上拿到**同一把锁**

此时 A 和 B 同时认为自己持有锁,**安全性直接破了**。

官方态度很实际:如果业务能容忍故障期间偶发双持有,主从方案就够用;不能容忍才需要考虑 Redlock 或换系统。

---

### 场景 8:同时锁多个资源

**适用性:Single 可用 / Cluster 需 hash tag 或逐个加锁**

#### Single:一个 Lua 原子拿多把锁

```lua
-- 全部成功才算成功,否则全部回滚
-- KEYS=锁key列表, ARGV[1]=token, ARGV[2]=ttl(ms)
for i = 1, #KEYS do
  if redis.call("SET", KEYS[i], ARGV[1], "NX", "PX", ARGV[2]) == false then
    -- 回滚已加的锁
    for j = 1, i - 1 do
      redis.call("DEL", KEYS[j])
    end
    return 0
  end
end
return 1
```

#### Cluster:两条路

**路线 A:用 hash tag 把锁收进同一 slot**

```
lock:{order:1001}:stock
lock:{order:1001}:coupon
lock:{order:1001}:balance
```

适用于这些锁天然属于同一业务实体的情况。

**路线 B:逐个加锁(类似 Redisson MultiLock)**

必须按**固定全局顺序**加锁,否则会死锁:

```go
// 关键:先排序,保证所有客户端的加锁顺序一致
func acquireMulti(ctx context.Context, rdb redis.Cmdable,
    keys []string, ttl time.Duration) ([]*Lock, error) {

    sorted := append([]string(nil), keys...)
    sort.Strings(sorted)   // 固定顺序,避免死锁

    var acquired []*Lock
    for _, k := range sorted {
        l, err := Acquire(ctx, rdb, k, ttl, true)
        if err != nil {
            // 回滚:反序释放已拿到的
            for i := len(acquired) - 1; i >= 0; i-- {
                _ = acquired[i].Release(ctx)
            }
            return nil, fmt.Errorf("acquireMulti %s: %w", k, err)
        }
        acquired = append(acquired, l)
    }
    return acquired, nil
}
```

#### 坑

- **不排序必死锁**:A 按 `[x, y]` 加锁、B 按 `[y, x]` 加锁,互等。
- 逐个加锁**不是原子的**。中途失败需要回滚,回滚期间可能有第三方插入。
- 锁的数量越多,整体成功率越低(各次成功率相乘)。

---

### 场景 9:Redlock

**适用性:Single 可用(N 个独立实例)/ Cluster 不适用**

#### 最常见的误解:Cluster ≠ Redlock 的 N 个实例

实测证明:同一个锁 key 在集群里只落一个 slot,**只有持有该 slot 的节点能写**,其余全是 `MOVED`:

```
$ docker exec redis-c1 redis-cli SET lock:r tokenX NX PX 10000
MOVED 13761 172.25.0.4:6379

$ docker exec redis-c2 redis-cli SET lock:r tokenX NX PX 10000
MOVED 13761 172.25.0.4:6379

$ docker exec redis-c3 redis-cli SET lock:r tokenX NX PX 10000
OK                                  ← 只有这个节点接受
```

所以"我有 3 节点集群,等于 Redlock 的 N=3"**是错的**。一把锁实际只由一个 master 负责,安全性等同单实例,故障时的异步复制竞态照旧存在。

真要跑 Redlock,必须部署 **5 个互不复制、互不组集群的独立 Redis 实例**。

这也解释了为什么 Redisson 把 RedLock 标记为 **deprecated**:官方说法是其"安全性保证存在争议",且要求多个独立实例的成本,在"单主 + 副本"或集群已是主流部署的现实下不划算。

#### 算法步骤(N 通常取 5)

1. 记下当前毫秒时间 `T1`
2. **并行**向 N 个实例发送同一个 key 和同一个 token 加锁,**每个请求用很短的超时**(锁 TTL 10 秒,则单请求超时取 5~50ms),避免卡在挂掉的节点上
3. 记下完成时间 `T2`,算总耗时
4. **当且仅当**拿到了**多数**(≥ N/2+1,即 5 取 3)**且** `T2-T1 < 锁TTL`,才算加锁成功
5. 实际有效期 = 初始 TTL − 加锁耗时 − 时钟漂移余量
6. 失败则**向所有实例发解锁**(包括自认为没锁上的)

#### 关键推论

- 真正可用时间 `MIN_VALIDITY = TTL - (T2-T1) - CLOCK_DRIFT`,必须在这个窗口内干完活
- 依赖**时钟漂移有界**假设(不要求时钟同步,但要求各机走表速率差不多)
- 失败要**随机延迟后重试**,避免多客户端同步重试导致谁都拿不到
- **崩溃恢复**:无持久化时节点重启会"遗忘"锁,可能让多数派重新成立,破坏安全性。严格保证需 `fsync=always`(很伤性能);实用替代是**延迟重启**——崩溃节点至少停过 max TTL 再重新加入
- 持续网络分区下,可用性惩罚等于一个 TTL,极端情况可无限期不可用

#### 必须知道的争议

官方文档自己挂了 Martin Kleppmann 的质疑和 antirez 的回应,并在 Disclaimer 里承认两点:

1. **必须实现 fencing token**(见场景 10)
2. **Redis 的 TTL 过期不用单调时钟**。墙上时钟被改(手动改时间、NTP 跳变)可能导致锁被多方持有

#### Go:Redsync

```go
import (
    "github.com/go-redsync/redsync/v4"
    "github.com/go-redsync/redsync/v4/redis/goredis/v9"
    goredislib "github.com/redis/go-redis/v9"
)

// 5 个互相独立的实例,不是一个集群!
func newRedlock() *redsync.Redsync {
    var pools []redsync.Pool
    for _, addr := range []string{
        "10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379",
        "10.0.0.4:6379", "10.0.0.5:6379",
    } {
        c := goredislib.NewClient(&goredislib.Options{Addr: addr})
        pools = append(pools, goredis.NewPool(c))
    }
    return redsync.New(pools...)
}

func useRedlock(rs *redsync.Redsync) error {
    mu := rs.NewMutex("lock:critical",
        redsync.WithExpiry(10*time.Second),
        redsync.WithTries(3),
        redsync.WithRetryDelayFunc(func(tries int) time.Duration {
            return time.Duration(rand.Intn(100)+50) * time.Millisecond // 随机退避
        }),
    )
    if err := mu.Lock(); err != nil {
        return err
    }
    defer mu.Unlock()
    // 临界区
    return nil
}
```

---

### 场景 10:强一致互斥

**适用性:Single 不够 / Cluster 不够**

这是本文最重要的一节。

#### 根本限制:锁过期 ≠ 持有者停止工作

考虑这个时序:

```
t=0    客户端 A 拿到锁,TTL 30 秒
t=5    A 开始处理,进入一次 Full GC(或被 OS 挂起、或容器被限流)
t=35   锁自动过期
t=36   客户端 B 拿到同一把锁,开始处理
t=40   A 的 GC 结束,A 以为自己还持有锁,继续写数据   ← 两个客户端同时写!
```

**光靠锁拦不住这种情况。** 这个问题独立于 Redis,对任何带超时的分布式锁都成立——包括 etcd 和 ZooKeeper。

#### 唯一的解法:fencing token

思路是让**被保护的资源**去拒绝过期的写入:

1. 每次加锁返回一个**单调递增**的 token
2. 客户端带着 token 去访问被保护资源
3. 资源记住见过的**最大 token**,拒绝任何更小的

```
t=0    A 加锁,得到 token=33
t=5    A 进入 GC
t=35   锁过期
t=36   B 加锁,得到 token=34
t=37   B 带 token=34 写入 → 资源记录 max_token=34,接受
t=40   A 带 token=33 写入 → 33 < 34,资源拒绝        ← 被拦住了
```

官方 Disclaimer 明确指出:这对耗时较长的处理尤其重要,而且**适用于任何分布式锁系统**。

#### 实现方式

**方式 A:Redis 侧生成 token**

```lua
-- 加锁同时取递增 token
-- KEYS[1]=锁key KEYS[2]=token计数器key  ARGV[1]=持有者id ARGV[2]=ttl(ms)
-- 注意:集群下 KEYS[1] 和 KEYS[2] 必须同 slot!
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  local token = redis.call("INCR", KEYS[2])
  redis.call("HSET", KEYS[1] .. ":meta", "token", token)
  return token
end
return 0
```

集群下记得用 hash tag:

```
lock:{order:1001}
lock:{order:1001}:seq
```

**方式 B:Redisson 的 RFencedLock**(Java)

```java
RFencedLock lock = redisson.getFencedLock("myLock");
Long token = lock.lockAndGetToken();        // 单调递增 token
// 或 tryLockAndGetToken(),失败返回 null
// getToken() 只读当前 token,不加锁
```

**方式 C:数据库侧用版本号兜底**

如果被保护资源是数据库,直接用乐观锁:

```sql
UPDATE orders
   SET status = 'paid', lock_token = 34
 WHERE id = 1001
   AND lock_token < 34;     -- 拒绝过期的写入
```

这是最朴素也最可靠的做法:**不管锁怎么失效,数据库这一关挡得住**。

#### 什么时候该换掉 Redis 锁

| 情况 | 建议 |
|---|---|
| 冲突少、偶发失败可重试、代价可接受 | Redis 锁够用 |
| 临界区很短(毫秒级),且有 fencing | Redis 锁够用 |
| 临界区长(秒级以上),有 GC/挂起风险 | 必须 fencing token |
| 要求"绝对不能双写",且无法在资源侧做 fencing | 换 **etcd**(Raft)或 **ZooKeeper**(ZAB) |
| 需要 leader election、成员管理 | 换 etcd / ZooKeeper |

etcd / ZooKeeper 用共识协议保证写入线性一致,锁的获取本身是强一致的。代价是吞吐量比 Redis 低一到两个数量级。

**但请注意:即便用 etcd,"锁过期但持有者还在跑"的问题依然存在**,fencing token 仍然必要。共识协议解决的是"谁持有锁"的一致性,不解决"持有者是否还活着"。

#### Redisson 的工程缓解(供参考)

Redisson 对主从异步复制竞态有具体缓解措施:

- `checkLockSyncedSlaves`:**默认开启**,加锁后校验是否已到达副本
- `slavesSyncTimeout`:默认 **1000ms**,等待副本确认的超时
- 副本在超时内没确认,Redisson **放弃该锁并让加锁失败**

其他细节:

- `RLock` 是**可重入**的,所有权绑线程 ID。别的线程解锁抛 `IllegalMonitorStateException`(需跨线程释放就用 `RSemaphore`)
- **看门狗默认 30 秒**(`Config.lockWatchdogTimeout`),**只在不传 leaseTime 时生效**。传了 `lock(10, SECONDS)` 就按固定租期到点自动释放,不再续期
- 锁等待基于 pub/sub 通知;只有 Spin Lock 用指数退避轮询(锁极多时 pub/sub 会打满网络,因为消息要发给集群所有节点)
- 公平锁有个坑:队列里每个死掉的线程要等 5 秒,5 个死线程 = 延迟 25 秒

---

## 两类错误,两种命运

这是单实例下最高频的考点,也是实测最容易记反的点。

| 错误发生时机 | 典型原因 | 结果 |
|---|---|---|
| **入队期** | 命令名拼错、参数个数不对、OOM | `EXEC` 直接报 `EXECABORT`,**整单丢弃,一条都不执行** |
| **运行期** | 类型错(对 String 用 `LPOP`) | 该条返回错误,**其余命令照样执行** |

实测 A:入队期错误

```
MULTI         → OK
INCR a b c    → (error) ERR wrong number of arguments for 'incr' command
SET k1 v1     → QUEUED
EXEC          → (error) EXECABORT Transaction discarded because of previous errors.
GET k1        → (nil)        ← 整单没执行
```

实测 B:运行期错误

```
MULTI         → OK
SET s abc     → QUEUED
LPOP s        → QUEUED
SET s2 ok     → QUEUED
EXEC          → 1) OK
                2) (error) WRONGTYPE Operation against a key holding the wrong kind of value
                3) OK
GET s2        → "ok"         ← 错误没拦住后面的命令
```

入队期检测是 **2.6.5** 起才有的。更老的版本得靠客户端自己检查每条命令是否回了 `QUEUED`。

**工程含义:不要指望 Redis 事务帮你保证业务一致性。** 需要"失败就全部不生效"的语义,只能用 Lua 脚本,或者在业务层做补偿。

---

## 本项目落地建议

本项目(`rocket-nano`)的实际情况:

- 客户端:`github.com/redis/go-redis/v9 v9.5.1`
- 抽象层:`internal/generic/global/global.go` 暴露 `RedisClient redis.Cmdable`
- 模式切换:配置项 `redis.player.mode`,值为 `cluster` 时用 `NewClusterClient`,否则 `NewClient`

### 建议 1:因为支持 cluster 模式,现在就别写跨 key 的 MULTI/WATCH

这是最关键的一条。由于 `redis.player.mode` 可以切到 `cluster`,任何跨 key 的 `MULTI`/`WATCH` 代码在切换后会失败——**而且因为 `CROSSSLOT` 是 `EXEC` 期才报错,单元测试如果只跑单实例就完全覆盖不到**。

替代方案优先级:
1. 把状态收进**一个 key**(Hash),用单 key Lua
2. 确实需要多 key,用 **hash tag** 绑定,并在 code review 时检查
3. 实在不行,业务层做补偿,不依赖 Redis 原子性

### 建议 2:注意 `Cmdable` 接口的两个缺口

实测确认:

```go
// Cmdable 接口里有:
Pipeline() Pipeliner
TxPipelined(ctx, fn) ([]Cmder, error)
TxPipeline() Pipeliner

// Cmdable 接口里没有:
// - Watch(...)   → 定义在 *Client / *ClusterClient / *Ring 上
// - Do(...)      → 同上
```

所以:
- 用 `TxPipelined` 做事务:**可以**直接用 `global.RedisClient`
- 用 `WATCH` 做乐观锁:**必须**类型断言(见场景 4 的 `watcher` 接口写法)
- 发 8.4 新命令如 `DELEX ... IFEQ`:**必须**断言出 `Do` 方法(v9.5.1 没有封装)

建议在 `global` 包里补两个辅助函数,把断言收敛到一处:

```go
// 建议新增到 internal/generic/global
func RedisWatcher() (interface {
    Watch(context.Context, func(*redis.Tx) error, ...string) error
}, bool) {
    w, ok := RedisClient.(interface {
        Watch(context.Context, func(*redis.Tx) error, ...string) error
    })
    return w, ok
}

func RedisScripter() (redis.Scripter, bool) {
    s, ok := RedisClient.(redis.Scripter)
    return s, ok
}
```

### 建议 3:锁的写法两种模式通用,直接固化成库

场景 7 的 `Lock` 实现在 single 和 cluster 下行为一致,可以直接放进 `internal/generic` 下复用。要点:

- 用 `SetNX(ctx, key, token, ttl)`(go-redis 的 `SetNX` 就是 `SET key val NX PX ttl`)
- token 用 `crypto/rand` 20 字节
- 释放和续期都走 Lua 校验 token
- 续期失败(返回 0 或报错)必须视为"已失去锁",通知业务中止

### 建议 4:给关键临界区加 fencing token

如果有"扣款""发货"这类不能重复执行的操作,不要只靠 Redis 锁。在数据库侧加一个版本号/token 列,用 `WHERE token < ?` 兜底(见场景 10 方式 C)。

### 建议 5:避免慢 Lua 脚本

本项目若有 Lua 脚本,确认其执行时间。写过数据的脚本**无法被 `SCRIPT KILL`**,一个循环写错就要 `SHUTDOWN NOSAVE`。建议:

- 脚本里不写无界循环
- 批量操作加数量上限,大批量拆成多次调用
- 上线前用 `redis-cli --latency` 观察 P99

---

## 附录:实验环境复现

### 单实例

```bash
docker run -d --name redis-lab -p 6399:6379 redis:8-alpine \
  redis-server --save '' --appendonly no

# 开客户端(事务实验需要两个窗口互相干扰)
docker exec -it redis-lab redis-cli
```

### 3 主集群

```bash
docker network create redis-lab-net

for i in 1 2 3; do
  docker run -d --name redis-c$i --network redis-lab-net redis:8-alpine \
    redis-server --cluster-enabled yes --cluster-config-file nodes.conf \
    --cluster-node-timeout 5000 --save '' --appendonly no
done

# 取各节点 IP 后建集群
IPS=""
for i in 1 2 3; do
  IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' redis-c$i)
  IPS="$IPS $IP:6379"
done
docker exec redis-c1 sh -c "redis-cli --cluster create $IPS --cluster-yes"
```

### 复现 CROSSSLOT 的注意事项

实验时容易被 `MOVED` 干扰。要观察事务的真实行为,必须**连到实际持有该 slot 的节点**,否则会先收到 `MOVED` 而看不到 `CROSSSLOT`:

```bash
# 先查 key 在哪个 slot
docker exec redis-c1 redis-cli CLUSTER KEYSLOT '{u}:1'    # → 11826

# 查哪个节点持有该 slot
docker exec redis-c1 redis-cli CLUSTER NODES | grep 11826

# 连那个节点做实验
docker exec redis-c3 sh -c 'printf "MULTI\r\nSET {u}:1 A\r\nSET {u}:2 B\r\nEXEC\r\n" | redis-cli --no-raw'
```

用 `redis-cli -c` 会自动跟随重定向,适合测单 key 操作;但测事务时它无法在节点间搬迁已入队的命令,所以要手动连对节点。

### 清理

```bash
docker rm -f redis-lab redis-c1 redis-c2 redis-c3
docker network rm redis-lab-net
```

---

## 参考资料

- [Transactions | Redis Docs](https://redis.io/docs/latest/develop/using-commands/transactions/)
- [Multi-key operations | Redis Docs](https://redis.io/docs/latest/develop/using-commands/multi-key-operations/)
- [Distributed Locks with Redis | Redis Docs](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- [Scripting with Lua | Redis Docs](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [EXEC | Redis Docs](https://redis.io/docs/latest/commands/exec/)
- [MULTI | Redis Docs](https://redis.io/docs/latest/commands/multi/)
- [BLPOP | Redis Docs](https://redis.io/docs/latest/commands/blpop/)
- [Locks and synchronizers | Redisson Docs](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/)
- [How to do distributed locking | Martin Kleppmann](http://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Is Redlock safe? | antirez](http://antirez.com/news/101)
