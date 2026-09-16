import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ElectricalEnergyMeasurementServer } from "@matter/main/behaviors/electrical-energy-measurement";
import { ElectricalPowerMeasurementServer } from "@matter/main/behaviors/electrical-power-measurement";
import { PowerTopologyServer } from "@matter/main/behaviors/power-topology";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { SolarPowerDevice } from "@matter/main/devices/solar-power";
import { ElectricalSensorEndpoint } from "@matter/main/endpoints/electrical-sensor";
import { MeasurementType } from "@matter/main/types";

import type {
  Measurement,
  Quantity,
  Readings,
} from "../solarman/measurements.js";

const MEASUREMENT_TYPES: Record<Quantity, MeasurementType> = {
  power: MeasurementType.ActivePower,
  energy: MeasurementType.ElectricalEnergy,
  voltage: MeasurementType.Voltage,
  current: MeasurementType.ActiveCurrent,
  frequency: MeasurementType.Frequency,
};

/** Matter allows at most 32 characters per string attribute. */
const LABEL_LENGTH = 32;

const VENDOR_NAME = "Solarman";

/**
 * A plant produces energy, so it reports the exported side of the meter. The
 * imported side is what a consumer such as a plug would report.
 */
const MeterEndpoint = ElectricalSensorEndpoint.with(
  PowerTopologyServer.with("NodeTopology"),
  ElectricalPowerMeasurementServer.with("AlternatingCurrent"),
  ElectricalEnergyMeasurementServer.with("ExportedEnergy", "CumulativeEnergy"),
);

/**
 * The Solar Power device type owns no cluster of its own. The specification
 * expects the meter as an Electrical Sensor on a child endpoint.
 */
const PlantEndpoint = SolarPowerDevice.with(
  BridgedDeviceBasicInformationServer,
);

export type DeviceInfo = {
  id: string;
  name: string;
  productName: string;
  reachable: boolean;
  measurements: Measurement[];
};

export type DeviceState = {
  reachable: boolean;
  readings: Readings;
};

/**
 * A Solarman inverter exposed as a bridged Matter solar power device, with its
 * meter as a composed electrical sensor endpoint.
 */
export class DeviceEndpoint {
  readonly #meter: Endpoint<typeof MeterEndpoint>;
  readonly root: Endpoint<typeof PlantEndpoint>;

  constructor(info: DeviceInfo) {
    this.#meter = new Endpoint(MeterEndpoint, {
      id: "meter",
      ...meterDefaults(info.measurements),
    });

    this.root = new Endpoint(PlantEndpoint, {
      id: endpointId(info.id),
      bridgedDeviceBasicInformation: {
        nodeLabel: info.name.slice(0, LABEL_LENGTH),
        vendorName: VENDOR_NAME,
        productName: info.productName.slice(0, LABEL_LENGTH),
        serialNumber: info.id.slice(0, LABEL_LENGTH),
        reachable: info.reachable,
      },
      parts: [this.#meter],
    });
  }

  async update({ reachable, readings }: DeviceState): Promise<void> {
    await this.root.set({ bridgedDeviceBasicInformation: { reachable } });
    await this.#meter.set(measurements(readings));
  }
}

function measurements(readings: Readings) {
  return {
    electricalPowerMeasurement: {
      activePower: readings.power ?? null,
      voltage: readings.voltage ?? null,
      activeCurrent: readings.current ?? null,
      frequency: readings.frequency ?? null,
    },
    electricalEnergyMeasurement: {
      cumulativeEnergyExported:
        readings.energy === undefined ? null : { energy: readings.energy },
    },
  };
}

function meterDefaults(measurements: Measurement[]) {
  const powerAccuracy = measurements
    .filter(({ quantity }) => quantity !== "energy")
    .map(({ quantity }) => accuracyOf(quantity));

  return {
    electricalPowerMeasurement: {
      powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
      numberOfMeasurementTypes: powerAccuracy.length,
      accuracy: powerAccuracy,
      activePower: null,
      voltage: null,
      activeCurrent: null,
      frequency: null,
    },
    electricalEnergyMeasurement: {
      accuracy: accuracyOf("energy"),
      cumulativeEnergyExported: null,
    },
  };
}

/**
 * Matter requires an accuracy entry per measurement type. Solarman publishes
 * no accuracy, so every range is declared as exact.
 */
function accuracyOf(quantity: Quantity) {
  return {
    measurementType: MEASUREMENT_TYPES[quantity],
    measured: true,
    minMeasuredValue: 0,
    maxMeasuredValue: Number.MAX_SAFE_INTEGER,
    accuracyRanges: [
      { rangeMin: 0, rangeMax: Number.MAX_SAFE_INTEGER, fixedMax: 1 },
    ],
  };
}

/** Matter endpoint ids allow only letters, digits, `_` and `-`. */
function endpointId(deviceId: string): string {
  return `solarman-${deviceId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}
