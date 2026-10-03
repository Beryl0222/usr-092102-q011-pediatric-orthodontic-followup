# 儿童正畸生长随访 · 领域模型

本文件是后端各院区接入时必须遵循的领域约定。系统定位是**证据整理与节点提醒**：
帮助医生比较各阶段证据、帮助家长看清当前计划与下一节点；**不替医生自动诊断，
不按年龄自动给出治疗**。

## 1. 核心原则

1. **证据先行，人工决定**：任何治疗类方案都必须引用已采集证据（`PLAN_PROPOSED.evidence_refs`），
   经 `OPINION_ISSUED` 表达医生立场、`CONSENT_GRANTED(TREATMENT)` 完成知情同意、
   绑定未结束的复诊窗后，才能 `PLAN_CONFIRMED`。系统没有"年龄到了就矫治"的路径。
2. **仅追加，不覆盖**：发育变化、依从困难、器械不良反应一律通过 `PLAN_REVISED` /
   `PLAN_REASSESSED` 追加。原始观察、意见、提案与确认事件永不修改、不删除，
   修订通过 `revision_of` 指向上一版生效提案，形成可回溯链。
3. **多医生意见并存**：同一证据可被多条 `OPINION_ISSUED` 引用（立场可不同），
   以 `opinion_id` 区分，互不覆盖，分歧连同监护人知情决定一起留档。
4. **"先观察"不是"无需复诊"**：纯观察方案（条目类型 `OBSERVE`）同样必须绑定
   `FOLLOWUP_WINDOW_SCHEDULED`；逾期未完成的窗口进入提醒队列。
5. **双升级路径不混同**：急性牙痛 / 面部肿胀 / 牙外伤走 `URGENT_DENTAL`（severity
   必须 HIGH/URGENT），正畸生长类信号走 `ROUTINE_ORTHODONTIC`。信号与通道的映射
   在写入时强校验（见 `src/catalog.js` 的 `SIGNAL_CHANNEL`）。
6. **临床连续性优先于用途撤回**：证据的 `TREATMENT` 用途恒为 true 且不可撤回；
   撤回教学/科研等用途只对**未来使用**生效（`future_use_only=true`），不追溯改写
   已发生的诊疗记录，也不中断复诊。
7. **版本连续**：每个聚合的 `version` 从 1 起逐事件 +1，同聚合事件时间不得倒流；
   `event_id` 全局唯一。

## 2. 聚合与事件目录

| 聚合 aggregate_type | 职责 | 事件 |
|---|---|---|
| `child_record` | 儿童身份与监护关系 | `CHILD_REGISTERED`、`GUARDIAN_LINKED`、`GUARDIAN_CHANGED` |
| `growth_episode` | 一次连续随访主线（跨院区、跨牙列阶段） | `EPISODE_OPENED`、`RISK_ESCALATED`、`RISK_RESOLVED`、`FOLLOWUP_WINDOW_SCHEDULED`、`FOLLOWUP_COMPLETED`、`REFERRAL_ISSUED` |
| `clinical_observation` | 检查来源、证据、观察发现、医生意见 | `EVIDENCE_CAPTURED`、`OBSERVATION_RECORDED`、`OPINION_ISSUED` |
| `care_plan` | 方案提出/确认/修订/复评，治疗期问题 | `PLAN_PROPOSED`、`PLAN_CONFIRMED`、`PLAN_REVISED`、`PLAN_REASSESSED`、`ADVERSE_REACTION_REPORTED`、`COMPLIANCE_ISSUE_REPORTED` |
| `consent_scope` | 知情同意与用途撤回 | `CONSENT_GRANTED`、`CONSENT_WITHDRAWN` |

事件信封与稳定枚举的机器可读版本是 `contracts/domain.schema.json`（JSON Schema
2020-12）；代码侧单一事实来源是 `src/catalog.js`，两者必须一致（测试会交叉校验）。

### 信封

```json
{
  "event_id": "evt-...",
  "event_type": "PLAN_REVISED",
  "aggregate_type": "care_plan",
  "aggregate_id": "plan:plan-0007",
  "subject_id": "child-2022-0007",
  "occurred_at": "2027-06-15T09:30:00+08:00",
  "version": 3,
  "summary": "基于生长变化修订为功能矫治",
  "payload": { }
}
```

v1 的五类事件（`OBSERVATION_RECORDED` 等）无 `payload` 时仍合法；v2 新增事件必须
携带 `payload`，且携带 payload 的事件必须有与 `payload.child_id` 一致的 `subject_id`。

## 3. 证据与用途授权

`EVIDENCE_CAPTURED.payload.permissions` 按四种用途逐条记账：

- `TREATMENT`（诊疗）：**必须为 true 且不可撤回**；
- `TEACHING`（教学）、`RESEARCH`（科研）、`CROSS_CAMPUS_CONTINUITY`（跨院连续）：
  标记为 true 前，必须存在采集时点有效的对应知情同意。

`CONSENT_WITHDRAWN` 只能撤回非 TREATMENT 用途，必须：
- 由撤回时点的现任监护人作出；
- 声明 `future_use_only: true`；
- 给出 `scope.evidence_ids` 或 `scope.all_capture_sources`。

撤回后医生视图的 `usable_for` 立即反映；证据本身与既往诊疗记录保留。

## 4. 方案生命周期与修订语义

```
PLAN_PROPOSED ──(CONSENT_GRANTED[TREATMENT] + 开放复诊窗 + 现任监护人)──▶ PLAN_CONFIRMED
                                                                          │
            ADVERSE_REACTION_REPORTED / COMPLIANCE_ISSUE_REPORTED ───────┤
            新证据/发育变化（evidence_refs 必须晚于确认时间）──────────────┤
                                                                          ▼
                                                                     PLAN_REVISED
（revision_of 指向上一版生效提案；revision_proposal_id 标识新版；须重新知情同意+新窗口）
                                                                          │
            复诊窗 FOLLOWUP_COMPLETED 后 ─▶ PLAN_REASSESSED（CONTINUE/REVISE/PAUSE/COMPLETE）
```

- 以 `ADVERSE_REACTION` 为由修订前必须先有 `ADVERSE_REACTION_REPORTED`；
  以 `COMPLIANCE_DIFFICULTY` 为由修订前必须先有 `COMPLIANCE_ISSUE_REPORTED`。
- `GROWTH_CHANGE` / `NEW_EVIDENCE` 修订必须在 `evidence_refs` 列出确认后新增的证据。
- 复评不改变方案内容；复评结论为 REVISE 时，另发 `PLAN_REVISED`，原结论保留。

## 5. 监护关系连续性

- 建档后通过 `GUARDIAN_LINKED` 登记首任监护人；已有现任监护人时不得直接 link 他人，
  必须走 `GUARDIAN_CHANGED`，事件中携带 `continuity_note`（向新监护人告知方案、
  证据与授权台账）。
- 所有知情决定（同意、撤回、方案确认/修订）都校验决定人在事件时点是否为现任监护人。
- 监护人更换不改变既往授权的效力，新监护人可按正常撤回流程限制未来用途。

## 6. 跨院转诊

`REFERRAL_ISSUED` 要求：

- 存在 `CROSS_CAMPUS_CONTINUITY` 用途的知情同意，`consent_ref` 精确指向该事件；
- `continuity_package` 中每条证据都必须单独授权跨院连续用途；
- `purpose_restrictions` 列出的用途在转出时点必须有效，接收端只能在限定用途内使用。

## 7. 读模型（src/projections.js）

均为纯函数，输入已校验事件数组与"截止时点"，支持回看历史状态：

- `buildFamilyView(events, childId, at)`：家长视图——`current_plan`（状态、条目、
  最近修订与复评）、`observation_reasons`（观察/介入理由，可读中文）、
  `next_milestone`（下一复诊窗及是否逾期）、`active_risks`。不输出诊断码。
- `buildClinicianView(events, childId, at)`：接诊医生视图——证据按
  乳牙列/混合牙列/恒牙列分组，每条证据附**全部**医生意见与四用途 `usable_for`
  台账；方案含完整修订链、复评、不良反应、依从问题、转诊记录与同意台账。
- `buildTriageQueues(events, at)`：`urgent_dental` 与 `routine_orthodontic`
  两个不重叠队列（构建时断言无重叠），以及 `overdue_followups`（"先观察"逾期提醒）。

## 8. 模块索引

- `contracts/domain.schema.json`：信封 + 枚举 + 按事件类型的载荷约束（if/then）。
- `src/catalog.js`：事件、聚合、枚举、信号→通道路由的单一事实来源。
- `src/validator.js`：单事件结构校验（`validateEvent(record) -> string[]`）。
- `src/store.js`：仅追加 `EventStore`，负责版本流与全部跨事件不变量。
- `src/application.js`：`FollowupService`，领域动作到事件的工厂（聚合 ID/版本自动）。
- `src/projections.js`：三类读模型。
- `examples/scenario.js`：完整联调故事；`data/sample-*.json` 为其静态快照。
