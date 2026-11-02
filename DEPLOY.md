# OpenMAIC 部署与外部平台接入指南

本文档面向两类读者：

- 在自己机器或内网服务器上部署 OpenMAIC 的运维人员。
- 需要从外部教学平台后端调用 OpenMAIC 的开发者。

文档覆盖当前两个集成模块：

- **模块一：完整课程生成**。外部平台负责提示词和大纲编辑界面，OpenMAIC 负责原始文件解析、大纲生成和完整课程生成。
- **模块二：单游戏生成交接**。外部平台上传素材并创建 handoff，浏览器进入 OpenMAIC 完成单游戏生成，平台轮询结果。

机器可读接口契约见 [integration/openapi.yaml](./integration/openapi.yaml)。如果本文与代码不一致，以实际路由和 OpenAPI 文件为准。

> 仓库只提供代码和空白运行环境。已有课程、会话、知识库、素材和集成记录不会随 Git 仓库一起迁移。完整迁移见“备份、恢复与迁移”章节。

---

## 0. 功能一致的“新空系统”

接收方从 GitHub 下载并完成本指南后，得到的是与交付方**代码版本和功能一致、但数据为空**的 OpenMAIC。它不是当前运行实例的完整克隆。

| 内容 | 是否随 GitHub 交付 | 新部署如何处理 |
| --- | --- | --- |
| 应用代码、数据库结构、文档解析器、Agent Runtime、Pro 工作台、模块一和模块二接口 | 是 | 从仓库获取，Docker 重新构建 |
| `install.ps1`、`.env.example`、`DEPLOY.md` | 是，前提是发布方已经提交并推送 | 用于生成接收方自己的 `.env.local` 和容器 |
| `.env.local` | 否 | 接收方按提示输入自己的模型服务信息；安装器生成访问码、集成密钥和数据库密码 |
| PostgreSQL 数据库 | 否 | 新建空数据库；课程、Pro 会话、知识库索引和用户数据均为空 |
| `data/` | 否 | 新建空数据卷；没有交付方已有的课程媒体、素材和 handoff 记录 |
| `node_modules/`、`.next/` | 否 | Docker 构建时在接收方机器重新安装依赖和编译 |
| Docker 镜像、构建缓存、`.pnpm-store` | 否 | 接收方机器重新拉取和构建 |

接收方开始安装前，先分清下面四类内容：

| 类别 | 接收方需要做什么 |
| --- | --- |
| 必须自己准备 | 一个可用的 OpenAI-compatible 模型服务，并在安装器中输入 `OPENAI_BASE_URL`、精确的模型 ID（写入 `OPENAI_MODELS` 和 `DEFAULT_MODEL`）以及 `OPENAI_API_KEY`。要复现当前知识库向量检索能力，还要准备一个可用的嵌入模型（写入 `KNOWLEDGE_BASE_EMBEDDING_MODEL`，例如 `openai:<embedding-model-id>`）；不准备时可在安装器里留空关闭向量索引，但功能不等价。其他非 OpenAI-compatible 提供商可以按 `.env.example` 手工配置。 |
| 安装器自动生成 | `.env.local`、`ACCESS_CODE`、`INTEGRATION_SHARED_SECRET`、PostgreSQL 密码、模型基础路由、3003 端口配置、空数据库卷和空 `data` 卷。不要从交付方复制这些值。 |
| 按需自己补充 | 特殊 `MODEL_ROUTES`、扫描件/图片视觉 OCR（`page-transcription`、`VISION_OCR_*`）、TTS（`TTS_*`）、ASR（`ASR_*`）、图片生成（`IMAGE_*`、`DEFAULT_IMAGE_PROVIDER`、`IMAGE_MIN_PIXELS`）、视频、联网搜索、第三方 PDF/MinerU/AliDocMind，以及可选的 `server-providers.yml`。这些能力必须使用接收方自己的账号、地址和密钥；当前实例没有额外配置的项，新实例也不需要凭空填写。 |
| 不会自动交付 | 交付方现有 PostgreSQL 数据和 `data/` 内容（课程、会话、知识库、素材、handoff、集成记录），以及 `.env.local`、`node_modules/`、`.next/`。除非明确做“数据迁移”，否则新实例按空库启动。 |

因此，接收方只要把代码下载完整，并按本指南填写自己的模型配置，就能得到相同的程序功能；模型生成效果、外部 OCR/TTS/ASR/图片等能力是否与当前实例一致，取决于接收方是否配置了等价服务。当前实例没有单独的 OCR 视觉路由、TTS、ASR、图片生成或 `server-providers.yml`，这些可选项的精确变量和配置方法见 4.4。

因此：

- “功能一致”表示同一份代码、同一套入口和接口、同一套生成流程。
- “数据一致”不会自动成立。需要旧课程、旧知识库或旧集成任务时，必须同时迁移 PostgreSQL 和 `data/`，见第 14 章。
- 模型输出是否完全一致还取决于接收方是否使用相同或等价的模型服务、模型 ID、路由和密钥权限。密钥不能从交付方复制。
- 发布方必须先确认当前工作区中的 `install.ps1`、模块一/模块二路由、文档解析器和相关依赖都已提交并推送到 GitHub；仅存在于本机的文件不会被接收方下载到。

## 交接：接收方最短安装流程

这条流程面向拿到代码、要在自己的 Windows 电脑或内网服务器上运行 OpenMAIC 的人。推荐使用仓库根目录的 [install.ps1](./install.ps1)，不要手工复制你的 `.env.local`。

1. 在接收方任意本地盘准备至少 30 GB 可用空间，C、D、E 盘均可。把 Docker Desktop 安装包下载到空间充足的位置并安装。
2. 启动 Docker Desktop，在 `Settings -> Resources -> Advanced -> Disk image location` 选择一个空间充足的磁盘映像位置，例如 `D:\Docker\DockerDesktop`。如果 C 盘空间充足，也可以保留 Docker Desktop 的默认位置。
3. 通过私有 Git 仓库或 ZIP 获取本项目，解压到任意位置，例如 `D:\OpenMAIC-dev`。`install.ps1` 不绑定盘符。不要拿源机器的 `.env.local`、`.git`、`node_modules`、`.next`、`.pnpm-store` 或 `data`。
4. 在项目根目录打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

5. 按提示填写模型 Base URL、Model ID、模型密钥和知识库向量模型。密钥输入时不会回显。知识库向量模型使用 `provider:model` 格式；首次安装留空会关闭知识库向量索引，已有值可按回车保留，也可以输入 `-` 清除。要与当前实例保持同一套知识库检索能力，填写交付方提供的嵌入模型，例如 `openai:qwen3.7-text-embedding`，但必须使用接收方自己的模型密钥。脚本会自动生成访问码、集成密钥和数据库密码，并默认使用宿主机 `3003` 端口。
6. 首次构建通常需要几分钟。看到 `OpenMAIC is running` 后，记录脚本输出的 `URL` 和 `Access code`。
7. Windows 防火墙询问时，仅允许专用网络访问 TCP `3003`。如果没有弹窗，以管理员 PowerShell 放行：

```powershell
New-NetFirewallRule `
  -DisplayName "OpenMAIC 3003" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3003 `
  -Action Allow
```

8. 在接收方电脑打开 `http://localhost:3003`，确认页面出现并输入访问码。再从同一局域网的另一台电脑打开脚本输出的 `http://<局域网IP>:3003`，确认远程访问正常。
9. 如果平台也要接入，分别复制 `.env.local` 中的 `OPENMAIC_BASE_URL` 和 `INTEGRATION_SHARED_SECRET` 给平台后端配置。前者可以走普通交接文档，后者只能通过密码库、加密文件或其他安全渠道传递。

交接时不要把源机器的 `.env.local` 直接发给别人。它包含模型密钥、数据库密码、教师访问码和平台集成密钥，而且其中的数据库主机名、局域网 IP 和端口只适用于原机器。

建议按角色分别交付最小信息：

| 接收人 | 应交付 | 不应交付 |
| --- | --- | --- |
| 安装 OpenMAIC 的运维人员 | 代码仓库或 ZIP、本文档、模型服务地址、模型 ID、模型密钥 | 源机器数据库、源机器 `.env.local` |
| 使用课程的教师 | `http://<局域网IP>:3003`、`ACCESS_CODE` | 模型密钥、数据库密码、集成密钥 |
| 对接平台的开发者 | `OPENMAIC_BASE_URL`、单独安全传递的 `INTEGRATION_SHARED_SECRET`、模块一/模块二接口说明 | `ACCESS_CODE`（除非其也需要登录）、模型密钥 |

如果对方没有 Git 访问权限，可在源机器 E 盘生成一个不含密钥和运行数据的 ZIP：

```powershell
Set-Location E:\
tar.exe -a -c -f E:\OpenMAIC-handoff.zip `
  --exclude='.git' `
  --exclude='node_modules' `
  --exclude='.next' `
  --exclude='.pnpm-store' `
  --exclude='data' `
  --exclude='.env.local*' `
  OpenMAIC-dev
```

ZIP 只用于交付程序代码。已有课程、Pro 会话、知识库和素材不会包含在内；需要迁移这些内容时，按后文“备份、恢复与迁移”同时迁移 PostgreSQL 和 `data/`，并单独加密传输。

---

## 1. 先选择部署方式

| 方式 | 适用场景 | 默认访问端口 | 数据库 |
| --- | --- | --- | --- |
| Docker Compose + `install.ps1` | 内网服务器、长期运行、交接给他人 | 宿主机 `3003` | Compose 内置 PostgreSQL 16 |
| 手工 Docker Compose | 已能自行维护环境变量的人员 | 宿主机 `3000` | Compose 内置 PostgreSQL 16 |
| Windows 本地开发 | 开发、调试、快速验收 | `3003` | 本机 PostgreSQL 16 或 17 |

两个端口的含义不同：

- `docker-compose.yml` 使用 `OPENMAIC_HOST_PORT` 控制宿主机端口；未设置时回退到 `3000`。
- `install.ps1` 默认写入 `OPENMAIC_HOST_PORT=3003`，所以推荐安装后的访问地址是 `http://<主机>:3003`。
- `pnpm dev:3003` 只用于本地开发，访问地址是 `http://<主机>:3003`。
- 容器内部始终监听 `3000`。无论宿主机使用哪个端口，都不要把容器内部端口改成 `3003`。

部署前先固定最终访问地址，例如：

```text
http://192.168.10.221:3003
```

后续以下两个变量必须使用同一个、浏览器真实可访问的地址：

```env
OPENMAIC_BASE_URL=http://192.168.10.221:3003
INTEGRATION_PUBLIC_BASE_URL=http://192.168.10.221:3003
```

如果平台后端可以通过内网域名访问 OpenMAIC，但老师的浏览器打不开该域名，返回给平台的课程链接仍会失效。`INTEGRATION_PUBLIC_BASE_URL` 必须以浏览器可达为准，不能写 `localhost`、`127.0.0.1` 或 Docker 内部服务名。

### 磁盘位置：源机器固定 E 盘，接收方任选

本仓库当前这台源机器有单独约束：新下载、依赖、构建产物、Docker 镜像和部署数据都放在 E 盘。这是源机器的交付要求，不是接收方的使用限制。

交接给其他接收方时，项目、Docker 磁盘映像、运行数据和备份都可以放在任意空间充足的本地盘。`install.ps1` 以脚本所在目录作为项目根目录，不检查盘符，也不要求使用 E 盘。接收方执行后文命令时，只需把示例中的 `E:\OpenMAIC-dev` 和 `E:\OpenMAIC-backup` 替换成自己的实际路径。

源机器当前使用以下位置：

- 仓库：`E:\OpenMAIC-dev`
- pnpm store：`E:\OpenMAIC-dev\.pnpm-store`
- Docker Desktop 磁盘映像：`E:\Docker\DockerDesktop`
- 备份：`E:\OpenMAIC-backup`

pnpm 可在当前 PowerShell 会话这样配置：

```powershell
$env:PNPM_HOME = 'E:\OpenMAIC-dev\.tools\pnpm'
$env:PNPM_STORE_DIR = 'E:\OpenMAIC-dev\.pnpm-store'
$env:COREPACK_HOME = 'E:\OpenMAIC-dev\.cache\corepack'
$env:PATH = "$env:PNPM_HOME;$env:PATH"
```

源机器必须在拉取镜像前把 Docker Desktop 的 Linux 引擎、镜像、容器层和 build cache 迁移到 E 盘。接收方则把下面的 `E:\Docker\DockerDesktop` 换成自己选定的磁盘位置：

```text
Docker Desktop
  -> Settings
  -> Resources
  -> Advanced
  -> Disk image location
  -> E:\Docker\DockerDesktop
```

迁移后必须在 Docker Desktop 设置页确认真实磁盘映像位置已经生效，再开始拉取镜像和构建。容器内的 `/var/lib/docker` 是 Linux 虚拟机内部路径，不能用来判断宿主机磁盘映像实际放在哪个盘。源机器不得让 Docker 映像继续留在 C 盘；接收方可以让仓库和 Docker 映像位于同一块盘或不同盘，只需确保所选磁盘空间充足。

---

## 2. Docker 生产部署

### 2.1 前置条件

- Windows 10/11 或支持 Docker Compose 的 Linux 主机。
- Docker Desktop 或 Docker Engine，包含 Compose v2。
- 至少 4 GiB 可用内存，建议 8 GiB 以上。
- 项目目录和 Docker 磁盘映像所在盘有足够空间用于镜像、构建缓存、PostgreSQL 和课程素材。
- 一台平台后端可访问、老师浏览器也可访问的内网地址。

### 2.2 获取代码

以下命令使用源机器的 `E:\OpenMAIC-dev` 作为示例。接收方可以把盘符和目录替换成自己的实际安装位置，例如 `C:\OpenMAIC-dev` 或 `D:\Apps\OpenMAIC-dev`。

```powershell
Set-Location E:\
git clone https://github.com/sky897021-afk/openmaic-pro.git OpenMAIC-dev
Set-Location E:\OpenMAIC-dev
```

如果仓库已经存在，只更新代码，不要覆盖现场 `.env.local` 和 `data`：

```powershell
Set-Location E:\OpenMAIC-dev
git status
git pull --ff-only
```

### 2.3 创建配置

推荐直接运行一键安装脚本。重复运行时会先备份现有 `.env.local`，并保留已有的模型密钥、访问码、集成密钥、数据库密码、知识库向量模型和全部自定义模型路由。安装器只更新 `MODEL_ROUTES.maic-agent-driver`，不会丢弃 `page-transcription`、场景级路由或其他自定义键：

```powershell
Set-Location E:\OpenMAIC-dev
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

需要非交互地指定知识库向量模型时，可以传入参数：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -KnowledgeEmbeddingModel "openai:qwen3.7-text-embedding"
```

需要非交互地关闭或清除知识库向量索引时：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -DisableKnowledgeEmbedding
```

首次安装时嵌入模型留空会关闭向量索引；已有值可按回车保留。Windows PowerShell 5.1 通过 `-File` 传参时对单字符 `-` 参数存在兼容性问题，因此自动化脚本应使用 `-DisableKnowledgeEmbedding`，不要在启动参数里写 `-KnowledgeEmbeddingModel '-'`。在交互提示中直接输入 `-` 仍会清除该值。

只有在排查脚本问题或需要逐项定制时，才按下面的手工流程创建配置。先复制模板：

```powershell
Set-Location E:\OpenMAIC-dev
Copy-Item .env.example .env.local
```

至少需要配置以下内容。示例中的尖括号必须替换成真实值：

```env
# 当前交付实例使用的 LLM 基线；接收方必须换成自己的密钥。
OPENAI_API_KEY=<receiver-provider-api-key>
OPENAI_BASE_URL=https://llm-zm3w5x60s7qvhc83.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
OPENAI_MODELS=deepseek-v4.1-flash
DEFAULT_MODEL=openai:deepseek-v4.1-flash
MODEL_ROUTES='{"maic-agent-driver":{"model":"openai:deepseek-v4.1-flash","api":"openai-completions"}}'

# 当前交付实例的知识库向量模型。留空会关闭向量索引。
KNOWLEDGE_BASE_EMBEDDING_MODEL=openai:qwen3.7-text-embedding

# PostgreSQL，仅 Docker Compose 使用 postgres 这个主机名
DATABASE_URL=postgres://openmaic:<db-password>@postgres:5432/openmaic
PERSISTENCE_POSTGRES_PASSWORD=<db-password>

# 当前交付实例的浏览器构建期开关
NEXT_PUBLIC_PERSISTENCE=1
NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true

# Pro 工作台、Agent Runtime 和单游戏默认模式
OPENMAIC_AGENT_RUNTIME_ENABLED=true
OPENMAIC_SINGLE_GAME_MODE=true

# 单租户共享课程库
PERSISTENCE_SHARED_OWNER_ID=openmaic-shared
PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true
ACCESS_CODE=<long-random-access-code>

# 外部平台集成
INTEGRATION_SHARED_SECRET=<long-random-integration-secret>
INTEGRATION_PUBLIC_BASE_URL=http://<receiver-lan-ip>:3003
OPENMAIC_BASE_URL=http://<receiver-lan-ip>:3003
OPENMAIC_HOST_PORT=3003
INTEGRATION_LAYOUT_PAGES=3

# 仅内网纯 HTTP 部署需要；HTTPS 部署不要设置这一行
COOKIE_SECURE=0
```

说明：

- 上例是当前交付实例启用的核心基线，不包含其密钥。接收方必须提供自己的模型密钥；加密钥、数据库密码和访问码都不要复制交付方的 `.env.local`。
- 当前实例通过一个 OpenAI-compatible 网关使用 `deepseek-v4.1-flash`，并用同一个网关的 `qwen3.7-text-embedding` 做知识库向量化。接收方的账号必须同时有这两个模型的权限；如果换成其他网关或模型，修改 Base URL、Model ID 和嵌入模型即可，但模型输出不会保证逐字相同。
- `NEXT_PUBLIC_PERSISTENCE` 必须严格写成 `1`，不能写 `true`。
- `DATABASE_URL` 中的主机名在 Docker 内必须是 `postgres`。写 `localhost` 会连接容器自身。
- `MODEL_ROUTES` 至少要包含 `maic-agent-driver`。Pro 工作台启用后，缺少这条路由会导致 Agent 会话启动失败。
- `MODEL_ROUTES` 是完整 JSON 对象，不是只写一条新路由。新增 OCR、场景或对话路由时必须保留已有的 `maic-agent-driver`，详见 4.4。
- `KNOWLEDGE_BASE_EMBEDDING_MODEL` 是 `provider:model`，会复用该提供商已有的 API Key 和 Base URL。它不是普通聊天模型，不能填 `deepseek-v4.1-flash`。
- `OPENMAIC_SINGLE_GAME_MODE=true` 与当前实例一致，表示没有显式指定生成模式的旧请求或 API 调用默认使用单游戏模式；`/classic`、`/game`、`/games` 三个入口仍可分别选择。
- 生产环境建议设置 `ACCESS_CODE`。只有在完全封闭、故意不设访问码的内网中，才可以改成下面这一组：

```env
PERSISTENCE_SHARED_OWNER_ID=openmaic-shared
PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true
```

- `COOKIE_SECURE=0` 只适合可信内网纯 HTTP。公网或不可信网络必须使用 HTTPS，并删除该设置。
- 数据库密码建议使用纯字母和数字，避免 URL 编码问题。若必须使用 `@`、`:`、`/`、`#` 等字符，需要在 `DATABASE_URL` 中进行百分号编码。

生成随机密钥：

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$rng.Dispose()
$secret
```

分别生成 `ACCESS_CODE`、`INTEGRATION_SHARED_SECRET` 和数据库密码。不要把 `.env.local` 提交到 Git，也不要通过聊天或前端代码传递这些值。

### 2.4 理解 `.env.local` 与 Compose 构建参数

`docker-compose.yml` 把 `.env.local` 作为运行时 `env_file` 加载，但该服务的 `env_file` 本身不会自动成为 Compose 插值来源或镜像构建参数。以 `NEXT_PUBLIC_*` 开头的变量会编译进浏览器包，必须在执行 `docker compose build` 前提供给 Compose。

本指南的 Compose 命令统一使用 `--env-file .env.local`。这样同一个文件既通过服务内的 `env_file` 注入运行时变量，也参与 `${OPENMAIC_HOST_PORT}` 等 Compose 插值和构建参数。只执行不带 `--env-file` 的 `docker compose` 时，Compose 不会自动读取 `.env.local`。

如果还启用了其他 `NEXT_PUBLIC_*` 功能，先把它们写入 `.env.local`，再带 `--env-file .env.local` 重新构建。只改文件而不重新构建，浏览器端开关不会变化。

`PERSISTENCE_POSTGRES_PASSWORD` 用于初始化 Compose 中的 PostgreSQL，必须与 `DATABASE_URL` 中的密码一致。它不属于应用运行时读取的数据库连接本身。

### 2.5 修改 Docker 端口为 3003

不需要修改 [docker-compose.yml](./docker-compose.yml)。在 `.env.local` 中设置：

```env
OPENMAIC_HOST_PORT=3003
```

`install.ps1` 默认写入该值；也可以运行 `.\install.ps1 -Port 3003` 明确指定。左侧是宿主机端口，右侧仍是容器端口 `3000`，容器的 `PORT=3000` 和健康检查不需要修改。

### 2.6 启动

使用一键脚本时，这一步已自动完成。手工启动时执行：

```powershell
Set-Location E:\OpenMAIC-dev
docker compose --env-file .env.local --profile server-persistence up -d --build
```

启动后检查：

```powershell
docker compose --env-file .env.local --profile server-persistence ps
docker compose --env-file .env.local --profile server-persistence logs --tail=200 openmaic
docker compose --env-file .env.local --profile server-persistence logs --tail=100 postgres
```

推荐安装方式使用 `3003`，访问地址是：

```text
http://localhost:3003
```

如果手工安装了 Docker Compose 且没有设置 `OPENMAIC_HOST_PORT`，则回退到：

```text
http://localhost:3000
```

### 2.7 Docker 数据位置

Compose 使用两个命名卷：

- `openmaic-data`：课程、课程媒体、运行数据，以及 `data/integration-materials`、`data/integration-handoffs` 等文件型集成记录。
- `openmaic-postgres`：课程库、Pro 工作台、知识库和 Agent Runtime 的 PostgreSQL 数据。

PostgreSQL 当前没有向宿主机发布 `5432`，平台不应直接连接这个数据库。平台只调用 OpenMAIC 的集成 HTTP API。

本地 Docker 开发需要进入数据库时：

```powershell
docker compose --env-file .env.local --profile server-persistence exec postgres `
  psql -U openmaic -d openmaic
```

---

## 3. Windows 本地开发部署（3003）

本地开发适合调试和验收，不等同于长期生产部署。

### 3.1 前置条件

- Node.js `>= 22.19`，建议使用 22 LTS。
- pnpm 10。
- PostgreSQL 16 或 17。
- 仓库位于空间充足的工作盘；本文源机器示例使用 E 盘。

源机器如果还没有 pnpm，先把 Corepack 和 pnpm 的缓存位置指到 E 盘。接收方把路径替换成自己的项目目录即可：

```powershell
$env:PNPM_HOME = 'E:\OpenMAIC-dev\.tools\pnpm'
$env:PNPM_STORE_DIR = 'E:\OpenMAIC-dev\.pnpm-store'
$env:COREPACK_HOME = 'E:\OpenMAIC-dev\.cache\corepack'
$env:PATH = "$env:PNPM_HOME;$env:PATH"

corepack enable --install-directory $env:PNPM_HOME
corepack prepare pnpm@10.28.0 --activate
```

### 3.2 安装依赖

```powershell
Set-Location E:\OpenMAIC-dev
pnpm install --store-dir E:\OpenMAIC-dev\.pnpm-store
```

不要在中途按 `Ctrl+C`。`postinstall` 会构建 `packages/` 下的工作区包，并生成 PPTX 导入所需的 `public/vendor/maic-importer/index.js`。

如果安装中断，可补跑：

```powershell
pnpm --filter @openmaic/importer build
pnpm run sync:maic-importer
```

### 3.3 准备本机 PostgreSQL

如果已有 PostgreSQL 16 或 17，先确认服务正在运行，并创建一个空库：

```powershell
psql -U postgres -h localhost -c "select version();"
createdb -U postgres -h localhost openmaic
```

如果 `psql` 或 `createdb` 不在 PATH，使用 PostgreSQL 安装目录中的完整路径，或使用 pgAdmin 创建 `openmaic` 数据库。

OpenMAIC 会在连接空库后自动建表，不需要手工执行 SQL 迁移脚本。它只会建表，不会自动创建数据库名 `openmaic`。

源机器如为本机新装 PostgreSQL，应把程序和数据目录选在 E 盘。接收方可以选择任意空间充足的磁盘；已有系统服务可以继续使用当前位置。

### 3.4 本地 `.env.local`

本机 PostgreSQL 使用 `localhost`：

```env
DATABASE_URL=postgres://postgres:<db-password>@localhost:5432/openmaic
NEXT_PUBLIC_PERSISTENCE=1
```

其余模型、Pro 工作台和集成变量与 Docker 章节一致。修改 `.env.local` 后手动停止并重启开发服务器，不要依赖热重载处理环境变量。

### 3.5 启动 3003

```powershell
Set-Location E:\OpenMAIC-dev
pnpm dev:3003
```

等价命令：

```powershell
pnpm dev -- -p 3003
```

Windows 下 `scripts/dev-with-postgres.mjs` 会检查 `postgresql-x64-17` 服务。只有以下条件同时成立时才会尝试启动数据库：

- 当前平台是 Windows。
- 目标端口是 `3003`。
- PostgreSQL 服务未运行且服务存在。

这只是“启动 3003 时顺带启动数据库”，不是 Windows 开机自启。启动其他端口不会触发该逻辑。

看到 `Ready` 后访问：

```text
http://localhost:3003
```

本地开发注意事项：

- `next dev` 首次访问页面时会即时编译，比生产模式慢。
- 不要在同一目录同时运行多个 `next dev`。
- 不要在开发服务器运行时对同一目录执行 `pnpm build`。
- 修改 `.env.local` 后手动重启。
- 开发模式下 `NEXT_PUBLIC_*` 重启后生效；Docker 生产构建必须在构建前提供这些变量。

---

## 4. 环境变量与密钥

### 4.1 必需项

| 变量 | 作用 | 关键要求 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接 | Docker 使用 `postgres` 主机；本地使用 `localhost` |
| `NEXT_PUBLIC_PERSISTENCE` | 启用服务端持久化 | 必须严格为 `1`，且 Docker 构建前已提供 |
| `<PROVIDER>_API_KEY` | LLM 提供商密钥 | 至少配置一个可用提供商 |
| `<PROVIDER>_MODELS` | 可选模型列表 | 模型 ID 必须与提供商实际名称一致 |
| `DEFAULT_MODEL` | 服务端默认模型 | 使用 `provider:model` 格式 |
| `MODEL_ROUTES` | 阶段模型路由 | Pro 工作台必须包含 `maic-agent-driver` |

### 4.2 推荐项

| 变量 | 作用 | 建议 |
| --- | --- | --- |
| `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` | 打开 Pro 工作台入口 | 设为 `true` 并在构建前导出 |
| `OPENMAIC_AGENT_RUNTIME_ENABLED` | 启用 Agent Runtime | 设为 `true` |
| `PERSISTENCE_SHARED_OWNER_ID` | 固定单租户共享课程库 | 所有浏览器共用同一课程库 |
| `ACCESS_CODE` | 内网访问码 | 除完全封闭内网外都建议设置 |
| `COOKIE_SECURE` | 控制安全 Cookie | HTTPS 保持默认；可信纯 HTTP 设为 `0` |

`PERSISTENCE_SHARED_OWNER_ID` 单独设置而没有 `ACCESS_CODE` 时，服务启动会失败。故意不设访问码时必须同时设置：

```env
PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true
```

### 4.3 集成项

| 变量 | 作用 | 要求 |
| --- | --- | --- |
| `INTEGRATION_SHARED_SECRET` | 所有集成路由的共享密钥 | 未设置时集成路由全部返回 404 |
| `INTEGRATION_PUBLIC_BASE_URL` | 返回给平台的课程/游戏链接基址 | 必须是浏览器可达地址 |
| `PERSISTENCE_POSTGRES_PASSWORD` | Compose 初始化 PostgreSQL 的密码 | 只在 Compose 环境使用，必须与 `DATABASE_URL` 匹配 |

密钥管理原则：

- API Key、数据库密码、`ACCESS_CODE` 和 `INTEGRATION_SHARED_SECRET` 只放服务端。
- `INTEGRATION_SHARED_SECRET` 只交给平台后端，不进入浏览器、前端 bundle、URL、日志或移动端。
- 轮换集成密钥后，平台后端与 OpenMAIC 必须同时更新并重启。
- 不要把现场 `.env.local` 发给仓库使用者，只提供变量清单和各自的密钥。

### 4.4 可选能力与特殊模型配置

仓库中的 [.env.example](./.env.example) 已列出当前代码支持的全部主要提供商变量。核心安装只要求聊天模型和数据库；OCR、TTS、ASR、图片、视频、联网搜索和第三方 PDF 服务都需要接收方自己的账号或服务地址。没有凭证时，对应能力会保持未配置，不会因为安装了同一份代码就自动可用。

#### 4.4.1 `MODEL_ROUTES` 与视觉 OCR

`MODEL_ROUTES` 必须是 JSON 对象。`maic-agent-driver` 不能丢；新增路由时要把所有键放在同一个对象中。例如：

```env
MODEL_ROUTES='{"maic-agent-driver":{"model":"openai:deepseek-v4.1-flash","api":"openai-completions"},"page-transcription":"openai:<vision-model-id>"}'
```

规则：

- `install.ps1` 重复运行时会读取并保留所有已有路由，只把 `maic-agent-driver` 更新为本次输入的聊天模型。
- 如果 `MODEL_ROUTES` 不是合法 JSON 对象，安装器会直接报错并停止，不会静默丢弃自定义路由。
- `page-transcription` 是扫描 PDF、PNG、JPEG 和 WebP 页面视觉转写使用的阶段名。
- 没有 `page-transcription` 路由时，该阶段会回退到 `DEFAULT_MODEL`。只有实际使用的 `DEFAULT_MODEL` 明确支持图片输入时才可能工作；当前实例没有独立视觉路由，不能假设 `deepseek-v4.1-flash` 具备图片输入能力。
- 视觉 OCR 不单独使用 `OCR_API_KEY`。它调用路由到的 LLM 提供商，并复用该提供商的 API Key 和 Base URL。
- 当前交付实例只显式配置了 `maic-agent-driver`，没有单独的 `page-transcription` 路由，也没有验证默认聊天模型支持视觉输入。要获得可靠的扫描件 OCR，接收方应选一个明确支持图片输入的视觉模型并补充该路由；否则扫描件可能失败，而带文本层的普通 PDF 仍可被本地解析。

视觉 OCR 阈值在 `.env.example` 中已经列出，默认值如下：

```env
VISION_OCR_MIN_TEXT_CHARS=24
VISION_OCR_MAX_PAGES=30
VISION_OCR_RENDER_SCALE=2
```

含义：

- `VISION_OCR_MIN_TEXT_CHARS`：本地文本层少于该字符数时，页面才进入视觉 OCR。
- `VISION_OCR_MAX_PAGES`：一次任务最多发送到视觉模型的页数。
- `VISION_OCR_RENDER_SCALE`：PDF 页面栅格化倍率，越高越清晰，也越占内存和时间。

扫描件会发送给所配置的视觉模型或外部文档服务，可能离开本机或内网。处理敏感材料前，应先确认服务商的数据策略。

#### 4.4.2 TTS

当前实例没有配置第三方服务端 TTS Key。没有服务端 TTS 时，代码仍提供浏览器原生语音能力，但音色、可用语言和稳定性由浏览器决定。需要固定音色或生产级语音时，配置以下任一提供商：

| 提供商 | 主要变量 |
| --- | --- |
| OpenAI | `TTS_OPENAI_API_KEY`、可选 `TTS_OPENAI_BASE_URL` |
| Azure | `TTS_AZURE_API_KEY`、`TTS_AZURE_BASE_URL` |
| GLM | `TTS_GLM_API_KEY`、可选 `TTS_GLM_BASE_URL` |
| Qwen | `TTS_QWEN_API_KEY`、可选 `TTS_QWEN_BASE_URL` |
| 豆包 | `TTS_DOUBAO_API_KEY`、可选 `TTS_DOUBAO_BASE_URL` |
| MiniMax | `TTS_MINIMAX_API_KEY`、`TTS_MINIMAX_BASE_URL` |
| ElevenLabs | `TTS_ELEVENLABS_API_KEY`、可选 `TTS_ELEVENLABS_BASE_URL` |
| 本地 VoxCPM2 / Lemonade | `TTS_VOXCPM_BASE_URL` 或 `TTS_LEMONADE_BASE_URL` |

常用运行参数：

```env
TTS_REQUEST_TIMEOUT_MS=30000
TTS_MIN_INTERVAL_MS=0
TTS_BACKOFF_BUDGET_MS=120000
```

可用 `TTS_<PROVIDER>_ENABLED=false` 强制关闭某个服务端提供商，例如 `TTS_OPENAI_ENABLED=false`；浏览器原生语音由 `TTS_BROWSER_NATIVE_ENABLED` 控制。

#### 4.4.3 ASR

当前实例没有配置第三方 ASR。音频或视频素材需要转写时可以选择：

- `ASR_OPENAI_API_KEY` / `ASR_OPENAI_BASE_URL`
- `ASR_QWEN_API_KEY` / `ASR_QWEN_BASE_URL`
- `ASR_AZURE_API_KEY` / `ASR_AZURE_BASE_URL`
- 本地 FunASR：`ASR_FUNASR_BASE_URL`
- 本地 Lemonade：`ASR_LEMONADE_BASE_URL`

本地音视频提取还要求运行 OpenMAIC 的应用环境在 `PATH` 中同时有 `ffmpeg` 和 `ffprobe`。Docker 部署时，这意味着它们必须在 `openmaic` 容器内可用，宿主机单独安装并不够；若使用自定义镜像，需要把这两个可执行文件一并加入镜像。缺少它们时，本地媒体验证器会跳过，配置了 AliDocMind 时才会改走云端提取。

#### 4.4.4 图片生成

当前实例没有配置图片生成 Key，也没有设置 `DEFAULT_IMAGE_PROVIDER`。服务端图片提供商和变量如下：

| 提供商 ID | 变量前缀 |
| --- | --- |
| `openai-image` | `IMAGE_OPENAI_*` |
| `seedream` | `IMAGE_SEEDREAM_*` |
| `qwen-image` | `IMAGE_QWEN_IMAGE_*` |
| `nano-banana` | `IMAGE_NANO_BANANA_*` |
| `minimax-image` | `IMAGE_MINIMAX_*` |
| `grok-image` | `IMAGE_GROK_*` |
| OpenRouter | `IMAGE_OPENROUTER_*` |
| 本地 Lemonade | `IMAGE_LEMONADE_BASE_URL` |

要指定 Agent 默认使用的服务端图片提供商：

```env
DEFAULT_IMAGE_PROVIDER=seedream
IMAGE_MIN_PIXELS=0
```

`DEFAULT_IMAGE_PROVIDER` 只接受已注册且已启用的服务端提供商 ID。`IMAGE_MIN_PIXELS` 为 `0` 或未设置时保持历史尺寸；需要统一提高最低像素面积时再设置正整数。

#### 4.4.5 视频、联网搜索和第三方 PDF

这些能力当前实例都没有配置，需要时按 `.env.example` 填写：

| 能力 | 变量 |
| --- | --- |
| 视频生成 | `VIDEO_SEEDANCE_*`、`VIDEO_KLING_*`、`VIDEO_VEO_*`、`VIDEO_SORA_*`、`VIDEO_MINIMAX_*`、`VIDEO_GROK_*`、`VIDEO_HAPPYHORSE_*`、`VIDEO_OPENROUTER_*` |
| 联网搜索 | `TAVILY_*`、`EXA_*`、`BOCHA_*`、`BRAVE_*`、`BAIDU_*`、`SEARXNG_BASE_URL`、`WEB_SEARCH_MINIMAX_*`、`WEB_SEARCH_DOUBAO_*`、`WEB_SEARCH_CLAUDE_*` |
| 自托管/云 PDF | `PDF_UNPDF_*`、`PDF_MINERU_*`、`PDF_MINERU_CLOUD_*`、`ALIDOCMIND_*` |
| MP4 渲染服务 | `RENDER_SERVICE_URL`，需要同时启用 Compose 的 `video-export` profile |

PDF 的本地文本层、DOCX/PPTX/XLSX、CSV、Markdown 和图片等解析不依赖上述第三方 PDF Key。自托管 MinerU 未配置 Base URL 时不会自动回退到 MinerU Cloud；只有显式设置 `ALLOW_MINERU_CLOUD_FALLBACK=true` 才允许云端回退。

#### 4.4.6 知识库向量模型

当前实例使用：

```env
KNOWLEDGE_BASE_EMBEDDING_MODEL=openai:qwen3.7-text-embedding
```

它复用 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`。接收方的网关若不提供该模型，需要换成自己的真实嵌入模型，例如 `openai:text-embedding-3-small` 或其他提供商的 `provider:model`。

- 留空会关闭向量索引，但知识库上传和词法检索仍可使用。
- 不能使用聊天模型代替嵌入模型。
- 新建空数据库不受旧向量维度影响；从旧数据库迁移时不要随意更换嵌入模型和向量维度。

#### 4.4.7 `server-providers.yml`

`server-providers.yml` 是 `.env.local` 之外的服务端提供商配置文件，但已被 `.gitignore` 忽略，因此不会随 GitHub 自动交付。当前实例没有这个文件，也没有依赖它。

选择使用该文件时：

1. 在项目根目录创建 `server-providers.yml`，写入服务商配置和密钥。
2. 编辑 [docker-compose.yml](./docker-compose.yml)，取消下面挂载行的注释：

```yaml
- ./server-providers.yml:/app/server-providers.yml:ro
```

3. 带 `--env-file .env.local` 重新创建容器。
4. 不要把该文件提交到公开仓库；需要交接时只交接脱敏模板，密钥通过密码库或加密渠道单独传递。

文件不存在时不要取消挂载注释，否则 Docker 可能创建错误类型的挂载目标。能用各提供商的 `*_API_KEY` / `*_BASE_URL` 环境变量表达时，优先使用 `.env.local`。

#### 4.4.8 构建期变量

以下变量会编译进浏览器包，修改后必须用带 `--env-file .env.local` 的命令重新构建：

- `NEXT_PUBLIC_PERSISTENCE`
- `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED`
- `NEXT_PUBLIC_MAIC_EDITOR_ENABLED`
- `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`
- `NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED`
- `NEXT_PUBLIC_PI_CHAT_ENABLED`
- `NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED`
- `NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI`
- `NEXT_PUBLIC_ENABLE_VIDEO_EXPORT`
- `NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION`
- `NEXT_PUBLIC_ENABLE_PPTX_IMPORT`
- `ALLOWED_FRAME_ANCESTORS`

```powershell
docker compose --env-file .env.local --profile server-persistence up -d --build
```

只修改 `.env.local` 而不重新构建，浏览器端开关不会更新。只改服务端提供商 Key 或路由时，通常重启应用即可；具体以第 13 章故障排查为准。

### 4.5 当前实例能力对照

| 能力 | 当前交付实例 | 接收方要复现时的配置 |
| --- | --- | --- |
| 核心聊天与生成 | 已启用，OpenAI-compatible `deepseek-v4.1-flash` | 自己的 `OPENAI_API_KEY`、Base URL、Model ID |
| Pro 工作台与 Agent Runtime | 已启用 | `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true`、`OPENMAIC_AGENT_RUNTIME_ENABLED=true`、持久化 |
| 单游戏默认模式 | 已启用 | `OPENMAIC_SINGLE_GAME_MODE=true` |
| 完整课程 / 单游戏 / 多游戏入口 | 已启用 | 代码自带，`/classic`、`/game`、`/games` |
| 模块一和模块二集成 API | 已启用 | `INTEGRATION_SHARED_SECRET`、浏览器可达的 `INTEGRATION_PUBLIC_BASE_URL` |
| 知识库向量索引 | 已启用 | `KNOWLEDGE_BASE_EMBEDDING_MODEL=openai:qwen3.7-text-embedding` 或等价嵌入模型 |
| 自定义 `MODEL_ROUTES` | 仅显式配置 `maic-agent-driver` | 合并自己的路由，保留 driver |
| 扫描件视觉 OCR | 没有独立视觉路由，也未验证默认模型支持图片输入 | 添加 `page-transcription`，并使用接收方确认支持图片的模型 |
| 服务端 TTS | 未配置第三方 Key | `TTS_*` |
| ASR | 未配置第三方 Key | `ASR_*`，本地方案还需要容器内 `ffmpeg`/`ffprobe` |
| 图片生成 | 未配置 | `IMAGE_*`、可选 `DEFAULT_IMAGE_PROVIDER` |
| 视频生成 | 未配置 | `VIDEO_*` |
| 联网搜索 | 未配置 | `TAVILY_*` 等 |
| 第三方 PDF / MinerU / AliDocMind | 未配置 | `PDF_*` 或 `ALIDOCMIND_*` |
| `server-providers.yml` | 未使用 | 可选；Docker 需要手工取消挂载注释 |

当前实例设置了 `PERSISTENCE_SHARED_OWNER_ID` 且没有 `ACCESS_CODE`，通过 `PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true` 允许开放内网访问。`install.ps1` 默认会生成并写入 `ACCESS_CODE`，这是更安全的默认值。只有在完全封闭、明确要让所有可达用户共享同一课程库时，才应删除 `ACCESS_CODE` 并保留 `PERSISTENCE_SHARED_OWNER_ALLOW_OPEN=true`。

---

## 5. 部署验收

### 5.1 基础健康检查

推荐安装方式（Docker，宿主机 `3003`）：

```powershell
Invoke-RestMethod http://localhost:3003/api/health
Invoke-RestMethod http://localhost:3003/api/agent/runtime
```

如果手工使用 Compose 且没有设置 `OPENMAIC_HOST_PORT`，把上面的 `3003` 换成 `3000`。

```powershell
Invoke-RestMethod http://localhost:3003/api/health
Invoke-RestMethod http://localhost:3003/api/agent/runtime
```

`/api/agent/runtime` 正常应返回：

```json
{
  "enabled": true,
  "runtimeEnabled": true,
  "persistence": true
}
```

如果 `persistence` 为 `false`，依次检查：

1. `DATABASE_URL` 是否配置。
2. `NEXT_PUBLIC_PERSISTENCE` 是否为 `1`。
3. Compose 命令是否带 `--env-file .env.local`，修改后是否重新构建。
4. 数据库容器是否健康。
5. 密码是否一致，已有 PostgreSQL 卷是否仍使用旧密码。
6. 修改后是否重启或重建了应用。

### 5.2 数据库检查

```powershell
docker compose --env-file .env.local --profile server-persistence exec -T postgres `
  psql -U openmaic -d openmaic -c "select 1;"
```

### 5.3 集成路由检查

未设置 `INTEGRATION_SHARED_SECRET` 时，所有 `/api/integration/v1/*` 路由应返回 404。

设置密钥并重启后，不携带签名请求一个状态接口：

```powershell
curl.exe -i http://localhost:3003/api/integration/v1/handoffs/ho_00000000
```

预期返回 401。如果仍是 404，优先检查：

- `.env.local` 是否被当前进程加载。
- Docker 是否只改了文件但没有重建或重启。
- 变量名是否拼错。

### 5.4 页面验收

1. 打开部署地址。
2. 输入 `ACCESS_CODE`。
3. 确认 Pro 工作台入口可见。
4. 新建会话并发送一条消息，确认模型可用。
5. 上传一个 `TXT`、`MD` 或 `DOCX` 文件，确认素材解析。
6. 生成一条很短的课程，确认课程落库并能在课程库重新打开。

### 5.5 平台到 OpenMAIC 的网络验收

在平台所在机器执行：

```powershell
Test-NetConnection 192.168.10.221 -Port 3003
curl.exe -i http://192.168.10.221:3003/api/health
```

平台后端和老师浏览器使用的地址可能不同，但最终返回给浏览器的 `classroomUrl`、`resourceUrl` 和 `redirectUrl` 必须可从老师浏览器打开。

---

## 6. 局域网、防火墙与反向代理

从其他电脑访问时，先放行宿主机端口。以管理员 PowerShell 执行：

```powershell
New-NetFirewallRule `
  -DisplayName "OpenMAIC 3003" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3003 `
  -Action Allow
```

如果 Docker 保持默认端口，把 `3003` 改成 `3000`。

开发模式下，Next.js 还会检查 `allowedDevOrigins`。当前 [next.config.ts](./next.config.ts) 已允许：

- `127.0.0.1`
- `192.168.*.*`
- `10.*.*.*`

如果局域网使用 `172.16.0.0/12` 等其他地址，需要在开发配置中加入对应来源。生产 Docker 模式不受该开发检查影响。

长期运行建议在前面增加 Nginx、Caddy 或其他反向代理：

- 使用 HTTPS，避免访问码、Bearer Token 和课程内容明文传输。
- 保留请求体大小上限，至少覆盖文档中的 150 MB 上传限制。
- 为同步大纲请求设置至少 120 秒后端超时。
- 不要把 PostgreSQL 端口暴露给平台或公网。
- 不要缓存 `/api/integration/v1/handoffs/*/payload` 和生成状态接口。

不要直接通过公网暴露无 `ACCESS_CODE` 的 OpenMAIC，也不要把共享集成密钥放进浏览器代码。

---

## 7. 平台连接总览

### 7.1 角色边界

| 能力 | 外部平台 | OpenMAIC |
| --- | --- | --- |
| 老师输入提示词 | 模块一负责；模块二由平台冻结后交接 | 接收 |
| 上传素材 | 平台后端调用接口 | 解析、存储、租户隔离 |
| 大纲展示与编辑 | 模块一负责 | 生成大纲；按确认稿生成 |
| 完整课程生成 | 轮询任务 | 运行现有完整课程流水线 |
| 单游戏落地页与生成 | 只负责跳转 | 浏览、生成、保存结果 |
| 最终资源展示 | 使用返回 URL 打开 | 提供 classroom/resource URL |

### 7.2 API 清单

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `POST` | `/api/integration/v1/extract` | HMAC 或 Bearer | 可选旧兼容：只抽取文件文本 |
| `POST` | `/api/integration/v1/materials` | HMAC 或 Bearer | 上传模块二原始素材 |
| `POST` | `/api/integration/v1/outlines` | JSON 用 HMAC；multipart 可用 Bearer | 生成模块一大纲 |
| `POST` | `/api/integration/v1/courses` | HMAC | 用老师确认稿创建生成任务 |
| `GET` | `/api/integration/v1/courses/jobs/{jobId}` | HMAC | 轮询完整课程任务 |
| `POST` | `/api/integration/v1/handoffs` | HMAC | 创建模块二单游戏交接 |
| `GET` | `/api/integration/v1/handoffs/{id}` | HMAC | 平台轮询游戏结果 |
| `GET` | `/api/integration/v1/handoffs/{id}/payload` | handoff ID | OpenMAIC 浏览器读取交接内容 |
| `POST` | `/api/integration/v1/handoffs/{id}/result` | completion token | OpenMAIC 浏览器回写结果 |

最后两个 handoff 子接口由 OpenMAIC 浏览器使用。外部平台不要调用，也不要尝试获取 `completionToken`。

### 7.3 平台侧变量

```env
OPENMAIC_BASE_URL=http://<openmaic-host>:3003
OPENMAIC_INTEGRATION_SECRET=<INTEGRATION_SHARED_SECRET>
OPENMAIC_TENANT_ID=<tenant>
```

`OPENMAIC_TENANT_ID` 应与平台自己的学校、机构或项目租户对应。素材和 handoff 都按租户隔离，一个租户不能引用另一个租户的 `materialId`。

---

## 8. 鉴权、HMAC、Nonce 与幂等

### 8.1 HMAC 请求头

JSON 接口和状态查询使用 HMAC-SHA256：

```text
stringToSign = timestamp + "." + nonce + "." + rawBody
signature    = lowercase hex(HMAC-SHA256(INTEGRATION_SHARED_SECRET, stringToSign))
```

请求头：

```http
x-openmaic-timestamp: <Unix 秒>
x-openmaic-nonce: <每次唯一的随机值>
x-openmaic-signature: <hex 签名>
```

规则：

- `timestamp` 是 Unix 秒，不是毫秒，允许前后 5 分钟偏差。
- 每次请求都应生成新 nonce。同一个 nonce 重放会返回 401。
- 服务端按请求原始字节验签。
- JSON 请求体只能 `JSON.stringify` 一次。签名和发送必须使用同一个字符串。
- GET 没有请求体，用空字符串参与签名。
- 签名十六进制大小写都接受，平台推荐统一输出小写。

### 8.2 Bearer 的适用范围

以下 multipart 上传可使用：

```http
Authorization: Bearer <INTEGRATION_SHARED_SECRET>
```

允许 Bearer 的场景：

- `/api/integration/v1/extract`
- `/api/integration/v1/materials`
- multipart 形式的 `/api/integration/v1/outlines`

JSON 的 `/courses`、`/handoffs` 和所有状态查询必须使用 HMAC。Bearer 会直接传输共享密钥，纯 HTTP 内网也应在可信网络中调用，正式环境应使用 HTTPS。

### 8.3 Idempotency-Key

`POST /api/integration/v1/courses` 必须带：

```http
Idempotency-Key: dfsm:course-123:chapter-9:v1
```

规则：

- 同一个租户和同一个 key 会返回同一个任务。
- 重试同一业务提交时继续使用原 key。
- 用户修改大纲并重新发起新的生成时，应生成新 key。
- 任务已经失败后再次重试，也应使用新 key。
- key 长度为 1 到 200 个字符。

---

## 9. 模块一：外部平台生成完整课程

### 9.1 完整时序

```text
平台后端
  -> POST /api/integration/v1/outlines
     multipart: tenantId + requirement + 原始 files
  <- outlineId + courseTitle + languageDirective + outlines + materialIds

老师在平台编辑 outline

平台后端
  -> 原样提交完整 outline、原提示词和 materialIds
  -> POST /api/integration/v1/courses
     Idempotency-Key: <本次业务唯一键>
  <- 202 + jobId + pollUrl

平台后端
  -> 每 5 到 10 秒 GET /courses/jobs/{jobId}
  <- running / succeeded / failed
  <- succeeded: result.stageId + result.classroomUrl
```

OpenMAIC 负责从原始文件提取文本、内嵌图片和版面信息。平台不需要先把文件转成纯文本。

`/extract` 仅保留为旧系统兼容路径。新的模块一接入应直接把原始文件提交给 `/outlines`。

### 9.2 第 1 步：生成大纲

接口：

```http
POST /api/integration/v1/outlines
Authorization: Bearer <INTEGRATION_SHARED_SECRET>
Content-Type: multipart/form-data
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `tenantId` | 是 | 平台租户 ID |
| `requirement` | 是 | 老师输入的完整教学要求 |
| `files` | 是 | 可重复；单文件不超过 50 MB，单次不超过 10 个，总计不超过 150 MB |
| `externalCourseId` | 否 | 平台课程 ID |
| `externalChapterId` | 否 | 平台章节 ID |
| `options` | 否 | JSON 字符串，可包含联网搜索、图片生成、视频生成开关 |

PowerShell 手工验收：

```powershell
$base = 'http://192.168.10.221:3003'
$secret = '<INTEGRATION_SHARED_SECRET>'

curl.exe --request POST "$base/api/integration/v1/outlines" `
  --header "Authorization: Bearer $secret" `
  --form "tenantId=dfsm" `
  --form "externalCourseId=course-123" `
  --form "externalChapterId=chapter-9" `
  --form "requirement=面向初中生生成一节水的三态变化课程，控制在 2 页。" `
  --form "files=@E:\OpenMAIC-materials\水的三态.docx" `
  --form "files=@E:\OpenMAIC-materials\装置图.png"
```

平台后端应使用 `FormData`。不要手动设置 multipart 的 `Content-Type`，让运行时自动生成 boundary。

大纲响应示例：

```json
{
  "success": true,
  "outlineId": "ol_6_3mDj6W3iZ6",
  "courseTitle": "水的三态变化",
  "languageDirective": "整节课使用中文（简体）授课",
  "outlines": [
    {
      "id": "scene_1",
      "order": 1,
      "type": "slide",
      "title": "水的三态与循环变化",
      "description": "介绍水的三种形态及其循环变化",
      "keyPoints": ["固态", "液态", "气态"],
      "quizConfig": {
        "questionCount": 3,
        "difficulty": "easy"
      }
    }
  ],
  "materialIds": ["mat_example123"],
  "materials": [
    {
      "fileName": "水的三态.docx",
      "kind": "docx",
      "chars": 1540,
      "imageCount": 2,
      "parser": "local-document"
    }
  ],
  "warnings": []
}
```

### 9.3 第 2 步：平台展示并编辑大纲

平台必须把 OpenMAIC 返回的完整 outline 对象交给老师编辑。以下字段要原样保存和回传：

- `id`
- `order`
- `type`
- `title`
- `description`
- `keyPoints`
- `teachingObjective`
- `estimatedDuration`
- `quizConfig`
- `widgetType`
- `widgetOutline`
- `suggestedImageIds`
- 其他当前平台不认识的字段

不要只保存 `title` 和 `description`。像 `quizConfig`、`widgetType`、`widgetOutline` 这类字段会直接影响后续页面生成。完整课程只接受 `slide`、`quiz`、`interactive` 三类 outline。

老师可以修改顺序和可见字段，但平台回传时仍应保留未知字段。OpenMAIC 会按 `order` 排序并重新编号。

### 9.4 第 3 步：创建完整课程任务

接口：

```http
POST /api/integration/v1/courses
Content-Type: application/json
Idempotency-Key: dfsm:course-123:chapter-9:v1
x-openmaic-timestamp: <Unix 秒>
x-openmaic-nonce: <唯一 nonce>
x-openmaic-signature: <HMAC>
```

请求体：

```json
{
  "tenantId": "dfsm",
  "externalCourseId": "course-123",
  "externalChapterId": "chapter-9",
  "requirement": "面向初中生生成一节水的三态变化课程，控制在 2 页。",
  "materialIds": ["mat_example123"],
  "courseTitle": "水的三态变化",
  "languageDirective": "整节课使用中文（简体）授课",
  "outlines": [
    {
      "id": "scene_1",
      "order": 1,
      "type": "slide",
      "title": "水的三态与循环变化",
      "description": "介绍水的三种形态及其循环变化",
      "keyPoints": ["固态", "液态", "气态"],
      "quizConfig": {
        "questionCount": 3,
        "difficulty": "easy"
      }
    }
  ]
}
```

返回 HTTP 202：

```json
{
  "success": true,
  "jobId": "int_9f75a05814294d5db34b0d75",
  "status": "queued",
  "pollUrl": "http://192.168.10.221:3003/api/integration/v1/courses/jobs/int_9f75a05814294d5db34b0d75",
  "reused": false
}
```

`reused: true` 表示幂等键命中了原任务，并没有重新生成。

### 9.5 第 4 步：轮询任务

```http
GET /api/integration/v1/courses/jobs/{jobId}
x-openmaic-timestamp: <Unix 秒>
x-openmaic-nonce: <新 nonce>
x-openmaic-signature: <对空 body 的 HMAC>
```

运行中示例：

```json
{
  "success": true,
  "jobId": "int_9f75a05814294d5db34b0d75",
  "status": "running",
  "step": "generating_scenes",
  "progress": 31,
  "scenesGenerated": 0,
  "totalScenes": 2,
  "done": false
}
```

成功示例：

```json
{
  "success": true,
  "jobId": "int_9f75a05814294d5db34b0d75",
  "status": "succeeded",
  "step": "completed",
  "progress": 100,
  "scenesGenerated": 2,
  "totalScenes": 2,
  "done": true,
  "result": {
    "stageId": "1iOGPLEUQW",
    "classroomUrl": "http://192.168.10.221:3003/classroom/1iOGPLEUQW",
    "scenesCount": 2
  }
}
```

失败示例：

```json
{
  "success": true,
  "jobId": "int_9f75a05814294d5db34b0d75",
  "status": "failed",
  "done": true,
  "error": "generation failed"
}
```

平台应保存 `classroomUrl`，课程章节点击后在新页面打开。不要从 `stageId` 自行拼接另一个域名，除非平台明确掌握反向代理映射。

### 9.6 必需保留的边界

- 老师确认后的 `outlines` 不应被平台重新生成或裁剪。
- `courseTitle` 和 `languageDirective` 应随确认稿继续传递。
- 本次大纲返回的 `materialIds` 应在创建课程时带上。
- 同一业务提交必须复用原 `Idempotency-Key`。
- OpenMAIC 重启会中断当前进程内生成任务，部署窗口应避开正在生成的任务。

---

## 10. 模块二：外部平台交接单游戏生成

### 10.1 完整时序

```text
平台后端
  -> POST /api/integration/v1/materials
     multipart: tenantId + 原始 files
  <- materialIds

平台后端
  -> POST /api/integration/v1/handoffs
     JSON: tenantId + prompt + materialIds
  <- handoffId + redirectUrl

平台浏览器
  -> 顶层跳转 redirectUrl
  -> /game?handoff=<id>
  -> 老师点击开始生成

OpenMAIC
  -> 复用现有 single-game 生成流水线
  -> 课程保存后由浏览器回写 stageId

平台后端
  -> GET /api/integration/v1/handoffs/{id}
  <- pending / succeeded
  <- succeeded: resourceUrl
```

### 10.2 第 1 步：上传素材

```http
POST /api/integration/v1/materials
Authorization: Bearer <INTEGRATION_SHARED_SECRET>
Content-Type: multipart/form-data
```

```powershell
$base = 'http://192.168.10.221:3003'
$secret = '<INTEGRATION_SHARED_SECRET>'

curl.exe --request POST "$base/api/integration/v1/materials" `
  --header "Authorization: Bearer $secret" `
  --form "tenantId=dfsm" `
  --form "files=@E:\OpenMAIC-materials\设备图例.pdf" `
  --form "files=@E:\OpenMAIC-materials\操作手册.docx"
```

响应示例：

```json
{
  "success": true,
  "materials": [
    {
      "materialId": "mat_example123",
      "fileName": "设备图例.pdf",
      "kind": "pdf",
      "chars": 1479,
      "imageCount": 50,
      "pageCount": 13,
      "layoutPageCount": 3,
      "parser": "unpdf"
    }
  ]
}
```

限制与生命周期：

- 单文件不超过 50 MB。
- 单次不超过 10 个文件。
- 总大小不超过 150 MB。
- 原始素材和解析结果保存 24 小时。
- `materialId` 是 opaque 值，平台应原样保存，不要解析其内容。

存储内容按文件格式保留 OpenMAIC 可用的文本、内嵌图片和版面信息。PDF 可带页码、内嵌图片和前 3 页版面参考图；DOCX 可带 `word/media` 图片和阅读顺序。生成时使用这些信息作为参考，不是原文件页面的像素级复制。

### 10.3 第 2 步：创建 handoff

```http
POST /api/integration/v1/handoffs
Content-Type: application/json
x-openmaic-timestamp: <Unix 秒>
x-openmaic-nonce: <唯一 nonce>
x-openmaic-signature: <HMAC>
```

请求：

```json
{
  "tenantId": "dfsm",
  "teacherId": "teacher-1",
  "externalCourseId": "course-123",
  "externalChapterId": "chapter-9",
  "prompt": "根据上传的设备和操作手册，生成一个设备识别单游戏互动资源。",
  "materialIds": ["mat_example123"],
  "mode": "single-game",
  "returnUrl": "http://platform.example.com/chapter/9"
}
```

响应：

```json
{
  "success": true,
  "handoffId": "ho_example123",
  "redirectUrl": "http://192.168.10.221:3003/game?handoff=ho_example123",
  "status": "pending",
  "expiresAt": "2026-11-02T10:00:00.000Z"
}
```

规则：

- handoff 有效期为 2 小时。
- `materialIds` 必须去重、未过期且全部属于同一个 `tenantId`。
- 任一素材不存在、过期或跨租户时，整个 handoff 创建失败。
- `mode` 当前只支持 `single-game`。
- `returnUrl` 可选，只是 OpenMAIC 页面上的返回链接。最终结果以平台轮询接口为准。

### 10.4 第 3 步：浏览器跳转

平台浏览器必须做顶层导航：

```ts
window.location.assign(redirectUrl);
```

不要用服务端静默请求代替这次跳转。老师需要在 OpenMAIC 页面看到素材摘要并点击开始生成。

OpenMAIC 页面会：

1. 用 opaque `handoffId` 读取 `/payload`。
2. 展示提示词和素材摘要。
3. 创建 `single-game` 会话。
4. 把素材文本、图片和版面信息交给现有生成流水线。
5. 课程保存后回写 completion token 和 `stageId`。

`/payload` 不需要 HMAC，但 handoff ID 本身不可猜。`completionToken` 只由 OpenMAIC 浏览器读取，平台后端不应请求或保存它。

### 10.5 第 4 步：平台轮询结果

```http
GET /api/integration/v1/handoffs/{handoffId}
x-openmaic-timestamp: <Unix 秒>
x-openmaic-nonce: <新 nonce>
x-openmaic-signature: <对空 body 的 HMAC>
```

等待中：

```json
{
  "success": true,
  "handoffId": "ho_example123",
  "status": "pending",
  "createdAt": "2026-11-02T08:00:00.000Z",
  "expiresAt": "2026-11-02T10:00:00.000Z"
}
```

成功：

```json
{
  "success": true,
  "handoffId": "ho_example123",
  "status": "succeeded",
  "stageId": "stage-example",
  "resourceUrl": "http://192.168.10.221:3003/classroom/stage-example",
  "createdAt": "2026-11-02T08:00:00.000Z",
  "expiresAt": "2026-11-02T10:00:00.000Z"
}
```

当前公开状态是 `pending` 或 `succeeded`。超过 2 小时仍未成功时，平台应按 handoff 过期处理，并重新创建素材和 handoff。

### 10.6 iframe 边界

当前流程按顶层页面跳转设计。如果平台希望 iframe 嵌入 OpenMAIC，需要额外的嵌入模式和 CSP `ALLOWED_FRAME_ANCESTORS` 配置；仅设置集成密钥不会自动允许 iframe。

---

## 11. 平台后端 TypeScript 参考实现

以下代码只依赖 Node.js 22 自带能力。全部放在平台后端，不要放进浏览器 bundle。

```ts
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const OPENMAIC_BASE_URL = requiredEnv('OPENMAIC_BASE_URL').replace(/\/+$/, '');
const OPENMAIC_INTEGRATION_SECRET = requiredEnv('OPENMAIC_INTEGRATION_SECRET');
const OPENMAIC_TENANT_ID = requiredEnv('OPENMAIC_TENANT_ID');

type JsonObject = Record<string, unknown>;

class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new IntegrationError(
      `OpenMAIC request failed with HTTP ${response.status}`,
      response.status,
      text,
    );
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function signedRequest<T>(
  path: string,
  options: {
    method: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const rawBody = options.body ?? '';
  const signature = createHmac('sha256', OPENMAIC_INTEGRATION_SECRET)
    .update(`${timestamp}.${nonce}.${rawBody}`, 'utf8')
    .digest('hex');

  const response = await fetch(`${OPENMAIC_BASE_URL}${path}`, {
    method: options.method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...options.headers,
      'x-openmaic-timestamp': timestamp,
      'x-openmaic-nonce': nonce,
      'x-openmaic-signature': signature,
    },
    body: options.body,
    cache: 'no-store',
  });

  return parseJsonResponse<T>(response);
}

async function signedJsonRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: JsonObject,
  headers?: Record<string, string>,
): Promise<T> {
  // JSON.stringify is called exactly once. This exact string is signed and sent.
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  return signedRequest<T>(path, { method, body: rawBody, headers });
}

async function createModuleOneOutline(input: {
  requirement: string;
  externalCourseId?: string;
  externalChapterId?: string;
  files: string[];
}): Promise<JsonObject> {
  const form = new FormData();
  form.set('tenantId', OPENMAIC_TENANT_ID);
  form.set('requirement', input.requirement);
  if (input.externalCourseId) {
    form.set('externalCourseId', input.externalCourseId);
  }
  if (input.externalChapterId) {
    form.set('externalChapterId', input.externalChapterId);
  }

  for (const filePath of input.files) {
    const bytes = new Uint8Array(await readFile(filePath));
    form.append('files', new Blob([bytes]), basename(filePath));
  }

  const response = await fetch(
    `${OPENMAIC_BASE_URL}/api/integration/v1/outlines`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPENMAIC_INTEGRATION_SECRET}`,
      },
      body: form,
      cache: 'no-store',
    },
  );

  return parseJsonResponse<JsonObject>(response);
}

async function uploadModuleTwoMaterials(
  files: string[],
): Promise<JsonObject> {
  const form = new FormData();
  form.set('tenantId', OPENMAIC_TENANT_ID);

  for (const filePath of files) {
    const bytes = new Uint8Array(await readFile(filePath));
    form.append('files', new Blob([bytes]), basename(filePath));
  }

  const response = await fetch(
    `${OPENMAIC_BASE_URL}/api/integration/v1/materials`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPENMAIC_INTEGRATION_SECRET}`,
      },
      body: form,
      cache: 'no-store',
    },
  );

  return parseJsonResponse<JsonObject>(response);
}

async function createCourse(
  approvedOutlineRequest: JsonObject,
  idempotencyKey: string,
): Promise<JsonObject> {
  return signedJsonRequest<JsonObject>(
    'POST',
    '/api/integration/v1/courses',
    approvedOutlineRequest,
    { 'Idempotency-Key': idempotencyKey },
  );
}

async function createSingleGameHandoff(input: {
  prompt: string;
  materialIds: string[];
  externalCourseId?: string;
  externalChapterId?: string;
  returnUrl?: string;
}): Promise<JsonObject> {
  return signedJsonRequest<JsonObject>(
    'POST',
    '/api/integration/v1/handoffs',
    {
      tenantId: OPENMAIC_TENANT_ID,
      ...input,
      mode: 'single-game',
    },
  );
}
```

关键点：

- `signedRequest` 对空 body 做 GET 签名，并给每次请求生成新 nonce。
- `signedJsonRequest` 只序列化一次 JSON。
- 不要把已序列化的字符串再放入 `JSON.stringify`。
- 在最终的 `fetch` 中覆盖调用方 headers，保证三个签名头不会被业务代码误改。
- Node.js 会自动为 `FormData` 设置 multipart boundary，不要手工设置 `content-type`。

### 11.1 轮询辅助函数

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCourseJob<T extends { done: boolean; status: string }>(
  jobId: string,
  options: { intervalMs: number; timeoutMs: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const result = await signedJsonRequest<T>(
      'GET',
      `/api/integration/v1/courses/jobs/${encodeURIComponent(jobId)}`,
    );

    if (result.status === 'failed') {
      throw new Error(`OpenMAIC generation failed: ${jobId}`);
    }
    if (result.done) return result;

    await sleep(options.intervalMs);
  }

  throw new Error(`OpenMAIC generation timed out: ${jobId}`);
}
```

handoff 轮询使用同一个 `signedJsonRequest`，路径改为：

```ts
`/api/integration/v1/handoffs/${encodeURIComponent(handoffId)}`
```

---

## 12. 超时、重试和错误处理

| 操作 | 建议超时 | 轮询间隔 | 重试策略 |
| --- | --- | --- | --- |
| `POST /outlines` | 后端至少 120 秒 | 不轮询，同步返回 | 网络错误或 5xx 可指数退避重试 |
| `POST /courses` | 30 秒 | 不适用 | 同一业务提交复用同一个 `Idempotency-Key` |
| 完整课程任务 | 15 到 30 分钟 | 5 到 10 秒 | 超时按失败处理，换新 key 重新创建 |
| `POST /handoffs` | 30 秒 | 不适用 | 明确失败后可重新创建，但需检查素材是否仍有效 |
| handoff 结果 | 最长 2 小时 | 5 到 10 秒 | 超过过期时间后重新上传素材并创建 handoff |

重试规则：

- 每次 HTTP 请求都要重新生成 timestamp、nonce 和 signature。
- 网络中断后可以重发完全相同的 JSON body，但签名头必须重新生成。
- 创建课程的业务重试必须复用同一个 `Idempotency-Key`。
- 返回 `reused: true` 时继续轮询原 `jobId`，不要新建任务。
- 任务明确失败后，用户再次点击生成时使用新 key。
- 对 401 不要盲目重试，先检查时钟、密钥和 nonce 生成逻辑。
- 对 404 先检查集成密钥是否加载，不要把未启用接口误判为平台路由错误。
- 对 413 降低文件数量或总大小。
- 对 5xx 使用指数退避，例如 1、2、4、8 秒，并加随机抖动。

OpenMAIC 的课程任务和 nonce 缓存当前是进程内状态。重启会中断运行中的任务，也可能让已经用过的 nonce 缓存丢失。部署和重启应避开生成高峰，不能把“重启后继续原任务”当作默认能力。

---

## 13. 常见故障排查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 页面打开但 Pro 模式不可用 | `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` 未参与构建 | 确认命令带 `--env-file .env.local` 后重新 build |
| `/api/agent/runtime` 的 `persistence` 为 false | `DATABASE_URL` 或 `NEXT_PUBLIC_PERSISTENCE=1` 缺失 | 检查两者并重新构建/重启 |
| 数据库认证失败 | `DATABASE_URL` 密码与 `PERSISTENCE_POSTGRES_PASSWORD` 不一致 | 统一密码；已有卷要改数据库用户密码或重建卷 |
| Docker 内连接 `localhost:5432` 失败 | 容器内 `localhost` 不是 PostgreSQL | 改成 `postgres:5432` |
| 本地连接 `postgres:5432` 失败 | 非 Docker 环境无法解析服务名 | 改成 `localhost:5432` |
| 平台请求全部 404 | `INTEGRATION_SHARED_SECRET` 未设置或进程未重启 | 设置密钥并重启应用 |
| HMAC 请求一直 401 | JSON 被序列化两次、GET 没有按空 body 签名、时钟偏差超过 5 分钟 | 检查原文、时钟和签名头 |
| 重试突然 401 | 复用了旧 nonce 或旧签名 | 每次请求重新生成 nonce 和签名 |
| 返回 URL 是 `localhost` | 未设置 `INTEGRATION_PUBLIC_BASE_URL` | 设置浏览器可达地址并重启 |
| 平台可访问但老师打不开课程 | 返回了内网容器地址或未开放的端口 | 使用 LAN IP/域名并放行防火墙 |
| 端口 3003 无响应 | `.env.local` 没有 `OPENMAIC_HOST_PORT=3003`，或 Compose 未使用该文件 | 运行 `install.ps1`，或检查 `docker compose --env-file .env.local ... ps` 的端口映射 |
| Docker 构建后前端开关仍没变 | `env_file` 不参与构建 | 构建前导出 `NEXT_PUBLIC_*` 后重建 |
| 生产构建在局域网 HTTP 下无法保存状态 | 浏览器拒绝生产态 Secure Cookie | HTTPS；可信内网临时设置 `COOKIE_SECURE=0` |
| 上传返回 413 | 单文件、数量或总量超限 | 单文件 50 MB、10 个、总计 150 MB 以内 |
| `.doc` 可读但 `.ppt` 失败 | 老式 `.ppt` 提取器不可用 | 先转换到 `.pptx` |
| 生成任务在部署后消失 | 任务保存在进程内，重启中断 | 避开生成时重启，重新提交任务 |
| 保存课程时报 EACCES | Docker 数据卷权限异常 | 检查 `openmaic-data` 卷，确认 `/app/data` 可写 |
| 两个实例看到的课程不一致 | 未共享 PostgreSQL 和 `data/` | 当前部署按单实例使用，或共享持久化存储 |
| 平台查询 handoff 一直 pending | 老师未点击开始、生成仍在运行或已过期 | 检查浏览器流程和 expiresAt |

查看日志：

```powershell
docker compose --env-file .env.local --profile server-persistence logs -f openmaic
docker compose --env-file .env.local --profile server-persistence logs -f postgres
```

---

## 14. 备份、恢复与迁移

### 14.1 必须同时备份的内容

Docker 部署至少包含：

1. PostgreSQL 数据。
2. `openmaic-data` 卷。
3. `.env.local` 中的变量清单和密钥，建议放入加密密码库，不放入公开仓库。

只备份数据库但不备份 `data/`，会丢失课程媒体、`data/integration-materials` 和 `data/integration-handoffs` 等内容。只备份 `data/` 但不备份 PostgreSQL，会丢失课程库、Pro 会话、知识库和 Agent Runtime 数据。

### 14.2 Docker 备份示例

以下路径以源机器 E 盘为例。接收方执行时请把项目和备份路径替换成自己实际使用的目录。

先停止发起新生成，等待当前任务完成，再执行：

```powershell
Set-Location E:\OpenMAIC-dev

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = "E:\OpenMAIC-backup\$stamp"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

docker compose --env-file .env.local --profile server-persistence exec -T postgres `
  pg_dump -U openmaic -d openmaic -Fc -f "/tmp/openmaic-$stamp.dump"

docker compose --env-file .env.local --profile server-persistence cp `
  "postgres:/tmp/openmaic-$stamp.dump" `
  "$backupRoot\postgres.dump"

docker compose --env-file .env.local cp openmaic:/app/data "$backupRoot\data"

Compress-Archive `
  -Path "$backupRoot\*" `
  -DestinationPath "E:\OpenMAIC-backup\openmaic-$stamp.zip"
```

备份完成后验证：

```powershell
Get-Item "E:\OpenMAIC-backup\openmaic-$stamp.zip"
docker compose --env-file .env.local --profile server-persistence exec -T postgres `
  pg_restore --list "/tmp/openmaic-$stamp.dump"
```

不要把备份放在 C 盘临时目录，也不要只保留一份未加密副本。

### 14.3 Docker 恢复原则

1. 停止 OpenMAIC 应用，保留 PostgreSQL 容器。
2. 将 PostgreSQL dump 复制进 `postgres` 容器。
3. 使用 `pg_restore --clean --if-exists` 恢复数据库。
4. 将备份的 `data` 恢复到 `openmaic:/app/data`。
5. 检查 `/app/data` 权限。
6. 启动应用并执行健康检查。

恢复前先备份当前现场。`--clean` 会删除目标库中的现有对象，不应在未确认目标环境时执行。

### 14.4 本地开发迁移

至少迁移：

```powershell
pg_dump -U postgres -h localhost -d openmaic -Fc -f E:\OpenMAIC-backup\openmaic-local.dump
Copy-Item E:\OpenMAIC-dev\data E:\OpenMAIC-backup\data -Recurse
```

目标机器：

```powershell
createdb -U postgres -h localhost openmaic
pg_restore -U postgres -h localhost -d openmaic E:\OpenMAIC-backup\openmaic-local.dump
```

然后把 `data` 恢复到目标仓库并重新配置 `.env.local`。数据库密码和 API Key 不要直接复用源环境。

### 14.5 升级顺序

```powershell
Set-Location E:\OpenMAIC-dev

# 1. 确认没有正在生成的课程
# 2. 完成数据库和 data 备份

git pull --ff-only

docker compose --env-file .env.local --profile server-persistence up -d --build
```

不要用 `docker compose down -v` 做常规升级。`-v` 会删除 PostgreSQL 和应用数据卷。

---

## 15. 安全与运行边界

### 15.1 访问控制

- `ACCESS_CODE` 是共享访问码，不是完整用户账号系统。
- 设置 `PERSISTENCE_SHARED_OWNER_ID` 后，所有通过访问码的人共享一个课程库。
- 公网部署必须使用 HTTPS、长随机访问码，并优先在反向代理层增加身份认证。
- `INTEGRATION_SHARED_SECRET` 等同于所有集成租户的服务端总密钥，泄漏后应立刻轮换。
- 租户隔离用于阻止跨租户引用素材，不等于让平台用户直接持有服务端密钥。

### 15.2 网络边界

- PostgreSQL 不向宿主机发布端口，也不要自行暴露 `5432`。
- 外部平台只需要访问 OpenMAIC HTTP 端口。
- 平台后端和 OpenMAIC 的服务器时钟应使用 NTP 同步。
- 纯 HTTP 只用于可信内网；Bearer 和访问码在 HTTP 下是明文。
- 仓库中的 SSRF 开关 `ALLOW_LOCAL_NETWORKS` 不应在公网部署中随意打开。

### 15.3 文件与解析限制

当前常见支持范围取决于已配置提取器：

- PDF、DOCX、PPTX、XLSX、XLS、DOC、CSV、TXT、Markdown。
- PNG、JPG、WebP 可通过 OCR 提取图片文字，具体依赖视觉/OCR 提供商。
- 老式 `.ppt` 暂不支持可靠纯文本提取，应转换为 `.pptx`。
- 音视频需要启用 ASR，并确保运行环境有 `ffmpeg`、`ffprobe`，否则可能跳过本地媒体提取。

上传限制：

- 单文件不超过 50 MB。
- 每次不超过 10 个文件。
- 每次总大小不超过 150 MB。
- 模块一 JSON `materials[].text` 合计不超过 200,000 字符。
- 集成素材保存 24 小时，handoff 保存 2 小时。

上传到云模型、OCR 或文档解析服务的内容可能离开本机内网。涉及敏感材料时，应先确认提供商的数据策略和部署合规要求。

### 15.4 单实例限制

当前实现有以下进程内状态：

- 课程生成任务状态。
- HMAC nonce 防重放缓存。
- 部分运行时调度状态。

因此当前部署应按单 OpenMAIC 实例运行。需要多实例时，应先补齐共享任务存储、共享 nonce 存储和一致的 `data/` 持久化，再配置负载均衡；否则同一个 job、nonce 或 handoff 可能落到不同实例而失败。

### 15.5 运维检查清单

上线平台前逐项确认：

- [ ] OpenMAIC 访问地址已固定，平台和老师都能访问。
- [ ] `NEXT_PUBLIC_PERSISTENCE=1` 已参与 Docker 构建。
- [ ] PostgreSQL 数据卷和 `openmaic-data` 卷都已持久化。
- [ ] `.env.local` 不在 Git 中。
- [ ] `ACCESS_CODE` 和 `INTEGRATION_SHARED_SECRET` 已使用随机值。
- [ ] `INTEGRATION_PUBLIC_BASE_URL` 不是 `localhost`。
- [ ] 平台后端具备 HMAC-SHA256 能力，并能逐字节签名请求体。
- [ ] 平台轮询会为每次请求生成新 nonce。
- [ ] 模块一保留完整 outline 和 `Idempotency-Key`。
- [ ] 模块二只让浏览器访问 `redirectUrl`，不请求 `/payload` 或 `/result`。
- [ ] 已完成一次从平台发起、OpenMAIC 生成、平台取回 URL 的端到端验收。
- [ ] 已准备数据库和 `data/` 的联合备份。
