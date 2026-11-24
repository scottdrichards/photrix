// `bun run --filter server env:example`: regenerates server/.env.example.
import { writeFileSync } from "node:fs";
import { renderEnvExample } from "./envExample.ts";

writeFileSync(new URL("../../.env.example", import.meta.url), renderEnvExample());
