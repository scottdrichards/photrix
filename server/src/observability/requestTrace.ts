import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  context as otelContext,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

type TraceCategory = "request" | "db" | "file" | "conversion" | "other";

type RequestTraceMeta = {
  method: string;
  url: string;
  requestId?: string;
};

type RequestSpan = {
  name: string;
  category: TraceCategory;
  detail?: string;
  depth: number;
  durationMs: number;
};

type RequestTraceContext = {
  requestId: string;
  method: string;
  url: string;
  startMs: number;
  depth: number;
  rootSpan: Span;
  spanStack: Span[];
  spans: RequestSpan[];
};

type MeasureOperationOptions = {
  category?: TraceCategory;
  detail?: string;
  logWithoutRequest?: boolean;
};

const requestTraceStorage = new AsyncLocalStorage<RequestTraceContext>();

const getTracer = () => trace.getTracer("photrix-server");

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;

const parsePositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const formatDuration = (durationMs: number): string => `${durationMs.toFixed(1)}ms`;

const getSpanLogThresholdMs = (): number =>
  parsePositiveNumber(process.env.PHOTRIX_TRACE_SPAN_MIN_MS, 25);

const getSummarySpanLimit = (): number =>
  Math.max(1, Math.floor(parsePositiveNumber(process.env.PHOTRIX_TRACE_TOP_SPANS, 8)));

const summarizeByCategory = (spans: RequestSpan[]) => {
  const totals: Record<TraceCategory, number> = {
    request: 0,
    db: 0,
    file: 0,
    conversion: 0,
    other: 0,
  };

  for (const span of spans) {
    totals[span.category] += span.durationMs;
  }

  return totals;
};

export const getCurrentRequestId = (): string | undefined =>
  requestTraceStorage.getStore()?.requestId;

export const setCurrentSpanAttributes = (attributes: Attributes): void => {
  const currentSpan = trace.getSpan(otelContext.active());
  if (!currentSpan) {
    return;
  }

  currentSpan.setAttributes(attributes);
};

export const addCurrentSpanEvent = (name: string, attributes?: Attributes): void => {
  const currentSpan = trace.getSpan(otelContext.active());
  if (!currentSpan) {
    return;
  }

  currentSpan.addEvent(name, attributes);
};

export const bindCurrentRequestTrace = <TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
): ((...args: TArgs) => void) => {
  const context = requestTraceStorage.getStore();
  if (!context) {
    return fn;
  }

  return (...args: TArgs) => {
    requestTraceStorage.run(context, () => {
      fn(...args);
    });
  };
};

export const runWithRequestTrace = async <T>(
  meta: RequestTraceMeta,
  fn: () => Promise<T>,
): Promise<T> => {
  const requestId = meta.requestId?.trim() || randomUUID().slice(0, 8);
  const rootSpan = getTracer().startSpan(
    "http.request",
    {
      attributes: {
        "http.request.method": meta.method,
        "url.path": meta.url,
        "photrix.request_id": requestId,
      },
    },
    ROOT_CONTEXT,
  );
  const context: RequestTraceContext = {
    requestId,
    method: meta.method,
    url: meta.url,
    startMs: nowMs(),
    depth: 0,
    rootSpan,
    spanStack: [rootSpan],
    spans: [],
  };

  return await requestTraceStorage.run(context, async () =>
    await otelContext.with(trace.setSpan(otelContext.active(), rootSpan), async () => {
      console.log(`[request ${requestId}] -> ${meta.method} ${meta.url}`);
      return await fn();
    }),
  );
};

export const finishRequestTrace = (statusCode: number): void => {
  const context = requestTraceStorage.getStore();
  if (!context) {
    return;
  }

  const totalDuration = nowMs() - context.startMs;
  const categoryTotals = summarizeByCategory(context.spans);
  const topSpans = [...context.spans]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, getSummarySpanLimit())
    .map(
      (span) =>
        `${span.category}:${span.name}${span.detail ? `(${span.detail})` : ""}=${formatDuration(span.durationMs)}`,
    );

  const categorySummary = [
    `db=${formatDuration(categoryTotals.db)}`,
    `file=${formatDuration(categoryTotals.file)}`,
    `conversion=${formatDuration(categoryTotals.conversion)}`,
    `other=${formatDuration(categoryTotals.other)}`,
  ].join(" ");

  const topSummary = topSpans.length > 0 ? ` | top: ${topSpans.join(", ")}` : "";

  context.rootSpan.setAttributes({
    "http.response.status_code": statusCode,
    "photrix.request.total_ms": totalDuration,
    "photrix.request.category.db_ms": categoryTotals.db,
    "photrix.request.category.file_ms": categoryTotals.file,
    "photrix.request.category.conversion_ms": categoryTotals.conversion,
    "photrix.request.category.other_ms": categoryTotals.other,
  });
  context.rootSpan.setStatus({
    code: statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
  context.rootSpan.end();

  console.log(
    `[request ${context.requestId}] <- ${context.method} ${context.url} ${statusCode} ${formatDuration(totalDuration)} | ${categorySummary}${topSummary}`,
  );
};

export const measureOperation = async <T>(
  name: string,
  fn: () => T | Promise<T>,
  options: MeasureOperationOptions = {},
): Promise<T> => {
  const {
    category = "other",
    detail,
    logWithoutRequest = false,
  } = options;
  const context = requestTraceStorage.getStore();
  const depth = context?.depth ?? 0;

  if (context) {
    context.depth += 1;
  }

  const startMs = nowMs();
  const parentSpan = context?.spanStack.at(-1);
  const parentContext = parentSpan
    ? trace.setSpan(otelContext.active(), parentSpan)
    : ROOT_CONTEXT;
  const span = getTracer().startSpan(
    name,
    {
      attributes: {
        "photrix.category": category,
        ...(detail ? { "photrix.detail": detail } : {}),
        ...(context ? { "photrix.request_id": context.requestId } : { "photrix.standalone": true }),
      },
    },
    parentContext,
  );

  if (context) {
    context.spanStack.push(span);
  }

  const recordDuration = (durationMs: number) => {
    span.setAttribute("photrix.duration_ms", durationMs);

    if (context) {
      context.depth = Math.max(context.depth - 1, 0);
      context.spans.push({
        name,
        category,
        detail,
        depth,
        durationMs,
      });

      if (durationMs >= getSpanLogThresholdMs()) {
        const indentation = "  ".repeat(Math.min(depth, 5));
        const suffix = detail ? ` (${detail})` : "";
        console.log(
          `[trace ${context.requestId}] ${indentation}${category}:${name}${suffix} ${formatDuration(durationMs)}`,
        );
      }
    }

    if (logWithoutRequest && durationMs >= getSpanLogThresholdMs()) {
      const suffix = detail ? ` (${detail})` : "";
      console.log(`[trace standalone] ${category}:${name}${suffix} ${formatDuration(durationMs)}`);
    }
  };

  try {
    const result = (await otelContext.with(
      trace.setSpan(parentContext, span),
      async () => await Promise.resolve(fn()),
    )) as T;
    recordDuration(nowMs() - startMs);
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    recordDuration(nowMs() - startMs);
    throw error;
  } finally {
    if (context) {
      context.spanStack.pop();
    }
    span.end();
  }
};

export const measureSyncOperation = <T>(
  name: string,
  fn: () => T,
  options: MeasureOperationOptions = {},
): T => {
  const {
    category = "other",
    detail,
    logWithoutRequest = false,
  } = options;
  const context = requestTraceStorage.getStore();
  const depth = context?.depth ?? 0;

  if (context) {
    context.depth += 1;
  }

  const startMs = nowMs();
  const parentSpan = context?.spanStack.at(-1);
  const parentContext = parentSpan
    ? trace.setSpan(otelContext.active(), parentSpan)
    : ROOT_CONTEXT;
  const span = getTracer().startSpan(
    name,
    {
      attributes: {
        "photrix.category": category,
        ...(detail ? { "photrix.detail": detail } : {}),
        ...(context ? { "photrix.request_id": context.requestId } : { "photrix.standalone": true }),
      },
    },
    parentContext,
  );

  if (context) {
    context.spanStack.push(span);
  }

  const recordDuration = (durationMs: number) => {
    span.setAttribute("photrix.duration_ms", durationMs);

    if (context) {
      context.depth = Math.max(context.depth - 1, 0);
      context.spans.push({
        name,
        category,
        detail,
        depth,
        durationMs,
      });

      if (durationMs >= getSpanLogThresholdMs()) {
        const indentation = "  ".repeat(Math.min(depth, 5));
        const suffix = detail ? ` (${detail})` : "";
        console.log(
          `[trace ${context.requestId}] ${indentation}${category}:${name}${suffix} ${formatDuration(durationMs)}`,
        );
      }
    }

    if (logWithoutRequest && durationMs >= getSpanLogThresholdMs()) {
      const suffix = detail ? ` (${detail})` : "";
      console.log(`[trace standalone] ${category}:${name}${suffix} ${formatDuration(durationMs)}`);
    }
  };

  try {
    const result = otelContext.with(trace.setSpan(parentContext, span), fn);
    recordDuration(nowMs() - startMs);
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    recordDuration(nowMs() - startMs);
    throw error;
  } finally {
    if (context) {
      context.spanStack.pop();
    }
    span.end();
  }
};
