import { describe, expect, it } from "@jest/globals";
import { isWorkerCmdline } from "./reapOrphanedWorkers.ts";

describe("isWorkerCmdline", () => {
  it("matches each Python ML worker by its script path", () => {
    const python = "/home/dev/photrix/server/.venv/bin/python";
    expect(
      isWorkerCmdline(`${python} /home/dev/photrix/server/python/whisper_worker.py`),
    ).toBe(true);
    expect(
      isWorkerCmdline(`${python} /home/dev/photrix/server/python/clap_worker.py`),
    ).toBe(true);
    expect(
      isWorkerCmdline(
        `${python} /home/dev/photrix/server/python/image_analysis_worker.py CUDAExecutionProvider cuda`,
      ),
    ).toBe(true);
  });

  it("does not match unrelated processes", () => {
    expect(isWorkerCmdline("/usr/bin/node src/main.ts")).toBe(false);
    expect(isWorkerCmdline("/usr/bin/python3 /usr/bin/networkd-dispatcher")).toBe(false);
    expect(
      isWorkerCmdline(
        "python -c from multiprocessing.resource_tracker import main;main(18)",
      ),
    ).toBe(false);
  });
});
