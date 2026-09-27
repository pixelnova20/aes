export type RuntimeAiIdentity = {
  name?: string | null;
  model: string;
  reasoningEffort?: string | null;
  source?: "personal" | "class";
};

/** Give proxied tutors authoritative, non-secret details about the active profile. */
export function buildRuntimeAiIdentityPrompt(settings: RuntimeAiIdentity) {
  const profileName = settings.name?.trim() || "未命名配置";
  const profileSource = settings.source === "class" ? "班级强制配置" : "个人配置";
  const reasoningEffort = settings.reasoningEffort || "default";
  return [
    "以下 AES 运行时信息是本次请求实际使用的 AI Provider 配置，以此信息为准：",
    `- AI Provider Profile：${JSON.stringify(profileName)}（${profileSource}）`,
    `- LLM 模型：${JSON.stringify(settings.model)}`,
    `- 推理级别：${JSON.stringify(reasoningEffort)}`,
    "当用户询问当前使用的模型、LLM、Provider Profile 或推理级别时，请直接依据以上信息回答。",
    "不要通过猜测环境变量、配置文件或服务实现来判断这些信息。",
  ].join("\n");
}
