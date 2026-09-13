// 可复现实验档案 · 页面（/repro）。旧入口 / 保持不变。
export function reproPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>可复现实验档案 · 墨锭试磨室</title>
<style>
  :root { --bg:#eef1ea; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --frozen:#7a5a12; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { margin:0; font-size:22px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0 0 6px; font-size:15px; }
  main { padding:18px 26px; display:grid; gap:16px; }
  .panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:end; }
  label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
  input,select,textarea { border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; min-width:120px; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
  button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:.45; cursor:not-allowed; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin:2px 4px 2px 0; }
  .pill.frozen { border-color:var(--frozen); color:var(--frozen); font-weight:700; }
  .pill.terminal { border-color:var(--accent); color:var(--accent); font-weight:700; }
  .pill.ticket { border-color:var(--warn); color:var(--warn); font-weight:700; }
  .meta { color:var(--muted); font-size:12px; } .warn { color:var(--warn); font-weight:700; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:8px; }
  .stat b { display:block; font-size:22px; }
  table { width:100%; border-collapse:collapse; font-size:13px; } td,th { border-bottom:1px solid var(--line); padding:5px 7px; text-align:left; }
  #msg { min-height:22px; font-size:13px; white-space:pre-wrap; } #msg.err { color:var(--warn); } #msg.ok { color:var(--accent); }
  .ops { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  details { margin-top:8px; } summary { cursor:pointer; font-size:12px; color:var(--muted); }
  pre { white-space:pre-wrap; word-break:break-all; font-size:11px; background:#f7f8f5; border:1px solid var(--line); border-radius:6px; padding:8px; max-height:220px; overflow:auto; }
  a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <div><h1>可复现实验档案</h1>
  <div class="meta">收样 → 试写 → 评分 → 封存 / 退回 · 绑定环境批次、操作者、留样编号 · <a href="/">返回旧版墨锭试磨室</a></div></div>
  <div class="row">
    <div><label>当前操作者（角色）</label><select id="actor"></select></div>
    <label class="meta"><input type="checkbox" id="failWrite"> 注入磁盘写失败（下一次写）</label>
    <button class="secondary" id="reload">刷新</button>
  </div>
</header>
<main>
  <div id="msg"></div>
  <section class="panel"><h2>实时统计</h2><div class="stats" id="stats"></div></section>

  <div class="grid">
    <section class="panel">
      <h2>环境批次</h2>
      <div class="row">
        <div><label>温度 ℃ [18,25]</label><input id="bTemp" type="number" step="0.1" value="22.0"></div>
        <div><label>湿度 % [45,65]</label><input id="bHum" type="number" step="0.1" value="55"></div>
        <button id="createBatch">建立批次</button>
      </div>
      <div id="batches" style="margin-top:10px"></div>
    </section>

    <section class="panel">
      <h2>收样建档</h2>
      <div class="row" style="flex-direction:column;align-items:stretch">
        <div><label>环境批次</label><select id="fBatch" style="width:100%"></select></div>
        <div class="row">
          <div style="flex:1"><label>留样编号</label><input id="fSample" style="width:100%" placeholder="YL-1001"></div>
          <div style="flex:1"><label>操作者（记录字段）</label><input id="fOperator" style="width:100%" placeholder="试磨员姓名/工号"></div>
        </div>
        <div><label>收样时读数（可选，越界会冻结批次）</label>
          <div class="row"><input id="fTemp" type="number" step="0.1" placeholder="温度"><input id="fHum" type="number" step="0.1" placeholder="湿度"></div></div>
        <button id="createArchive">收样建档</button>
      </div>
    </section>
  </div>

  <section class="panel"><h2>实验档案</h2><div class="grid" id="archives"></div></section>
  <section class="panel"><h2>异常单（复核通过后解冻 · 提交人不能自审）</h2><div id="tickets"></div></section>
  <section class="panel"><h2>统计快照（固化，永不回改）</h2><div id="snapshots"></div></section>
</main>

<script>
const API = (path, opt) => fetch(path, { ...opt, headers: { 'Content-Type':'application/json', ...((opt&&opt.headers)||{}) } });
let state = null;
const $ = s => document.querySelector(s);
function actorId() { return $('#actor').value; }
function heads(extra) { return { 'Content-Type':'application/json', 'x-user': actorId(), ...($('#failWrite').checked ? {'x-fail-write':'1'} : {}), ...(extra||{}) }; }
function msg(text, ok) { const m = $('#msg'); m.textContent = text; m.className = ok ? 'ok' : 'err'; }
async function call(path, method, body) {
  $('#failWrite').checked = false; // 注入仅作用于下一次写
  const res = await API(path, { method, headers: heads(), body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error||'请求失败') + (data.code ? ' [' + data.code + ']' : '') + (data.message ? '：' + data.message : ''));
  return data;
}
async function load() {
  const res = await API('/api/repro/state');
  state = await res.json();
  render();
}
function render() {
  const roleName = { sampler:'收样', grinder:'试磨', judge:'评分', reviewer:'复核', admin:'主任' };
  const picked = $('#actor').value;
  $('#actor').innerHTML = state.users.map(u => '<option value="'+u.id+'"'+(u.id===picked?' selected':'')+'>'+u.name+'（'+u.roles.map(r=>roleName[r]||r).join('/')+'）</option>').join('');
  const s = state.stats;
  $('#stats').innerHTML = ['收样','试写','评分','封存','退回'].map(k =>
    '<div class="stat card"><span>'+k+'</span><b>'+(s.byStage[k]||0)+'</b></div>').join('')
    + '<div class="stat card"><span>进行中</span><b>'+s.active+'</b></div>'
    + '<div class="stat card"><span>冻结批次</span><b>'+s.batchesFrozen+'</b></div>'
    + '<div class="stat card"><span>待复核单</span><b>'+s.openTickets+'</b></div>'
    + '<div class="stat card"><span>版本总数</span><b>'+s.versions+'</b></div>';

  $('#fBatch').innerHTML = state.batches.map(b => '<option value="'+b.id+'">'+b.id+(b.frozen?'（冻结）':b.activeArchiveId?'（占用 '+b.activeArchiveId+'）':'（空闲）')+'</option>').join('');
  $('#batches').innerHTML = state.batches.map(b =>
    '<div class="card"><h3>'+b.id+' '+(b.frozen?'<span class="pill frozen">冻结</span>':'<span class="pill">正常</span>')+'</h3>'
    + '<div class="meta">温湿度：'+b.temp+'℃ / '+b.humidity+'% · 建立：'+b.createdBy.name+'</div>'
    + (b.frozen ? '<div class="warn">'+b.frozenReason+' @ '+b.frozenAt+'</div>' : '')
    + '<div class="row" style="margin-top:6px"><input type="number" step="0.1" value="'+b.temp+'" id="rT-'+b.id+'" style="width:80px"><input type="number" step="0.1" value="'+b.humidity+'" id="rH-'+b.id+'" style="width:80px"><button class="secondary" onclick="reading(&quot;'+b.id+'&quot;)">上报读数</button></div>'
    + '<details><summary>读数历史（'+b.readings.length+'）</summary><pre>'+b.readings.map(r=>r.at+'  '+r.temp+'℃ '+r.humidity+'% ('+r.by.name+')').join('\\n')+'</pre></details></div>').join('');

  $('#archives').innerHTML = state.archives.map(a => {
    const frozen = state.batches.find(b => b.id === a.batchId)?.frozen;
    const terminal = ['封存','退回'].includes(a.stage);
    return '<div class="card"><h3>'+a.id+' <span class="pill'+(terminal?' terminal':'')+'">'+a.stage+'</span>'+(frozen?'<span class="pill frozen">批次冻结</span>':'')+'</h3>'
      + '<div class="meta">批次 '+a.batchId+' · 留样 '+a.sampleNo+' · 操作者 '+a.operator+' · 当前版本 v'+a.currentVersion+(a.score!=null?' · 评分 '+a.score:'')+'</div>'
      + '<div class="ops">'
      + '<button onclick="go(&quot;'+a.id+'&quot;,&quot;试写&quot;)" '+(a.stage!=='收样'||frozen?'disabled':'')+'>试写</button>'
      + '<button onclick="go(&quot;'+a.id+'&quot;,&quot;评分&quot;)" '+(a.stage!=='试写'||frozen?'disabled':'')+'>评分</button>'
      + '<button onclick="go(&quot;'+a.id+'&quot;,&quot;封存&quot;)" '+(a.stage!=='评分'||frozen?'disabled':'')+'>封存</button>'
      + '<button class="danger" onclick="go(&quot;'+a.id+'&quot;,&quot;退回&quot;)" '+(terminal||frozen?'disabled':'')+'>退回</button>'
      + '<button class="secondary" onclick="versions(&quot;'+a.id+'&quot;)">版本/时间线</button>'
      + '</div><div id="d-'+a.id+'"></div></div>';
  }).join('') || '<div class="meta">暂无档案</div>';

  $('#tickets').innerHTML = state.tickets.map(t =>
    '<div class="card" style="margin-bottom:8px"><b>'+t.id+'</b> <span class="pill ticket">'+t.status+'</span>'
    + '<div>'+t.detail+'</div><div class="meta">批次 '+t.batchId+' · 提交人 '+t.createdBy.name+' @ '+t.createdAt+'</div>'
    + (t.review ? '<div class="meta">复核：'+t.review.by.name+' '+(t.review.approve?'通过':'驳回')+' '+t.review.comment+'</div>' : '')
    + (t.status==='待复核' ? '<div class="ops"><button onclick="review(&quot;'+t.id+'&quot;,true)">复核通过（解冻）</button><button class="danger" onclick="review(&quot;'+t.id+'&quot;,false)">驳回</button></div>' : '')
    + '</div>').join('') || '<div class="meta">暂无异常单</div>';

  const snaps = state.statsSnapshots || [];
  $('#snapshots').innerHTML = snaps.length ? '<table><tr><th>快照</th><th>档案</th><th>版本</th><th>阶段分布</th><th>进行中</th><th>时间</th></tr>'
    + snaps.map(sn => '<tr><td>'+sn.id+'</td><td>'+sn.archiveId+'</td><td>v'+sn.versionNo+'</td><td>'
      + ['收样','试写','评分','封存','退回'].map(k=>k+':'+(sn.stats.byStage[k]||0)).join(' ')
      + '</td><td>'+sn.stats.active+'</td><td class="meta">'+sn.at+'</td></tr>').join('') + '</table>'
    : '<div class="meta">暂无快照</div>';
}
async function versions(id) {
  const [vs, steps] = await Promise.all([
    API('/api/repro/archives/'+id+'/versions').then(r=>r.json()),
    API('/api/repro/archives/'+id+'/timeline').then(r=>r.json()),
  ]);
  const el = $('#d-'+id);
  el.innerHTML = '<details open><summary>时间线与 '+vs.length+' 个版本（旧版本不可变）</summary>'
    + '<div class="meta">时间线：'+steps.map(s=>s.step).join(' → ')+'</div>'
    + '<pre>'+vs.map(v=>'v'+v.no+' '+v.at+' '+v.step+' by '+v.actor.name+'\\n  状态='+v.archive.stage+(v.archive.score!=null?' 评分='+v.archive.score:'')+'\\n  快照='+JSON.stringify(v.stats)).join('\\n\\n')+'</pre></details>';
}
async function reading(id) {
  try { await call('/api/repro/batches/'+id+'/readings','POST',{ temp:Number($('#rT-'+id).value), humidity:Number($('#rH-'+id).value) }); msg('读数已上报',1); }
  catch(e){ msg(e.message); } await load();
}
async function go(id, step) {
  const body = { step };
  if (step==='试写') { body.paper=prompt('试磨纸张（如 净皮宣纸）'); if(body.paper===null) return; body.water=prompt('加水量（如 20滴）'); if(body.water===null) return;
    body.speed=prompt('出墨速度（可空）','快'); body.colorLayer=prompt('墨色层次（可空）','分明'); body.sediment=prompt('沉淀情况（可空）','无'); }
  if (step==='评分') { body.score=Number(prompt('评分 0-100')); if(!Number.isFinite(body.score)) return; }
  if (step==='封存') { body.sealLocation=prompt('封存位置（如 恒湿柜B-3）'); if(body.sealLocation===null) return; }
  if (step==='退回') { body.returnReason=prompt('退回原因'); if(body.returnReason===null) return; }
  try { await call('/api/repro/archives/'+id+'/transition','POST',body); msg(step+' 完成，已生成新版本',1); }
  catch(e){ msg(e.message); } await load();
}
async function review(id, approve) {
  const comment = prompt(approve ? '复核意见（通过将解冻批次）' : '驳回意见','') ;
  if (comment===null) return;
  try { await call('/api/repro/tickets/'+id+'/review','POST',{ approve, comment }); msg(approve?'复核通过':'已驳回',1); }
  catch(e){ msg(e.message); } await load();
}
$('#createBatch').onclick = async () => {
  try { const r = await call('/api/repro/batches','POST',{ temp:Number($('#bTemp').value), humidity:Number($('#bHum').value) });
    msg('批次已建立：'+r.batch.id+(r.oob?'（温湿度越界，已冻结并生成异常单 '+r.ticket.id+'）':''),1); }
  catch(e){ msg(e.message); } await load();
};
$('#createArchive').onclick = async () => {
  const body = { batchId:$('#fBatch').value, sampleNo:$('#fSample').value.trim(), operator:$('#fOperator').value.trim() };
  if ($('#fTemp').value) body.temp = Number($('#fTemp').value);
  if ($('#fHum').value) body.humidity = Number($('#fHum').value);
  try { const r = await call('/api/repro/archives','POST',body); msg('建档成功：'+r.archive.id+'，版本 v1',1); $('#fSample').value=''; }
  catch(e){ msg(e.message); } await load();
};
$('#reload').onclick = load;
load();
</script>
</body>
</html>`;
}
