/**
 * 文件作用：汇总并导出后端“AI Provider 与模型设置”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/ai-settings/index.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export type { AiSettings } from "./ai-settings.types.js";
export { maskApiKey } from "./credential-mask.js";
export {
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  MODEL_PROFILE_SEEDS,
  findModelProfileByName,
  findPiModelProfileByName,
  findSeedModelProfileByName,
  normalizeModelName,
  resolveContextWindowTokens,
  seedModelProfiles,
  type ModelProfileSeed,
} from "./model-profile.service.js";
export {
  LOCAL_MODEL_SOURCE_URL,
  deactivateLocalModelProfile,
  listLocalModelProfiles,
  prepareLocalModelProfile,
  registerLocalModelProfile,
  type LocalModelProfileInput,
} from "./local-model-catalog.service.js";
export {
  buildProviderTestRequest,
  normalizeReasoningEffortForModel,
  normalizeProviderBaseUrl,
  reasoningEffortOptionsForModel,
  resolveModelCapabilities,
  REASONING_EFFORTS,
  type ModelCapabilities,
  type ModelFamily,
  type OpenAICompatibleModelOptions,
  type ReasoningEffort,
} from "./model-capability.service.js";
export {
  runOpenAiCompatibleChat,
  streamOpenAiCompatibleChat,
  type OpenAiCompatibleChatInput,
} from "./openai-compatible-chat.js";
export {
  buildHomeworkTutorSystemPrompt,
  buildHomeworkTutorUserPrompt,
  type HomeworkTutorMode,
  type HomeworkTutorTurn,
} from "./homework-tutor.js";
export {
  buildStudyTutorSystemPrompt,
  buildStudyTutorUserPrompt,
  type StudyTutorTurn,
} from "./study-tutor.js";
export {
  buildRuntimeAiIdentityPrompt,
  type RuntimeAiIdentity,
} from "./runtime-ai-identity.js";
export {
  listAiProviderModels,
  parseAiProviderModels,
  testAiProvider,
} from "./provider-connectivity.service.js";
export {
  DEFAULT_AI_PROVIDER_PROFILE,
  getAiProviderOwnerEmail,
  normalizeAiProviderOwnerEmail,
  resolvePersonalSelectedAiProviderProfile,
  resolveSelectedAiProviderProfile,
  shouldUseForcedClassProvider,
} from "./provider-profile.service.js";
export {
  AiConcurrencyLimitError,
  acquireUserAiRequestSlot,
  withUserAiRequestSlot,
  withUserAiStreamSlot,
} from "./user-ai-concurrency.service.js";
export {
  AiDailyTokenQuotaError,
  beginClassAiAgentQuota,
  beginClassAiChatQuota,
  classAiUsageDate,
  estimateAiTokens,
  getClassAiTokenQuotaStatus,
  hasClassAiDailyTokenQuota,
  normalizeClassAiDailyTokenLimit,
  type AiTokenUsage,
  type ClassQuotaProvider,
} from "./class-ai-token-quota.service.js";
