import type { LoggerReading } from "./local.js";

/**
 * Matter reports electricity in milli-units: mW, mWh, mV, mA and mHz. The
 * logger reports watts, kilowatt hours, volts, amps and hertz.
 */
export type Quantity = "power" | "energy" | "voltage" | "current" | "frequency";

export type Readings = Record<Quantity, number>;

/**
 * Every inverter behind a Solarman logger answers the same register block, so
 * the set of readings is fixed and never has to be discovered the way a cloud
 * key set does.
 */
export const QUANTITIES: Quantity[] = [
  "power",
  "energy",
  "voltage",
  "current",
  "frequency",
];

/**
 * Converts a logger reading into Matter milli-units.
 *
 * Only the first phase is published. The register block holds three, and a
 * single-phase inverter reports zero for the other two, which Matter cannot
 * tell apart from a real zero.
 */
export function toReadings(reading: LoggerReading): Readings {
  return {
    power: Math.round(reading.watts * 1e3),
    energy: Math.round(reading.totalKwh * 1e6),
    voltage: Math.round((reading.acVoltageV[0] ?? 0) * 1e3),
    current: Math.round((reading.acCurrentA[0] ?? 0) * 1e3),
    frequency: Math.round(reading.frequencyHz * 1e3),
  };
}
