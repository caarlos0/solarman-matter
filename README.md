# solarman-matter

Exposes a solar inverter as a Matter device on your local network.

The inverter is read through its Solarman data logger, on your own network.
There is no cloud account, no API key and no call quota: the bridge speaks to
the logger directly, and keeps working when the internet does not.

Each inverter is published as a **Solar Power** device with a composed
**Electrical Sensor** endpoint, so controllers such as Home Assistant show the
generated power and the lifetime production without a custom integration.

## Install

Get a `.deb` or a tarball from the [releases page][releases], for `x86_64` or
`arm64`. The binary is self-contained: no runtime, no `node_modules`, no files
beside it.

```sh
sudo dpkg -i solarman-matter_0.1.0_linux_amd64.deb
solarman-matter
```

```sh
tar xf solarman-matter_Linux_x86_64.tar.gz
./solarman-matter
```

[releases]: https://github.com/caarlos0/solarman-matter/releases

## Requirements

- A Solarman data logger on the same network as the bridge, the kind that ships
  with Deye, Sofar and similar string inverters.
- [Bun](https://bun.sh) 1.4 or later, to run from source.

## Setup

Find the logger on your network. It answers on port 8899, and its status page
is on port 80. Give it a fixed address in your router, so it does not move.

Copy `.env.example` to `.env` and put the address in `SOLARMAN_LOCAL_HOSTS`.

```sh
bun install
bun start
```

Then open <http://localhost:8080> for the pairing code.

## The web page

The page shows the pairing code and what each inverter last reported: the power
now, the production today and the lifetime total.

There is nothing to choose. You listed the inverters when you wrote their
addresses in the configuration, so all of them are bridged.

## Configuration

| Variable                  | Required | Default                       | Meaning                                    |
| ------------------------- | -------- | ----------------------------- | ------------------------------------------ |
| `SOLARMAN_LOCAL_HOSTS`    | yes      |                               | Logger addresses, comma separated.         |
| `SOLARMAN_LOCAL_USER`     | no       | `admin`                       | Logger web login.                          |
| `SOLARMAN_LOCAL_PASSWORD` | no       | `admin`                       | Logger web password.                       |
| `SOLARMAN_POLL_INTERVAL`  | no       | `30`                          | Seconds between reads.                     |
| `SOLARMAN_WEB_PORT`       | no       | `8080`                        | Port of the web page.                      |
| `SOLARMAN_STATE_FILE`     | no       | next to Matter data           | Remembers the serial behind each address.  |
| `MATTER_PASSCODE`         | no       | `20202021`                    | Commissioning passcode.                    |
| `MATTER_DISCRIMINATOR`    | no       | `3840`                        | Commissioning discriminator.               |
| `MATTER_PORT`             | no       | `5540`                        | Matter UDP port.                           |

Every setting this bridge owns is prefixed, because bare names such as
`LOCAL_HOSTS` collide with other tools. A real environment variable always wins
over the `.env` file, so an old export can hide the file without a warning.

## How it works

The logger speaks [Solarman V5][v5] on port 8899, which wraps Modbus RTU. The
bridge asks it for holding registers 59 to 112, the telemetry block of the
[Deye string profile][profile], and writes the values into Matter.

[v5]: https://pysolarmanv5.readthedocs.io/en/stable/solarmanv5_protocol.html
[profile]: https://github.com/davidrapan/ha-solarman

| Register   | Matter attribute                     |
| ---------- | ------------------------------------ |
| 80, 81     | `activePower`                        |
| 63, 64     | `cumulativeEnergyExported`           |
| 73         | `voltage`                            |
| 76         | `activeCurrent`                      |
| 79         | `frequency`                          |

A plant exports energy, so the production feeds the *exported* side of the
meter, not the imported one.

Register 60 holds the production of today. It resets each night, so it cannot
feed a cumulative attribute; the page shows it, and Matter gets the lifetime
total instead. Your controller can derive the day from that.

Only Modbus function 3, read holding registers, is ever sent. Nothing in the
bridge can change a setting on the logger or the inverter.

## Nights

The logger is powered by the inverter, which is powered by the sun, so it
disappears every night. That is not a fault:

- The Matter device stays, marked unreachable, and keeps its last values. A
  controller that dropped the device each evening would lose its history.
- The device is named after the inverter serial, not the address, so it
  survives a logger that DHCP moved. The serial is asked of the logger once and
  written to the state file.
- A first run started after dark therefore has no serial to publish. The
  inverter appears at first light, and every run after that is immediate.

## State

The Matter fabric and node state live in `~/.matter/solarman-matter`. The
serial behind each address is in `~/.matter/solarman-matter-inverters.json`.

## Clearing the pairings

Remove the bridge in your controller first. That deletes the fabric on both
sides.

If the controller entry is gone or stuck, factory reset the bridge. Stop it
first: erasing the state under a running bridge leaves the old fabric in memory,
and the pairing code does not come back. `bun run reset` refuses while the
bridge runs.

```sh
bun run reset
bun start
```

The bridge then prints a new pairing code, on the page and in the log. Your
controller keeps a dead entry for the old bridge, so remove it by hand.

## Limits

- Production only. Batteries, meters, grid import and household consumption are
  not exposed.
- The first AC phase only. The registers carry three, and a single-phase
  inverter reports zero for the other two, which Matter cannot tell apart from
  a real zero.
- No DC strings. The logger reports volts, amps and watts for each string, but
  the Matter electrical sensor describes an AC meter.
- One Matter device per inverter. A plant with several is not added up.
- The register map is the Deye string profile. Hybrid and battery inverters
  answer a different one and are untested.
- The web page has no authentication. Keep it on a trusted network.

## Development

```sh
bun start          # run from source
bun test src       # run the tests
bun run typecheck  # tsc --noEmit
bun run build      # compile a binary for this machine
```

Releases are built by [GoReleaser](https://goreleaser.com) with the Bun builder,
which runs `bun build --compile` for `linux-x64` and `linux-arm64`. Push a tag
to release:

```sh
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
```

The web page is inlined in `src/page.ts` so the binary stays a single file.
Edit it there.

## Credits

The Solarman V5 client is the one from [electrify][electrify], where it was
checked against the Solarman cloud and reported the same values, to the digit.

[electrify]: https://github.com/caarlos0/electrify
