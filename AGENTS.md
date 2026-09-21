# AGENTS.md

Bridge that exposes solar inverters as Matter devices. Each inverter is read
through its Solarman data logger on the local network. There is no cloud.

## Safety

This bridge only reads. It sends Modbus function 3, read holding registers,
and nothing else. Never add a write path: the same protocol can change inverter
settings, and a wrong register is a real appliance on a roof.

The bridge locks its Matter storage. Always override it when you run a test
instance, or you take over the paired production node:

```sh
SOLARMAN_LOCAL_HOSTS=192.168.107.197 SOLARMAN_WEB_PORT=8099 MATTER_PORT=5599 \
  MATTER_STORAGE_PATH=/tmp/sm-test SOLARMAN_STATE_FILE=/tmp/sm-test.json \
  bun src/index.ts
```

## Commands

```sh
bun install
bun start          # run from source
bun test src       # run the tests
bun run typecheck  # tsc --noEmit; bun does not type-check
bun run build      # compile a binary for this machine
bun run reset      # erase the Matter state; refuses while the bridge runs
```

Bun loads `.env` itself. There is no Node, no npm, and no bundler step.

## Layout

| File                            | Role                                            |
| ------------------------------- | ----------------------------------------------- |
| `src/index.ts`                  | Startup and the poll timer.                     |
| `src/config.ts`                 | Environment settings.                           |
| `src/inverters.ts`              | Registry: reads the loggers, feeds Matter.      |
| `src/state.ts`                  | Remembers the serial behind each address.       |
| `src/web.ts`                    | HTTP API and page serving.                      |
| `src/page.ts`                   | The web page.                                   |
| `src/solarman/local.ts`         | Solarman V5 and Modbus client.                  |
| `src/solarman/measurements.ts`  | Scales a reading into Matter milli-units.       |
| `src/matter/bridge.ts`          | Matter server node and aggregator.              |
| `src/matter/device-endpoint.ts` | Maps an inverter onto Matter endpoints.         |

## The logger

Port 8899 speaks [Solarman V5][v5], which wraps Modbus RTU. The register map is
the [Deye string profile][profile].

[v5]: https://pysolarmanv5.readthedocs.io/en/stable/solarmanv5_protocol.html
[profile]: https://github.com/davidrapan/ha-solarman

Every V5 frame carries the **logger** serial, which is not the inverter serial.
The logger serial is read from `http://<host>/status.html`, behind basic auth,
as `var cover_mid`. The inverter serial is in holding registers 0 to 18.

The telemetry block is registers 59 to 112, both ends inclusive:

| Register | Value                 | Scale     |
| -------- | --------------------- | --------- |
| 59       | inverter status       | raw       |
| 60       | production today      | ÷10 kWh   |
| 63, 64   | production total      | ÷10 kWh   |
| 73 to 75 | AC volts per phase    | ÷10 V     |
| 76 to 78 | AC amps per phase     | ÷10 A, signed |
| 79       | AC frequency          | ÷100 Hz   |
| 80, 81   | AC power              | ÷10 W     |
| 90       | radiator temperature  | −1000, ÷10 °C |
| 109, 111 | DC volts per string   | ÷10 V     |
| 110, 112 | DC amps per string    | ÷10 A     |

Things that bite:

- 32-bit values put the **low word first**, although Modbus is big-endian.
- The current registers are **signed**; `0xFFF6` is −1.0 A, not 6553.0 A.
- Temperatures carry a **1000 offset**. A sensor that is not fitted reads 0,
  which is −100 °C, and is not a measurement.
- This logger appends two zero bytes **after** the Modbus CRC. Drop them before
  the CRC is checked.
- The logger sends unsolicited heartbeats, control code `0x4710`. Skip them and
  never answer: an answer would be a write.
- The status code in register 59 has no mapping that was ever verified here.
  Do not invent one.

## Nights

The logger is powered by the inverter, so it is **gone every night**. This
shapes the whole design:

- `LoggerUnreachable` means asleep, not broken. It is not reported as a fault.
- The Matter endpoint must persist, marked unreachable, and keep its last
  values. A device that disappears each evening loses its history in the
  controller.
- The endpoint id is therefore the **inverter serial**, which is stable and
  written to the state file, never the address, which DHCP can move.
- A first run after dark cannot learn the serial, so that inverter appears at
  first light. There is no way around it; do not fake an id.

## Matter

Matter reports electricity in milli-units: mW, mWh, mV, mA and mHz.

An inverter becomes a bridged **Solar Power** device (`0x0017`), which owns no
cluster of its own, with its meter as a composed **Electrical Sensor** child
endpoint. The Solar Power endpoint carries `BridgedDeviceBasicInformation`,
because that is the endpoint the aggregator owns.

A plant produces, so the total goes to `cumulativeEnergyExported`. Use the
`ExportedEnergy` feature, not `ImportedEnergy`.

Today's production resets each night, so it cannot feed a cumulative attribute.
It is shown on the page only.

## Conventions

- Every setting this project owns is prefixed `SOLARMAN_`. Bare names collide
  with other tools, and a real environment variable silently wins over `.env`.
- `src/page.ts` is a template literal. Escape `` ` `` and `${` when you edit the
  markup, and keep the page dependency free.
- The released binary carries no files beside it, so anything the page needs
  must live in the source.
- Tests use the `node:test` API and run under `bun test`.
- `Inverters` takes its loggers as a parameter, which is the seam the tests
  use. Do not reach into its private fields.
- Releases are built by GoReleaser Pro with the Bun builder, for `linux-x64`
  and `linux-arm64`. Its output directory is `dist/`.

## Verifying a change

Type-check and test, then run a throwaway instance with the overrides above and
read `/api/state`. A real logger is the only way to check the register map; the
tests use recorded frames.

To check a Linux binary, build it and run it under Docker:

```sh
goreleaser build --snapshot --clean
docker run --rm --platform linux/arm64 \
  -v "$PWD/dist/solarman-matter_bun-linux-arm64/solarman-matter:/usr/local/bin/solarman-matter:ro" \
  debian:bookworm-slim solarman-matter
```

To check the page, screenshot it rather than guessing:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --window-size=900,1200 --virtual-time-budget=4000 \
  --screenshot=/tmp/page.png http://localhost:8099/
```

## Not supported yet

Batteries, meters, grid import and household consumption. The first AC phase
only, and no DC strings. Plants with more than one inverter get one Matter
device each; the bridge does not add them up. Hybrid inverters answer a
different register map and are untested. The web page has no authentication.
