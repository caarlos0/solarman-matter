import { loadConfig } from "./config.js";
import { Inverters } from "./inverters.js";
import { Bridge } from "./matter/bridge.js";
import { SolarmanLocal } from "./solarman/local.js";
import { startWeb } from "./web.js";

// Kept inside a function: the released binary is CommonJS, which has no
// top-level await.
async function main() {
  const config = loadConfig();

  const bridge = new Bridge(config.matter);
  await bridge.start();

  const inverters = new Inverters(
    config.hosts.map(
      (host) => new SolarmanLocal(host, config.user, config.password),
    ),
    bridge,
    config.stateFile,
  );
  await inverters.load();
  await inverters.poll();

  await startWeb(config.webPort, inverters, bridge);
  console.log(`Bridge status at http://localhost:${config.webPort}`);

  const timer = setInterval(() => void inverters.poll(), config.pollIntervalMs);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      void bridge.stop().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
