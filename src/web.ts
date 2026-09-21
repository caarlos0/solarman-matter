import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { Inverters } from "./inverters.js";
import type { Bridge } from "./matter/bridge.js";
import { PAGE } from "./page.js";

/** Serves the pairing code and what every inverter last reported. */
export function startWeb(
  port: number,
  inverters: Inverters,
  bridge: Bridge,
): Promise<void> {
  const server = createServer((request, response) => {
    handle(request, response, inverters, bridge);
  });

  return new Promise((resolve) => server.listen(port, resolve));
}

function handle(
  request: IncomingMessage,
  response: ServerResponse,
  inverters: Inverters,
  bridge: Bridge,
): void {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    send(response, 200, {
      inverters: inverters.list(),
      commissioning: bridge.commissioning ?? null,
    });
    return;
  }

  send(response, 404, { error: "not found" });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
