/** Native acceptance bridge for the production plugin-job owner. */
import { startNanoBananaJob } from "$lib/api/plugin-jobs";
import { pluginJobsController } from "$lib/state/plugin-jobs";

interface ExternalJobRequest {
  token: string;
  sourcePath: string;
  outputDir: string;
  outputFilename: string;
}

export function startExternalJobProbe(signal: AbortSignal): void {
  if (signal.aborted) return;
  const resultKey = "e2eExternalJobResult";
  signal.addEventListener("abort", () => {
    delete document.documentElement.dataset[resultKey];
  }, { once: true });
  window.addEventListener("e2e-external-job", ((event: CustomEvent<ExternalJobRequest>) => {
    const { token, sourcePath, outputDir, outputFilename } = event.detail;
    void pluginJobsController.accept(
      { kind: "nano-banana", label: outputFilename, detail: "native timeout acceptance" },
      () => startNanoBananaJob(
        sourcePath,
        "hold until the application cancels this job",
        outputDir,
        outputFilename,
        "native-fixture-key",
        "flash-image",
      ),
    ).then((result) => {
      if (!signal.aborted) {
        document.documentElement.dataset[resultKey] = JSON.stringify({ token, result });
      }
    });
  }) as EventListener, { signal });
}
