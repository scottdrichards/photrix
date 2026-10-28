// node --test scripts/  (bun run --filter server test:scripts)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ORT_PACKAGES,
  PROFILES,
  checkReport,
  chooseProfile,
  parseComputeCap,
  planInstall,
} from "./python-env.mjs";

const facts = (overrides = {}) => ({
  platform: "linux",
  arch: "x64",
  nvidiaComputeCap: null,
  hasRocm: false,
  ...overrides,
});

describe("chooseProfile", () => {
  it("picks the CUDA build by compute capability", () => {
    assert.equal(chooseProfile(facts({ nvidiaComputeCap: 6.1 })), "cuda-legacy");
    assert.equal(chooseProfile(facts({ nvidiaComputeCap: 7.0 })), "cuda-legacy");
    assert.equal(chooseProfile(facts({ nvidiaComputeCap: 7.5 })), "cuda");
    assert.equal(chooseProfile(facts({ nvidiaComputeCap: 8.9 })), "cuda");
  });

  it("prefers NVIDIA over everything else on the same box", () => {
    assert.equal(
      chooseProfile(facts({ platform: "win32", nvidiaComputeCap: 8.6 })),
      "cuda",
    );
    assert.equal(chooseProfile(facts({ nvidiaComputeCap: 8.6, hasRocm: true })), "cuda");
  });

  it("covers the other platforms", () => {
    assert.equal(chooseProfile(facts({ platform: "darwin", arch: "arm64" })), "mac");
    assert.equal(chooseProfile(facts({ platform: "darwin", arch: "x64" })), "cpu");
    assert.equal(chooseProfile(facts({ hasRocm: true })), "rocm");
    assert.equal(chooseProfile(facts({ platform: "win32" })), "directml");
    assert.equal(chooseProfile(facts()), "cpu");
  });

  it("never picks a profile that doesn't exist", () => {
    for (const f of [
      facts(),
      facts({ nvidiaComputeCap: 6.1 }),
      facts({ nvidiaComputeCap: 9 }),
      facts({ platform: "darwin", arch: "arm64" }),
      facts({ hasRocm: true }),
      facts({ platform: "win32" }),
    ]) {
      assert.ok(PROFILES[chooseProfile(f)]);
    }
  });
});

describe("parseComputeCap", () => {
  it("reads the first GPU", () => {
    assert.equal(parseComputeCap("6.1\n8.9\n"), 6.1);
    assert.equal(parseComputeCap("8.6\r\n"), 8.6);
  });
  it("is null for anything else", () => {
    assert.equal(parseComputeCap(""), null);
    assert.equal(parseComputeCap("[N/A]"), null);
    assert.equal(parseComputeCap(undefined), null);
  });
});

describe("planInstall", () => {
  it("keeps the Pascal pins that work on a Quadro P520", () => {
    const flat = planInstall("cuda-legacy").map((s) => s.join(" "));
    assert.match(flat[0], /pip install -r .*requirements\.txt$/);
    assert.ok(flat.some((s) => s.includes("torch==2.9.1+cu126")));
    assert.ok(flat.some((s) => s.includes("torchvision==0.24.1+cu126")));
    assert.ok(flat.some((s) => s.includes("--extra-index-url https://download.pytorch.org/whl/cu126")));
    assert.ok(flat.at(-1).includes("onnxruntime-gpu==1.26.0"));
    assert.ok(flat.at(-1).includes("nvidia-cudnn-cu12==9.10.2.21"));
  });

  it("always leaves exactly one onnxruntime package, installed last", () => {
    for (const name of Object.keys(PROFILES)) {
      const steps = planInstall(name);
      const uninstall = steps.at(-2);
      assert.deepEqual(uninstall.slice(0, 4), ["-m", "pip", "uninstall", "-y"]);
      assert.deepEqual(uninstall.slice(4), ORT_PACKAGES);
      const installed = steps.at(-1)[3];
      assert.ok(
        ORT_PACKAGES.some((p) => installed.startsWith(`${p}==`)),
        `${name} installs ${installed}`,
      );
    }
  });

  it("pins torch to the profile's own build, never an unpinned latest", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const torchStep = planInstall(name).find((s) => s.some((a) => a.startsWith("torch==")));
      if (!profile.torchIndex) {
        assert.equal(torchStep, undefined, name);
        continue;
      }
      assert.ok(torchStep.includes(`torch==2.9.1+${profile.torchIndex}`), name);
    }
  });

  it("rejects an unknown profile", () => {
    assert.throws(() => planInstall("cuda121"), /unknown profile/);
  });
});

describe("checkReport", () => {
  const report = (device, provider, extra = {}) => ({
    torch: { device, rejected: {}, error: null, ...extra },
    ort: { provider, error: null },
  });

  it("passes when the probe matches the profile", () => {
    assert.deepEqual(
      checkReport("cuda-legacy", report("cuda", "CUDAExecutionProvider")),
      [],
    );
  });

  it("explains a GPU that installed but didn't verify", () => {
    const problems = checkReport(
      "cuda",
      report("cpu", "CUDAExecutionProvider", {
        rejected: { cuda: "RuntimeError: no kernel image is available" },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /torch is on cpu, expected cuda \(RuntimeError: no kernel image/);
  });

  it("flags the face provider separately", () => {
    const problems = checkReport("directml", report("cpu", "CPUExecutionProvider"));
    assert.deepEqual(problems, [
      "face models get CPUExecutionProvider, expected DmlExecutionProvider",
    ]);
  });
});
