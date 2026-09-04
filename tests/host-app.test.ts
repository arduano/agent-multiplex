import type { AddressInfo } from "node:net";

import { HostCatalog, HostService } from "@agent-multiplex/host-core";
import { afterEach, describe, expect, it } from "vitest";

import { createHostHttpSurface, type HostHttpSurface } from "../apps/host/src/http.js";

let surface: HostHttpSurface | undefined;
let service: HostService | undefined;
let catalog: HostCatalog | undefined;

afterEach(async () => {
  await surface?.close();
  service?.close();
  catalog?.close();
  surface = undefined;
  service = undefined;
  catalog = undefined;
});

describe("host HTTP surface", () => {
  it("serves the dashboard and the FleetRouter over default JSON tRPC", async () => {
    catalog = new HostCatalog({ filename: ":memory:" });
    service = new HostService({ catalog, instanceId: "http-smoke-host" });
    surface = createHostHttpSurface(service);
    await new Promise<void>((resolveListen, rejectListen) => {
      surface!.server.once("error", rejectListen);
      surface!.server.listen(0, "127.0.0.1", () => {
        surface!.server.off("error", rejectListen);
        resolveListen();
      });
    });
    const { port } = surface.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Agent Multiplex");
    expect(html).toContain('data-testid="stream-status"');
    expect(html).toContain('data-testid="send-button"');
    expect(html).toContain('data-testid="steer-button"');
    expect(html).toContain('data-testid="interrupt-button"');
    expect(html).toContain('data-testid="interaction-card"');
    expect(html).toContain("new WebSocket(websocketUrl())");

    const describe = await fetch(`${origin}/trpc/system.describe`);
    expect(describe.status).toBe(200);
    const describeBody = (await describe.json()) as {
      result: { data: { instanceId: string; protocolVersion: number } };
    };
    expect(describeBody.result.data).toMatchObject({
      instanceId: "http-smoke-host",
      protocolVersion: 2,
    });

    const sessions = await fetch(
      `${origin}/trpc/sessions.list?input=${encodeURIComponent(JSON.stringify({}))}`,
    );
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ result: { data: [] } });

    expect((await fetch(`${origin}/missing`)).status).toBe(404);
  });
});
