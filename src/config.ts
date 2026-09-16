import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  endpoint: string;
  appId: string;
  appSecret: string;
  email: string;
  password: string;
  orgId?: number;
  pollIntervalMs: number;
  stateFile: string;
  webPort: number;
  matter: {
    passcode: number;
    discriminator: number;
    port: number;
  };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`environment variable ${name} is not a number: ${raw}`);
  }
  return value;
}

/**
 * Every setting is prefixed. Bare names such as `APP_ID` collide with other
 * tools, and a real environment variable silently wins over the `.env` file.
 */
export function loadConfig(): Config {
  const orgId = process.env.SOLARMAN_ORG_ID?.trim();

  return {
    // Solarman keeps two data centers. The account decides which one answers.
    endpoint:
      process.env.SOLARMAN_ENDPOINT?.trim() ||
      "https://globalapi.solarmanpv.com",
    appId: required("SOLARMAN_APP_ID"),
    appSecret: required("SOLARMAN_APP_SECRET"),
    email: required("SOLARMAN_EMAIL"),
    password: required("SOLARMAN_PASSWORD"),
    orgId: orgId ? optionalNumber("SOLARMAN_ORG_ID", 0) : undefined,
    // The cloud refreshes about every five minutes, and each read spends part
    // of the call allowance of the app, so a fast poll only wastes it.
    pollIntervalMs: optionalNumber("SOLARMAN_POLL_INTERVAL", 300) * 1000,
    stateFile:
      process.env.SOLARMAN_STATE_FILE?.trim() ||
      join(
        process.env.MATTER_STORAGE_PATH?.trim() || join(homedir(), ".matter"),
        "solarman-matter-devices.json",
      ),
    webPort: optionalNumber("SOLARMAN_WEB_PORT", 8080),
    matter: {
      passcode: optionalNumber("MATTER_PASSCODE", 20202021),
      discriminator: optionalNumber("MATTER_DISCRIMINATOR", 3840),
      port: optionalNumber("MATTER_PORT", 5540),
    },
  };
}
