import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { config } from "../config/config.ts";
import { exportEnvDefaults } from "../config/childEnv.ts";

let telemetrySdk: NodeSDK | undefined;
let telemetryStartPromise: Promise<void> | null = null;
let telemetryStopPromise: Promise<void> | null = null;

const isTelemetryEnabled = () => config().telemetry.enabled;

const getTracesEndpoint = () => config().telemetry.tracesEndpoint;

// The OpenTelemetry SDK reads these itself; an operator's own values win.
const configureTelemetryEnvironment = () => {
  exportEnvDefaults({
    OTEL_SERVICE_NAME: "photrix-server",
    OTEL_RESOURCE_ATTRIBUTES: `service.namespace=photrix,deployment.environment=${config().server.nodeEnv}`,
  });
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

  telemetryStartPromise = Promise.resolve(telemetrySdk.start()).catch((error) => {
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
