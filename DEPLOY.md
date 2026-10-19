# 部署指南（开发模式 · 不用 Docker）

这份文档写给**拿到仓库、要在自己机器上跑起一套一样系统**的人。

按下面的顺序做完，你能得到一个和源机器**功能完全一致**的 OpenMAIC。
注意是「功能一致」不是「内容一致」——课程、上传的素材、知识库索引都在原来的数据库里，不会跟着仓库走。要连内容一起搬，见最后一节。

---

## 一、前置条件

| 需要 | 版本 | 备注 |
| --- | --- | --- |
| **Node.js** | **>= 22.19**（建议 22 LTS） | 仓库里有 `.nvmrc`，写的是 `22`。低于 22.19 会装不上 |
| **pnpm** | **>= 10** | 没装的话：`corepack enable` |
| **PostgreSQL** | **13 以上**（源机器用 17） | **必须装，且必须能连上**，详见下面的专门说明 |

### 关于 PostgreSQL —— 这是必须的，不是可选

**请把它当成和 Node 同级的硬性前提，不要抱着「先跑起来看看」的心态跳过。** 源机器上：

- **课程库 / 共享课程** —— 存在 PostgreSQL 里（不是浏览器里）
- **Pro 工作台**（会话、消息、素材、发布状态）—— 存在 PostgreSQL 里
- **Agent 运行时**（`/api/agent/runtime` 返回的 `persistence: true`）—— 靠它
- **知识库 / 向量检索** —— 也在这里

不装或连不上的后果：界面**能打开**，但一进工作台或点课程就是各种失败，而且报错不会明确告诉你是数据库的问题。这会浪费你很多时间去怀疑别的地方。**所以先把数据库搞通，再做后面任何事。**

### 版本

代码里**没有版本门限**（没有 `CREATE EXTENSION`，也没有版本判断）。用到的都是 `ADD COLUMN IF NOT EXISTS`、`ON CONFLICT ... DO UPDATE` 这类 9.6 时代就有的语法，所以**13 以上任何版本都能跑**。源机器用的是 17，Docker 配置里用的是 16，这两个都验证过。**推荐装 16 或 17。**

### 不需要装 pgvector 之类的扩展

**这点可以省你很多功夫**：本项目的向量检索**不依赖 `pgvector`**。向量是以普通的 `bytea` 列存的（little-endian float32），相似度计算在应用层做（见 `lib/persistence/knowledge-base.ts`）。所以**装一个原版 PostgreSQL 就够了**，不要去折腾扩展编译。

### Windows 上怎么装

1. 去 <https://www.postgresql.org/download/windows/> 下载 EDB 安装包（选 16 或 17）
2. 装的时候会**让你设一个 `postgres` 超级用户密码 —— 记下来，第 4 步配 `DATABASE_URL` 要用**
3. 端口保持默认 **5432**
4. 装完确认服务在跑：服务管理器里应该有一个 `postgresql-x64-17` 之类的服务，状态是"正在运行"，或者命令行跑：

   ```bash
   netstat -ano | grep 5432
   ```

   能看到 `LISTENING` 就对了。

> 如果你用 `winget`：`winget install PostgreSQL.PostgreSQL.17`，但**它默认装的密码和端口需要自己确认**，还是推荐用 EDB 的图形安装包。
>
> 如果已经装了但忘了密码，重装比找回快。

---

## 二、操作步骤

### 第 1 步：拿代码

```bash
git clone https://github.com/sky897021-afk/openmaic-pro.git
cd openmaic-pro
```

### 第 2 步：装依赖

```bash
pnpm install
```

**这一步不能跳过、不能中途 Ctrl-C。** 它除了装依赖，还会自动跑 `postinstall`：

- 编译 `packages/` 下的 8 个子包（`@openmaic/storage`、`@openmaic/dsl`、`@openmaic/importer` 等）
- 生成运行时需要的 `public/vendor/maic-importer/index.js`（PPTX 导入功能靠它）

比普通项目慢很多，属正常。

> 如果中间断了，补一条即可：
> ```bash
> pnpm --filter @openmaic/importer build && pnpm run sync:maic-importer
> ```

### 第 3 步：准备数据库

**先确认你能连上 PostgreSQL**（很多人卡在这里，因为 Windows 安装时**不会**把 `psql` 加进 PATH）：

```bash
# 如果这句报 "command not found"，用完整路径，例如：
#   "/c/Program Files/PostgreSQL/17/bin/psql" -U postgres -h localhost -c "select version();"
psql -U postgres -h localhost -c "select version();"
```

能打印出版本号（类似 `PostgreSQL 17.x ...`）就说明数据库通了。会提示输密码 —— 就是安装时你设的那个。

然后建库：

```bash
createdb -U postgres -h localhost openmaic
```

**不需要任何 `.sql` 脚本。** 这个项目没有迁移文件，建表逻辑内嵌在服务启动流程里，连上空库就会自动建好全部表。

> **`psql` / `createdb` 不在 PATH 怎么办？**
> 两个办法：
> 1. 用完整路径（把 `17` 换成你装的版本）：`"/c/Program Files/PostgreSQL/17/bin/createdb" -U postgres -h localhost openmaic`
> 2. 或者干脆用图形工具：装 EDB 时自带的 **pgAdmin**，右键 `Databases` → `Create` → 填 `openmaic`，存盘即可。效果一样。
>
> **但库本身一定要建。** 服务端只会自动建**表**，不会自动建**库** —— 连不上目标库它会报错。这一步不能省，省的是"用哪种方式建"。

### 第 4 步：配置 `.env.local`

```bash
cp .env.example .env.local
```

然后编辑 `.env.local`。下面分三类，**第三类才是让系统变成「和源机器一样」的关键**。

#### ① 至少配一个 LLM 提供商

不配的话界面能打开，但生成不了任何内容。

```env
OPENAI_API_KEY=你的key
OPENAI_BASE_URL=你的接口地址
OPENAI_MODELS=模型名
```

（也可以用 `ANTHROPIC_*` / `DEEPSEEK_*` / `QWEN_*` 等任意一个，`.env.example` 里都有。）

#### ② 数据库连接

```env
DATABASE_URL=postgres://postgres:你的密码@localhost:5432/openmaic
```

四个部分分别对应：

```
postgres://  postgres  :  你的密码  @  localhost  :  5432  /  openmaic
  协议        用户名                    主机名        端口      库名
```

- 用户名：如果安装后没建过别的用户，就是 `postgres`
- 密码：**安装 PostgreSQL 时你设的那个**（不是 `.env.example` 里任何值）
- 库名：就是第 3 步建的 `openmaic`

⚠️ **密码里如果有 `@` `:` `/` `#` 这些字符，URL 里必须转义**（`@` 写成 `%40`，`#` 写成 `%23`）。这是最常见的"配置看着没问题但连不上"的原因。密码里带这些符号的话，建议先直接改成一个纯字母数字的密码省事。

#### ③ 让系统行为和源机器一致的开关

**变量名照抄，值自己填。**

```env
# --- 服务端持久化 ---
NEXT_PUBLIC_PERSISTENCE=1

# --- Pro 工作台 ---
NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true
OPENMAIC_AGENT_RUNTIME_ENABLED=true

# --- 模型路由（agent 必须显式指定，没有兜底）---
MODEL_ROUTES={"maic-agent-driver":{"model":"openai:你的模型名","api":"openai-completions"}}
DEFAULT_MODEL=openai:你的模型名

# --- 所有人共用一个课程库 ---
PERSISTENCE_SHARED_OWNER_ID=openmaic-shared
PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true

# --- 单游戏模式 ---
OPENMAIC_SINGLE_GAME_MODE=true

# --- 向量知识库（语义检索用的嵌入模型）---
KNOWLEDGE_BASE_EMBEDDING_MODEL=openai:你的嵌入模型名
```

**关于 `NEXT_PUBLIC_PERSISTENCE`**：⚠️ 它**只认 `1`**，不认 `true`（代码里是 `=== '1'`）。上面其他开关用的是 `true`，唯独这个是数字 —— 写成 `true` 会静默失效，表现就是 `persistence: false`。

**关于 `MODEL_ROUTES`**：格式是 `{"路由名":{"model":"提供商:模型","api":"openai-completions"}}`。`maic-agent-driver` 必须显式路由，**没有默认值**，不填 agent 起不来。`api` 取 `openai-completions` 或 `openai-responses`。

**关于 `PERSISTENCE_SHARED_OWNER_*`**：这两个变量合起来的效果是「所有访问者共用同一个课程库，且不需要访问码」。
⚠️ 单独设 `PERSISTENCE_SHARED_OWNER_ID` 会让**服务启动失败**，必须二选一：

- 配 `ACCESS_CODE`（有密码的共享库），或
- 显式写 `PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true`（声明「这是内网，故意不设码」）

源机器用的是后者。启动时服务端会打一条警告，这是**预期行为，不是故障**。

### 第 5 步：启动

```bash
pnpm dev
```

默认端口 **3000**。换端口：

```bash
pnpm dev -- -p 3003
```

看到 `Ready` 就可以访问了：`http://localhost:3000`（或你指定的端口）。

---

## 三、验收

依次确认这几条，全对说明配置没问题：

```bash
curl http://localhost:3000/api/health
```

期望返回类似：

```json
{"success":true,"status":"ok","version":"1.1.1","accessCodeConfigured":false,"capabilities":{...}}
```

```bash
curl http://localhost:3000/api/agent/runtime
```

期望返回：

```json
{"enabled":true,"runtimeEnabled":true,"persistence":true}
```

这两个 `true` 是重点：

- `enabled` / `runtimeEnabled` → `OPENMAIC_AGENT_RUNTIME_ENABLED` 生效了
- `persistence` → **`DATABASE_URL` 通了**

**如果 `persistence` 是 `false`，按这个顺序查：**

1. `DATABASE_URL` 写了吗？`NEXT_PUBLIC_PERSISTENCE=1` 写了吗？（两个都要）
2. 数据库服务在跑吗？
   ```bash
   netstat -ano | grep 5432
   ```
   没有 `LISTENING` 就是 PostgreSQL 服务没起来。
3. 密码对不对、有没有需要转义的字符（见第 4 步 ②）？用 `psql` 手动连一次最直接：
   ```bash
   psql "postgres://postgres:你的密码@localhost:5432/openmaic" -c "select 1;"
   ```
   这条能通，`DATABASE_URL` 就一定是对的。
4. 库 `openmaic` 建了吗？（服务端不会自己 `CREATE DATABASE`）
5. 改完 `.env.local` **重启过服务吗**？（见第五节第 4 条）

拿不准的时候看服务端启动日志，连库失败会打明确的行。

然后是界面：

1. 打开首页，能看到 **Pro 工作台**入口 → `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` 生效了
2. 进工作台，建一个会话，发一句话 → LLM 配置通了
3. 传一个 `.md` 文件当素材，挂到会话上 → 数据库和素材链路通了

---

## 四、局域网访问（重要）

如果别人要**从另一台机器**用浏览器访问这台机器上的服务（比如 `http://192.168.1.50:3003`），需要注意一件事：

开发模式下，Next.js 会拦截「跨来源」的请求。仓库里已经打好了补丁（`next.config.ts`）：

```ts
allowedDevOrigins: ['127.0.0.1', '192.168.*.*', '10.*.*.*'],
```

**也就是说：`192.168.x.x` 和 `10.x.x.x` 开头的局域网地址可以直接访问，不用改任何东西。**

如果你的局域网用的是 **`172.16` ~ `172.31` 段**，需要自己去 `next.config.ts` 那行里加一条，否则表现是「页面打开了但没反应」——不是打不开，是打开了但点不动。这一点很容易误判成程序坏了。

从别的机器访问时，还要确认系统防火墙放行了那个端口。

---

## 五、开发模式的注意事项

你用的是 `next dev`（开发模式），有几个和 `next build` 不一样的脾气：

**1. 第一次打开每个页面会比较慢。**
开发模式是「用到才编译」。第一次访问某个页面，服务端要现场编译，可能等十几秒。之后就好了；重启服务后又要重来一次。

**2. 同一个目录只能开一个开发服务器。**
再开一个（哪怕换了端口）会被拒绝并提示已有实例在跑。要换端口就先停掉原来的。

**3. 不要在这个目录里跑 `pnpm build`。**
本机历史上出现过开发服务器「假死」——端口还在监听、进程还活着、CPU 是 0，但连接上了不返回任何数据。怀疑和「开发服务器运行期间在同一目录执行 `next build`」有关。想验证生产模式，请**另克隆一份到别的目录**去 build。

**4. 改 `.env.local` 之后手动重启服务。**
Next 会监视这个文件并尝试自我重启，但这个过程不稳定（也是上面那个假死事故的疑似原因之一）。改了配置就自己 Ctrl-C 再 `pnpm dev`。

**5. 开发模式改配置不需要重新 build。**
这是开发模式相比生产模式最省事的地方：`NEXT_PUBLIC_*` 这类「构建期变量」在生产模式下必须重新 `pnpm build`，而在开发模式下**重启一下服务就生效**。

---

## 六、安全提醒

**1. 默认没有登录、没有访问码。**
这是 `PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true` 的效果：**谁能访问到这个地址，谁就能查看、修改、发布同一个课程库**。放在内网上没问题（这正是设计意图），但如果要暴露到公网，**必须先设 `ACCESS_CODE`**，否则等于把整个库公开。

**2. 不要把源机器的 `.env.local` 直接发给别人。**
那里面有 API key 和数据库密码。正确做法是把**变量名清单**给对方，让他填自己的 key——上面第 4 步那份清单就是干这个用的。

---

## 七、可选：连数据一起搬

默认情况下对方拿到的是**空白系统**：代码和功能完全一样，但没有课程、没有素材、没有知识库索引。

要连内容一起搬，才需要这两样：

```bash
# 源机器导出（openmaic_dev 是源机器的库名，你那边按实际填）
pg_dump -U postgres -h localhost -d openmaic_dev > openmaic.sql

# 目标机器导入
createdb -U postgres -h localhost openmaic
psql -U postgres -h localhost -d openmaic -f openmaic.sql
```

（`pg_dump` / `psql` 同样可能不在 PATH，用完整路径，见第 3 步。）

要一起给的还有：

- `data/` 目录（素材的原始字节文件）

**想清楚再给。** 这个 dump 里有对方不需要的全部课程、会话记录和上传的课件。对方如果只是想自己跑一套，**给 `.env.local`（变量名）+ 一个 API key 就够了**。

---

## 八、已知限制

- **`.doc` / `.docx` 素材抽不出文本。** 这个部署没有配置对应的文档抽取器，所以这两种格式传上去当知识库用不了。**用 `.md` 格式代替**是可行的做法。
- **数据库表是服务启动时自建的**，所以给一个完全空的库就行，不要试图手工建表。