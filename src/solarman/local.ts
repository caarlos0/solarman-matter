import { createConnection } from "node:net";

/**
 * Reads the inverter through the data logger on the local network.
 *
 * The logger speaks Solarman V5 on port 8899, which wraps Modbus RTU:
 * https://pysolarmanv5.readthedocs.io/en/stable/solarmanv5_protocol.html
 * The register map follows the Deye string profile:
 * https://github.com/davidrapan/ha-solarman
 *
 * Only Modbus function 3, read holding registers, is ever sent. Nothing here
 * can change a setting on the logger or the inverter.
 */
const V5_PORT = 8899;
const TIMEOUT_MS = 8000;
/**
 * How long to wait to find out whether the logger is there at all.
 *
 * On the same network it answers at once or not at all: its status page took
 * 60 ms awake, while a host that is not there took over seven seconds to give
 * up on its own. Deciding in two keeps a night from being spent blocked.
 */
const REACH_MS = 2000;
/** The telemetry block, both ends inclusive. */
const FIRST_REGISTER = 59;
const REGISTER_COUNT = 54;

/**
 * The logger could not be reached at all.
 *
 * It is powered by the inverter, which is powered by the sun, so it is gone
 * every night. That is not a fault, and the caller has to be able to tell it
 * apart from a logger that answers with nonsense.
 */
export class LoggerUnreachable extends Error {
  constructor(host: string, reason: string) {
    super(`solar logger at ${host} did not answer: ${reason}`);
    this.name = "LoggerUnreachable";
  }
}

export type LoggerReading = {
  at: number;
  watts: number;
  totalKwh: number;
  dailyKwh: number;
  inverterStatusCode: number;
  frequencyHz: number;
  acVoltageV: number[];
  acCurrentA: number[];
  dcVoltageV: number[];
  dcCurrentA: number[];
  dcPowerW: number[];
  /** Radiator temperature in Celsius. Absent when no sensor reports. */
  radiatorC?: number;
  loggerUptimeSeconds: number;
};

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

function checksum(data: Uint8Array): number {
  return data.reduce((sum, byte) => sum + byte, 0) & 0xff;
}

export function encodeRead(
  loggerSerial: number,
  start: number,
  count: number,
  sequence: number,
): Buffer {
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 125 ||
    start + count > 65536
  ) {
    throw new Error("invalid holding-register range");
  }
  const frame = Buffer.alloc(36);
  frame[0] = 0xa5;
  frame.writeUInt16LE(23, 1);
  frame.writeUInt16LE(0x4510, 3);
  frame[5] = sequence;
  frame.writeUInt32LE(loggerSerial, 7);
  frame[11] = 2;
  frame[26] = 1;
  frame[27] = 3; // Read holding registers. Never a write function.
  frame.writeUInt16BE(start, 28);
  frame.writeUInt16BE(count, 30);
  frame.writeUInt16LE(crc16(frame.subarray(26, 32)), 32);
  frame[34] = checksum(frame.subarray(1, 34));
  frame[35] = 0x15;
  return frame;
}

function validateFrame(frame: Buffer, loggerSerial: number): void {
  if (
    frame.length < 13 ||
    frame[0] !== 0xa5 ||
    frame.at(-1) !== 0x15 ||
    frame.length !== frame.readUInt16LE(1) + 13
  ) {
    throw new Error("invalid V5 frame length or delimiters");
  }
  if (frame.at(-2) !== checksum(frame.subarray(1, -2))) {
    throw new Error("invalid V5 checksum");
  }
  if (frame.readUInt32LE(7) !== loggerSerial) {
    throw new Error("unexpected V5 logger serial");
  }
}

export function decodeRead(
  frame: Buffer,
  loggerSerial: number,
  count: number,
  sequence: number,
): { registers: Buffer; loggerUptimeSeconds: number } {
  validateFrame(frame, loggerSerial);
  if (
    frame.length < 32 ||
    frame[5] !== sequence ||
    frame.readUInt16LE(3) !== 0x1510 ||
    frame[11] !== 2 ||
    frame[12] !== 1
  ) {
    throw new Error("unexpected V5 length, sequence, control code, or status");
  }

  let rtu = frame.subarray(25, -2);
  const expectedLength = rtu[1] === 0x83 ? 5 : count * 2 + 5;
  // This logger appends 0000 after the real CRC. Drop it, then check the CRC.
  if (rtu.length === expectedLength + 2 && rtu.readUInt16LE(rtu.length - 2) === 0) {
    rtu = rtu.subarray(0, -2);
  }
  if (
    rtu.length !== expectedLength ||
    crc16(rtu.subarray(0, -2)) !== rtu.readUInt16LE(rtu.length - 2)
  ) {
    throw new Error("invalid Modbus response length or CRC");
  }
  if (rtu[0] !== 1) {
    throw new Error("unexpected Modbus slave");
  }
  if (rtu[1] === 0x83) {
    throw new Error(`Modbus read exception ${rtu[2]}`);
  }
  if (rtu[1] !== 3 || rtu[2] !== count * 2) {
    throw new Error("unexpected Modbus function or byte count");
  }

  return {
    registers: rtu.subarray(3, -2),
    loggerUptimeSeconds: frame.readUInt32LE(17),
  };
}

export function decodeTelemetry(
  registers: Buffer,
  loggerUptimeSeconds = 0,
  at = Date.now(),
): LoggerReading {
  if (registers.length !== REGISTER_COUNT * 2) {
    throw new Error(
      `expected holding registers ${FIRST_REGISTER}..${FIRST_REGISTER + REGISTER_COUNT - 1}`,
    );
  }
  const u16 = (address: number) => registers.readUInt16BE((address - FIRST_REGISTER) * 2);
  const i16 = (address: number) => registers.readInt16BE((address - FIRST_REGISTER) * 2);
  // Modbus is big-endian, but these 32-bit values put the low word first.
  const u32 = (address: number) => u16(address) + u16(address + 1) * 65536;
  // Temperatures carry a 1000 offset. A sensor that is not fitted reads 0,
  // which is -100 C, and is not a measurement.
  const celsius = (address: number) => {
    const value = (u16(address) - 1000) / 10;
    return value <= -100 ? undefined : value;
  };
  const radiatorC = celsius(90);

  return {
    at,
    watts: u32(80) / 10,
    totalKwh: u32(63) / 10,
    dailyKwh: u16(60) / 10,
    inverterStatusCode: u16(59),
    frequencyHz: u16(79) / 100,
    acVoltageV: [73, 74, 75].map((address) => u16(address) / 10),
    acCurrentA: [76, 77, 78].map((address) => i16(address) / 10),
    dcVoltageV: [u16(109) / 10, u16(111) / 10],
    dcCurrentA: [u16(110) / 10, u16(112) / 10],
    dcPowerW: [(u16(109) * u16(110)) / 100, (u16(111) * u16(112)) / 100],
    ...(radiatorC === undefined ? {} : { radiatorC }),
    loggerUptimeSeconds,
  };
}

/** Pulls the logger serial out of its status page, so only the host is configured. */
export function parseLoggerSerial(html: string): number {
  const serial = /var\s+cover_mid\s*=\s*"(\d+)"/.exec(html)?.[1];
  if (!serial) {
    throw new Error("logger status page has no serial");
  }
  return Number(serial);
}

export class SolarmanLocal {
  #serial?: number;
  #inverterSerial?: string;
  #sequence = Math.floor(Math.random() * 256);

  constructor(
    readonly host: string,
    private readonly user = "admin",
    private readonly password = "admin",
    private readonly port = V5_PORT,
  ) {}

  /**
   * Asks the logger for its own serial, which every V5 frame has to carry.
   *
   * The serial is on the sticker, but reading it keeps the configuration to
   * one address, and a replaced logger then needs no edit.
   */
  async serial(): Promise<number> {
    if (this.#serial !== undefined) {
      return this.#serial;
    }
    const authorization = Buffer.from(`${this.user}:${this.password}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(`http://${this.host}/status.html`, {
        headers: { authorization: `Basic ${authorization}` },
        signal: AbortSignal.timeout(REACH_MS),
      });
    } catch (error) {
      // Nothing answered. A logger that is awake but refuses the login
      // replies with a status code, and is handled below.
      throw new LoggerUnreachable(this.host, (error as Error).message);
    }
    if (!response.ok) {
      throw new Error(`logger status page: HTTP ${response.status}`);
    }
    this.#serial = parseLoggerSerial(await response.text());
    return this.#serial;
  }

  async read(): Promise<LoggerReading> {
    const serial = await this.serial();
    const { registers, loggerUptimeSeconds } = await this.#registers(
      serial,
      FIRST_REGISTER,
      REGISTER_COUNT,
    );
    return decodeTelemetry(registers, loggerUptimeSeconds);
  }

  /** The inverter serial, from the identity block, to match against the cloud. */
  async inverterSerial(): Promise<string> {
    if (this.#inverterSerial !== undefined) {
      return this.#inverterSerial;
    }
    const { registers } = await this.#registers(await this.serial(), 0, 19);
    this.#inverterSerial = registers.subarray(6, 16).toString("ascii").trim();
    return this.#inverterSerial;
  }

  async #registers(
    serial: number,
    start: number,
    count: number,
  ): Promise<{ registers: Buffer; loggerUptimeSeconds: number }> {
    this.#sequence = (this.#sequence + 1) & 0xff;
    const sequence = this.#sequence;
    const request = encodeRead(serial, start, count, sequence);
    const socket = createConnection({ host: this.host, port: this.port });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;

    try {
      return await new Promise((resolve, reject) => {
        let pending = Buffer.alloc(0);
        const unreachable = (reason: string) =>
          reject(new LoggerUnreachable(this.host, reason));

        timer = setTimeout(() => unreachable("no connection"), REACH_MS);
        socket.once("connect", () => {
          connected = true;
          clearTimeout(timer);
          timer = setTimeout(
            () => reject(new Error(`V5 read ${start}..${start + count - 1} timed out`)),
            TIMEOUT_MS,
          );
          socket.write(request);
        });
        socket.once("error", (error) =>
          connected ? reject(error) : unreachable((error as Error).message),
        );
        socket.once("close", () =>
          connected
            ? reject(new Error("V5 connection closed before response"))
            : unreachable("connection closed"),
        );
        socket.on("data", (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          try {
            while (pending.length >= 3) {
              const length = pending.readUInt16LE(1) + 13;
              if (pending.length < length) {
                return;
              }
              const frame = pending.subarray(0, length);
              pending = pending.subarray(length);
              // The logger sends unsolicited heartbeats. They are not answered,
              // because an answer would be a write.
              if (frame.readUInt16LE(3) === 0x4710) {
                continue;
              }
              resolve(decodeRead(frame, serial, count, sequence));
              return;
            }
          } catch (error) {
            reject(error);
          }
        });
      });
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
}
