import { describe, expect, it } from "vitest";

import {
  createMultiplexRoleAuthorization,
  createMultiplexSharedSecretSecurity,
  type MultiplexAuthorization,
} from "../src/security.js";
import { pinnedConnectOptions } from "../src/target.js";

describe("p2prpc transport identity", () => {
  it("pins endpoint and exact shared-secret principal independently of locator", () => {
    const target = pinnedConnectOptions({
      endpointId: "expected-iroh-key",
      locator: { kind: "ticket", ticket: "untrusted-route-ticket" },
    });

    expect(target).toEqual({
      expectedPeerId: "expected-iroh-key",
      expectedPrincipal: {
        id: "expected-iroh-key",
        subject: "expected-iroh-key",
        issuer: null,
        clientId: null,
        tenantId: null,
      },
      locator: { kind: "ticket", ticket: "untrusted-route-ticket" },
    });
  });

  it("inherits p2prpc's 32-byte shared-secret floor", () => {
    expect(() =>
      createMultiplexSharedSecretSecurity({ secret: "x".repeat(31) }),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      createMultiplexSharedSecretSecurity({ secret: "x".repeat(32) }),
    ).not.toThrow();
  });

  it("separates scoped access gateways from runtime and control-node ingress", async () => {
    const roles = new Map([
      ["gateway-endpoint", {
        role: "access-gateway" as const,
        scopes: new Set(["read", "agent-control"] as const),
      }],
      ["runtime-endpoint", {
        role: "runtime-node" as const,
        scopes: new Set(),
      }],
      ["child-endpoint", {
        role: "child-control-node" as const,
        scopes: new Set(),
      }],
      ["parent-endpoint", {
        role: "parent-control-node" as const,
        scopes: new Set(),
      }],
    ]);
    const authorize = createMultiplexRoleAuthorization({
      authorizationForPrincipal: (_principal, endpoint) => roles.get(endpoint),
      allowEnrollment: true,
    });
    const decision = (
      endpoint: string,
      path: string,
      type: "query" | "mutation" | "subscription" = "query",
    ) =>
      authorize({
        principal: { id: endpoint },
        remotePeerId: endpoint,
        action: { kind: "rpc", path, type, headers: {} },
      } as unknown as Parameters<MultiplexAuthorization>[0]);

    expect(await decision("gateway-endpoint", "access.sessions.search")).toBe(true);
    expect(await decision("gateway-endpoint", "ingress.gateways.enroll")).toBe(true);
    expect(await decision(
      "gateway-endpoint",
      "access.sessions.execute",
      "mutation",
    )).toBe(true);
    expect(await decision(
      "gateway-endpoint",
      "access.metadata.patch",
      "mutation",
    )).toMatchObject({ allowed: false });
    expect(await decision(
      "gateway-endpoint",
      "access.authority.promote",
      "mutation",
    )).toMatchObject({ allowed: false });
    expect(await decision("gateway-endpoint", "ingress.runtimeNodes.register")).toMatchObject({
      allowed: false,
    });
    expect(await decision("gateway-endpoint", "link.topology.snapshot")).toMatchObject({
      allowed: false,
    });
    expect(await decision("runtime-endpoint", "ingress.runtimeNodes.heartbeat")).toBe(true);
    expect(await decision("runtime-endpoint", "access.sessions.execute")).toMatchObject({
      allowed: false,
    });
    expect(await decision("runtime-endpoint", "ingress.controlNodes.attach")).toMatchObject({
      allowed: false,
    });
    expect(await decision("child-endpoint", "ingress.controlNodes.heartbeat")).toBe(true);
    expect(await decision("child-endpoint", "access.authority.promote")).toMatchObject({
      allowed: false,
    });
    expect(await decision("child-endpoint", "ingress.runtimeNodes.heartbeat")).toMatchObject({
      allowed: false,
    });
    expect(await decision("parent-endpoint", "link.topology.snapshot")).toBe(true);
    expect(await decision("parent-endpoint", "access.sessions.search")).toMatchObject({
      allowed: false,
    });
    expect(await decision("parent-endpoint", "ingress.controlNodes.attach")).toMatchObject({
      allowed: false,
    });
    expect(await decision("new-endpoint", "ingress.controlNodes.attach")).toBe(true);
    expect(await decision("new-endpoint", "ingress.runtimeNodes.register")).toBe(true);
    expect(await decision("new-endpoint", "ingress.gateways.enroll")).toBe(true);
    expect(await decision("new-endpoint", "ingress.runtimeNodes.heartbeat")).toMatchObject({
      allowed: false,
    });
    expect(await decision("new-endpoint", "access.sessions.search")).toMatchObject({
      allowed: false,
    });
    expect(await decision("runtime-endpoint", "ingress.runtimeNodes.register.extra")).toMatchObject({
      allowed: false,
    });
  });

  it("denies the file side channel regardless of role or enrollment", async () => {
    const authorize = createMultiplexRoleAuthorization({
      authorizationForPrincipal: () => ({
        role: "access-gateway",
        scopes: new Set(["read"]),
      }),
      allowEnrollment: true,
    });
    expect(await authorize({
      principal: { id: "gateway-endpoint" },
      remotePeerId: "gateway-endpoint",
      action: { kind: "file.push", manifest: {} },
    } as unknown as Parameters<MultiplexAuthorization>[0])).toMatchObject({
      allowed: false,
    });
  });

  it("maps each gateway mutation family to one explicit action scope", async () => {
    const paths = [
      ["agent-launch", "access.launches.create"],
      ["agent-archive", "access.sessions.archive"],
      ["agent-control", "access.sessions.execute"],
      ["metadata-propose", "access.metadata.patch"],
      ["topology-admin", "access.topology.detach"],
      ["authority-admin", "access.authority.promote"],
    ] as const;

    for (const [scope, allowedPath] of paths) {
      const authorize = createMultiplexRoleAuthorization({
        authorizationForPrincipal: () => ({
          role: "access-gateway",
          scopes: new Set([scope]),
        }),
      });
      const decision = (path: string) =>
        authorize({
          principal: { id: "gateway-endpoint" },
          remotePeerId: "gateway-endpoint",
          action: { kind: "rpc", path, type: "mutation", headers: {} },
        } as unknown as Parameters<MultiplexAuthorization>[0]);

      expect(await decision(allowedPath)).toBe(true);
      for (const [, deniedPath] of paths) {
        if (deniedPath === allowedPath) continue;
        expect(await decision(deniedPath)).toMatchObject({ allowed: false });
      }
      expect(await decision("access.unknown.mutation")).toMatchObject({
        allowed: false,
      });
    }
  });

  it("authorizes image transfer over pinned gateway peers with the same edge scopes", async () => {
    for (const [path, type, scope] of [
      ["access.images.beginUpload", "mutation", "agent-control"],
      ["access.images.writeUpload", "mutation", "agent-control"],
      ["access.images.commitUpload", "mutation", "agent-control"],
      ["access.images.abortUpload", "mutation", "agent-control"],
      ["access.images.resolvePath", "mutation", "read"],
      ["access.images.read", "query", "read"],
      ["access.images.limits", "query", "read"],
    ] as const) {
      for (const candidate of ["read", "agent-control"] as const) {
        const authorize = createMultiplexRoleAuthorization({ authorizationForPrincipal: () => ({ role: "access-gateway", scopes: new Set([candidate]) }) });
        const result = await authorize({ principal: { id: "gateway" }, remotePeerId: "gateway", action: { kind: "rpc", path, type, headers: {} } } as unknown as Parameters<MultiplexAuthorization>[0]);
        expect(result, `${candidate} ${path}`).toEqual(candidate === scope ? true : expect.objectContaining({ allowed: false }));
      }
    }
  });

  it("keeps raw terminal access separate from read and agent control", async () => {
    const decide = (
      scopes: ReadonlySet<"read" | "agent-control" | "terminal-view" | "terminal-control">,
      path: string,
      type: "query" | "mutation" | "subscription",
    ) => createMultiplexRoleAuthorization({
      authorizationForPrincipal: () => ({ role: "access-gateway", scopes }),
    })({
      principal: { id: "gateway-endpoint" },
      remotePeerId: "gateway-endpoint",
      action: { kind: "rpc", path, type, headers: {} },
    } as unknown as Parameters<MultiplexAuthorization>[0]);

    for (const scope of ["read", "agent-control"] as const) {
      expect(await decide(new Set([scope]), "access.terminals.get", "query"))
        .toMatchObject({ allowed: false });
      expect(await decide(new Set([scope]), "access.terminals.attach", "subscription"))
        .toMatchObject({ allowed: false });
      expect(await decide(new Set([scope]), "access.terminals.input", "mutation"))
        .toMatchObject({ allowed: false });
    }
    expect(await decide(
      new Set(["terminal-view"]),
      "access.terminals.get",
      "query",
    )).toBe(true);
    expect(await decide(
      new Set(["terminal-view"]),
      "access.terminals.attach",
      "subscription",
    )).toBe(true);
    expect(await decide(
      new Set(["terminal-view"]),
      "access.terminals.input",
      "mutation",
    )).toMatchObject({ allowed: false });
    expect(await decide(
      new Set(["terminal-control"]),
      "access.terminals.get",
      "query",
    )).toBe(true);
    expect(await decide(
      new Set(["terminal-control"]),
      "access.terminals.open",
      "mutation",
    )).toBe(true);
    expect(await decide(
      new Set(["terminal-control"]),
      "access.terminals.get",
      "mutation",
    )).toMatchObject({ allowed: false });
    expect(await decide(
      new Set(["terminal-control"]),
      "access.terminals.unknown",
      "mutation",
    )).toMatchObject({ allowed: false });
  });

  it("opens independent enrollment apertures", async () => {
    const authorize = createMultiplexRoleAuthorization({
      authorizationForPrincipal: () => undefined,
      allowAccessGatewayEnrollment: true,
    });
    const decision = (path: string) => authorize({
      principal: { id: "new-endpoint" },
      remotePeerId: "new-endpoint",
      action: { kind: "rpc", path, type: "mutation", headers: {} },
    } as unknown as Parameters<MultiplexAuthorization>[0]);

    expect(await decision("ingress.gateways.enroll")).toBe(true);
    expect(await decision("ingress.runtimeNodes.register")).toMatchObject({ allowed: false });
    expect(await decision("ingress.controlNodes.attach")).toMatchObject({ allowed: false });
  });
});
