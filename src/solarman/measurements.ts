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

/**
 * What to publish for an inverter that is not answering.
 *
 * Everything measured at this instant falls to zero, because an inverter
 * whose logger is dark is generating nothing. Leaving the last watts in place
 * would be worse than saying nothing: a controller that adds power up over
 * time turns them into a whole night of production that never happened.
 *
 * The lifetime total is not measured at an instant, so it stays. A total that
 * dropped to zero every evening would read as a meter that had been replaced.
 */
export function idle(last?: Readings): Partial<Readings> {
  return {
    power: 0,
    voltage: 0,
    current: 0,
    frequency: 0,
    ...(last === undefined ? {} : { energy: last.energy }),
  };
}
