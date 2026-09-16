import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Devices } from "./devices.js";
import type { Bridge } from "./matter/bridge.js";
import type {
  SolarmanApi,
  SolarmanDataPoint,
  SolarmanDevice,
  SolarmanStation,
} from "./solarman/api.js";

const INVERTER_DATA: SolarmanDataPoint[] = [
  { key: "APo_t1", name: "Total AC Output Power", value: "1174", unit: "W" },
  { key: "Et_ge0", name: "Production Total", value: "18932.4", unit: "kWh" },
];

const LOGGER_DATA: SolarmanDataPoint[] = [
  { key: "ST_PG1", name: "Running status", value: "Normal", unit: null },
];

function inverter(sn: string): SolarmanDevice {
  return {
    deviceSn: sn,
    deviceId: 1,
    deviceType: "INVERTER",
    connectStatus: 1,
  };
}

function fakeApi(
  stations: SolarmanStation[],
  devices: Record<number, SolarmanDevice[]>,
  data: Record<string, SolarmanDataPoint[]>,
) {
  const reads: string[] = [];
  return {
    stations: async () => stations,
    devices: async (stationId: number) => devices[stationId] ?? [],
    currentData: async (sn: string) => {
      reads.push(sn);
      return data[sn] ?? [];
    },
    reads,
  } as unknown as SolarmanApi & { reads: string[] };
}

function fakeBridge() {
  const bridged = new Set<string>();
  const updates: unknown[] = [];
  const bridge = {
    addDevice: async ({ id }: { id: string }) => void bridged.add(id),
    removeDevice: async (id: string) => void bridged.delete(id),
    updateDevice: async (_id: string, state: unknown) =>
      void updates.push(state),
  } as unknown as Bridge;
  return { bridge, bridged, updates };
}

async function stateFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "solarman-matter-")), "devices.json");
}

function plant() {
  return fakeApi([{ id: 7, name: "Home" }], { 7: [inverter("SN1")] }, {
    SN1: INVERTER_DATA,
  });
}

test("bridges an inverter only after the user enables it", async () => {
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(plant(), bridge, await stateFile());

  await devices.load();
  assert.deepEqual([...bridged], []);
  assert.deepEqual(devices.list(), [
    {
      id: "SN1",
      name: "Home",
      productName: "INVERTER SN1",
      online: true,
      quantities: ["power", "energy"],
      enabled: false,
      readings: {},
    },
  ]);

  await devices.setEnabled("SN1", true);
  assert.deepEqual([...bridged], ["SN1"]);

  await devices.setEnabled("SN1", false);
  assert.deepEqual([...bridged], []);
});

test("refuses to expose a device that reports no production", async () => {
  const { bridge } = fakeBridge();
  const api = fakeApi([{ id: 7, name: "Home" }], { 7: [inverter("SN1")] }, {
    SN1: LOGGER_DATA,
  });
  const devices = new Devices(api, bridge, await stateFile());
  await devices.load();

  await assert.rejects(devices.setEnabled("SN1", true), /no production/);
  await assert.rejects(devices.setEnabled("nope", true), /unknown device/);
});

test("publishes the production as soon as a plant is exposed", async () => {
  const { bridge, updates } = fakeBridge();
  const devices = new Devices(plant(), bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("SN1", true);

  assert.deepEqual(updates, [
    {
      reachable: true,
      readings: { power: 1_174_000, energy: 18_932_400_000 },
    },
  ]);
});

test("keeps the last readings of the enabled plants", async () => {
  const { bridge } = fakeBridge();
  const devices = new Devices(plant(), bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("SN1", true);
  await devices.poll();

  assert.deepEqual(devices.list()[0]?.readings, {
    power: 1_174_000,
    energy: 18_932_400_000,
  });
});

test("reads only the enabled plants", async () => {
  const api = fakeApi(
    [{ id: 7, name: "Home" }],
    { 7: [inverter("SN1"), inverter("SN2")] },
    { SN1: INVERTER_DATA, SN2: INVERTER_DATA },
  );
  const devices = new Devices(api, fakeBridge().bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("SN1", true);
  api.reads.length = 0;
  await devices.poll();

  assert.deepEqual(api.reads, ["SN1"]);
});

test("marks a plant unreachable when the cloud read fails", async () => {
  const { bridge, updates } = fakeBridge();
  const api = plant();
  const devices = new Devices(api, bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("SN1", true);

  api.currentData = async () => {
    throw new Error("appId insufficient allowance");
  };
  await devices.poll();

  assert.deepEqual(updates.at(-1), { reachable: false, readings: {} });
  assert.equal(devices.list()[0]?.online, false);
});

test("restores the selection of an earlier run", async () => {
  const file = await stateFile();
  const api = plant();

  const first = fakeBridge();
  const devices = new Devices(api, first.bridge, file);
  await devices.load();
  await devices.setEnabled("SN1", true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["SN1"]);

  const second = fakeBridge();
  await new Devices(api, second.bridge, file).load();
  assert.deepEqual([...second.bridged], ["SN1"]);
});

test("unbridges a plant that left the Solarman account", async () => {
  const file = await stateFile();
  const present = [inverter("SN1")];
  const { bridge, bridged } = fakeBridge();
  const api = fakeApi([{ id: 7, name: "Home" }], { 7: present }, {
    SN1: INVERTER_DATA,
  });
  const devices = new Devices(api, bridge, file);

  await devices.load();
  await devices.setEnabled("SN1", true);
  assert.deepEqual([...bridged], ["SN1"]);

  present.length = 0;
  await devices.refresh();

  assert.deepEqual([...bridged], []);
  assert.deepEqual(devices.list(), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
});
