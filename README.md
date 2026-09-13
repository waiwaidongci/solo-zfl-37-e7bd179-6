# 墨锭试磨室

运行：

```bash
npm start
```

- 旧版墨锭试磨室：`http://localhost:3037/`，数据保存在 `data/ink-stick-testing.json`（建档、状态调整、试磨记录、统计，行为与旧数据保持不变）。
- 可复现实验档案（新）：`http://localhost:3037/repro`，数据独立保存在 `data/repro-archives.json`。

## 可复现实验档案

每次试磨建档时绑定**环境批次、操作者、留样编号**，按状态机流转：

```
收样 → 试写 → 评分 → 封存
  └──────┴──────┴────→ 退回（任一步可退回，封存/退回为终态）
```

- **跳步拒绝**：只能按相邻状态推进，否则 `409 skip_step`。
- **越权拒绝**：请求头 `x-user` 指定操作者；收样员/试磨员/评分师/复核员/主任各司其职，越岗返回 `403 forbidden_role`，缺身份 `401`。
- **同批次唯一进行中试磨**：重复留样编号或同批次并发建档，串行写锁保证只有一次成功，其余 `409`（`sample_exists` / `batch_busy`）。
- **温湿度越界**：温度区间 `[18,25]℃`、湿度 `[45,65]%`。越界立即**冻结环境批次并生成异常单**；冻结期间禁止建档与流转。异常单经**他人复核通过**后解冻（提交人不能自审 `403 self_review`；驳回后复测达标自动解冻）。
- **不可变版本**：每次修改追加新版本，版本内嵌完整档案快照与当时统计快照；旧版本、时间线、统计快照此后不再变化。
- **原子持久化**：临时文件 + rename 落盘；写入失败时内存、事件、版本整体回滚，返回 `507 disk_write_failed`，不留部分结果与临时文件。

页面右上角可切换操作者、勾选"注入磁盘写失败"演练失败流程。

### 演练脚本

服务启动后执行，覆盖正常、冲突并发、越权跳步、温湿度冻结复核、磁盘失败与旧入口兼容（36 项断言）：

```bash
node scripts/walkthrough.mjs        # 后端端到端
node scripts/page-harness.mjs       # 页面失败注入/刷新恢复（真实执行页面脚本）
node scripts/mobile-layout-check.mjs # 手机宽度（375/320px）防横向溢出核验
```

### 主要 API（均为 JSON）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/repro/batches` | 建立环境批次（建批读数越界即冻结+异常单） |
| POST | `/api/repro/batches/:id/readings` | 上报温湿度读数 |
| GET  | `/api/repro/batches/:id` | 批次详情（含进行中档案） |
| POST | `/api/repro/archives` | 收样建档 |
| POST | `/api/repro/archives/:id/transition` | 流转 `{step: 试写|评分|封存|退回, ...}` |
| GET  | `/api/repro/archives/:id` | 档案详情 |
| GET  | `/api/repro/archives/:id/versions` | 全部版本（含档案/统计快照） |
| GET  | `/api/repro/archives/:id/timeline` | 时间线 |
| POST | `/api/repro/tickets/:id/review` | 复核异常单 `{approve, comment}` |
| GET  | `/api/repro/events` | 仅追加事件流（可按 batchId/archiveId 过滤） |
| GET  | `/api/repro/stats` | 当前统计与历史快照 |

请求头：`x-user: u-clerk|u-grinder|u-judge|u-reviewer|u-admin`；故障演练加 `x-fail-write: 1`。
