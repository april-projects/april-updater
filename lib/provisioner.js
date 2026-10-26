import { Client } from 'ssh2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, '..', 'keys');

/**
 * 服务器批量接入（密钥模式）：
 *   每台服务器一对独立密钥。导入时私钥落盘到 keys/<host>.pem（600），
 *   之后所有部署都引用该私钥文件，配置里不出现私钥明文。
 *   连接后扫描 Java 容器：容器名、jar 路径、映射端口，生成项目配置。
 */
export class Provisioner {
  /** 落盘私钥，返回配置里引用的路径 */
  static savePrivateKey(host, pem) {
    if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
      throw new Error(`${host}: 内容不是 PEM 私钥（缺少 BEGIN ... PRIVATE KEY）`);
    }
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    const file = path.join(KEYS_DIR, `${host}.pem`);
    fs.writeFileSync(file, pem.endsWith('\n') ? pem : pem + '\n', { mode: 0o600 });
    return file;
  }

  #connect({ host, port = 22, username = 'root', privateKeyPem, privateKeyPath, password }, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const cfg = { host, port, username, readyTimeout: timeoutMs };
      if (privateKeyPem) cfg.privateKey = privateKeyPem;
      else if (privateKeyPath) {
        const full = privateKeyPath.startsWith('~') ? path.join(os.homedir(), privateKeyPath.slice(1)) : privateKeyPath;
        try {
          cfg.privateKey = fs.readFileSync(full, 'utf8');
        } catch (err) {
          return reject(new Error(`${host}: 读取私钥失败 ${full}：${err.message}`));
        }
      } else if (password) cfg.password = password;
      else return reject(new Error(`${host}: 缺少私钥或密码`));
      const conn = new Client();
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`${host}: 连接超时`));
      }, timeoutMs);
      conn
        .on('ready', () => {
          clearTimeout(timer);
          resolve(conn);
        })
        .on('error', (err) => {
          clearTimeout(timer);
          const reason =
            err.level === 'authentication'
              ? '认证失败（私钥未在服务器上授权，或用户名不对）'
              : err.message;
          reject(new Error(`${host}: ${reason}`));
        })
        .connect(cfg);
    });
  }

  #exec(conn, cmd, opts = {}) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream
          .on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} 退出码 ${code}: ${stderr || stdout}`))))
          .on('data', (d) => (stdout += d.toString()))
          .stderr.on('data', (d) => (stderr += d.toString()));
      });
    });
  }

  /** 用私钥/密码连接并扫描 Java 服务 */
  async onboard(hostCfg) {
    const conn = await this.#connect(hostCfg);
    const result = { host: hostCfg.host, ok: false, services: [], error: null };
    try {
      const lines = await this.#exec(
        conn,
        `docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}' | grep -Ei 'java|openjdk|jdk' || true`
      );
      for (const line of lines.split('\n').filter(Boolean)) {
        const [name, image, ports] = line.split('\t');
        const svc = { containerName: name, image };

        try {
          const mounts = await this.#exec(conn, `docker inspect ${name} --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}'`);
          const appMount = mounts.split(' ').find((m) => m.endsWith(':/app'));
          if (appMount) {
            const src = appMount.split(':')[0].replace(/\/app$/, '');
            const jars = await this.#exec(conn, `ls ${src}/*.jar 2>/dev/null | head -3 || true`);
            const jarList = jars.trim().split('\n').filter(Boolean);
            if (jarList.length === 1) svc.remoteJarPath = jarList[0];
            else if (jarList.length > 1) svc.jarCandidates = jarList;
          }
        } catch { /* 容器结构特殊，跳过 jar 探测 */ }

        const portMatch = ports.match(/0\.0\.0\.0:(\d+)->/);
        if (portMatch) {
          svc.hostPort = Number(portMatch[1]);
          svc.healthUrl = `http://${hostCfg.host}:${svc.hostPort}/actuator/health`;
        }
        result.services.push(svc);
      }
      result.ok = true;
    } catch (err) {
      result.error = err.message;
    } finally {
      conn.end();
    }
    return result;
  }

  /** 生成「服务器 + 服务列表」配置片段 */
  buildServer(discovered, privateKeyPath) {
    const host = discovered.host;
    return {
      name: host,
      host,
      port: 22,
      username: 'root',
      privateKeyPath,
      services: discovered.services
        .filter((s) => s.remoteJarPath)
        .map((s) => ({
          name: s.containerName,
          localJarDir: `~/Developer/jars/${s.containerName}`,
          healthCheck: { timeoutSec: 120, intervalSec: 5 },
          remoteJarPath: s.remoteJarPath,
          containerName: s.containerName,
          restartCommand: `docker restart ${s.containerName}`,
          restartTimeoutSec: 60,
          ...(s.healthUrl ? { healthUrl: s.healthUrl } : {}),
        })),
    };
  }
}
