import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFile } from 'node:child_process';
import { SshClient } from './ssh-client.js';

/**
 * 部署流水线（每个目标服务器一条，互不影响）：
 *   备份旧 jar（mv → .bak）→ SFTP 上传新 jar → 执行重启命令 → 健康检查
 *   任一步失败 → 自动回滚（还原备份 jar → 重启 → 健康检查）
 */
export class Deployer {
  constructor() {
    /** @type {Map<string, object>} jobId -> job */
    this.jobs = new Map();
    this.jobSeq = 0;
    // 部署历史持久化（JSONL，一行一条），容器内通过挂载 data/ 目录持久化
    this.historyPath = process.env.HISTORY_PATH || path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'data', 'history.jsonl');
  }

  newJob(server, targetName, artifactPath, type = 'service') {
    const id = `job-${Date.now()}-${++this.jobSeq}`;
    const job = {
      id,
      type, // service | site
      server: server.name,
      service: targetName,
      host: `${server.username}@${server.host}`,
      jarPath: artifactPath,
      status: 'running', // running | success | failed | rolled-back
      steps: [], // {name, status: running|done|failed|skipped, message}
      createdAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.jobs.set(id, job);
    return job;
  }

  #step(job, name) {
    const step = { name, status: 'running', message: '' };
    job.steps.push(step);
    return {
      ok(msg) {
        step.status = 'done';
        step.message = msg;
      },
      fail(msg) {
        step.status = 'failed';
        step.message = msg;
      },
      skip(msg) {
        step.status = 'skipped';
        step.message = msg;
      },
      update(msg) {
        step.message = msg;
      },
      step,
    };
  }

  async #healthCheck(url, opts = {}) {
    const { timeoutSec = 120, intervalSec = 5 } = opts || {};
    if (!url) throw new Error('未配置健康检查地址 healthUrl');
    const deadline = Date.now() + timeoutSec * 1000;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) return res.status;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err.cause?.code || err.message;
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
    throw new Error(`健康检查超时（${timeoutSec}s），最后一次结果：${url} → ${lastErr}`);
  }

  /**
   * 容器状态健康检查（无 healthUrl 时的降级方案）：
   * 容器持续运行 graceSec 秒且 RestartCount 未增长 → 健康；crash loop 会一直等到超时。
   */
  async #containerCheck(ssh, conn, service, graceSec = 30) {
    const { timeoutSec = 120, intervalSec = 5 } = service.healthCheck || {};
    const name = service.containerName;
    if (!name) throw new Error('未配置 healthUrl 且未配置 containerName，无法执行健康检查');
    const cmd = `docker inspect -f '{{.State.Status}} {{.RestartCount}}' '${name}' 2>/dev/null || echo missing -1`;
    const deadline = Date.now() + timeoutSec * 1000;
    let baseline = null;
    let stableSince = null;
    while (Date.now() < deadline) {
      const { stdout } = await ssh.exec(conn, cmd, { timeoutMs: 15000 });
      const [status, rcRaw] = stdout.trim().split(/\s+/);
      const rc = parseInt(rcRaw, 10);
      if (status === 'running') {
        if (baseline === null || rc < baseline) {
          baseline = rc;
          stableSince = Date.now();
        } else if (rc === baseline && Date.now() - stableSince >= graceSec * 1000) {
          return `容器持续运行 ${graceSec}s，重启计数未增长（${rc}）`;
        }
        // rc > baseline：容器被重启策略反复拉起（crash loop），继续观察直到超时
      } else {
        baseline = null;
        stableSince = null;
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
    throw new Error(`容器健康检查超时（${timeoutSec}s）：${name} 未稳定运行（可能处于 crash loop）`);
  }

  /** 对服务器的某个服务执行部署，过程实时写入 job.steps，前端轮询 */
  deploy(server, serviceName, jarPath, { skipHealth = false } = {}) {
    const service = server.services.find((x) => x.name === serviceName);
    const job = this.newJob(server, serviceName, jarPath);
    this.#run(server, service, jarPath, job, { skipHealth }).catch(() => {});
    return job;
  }

  /**
   * 前端站点部署：本地打包 dist 为 tar.gz → 备份远端站点目录 → 上传 → 解压 → 验证 index.html。
   * archivePath 传入已存在的 dist 压缩包（手动上传场景）时跳过打包步骤。
   */
  deploySite(server, siteName, archivePath) {
    const site = (server.sites || []).find((x) => x.name === siteName);
    const job = this.newJob(server, siteName, archivePath, 'site');
    this.#runSite(server, site, archivePath, job).catch(() => {});
    return job;
  }

  /** 本地打包 dist 目录为 tar.gz（busybox tar 兼容），返回压缩包路径 */
  #packDist(distDir) {
    const out = path.join(os.tmpdir(), `april-dist-${Date.now()}-${process.pid}.tar.gz`);
    return new Promise((resolve, reject) => {
      execFile('tar', ['-czf', out, '--exclude', '.uploads', '-C', distDir, '.'], (err) => {
        if (err) reject(new Error(`打包 dist 失败：${err.message}`));
        else resolve(out);
      });
    });
  }

  async #runSite(server, site, archivePath, job) {
    const ssh = new SshClient(server);
    const remoteRoot = site.remoteRoot;
    let conn;
    let packed = null; // 本地临时 tar.gz（自动打包时）
    let backupPath = null;
    let uploaded = false;
    const ts = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    try {
      if (!remoteRoot) throw new Error('该站点未配置 remoteRoot');
      if (!archivePath) {
        const distDir = site.localDistDir ? site.localDistDir.replace(/^~/, process.env.HOME || '') : null;
        if (!distDir || !fs.existsSync(distDir)) throw new Error(`本地 dist 目录不存在：${distDir || '未配置 localDistDir'}`);
        const s0 = this.#step(job, '打包 dist');
        try {
          packed = await this.#packDist(distDir);
          archivePath = packed;
          s0.ok(`${distDir} → ${(fs.statSync(packed).size / 1048576).toFixed(1)} MB`);
        } catch (err) {
          s0.fail(err.message);
          throw err;
        }
      }

      conn = await ssh.connect();

      // 1. 备份旧版本：整个站点目录改名为带时间戳的 .bak
      const s1 = this.#step(job, '备份旧版本');
      const check = await ssh.exec(conn, `[ -d '${remoteRoot}' ] && echo yes || echo no`, { timeoutMs: 15000 });
      if (check.stdout.trim() === 'yes') {
        const r = await ssh.exec(
          conn,
          `b='${remoteRoot}.bak.'$(date +%Y%m%d-%H%M%S); mv -f '${remoteRoot}' "$b" && echo "$b"`,
          { timeoutMs: 15000 }
        );
        backupPath = r.stdout.trim();
        s1.ok(`${remoteRoot} → ${backupPath}`);
      } else {
        s1.skip('远端无旧目录（首次部署）');
      }

      // 2. 上传压缩包到远端临时目录
      const remoteArchive = `/tmp/april-dist-${ts()}.tar.gz`;
      const s2 = this.#step(job, '上传 dist 包');
      try {
        const sizeMb = ((fs.statSync(archivePath).size / 1048576) | 0);
        await ssh.upload(conn, archivePath, remoteArchive);
        s2.ok(`已上传至 ${remoteArchive}（${sizeMb} MB）`);
        uploaded = true;
      } catch (err) {
        s2.fail(err.message);
        throw err;
      }

      // 3. 解压到站点目录
      const s3 = this.#step(job, '解压发布');
      try {
        await ssh.exec(conn, `mkdir -p '${remoteRoot}' && tar -xzf '${remoteArchive}' -C '${remoteRoot}'`, { timeoutMs: 120000 });
        s3.ok(`已解压至 ${remoteRoot}`);
      } catch (err) {
        s3.fail(err.message);
        throw err;
      }

      // 4. 验证 index.html
      const s4 = this.#step(job, '验证');
      const verify = await ssh.exec(conn, `[ -f '${remoteRoot}/index.html' ] && echo yes || echo no`, { timeoutMs: 15000 });
      if (verify.stdout.trim() === 'yes') {
        s4.ok('index.html 存在，发布完成');
      } else {
        s4.fail(`${remoteRoot}/index.html 不存在（dist 内容可能不对）`);
        throw new Error(`验证失败：${remoteRoot}/index.html 不存在`);
      }

      job.status = 'success';
      // 清理：旧备份保留最近 5 个，删除远端临时包
      await ssh.exec(
        conn,
        `ls -1d '${remoteRoot}.bak.'* 2>/dev/null | sort -r | tail -n +6 | xargs -r rm -rf; rm -f '${remoteArchive}'`,
        { timeoutMs: 15000 }
      ).catch(() => {});
    } catch (err) {
      job.error = err.message;
      if (!uploaded) {
        // 上传前失败：还原备份目录
        if (conn && backupPath) {
          await ssh.exec(conn, `[ -d '${backupPath}' ] && mv -f '${backupPath}' '${remoteRoot}' || true`)
            .catch(() => {});
        }
        job.status = 'failed';
      } else {
        try {
          const step = this.#step(job, '回滚');
          await ssh.exec(conn, `rm -rf '${remoteRoot}' && mv -f '${backupPath}' '${remoteRoot}'`);
          step.ok('已还原旧版本目录');
          job.status = 'rolled-back';
        } catch (rbErr) {
          job.status = 'failed';
          job.error = `${err.message}；回滚失败：${rbErr.message}（需人工介入，备份位于 ${backupPath}）`;
        }
      }
    } finally {
      if (packed) fs.rmSync(packed, { force: true });
      if (conn) ssh.close(conn);
      job.finishedAt = new Date().toISOString();
      this.#persist(job);
    }
  }

  async #run(server, service, jarPath, job, { skipHealth }) {
    const ssh = new SshClient(server);
    const remoteJar = service.remoteJarPath;

    let conn;
    let backupPath = null; // 本次部署对应的备份文件（带时间戳）
    let uploaded = false;
    try {
      conn = await ssh.connect();

      // 1. 备份旧版本为带时间戳文件（首次部署远端无文件时跳过）
      const s1 = this.#step(job, '备份旧版本');
      const check = await ssh.exec(conn, `[ -f '${remoteJar}' ] && echo yes || echo no`, { timeoutMs: 15000 });
      if (check.stdout.trim() === 'yes') {
        const r = await ssh.exec(
          conn,
          `b='${remoteJar}.bak.'$(date +%Y%m%d-%H%M%S); mv -f '${remoteJar}' "$b" && echo "$b"`,
          { timeoutMs: 15000 }
        );
        backupPath = r.stdout.trim();
        s1.ok(`${remoteJar} → ${backupPath}`);
      } else {
        s1.skip('远端无旧文件（首次部署）');
      }

      // 2. 上传
      const s2 = this.#step(job, '上传新 jar');
      try {
        const sizeMb = ((fs.statSync(jarPath).size / 1048576) | 0);
        await ssh.upload(conn, jarPath, remoteJar);
        s2.ok(`已上传至 ${remoteJar}（${sizeMb} MB）`);
        uploaded = true;
      } catch (err) {
        s2.fail(err.message);
        throw err;
      }

      // 3. 重启
      const s3 = this.#step(job, '重启服务');
      try {
        await ssh.exec(conn, service.restartCommand, { timeoutMs: (service.restartTimeoutSec || 60) * 1000 });
        s3.ok(service.restartCommand);
      } catch (err) {
        s3.fail(err.message);
        throw err;
      }

      // 4. 健康检查：配置了 healthUrl 走 HTTP 轮询，否则降级为容器状态检查
      if (skipHealth) {
        this.#step(job, '健康检查').skip('已跳过');
      } else if (service.healthUrl) {
        const s4 = this.#step(job, '健康检查');
        try {
          const code = await this.#healthCheck(service.healthUrl, service.healthCheck);
          s4.ok(`服务健康（HTTP ${code}）`);
        } catch (err) {
          s4.fail(err.message);
          throw err;
        }
      } else {
        const s4 = this.#step(job, '健康检查（容器状态）');
        try {
          const msg = await this.#containerCheck(ssh, conn, service);
          s4.ok(msg);
        } catch (err) {
          s4.fail(err.message);
          throw err;
        }
      }

      job.status = 'success';
      // 清理旧备份，仅保留最近 5 个
      await ssh.exec(
        conn,
        `ls -1d '${remoteJar}.bak.'* 2>/dev/null | sort -r | tail -n +6 | xargs -r rm -f`,
        { timeoutMs: 15000 }
      ).catch(() => {});
    } catch (err) {
      job.error = err.message;
      if (!uploaded) {
        // 上传前失败，远端未发生变更（备份已完成 mv 但原文件仍以 .bak 存在，还原）
        if (conn && backupPath) {
          await ssh.exec(conn, `[ -f '${backupPath}' ] && mv -f '${backupPath}' '${remoteJar}' || true`)
            .catch(() => {});
        }
        job.status = 'failed';
      } else {
        try {
          await this.#rollback(ssh, conn, server, service, job, remoteJar, backupPath, skipHealth);
          job.status = 'rolled-back';
        } catch (rbErr) {
          job.status = 'failed';
          job.error = `${err.message}；回滚失败：${rbErr.message}（需人工介入，备份位于 ${backupPath}）`;
        }
      }
    } finally {
      if (conn) ssh.close(conn);
      job.finishedAt = new Date().toISOString();
      this.#persist(job);
    }
  }

  /** 部署结束（成功/失败/回滚）后追加写入历史文件；落盘失败只记日志，不影响部署结果 */
  #persist(job) {
    try {
      fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
      fs.appendFileSync(this.historyPath, JSON.stringify(job) + '\n', 'utf8');
    } catch (err) {
      console.error('写入部署历史失败:', err.message);
    }
  }

  /** 读取持久化历史，按创建时间倒序 */
  readHistory() {
    try {
      return fs.readFileSync(this.historyPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  async #rollback(ssh, conn, server, service, job, remoteJar, backupPath, skipHealth) {
    const step = this.#step(job, '回滚');
    try {
      await ssh.exec(conn, `mv -f '${backupPath}' '${remoteJar}'`);
      step.update('已还原备份，正在重启旧版本...');
      await ssh.exec(conn, service.restartCommand, { timeoutMs: (service.restartTimeoutSec || 60) * 1000 });
      if (!skipHealth) {
        if (service.healthUrl) await this.#healthCheck(service.healthUrl, service.healthCheck);
        else await this.#containerCheck(ssh, conn, service);
        step.ok('已回滚到旧版本并通过健康检查');
      } else {
        step.ok('已回滚到旧版本（未做健康检查）');
      }
    } catch (err) {
      step.fail(err.message);
      throw err;
    }
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
