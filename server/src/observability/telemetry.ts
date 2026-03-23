import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

let telemetrySdk: NodeSDK | undefined;
let telemetryStartPromise: Promise<void> | null = null;
let telemetryStopPromise: Promise<void> | null = null;

const isTelemetryEnabled = () =>
  process.env.PHOTRIX_OTEL_ENABLED?.trim().toLowerCase() === "true";

const getTracesEndpoint = () =>
  process.env.PHOTRIX_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
  "http://127.0.0.1:4318/v1/traces";

const configureTelemetryEnvironment = () => {
  process.env.OTEL_SERVICE_NAME ??= "photrix-server";
  process.env.OTEL_RESOURCE_ATTRIBUTES ??=
    `service.namespace=photrix,deployment.environment=${process.env.NODE_ENV ?? "development"}`;
};

export const startTelemetry = async (): Promise<void> => {
  if (!isTelemetryEnabled()) {
    return;
  }

  if (telemetryStartPromise) {
    return await telemetryStartPromise;
  }

  configureTelemetryEnvironment();

  telemetrySdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: getTracesEndpoint(),
    }),
  });

  telemetryStartPromise = Promise.resolve(telemetrySdk.start())
    .then(() => {
      console.log(`[telemetry] OpenTelemetry enabled -> ${getTracesEndpoint()}`);
    })
    .catch((error) => {
      telemetryStartPromise = null;
      telemetrySdk = undefined;
      throw error;
    });

  return await telemetryStartPromise;
};

export const stopTelemetry = async (): Promise<void> => {
  if (!telemetrySdk) {
    return;
  }

  if (telemetryStopPromise) {
    return await telemetryStopPromise;
  }

  telemetryStopPromise = Promise.resolve(telemetrySdk.shutdown()).finally(() => {
    telemetrySdk = undefined;
    telemetryStartPromise = null;
    telemetryStopPromise = null;
  });

  return await telemetryStopPromise;
};