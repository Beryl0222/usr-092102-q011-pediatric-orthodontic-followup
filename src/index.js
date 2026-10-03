// 儿童正畸生长随访后端 —— 模块入口
export * from "./domain/codes.js";
export { makeEvent, checkEnvelope } from "./domain/events.js";
export { validateEvent } from "./validator.js";
export {
  reduceEpisode,
  reduceObservation,
  reducePlan,
  reduceConsent,
  activeGuardians,
  isPurposeAllowed,
} from "./domain/reducers.js";
export {
  EventStore,
  ConcurrencyError,
  EventValidationError,
} from "./infrastructure/eventStore.js";
export { FollowupService, DomainError } from "./application/followupService.js";
export { FollowupQueries } from "./application/queryService.js";
