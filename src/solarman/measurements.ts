import type { SolarmanDataPoint } from "./api.js";

/**
 * Matter reports electricity in milli-units: mW, mWh, mV, mA and mHz. Every
 * Solarman data point is scaled into one of them.
 */
export type Quantity = "power" | "energy" | "voltage" | "current" | "frequency";

export type Measurement = {
  quantity: Quantity;
  /** Solarman data point key, e.g. `APo_t1`. */
  key: string;
  /** Multiplier from the Solarman value to the Matter milli-unit. */
  factor: number;
};

export type Readings = Partial<Record<Quantity, number>>;

/**
 * Keys are matched exactly, because the trailing digit is meaningful: `Et_ge0`
 * is the total production, while `Et_ge1` and `Et_ge2` are the totals of the
 * single PV strings. The first key that the device reports wins.
 */
const KEYS: Record<Quantity, string[]> = {
  // `APo_t1` on string inverters, `INV_O_P_T` on hybrids.
  power: ["APo_t1", "INV_O_P_T"],
  // Lifetime production only. `Etdy_ge0` is the production of today, which
  // resets each night and cannot feed a cumulative Matter attribute.
  energy: ["Et_ge0"],
  voltage: ["AV1"],
  current: ["AC1"],
  frequency: ["A_Fo1", "AC_Fo1"],
};

/**
 * Mega prefixes are left out on purpose. Lowercased, `MWh` and `mWh` are the
 * same text but differ by a factor of a thousand million, so a plant that
 * reports megawatts gets no reading instead of a wrong one.
 */
const UNITS: Record<Quantity, Record<string, number>> = {
  power: { w: 1e3, kw: 1e6 },
  energy: { wh: 1e3, kwh: 1e6 },
  voltage: { v: 1e3, kv: 1e6 },
  current: { a: 1e3 },
  frequency: { hz: 1e3 },
};

function unitFactor(quantity: Quantity, unit: string): number | undefined {
  // Solarman writes units as "W", "kWh", "kW·h"; normalise before the lookup.
  return UNITS[quantity][unit.toLowerCase().replace(/[^a-z]/g, "")];
}

/**
 * Selects the readings a device offers over Matter. Returns an empty list for
 * devices that report no production, such as a data logger.
 */
export function measurementsOf(points: SolarmanDataPoint[]): Measurement[] {
  const byKey = new Map(points.map((point) => [point.key, point]));
  const measurements: Measurement[] = [];

  for (const [quantity, keys] of Object.entries(KEYS) as [
    Quantity,
    string[],
  ][]) {
    for (const key of keys) {
      const unit = byKey.get(key)?.unit;
      const factor = unit ? unitFactor(quantity, unit) : undefined;
      if (factor !== undefined) {
        measurements.push({ quantity, key, factor });
        break;
      }
    }
  }

  // Voltage, current or frequency alone does not describe a producing plant.
  const produces = measurements.some(
    ({ quantity }) => quantity === "power" || quantity === "energy",
  );
  return produces ? measurements : [];
}

/** Converts Solarman data points into Matter milli-units. */
export function readMeasurements(
  measurements: Measurement[],
  points: SolarmanDataPoint[],
): Readings {
  const byKey = new Map(points.map(({ key, value }) => [key, value]));
  const readings: Readings = {};

  for (const { quantity, key, factor } of measurements) {
    // Every value arrives as text, and some points hold a status word.
    const value = Number(byKey.get(key));
    if (Number.isFinite(value)) {
      readings[quantity] = Math.round(value * factor);
    }
  }

  return readings;
}
