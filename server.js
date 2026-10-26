import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { sshExecOnce } from './lib/ssh-client.js';
import { Deployer } from './lib/deployer.js';
import { Provisioner } from './lib/provisioner.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  // 环境变量占位符：${VAR}，避免密钥写死在配置文件
  return JSON.parse(raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? ''));
}

function resolveDir(dir) {
  const expanded = dir.startsWith('~') ? path.join(process.env.HOME || '', dir.slice(1)) : dir;
  return path.resolve(expanded);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const deployer = new Deployer();

// ---- 配置 ----
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  // 不向前端泄露密钥
  const safe = {
    servers: (config.servers || []).map((srv) => {
      const { password, privateKeyPath, ...rest } = srv;
      return { ...rest, hasAuth: Boolean(password || privateKeyPath) };
    }),
  };
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ ok: true });
});

// 原始配置文本（供编辑器展示；密码已脱敏）
app.get('/api/config/raw', (req, res) => {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  res.type('application/json').send(raw.replace(/("password"\s*:\s*")([^"]*)(")/g, '$1${SSH_PASSWORD}$3'));
});

// 本地 jar 目录扫描（“读取配置好的 jar”）
app.get('/api/jars', (req, res) => {
  const config = loadConfig();
  const server = (config.servers || []).find((s) => s.name === req.query.server);
  const service = server?.services.find((x) => x.name === req.query.service);
  if (!service?.localJarDir) return res.status(404).json({ error: '该服务未配置 localJarDir' });
  const dir = resolveDir(service.localJarDir);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: `目录不存在：${dir}` });
  const jars = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  res.json({ dir, jars });
});

// 上传 jar 到项目的构建产物目录
app.post('/api/upload-jar', express.raw({ type: '*/*', limit: '512mb' }), (req, res) => {
  const config = loadConfig();
  const server = (config.servers || []).find((s) => s.name === req.headers['x-server']);
  const service = server?.services.find((x) => x.name === req.headers['x-service']);
  if (!service?.localJarDir) return res.status(400).json({ error: '该服务未配置 localJarDir' });
  const buf = req.body;
  if (!buf?.length) return res.status(400).json({ error: '空的上传内容' });
  const jarName = path.basename(req.headers['x-filename'] || 'upload.jar');
  fs.writeFileSync(path.join(resolveDir(service.localJarDir), jarName), buf);
  res.json({ jarName });
});

// ---- SSH 连通性 ----
app.post('/api/ssh/ping', async (req, res) => {
  const config = loadConfig();
  const server = (config.servers || []).find((s) => s.name === req.body.server);
  if (!server) return res.status(404).json({ error: '未找到目标服务器配置' });
  try {
    const { stdout } = await sshExecOnce(server, 'echo ok');
    res.json({ ok: true, info: stdout.trim() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 远端状态：jar 文件信息 + 容器状态
app.post('/api/ssh/status', async (req, res) => {
  const config = loadConfig();
  const server = (config.servers || []).find((s) => s.name === req.body.server);
  const service = server?.services.find((x) => x.name === req.body.service);
  if (!server || !service) return res.status(404).json({ error: '未找到目标服务器/服务配置' });
  const jar = service.remoteJarPath;
  const cmd = [
    `[ -f '${jar}' ] && stat -c '%y %s' '${jar}' || echo '无 jar 文件'`,
    `[ -f '${jar}.bak' ] && echo '存在备份 ${jar}.bak' || true`,
    service.containerName
      ? `docker ps -a --filter name=^${service.containerName}$ --format '{{.Names}} {{.Status}}' 2>/dev/null || true`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  try {
    const { stdout } = await sshExecOnce(server, cmd);
    res.json({ ok: true, info: stdout.trim() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ---- 服务器批量接入（密钥模式）----
const provisioner = new Provisioner();

/**
 * entries: [{ host, username?, privateKeyPem, password? }]
 * 私钥落盘 keys/<host>.pem，之后配置引用文件路径。
 */
app.post('/api/servers/onboard', async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: '需要 entries 数组（host + privateKeyPem）' });
  }
  const prepared = [];
  for (const e of entries) {
    const host = (e.host || '').trim();
    if (!host) continue;
    try {
      const privateKeyPath = e.privateKeyPem
        ? Provisioner.savePrivateKey(host, e.privateKeyPem)
        : e.privateKeyPath;
      prepared.push({
        hostCfg: {
          host,
          port: e.port || 22,
          username: e.username || 'root',
          privateKeyPem: e.privateKeyPem,
          privateKeyPath,
          password: e.password,
        },
        privateKeyPath,
      });
    } catch (err) {
      prepared.push({ hostCfg: { host }, error: err.message });
    }
  }

  const results = await Promise.all(
    prepared.map(async (p) => {
      if (p.error) return { host: p.hostCfg.host, ok: false, error: p.error, services: [] };
      try {
        const r = await provisioner.onboard(p.hostCfg);
        return { ...r, privateKeyPath: p.privateKeyPath };
      } catch (err) {
        return { host: p.hostCfg.host, ok: false, error: err.message, services: [] };
      }
    })
  );
  res.json({
    servers: results
      .filter((r) => r.ok && r.privateKeyPath && r.services.some((x) => x.remoteJarPath))
      .map((r) => provisioner.buildServer(r, r.privateKeyPath)),
    results,
  });
});

// 把扫描到的服务合并进 config.json（按服务器聚合；同名服务跳过，force 覆盖）
app.post('/api/servers/adopt', (req, res) => {
  const { servers, force = false } = req.body;
  if (!Array.isArray(servers)) return res.status(400).json({ error: '需要 servers 数组' });
  const config = loadConfig();
  config.servers = config.servers || [];
  let added = 0;
  let skipped = 0;
  for (const incoming of servers) {
    let srv = config.servers.find((x) => x.host === incoming.host);
    if (!srv) {
      srv = { ...incoming, services: [] };
      config.servers.push(srv);
    } else {
      // 补充连接信息（若已有条目缺认证）
      if (!srv.privateKeyPath && incoming.privateKeyPath) srv.privateKeyPath = incoming.privateKeyPath;
    }
    for (const svc of incoming.services || []) {
      const idx = srv.services.findIndex((x) => x.name === svc.name);
      if (idx >= 0) {
        if (force) srv.services[idx] = svc;
        else skipped++;
        continue;
      }
      srv.services.push(svc);
      added++;
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  // 顺带创建本地 jar 目录
  for (const srv of servers) {
    for (const svc of srv.services || []) {
      if (!svc.localJarDir) continue;
      const dir = resolveDir(svc.localJarDir);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }
  res.json({ added, skipped });
});

// ---- 部署 ----
app.post('/api/deploy', (req, res) => {
  const { server: serverName, service: serviceName, jarName } = req.body;
  const config = loadConfig();
  const srv = (config.servers || []).find((s) => s.name === serverName);
  if (!srv) return res.status(404).json({ error: `服务器不存在：${serverName}` });
  const svc = (srv.services || []).find((x) => x.name === serviceName);
  if (!svc) return res.status(404).json({ error: `服务不存在：${serviceName}` });
  if (!svc.localJarDir) return res.status(400).json({ error: '该服务未配置 localJarDir' });
  const jarPath = path.join(resolveDir(svc.localJarDir), jarName);
  if (!fs.existsSync(jarPath)) return res.status(400).json({ error: `jar 不存在：${jarPath}` });
  const job = deployer.deploy(srv, serviceName, jarPath, req.body);
  res.json({ jobs: [job.id] });
});

app.get('/api/jobs', (req, res) => {
  res.json(deployer.listJobs());
});

app.get('/api/jobs/:id', (req, res) => {
  const job = deployer.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job 不存在' });
  res.json(job);
});

const PORT = process.env.PORT || 5230;
app.listen(PORT, () => {
  console.log(`Java Updater（SSH 模式）已启动：http://127.0.0.1:${PORT}`);
});
