import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeRead,
  decodeTelemetry,
  encodeRead,
  parseLoggerSerial,
} from "./local.js";

const SERIAL = 2754182292;

function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

/** Wraps a Modbus RTU response the way the logger does. */
function v5Reply(rtu: Buffer, sequence: number, serial = SERIAL): Buffer {
  const frame = Buffer.alloc(25 + rtu.length + 2);
  frame[0] = 0xa5;
  frame.writeUInt16LE(frame.length - 13, 1);
  frame.writeUInt16LE(0x1510, 3);
  frame[5] = sequence;
  frame.writeUInt32LE(serial, 7);
  frame[11] = 2;
  frame[12] = 1;
  frame.writeUInt32LE(1_700_000_000, 13);
  frame.writeUInt32LE(8654, 17);
  frame.writeUInt32LE(0, 21);
  rtu.copy(frame, 25);
  frame[frame.length - 2] =
    frame.subarray(1, -2).reduce((sum, byte) => sum + byte, 0) & 0xff;
  frame[frame.length - 1] = 0x15;
  return frame;
}

function rtuRead(registers: Buffer): Buffer {
  const body = Buffer.concat([
    Buffer.from([1, 3, registers.length]),
    registers,
  ]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(body));
  return Buffer.concat([body, crc]);
}

/** Registers 59..112, holding the values this plant really reported. */
function telemetry(values: Partial<Record<number, number>> = {}): Buffer {
  const registers = Buffer.alloc(54 * 2);
  const put = (address: number, value: number) =>
    registers.writeUInt16BE(value, (address - 59) * 2);
  put(59, 2);
  put(60, 162);
  // A 32-bit counter, low word first.
  put(63, 278771 % 65536);
  put(64, Math.floor(278771 / 65536));
  put(73, 2339);
  put(76, 248);
  put(79, 5995);
  put(80, 56752 % 65536);
  put(81, Math.floor(56752 / 65536));
  put(109, 1084);
  put(110, 110);
  put(111, 2149);
  put(112, 220);
  for (const [address, value] of Object.entries(values)) {
    put(Number(address), value!);
  }
  return registers;
}

test("asks only for holding registers and never for a write", () => {
  const frame = encodeRead(SERIAL, 59, 54, 7);
  assert.equal(frame[0], 0xa5);
  assert.equal(frame.at(-1), 0x15);
  assert.equal(frame[27], 3);
  assert.equal(frame.readUInt32LE(7), SERIAL);
  assert.equal(frame.readUInt16BE(28), 59);
  assert.equal(frame.readUInt16BE(30), 54);
});

test("refuses a register range the protocol cannot carry", () => {
  const ranges: [number, number][] = [
    [-1, 1],
    [0, 0],
    [0, 126],
    [65535, 2],
    [0.5, 1],
  ];
  for (const [start, count] of ranges) {
    assert.throws(
      () => encodeRead(SERIAL, start, count, 1),
      /invalid holding-register range/,
    );
  }
});

test("reads back a reply and its logger uptime", () => {
  const registers = telemetry();
  const decoded = decodeRead(v5Reply(rtuRead(registers), 7), SERIAL, 54, 7);
  assert.deepEqual(decoded.registers, registers);
  assert.equal(decoded.loggerUptimeSeconds, 8654);
});

test("tolerates the two padding bytes this logger adds after the CRC", () => {
  const reply = v5Reply(
    Buffer.concat([rtuRead(telemetry()), Buffer.from([0, 0])]),
    7,
  );
  assert.equal(decodeRead(reply, SERIAL, 54, 7).registers.length, 54 * 2);
});

test("rejects a reply from another logger, sequence, or checksum", () => {
  const rtu = rtuRead(telemetry());
  assert.throws(
    () => decodeRead(v5Reply(rtu, 7, 1234), SERIAL, 54, 7),
    /unexpected V5 logger serial/,
  );
  assert.throws(
    () => decodeRead(v5Reply(rtu, 8), SERIAL, 54, 7),
    /unexpected V5 length, sequence, control code, or status/,
  );
  const corrupted = v5Reply(rtu, 7);
  corrupted[30] = corrupted[30]! ^ 0xff;
  assert.throws(
    () => decodeRead(corrupted, SERIAL, 54, 7),
    /invalid V5 checksum/,
  );
});

test("reports a Modbus exception instead of decoding it as data", () => {
  const body = Buffer.from([1, 0x83, 2]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(body));
  assert.throws(
    () => decodeRead(v5Reply(Buffer.concat([body, crc]), 7), SERIAL, 54, 7),
    /Modbus read exception 2/,
  );
});

test("scales the registers into the units the inverter reports", () => {
  assert.deepEqual(decodeTelemetry(telemetry(), 8654, 1_700_000_000_000), {
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
  });
});

test("reads a current flowing backwards as a negative one", () => {
  // Register 76 is signed, so 0xFFF6 is -1.0 A and not 6553.0 A.
  assert.equal(decodeTelemetry(telemetry({ 76: 0xfff6 })).acCurrentA[0], -1);
});

test("keeps a temperature only when a sensor reports one", () => {
  assert.equal(decodeTelemetry(telemetry({ 90: 1728 })).radiatorC, 72.8);
  // An absent sensor reads 0, which is -100 C, and is not a measurement.
  assert.equal(decodeTelemetry(telemetry()).radiatorC, undefined);
});

test("refuses a register block that is not the telemetry block", () => {
  assert.throws(
    () => decodeTelemetry(Buffer.alloc(10)),
    /expected holding registers 59\.\.112/,
  );
});

test("finds the logger serial on its status page", () => {
  assert.equal(parseLoggerSerial('var cover_mid = "2754182292";'), 2754182292);
  assert.throws(
    () => parseLoggerSerial("<html></html>"),
    /logger status page has no serial/,
  );
});
