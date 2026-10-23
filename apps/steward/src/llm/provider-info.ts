// Console links follow the providers' own consoles (and Magpie's provider presets).
// Runtime endpoints live in the model catalog, never in this presentation metadata.
export interface ProviderInfo {
  family: string;
  familyName: string;
  plan?: "api" | "coding" | "token" | "individual";
  region?: "global" | "cn" | "sgp" | "ams";
  consoleUrl: string;
  keysUrl: string;
}

const links: Record<string, [string, string?]> = {
  anthropic: ["https://console.anthropic.com", "/settings/keys"],
  openai: ["https://platform.openai.com", "/api-keys"],
  google: ["https://aistudio.google.com", "/apikey"],
  deepseek: ["https://platform.deepseek.com", "/api_keys"],
  xai: ["https://console.x.ai"],
  moonshotai: ["https://platform.moonshot.ai", "/console/api-keys"],
  "moonshotai-cn": ["https://platform.moonshot.cn", "/console/api-keys"],
  "kimi-coding": ["https://www.kimi.com/code/console"],
  zai: ["https://z.ai", "/manage-apikey/apikey-list"],
  "zai-api": ["https://z.ai", "/manage-apikey/apikey-list"],
  "zai-coding-cn": ["https://open.bigmodel.cn", "/usercenter/proj-mgmt/apikeys"],
  "zai-api-cn": ["https://open.bigmodel.cn", "/usercenter/proj-mgmt/apikeys"],
  minimax: ["https://platform.minimax.io", "/user-center/basic-information/interface-key"],
  "minimax-cn": ["https://platform.minimaxi.com", "/user-center/basic-information/interface-key"],
  xiaomi: ["https://platform.xiaomimimo.com", "/console/api-keys"],
  "xiaomi-token-plan-cn": ["https://platform.xiaomimimo.com", "/token-plan"],
  "xiaomi-token-plan-sgp": ["https://platform.xiaomimimo.com", "/token-plan"],
  "xiaomi-token-plan-ams": ["https://platform.xiaomimimo.com", "/token-plan"],
  "qwen-token-plan": ["https://modelstudio.console.alibabacloud.com"],
  "qwen-token-plan-cn": ["https://bailian.console.aliyun.com", "/cn-beijing/subscription/token-plan/personal"],
  "qwen-token-plan-individual": ["https://modelstudio.console.alibabacloud.com"],
  openrouter: ["https://openrouter.ai", "/keys"],
  mistral: ["https://console.mistral.ai", "/api-keys"],
  groq: ["https://console.groq.com", "/keys"],
  "amazon-bedrock": ["https://console.aws.amazon.com/bedrock/home", "#/api-keys"],
  azure: ["https://portal.azure.com", "/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI"],
  together: ["https://api.together.ai", "/settings/api-keys"],
  fireworks: ["https://app.fireworks.ai", "/settings/users/api-keys"],
  cerebras: ["https://cloud.cerebras.ai", "/platform/api-keys"],
  baseten: ["https://app.baseten.co", "/settings/api_keys"],
  huggingface: ["https://huggingface.co", "/settings/tokens"],
  nvidia: ["https://build.nvidia.com"],
  "google-vertex": ["https://console.cloud.google.com/vertex-ai"],
  "cloudflare-ai-gateway": ["https://dash.cloudflare.com", "/profile/api-tokens"],
  "cloudflare-workers-ai": ["https://dash.cloudflare.com", "/profile/api-tokens"],
  "vercel-ai-gateway": ["https://vercel.com/dashboard"],
  "github-copilot": ["https://github.com/settings/copilot", "https://github.com/settings/tokens"],
  "openai-codex": ["https://chatgpt.com"],
  opencode: ["https://opencode.ai/auth"],
  "opencode-go": ["https://opencode.ai/auth"],
  "ant-ling": ["https://developer.ant-ling.com"],
  meta: ["https://api.meta.ai"],
  radius: ["https://radius.pi.dev"],
};

const variants: Record<string, [string, string, ProviderInfo["plan"], ProviderInfo["region"]]> = {
  moonshotai: ["moonshotai", "Kimi", "api", "global"],
  "moonshotai-cn": ["moonshotai", "Kimi", "api", "cn"],
  "kimi-coding": ["moonshotai", "Kimi", "coding", "global"],
  zai: ["zai", "Z.AI / GLM", "coding", "global"],
  "zai-api": ["zai", "Z.AI / GLM", "api", "global"],
  "zai-coding-cn": ["zai", "Z.AI / GLM", "coding", "cn"],
  "zai-api-cn": ["zai", "Z.AI / GLM", "api", "cn"],
  minimax: ["minimax", "MiniMax", undefined, "global"],
  "minimax-cn": ["minimax", "MiniMax", undefined, "cn"],
  xiaomi: ["xiaomi", "Xiaomi MiMo", "api", undefined],
  "xiaomi-token-plan-cn": ["xiaomi", "Xiaomi MiMo", "token", "cn"],
  "xiaomi-token-plan-sgp": ["xiaomi", "Xiaomi MiMo", "token", "sgp"],
  "xiaomi-token-plan-ams": ["xiaomi", "Xiaomi MiMo", "token", "ams"],
  "qwen-token-plan": ["qwen-token-plan", "Qwen", "token", "global"],
  "qwen-token-plan-cn": ["qwen-token-plan", "Qwen", "token", "cn"],
  "qwen-token-plan-individual": ["qwen-token-plan", "Qwen", "individual", "global"],
};

export function providerInfo(id: string, name: string): ProviderInfo | undefined {
  const entry = links[id];
  if (!entry) return undefined;
  const [consoleUrl, path] = entry;
  const [family, familyName, plan, region] = variants[id] ?? [id, name, undefined, undefined];
  return { family, familyName, plan, region, consoleUrl, keysUrl: path ? new URL(path, consoleUrl).href : consoleUrl };
}
