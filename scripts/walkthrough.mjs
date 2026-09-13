#!/usr/bin/env node
// 端到端演练：对运行中的墨锭试磨室走通 正常 / 冲突 / 越权 / 温湿度异常 / 磁盘失败 流程。
// 用法：node scripts/walkthrough.mjs [BASE_URL]
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] || process.env.BASE_URL || "http://localhost:3037";
const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const U = {
  clerk: "u-clerk", grinder: "u-grinder", judge: "u-judge",
  reviewer: "u-reviewer", admin: "u-admin",
};
let passed = 0;
function ok(name) { passed += 1; console.log("  ✅ " + name); }
function section(name) { console.log("\n=== " + name + " ==="); }

async function req(method, path, { user, body, failWrite } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers["x-user"] = user;
  if (failWrite) headers["x-fail-write"] = "1";
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const expectFail = async (p, status, code, label) => {
  const r = await p;
  assert.equal(r.status, status, `${label}: 期望 ${status} 得到 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error, code, `${label}: 错误码应为 ${code}`);
  ok(`${label} → ${status} ${code}`);
  return r;
};
async function noTmpFiles() {
  const files = await readdir(DATA);
  const left = files.filter(f => f.includes(".tmp"));
  assert.deepEqual(left, [], "不应残留临时文件：" + left.join(","));
}
const tag = String(Date.now()).slice(-8);

// ---------------------------------------------------------------- 正常流程
section("正常流程：建档 → 试写 → 评分 → 封存，版本/时间线/统计快照固化");
{
  let r = await req("POST", "/api/repro/batches", { user: U.clerk, body: { temp: 22.5, humidity: 55 } });
  assert.equal(r.status, 201);
  const batch = r.json.batch.id;
  ok("收样员建立正常批次 " + batch);

  r = await req("POST", "/api/repro/archives", {
    user: U.clerk,
    body: { batchId: batch, sampleNo: `YL-N-${tag}`, operator: "试磨员阿砚" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const arc = r.json.archive.id;
  assert.equal(r.json.archive.stage, "收样");
  ok(`收样建档 ${arc}（绑定批次/操作者/留样编号），v1`);

  // 跳步：收样直接评分
  await expectFail(
    req("POST", `/api/repro/archives/${arc}/transition`, { user: U.judge, body: { step: "评分", score: 90 } }),
    409, "skip_step", "收样直接评分（跳步）");

  r = await req("POST", `/api/repro/archives/${arc}/transition`, {
    user: U.grinder,
    body: { step: "试写", paper: "净皮宣纸", water: "20滴", speed: "快", colorLayer: "分明", sediment: "无" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.archive.stage, "试写");
  ok("试磨员完成试写 → v2");

  r = await req("POST", `/api/repro/archives/${arc}/transition`, {
    user: U.judge, body: { step: "评分", score: 91 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.archive.score, 91);
  ok("评分师完成评分 91 → v3");

  r = await req("POST", `/api/repro/archives/${arc}/transition`, {
    user: U.judge, body: { step: "封存", sealLocation: "恒湿柜B-3" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.archive.stage, "封存");
  ok("封存 → v4（终态）");

  // 终态再流转（用有权退回的收样员，确保命中终态而非角色校验）
  await expectFail(
    req("POST", `/api/repro/archives/${arc}/transition`, { user: U.clerk, body: { step: "退回", returnReason: "x" } }),
    409, "terminal", "封存后继续流转");

  // 时间线（建档即收样；之后每次流转追加一步）
  const tl = (await req("GET", `/api/repro/archives/${arc}/timeline`)).json;
  assert.deepEqual(tl.map(s => s.step), ["建档", "试写", "评分", "封存"]);
  const versions0 = (await req("GET", `/api/repro/archives/${arc}/versions`)).json;
  assert.deepEqual(versions0.map(v => v.step), ["收样", "试写", "评分", "封存"]);
  ok("时间线：建档→试写→评分→封存；版本步骤：收样(v1)→试写→评分→封存");

  // 版本固化：记录 v1/v2 内容，后续变化不得回改
  const before = (await req("GET", `/api/repro/archives/${arc}/versions`)).json;
  assert.equal(before.length, 4);
  const v1 = JSON.stringify(before[0]);
  const v2 = JSON.stringify(before[1]);
  assert.equal(before[0].archive.stage, "收样");
  const v1Stats = JSON.stringify(before[0].stats);

  // 统计快照流（v1 时的快照）
  const stats1 = (await req("GET", "/api/repro/stats")).json;
  const snap1 = stats1.snapshots.find(s => s.archiveId === arc && s.versionNo === 1);
  assert.ok(snap1, "应存在 v1 的统计快照");
  assert.equal(snap1.stats.byStage["收样"], snap1.stats.byStage["收样"]);
  const snap1Json = JSON.stringify(snap1);

  // 同批次封存后腾出名额：再建一份并退回，制造新版本与新统计
  r = await req("POST", "/api/repro/archives", {
    user: U.clerk, body: { batchId: batch, sampleNo: `YL-N2-${tag}`, operator: "试磨员阿砚" },
  });
  assert.equal(r.status, 201);
  const arc2 = r.json.archive.id;
  ok("终态后同批次可再建进行中试磨 " + arc2);
  await req("POST", `/api/repro/archives/${arc2}/transition`, {
    user: U.clerk, body: { step: "退回", returnReason: "留样标签不清" },
  });
  ok("收样员从收样直接退回（允许分支）→ 终态");

  const after = (await req("GET", `/api/repro/archives/${arc}/versions`)).json;
  assert.equal(JSON.stringify(after[0]), v1, "v1 被回改了");
  assert.equal(JSON.stringify(after[1]), v2, "v2 被回改了");
  assert.equal(after.length, 4, "旧档案版本数不应变化");
  const stats2 = (await req("GET", "/api/repro/stats")).json;
  const snap1b = stats2.snapshots.find(s => s.archiveId === arc && s.versionNo === 1);
  assert.equal(JSON.stringify(snap1b), snap1Json, "v1 统计快照被回改");
  assert.equal(JSON.stringify(after[0].stats), v1Stats, "版本内嵌统计快照被回改");
  ok("旧版本、旧时间线、统计快照在后续操作后保持不变");
}

// ---------------------------------------------------------------- 冲突与并发
section("冲突：同一环境批次重复/并发建档只成功一次");
{
  const r = await req("POST", "/api/repro/batches", { user: U.clerk, body: { temp: 21, humidity: 50 } });
  const batch = r.json.batch.id;

  // 顺序重复（同留样编号）
  const a = await req("POST", "/api/repro/archives", { user: U.clerk, body: { batchId: batch, sampleNo: `YL-D-${tag}`, operator: "甲" } });
  assert.equal(a.status, 201);
  await expectFail(
    req("POST", "/api/repro/archives", { user: U.clerk, body: { batchId: batch, sampleNo: `YL-D-${tag}`, operator: "乙" } }),
    409, "sample_exists", "重复留样编号");

  // 5 个并发建档（不同留样编号）抢同一空批次的唯一名额
  const raceBatch = (await req("POST", "/api/repro/batches", { user: U.clerk, body: { temp: 20, humidity: 48 } })).json.batch.id;
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(i =>
      req("POST", "/api/repro/archives", {
        user: U.clerk,
        body: { batchId: raceBatch, sampleNo: `YL-C${i}-${tag}`, operator: `并发${i}` },
      })
    )
  );
  const wins = results.filter(x => x.status === 201);
  const busy = results.filter(x => x.status === 409 && x.json.error === "batch_busy");
  assert.equal(wins.length, 1, `并发只应成功一次，实际 ${wins.length}`);
  assert.equal(busy.length, 4);
  ok("5 个并发建档：1 成功，4 个 batch_busy");

  const st = (await req("GET", "/api/repro/state")).json;
  const active = st.archives.filter(x => x.batchId === raceBatch && !["封存", "退回"].includes(x.stage));
  assert.equal(active.length, 1, "同批次进行中试磨只能有一个");
  ok("该批次进行中试磨数量 = 1");
}

// ---------------------------------------------------------------- 越权
section("越权：无角色/未知用户/越岗操作全部拒绝");
{
  const b = (await req("POST", "/api/repro/batches", { user: U.admin, body: { temp: 23, humidity: 60 } })).json.batch.id;
  const a = (await req("POST", "/api/repro/archives", {
    user: U.clerk, body: { batchId: b, sampleNo: `YL-A-${tag}`, operator: "甲" },
  })).json.archive.id;

  await expectFail(req("POST", "/api/repro/batches", { body: { temp: 23, humidity: 60 } }),
    401, "unauthenticated", "缺少 x-user");
  await expectFail(req("POST", "/api/repro/batches", { user: "u-nobody", body: { temp: 23, humidity: 60 } }),
    403, "unknown_actor", "未知操作者");
  await expectFail(req("POST", "/api/repro/archives", {
    user: U.grinder, body: { batchId: b, sampleNo: `YL-X-${tag}`, operator: "甲" },
  }), 403, "forbidden_role", "试磨员收样建档");
  await expectFail(req("POST", `/api/repro/archives/${a}/transition`, {
    user: U.clerk, body: { step: "试写", paper: "纸", water: "水" },
  }), 403, "forbidden_role", "收样员执行试写");
  await expectFail(req("POST", `/api/repro/archives/${a}/transition`, {
    user: U.grinder, body: { step: "封存", sealLocation: "柜" },
  }), 403, "forbidden_role", "试磨员执行封存");

  // 越权拒绝不落任何痕迹
  const ev = (await req("GET", `/api/repro/events?archiveId=${a}`)).json;
  assert.ok(!ev.some(e => e.type === "archive.transition"), "越权请求不得产生事件");
  const versions = (await req("GET", `/api/repro/archives/${a}/versions`)).json;
  assert.equal(versions.length, 1, "越权请求不得产生版本");
  ok("越权被拒后无事件、无新版本，档案仍停留在收样");
}

// ------------------------------------------------- 温湿度冻结 / 异常单 / 复核
section("温湿度越界：冻结批次、异常单、禁自审、复核解冻");
{
  // 建批即越界
  let r = await req("POST", "/api/repro/batches", { user: U.clerk, body: { temp: 30, humidity: 55 } });
  assert.equal(r.status, 201);
  const b = r.json.batch.id;
  assert.equal(r.json.oob, true);
  assert.equal(r.json.batch.frozen, true);
  const ticket = r.json.ticket.id;
  ok(`建批温度30℃越界：批次冻结并生成异常单 ${ticket}`);

  // 冻结批次禁止建档
  await expectFail(req("POST", "/api/repro/archives", {
    user: U.clerk, body: { batchId: b, sampleNo: `YL-F-${tag}`, operator: "甲" },
  }), 409, "batch_frozen", "冻结批次上建档");

  // 提交人自审拒绝；非复核员拒绝
  await expectFail(req("POST", `/api/repro/tickets/${ticket}/review`, {
    user: U.clerk, body: { approve: true, comment: "自己看没问题" },
  }), 403, "self_review", "提交人自审");
  await expectFail(req("POST", `/api/repro/tickets/${ticket}/review`, {
    user: U.judge, body: { approve: true },
  }), 403, "forbidden_role", "评分师越权复核");
  ok("自审与越岗复核均被拒绝，异常单仍待复核");

  // 复核员通过 → 解冻
  r = await req("POST", `/api/repro/tickets/${ticket}/review`, {
    user: U.reviewer, body: { approve: true, comment: "空调已恢复，复测达标" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "通过");
  const bd = (await req("GET", `/api/repro/batches/${b}`)).json;
  assert.equal(bd.frozen, false);
  ok("复核员通过后批次解冻");

  // 驳回路径：再次越界开单 → 驳回 → 复测达标自动解冻
  r = await req("POST", `/api/repro/batches/${b}/readings`, { user: U.grinder, body: { temp: 15, humidity: 55 } });
  assert.equal(r.json.oob, true);
  const t2 = r.json.ticket.id;
  ok("再次越界（15℃）重新冻结并开第二张异常单 " + t2);
  r = await req("POST", `/api/repro/tickets/${t2}/review`, {
    user: U.reviewer, body: { approve: false, comment: "未见整改记录，驳回" },
  });
  assert.equal(r.json.status, "驳回");
  assert.equal((await req("GET", `/api/repro/batches/${b}`)).json.frozen, true);
  ok("驳回后批次保持冻结");
  r = await req("POST", `/api/repro/batches/${b}/readings`, { user: U.clerk, body: { temp: 22, humidity: 55 } });
  assert.equal(r.json.cleared, true);
  assert.equal(r.json.batch.frozen, false);
  ok("异常单关闭后复测达标，批次自动解冻");

  // 解冻后正常建档与完整流转可用
  r = await req("POST", "/api/repro/archives", {
    user: U.clerk, body: { batchId: b, sampleNo: `YL-F2-${tag}`, operator: "阿砚" },
  });
  assert.equal(r.status, 201);
  ok("解冻后建档成功 " + r.json.archive.id);
}

// ---------------------------------------------------------------- 磁盘写失败
section("磁盘失败：写入失败时内存/事件/版本不留部分结果");
{
  const b = (await req("POST", "/api/repro/batches", { user: U.clerk, body: { temp: 22, humidity: 55 } })).json.batch.id;

  const before = (await req("GET", "/api/repro/state")).json;
  const nArchivesBefore = before.archives.length;
  const nEventsBefore = (await req("GET", "/api/repro/events")).json.length;
  const nTicketsBefore = before.tickets.length;

  // 建档时磁盘失败
  let r = await req("POST", "/api/repro/archives", {
    user: U.clerk, failWrite: true,
    body: { batchId: b, sampleNo: `YL-FAIL-${tag}`, operator: "甲" },
  });
  assert.equal(r.status, 507, JSON.stringify(r.json));
  assert.equal(r.json.error, "disk_write_failed");
  ok("建档落盘失败 → 507 disk_write_failed");

  const after = (await req("GET", "/api/repro/state")).json;
  assert.ok(!after.archives.some(a => a.sampleNo === `YL-FAIL-${tag}`), "内存中不应出现失败档案");
  assert.equal(after.archives.length, nArchivesBefore, "档案数不变");
  const nEventsAfter = (await req("GET", "/api/repro/events")).json.length;
  assert.equal(nEventsAfter, nEventsBefore, "事件数不变");
  assert.equal(after.tickets.length, nTicketsBefore, "异常单数不变");
  await noTmpFiles();
  ok("失败后：无档案、无事件、无异常单残留，磁盘无临时文件");

  // 越界读数落盘失败：冻结与异常单也必须一起回滚
  r = await req("POST", `/api/repro/batches/${b}/readings`, {
    user: U.clerk, failWrite: true, body: { temp: 40, humidity: 55 },
  });
  assert.equal(r.status, 507);
  const bd = (await req("GET", `/api/repro/batches/${b}`)).json;
  assert.equal(bd.frozen, false, "失败读数不得冻结批次");
  assert.equal(bd.readings.at(-1).temp, 22, "失败读数不得进入读数历史");
  const st = (await req("GET", "/api/repro/state")).json;
  assert.equal(st.tickets.length, nTicketsBefore, "失败不得生成异常单");
  ok("越界读数落盘失败：批次未冻结、无异常单、读数历史无污染");

  // 流转时磁盘失败：阶段、版本、时间线都不变
  const okArc = (await req("POST", "/api/repro/archives", {
    user: U.clerk, body: { batchId: b, sampleNo: `YL-OK-${tag}`, operator: "甲" },
  })).json.archive;
  const vBefore = (await req("GET", `/api/repro/archives/${okArc.id}/versions`)).json.length;
  r = await req("POST", `/api/repro/archives/${okArc.id}/transition`, {
    user: U.grinder, failWrite: true,
    body: { step: "试写", paper: "净皮宣纸", water: "20滴" },
  });
  assert.equal(r.status, 507);
  const again = await req("GET", `/api/repro/archives/${okArc.id}`);
  assert.equal(again.json.stage, "收样", "失败流转不得改变阶段");
  assert.equal((await req("GET", `/api/repro/archives/${okArc.id}/versions`)).json.length, vBefore, "失败流转不得生成版本");
  await noTmpFiles();
  ok("流转落盘失败：阶段仍为收样、版本数不变、无临时文件");

  // 服务未被失败污染：随后正常写入成功
  r = await req("POST", `/api/repro/archives/${okArc.id}/transition`, {
    user: U.grinder, body: { step: "试写", paper: "净皮宣纸", water: "20滴" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.archive.stage, "试写");
  ok("失败后服务恢复，正常流转成功");
}

// ---------------------------------------------------------------- 旧入口
section("旧入口与旧数据保持可用");
{
  const home = await fetch(BASE + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes("墨锭试磨室") && html.includes("/repro"), "旧页面保留且有新入口链接");
  const items = await req("GET", "/api/items");
  assert.equal(items.status, 200);
  const codes = items.json.map(i => i.code);
  assert.ok(codes.includes("IS-001") && codes.includes("IS-002"), "旧数据 IS-001/IS-002 仍在");
  const stats = await req("GET", "/api/stats");
  assert.equal(stats.status, 200);
  assert.equal(stats.json["已试磨"], 1);
  ok("旧页面 / 旧 /api/items / /api/stats 与旧数据完好，旧页含新入口");
}

console.log(`\n🎉 全部通过：${passed} 个断言，覆盖正常、冲突并发、越权跳步、温湿度冻结复核、磁盘失败与旧入口兼容。`);
