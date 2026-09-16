# solarman-matter

Exposes the solar plants of a [SOLARMAN](https://www.solarmanpv.com) account as
Matter devices on your local network.

A web page lists every inverter in your account. Choose the ones you want, and
the bridge publishes each of them as a **Solar Power** device with a composed
**Electrical Sensor** endpoint.

Controllers such as Home Assistant then show the generated power and the total
production, plus the AC voltage, current and frequency when the inverter reports
them.

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

- A SOLARMAN Smart or SOLARMAN Business account that owns the plants.
- A developer `appId` and `appSecret` with call allowance (see below).
- [Bun](https://bun.sh) 1.4 or later, to run from source.

## Setup

The Solarman Open API is not self-service. Write to `service@solarmanpv.com`
with your contact details, your SOLARMAN account, your customer type and what
you want to build. Solarman then creates an app and sends you the `appId` and
the `appSecret`.

Ask for **call allowance** in the same message. Without it every call answers
`2101010 appId insufficient allowance`, including the login.

Copy `.env.example` to `.env` and fill it in.

```sh
bun install
bun start
```

Then open <http://localhost:8080>.

## Using the web page

The page lists every inverter of every plant in your account.

- **Expose** adds the inverter to the Matter bridge. The controller sees it at
  once; no restart is needed.
- **Remove** takes it off the bridge again.
- An inverter that reports no production cannot be exposed, so its button is
  disabled.
- **Refresh from Solarman** reloads the account. A plant you deleted is removed
  from the bridge too.
- Exposed plants show their latest reading, refreshed every
  `SOLARMAN_POLL_INTERVAL` seconds.

The page also shows the pairing code. Use it to commission the bridge in your
Matter controller. The choice of plants is stored, so it survives a restart.

## Configuration

| Variable                 | Required | Default                          | Meaning                                    |
| ------------------------ | -------- | -------------------------------- | ------------------------------------------ |
| `SOLARMAN_APP_ID`        | yes      |                                  | Developer app id.                          |
| `SOLARMAN_APP_SECRET`    | yes      |                                  | Developer app secret.                      |
| `SOLARMAN_EMAIL`         | yes      |                                  | Account that owns the plants.              |
| `SOLARMAN_PASSWORD`      | yes      |                                  | Account password, in plain text.           |
| `SOLARMAN_ORG_ID`        | no       |                                  | Merchant id of a Business account.         |
| `SOLARMAN_ENDPOINT`      | no       | `https://globalapi.solarmanpv.com` | Overrides the data center.               |
| `SOLARMAN_POLL_INTERVAL` | no       | `300`                            | Seconds between Solarman cloud reads.      |
| `SOLARMAN_WEB_PORT`      | no       | `8080`                           | Port of the web page.                      |
| `SOLARMAN_STATE_FILE`    | no       | next to Matter data              | File that stores the exposed plants.       |
| `MATTER_PASSCODE`        | no       | `20202021`                       | Commissioning passcode.                    |
| `MATTER_DISCRIMINATOR`   | no       | `3840`                           | Commissioning discriminator.               |
| `MATTER_PORT`            | no       | `5540`                           | Matter UDP port.                           |

The bridge hashes the password with SHA-256 before it sends it, because the
platform rejects anything else.

Every setting this bridge owns is prefixed, because bare names such as `APP_ID`
collide with other tools. A real environment variable always wins over the
`.env` file, so an old export can hide the file without a warning.

## How it works

1. Logs in with the app credentials and the account
   (`/account/v1.0/token?appId=…`). There is no refresh endpoint, so the bridge
   logs in again when the token nears its end.
2. Lists the plants (`/station/v1.0/list`) and their inverters
   (`/station/v1.0/device`).
3. Reads each inverter once (`/device/v1.0/currentData`) and keeps the data
   points that report production. Every point carries its own unit, so values
   convert into the Matter milli-units (mW, mWh, mV, mA, mHz).
4. Polls the same endpoint for the exposed plants and writes the values into
   the Matter attributes.

| Solarman key           | Matter attribute                     |
| ---------------------- | ------------------------------------ |
| `APo_t1`, `INV_O_P_T`  | `activePower`                        |
| `Et_ge0`               | `cumulativeEnergyExported`           |
| `AV1`                  | `voltage`                            |
| `AC1`                  | `activeCurrent`                      |
| `A_Fo1`, `AC_Fo1`      | `frequency`                          |

A plant exports energy, so the production feeds the *exported* side of the
meter, not the imported one.

`Etdy_ge0` is the production of today. It resets each night, so it cannot feed
a cumulative attribute and is ignored. Your controller can derive the daily
figure from the total.

## Choosing the data center

The account decides which data center answers, not where you live. The bridge
uses the international one. If the login fails with `2101009 appId or api is
locked`, set `SOLARMAN_ENDPOINT=https://api.solarmanpv.com`.

A SOLARMAN Business account also needs `SOLARMAN_ORG_ID`. Without it the login
succeeds but the plant list comes back empty.

## State

The Matter fabric and node state live in `~/.matter/solarman-matter`. The list
of exposed plants is in `~/.matter/solarman-matter-devices.json`.

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
controller keeps a dead entry for the old bridge, so remove it by hand. The list
of exposed plants survives.

## Limits

- Production only. Batteries, meters, grid import and consumption are not
  exposed yet.
- Inverters only. A data logger reports no production, so it is not exposed.
- A plant with more than one inverter gets one Matter device per inverter. The
  bridge does not add them up.
- A plant that reports megawatts gets no reading. Lowercased, `MWh` and `mWh`
  are the same text, so the bridge refuses the guess instead of being wrong by
  a factor of a thousand million.
- Polling only. Solarman refreshes about every five minutes, and each read
  spends part of the call allowance of your app, so a short interval only wastes
  it.
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
