import { beforeEach, expect, it, vi } from "vitest";
const { invoke, getSession, guard } = vi.hoisted(() => ({invoke:vi.fn(),getSession:vi.fn(),guard:vi.fn()}));
vi.mock("$lib/api/common", () => ({invoke,virtualPathGuard:guard}));
vi.mock("$lib/api/native-resource-session", () => ({getNativeResourceSession:getSession}));
import { loadVideoAudio, loadVideoPreview, NoVideoAudio } from "$lib/api/video-preview";
beforeEach(() => {vi.clearAllMocks();guard.mockReturnValue(null);getSession.mockResolvedValue("session");});
it("rejects virtual locations before starting a native session or capability", async () => {
  guard.mockReturnValue({error:"Virtual locations cannot preview video"});
  getSession.mockRejectedValue(new Error("Native session unavailable"));
  await expect(loadVideoPreview("virtual://movie").promise).rejects.toThrow("Virtual locations");
  expect(getSession).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it("uses the acknowledged native session for acquisition, preparation and release", async () => {
  invoke.mockImplementation(async command => command === "begin_video_preview" ? "capability" : command === "prepare_video_preview" ? "http://127.0.0.1/media/capability" : undefined);
  const job=loadVideoPreview("/movie.webm"); const source=await job.promise;source.release();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("release_video_preview",{sessionId:"session",token:"capability"}));
  expect(invoke).toHaveBeenCalledWith("prepare_video_preview",{sessionId:"session",token:"capability",path:"/movie.webm"});
});
import { saveVideoCopy, probeVideoCodec } from "$lib/api/video-preview";
it("saves a copy to the chosen destination, and does nothing on cancel", async () => {
  invoke.mockImplementation(async c => c === "pick_file" ? "/out/m.mkv" : undefined);
  expect(await saveVideoCopy("/m.mkv", "m.mkv")).toBe(true);
  expect(invoke).toHaveBeenCalledWith("save_file_copy", { source: "/m.mkv", destination: "/out/m.mkv" });
  invoke.mockClear(); invoke.mockResolvedValue(null);
  expect(await saveVideoCopy("/m.mkv", "m.mkv")).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("save_file_copy", expect.anything());
});
it("probe failure yields null", async () => {
  invoke.mockRejectedValue(new Error("x"));
  expect(await probeVideoCodec("/m.mkv")).toBeNull();
});
it("companion audio uses its own capability and reports a file without audio (#1171)", async () => {
  invoke.mockImplementation(async command => command === "begin_video_preview" ? "audio-capability" : command === "prepare_video_audio_preview" ? "http://127.0.0.1/media/audio-capability" : undefined);
  const source = await loadVideoAudio("/movie.mp4").promise;
  expect(source.url).toBe("http://127.0.0.1/media/audio-capability");
  expect(invoke).toHaveBeenCalledWith("prepare_video_audio_preview", { sessionId: "session", token: "audio-capability", path: "/movie.mp4" });
  source.release();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("release_video_preview", { sessionId: "session", token: "audio-capability" }));
  invoke.mockImplementation(async command => command === "begin_video_preview" ? "silent" : null);
  await expect(loadVideoAudio("/silent.mp4").promise).rejects.toBeInstanceOf(NoVideoAudio);
});
