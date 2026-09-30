/** Native acceptance bridge for the production plugin-job owner. */
import { startNanoBananaJob } from "$lib/api/plugin-jobs";
import { pluginJobsController } from "$lib/state/plugin-jobs";
import { createDomRpc } from "./dom-rpc";

interface ExternalJobRequest {
  token: string;
  sourcePath: string;
  outputDir: string;
  outputFilename: string;
}

export function startExternalJobProbe(signal: AbortSignal): void {
  createDomRpc<ExternalJobRequest>({
    event: "e2e-external-job",
    resultKey: "e2eExternalJobResult",
    signal,
    handlers: {
      default: ({ sourcePath, outputDir, outputFilename }) => pluginJobsController.accept(
        { kind: "nano-banana", label: outputFilename, detail: "native timeout acceptance" },
        () => startNanoBananaJob(
          sourcePath,
          "hold until the application cancels this job",
          outputDir,
          outputFilename,
          "native-fixture-key",
          "flash-image",
        ),
      ),
    },
  });
}
