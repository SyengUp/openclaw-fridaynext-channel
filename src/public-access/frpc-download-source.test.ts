import { describe, expect, it } from "vitest";
import {
  expectedFrpcArchiveSHA256,
  frpcArchiveFileName,
  frpcDownloadSources,
} from "./frpc-manager.js";

describe("frpc download hardening", () => {
  it("pins every supported 0.69.1 archive checksum", () => {
    for (const platform of ["darwin", "linux", "windows"]) {
      for (const cpu of ["amd64", "arm64"]) {
        expect(expectedFrpcArchiveSHA256(`frp_0.69.1_${platform}_${cpu}`)).toMatch(
          /^[a-f0-9]{64}$/,
        );
      }
    }
  });

  it("tries the FridayTunnel control plane before GitHub fallback", () => {
    expect(frpcDownloadSources("https://friday.example/", "frp_0.69.1_linux_amd64")).toEqual([
      "https://friday.example/v1/frpc/v0.69.1/frp_0.69.1_linux_amd64.tar.gz",
      "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_amd64.tar.gz",
    ]);
  });

  it("windows releases are .zip on both sources", () => {
    expect(frpcArchiveFileName("frp_0.69.1_windows_arm64")).toBe("frp_0.69.1_windows_arm64.zip");
    expect(frpcArchiveFileName("frp_0.69.1_linux_arm64")).toBe("frp_0.69.1_linux_arm64.tar.gz");
    expect(frpcDownloadSources("https://friday.example", "frp_0.69.1_windows_amd64")).toEqual([
      "https://friday.example/v1/frpc/v0.69.1/frp_0.69.1_windows_amd64.zip",
      "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_windows_amd64.zip",
    ]);
  });
});
