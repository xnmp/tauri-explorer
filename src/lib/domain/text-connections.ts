/** Host-owned text connection metadata. Credentials are always write-only. */
export type TextTransport = "codex-cli" | "claude-code-cli" | "openai-chat-completions" | "anthropic-messages";
export type CredentialSource = { kind: "none" } | { kind: "environment"; name: string } | { kind: "secret"; id: string };
interface CommonProfile { id: string; name: string; model: string; timeoutMs: number }
export type CliTextProfile = CommonProfile & { transport: "codex-cli" | "claude-code-cli"; executablePath: string };
export type HttpTextProfile = CommonProfile & { transport: "openai-chat-completions" | "anthropic-messages"; baseUrl: string; allowInsecureHttp: boolean; credential: CredentialSource; hasCredential?: boolean };
export type TextProfile = CliTextProfile | HttpTextProfile;
interface ConfigurationData { schemaVersion: 1; revision: number; profiles: TextProfile[] }
export type TextConfiguration = ConfigurationData & ({ enabled: true; defaultProfileId: string } | { enabled: false; defaultProfileId: string | null });
export interface ServiceError { code: string; message: string; retryAfterMs?: number }
export interface TextContext { profileId: string; configurationRevision: number; fingerprint: string; transport: TextTransport; requestedModel: string; actualModel?: string }
export interface TextDescription { version: 1; enabled: boolean; available: boolean; configurationRevision: number; context?: TextContext; error?: ServiceError }
export interface TextResult { text: string; context: TextContext; usage?: { inputTokens?: number; outputTokens?: number } }
export const TEXT_SETTINGS_SEARCH_TERMS = ["AI", "LLM", "Language models", "Codex", "Claude", "DeepSeek", "endpoint", "API key"];
export function isHttpProfile(profile: TextProfile): profile is HttpTextProfile { return profile.transport === "openai-chat-completions" || profile.transport === "anthropic-messages"; }
export function editableConfiguration(configuration: TextConfiguration): TextConfiguration {
  return { ...configuration, profiles: configuration.profiles.map(profile => isHttpProfile(profile) ? (({ hasCredential: _, ...publicProfile }) => ({ ...publicProfile, credential: { ...publicProfile.credential } }))(profile) : { ...profile }) };
}
const bounded = (value: string, max: number) => value.trim().length > 0 && [...value].length <= max && !/\p{Cc}/u.test(value);
export function validateTextProfile(profile: TextProfile): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(profile.id)) errors.push("Profile ID must be between 1 and 128 ASCII letters, digits, dots, underscores or hyphens.");
  if (!bounded(profile.name, 256)) errors.push("Name must be between 1 and 256 characters without control characters.");
  if (!bounded(profile.model, 256)) errors.push("Enter a model ID of up to 256 characters without control characters.");
  if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 45000) errors.push("Timeout must be between 1 and 45 seconds.");
  if (!isHttpProfile(profile)) {
    if (new TextEncoder().encode(profile.executablePath).length > 4096 || /\p{Cc}/u.test(profile.executablePath)) errors.push("Executable path must be at most 4096 bytes without control characters.");
    return errors;
  }
  try {
    const root = new URL(profile.baseUrl);
    if (new TextEncoder().encode(profile.baseUrl).length > 2048 || root.username || root.password || root.search || root.hash || /[?#]/.test(profile.baseUrl)) throw new Error();
    if (root.protocol !== "https:" && !(root.protocol === "http:" && (profile.allowInsecureHttp || ["localhost", "127.0.0.1", "[::1]"].includes(root.hostname)))) throw new Error();
  } catch { errors.push("Enter an HTTPS API root without credentials, query or fragment; HTTP requires a local endpoint or explicit permission."); }
  if (profile.credential.kind === "environment" && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(profile.credential.name)) errors.push("Enter an environment variable name, such as DEEPSEEK_API_KEY.");
  if (profile.credential.kind === "secret" && !/^[A-Za-z0-9._-]{1,128}$/.test(profile.credential.id)) errors.push("The saved credential reference is invalid.");
  return errors;
}
export function validateTextConfiguration(configuration: TextConfiguration): string[] {
  const errors = configuration.profiles.flatMap(profile => validateTextProfile(profile).map(error => `${profile.name || "Profile"}: ${error}`));
  if (configuration.schemaVersion !== 1 || !Number.isSafeInteger(configuration.revision) || configuration.revision < 0) errors.push("Unsupported configuration schema or revision.");
  if (configuration.profiles.length > 32) errors.push("Save at most 32 profiles.");
  if (new Set(configuration.profiles.map(p => p.id)).size !== configuration.profiles.length) errors.push("Profile IDs must be unique.");
  if ((configuration.enabled || configuration.defaultProfileId !== null) && !configuration.profiles.some(p => p.id === configuration.defaultProfileId)) errors.push("Select an existing default profile before enabling language models.");
  return errors;
}
export function newTextProfile(id: string, model = ""): CliTextProfile { return { id, name: "New connection", transport: "codex-cli", model, executablePath: "", timeoutMs: 45000 }; }
export function changeTransport(profile: TextProfile, transport: TextTransport): TextProfile {
  const common = { id: profile.id, name: profile.name, model: profile.model, timeoutMs: profile.timeoutMs };
  return transport === "codex-cli" || transport === "claude-code-cli" ? { ...common, transport, executablePath: "" } : { ...common, transport, baseUrl: transport === "anthropic-messages" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1", allowInsecureHttp: false, credential: { kind: "none" } };
}
