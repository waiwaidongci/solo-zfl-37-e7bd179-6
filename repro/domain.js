// 可复现实验档案 · 领域规则
// 角色、状态机（收样→试写→评分→封存/退回，禁止跳步）、温湿度冻结/异常单/复核、
// 事件、版本快照、统计快照。所有函数均为纯操作内存 db，持久化由 repro/store.js 负责。

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// 墨锭试磨环境判定区间（越界即冻结批次并开异常单）
export const LIMITS = { temp: { min: 18, max: 25 }, humidity: { min: 45, max: 65 } };

// 档案流转步骤（顺序即合法顺序，禁止跳步）；封存/退回为终态
export const STEPS = ["收样", "试写", "评分", "封存", "退回"];
export const TERMINAL = ["封存", "退回"];
// 每个步骤允许的下一个动作
export const NEXT = {
  收样: ["试写", "退回"],
  试写: ["评分", "退回"],
  评分: ["封存", "退回"],
  封存: [],
  退回: [],
};

// 内置操作者：id 经 x-user 请求头传入
export const USERS = [
  { id: "u-clerk", name: "收样员老方", roles: ["sampler"] },
  { id: "u-grinder", name: "试磨员阿砚", roles: ["grinder"] },
  { id: "u-judge", name: "评分师墨衡", roles: ["judge"] },
  { id: "u-reviewer", name: "复核员清秋", roles: ["reviewer"] },
  { id: "u-admin", name: "室主任松岚", roles: ["admin"] },
];
const USER_BY_ID = Object.fromEntries(USERS.map(u => [u.id, u]));
// admin 可执行任何流转动作；其余按角色限定
const STEP_ROLE = { 收样: "sampler", 试写: "grinder", 评分: "judge", 封存: "judge", 退回: "sampler" };

export function parseActor(userId) {
  if (!userId) throw new ApiError(401, "unauthenticated", "缺少操作者（x-user 头）");
  const user = USER_BY_ID[userId];
  if (!user) throw new ApiError(403, "unknown_actor", "未知操作者");
  return { id: user.id, name: user.name, roles: user.roles };
}
function isAdmin(actor) { return actor.roles.includes("admin"); }
// 流转动作的越权判定：admin 放行，其余必须拥有该步骤所需角色
export function canTransition(actor, step) {
  return isAdmin(actor) || actor.roles.includes(STEP_ROLE[step]);
}
// 复核动作：仅复核员或 admin；提交人不得自审在业务层判定
export function canReview(actor) {
  return isAdmin(actor) || actor.roles.includes("reviewer");
}

export function isOob(temp, humidity) {
  return temp < LIMITS.temp.min || temp > LIMITS.temp.max ||
    humidity < LIMITS.humidity.min || humidity > LIMITS.humidity.max;
}
export function readingReason(temp, humidity) {
  const why = [];
  if (temp < LIMITS.temp.min || temp > LIMITS.temp.max) why.push(`温度 ${temp}℃ 越界[${LIMITS.temp.min},${LIMITS.temp.max}]`);
  if (humidity < LIMITS.humidity.min || humidity > LIMITS.humidity.max) why.push(`湿度 ${humidity}% 越界[${LIMITS.humidity.min},${LIMITS.humidity.max}]`);
  return why.join("；");
}

// ---- ID 与时间 ----
export function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function nextSeq(meta, key) {
  meta.seq[key] = (meta.seq[key] || 0) + 1;
  return meta.seq[key];
}
const pad3 = n => String(n).padStart(3, "0");
export function nextId(db, kind, prefix) {
  const id = `${prefix}-${dayStamp()}-${pad3(nextSeq(db.meta, kind))}`;
  db.meta.lastIds[kind] = id;
  return id;
}

export function nowIso() { return new Date().toISOString(); }

// ---- 事件（仅追加）----
export function appendEvent(db, type, payload) {
  const seq = nextSeq(db.meta, "evt");
  const event = { id: `EVT-${dayStamp()}-${pad3(seq)}`, at: nowIso(), type, payload };
  db.events.push(event);
  return event;
}

function pendingTickets(db, batchId) {
  return db.tickets.filter(t => t.batchId === batchId && t.status === "待复核");
}
function latestReadingInBounds(batch) {
  const r = batch.readings[batch.readings.length - 1];
  return !!r && !isOob(r.temp, r.humidity);
}

// 录入环境读数：越界则冻结批次并生成异常单（复核通过后才解冻）。
// 冻结中录到达标读数且无待复核单时自动解冻（驳回后复测达标的正常路径）。
// 返回 { oob, cleared?, ticket? }，供路由决定后续动作。
export function applyReading(db, batch, temp, humidity, actor) {
  const reading = { at: nowIso(), temp, humidity, by: { id: actor.id, name: actor.name } };
  batch.readings.push(reading);
  appendEvent(db, "env.reading", { batchId: batch.id, temp, humidity, by: actor.id });
  if (!isOob(temp, humidity)) {
    if (batch.frozen && pendingTickets(db, batch.id).length === 0 && latestReadingInBounds(batch)) {
      batch.frozen = false;
      batch.frozenAt = null;
      batch.frozenReason = null;
      appendEvent(db, "env.unfreeze", { batchId: batch.id, reason: "复测达标", by: actor.id });
      return { oob: false, cleared: true };
    }
    return { oob: false, cleared: false };
  }

  batch.frozen = true;
  batch.frozenAt = reading.at;
  batch.frozenReason = readingReason(temp, humidity);
  const ticket = {
    id: nextId(db, "ticket", "EX"),
    batchId: batch.id,
    type: "环境越界",
    detail: batch.frozenReason,
    reading,
    status: "待复核",
    createdBy: { id: actor.id, name: actor.name },
    createdAt: reading.at,
    review: null,
  };
  db.tickets.push(ticket);
  appendEvent(db, "env.freeze", { batchId: batch.id, ticketId: ticket.id, reason: ticket.detail });
  return { oob: true, ticket };
}

// 复核异常单：提交人不能自审；同一批次所有待复核单通过后批次才解冻
export function reviewTicket(db, ticketId, actor, approve, comment) {
  const ticket = db.tickets.find(t => t.id === ticketId);
  if (!ticket) throw new ApiError(404, "ticket_not_found", "异常单不存在");
  if (ticket.status !== "待复核") throw new ApiError(409, "ticket_closed", "异常单已复核");
  // 身份红线先于角色：提交人即便兼具复核权限（含 admin）也不能自审
  if (ticket.createdBy.id === actor.id) throw new ApiError(403, "self_review", "提交人不能自审");
  if (!canReview(actor)) throw new ApiError(403, "forbidden_role", "仅复核员可复核异常单");

  ticket.status = approve ? "通过" : "驳回";
  ticket.review = {
    at: nowIso(),
    by: { id: actor.id, name: actor.name },
    approve,
    comment: comment || "",
  };
  appendEvent(db, "ticket.review", {
    ticketId: ticket.id, batchId: ticket.batchId, approve, by: actor.id,
  });

  const batch = db.batches.find(b => b.id === ticket.batchId);
  if (batch && approve && !db.tickets.some(t => t.batchId === batch.id && t.status === "待复核")) {
    batch.frozen = false;
    batch.frozenAt = null;
    batch.frozenReason = null;
    appendEvent(db, "env.unfreeze", { batchId: batch.id, by: actor.id });
  }
  return ticket;
}

// ---- 统计 ----
export function computeStats(db) {
  const byStage = Object.fromEntries(STEPS.map(s => [s, 0]));
  let active = 0;
  for (const a of db.archives) {
    byStage[a.stage] = (byStage[a.stage] || 0) + 1;
    if (!TERMINAL.includes(a.stage)) active += 1;
  }
  return {
    byStage,
    active,
    batches: db.batches.length,
    batchesFrozen: db.batches.filter(b => b.frozen).length,
    openTickets: db.tickets.filter(t => t.status === "待复核").length,
    versions: db.snapshots.length,
  };
}

function archiveSnapshot(a) {
  return structuredClone({
    id: a.id, batchId: a.batchId, sampleNo: a.sampleNo,
    operator: a.operator, stage: a.stage,
    paper: a.paper, water: a.water, speed: a.speed,
    colorLayer: a.colorLayer, sediment: a.sediment,
    score: a.score, sealLocation: a.sealLocation,
    returnReason: a.returnReason, updatedAt: a.updatedAt,
  });
}

// 每次档案修改都生成新版本：版本号按档案各自从 v1 递增。
// 旧版本内容、时间线（steps）与统计快照此后不再变化。
export function recordVersion(db, archive, step, actor, note) {
  archive.verSeq = (archive.verSeq || 0) + 1;
  const no = archive.verSeq;
  const at = nowIso();
  archive.updatedAt = at;
  const stats = computeStats(db); // 先统计，把本次修改计入
  const version = {
    no, at, step, actor: { id: actor.id, name: actor.name }, note: note || "",
    archive: archiveSnapshot(archive),
    stats: structuredClone(stats), // 固化当时的统计快照
  };
  archive.versions.push(version);
  // 同一份快照同时进入全局快照流；之后永不修改（id 全局唯一）
  const snapSeq = pad3(nextSeq(db.meta, "snap"));
  db.snapshots.push({ id: `SNAP-${dayStamp()}-${snapSeq}`, at, archiveId: archive.id, versionNo: no, stats: structuredClone(stats) });
  return no;
}

// ---- 入参校验 ----
export function requireFields(input, fields) {
  for (const f of fields) {
    if (input[f] === undefined || input[f] === null || String(input[f]).trim() === "") {
      throw new ApiError(400, "missing_field", `缺少字段：${f}`);
    }
  }
}
export function toNumber(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, "bad_number", `${label} 必须是数字`);
  return n;
}

// ---- 首启种子数据（仅当数据文件不存在时写入一次）----
export function buildSeed() {
  const db = {
    meta: { createdAt: "2026-09-01T08:00:00.000Z", seq: {}, lastIds: {} },
    users: structuredClone(USERS),
    batches: [],
    archives: [],
    tickets: [],
    events: [],
    snapshots: [],
  };
  const mkBatch = (id, temp, humidity, operator) => {
    const batch = {
      id, code: id, temp, humidity, frozen: false, frozenAt: null, frozenReason: null,
      createdBy: operator, createdAt: "2026-09-02T08:00:00.000Z", readings: [],
    };
    db.batches.push(batch);
    return batch;
  };
  const seedActor = { id: "u-admin", name: "室主任松岚" };
  // 正常批次：边界内
  applyReading(db, mkBatch("ENV-20260902-001", 22.4, 55, seedActor), 22.4, 55, seedActor);
  // 异常批次：启动即冻结并带一张待复核异常单
  const cold = mkBatch("ENV-20260902-002", 16.8, 58, seedActor);
  applyReading(db, cold, 16.8, 58, seedActor);

  // 一份进行中（收样）的示例档案
  const a = {
    id: "RA-20260902-001", batchId: "ENV-20260902-001", sampleNo: "YL-0001",
    operator: "收样员老方", stage: "收样",
    paper: null, water: null, speed: null, colorLayer: null, sediment: null,
    score: null, sealLocation: null, returnReason: null,
    createdAt: "2026-09-02T09:00:00.000Z", updatedAt: "2026-09-02T09:00:00.000Z",
    steps: [], versions: [],
  };
  db.archives.push(a);
  a.steps.push({ seq: 1, at: a.createdAt, step: "建档", actor: seedActor, note: "收样登记" });
  recordVersion(db, a, "收样", seedActor, "收样登记");
  return db;
}
