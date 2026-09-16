import type { Bridge } from "./matter/bridge.js";
import type { SolarmanApi } from "./solarman/api.js";
import {
  measurementsOf,
  readMeasurements,
  type Measurement,
  type Quantity,
  type Readings,
} from "./solarman/measurements.js";
import { loadEnabled, saveEnabled } from "./state.js";

export type DeviceView = {
  id: string;
  name: string;
  productName: string;
  online: boolean;
  /** Empty when the device reports no production. */
  quantities: Quantity[];
  enabled: boolean;
  readings: Readings;
};

type Entry = {
  /** Device serial number. It identifies the device in every Solarman call. */
  sn: string;
  stationName: string;
  deviceType: string;
  online: boolean;
  measurements: Measurement[];
  readings: Readings;
};

/** The device type that reports the production of a plant. */
const INVERTER = "INVERTER";

/** Tracks the Solarman inverters and which of them are bridged to Matter. */
export class Devices {
  #entries = new Map<string, Entry>();
  #enabled = new Set<string>();

  constructor(
    private readonly api: SolarmanApi,
    private readonly bridge: Bridge,
    private readonly stateFile: string,
  ) {}

  /** Loads the device list and bridges the devices enabled in an earlier run. */
  async load(): Promise<void> {
    await this.refresh();
    this.#enabled = await loadEnabled(this.stateFile);
    for (const id of this.#enabled) {
      await this.#addToBridge(id);
    }
  }

  /** Reloads the plants and the readings every new inverter offers. */
  async refresh(): Promise<void> {
    const entries = new Map<string, Entry>();

    for (const station of await this.api.stations()) {
      for (const device of await this.api.devices(station.id, INVERTER)) {
        const known = this.#entries.get(device.deviceSn);
        entries.set(device.deviceSn, {
          sn: device.deviceSn,
          stationName: station.name,
          deviceType: device.deviceType,
          online: device.connectStatus === 1,
          measurements:
            known?.measurements ??
            measurementsOf(await this.api.currentData(device.deviceSn)),
          readings: known?.readings ?? {},
        });
      }
    }

    this.#entries = entries;
    await this.#dropMissing();
  }

  list(): DeviceView[] {
    return [...this.#entries.values()]
      .map((entry) => ({
        id: entry.sn,
        name: entry.stationName,
        productName: `${entry.deviceType} ${entry.sn}`,
        online: entry.online,
        quantities: entry.measurements.map(({ quantity }) => quantity),
        enabled: this.#enabled.has(entry.sn),
        readings: entry.readings,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) {
      throw new Error(`unknown device ${id}`);
    }
    if (enabled && entry.measurements.length === 0) {
      throw new Error(`device ${entry.sn} reports no production`);
    }
    if (enabled === this.#enabled.has(id)) {
      return;
    }

    if (enabled) {
      this.#enabled.add(id);
      await this.#addToBridge(id);
      // Publish the real values at once. The next poll can be minutes away.
      await this.#read(id);
    } else {
      this.#enabled.delete(id);
      await this.bridge.removeDevice(id);
    }

    await saveEnabled(this.stateFile, this.#enabled);
  }

  /** Reads the enabled devices and pushes the values into Matter. */
  async poll(): Promise<void> {
    for (const id of this.#enabled) {
      await this.#read(id);
    }
  }

  async #read(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) {
      return;
    }
    try {
      entry.readings = readMeasurements(
        entry.measurements,
        await this.api.currentData(entry.sn),
      );
      entry.online = true;
      await this.bridge.updateDevice(id, {
        reachable: true,
        readings: entry.readings,
      });
    } catch (error) {
      console.error(`failed to read ${entry.sn}:`, error);
      entry.online = false;
      await this.bridge.updateDevice(id, { reachable: false, readings: {} });
    }
  }

  /** Unbridges devices that disappeared from the Solarman account. */
  async #dropMissing(): Promise<void> {
    const missing = [...this.#enabled].filter((id) => !this.#entries.has(id));
    if (missing.length === 0) {
      return;
    }
    for (const id of missing) {
      this.#enabled.delete(id);
      await this.bridge.removeDevice(id);
    }
    await saveEnabled(this.stateFile, this.#enabled);
  }

  async #addToBridge(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry || entry.measurements.length === 0) {
      return;
    }
    await this.bridge.addDevice({
      id,
      name: entry.stationName,
      productName: `${entry.deviceType} ${entry.sn}`,
      reachable: entry.online,
      measurements: entry.measurements,
    });
  }
}
