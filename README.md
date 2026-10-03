# 儿童正畸生长随访

儿童正畸生长随访后端的领域层：围绕**儿童身份、监护关系、牙列阶段、检查来源、
龋病与不良习惯、颌面生长观察、风险信号、治疗方案、知情决定、复诊窗口**建立连续、
仅追加的事件档案，供各院区统一接入。

系统只整理证据与提醒，**不自动诊断、不按年龄给出治疗**；同一影像的多位医生意见
可以并存；急性龋痛与常规正畸评估走不同升级路径；监护人更换、照片科研用途撤回与
跨院转诊时，临床连续性与用途限制都完整保留；方案确认后的发育变化、依从困难与
器械不良反应通过修订与复评追加处理，不覆盖原判断。

## 目录

- `contracts/domain.schema.json`：事件信封、稳定枚举与按事件类型的载荷约束（v1 信封兼容）。
- `src/catalog.js`：事件/聚合/枚举/风险路由的单一事实来源。
- `src/validator.js`：单事件结构校验（`validateEvent`）。
- `src/store.js`：仅追加事件存储与跨事件不变量（`EventStore`）。
- `src/application.js`：领域动作工厂（`FollowupService`）。
- `src/projections.js`：家长视图、接诊医生视图、双通道分级队列。
- `examples/scenario.js`：完整联调故事（4 岁咨询→观察→龋痛急诊→生长变化修订→
  器械不良反应→监护人更换→科研撤回→跨院转诊）。
- `data/sample.json`：v1 信封最小样例；`data/sample-events.json` 及
  `data/sample-{family,clinician}-view.json`、`data/sample-triage.json`：完整故事快照。
- `docs/domain-model.md`：领域原则、事件目录、不变量与授权/转诊语义（接入前必读）。

## 本地检查

```bash
npm test
```

测试覆盖：schema 与目录一致性、v1 向后兼容、完整生命周期、以及每一条关键不变量的
拒绝用例（错误通道、无证据方案、未知情确认、修订覆盖、撤回诊疗用途、越权转诊等）。
