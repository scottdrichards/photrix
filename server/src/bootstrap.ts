import "dotenv/config";
import { startTelemetry, stopTelemetry } from "./observability/telemetry.ts";

let shutdownRegistered = false;

const registerShutdownHandlers = () => {
  if (shutdownRegistered) {
    return;
  }

  shutdownRegistered = true;

  const shutdown = (signal: NodeJS.Signals) => {
    void stopTelemetry()
      .catch((error) => {
        console.error(`[telemetry] Failed to stop after ${signal}`, error);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

const bootstrap = async () => {
  await startTelemetry();
  registerShutdownHandlers();
  await import("./main.ts");
};

bootstrap().catch((error) => {
  console.error("[bootstrap] Failed to initialize telemetry", error);
  process.exit(1);
});