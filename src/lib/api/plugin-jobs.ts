/** Long-running image plugin job launchers. Completion arrives through events. */
import { invoke, extractError, type ApiResult } from "./common";

export async function startNanoBananaJob(
  sourcePath: string,
  prompt: string,
  outputDir: string,
  outputFilename: string,
  apiKey: string,
  model: string,
): Promise<ApiResult<number>> {
  try {
    const data = await invoke<number>("start_nano_banana_job", {
      sourcePath, prompt, outputDir, outputFilename, apiKey, model,
    });
    return { ok: true, data };
  } catch (err) { return { ok: false, error: extractError(err) }; }
}

export async function startUpscaleJob(
  sourcePath: string,
  outputDir: string,
  outputFilename: string,
  apiKey: string,
  upscaleFactor: number,
): Promise<ApiResult<number>> {
  try {
    const data = await invoke<number>("start_upscale_job", {
      sourcePath, outputDir, outputFilename, apiKey, upscaleFactor,
    });
    return { ok: true, data };
  } catch (err) { return { ok: false, error: extractError(err) }; }
}
