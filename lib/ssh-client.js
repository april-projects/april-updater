import { Client } from 'ssh2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * SSH/SFTP 客户端：上传 jar、执行备份/重启命令。
 * 认证支持私钥（privateKeyPath）或密码（password）。
 */
export class SshClient {
  constructor({ host, port = 22, username = 'root', privateKeyPath, password, connectTimeoutMs = 15000 }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.privateKeyPath = privateKeyPath;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  /** 建立连接并保持（复用于一次部署的多个命令） */
  connect() {
    return new Promise((resolve, reject) => {
      const cfg = {
        host: this.host,
        port: this.port,
        username: this.username,
        readyTimeout: this.connectTimeoutMs,
      };
      if (this.privateKeyPath) {
        const keyPath = this.privateKeyPath.startsWith('~')
          ? path.join(os.homedir(), this.privateKeyPath.slice(1))
          : this.privateKeyPath;
        try {
          cfg.privateKey = fs.readFileSync(keyPath, 'utf8');
        } catch (err) {
          // 容器内运行的回退：宿主机路径解析不到时，尝试 keys/ 目录同名文件
          const fallback = path.join('/app/keys', path.basename(keyPath));
          try {
            cfg.privateKey = fs.readFileSync(fallback, 'utf8');
          } catch {
            return reject(new Error(`读取私钥失败 ${keyPath}：${err.message}`));
          }
        }
      }
      if (this.password) cfg.password = this.password;
      const conn = new Client();
      conn
        .on('ready', () => resolve(conn))
        .on('error', (err) => reject(new Error(`SSH 连接失败 ${this.username}@${this.host}:${this.port}：${err.message}`)))
        .connect(cfg);
    });
  }

  /** 在连接上执行命令，非 0 退出码抛错 */
  exec(conn, command, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.close();
          reject(new Error(`命令超时（${timeoutMs}ms）：${command}`));
        }, timeoutMs);
        stream
          .on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`命令退出码 ${code}：${command}\n${stderr || stdout}`.trim()));
          })
          .on('data', (d) => (stdout += d.toString()))
          .stderr.on('data', (d) => (stderr += d.toString()));
      });
    });
  }

  /** SFTP 上传本地文件到远端完整路径 */
  upload(conn, localPath, remotePath) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(new Error(`打开 SFTP 失败：${err.message}`));
        const ws = sftp.createWriteStream(remotePath);
        ws.on('error', (e) => reject(new Error(`SFTP 写入失败 ${remotePath}：${e.message}`)))
          .on('close', () => resolve())
          .end(fs.readFileSync(localPath));
      });
    });
  }

  close(conn) {
    conn.end();
  }
}

/** 便捷封装：单命令场景（测试连通性等） */
export async function sshExecOnce(serverCfg, command, opts) {
  const client = new SshClient(serverCfg);
  const conn = await client.connect();
  try {
    return await client.exec(conn, command, opts);
  } finally {
    client.close(conn);
  }
}
