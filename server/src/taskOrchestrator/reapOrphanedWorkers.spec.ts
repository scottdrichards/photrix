import { describe, expect, it } from "@jest/globals";
import { isOwnedByLiveServer, isWorkerCmdline, parseParentPid } from "./reapOrphanedWorkers.ts";

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

describe("parseParentPid", () => {
  it("reads the ppid after the command name", () => {
    expect(parseParentPid("4242 (python) S 4100 4242 4100 0 -1 4194560")).toBe(4100);
  });

  it("is not fooled by spaces or parentheses in the command name", () => {
    expect(parseParentPid("4242 (pt_main (thread) x) S 77 4242 77 0")).toBe(77);
  });

  it("returns null for unparseable input", () => {
    expect(parseParentPid("")).toBeNull();
    expect(parseParentPid("4242 (python)")).toBeNull();
  });
});

describe("isOwnedByLiveServer", () => {
  it("treats a worker whose parent is Node as belonging to a running server", () => {
    expect(isOwnedByLiveServer("/usr/bin/node --max-old-space-size=1024 dist/server/src/main.js")).toBe(true);
    expect(isOwnedByLiveServer("node dist/server/src/main.js")).toBe(true);
  });

  it("treats a worker re-parented to init or a subreaper as an orphan", () => {
    expect(isOwnedByLiveServer("/sbin/init")).toBe(false);
    expect(isOwnedByLiveServer("/lib/systemd/systemd --user")).toBe(false);
    expect(isOwnedByLiveServer(null)).toBe(false);
  });

  it("does not treat a shell or another program as a server", () => {
    expect(isOwnedByLiveServer("bash -c something")).toBe(false);
    expect(isOwnedByLiveServer("/usr/bin/nodemon src/main.ts")).toBe(false);
  });
});
