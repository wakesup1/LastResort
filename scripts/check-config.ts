import nextEnv from "@next/env";
import { readConfig, ConfigError } from "../src/server/config.ts";

nextEnv.loadEnvConfig(process.cwd());
try {
  readConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "Configuration check failed.");
  process.exitCode = 1;
}
