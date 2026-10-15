import { describe, expect, it } from "vitest";
import { validateTextConfiguration, validateTextProfile, editableConfiguration, type TextConfiguration, type HttpTextProfile } from "$lib/domain/text-connections";
const profile = (patch: Partial<HttpTextProfile> = {}): HttpTextProfile => ({ id: "custom", name: "DeepSeek", model: "custom-model", transport: "openai-chat-completions", baseUrl: "https://api.example.test/nested/v1/", credential: { kind: "none" }, timeoutMs: 45000, allowInsecureHttp: false, ...patch });
const configuration = (patch: Partial<TextConfiguration> = {}): TextConfiguration => ({ schemaVersion: 1, revision: 0, enabled: true, defaultProfileId: "custom", profiles: [profile()], ...patch } as TextConfiguration);
describe("text connection rules", () => {
  it("accepts manual models and prefix roots with or without trailing slashes", () => {
    for (const baseUrl of ["https://api.example.test/nested/v1", "https://api.example.test/nested/v1/"]) expect(validateTextProfile(profile({ baseUrl, model: "user-entered-v2029" }))).toEqual([]);
  });
  it.each(["https://user:key@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/v1#secret", "https://example.test/v1?", "https://example.test/v1#", "ftp://example.test", "broken", "http://example.test/v1"])("rejects unsafe API root %s", baseUrl => expect(validateTextProfile(profile({ baseUrl }))).not.toEqual([]));
  it("allows loopback HTTP or explicitly selected insecure transport", () => {
    expect(validateTextProfile(profile({ baseUrl: "http://localhost:1234/prefix" }))).toEqual([]);
    expect(validateTextProfile(profile({ baseUrl: "http://private.example:1234/v1", allowInsecureHttp: true }))).toEqual([]);
  });
  it("bounds timeout, model and environment names", () => {
    for (const timeoutMs of [NaN, 0, 999, 45001, 1.1]) expect(validateTextProfile(profile({ timeoutMs }))).not.toEqual([]);
    for (const model of ["", "  ", "x".repeat(257), "model\nsecret"]) expect(validateTextProfile(profile({ model }))).not.toEqual([]);
    for (const name of ["", "BAD-NAME", "1KEY", "X".repeat(129)]) expect(validateTextProfile(profile({ credential: { kind: "environment", name } }))).not.toEqual([]);
  });
  it("matches native Unicode scalar limits and rejects invalid credentials/path controls", () => {
    expect(validateTextProfile(profile({ name: "👩".repeat(256), model: "模型".repeat(128) }))).toEqual([]);
    expect(validateTextProfile(profile({ model: "👩".repeat(257) }))).not.toEqual([]);
    expect(validateTextProfile(profile({ credential: { kind: "secret", id: "owner/key" } }))).not.toEqual([]);
    expect(validateTextProfile({ id: "cli", name: "CLI", model: "model", transport: "codex-cli", executablePath: "bad\tpath", timeoutMs: 1000 })).not.toEqual([]);
  });
  it("requires a selected existing profile when enabled without choosing an arbitrary replacement", () => {
    expect(validateTextConfiguration(configuration({ defaultProfileId: "missing" }))).not.toEqual([]);
    expect(validateTextConfiguration(configuration({ enabled: false, defaultProfileId: null, profiles: [] }))).toEqual([]);
    expect(validateTextConfiguration(configuration({ enabled: true, defaultProfileId: "", profiles: [] }))).not.toEqual([]);
    expect(validateTextConfiguration(configuration({ profiles: [profile(), profile()] }))).not.toEqual([]);
  });
  it("strips sanitized credential presence before save and preserves source metadata", () => {
    const result = editableConfiguration(configuration({ profiles: [profile({ hasCredential: true, credential: { kind: "secret", id: "secret-id" } })] }));
    expect(result.profiles[0]).not.toHaveProperty("hasCredential");
    expect((result.profiles[0] as HttpTextProfile).credential).toEqual({ kind: "secret", id: "secret-id" });
  });
});
