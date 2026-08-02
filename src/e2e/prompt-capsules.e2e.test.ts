import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

/**
 * Exercises GET/PUT /friday-next/prompt-capsules through the real route table
 * (registration + dispatch + handler), the way the app calls it on (re)connect
 * and after every local capsule edit.
 */
describe("e2e prompt capsules", () => {
  let historyDir = "";
  const auth = { authorization: "Bearer test-token" };

  const CAPSULE = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Canvas",
    iconSystemName: "rectangle.on.rectangle.angled",
    prompt: "reply in canvas",
    createdAt: 1_700_000_000_000,
    sortOrder: 0,
    updatedAt: 1_700_000_000_000,
  };

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
  });

  afterEach(() => {
    removeTempHistoryDir(historyDir);
  });

  it("rejects a bad bearer token with 401", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "GET",
      path: "/friday-next/prompt-capsules",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("round-trips the capsule list across a PUT and a fresh GET", async () => {
    const app = createAppSimulator({ token: "test-token" });

    const empty = await app.rawRequest({
      method: "GET",
      path: "/friday-next/prompt-capsules",
      headers: auth,
    });
    expect(empty.status).toBe(200);
    const emptyBody = JSON.parse(empty.body);
    expect(emptyBody).toMatchObject({ ok: true, revision: 0, capsules: [] });

    const put = await app.rawRequest({
      method: "PUT",
      path: "/friday-next/prompt-capsules",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ capsules: [CAPSULE], baseRevision: 0 }),
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.body)).toMatchObject({ ok: true, revision: 1 });

    // A reinstalled app with no local file gets the full list back.
    const restored = await app.rawRequest({
      method: "GET",
      path: "/friday-next/prompt-capsules",
      headers: auth,
    });
    const restoredBody = JSON.parse(restored.body);
    expect(restoredBody.capsules).toEqual([CAPSULE]);
    expect(restoredBody.storeId).toBe(emptyBody.storeId);
  });

  it("refuses a stale baseRevision with 409 and the current state", async () => {
    const app = createAppSimulator({ token: "test-token" });
    await app.rawRequest({
      method: "PUT",
      path: "/friday-next/prompt-capsules",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ capsules: [CAPSULE] }),
    });

    const stale = await app.rawRequest({
      method: "PUT",
      path: "/friday-next/prompt-capsules",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ capsules: [], baseRevision: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ conflict: true, revision: 1 });
  });
});
