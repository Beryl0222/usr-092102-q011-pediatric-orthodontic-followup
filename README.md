# 儿童正畸生长随访

儿童正畸生长随访后端：围绕儿童身份、监护关系、牙列阶段、检查来源、龋病与不良习惯、
颌面生长观察、风险信号、治疗方案、知情决定与复诊窗口形成**连续档案**。
系统只整理证据与提醒，不替医生自动诊断、不按年龄给治疗。

## 设计要点

- **契约兼容**：不改动 `contracts/domain.schema.json` 的信封枚举，业务细分放在
  `payload.kind`（见 [`docs/domain-model.md`](docs/domain-model.md)）。
- **只追加、不覆盖**：事件溯源；方案变化走修订与复评（发育变化/依从困难/器械不良反应），
  原方案完整留存；同一影像多位医生意见并存。
- **观察不等于无需复诊**：OBSERVE 意见/方案必须写观察理由和复诊窗口，逾期自动提醒。
- **双升级路径**：急性牙痛/肿胀走 `URGENT_DENTAL`（24h SLA），常规正畸问题走
  `ROUTINE_ORTHO`，二者不能合并升级。
- **用途限制随档保留**：撤回照片科研用途只关闭研究视图、不删资料；监护人更换不重置授权；
  跨院转诊同时携带诊疗连续性与教研用途限制。
- **两类视图**：家长看到当前计划、观察理由、下一节点；医生可比较各阶段证据并按
  诊疗/教学/研究用途过滤影像。

## 目录

- `contracts/domain.schema.json`：领域事件信封及稳定枚举（未改动）。
- `docs/domain-model.md`：payload.kind 与信封的挂载关系、版本与修订语义。
- `src/domain/`：稳定词汇、事件工厂、聚合 reducer。
- `src/infrastructure/eventStore.js`：追加型事件存储（版本递增、乐观并发）。
- `src/application/`：`FollowupService`（写命令）与 `FollowupQueries`（家长/医生视图、提醒）。
- `data/sample.json`：信封联调样例；`data/sample-followup.json`：观察方案业务样例。
- `tests/`：契约一致性与核心业务场景。

## 快速使用

```js
import {
  FollowupService, FollowupQueries, EventStore,
  CONSENT_SCOPE, PURPOSE, DENTITION_STAGE, DECISION,
} from "./src/index.js";

const svc = new FollowupService(new EventStore());
const q = new FollowupQueries(svc.store);

svc.openEpisode({ episode_id: "ep-1", child: { child_id: "c1", name: "豆豆" },
  guardian: { guardian_id: "g1", name: "豆妈", relationship: "MOTHER" }, site_id: "site-a" });
svc.recordExam({ observation_id: "obs-1", episode_id: "ep-1",
  examined_at: "2026-09-01T10:00:00+08:00", child_age_months: 48,
  dentition_stage: DENTITION_STAGE.PRIMARY, examiner_id: "doc-a", source: "门诊检查" });
svc.confirmPlan({ episode_id: "ep-1", decision: DECISION.OBSERVE,
  rationale: "颌骨仍在快速生长", observation_reason: "等待切牙替换判断反𬌗是否持续",
  followup_window: { due_date: "2026-12-01", reason: "切牙替换期复评" },
  confirming_guardian_id: "g1", physician_id: "doc-a" });

q.buildParentView("ep-1");  // 当前计划 + 观察理由 + 下一节点
q.listDueWindows();         // 逾期/临近复诊与紧急 SLA 提醒
```

## 本地检查

```bash
npm test
```
