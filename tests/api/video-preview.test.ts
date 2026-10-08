import { beforeEach, expect, it, vi } from "vitest";
const { invoke, getSession, guard } = vi.hoisted(() => ({invoke:vi.fn(),getSession:vi.fn(),guard:vi.fn()}));
vi.mock("$lib/api/common", () => ({invoke,virtualPathGuard:guard}));
vi.mock("$lib/api/native-resource-session", () => ({getNativeResourceSession:getSession}));
import { loadVideoPreview } from "$lib/api/video-preview";
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
