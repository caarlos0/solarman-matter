import { createHash } from "node:crypto";

type SolarmanResponse = {
  success: boolean;
  code?: string | null;
  msg?: string | null;
};

export type SolarmanStation = {
  id: number;
  name: string;
};

export type SolarmanDevice = {
  deviceSn: string;
  deviceId: number;
  deviceType: string;
  /** `0` offline, `1` online, `2` alarm. Not the same scale as `deviceState`. */
  connectStatus: number;
};

/** One reading of a device, e.g. `APo_t1` in `W`. */
export type SolarmanDataPoint = {
  key: string;
  name: string;
  value: string;
  unit?: string | null;
};

type Token = {
  accessToken: string;
  expiresAt: number;
};

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const STATION_PAGE_SIZE = 50;
const DEVICE_PAGE_SIZE = 200;

export class SolarmanApi {
  #token?: Token;

  constructor(
    private readonly endpoint: string,
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly email: string,
    private readonly password: string,
    private readonly orgId?: number,
  ) {}

  /**
   * Gets an access token. There is no refresh endpoint in v1.0, and a new
   * token does not invalidate the previous one, so we simply log in again.
   */
  async login(): Promise<void> {
    this.#token = undefined;
    const result = await this.#post<{
      access_token: string;
      expires_in: number;
    }>(`/account/v1.0/token?appId=${encodeURIComponent(this.appId)}`, {
      appSecret: this.appSecret,
      email: this.email,
      // The platform rejects anything but a lowercase hex SHA-256 digest.
      password: createHash("sha256").update(this.password).digest("hex"),
      ...(this.orgId === undefined ? {} : { orgId: this.orgId }),
    });

    this.#token = {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
  }

  /** Lists the plants of the account. */
  async stations(): Promise<SolarmanStation[]> {
    const stations: SolarmanStation[] = [];

    for (let page = 1; ; page++) {
      const { total, stationList } = await this.#post<{
        total: number;
        stationList: SolarmanStation[] | null;
      }>("/station/v1.0/list", { page, size: STATION_PAGE_SIZE });

      stations.push(...(stationList ?? []));
      if (stations.length >= total || !stationList?.length) {
        return stations;
      }
    }
  }

  /** Lists the devices of a plant, e.g. its inverters. */
  async devices(
    stationId: number,
    deviceType?: string,
  ): Promise<SolarmanDevice[]> {
    const devices: SolarmanDevice[] = [];

    for (let page = 1; ; page++) {
      const { total, deviceListItems } = await this.#post<{
        total: number;
        deviceListItems: SolarmanDevice[] | null;
      }>("/station/v1.0/device", {
        stationId,
        page,
        size: DEVICE_PAGE_SIZE,
        ...(deviceType ? { deviceType } : {}),
      });

      devices.push(...(deviceListItems ?? []));
      if (devices.length >= total || !deviceListItems?.length) {
        return devices;
      }
    }
  }

  /**
   * Reads the last values a device reported. The key set depends on the
   * inverter model, and each point carries its own unit.
   */
  async currentData(deviceSn: string): Promise<SolarmanDataPoint[]> {
    const { dataList } = await this.#post<{
      dataList: SolarmanDataPoint[] | null;
    }>("/device/v1.0/currentData", { deviceSn });
    return dataList ?? [];
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    await this.#loginIfExpired(path);

    const url = new URL(path, this.endpoint);
    url.searchParams.set("language", "en");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The space after `bearer` is part of the format.
        ...(this.#token
          ? { Authorization: `bearer ${this.#token.accessToken}` }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `solarman api ${path} failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    // Failures answer HTTP 200, so only `success` tells them apart.
    const json = (await response.json()) as SolarmanResponse & T;
    if (!json.success) {
      throw new Error(
        `solarman api ${path} failed: ${json.msg ?? "unknown error"} (code ${json.code ?? "none"})`,
      );
    }
    return json;
  }

  async #loginIfExpired(path: string): Promise<void> {
    const token = this.#token;
    if (
      !token ||
      path.startsWith("/account/v1.0/token") ||
      Date.now() + TOKEN_REFRESH_MARGIN_MS < token.expiresAt
    ) {
      return;
    }
    await this.login();
  }
}
