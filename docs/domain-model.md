# 领域模型与事件约定

本服务在不修改 `contracts/domain.schema.json` 的前提下建设。契约只固定**信封**
（5 种 `event_type` × 4 种 `aggregate_type`，`additionalProperties: true`），
业务细分统一放在 `payload`，其中 `payload.kind` 是本服务的稳定细分枚举。

## 1. 信封与 payload.kind 的挂载关系

| event_type（契约） | payload.kind | 允许的 aggregate_type |
| --- | --- | --- |
| OBSERVATION_RECORDED | EPISODE_OPENED、GUARDIAN_CHANGED、EXAM_RECORDED、IMAGE_CAPTURED、FINDING_RECORDED、CONSENT_GRANTED、CONSENT_WITHDRAWN | growth_episode / clinical_observation / consent_scope |
| OPINION_ISSUED | OPINION_ISSUED | clinical_observation |
| PLAN_CONFIRMED | PLAN_CONFIRMED | care_plan |
| RISK_ESCALATED | RISK_ESCALATED | clinical_observation |
| FOLLOWUP_COMPLETED | VISIT_COMPLETED、REFERRAL_TRANSFERRED | growth_episode |

约束由 `src/domain/events.js` 的 `checkEnvelope()` 在入存储前强制；
契约字段由 `src/validator.js` 校验。新增业务能力时**新增 payload.kind**，
不新增信封枚举，保证各院区旧版本仍可解析。

说明：

- `EXAM_RECORDED` 同时出现在 `clinical_observation`（检查事实本体）和
  `growth_episode`（连续档案索引）。
- 同意的授予/撤回是"记录一项决定事实"，归 `OBSERVATION_RECORDED`。

## 2. 聚合与连续档案

- `growth_episode/{episode_id}`：儿童身份、监护关系史、检查索引、转诊状态。
- `clinical_observation/{observation_id}`：一次检查/复诊遭遇，含检查来源
  （门诊检查 / 转诊带入 / 远程随访）、影像、龋病与不良习惯、颌面生长观察、
  多位医生意见、风险升级。
- `care_plan/careplan-{episode_id}`：当前方案 + 历史方案链。
- `consent_scope/consent-{episode_id}`：`scope(PHOTO/CLINICAL_RECORD) × purpose(诊疗/教学/研究)` 授权矩阵。

同一 `episode_id` 下的全部事件按 `occurred_at` 排序即构成跨院区连续档案
（`EventStore.loadEpisode`）。

## 3. 系统边界（重要）

- 系统**只整理证据、管理观察窗口与提醒**，不自动诊断、不做"年龄→治疗"规则。
  月龄（`child_age_months`）与牙列阶段仅作事实记录。
- 矫治器（`appliance`）只能出现在医生 `decision=TREAT` 且附知情决定事件的方案中；
  `TREAT` 方案无 `consent_event_ids` 会被拒绝。
- `decision=OBSERVE` 的意见与方案必须同时给出 `observation_reason` 与
  `followup_window.due_date`，从机制上消除"先观察 = 不用复诊"的误解。

## 4. 两条互斥升级路径

风险信号（`RISK_CODE`）在登记时即绑定路径，一次升级不允许混路径：

- `URGENT_DENTAL`：自发性牙痛、夜间痛、面部肿胀、牙外伤——24 小时 SLA，
  家长视图置顶提醒。
- `ROUTINE_ORTHO`：龋病进展、持续口呼吸、习惯持续、生长不对称、反𬌗趋势、
  间隙丧失——进入复诊窗口管理。

混路径升级抛 `MIXED_ESCALATION_PATH`，必须分别升级。

## 5. 只追加、不覆盖

- 事件存储 append-only；`version` 按聚合实例从 1 递增，写入带 `expectedVersion`
  做乐观并发控制。
- 方案确认后，后续**发育变化 / 依从困难 / 器械不良反应**一律通过
  `PLAN_CONFIRMED(kind=PLAN_CONFIRMED, revises_plan_id=…, revision_trigger=…,
  reassessment_opinion_ids=…)` 修订：原方案完整进入 `history`，且必须附复评意见。
  重复确认（无修订字段）抛 `PLAN_EXISTS`。
- 同一影像的多位医生意见在 `opinions[]` 中并存，不做去重与覆盖。
- 风险升级的后续 `RESOLVED` 事件只改变处置状态，原始升级事件保留。

## 6. 用途限制与连续性

- 授权按 scope × purpose 独立生效；撤回（CONSENT_WITHDRAWN）只关闭对应格子，
  **不删除任何事件**——诊疗连续性保留。
- 监护人更换（GUARDIAN_CHANGED）保留完整监护史，**不重置** consent 矩阵；
  授权决定只能由当前监护人作出。
- 跨院转诊（REFERRAL_TRANSFERRED）生成转诊包：诊疗证据随包以保持连续性，
  非诊疗用途的授权状态（如 PHOTO.TEACHING/RESEARCH）以 `consent_restrictions`
  原样随附，接收方必须继续遵守；转出后本院区不能再登记检查。

## 7. 读模型

- 家长视图 `buildParentView`：当前计划、观察理由、下一节点（紧急 SLA 优先）、
  在途紧急升级、转诊信息。
- 医生视图 `buildPhysicianView(episodeId, {purpose})`：各阶段证据时间线
  （牙列阶段、龋病/习惯/生长、影像、多医生意见）、方案修订链、每份影像在
  请求用途下是否可用、完整授权矩阵。
- 全院提醒 `listDueWindows`：OVERDUE / DUE_SOON（14 天内）窗口，含紧急 SLA；
  复诊完成（VISIT_COMPLETED）后窗口关闭。
