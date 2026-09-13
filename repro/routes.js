// 可复现实验档案 · HTTP 路由（挂在旧服务之下，旧入口全部保留）
//
// 认证：x-user: <用户id> 表示操作者；x-fail-write: 1 注入磁盘写失败。
// 流转：收样→试写→评分→封存；任一步可退回。跳步 409、角色不符 403、
// 批次冻结中 409、同批次重复/并发建档 409（串行锁保证只成功一次）。

import {
  ApiError, STEPS, TERMINAL, NEXT, USERS,
  parseActor, canTransition,
  isOob, toNumber, requireFields,
  nextId, nowIso, appendEvent, applyReading, reviewTicket,
  computeStats, recordVersion,
} from "./domain.js";
import { reproPage } from "./page.js";

const STAGE_FIELDS = {
  试写: ["paper", "water"],
  评分: ["score"],
  封存: ["sealLocation"],
  退回: ["returnReason"],
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

function archiveDetail(a) {
  return {
    ...structuredClone(a),
    currentVersion: a.versions.length ? a.versions[a.versions.length - 1].no : 0,
  };
}
function archiveSummary(a) {
  const v = a.versions[a.versions.length - 1];
  return {
    id: a.id, batchId: a.batchId, sampleNo: a.sampleNo, operator: a.operator,
    stage: a.stage, score: a.score, currentVersion: v ? v.no : 0,
    updatedAt: a.updatedAt,
  };
}
function batchDetail(b, db) {
  const active = db.archives.find(a => a.batchId === b.id && !TERMINAL.includes(a.stage));
  return { ...structuredClone(b), activeArchiveId: active ? active.id : null };
}

// 随业务请求上报的环境读数：独立原子落盘。
// 越界时这一个 mutate 只负责"冻结+异常单"并提交；随后的业务 mutate 看到冻结即拒绝，
// 保证冻结与异常单绝不随业务拒绝一起回滚。
async function ingestReading(store, batchId, input, actor, failWrite) {
  if (input.temp === undefined && input.humidity === undefined) return null;
  return store.mutate(db => {
    const batch = db.batches.find(b => b.id === batchId);
    if (!batch) throw new ApiError(404, "batch_not_found", "环境批次不存在");
    const temp = input.temp === undefined ? batch.temp : toNumber(input.temp, "温度");
    const humidity = input.humidity === undefined ? batch.humidity : toNumber(input.humidity, "湿度");
    batch.temp = temp;
    batch.humidity = humidity;
    const r = applyReading(db, batch, temp, humidity, actor);
    return { batch: batchDetail(batch, db), ...r };
  }, { failWrite });
}

export async function handleRepro(req, res, url, store) {
  const p = url.pathname;
  const failWrite = req.headers["x-fail-write"] === "1";

  // ---- 页面与常量 ----
  if (req.method === "GET" && p === "/repro") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(reproPage());
  }
  if (req.method === "GET" && p === "/api/repro/state") {
    const db = store.read();
    return send(res, 200, {
      users: USERS,
      steps: STEPS,
      limits: { temp: { min: 18, max: 25 }, humidity: { min: 45, max: 65 } },
      batches: db.batches.map(b => batchDetail(b, db)),
      archives: db.archives.map(archiveSummary),
      tickets: structuredClone(db.tickets),
      stats: computeStats(db),
      statsSnapshots: structuredClone(db.snapshots.slice(-12).reverse()),
      events: structuredClone(db.events.slice(-30).reverse()),
    });
  }

  // ---- 环境批次 ----
  if (req.method === "POST" && p === "/api/repro/batches") {
    const actor = parseActor(req.headers["x-user"]);
    if (!actor.roles.includes("sampler") && !actor.roles.includes("admin")) {
      throw new ApiError(403, "forbidden_role", "仅收样员可建立环境批次");
    }
    const input = await readBody(req);
    requireFields(input, ["temp", "humidity"]);
    const temp = toNumber(input.temp, "温度");
    const humidity = toNumber(input.humidity, "湿度");
    const result = await store.mutate(db => {
      const batch = {
        id: nextId(db, "batch", "ENV"),
        temp, humidity,
        frozen: false, frozenAt: null, frozenReason: null,
        createdBy: { id: actor.id, name: actor.name },
        createdAt: nowIso(), readings: [],
      };
      db.batches.unshift(batch);
      appendEvent(db, "batch.create", { batchId: batch.id, by: actor.id });
      // 建批时即越界：直接冻结并开异常单（随建档一并落盘）
      const r = applyReading(db, batch, temp, humidity, actor);
      return { batch: batchDetail(batch, db), oob: isOob(temp, humidity), ticket: r.ticket || null };
    }, { failWrite });
    return send(res, 201, result);
  }

  if (req.method === "GET" && /^\/api\/repro\/batches\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split("/").pop());
    const db = store.read();
    const batch = db.batches.find(b => b.id === id);
    if (!batch) throw new ApiError(404, "batch_not_found", "环境批次不存在");
    return send(res, 200, batchDetail(batch, db));
  }

  // 录入环境读数（越界→冻结批次+异常单）
  if (req.method === "POST" && /^\/api\/repro\/batches\/[^/]+\/readings$/.test(p)) {
    const actor = parseActor(req.headers["x-user"]);
    const id = decodeURIComponent(p.split("/")[4]);
    const input = await readBody(req);
    requireFields(input, ["temp", "humidity"]);
    const temp = toNumber(input.temp, "温度");
    const humidity = toNumber(input.humidity, "湿度");
    const out = await store.mutate(db => {
      const batch = db.batches.find(b => b.id === id);
      if (!batch) throw new ApiError(404, "batch_not_found", "环境批次不存在");
      const r = applyReading(db, batch, temp, humidity, actor);
      return { batch: batchDetail(batch, db), ...r };
    }, { failWrite });
    return send(res, 201, out);
  }

  // ---- 档案建档（收样）----
  if (req.method === "POST" && p === "/api/repro/archives") {
    const actor = parseActor(req.headers["x-user"]);
    if (!canTransition(actor, "收样")) {
      throw new ApiError(403, "forbidden_role", "仅收样员可收样建档");
    }
    const input = await readBody(req);
    requireFields(input, ["batchId", "sampleNo", "operator"]);
    const batchId = String(input.batchId).trim();
    // 随收样上报的读数先独立提交（可能触发冻结+异常单）
    await ingestReading(store, batchId, input, actor, failWrite);
    const result = await store.mutate(db => {
      const batch = db.batches.find(b => b.id === batchId);
      if (!batch) throw new ApiError(404, "batch_not_found", "环境批次不存在");
      if (batch.frozen) throw new ApiError(409, "batch_frozen", `环境批次冻结中：${batch.frozenReason}`);
      if (db.archives.some(a => a.sampleNo === String(input.sampleNo).trim())) {
        throw new ApiError(409, "sample_exists", "留样编号已存在");
      }
      const clash = db.archives.find(a => a.batchId === batch.id && !TERMINAL.includes(a.stage));
      if (clash) throw new ApiError(409, "batch_busy", `该环境批次已有进行中的试磨 ${clash.id}`);

      const now = nowIso();
      const archive = {
        id: nextId(db, "archive", "RA"),
        batchId: batch.id,
        sampleNo: String(input.sampleNo).trim(),
        operator: String(input.operator).trim(),
        stage: "收样",
        paper: null, water: null, speed: null, colorLayer: null, sediment: null,
        score: null, sealLocation: null, returnReason: null,
        createdAt: now, updatedAt: now,
        steps: [], versions: [],
      };
      db.archives.unshift(archive);
      archive.steps.push({ seq: 1, at: now, step: "建档", actor: { id: actor.id, name: actor.name }, note: "收样登记" });
      appendEvent(db, "archive.create", {
        archiveId: archive.id, batchId: batch.id, sampleNo: archive.sampleNo, by: actor.id,
      });
      recordVersion(db, archive, "收样", actor, "收样登记");
      return { archive: archiveDetail(archive) };
    }, { failWrite });
    return send(res, 201, result);
  }

  // ---- 档案流转 ----
  const transition = p.match(/^\/api\/repro\/archives\/([^/]+)\/transition$/);
  if (transition && req.method === "POST") {
    const actor = parseActor(req.headers["x-user"]);
    const archiveId = decodeURIComponent(transition[1]);
    const input = await readBody(req);
    requireFields(input, ["step"]);
    const step = String(input.step);
    if (!STEPS.includes(step) || step === "收样") {
      throw new ApiError(400, "bad_step", `未知流转动作：${input.step}`);
    }
    if (!canTransition(actor, step)) {
      throw new ApiError(403, "forbidden_role", `${step} 需要对应岗位权限`);
    }
    requireFields(input, STAGE_FIELDS[step] || []);

    // 先解析档案所属批次（只读），随动作上报的读数独立提交
    const existing = store.read().archives.find(a => a.id === archiveId);
    if (!existing) throw new ApiError(404, "archive_not_found", "实验档案不存在");
    await ingestReading(store, existing.batchId, input, actor, failWrite);

    const out = await store.mutate(db => {
      const archive = db.archives.find(a => a.id === archiveId);
      const batch = db.batches.find(b => b.id === archive.batchId);
      if (batch.frozen) throw new ApiError(409, "batch_frozen", `环境批次冻结中：${batch.frozenReason}`);
      if (TERMINAL.includes(archive.stage)) {
        throw new ApiError(409, "terminal", `档案已${archive.stage}，不可继续流转`);
      }
      if (!NEXT[archive.stage].includes(step)) {
        throw new ApiError(409, "skip_step", `不能从「${archive.stage}」跳到「${step}」`);
      }

      const at = nowIso();
      const from = archive.stage;
      const note = String(input.note || "").trim();
      if (step === "试写") {
        archive.paper = String(input.paper).trim();
        archive.water = String(input.water).trim();
        archive.speed = input.speed != null && String(input.speed) !== "" ? String(input.speed) : null;
        archive.colorLayer = input.colorLayer != null && String(input.colorLayer) !== "" ? String(input.colorLayer) : null;
        archive.sediment = input.sediment != null && String(input.sediment) !== "" ? String(input.sediment) : null;
      } else if (step === "评分") {
        archive.score = toNumber(input.score, "评分");
      } else if (step === "封存") {
        archive.sealLocation = String(input.sealLocation).trim();
      } else if (step === "退回") {
        archive.returnReason = String(input.returnReason).trim();
      }
      archive.stage = step;
      archive.steps.push({
        seq: archive.steps.length + 1, at, step,
        actor: { id: actor.id, name: actor.name }, note,
      });
      appendEvent(db, "archive.transition", {
        archiveId: archive.id, batchId: batch.id, from, to: step, by: actor.id,
      });
      recordVersion(db, archive, step, actor, note);
      return { archive: archiveDetail(archive) };
    }, { failWrite });
    return send(res, 201, out);
  }

  // ---- 档案详情 / 版本 / 时间线 ----
  if (req.method === "GET" && p === "/api/repro/archives") {
    return send(res, 200, store.read().archives.map(archiveSummary));
  }
  const detail = p.match(/^\/api\/repro\/archives\/([^/]+)$/);
  if (detail && req.method === "GET") {
    const a = store.read().archives.find(x => x.id === decodeURIComponent(detail[1]));
    if (!a) throw new ApiError(404, "archive_not_found", "实验档案不存在");
    return send(res, 200, archiveDetail(a));
  }
  const versions = p.match(/^\/api\/repro\/archives\/([^/]+)\/versions$/);
  if (versions && req.method === "GET") {
    const a = store.read().archives.find(x => x.id === decodeURIComponent(versions[1]));
    if (!a) throw new ApiError(404, "archive_not_found", "实验档案不存在");
    return send(res, 200, structuredClone(a.versions));
  }
  const timeline = p.match(/^\/api\/repro\/archives\/([^/]+)\/timeline$/);
  if (timeline && req.method === "GET") {
    const a = store.read().archives.find(x => x.id === decodeURIComponent(timeline[1]));
    if (!a) throw new ApiError(404, "archive_not_found", "实验档案不存在");
    return send(res, 200, structuredClone(a.steps));
  }

  // ---- 异常单复核 ----
  if (req.method === "GET" && p === "/api/repro/tickets") {
    return send(res, 200, structuredClone(store.read().tickets));
  }
  const review = p.match(/^\/api\/repro\/tickets\/([^/]+)\/review$/);
  if (review && req.method === "POST") {
    const actor = parseActor(req.headers["x-user"]);
    const input = await readBody(req);
    const approve = input.approve !== false;
    const ticket = await store.mutate(
      db => reviewTicket(db, decodeURIComponent(review[1]), actor, approve, input.comment),
      { failWrite },
    );
    return send(res, 201, structuredClone(ticket));
  }

  // ---- 事件流（只追加，可按批次/档案过滤）----
  if (req.method === "GET" && p === "/api/repro/events") {
    const q = url.searchParams;
    let events = store.read().events;
    if (q.get("batchId")) events = events.filter(e => e.payload?.batchId === q.get("batchId"));
    if (q.get("archiveId")) events = events.filter(e => e.payload?.archiveId === q.get("archiveId"));
    return send(res, 200, structuredClone(events)); // 按追加顺序
  }

  // ---- 统计：当前值 + 历史快照（快照与旧版本永不改变）----
  if (req.method === "GET" && p === "/api/repro/stats") {
    const db = store.read();
    return send(res, 200, {
      current: computeStats(db),
      snapshots: structuredClone(db.snapshots),
    });
  }

  return false; // 非 /repro 路由，交回旧服务处理
}
