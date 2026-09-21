import assert from "node:assert/strict";
import { test } from "node:test";

import { idle } from "../solarman/measurements.js";
import { measurements } from "./device-endpoint.js";

const READINGS = {
  power: 5_675_200,
  energy: 27_877_100_000,
  voltage: 233_900,
  current: 24_800,
  frequency: 59_950,
};

test("publishes a reading on the exported side of the meter", () => {
  assert.deepEqual(measurements(READINGS), {
    electricalPowerMeasurement: {
      activePower: 5_675_200,
      voltage: 233_900,
      activeCurrent: 24_800,
      frequency: 59_950,
    },
    electricalEnergyMeasurement: {
      // A plant produces, so the total is exported, never imported.
      cumulativeEnergyExported: { energy: 27_877_100_000 },
    },
  });
});

test("publishes zero for everything measured at this instant when idle", () => {
  const asleep = measurements(idle(READINGS));

  assert.deepEqual(asleep.electricalPowerMeasurement, {
    activePower: 0,
    voltage: 0,
    activeCurrent: 0,
    frequency: 0,
  });
});

test("keeps the lifetime total when idle", () => {
  assert.deepEqual(
    measurements(idle(READINGS)).electricalEnergyMeasurement,
    { cumulativeEnergyExported: { energy: 27_877_100_000 } },
  );
});

test("leaves the total alone when it was never read", () => {
  const cold = measurements(idle(undefined));

  // Matter's set() skips a cluster that is absent, so a total already
  // published survives a poll that never got one. Writing null would erase it.
  assert.ok(!("electricalEnergyMeasurement" in cold));
  assert.equal(cold.electricalPowerMeasurement.activePower, 0);
});
