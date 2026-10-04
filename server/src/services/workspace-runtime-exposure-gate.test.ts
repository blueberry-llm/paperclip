import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrokerClient } from "./runtime-exposure/broker-client.js";
import {
  resetRuntimeServicesForTests,
  resolveRuntimeServiceExposure,
  setRemoteRuntimeExposureGate,
  setWorkspaceRuntimeExposureDepsForTests,
} from "./workspace-runtime.js";

/**
 * The instance kill switch (`enableTailscaleRuntimeExposure`) as the resolver
 * sees it.
 *
 * These tests cover the decision only. The full spawn path needs real processes,
 * a real broker socket, and `/proc`, so it lives in
 * `workspace-runtime-exposure.test.ts` and runs on the CI hosts that support it.
 */

const broker = {
  list: vi.fn(async () => []),
  reserve: vi.fn(),
  expose: vi.fn(),
  remove: vi.fn(),
} as unknown as BrokerClient;

function deps() {
  setWorkspaceRuntimeExposureDepsForTests({
    broker,
    isPortAvailable: async () => true,
    isBrokerAvailable: async () => true,
    resolveHostname: async () => "runner.tail123.ts.net",
    probeHealth: async () => true,
    now: () => "2026-10-04T00:00:00.000Z",
    diagnoseListenerBinds: async () => null,
  } as never);
}

const defaultCandidate = {
  service: {},
  serviceName: "paperclip-dev",
  command: "pnpm dev:once",
};

const declaredOptIn = {
  service: { expose: { type: "tailscale_https", hostname: "auto", publicPort: "same" } },
  serviceName: "paperclip-dev",
  command: "pnpm dev:once",
};

describe("remote runtime exposure gate", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "auto");
    deps();
  });

  afterEach(async () => {
    await resetRuntimeServicesForTests();
    vi.unstubAllEnvs();
  });

  it("keeps the automatic default when the gate allows the transport", async () => {
    setRemoteRuntimeExposureGate(async () => true);

    const resolved = await resolveRuntimeServiceExposure(defaultCandidate);

    expect(resolved?.origin).toBe("default");
  });

  it("drops the automatic default when the operator turns exposure off", async () => {
    setRemoteRuntimeExposureGate(async () => false);

    expect(await resolveRuntimeServiceExposure(defaultCandidate)).toBeNull();
  });

  it("fails closed when the settings read rejects", async () => {
    // A kill switch that reopens on a database blip is not a kill switch.
    setRemoteRuntimeExposureGate(async () => {
      throw new Error("settings unavailable");
    });

    expect(await resolveRuntimeServiceExposure(defaultCandidate)).toBeNull();
  });

  it("honors an explicit opt-in when the gate allows the transport", async () => {
    setRemoteRuntimeExposureGate(async () => true);

    const resolved = await resolveRuntimeServiceExposure(declaredOptIn);

    expect(resolved?.origin).toBe("declared");
  });

  it("fails loudly when a service declares HTTPS but the transport is off", async () => {
    // Silently coming up on plain HTTP under the same name would be worse than
    // not coming up at all.
    setRemoteRuntimeExposureGate(async () => false);

    await expect(resolveRuntimeServiceExposure(declaredOptIn)).rejects.toThrow(
      /remote runtime exposure turned off/i,
    );
  });

  it("still honors a service's own opt-out with the transport on", async () => {
    setRemoteRuntimeExposureGate(async () => true);

    const resolved = await resolveRuntimeServiceExposure({
      service: { expose: { type: "none" } },
      serviceName: "paperclip-dev",
      command: "pnpm dev:once",
    });

    expect(resolved).toBeNull();
  });
});