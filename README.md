# Java Updater

<p align="center">
  <b>一个面向 Java 服务的自动化发布工具：选 jar → SSH 上传 → 重启 → 健康检查 → 失败自动回滚</b><br>
  为「几十台服务器、每次更新都要逐台登录传包重启」的场景而生。
</p>

---

## 为什么做这个

如果你维护着一批部署在多台服务器上的 Java 服务（尤其是用 [1Panel](https://github.com/1Panel-dev/1Panel) 面板 + Docker 跑的），每次发版大概是这样的：

1. SSH 登录服务器 A，备份旧 jar，上传新 jar，重启，盯日志确认起来没
2. 登录服务器 B，重复一遍
3. 登录服务器 C……手一抖传错包、忘了备份、重启后发现起不来又得翻备份

这个工具把整个流程变成页面上的一次点击：

- ✅ 按服务器管理，自动扫描服务器上的 Java 容器、jar 路径、端口，**零手工配置接入**
- ✅ 批量导入服务器：粘贴「IP + 私钥」即可，私钥落盘加密权限保存，配置文件不出现明文
- ✅ 部署流水线：**备份 → 上传（SFTP）→ 重启 → 健康检查轮询**，每一步实时可视化
- ✅ **失败自动回滚**：健康检查不过就还原备份、重启旧版本，并再次确认旧版本健康
- ✅ 各服务器独立执行、互不影响，单台失败不影响其他台
- ✅ 支持 Docker 部署本工具自身

> 它只依赖 SSH —— 任何能用 SSH 登录的服务器都能用，与具体面板无关。

## 工作原理

```
                     ┌──────────────────────────────────────────┐
   本地 jar 目录      │              Java Updater              │       目标服务器（N 台）
  ┌────────────┐     │  ┌────────┐  ┌─────────┐  ┌───────────┐  │     ┌─────────────────┐
  │ app-1..jar │───▶ │  │ Web UI │─▶│ Deployer│─▶│ SSH/SFTP  │──┼───▶ │ backup: app.jar │
  │ app-2.jar  │     │  └────────┘  └─────────┘  └───────────┘  │     │   ↓ mv .bak     │
  └────────────┘     │       ↑ 轮询任务状态        │             │     │ upload: app.jar │
                     │                            │             │     │ restart cmd     │
                     └────────────────────────────┼─────────────┘     │ health check    │
                                                  │                   │  ↘ 失败→回滚     │
                                            健康检查 URL               └─────────────────┘
```

每台服务器的部署流程：

| 步骤 | 动作 | 失败处理 |
|---|---|---|
| 1. 备份 | `mv app.jar app.jar.bak`（远端无旧文件则跳过） | — |
| 2. 上传 | SFTP 写入新 jar | 还原备份 |
| 3. 重启 | 执行配置的 `restartCommand`（如 `docker restart xxx`） | 还原备份 + 重启旧版本 |
| 4. 健康检查 | 轮询 `healthUrl` 直到 2xx（默认 120s 超时、5s 间隔） | 同上，并再次确认旧版本健康 |

## 快速开始

### 方式一：Node 直接运行（Node ≥ 20）

```bash
git clone https://github.com/april-projects/april-updater.git
cd april-updater
npm install
cp config.example.json config.json   # 按需修改
npm start
# 打开 http://127.0.0.1:5230
```

### 方式二：Docker（推荐）

镜像由 GitHub Actions 自动构建并发布到 GHCR（多架构 amd64/arm64，公开可用）：

```bash
docker pull ghcr.io/april-projects/april-updater:latest

git clone https://github.com/april-projects/april-updater.git
cd april-updater/deploy
cp ../config.example.json ./config.json   # 按需修改
docker compose up -d
```

本地构建则注释掉 compose 里的 `image` 行、启用 `build: ..` 后 `docker compose up -d --build`。容器需要挂载：配置文件、导入的私钥目录、`~/.ssh`（只读）、本地 jar 产物目录。

## 批量接入服务器

首次使用不需要手写配置。点击页面右上角 **「接入服务器」**，每台服务器一段粘贴：

```
47.83.16.102
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjE...
-----END OPENSSH PRIVATE KEY-----
8.8.8.8
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

点击「扫描」，工具会对每台服务器并行执行：

1. **私钥落盘**到 `keys/<IP>.pem`（权限 `600`），配置只引用文件路径
2. 用该密钥 SSH 连接，扫描 Java 容器（容器名、jar 挂载路径、jar 文件、端口映射）
3. 自动生成配置：`docker restart <容器名>` 作为重启命令，映射端口拼出健康检查地址
4. 确认后保存，同名服务自动去重

> 没有密码登录也完全没关系 —— 密钥模式是主要使用方式。扫描失败的机器会逐台显示原因，不影响其他台。

## 配置说明

配置以**服务器**为单位，每台服务器下挂它的若干 Java 服务：

```json
{
  "servers": [
    {
      "name": "1.2.3.4",
      "host": "1.2.3.4",
      "port": 22,
      "username": "root",
      "privateKeyPath": "keys/1.2.3.4.pem",
      "services": [
        {
          "name": "order-service",
          "localJarDir": "~/Developer/jars/order-service",
          "remoteJarPath": "/opt/order-service/app.jar",
          "containerName": "order-service",
          "restartCommand": "docker restart order-service",
          "restartTimeoutSec": 60,
          "healthUrl": "http://1.2.3.4:8080/actuator/health",
          "healthCheck": { "timeoutSec": 120, "intervalSec": 5 }
        }
      ]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| 服务器 `privateKeyPath` / `password` | SSH 认证方式二选一；`password` 支持 `${ENV_VAR}` 环境变量占位符 |
| 服务 `localJarDir` | 本地构建产物目录，页面按修改时间倒序扫描 `.jar`，也支持页面上传 |
| 服务 `remoteJarPath` | 服务器上 jar 完整路径，部署时自动备份为 `<path>.bak` |
| 服务 `restartCommand` | 重启命令，任意可执行 shell 命令均可 |
| 服务 `healthUrl` | 健康检查地址，返回 2xx 判定成功；不配置则跳过该步骤 |

日常发版：把构建好的 jar 放进 `localJarDir`（或页面上传）→ 选服务器、选服务、选 jar → **开始部署**，盯进度条就行。

## 安全设计

- 私钥文件权限 `600`，仅存于工具本机 `keys/` 目录，永不回显到页面、不写入配置
- 配置中的密码支持环境变量占位符（`${VAR}`），避免明文入库
- 页面 API 永远不返回密钥内容
- 工具对远端的写操作仅限：`remoteJarPath` 与它的 `.bak`，外加执行你自己配置的 `restartCommand`
- 建议为工具单独生成一对密钥，并在服务器上只授予部署所需权限

## 目录结构

```
april-updater/
├── server.js              # Express API 与静态资源
├── lib/
│   ├── ssh-client.js      # SSH/SFTP 客户端封装（ssh2）
│   ├── deployer.js        # 部署/回滚流水线
│   └── provisioner.js     # 服务器批量接入与 Java 服务扫描
├── public/index.html      # 单页前端（无构建步骤）
├── config.example.json    # 配置示例
├── keys/                  # 导入的私钥（gitignore）
└── config.json            # 实际配置（gitignore）
```

## FAQ

**Q: 必须用 1Panel 吗？**
A: 不用。工具只依赖 SSH，任何能跑 Java 服务的 Linux 服务器都适用。1Panel 用户的好处是「接入服务器」的自动扫描对 1Panel 的 Java 运行时容器识别得很好。

**Q: 健康检查返回 401？**
A: 说明你的服务对 `/actuator/health` 做了鉴权。在 Spring Security 里放行该路径，或把 `healthUrl` 换成任一无需认证、返回 2xx 的接口。

**Q: 多台服务器部署同一个服务？**
A: 把多台服务器的同名服务放进各自的 `services` 列表，分别部署即可。目前部署粒度是「单台服务器上的单个服务」，跨服务器编排在计划中。

**Q: 部署记录会持久化吗？**
A: 不会，记录在内存中，工具重启后清空。服务器上的 `.bak` 备份文件不受影响。

**Q: 误删了服务器上的 jar 怎么办？**
A: 部署前的旧版本永远以 `.bak` 后缀留在同目录，手工 `mv` 回去重启即可。

## License

[MIT](LICENSE)

---

**Warning / 免责声明**：本工具会通过 SSH 修改远端文件并重启服务，请务必先在测试环境验证流程，并为线上服务器做好备份。将密钥交给工具前，请确认你了解它将获得的权限。
