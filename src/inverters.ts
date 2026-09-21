import type { Bridge } from "./matter/bridge.js";
import { LoggerUnreachable, type LoggerReading } from "./solarman/local.js";
import { idle, toReadings, type Readings } from "./solarman/measurements.js";
import { loadSerials, saveSerials } from "./state.js";

/** What this bridge needs of a data logger on the local network. */
export type Logger = {
  readonly host: string;
  read(): Promise<LoggerReading>;
  inverterSerial(): Promise<string>;
};

export type InverterView = {
  host: string;
  serial?: string;
  /** False while the logger sleeps, which it does every night. */
  reachable: boolean;
  readings?: Readings;
  todayKwh?: number;
  /** Milliseconds since the epoch of the last answer, if there ever was one. */
  lastSeen?: number;
  error?: string;
};

type Inverter = InverterView & { logger: Logger; bridged: boolean };

/**
 * Tracks the inverters and keeps their Matter endpoints fed.
 *
 * Every configured address is bridged. The user already chose the inverters
 * by writing their addresses down, so there is nothing left to pick.
 */
export class Inverters {
  readonly #inverters: Inverter[];
  /** The serial behind each address, as last written to the state file. */
  #serials = new Map<string, string>();
  #unsaved = false;

  constructor(
    loggers: Logger[],
    private readonly bridge: Bridge,
    private readonly stateFile: string,
  ) {
    this.#inverters = loggers.map((logger) => ({
      host: logger.host,
      logger,
      bridged: false,
      reachable: false,
    }));
  }

  /**
   * Publishes every inverter whose serial is already known.
   *
   * One that has never answered is published as soon as it first does. That
   * only happens on a first run started after dark, because the serial has to
   * be asked of the logger once.
   */
  async load(): Promise<void> {
    this.#serials = await loadSerials(this.stateFile);
    for (const inverter of this.#inverters) {
      inverter.serial = this.#serials.get(inverter.host);
      await this.#bridgeOnce(inverter);
    }
  }

  list(): InverterView[] {
    return this.#inverters.map(
      ({ logger: _logger, bridged: _bridged, ...view }) => view,
    );
  }

  /** Reads every inverter and pushes the values into Matter. */
  async poll(): Promise<void> {
    await Promise.all(this.#inverters.map((inverter) => this.#read(inverter)));
    // The inverters are read at the same time, so the file is written once,
    // here, by one writer. A read and write inside each of them would keep
    // only the serial of whichever finished last.
    if (this.#unsaved) {
      await saveSerials(this.stateFile, this.#serials);
      this.#unsaved = false;
    }
  }

  async #read(inverter: Inverter): Promise<void> {
    let reading: LoggerReading;
    try {
      reading = await inverter.logger.read();
    } catch (error) {
      // A logger that cannot be reached at all is asleep, which is what it
      // does every night. Anything else is a fault worth showing.
      inverter.reachable = false;
      inverter.error =
        error instanceof LoggerUnreachable ? undefined : message(error);
      if (inverter.error) {
        console.error(`failed to read ${inverter.host}:`, error);
      }
      await this.#publish(inverter);
      return;
    }

    inverter.reachable = true;
    inverter.error = undefined;
    inverter.lastSeen = reading.at;
    inverter.readings = toReadings(reading);
    inverter.todayKwh = reading.dailyKwh;

    // The serial takes a second connection, so it can fail on its own. The
    // reading is already in hand and stays; the serial is asked again on the
    // next poll.
    if (inverter.serial === undefined) {
      try {
        inverter.serial = await inverter.logger.inverterSerial();
        this.#serials.set(inverter.host, inverter.serial);
        this.#unsaved = true;
      } catch (error) {
        inverter.error = message(error);
        console.error(`failed to read the serial of ${inverter.host}:`, error);
      }
    }

    await this.#bridgeOnce(inverter);
    await this.#publish(inverter);
  }

  async #bridgeOnce(inverter: Inverter): Promise<void> {
    if (inverter.bridged || inverter.serial === undefined) {
      return;
    }
    await this.bridge.addDevice({
      id: inverter.serial,
      name: `Inverter ${inverter.serial}`,
      productName: "Solarman Inverter",
      reachable: inverter.reachable,
    });
    inverter.bridged = true;
  }

  async #publish(inverter: Inverter): Promise<void> {
    if (!inverter.bridged || inverter.serial === undefined) {
      return;
    }
    await this.bridge.updateDevice(inverter.serial, {
      reachable: inverter.reachable,
      readings:
        inverter.reachable && inverter.readings !== undefined
          ? inverter.readings
          : idle(inverter.readings),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
