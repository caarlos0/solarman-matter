import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Inverters, type Logger } from "./inverters.js";
import type { Bridge } from "./matter/bridge.js";
import { LoggerUnreachable, type LoggerReading } from "./solarman/local.js";

const READING: LoggerReading = {
  at: 1_700_000_000_000,
  watts: 5675.2,
  totalKwh: 27877.1,
  dailyKwh: 16.2,
  inverterStatusCode: 2,
  frequencyHz: 59.95,
  acVoltageV: [233.9, 0, 0],
  acCurrentA: [24.8, 0, 0],
  dcVoltageV: [108.4, 214.9],
  dcCurrentA: [11, 22],
  dcPowerW: [1192.4, 4727.8],
  loggerUptimeSeconds: 8654,
};

const MILLI = {
  power: 5_675_200,
  energy: 27_877_100_000,
  voltage: 233_900,
  current: 24_800,
  frequency: 59_950,
};

const SERIAL = "2302226555";

/** A logger under test. `answer` decides what the next read does. */
function fakeLogger(host: string, serial = SERIAL) {
  const logger = {
    host,
    answer: async (): Promise<LoggerReading> => READING,
    serialCalls: 0,
    read: () => logger.answer(),
    inverterSerial: async () => {
      logger.serialCalls++;
      return serial;
    },
  };
  return logger as Logger & typeof logger;
}

function asleep(host: string) {
  const logger = fakeLogger(host);
  logger.answer = async () => {
    throw new LoggerUnreachable(host, "no connection");
  };
  return logger;
}

function fakeBridge() {
  const added: string[] = [];
  const updates: { id: string; reachable: boolean; readings?: unknown }[] = [];
  const bridge = {
    addDevice: async ({ id }: { id: string }) => void added.push(id),
    removeDevice: async () => {},
    updateDevice: async (
      id: string,
      state: { reachable: boolean; readings?: unknown },
    ) => void updates.push({ id, ...state }),
  } as unknown as Bridge;
  return { bridge, added, updates };
}

async function stateFile(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "solarman-matter-")),
    "inverters.json",
  );
}

test("bridges every configured inverter, with no picking", async () => {
  const { bridge, added, updates } = fakeBridge();
  const inverters = new Inverters(
    [fakeLogger("10.0.0.1")],
    bridge,
    await stateFile(),
  );

  await inverters.load();
  await inverters.poll();

  assert.deepEqual(added, [SERIAL]);
  assert.deepEqual(updates, [
    { id: SERIAL, reachable: true, readings: MILLI },
  ]);
});

test("reports the reading in Matter milli-units", async () => {
  const inverters = new Inverters(
    [fakeLogger("10.0.0.1")],
    fakeBridge().bridge,
    await stateFile(),
  );

  await inverters.load();
  await inverters.poll();

  assert.deepEqual(inverters.list(), [
    {
      host: "10.0.0.1",
      serial: SERIAL,
      reachable: true,
      readings: MILLI,
      todayKwh: 16.2,
      lastSeen: READING.at,
      error: undefined,
    },
  ]);
});

test("remembers the serial so a start after dark still bridges", async () => {
  const file = await stateFile();

  const day = new Inverters([fakeLogger("10.0.0.1")], fakeBridge().bridge, file);
  await day.load();
  await day.poll();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    "10.0.0.1": SERIAL,
  });

  // The logger is powered by the inverter, so at night it answers nothing at
  // all. The endpoint still has to exist, or the controller loses the device.
  const night = fakeBridge();
  const bridged = new Inverters([asleep("10.0.0.1")], night.bridge, file);
  await bridged.load();
  await bridged.poll();

  assert.deepEqual(night.added, [SERIAL]);
  assert.deepEqual(night.updates, [
    { id: SERIAL, reachable: false, readings: undefined },
  ]);
});

test("asks for the serial only once", async () => {
  const logger = fakeLogger("10.0.0.1");
  const inverters = new Inverters(
    [logger],
    fakeBridge().bridge,
    await stateFile(),
  );

  await inverters.load();
  await inverters.poll();
  await inverters.poll();

  assert.equal(logger.serialCalls, 1);
});

test("keeps the last readings while the logger sleeps", async () => {
  const logger = fakeLogger("10.0.0.1");
  const { bridge, updates } = fakeBridge();
  const inverters = new Inverters([logger], bridge, await stateFile());

  await inverters.load();
  await inverters.poll();

  logger.answer = async () => {
    throw new LoggerUnreachable("10.0.0.1", "no connection");
  };
  await inverters.poll();

  const view = inverters.list()[0]!;
  assert.equal(view.reachable, false);
  // A night is not a fault, so nothing is reported as broken.
  assert.equal(view.error, undefined);
  assert.deepEqual(view.readings, MILLI);
  // Matter is told the device is unreachable, and the values are left alone.
  assert.deepEqual(updates.at(-1), {
    id: SERIAL,
    reachable: false,
    readings: undefined,
  });
});

test("shows a fault that is not simply a sleeping logger", async () => {
  const logger = fakeLogger("10.0.0.1");
  const inverters = new Inverters(
    [logger],
    fakeBridge().bridge,
    await stateFile(),
  );
  await inverters.load();

  logger.answer = async () => {
    throw new Error("invalid Modbus response length or CRC");
  };
  await inverters.poll();

  assert.match(inverters.list()[0]!.error!, /invalid Modbus response/);
});

test("writes down the serial of every inverter, not just the last", async () => {
  const file = await stateFile();
  const inverters = new Inverters(
    [fakeLogger("10.0.0.1", "SN-A"), fakeLogger("10.0.0.2", "SN-B")],
    fakeBridge().bridge,
    file,
  );

  await inverters.load();
  await inverters.poll();

  // They are read at the same time. A read and write of the file inside each
  // of them would keep only whichever finished last.
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    "10.0.0.1": "SN-A",
    "10.0.0.2": "SN-B",
  });
});

test("keeps a good reading when only the serial fails", async () => {
  const logger = fakeLogger("10.0.0.1");
  logger.inverterSerial = async () => {
    throw new LoggerUnreachable("10.0.0.1", "connection closed");
  };
  const inverters = new Inverters(
    [logger],
    fakeBridge().bridge,
    await stateFile(),
  );

  await inverters.load();
  await inverters.poll();

  const view = inverters.list()[0]!;
  // The logger answered the telemetry, so it is plainly awake.
  assert.equal(view.reachable, true);
  assert.deepEqual(view.readings, MILLI);
  assert.equal(view.serial, undefined);
  assert.match(view.error!, /connection closed/);
});

test("keeps one inverter answering when another does not", async () => {
  const { bridge, added } = fakeBridge();
  const inverters = new Inverters(
    [fakeLogger("10.0.0.1", "SN-A"), asleep("10.0.0.2")],
    bridge,
    await stateFile(),
  );

  await inverters.load();
  await inverters.poll();

  assert.deepEqual(added, ["SN-A"]);
  assert.deepEqual(
    inverters.list().map(({ host, reachable }) => ({ host, reachable })),
    [
      { host: "10.0.0.1", reachable: true },
      { host: "10.0.0.2", reachable: false },
    ],
  );
});

test("holds an inverter back until its serial is known", async () => {
  const { bridge, added, updates } = fakeBridge();
  const inverters = new Inverters(
    [asleep("10.0.0.1")],
    bridge,
    await stateFile(),
  );

  await inverters.load();
  await inverters.poll();

  // Nothing can be published yet: the serial is the identity, and only the
  // logger knows it.
  assert.deepEqual(added, []);
  assert.deepEqual(updates, []);
  assert.deepEqual(inverters.list(), [
    { host: "10.0.0.1", reachable: false, serial: undefined, error: undefined },
  ]);
});
