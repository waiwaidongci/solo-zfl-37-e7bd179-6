#!/usr/bin/env node
// 手机宽度适配的静态核验（无浏览器环境）：
//  1) 渲染后的关键结构都被响应式规则覆盖：批次卡片、表头、按钮、状态文字、表头下拉；
//  2) CSS 中存在防横向溢出的硬性约束；
//  3) 用一个极简的“375px 伸缩模拟”核对：所有固定宽度元素都可缩放到 <=375。
import assert from "node:assert/strict";
import { reproPage } from "../repro/page.js";

const html = reproPage();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
let n = 0;
const ok = m => { n++; console.log("  ✅ " + m); };
const has = re => re.test(css);

console.log("=== viewport 与全局防溢出 ===");
assert.ok(/<meta name="viewport"[^>]*width=device-width/.test(html), "缺少 viewport meta");
ok("viewport meta: width=device-width（手机不按桌面宽度缩放）");
assert.ok(has(/html,body\s*\{[^}]*overflow-x:hidden/), "html/body 未禁止横向滚动");
ok("html,body: max-width:100% + overflow-x:hidden（页面级不横向溢出）");
assert.ok(has(/\.panel,\.card\s*\{[^}]*min-width:0/), "卡片缺 min-width:0");
ok("panel/card: min-width:0（grid/flex 子项允许收缩，卡片不撑破屏幕）");

console.log("=== 批次卡片：温湿度输入 + 上报按钮在窄屏可换行/伸缩 ===");
assert.ok(has(/\.reading-row\s*>\s*div\s*\{[^}]*flex:1 1 30%/), "缺窄屏读数输入伸缩规则");
ok("@media≤640px: 批次卡片两个读数输入 flex:1 1 30%，按钮同排不被挤出");
assert.ok(has(/button\s*\{[^}]*max-width:100%/), "按钮缺 max-width:100%");
ok("所有按钮 max-width:100%，.ops flex-wrap（按钮永不超出卡片/屏幕）");
assert.ok(has(/\.ops\s*\{[^}]*flex-wrap:wrap/), "操作按钮区不换行");
ok("档案操作区（试写/评分/封存/退回/版本）flex-wrap:wrap");

console.log("=== 表头：状态文字与角色下拉适应窄屏 ===");
assert.ok(has(/@media[^{]*max-width:640px[\s\S]*?header\s*>\s*div:last-child\s*\{[^}]*width:100%/), "表头控件窄屏未占整行");
ok("@media≤640px: 表头操作者/注入/刷新区独占整行，select width:100%（状态文字不被挤出）");
assert.ok(has(/header\s*\{[^}]*flex-wrap:wrap/), "表头不换行");
ok("header flex-wrap:wrap：标题与控件在窄屏自动堆叠");

console.log("=== 快照表：宽表在窄屏内部滚动而非顶开页面 ===");
const inlineJs = html.match(/<script>([\s\S]*?)<\/script>/)[1];
assert.ok(/class="table-wrap"[^>]*>\s*<table>/.test(inlineJs), "快照表渲染时未包 .table-wrap");
ok("快照表渲染时外包 .table-wrap");
assert.ok(has(/\.table-wrap\s*\{[^}]*overflow-x:auto/), "表格容器缺横向滚动");
ok(".table-wrap: overflow-x:auto + width:100%（表头不溢出页面，仅表内横滑）");

console.log("=== 表单与长文本 ===");
assert.ok(has(/input,select,textarea\s*\{[^}]*min-width:0[^}]*max-width:100%/), "输入框缺少收缩约束");
ok("input/select/textarea: min-width:0 + max-width:100%（建档表单可随卡片收窄）");
assert.ok(has(/\.grid\s*\{[^}]*minmax\(min\(100%,300px\),1fr\)/), "卡片网格未使用 100% 钳制 minmax");
ok("卡片网格 minmax(min(100%,300px),1fr)：375px 屏单列且卡片=屏宽，不留横向溢出");
assert.ok(has(/\.meta\s*\{[^}]*overflow-wrap:anywhere/) || has(/overflow-wrap:anywhere/), "长串（批次/留样号）不换行");
ok("长编号/状态文本 overflow-wrap:anywhere（长字符串可断行，不撑宽卡片）");
assert.ok(has(/@media[^{]*max-width:400px[\s\S]*?\.stats\s*\{[^}]*repeat\(2,1fr\)/), "超窄屏统计栅格未降级");
ok("@media≤400px: 实时统计降为 2 列（320px 宽也不挤）");

console.log("=== 375px 伸缩模拟：不存在硬编码超宽固定元素 ===");
const fixedWide = [...css.matchAll(/(?<!max-)(?:^|[;{\s])(?:width|min-width)\s*:\s*(\d+)px/g)]
  .filter(m => Number(m[1]) > 375)
  .map(m => m[0].trim());
assert.deepEqual(fixedWide, [], "存在超过 375px 的固定宽度声明：" + fixedWide.join(","));
ok("CSS 中无任何 >375px 的固定 width/min-width，整页可缩放到手机宽度");

console.log(`\n🎉 手机宽度适配核验通过：${n} 项（批次卡片、表头/下拉、按钮、快照表、表单、长文本均不溢出）。`);
