// 可复现实验档案 · 存储层
// 独立数据文件 data/repro-archives.json（旧数据 data/ink-stick-testing.json 完全不动）。
// 保证：
//  1) 串行写锁——同一环境批次的并发建档/流转在同一临界区内判定，重复或并发只成功一次；
//  2) 原子落盘——先写临时文件再 rename，磁盘写入失败时内存 db 整体回滚，
//     事件、版本、异常单都不会留下部分结果；
//  3) 失败注入——请求带 x-fail-write 头（或 FAIL_NEXT_WRITE/FAIL_ALL_WRITES 环境变量）
//     时落盘必失败，用于演练"磁盘写失败"流程。

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { buildSeed } from "./domain.js";

export class ReproStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
    this.chain = Promise.resolve(); // 写操作串行队列
    this.failAll = process.env.FAIL_ALL_WRITES === "1";
    this.failNext = process.env.FAIL_NEXT_WRITE === "1";
  }

  async init() {
    if (this.db) return;
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      const seed = buildSeed();
      await writeFile(this.filePath, JSON.stringify(seed, null, 2));
    }
    this.db = JSON.parse(await readFile(this.filePath, "utf8"));
  }

  read() { return this.db; }

  // fn(db) 在锁内、在工作副本上执行并返回结果；落盘成功后才提交工作副本。
  // 任何一步抛错（业务拒绝或磁盘失败），内存都回到 mutate 前的状态。
  mutate(fn, { failWrite = false } = {}) {
    const run = this.chain.then(async () => {
      const committed = this.db;
      const working = structuredClone(committed);
      let result;
      try {
        result = fn(working);
        if (result && typeof result.then === "function") result = await result;
      } catch (e) {
        // 业务规则拒绝：工作副本整体丢弃，事件/版本/冻结均未发生
        throw e;
      }
      await this.persist(working, { failWrite });
      this.db = working;
      return result;
    });
    // 队列不断链：本次成败都不影响后续请求入队
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async persist(db, { failWrite }) {
    const tmp = `${this.filePath}.tmp-${process.pid}-${this.db.meta.seq.evt || 0}`;
    try {
      await writeFile(tmp, JSON.stringify(db, null, 2));
      if (failWrite || this.failAll || this.failNext) {
        this.failNext = false;
        throw new Error("injected_disk_write_failure");
      }
      await rename(tmp, this.filePath);
    } catch (e) {
      try { await unlink(tmp); } catch { /* 临时文件可能未生成 */ }
      const err = new Error(`磁盘写入失败：${e.message}`);
      err.code = "disk_write_failed";
      throw err;
    }
  }
}
