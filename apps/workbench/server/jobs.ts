import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../shared/types.js';

const iso = () => new Date().toISOString();
const active = (task: Task) => ['queued', 'running', 'waiting', 'cancelling'].includes(task.status);

/** One serial execution queue per workspace, with truthful cancellation states. */
export class Jobs {
  tasks: Task[] = [];
  controllers = new Map<string, AbortController>();
  private chain = Promise.resolve();
  private writes = Promise.resolve();
  private committing = new Set<string>();
  constructor(private directory: string) {}

  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, 'tasks.json'), 'utf8'));
      if (!Array.isArray(saved)) throw new Error('任务记录格式无效。');
      this.tasks = saved;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('任务记录无法读取，已保留原文件，请检查 .workbench/tasks.json。');
    }
    for (const task of this.tasks) if (active(task)) {
      task.status = 'interrupted'; task.error = '应用上次结束时此任务未完成，可重新执行。';
      this.event(task, task.error, 'warning');
    }
    this.persist(); await this.flush();
  }
  persist() {
    const snapshot = JSON.stringify(this.tasks.slice(-100), null, 2);
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const file = path.join(this.directory, 'tasks.json');
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, 'utf8'); await rename(temporary, file);
    });
    void this.writes.catch(error => console.error('任务记录保存失败：', error.message));
  }
  flush() { return this.writes; }
  event(task: Task, message: string, level: 'info' | 'warning' | 'error' = 'info') {
    const previous = task.events.at(-1);
    if (previous?.message === message && (previous.level || 'info') === level) return;
    task.events.push({ at: iso(), message, level }); task.updatedAt = iso(); this.persist();
  }
  start(kind: string, label: string, execute: (task: Task, signal: AbortSignal) => Promise<unknown>) {
    const task: Task = { id: randomUUID(), kind, label, status: 'queued', createdAt: iso(), updatedAt: iso(), events: [] };
    const controller = new AbortController(); this.controllers.set(task.id, controller); this.tasks.push(task); this.persist();
    this.chain = this.chain.then(async () => {
      if (controller.signal.aborted) { this.controllers.delete(task.id); return; }
      try {
        await this.flush(); task.status = 'running'; this.event(task, '开始执行');
        const result = await execute(task, controller.signal);
        if (controller.signal.aborted) { task.status = 'cancelled'; this.event(task, '任务已取消，运行资源已释放', 'warning'); }
        else { task.result = result; task.status = 'completed'; this.event(task, '执行完成，结果已记录'); }
      } catch (error: any) {
        const cancelled = controller.signal.aborted || error?.cancelled === true;
        task.status = cancelled && !error.cleanupFailed ? 'cancelled' : 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        if (typeof error?.code === 'string') task.errorCode = error.code;
        this.event(task, task.error!, task.status === 'failed' ? 'error' : 'warning');
      } finally {
        this.controllers.delete(task.id); this.persist();
      }
    });
    return task;
  }
  async commit<T>(task: Task, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted(); this.committing.add(task.id);
    try { return await operation(); } finally { this.committing.delete(task.id); }
  }
  async cancel(id: string) {
    const task = this.tasks.find(task => task.id === id); if (!task) throw new Error('任务不存在。');
    if (!active(task) || task.status === 'cancelling') return task;
    if (this.committing.has(id)) throw Object.assign(new Error('当前结果正在原子保存，请等待保存完成。'), { status: 409 });
    const queued = task.status === 'queued'; this.controllers.get(id)?.abort();
    task.status = queued ? 'cancelled' : 'cancelling';
    this.event(task, queued ? '排队任务已取消，未启动执行器' : '已请求取消，等待执行器退出并清理运行资源', 'warning');
    return task;
  }
  async settle() { await this.chain; await this.flush(); }
}
