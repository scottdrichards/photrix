import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  context as otelContext,
  trace,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import {
  bindCurrentRequestTrace,
  finishRequestTrace,
  getCurrentRequestId,
  measureOperation,
  runWithRequestTrace,
} from "./requestTrace.ts";

const createSpanRecorder = () => {
  const calls: Array<{ name: string; context: Context | undefined }> = [];
  const fakeTracer: Pick<Tracer, "startSpan"> = {
    startSpan: (name, _options, context) => {
      calls.push({ name, context });
      return trace.wrapSpanContext({
        traceId: "11111111111111111111111111111111",
        spanId: `${(calls.length + 1).toString(16).padStart(16, "0")}`,
        traceFlags: 1,
      });
    },
  };

  jest.spyOn(trace, "getTracer").mockReturnValue(fakeTracer as Tracer);

  return { calls };
};

describe("requestTrace", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps request id available inside nested operations", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    let nestedRequestId: string | undefined;

    await runWithRequestTrace(
      {
        method: "GET",
        url: "/api/health",
        requestId: "trace-test-id",
      },
      async () => {
        const value = await measureOperation(
          "nested-operation",
          async () => {
            nestedRequestId = getCurrentRequestId();
            return 42;
          },
          { category: "db", detail: "unit-test" },
        );

        expect(value).toBe(42);
        finishRequestTrace(200);
      },
    );

    expect(nestedRequestId).toBe("trace-test-id");
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("binds callbacks to the active request trace context", async () => {
    let callbackRequestId: string | undefined;

    await runWithRequestTrace(
      {
        method: "GET",
        url: "/api/health",
        requestId: "trace-bind-id",
      },
      async () => {
        const callback = bindCurrentRequestTrace(() => {
          callbackRequestId = getCurrentRequestId();
        });

        await Promise.resolve().then(() => {
          callback();
        });
      },
    );

    expect(callbackRequestId).toBe("trace-bind-id");
  });

  it("starts request traces from the root context", async () => {
    const { calls } = createSpanRecorder();
    const parentSpan = trace.wrapSpanContext({
      traceId: "22222222222222222222222222222222",
      spanId: "3333333333333333",
      traceFlags: 1,
    });

    await otelContext.with(trace.setSpan(otelContext.active(), parentSpan), async () => {
      await runWithRequestTrace(
        {
          method: "GET",
          url: "/api/health",
          requestId: "root-trace-id",
        },
        async () => {
          finishRequestTrace(200);
        },
      );
    });

    const requestCall = calls.find(({ name }) => name === "GET /api/health");
    expect(requestCall).toBeDefined();
    expect(trace.getSpan(requestCall?.context ?? otelContext.active())).toBeUndefined();
  });

  it("uses method and pathname for request root span names", async () => {
    const { calls } = createSpanRecorder();

    await runWithRequestTrace(
      {
        method: "GET",
        url: "/api/files/?page=0&pageSize=10",
        requestId: "name-trace-id",
      },
      async () => {
        finishRequestTrace(200);
      },
    );

    const requestCall = calls.find(({ name }) => name === "GET /api/files/");
    expect(requestCall).toBeDefined();
  });

  it("starts standalone operations from the root context", async () => {
    const { calls } = createSpanRecorder();
    const parentSpan = trace.wrapSpanContext({
      traceId: "44444444444444444444444444444444",
      spanId: "5555555555555555",
      traceFlags: 1,
    });

    await otelContext.with(trace.setSpan(otelContext.active(), parentSpan), async () => {
      await measureOperation("standalone-operation", async () => 42, { category: "other" });
    });

    const standaloneCall = calls.find(({ name }) => name === "standalone-operation");
    expect(standaloneCall).toBeDefined();
    expect(trace.getSpan(standaloneCall?.context ?? otelContext.active())).toBeUndefined();
  });
});