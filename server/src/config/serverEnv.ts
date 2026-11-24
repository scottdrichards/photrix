// main.ts imports this first: it loads server/.env, then validates the whole
// configuration before any other module reads it, exiting with every problem
// listed if something is wrong.
import "dotenv/config";
import { initConfig } from "./config.ts";

initConfig("server");
