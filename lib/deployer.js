import fs from 'node:fs';
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
  }

  newJob(server, serviceName, jarPath) {
    const id = `job-${Date.now()}-${++this.jobSeq}`;
    const job = {
      id,
      server: server.name,
      service: serviceName,
      host: `${server.username}@${server.host}`,
      jarPath,
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

  /** 对服务器的某个服务执行部署，过程实时写入 job.steps，前端轮询 */
  deploy(server, serviceName, jarPath, { skipHealth = false } = {}) {
    const service = server.services.find((x) => x.name === serviceName);
    const job = this.newJob(server, serviceName, jarPath);
    this.#run(server, service, jarPath, job, { skipHealth }).catch(() => {});
    return job;
  }

  async #run(server, service, jarPath, job, { skipHealth }) {
    const ssh = new SshClient(server);
    const remoteJar = service.remoteJarPath;
    const backupPath = `${remoteJar}.bak`;

    let conn;
    let uploaded = false;
    try {
      conn = await ssh.connect();

      // 1. 备份旧 jar（首次部署远端无文件时跳过）
      const s1 = this.#step(job, '备份旧版本');
      const check = await ssh.exec(conn, `[ -f '${remoteJar}' ] && echo yes || echo no`, { timeoutMs: 15000 });
      if (check.stdout.trim() === 'yes') {
        await ssh.exec(conn, `mv -f '${remoteJar}' '${backupPath}'`);
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

      // 4. 健康检查
      if (skipHealth) {
        this.#step(job, '健康检查').skip('已跳过');
      } else {
        const s4 = this.#step(job, '健康检查');
        try {
          const code = await this.#healthCheck(service.healthUrl, service.healthCheck);
          s4.ok(`服务健康（HTTP ${code}）`);
        } catch (err) {
          s4.fail(err.message);
          throw err;
        }
      }

      job.status = 'success';
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
    }
  }

  async #rollback(ssh, conn, server, service, job, remoteJar, backupPath, skipHealth) {
    const step = this.#step(job, '回滚');
    try {
      await ssh.exec(conn, `mv -f '${backupPath}' '${remoteJar}'`);
      step.update('已还原备份，正在重启旧版本...');
      await ssh.exec(conn, service.restartCommand, { timeoutMs: (service.restartTimeoutSec || 60) * 1000 });
      if (!skipHealth) {
        await this.#healthCheck(service.healthUrl, service.healthCheck);
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
