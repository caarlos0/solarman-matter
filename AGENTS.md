# AGENTS.md

Bridge that exposes the inverters of a SOLARMAN account as Matter devices on
the local network. A web page lists the plants and the user picks which ones to
expose.

## Safety

This bridge only reads. The Solarman control endpoints need a separate grant
and are not used. Keep it that way unless the user asks for control.

The bridge locks its Matter storage. Always override it when you run a test
instance, or you take over the paired production node:

```sh
SOLARMAN_WEB_PORT=8099 MATTER_PORT=5599 \
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

| File                            | Role                                              |
| ------------------------------- | ------------------------------------------------- |
| `src/index.ts`                  | Startup and the poll timer.                       |
| `src/config.ts`                 | Environment settings.                             |
| `src/devices.ts`                | Registry: which inverters exist and which are exposed. |
| `src/state.ts`                  | Reads and writes the exposed-plant list.          |
| `src/web.ts`                    | HTTP API and page serving.                        |
| `src/page.ts`                   | The web page.                                     |
| `src/solarman/api.ts`           | Solarman cloud client.                            |
| `src/solarman/measurements.ts`  | Reads data points into Matter milli-units.        |
| `src/matter/bridge.ts`          | Matter server node and aggregator.                |
| `src/matter/device-endpoint.ts` | Maps an inverter onto Matter endpoints.           |

## Solarman cloud

Base URL `https://globalapi.solarmanpv.com`, or `https://api.solarmanpv.com`
for an account in China. The account decides which one answers, not the
location of the bridge.

Every call is a `POST` with a JSON body and `?language=en`. Failures answer
**HTTP 200** with `{"success": false, "code": "…", "msg": "…"}`, so branch on
`success`, never on the status. `code` is a string.

- `/account/v1.0/token?appId=…` — login. `appId` goes in the query, the rest in
  the body: `appSecret`, `email`, `password`. The password must be a
  **lowercase hex SHA-256** digest. Add `orgId` for a SOLARMAN Business
  account; leave it out for a Smart account, or the plant list comes back
  empty.
- `/station/v1.0/list` — plants, paged with `page` and `size`.
- `/station/v1.0/device` — devices of a plant. The array is `deviceListItems`.
  `connectStatus` is `0` offline, `1` online, `2` alarm — **not** the same
  scale as `deviceState` in `currentData`.
- `/device/v1.0/currentData` — last reported values of one device. The logger
  serial number returns an empty list, so always query the `INVERTER`.

The token lasts about 60 days and there is no refresh endpoint. Logging in
again is safe: it does not invalidate the earlier token.

After the login, `appId` and `appSecret` are never sent again. The token goes
in `Authorization: bearer <token>` — the space after `bearer` is part of the
format.

`appSecret` and `appId` never appear in the query of later calls.

### Errors worth knowing

| Code      | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| `2101009` | AppId or API is locked. Usually the wrong data center.       |
| `2101010` | AppId insufficient allowance. The call quota is used up.     |
| `2101017` | No `Authorization` header, or no `bearer ` prefix.           |
| `2101019` | Invalid token, appId, appSecret or account.                  |
| `2101022` | Business error. A Smart account with an `orgId`, or reverse. |
| `2101025` | Wrong account, or a password that is not lowercase SHA-256.  |

Limits are 300 calls per 10 seconds, plus a separate lifetime allowance per
app.

### Data points

`currentData` returns `dataList` as `{key, name, value, unit}`. The key set
depends on the inverter model, so treat it as an open map. `value` is always a
string, and some points hold a status word. `name` is localised; `key` is
stable. Take the unit from the response, never from a table of your own.

Keys are matched **exactly**, because the trailing digit is meaningful:
`Et_ge0` is the total production, while `Et_ge1` and `Et_ge2` are the totals of
the single PV strings. `Etdy_ge0` is the production of today and resets each
night, so it cannot feed a cumulative Matter attribute.

## Matter

Matter reports electricity in milli-units: mW, mWh, mV, mA and mHz.

An inverter becomes a bridged **Solar Power** device (`0x0017`), which owns no
cluster of its own, with its meter as a composed **Electrical Sensor** child
endpoint. The Solar Power endpoint carries `BridgedDeviceBasicInformation`,
because that is the endpoint the aggregator owns.

A plant produces, so the total goes to `cumulativeEnergyExported`. Use the
`ExportedEnergy` feature, not `ImportedEnergy`.

## Conventions

- Every setting this project owns is prefixed `SOLARMAN_`. Bare names collide
  with other tools, and a real environment variable silently wins over `.env`.
- `src/page.ts` is a template literal. Escape `` ` `` and `${` when you edit the
  markup, and keep the page dependency free.
- The released binary carries no files beside it, so anything the page needs
  must live in the source.
- Tests use the `node:test` API and run under `bun test`.
- Releases are built by GoReleaser Pro with the Bun builder, for `linux-x64`
  and `linux-arm64`. Its output directory is `dist/`.

## Verifying a change

Type-check and test, then run a throwaway instance with the overrides above and
read `/api/state`. To check a Linux binary, build it and run it under Docker:

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

Batteries, meters, grid import and household consumption. Plants with more than
one inverter get one Matter device per inverter; the bridge does not add them
up. Updates are polled. The web page has no authentication.
