import { loadConfig } from "./config.js";
import { Devices } from "./devices.js";
import { Bridge } from "./matter/bridge.js";
import { SolarmanApi } from "./solarman/api.js";
import { startWeb } from "./web.js";

// Kept inside a function: the released binary is CommonJS, which has no
// top-level await.
async function main() {
  const config = loadConfig();
  const api = new SolarmanApi(
    config.endpoint,
    config.appId,
    config.appSecret,
    config.email,
    config.password,
    config.orgId,
  );
  await api.login();

  const bridge = new Bridge(config.matter);
  await bridge.start();

  const devices = new Devices(api, bridge, config.stateFile);
  await devices.load();
  await devices.poll();

  await startWeb(config.webPort, devices, bridge);
  console.log(`Choose the plants to expose at http://localhost:${config.webPort}`);

  const timer = setInterval(() => void devices.poll(), config.pollIntervalMs);

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
