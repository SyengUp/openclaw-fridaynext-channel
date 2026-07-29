import { describe, expect, it } from "vitest";
import { pickLanIpFromInterfaces } from "./frpc-manager.js";

// Minimal NetworkInterfaceInfo shape — only the fields pickLanIpFromInterfaces reads.
function v4(address: string, internal = false) {
  return [{ address, family: "IPv4" as const, internal }] as never;
}

describe("pickLanIpFromInterfaces", () => {
  it("skips container/VM/VPN interfaces even when enumerated first", () => {
    // The multi-NIC trap this fix exists for: a Docker bridge / VM host adapter enumerating
    // before the real NIC. The old "first non-internal IPv4" logic advertised 192.168.64.1
    // and pairing died — the app tries only the LAN address for the voucher exchange.
    expect(
      pickLanIpFromInterfaces({
        bridge100: v4("192.168.64.1"),
        en0: v4("192.168.100.133"),
      }),
    ).toBe("192.168.100.133");
    expect(
      pickLanIpFromInterfaces({
        docker0: v4("172.17.0.1"),
        "br-9a1c": v4("172.18.0.1"),
        eth0: v4("192.168.1.20"),
      }),
    ).toBe("192.168.1.20");
    expect(
      pickLanIpFromInterfaces({
        utun3: v4("100.64.0.5"),
        tailscale0: v4("100.101.102.103"),
        wlan0: v4("10.0.0.7"),
      }),
    ).toBe("10.0.0.7");
  });

  it("ignores loopback/internal entries", () => {
    expect(
      pickLanIpFromInterfaces({
        lo: v4("127.0.0.1", true),
        eth0: v4("192.168.1.20"),
      }),
    ).toBe("192.168.1.20");
  });

  it("falls back to the first non-internal IPv4 when everything looks virtual", () => {
    // A wrong-subnet answer still beats no answer: keeps the old behavior as the floor.
    expect(
      pickLanIpFromInterfaces({
        docker0: v4("172.17.0.1"),
        vmenet0: v4("192.168.64.2"),
      }),
    ).toBe("172.17.0.1");
  });

  it("returns null when no candidate exists", () => {
    expect(pickLanIpFromInterfaces({ lo: v4("127.0.0.1", true) })).toBeNull();
    expect(pickLanIpFromInterfaces({})).toBeNull();
  });
});
