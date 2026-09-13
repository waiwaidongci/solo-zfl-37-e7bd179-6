#!/usr/bin/env node
// 无浏览器环境下的页面行为验证：用极简 DOM 垫片真实执行 /repro 的内联脚本，
// fetch 指向运行中的服务，模拟勾选失败注入后点击"建立批次/收样建档"等真实 UI 动作，
// 并断言：注入头到达服务端、显示明确失败、无部分数据、刷新后恢复。
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] || "http://localhost:3037";
const here = dirname(fileURLToPath(import.meta.url));
import { reproPage } from "../repro/page.js";
const html = reproPage();
const inline = html.match(/<script>([\s\S]*)<\/script>/)[1];

let lastFetch = null;
// ---- 极简 DOM ----
class El {
  constructor(tag) { this.tagName = (tag || "div").toUpperCase(); this.children = []; this.attrs = {}; this._text = ""; this.style = {}; this._cls = new Set(); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(" "); }
  classList = {
    add: (...c) => c.forEach(x => this._cls.add(x)),
    contains: c => this._cls.has(c),
  };
  set id(v) { this.attrs.id = v; } get id() { return this.attrs.id || ""; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.children = [];
    // 解析需要的少量结构：onclick、id、value、文本
    const re = /<(?:button|input|select|div|span|option|h3|b)([^>]*?)(\/?)>/g;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const attrs = m[1];
      const child = new El(/<(\w+)/.exec("<" + m[0].slice(1)) ? m[0].match(/<(\w+)/)[1] : "div");
      const idM = attrs.match(/\sid="([^"]+)"/); if (idM) child.attrs.id = idM[1];
      const ocM = attrs.match(/\sonclick="([^"]*)"/); if (ocM) child.attrs.onclick = ocM[1].replace(/&quot;/g, '"');
      const vM = attrs.match(/\svalue="([^"]*)"/); if (vM) child._value = vM[1];
      const dis = /\sdisabled/.test(attrs); if (dis) child.disabled = true;
      const t = (m[0].match(/<(button|option)[^>]*>([^<]*)/) || [])[2];
      if (t) child._text = t;
      child.parentHTML = this._innerHTML;
      this.children.push(child);
    }
  }
  get innerHTML() { return this._innerHTML || ""; }
  set textContent(v) { this._text = String(v); this._innerHTML = String(v); }
  get textContent() { return (this._innerHTML || this._text || "").replace(/<[^>]+>/g, " "); }
  set value(v) { this._value = String(v); }
  get value() { return this._value ?? ""; }
  set checked(v) { this._checked = !!v; } get checked() { return !!this._checked; }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  addEventListener(type, fn) { (this._h ||= {})[type] = fn; }
  click() { const h = this._h?.click || this.onclick; if (typeof h === "function") return h.call(this); }
  get onclick() { return this._oc || null; }
  set onclick(fn) { this._oc = fn; }
}
function walk(el, out = []) { for (const c of el.children || []) { out.push(c); walk(c, out); } return out; }
function queryAll(root, sel) {
  const all = walk(root);
  if (sel.startsWith("#")) { const id = sel.slice(1); return all.filter(e => e.attrs.id === id); }
  return all.filter(() => false);
}
// document
const ids = {};
const staticEls = [...html.matchAll(/<(?:select|input|button)[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
for (const id of staticEls) { const e = new El("input"); e.attrs.id = id; ids[id] = e; }
ids.msg = new El("div"); ids.msg.attrs.id = "msg";
ids.actor.value = "u-clerk";
ids.failWrite.checked = false;
// 模板内动态渲染容器
["stats", "fBatch", "batches", "archives", "tickets", "snapshots"].forEach(id => ids[id] = ids[id] || Object.assign(new El("div"), { attrs: { id } }));

const document = {
  querySelector: sel => sel.startsWith("#") ? (ids[sel.slice(1)] || null) : null,
};
const prompts = [];
globalThis.document = document;
globalThis.window = {};
globalThis.prompt = (...a) => { prompts.push(a); return prompts._ret ?? null; };
const realFetch = globalThis.fetch.bind(globalThis);
const api = (path, opt) => realFetch(BASE + path, opt).then(r => r.json());
globalThis.fetch = async (path, opt = {}) => {
  globalThis.__lastFetch = { path, opt };
  if ((opt.method || "GET") !== "GET") globalThis.__lastWrite = { path, opt };
  const res = await realFetch(BASE + path, opt);
  return {
    ok: res.ok, status: res.status,
    async json() { return res.json(); },
  };
};

// ---- 执行页面脚本（去掉自动 load()，我们手动驱动）----
const code = inline.replace(/\nload\(\);\s*$/, "") + "\nglobalThis.__page = { call, load, render, $, getLastFetch: () => globalThis.__lastWrite };\n";
new Function(code)();
const page = globalThis.__page;
// 页面脚本通过自己的 $ 访问元素；确认与垫片 ids 指向同一对象
for (const id of [...staticEls, "msg", "stats", "fBatch", "batches", "archives", "tickets", "snapshots"]) {
  if (!page.$("#" + id)) throw new Error("shim missing element #" + id);
}
await page.load();

let passed = 0;
const ok = n => { passed++; console.log("  ✅ " + n); };
const state = () => api("/api/repro/state");
const $ = s => page.$(s);

console.log("=== 失败注入：建立批次 ===");
{
  const before = await state();
  $("#failWrite").checked = true; // 用户勾选"注入磁盘写失败"
  $("#bTemp").value = "22.0"; $("#bHum").value = "55";
  await $("#createBatch").click();
  // 1) 注入头确实发出
  assert.equal(page.getLastFetch().opt.headers["x-fail-write"], "1", "x-fail-write 头必须带到服务端");
  ok("勾选后请求确实携带 x-fail-write: 1（修复前该头从不发出）");
  // 2) 明确失败提示
  assert.match($("#msg").textContent, /磁盘写入失败/);
  assert.equal($("#msg").className, "err");
  ok("页面显示明确失败：" + $("#msg").textContent);
  // 3) 开关请求后复位
  assert.equal($("#failWrite").checked, false, "一次性注入后开关应复位");
  ok("失败后注入开关自动复位（不会污染后续请求）");
  // 4) 无部分数据
  const after = await state();
  assert.equal(after.batches.length, before.batches.length, "失败不得新增批次");
  assert.equal(after.stats.versions, before.stats.versions, "失败不得产生版本/快照");
  ok("刷新后批次数量、版本快照数均未变化（无部分数据）");
}

console.log("=== 失败注入：收样建档（无部分数据）===");
{
  // 先经 API 准备一个空闲、未冻结的批次（避免占用/冻结干扰）
  const rb = await api("/api/repro/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user": "u-clerk" },
    body: JSON.stringify({ temp: 22, humidity: 55 }),
  });
  const freeBatch = rb.batch.id;
  const before = await state();
  $("#fBatch").value = freeBatch;
  $("#fSample").value = "YL-UX-0001"; $("#fOperator").value = "阿砚";
  $("#failWrite").checked = true;
  await $("#createArchive").click();
  assert.equal(page.getLastFetch().opt.headers["x-fail-write"], "1");
  assert.match($("#msg").textContent, /磁盘写入失败/);
  ok("建档失败提示明确：" + $("#msg").textContent);
  const after = await state();
  assert.ok(!after.archives.some(a => a.sampleNo === "YL-UX-0001"), "失败档案不得出现");
  assert.equal(after.archives.length, before.archives.length);
  const fresh = await api("/api/repro/batches/" + freeBatch);
  assert.equal(fresh.activeArchiveId, null, "失败后批次不应被占用");
  ok("无新档案、无新版本，批次未被占用");
}

console.log("=== 刷新恢复：取消注入后操作正常成功 ===");
{
  const before = await state();
  $("#failWrite").checked = false; // 开关已复位；显式确认
  $("#bTemp").value = "23.0"; $("#bHum").value = "52";
  await $("#createBatch").click();
  assert.equal(page.getLastFetch().opt.headers["x-fail-write"], undefined, "正常请求不得带注入头");
  assert.equal($("#msg").className, "ok");
  const after = await state();
  assert.equal(after.batches.length, before.batches.length + 1, "刷新/复位后应成功新增批次");
  ok("不勾选时建立批次成功，页面提示成功，列表实时刷新（恢复正常）");
  // 页面渲染的批次卡片包含新批次与读数按钮
  assert.match($("#batches").innerHTML, /上报读数/);
  ok("批次卡片正常渲染（温湿度输入 + 上报读数按钮）");
}

console.log(`\n🎉 页面行为验证通过：${passed} 项（失败注入到达服务端、明确失败、无部分数据、开关复位、刷新恢复）。`);
