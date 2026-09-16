import assert from "node:assert/strict";
import { test } from "node:test";

import type { SolarmanDataPoint } from "./api.js";
import { measurementsOf, readMeasurements } from "./measurements.js";

function point(
  key: string,
  value: string,
  unit?: string | null,
): SolarmanDataPoint {
  return { key, name: key, value, unit };
}

// Data points of a string inverter behind a Solarman logger.
const INVERTER = [
  point("APo_t1", "1174", "W"),
  point("AV1", "227.4", "V"),
  point("AC1", "5.16", "A"),
  point("A_Fo1", "59.98", "Hz"),
  point("Et_ge0", "18932.4", "kWh"),
  point("Etdy_ge0", "12.7", "kWh"),
  point("Et_ge1", "9466.2", "kWh"),
  point("DV1", "412.6", "V"),
  point("INV_T0", "41.2", "℃"),
  point("ST_PG1", "Normal", null),
];

test("maps inverter data points to Matter milli-units", () => {
  const measurements = measurementsOf(INVERTER);

  assert.deepEqual(readMeasurements(measurements, INVERTER), {
    power: 1_174_000,
    energy: 18_932_400_000,
    voltage: 227_400,
    current: 5_160,
    frequency: 59_980,
  });
});

test("reads the total production, not a single string or the day", () => {
  assert.deepEqual(
    measurementsOf(INVERTER).find(({ quantity }) => quantity === "energy"),
    { quantity: "energy", key: "Et_ge0", factor: 1e6 },
  );
});

test("reads the total output power of a hybrid inverter", () => {
  const hybrid = [point("INV_O_P_T", "2.4", "kW"), point("Et_ge0", "10", "kWh")];

  assert.deepEqual(readMeasurements(measurementsOf(hybrid), hybrid), {
    power: 2_400_000,
    energy: 10_000_000,
  });
});

test("skips a point whose unit is unknown or missing", () => {
  const odd = [
    point("APo_t1", "1000", "W"),
    point("AV1", "227", null),
    point("AC1", "5", "kA"),
  ];

  assert.deepEqual(measurementsOf(odd).map(({ quantity }) => quantity), [
    "power",
  ]);
});

test("ignores a device that reports no production, such as a logger", () => {
  assert.deepEqual(
    measurementsOf([point("AV1", "227", "V"), point("ST_PG1", "Normal", null)]),
    [],
  );
});

test("ignores a value that is not a number", () => {
  const measurements = measurementsOf(INVERTER);
  const readings = readMeasurements(measurements, [
    point("APo_t1", "1000", "W"),
    point("Et_ge0", "--", "kWh"),
  ]);

  assert.deepEqual(readings, { power: 1_000_000 });
});
