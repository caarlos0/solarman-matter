import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  hosts: string[];
  user: string;
  password: string;
  pollIntervalMs: number;
  stateFile: string;
  webPort: number;
  matter: {
    passcode: number;
    discriminator: number;
    port: number;
  };
};

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
 * The addresses of the data loggers, one per inverter.
 *
 * A mistyped address only ever looks like a logger that is asleep, so an
 * empty list is refused outright rather than starting a bridge with nothing
 * behind it.
 */
function loadHosts(): string[] {
  const hosts = (process.env.SOLARMAN_LOCAL_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  if (hosts.length === 0) {
    throw new Error(
      "missing required environment variable SOLARMAN_LOCAL_HOSTS",
    );
  }
  return [...new Set(hosts)];
}

/**
 * Every setting is prefixed. Bare names such as `LOCAL_HOSTS` collide with
 * other tools, and a real environment variable silently wins over the `.env`
 * file.
 */
export function loadConfig(): Config {
  return {
    hosts: loadHosts(),
    // These loggers ship with admin/admin and are rarely changed.
    user: process.env.SOLARMAN_LOCAL_USER?.trim() || "admin",
    password: process.env.SOLARMAN_LOCAL_PASSWORD?.trim() || "admin",
    // The inverter refreshes every few seconds, and a read costs nothing but
    // a packet on the local network.
    pollIntervalMs: optionalNumber("SOLARMAN_POLL_INTERVAL", 30) * 1000,
    stateFile:
      process.env.SOLARMAN_STATE_FILE?.trim() ||
      join(
        process.env.MATTER_STORAGE_PATH?.trim() || join(homedir(), ".matter"),
        "solarman-matter-inverters.json",
      ),
    webPort: optionalNumber("SOLARMAN_WEB_PORT", 8080),
    matter: {
      passcode: optionalNumber("MATTER_PASSCODE", 20202021),
      discriminator: optionalNumber("MATTER_DISCRIMINATOR", 3840),
      port: optionalNumber("MATTER_PORT", 5540),
    },
  };
}
