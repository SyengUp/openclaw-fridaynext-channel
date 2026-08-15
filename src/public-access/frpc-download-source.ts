/**
 * Pinned frpc download source list + checksums.
 *
 * Local copy kept for the channel plugin's own exported surface (tests import
 * `expectedFrpcArchiveSHA256` / `frpcDownloadSources` from `frpc-manager`, which re-exports
 * this module). The production lifecycle no longer uses these constants directly —
 * `@syengup/tunnel-edge`'s `TunnelRuntime` ships an identical copy and installs the exact
 * same frpc binary. The duplication of these pinned values is deliberate and acceptable.
 *
 * The FridayTunnel control plane is tried first because GitHub Releases is routinely
 * unreachable from mainland cloud providers; GitHub remains the independent fallback.
 * Every archive is checksum-verified against these pinned values, so neither source is a
 * supply-chain trust dependency.
 */

export const FRP_VERSION = "0.69.1";

const FRP_SHA256: Record<string, string> = {
  "frp_0.69.1_darwin_amd64": "2bc26d02100ef333f2712149ea5997dc530dc0eefac64f4be41cb0f49d032f40",
  "frp_0.69.1_darwin_arm64": "310012e2f1dcf3cdde2605d29b95340b686c94d1680a23711d58efeffc02f64e",
  "frp_0.69.1_linux_amd64": "7be257b72dbbc60bcb3e0e25a5afd1dfac7b63f897084864d3c956dd3d5674e1",
  "frp_0.69.1_linux_arm64": "bbc0c75e896af3f292fb46ba09c844a04fa9b5ea3530c039c7af20637f836355",
};

export function expectedFrpcArchiveSHA256(base: string): string | null {
  return FRP_SHA256[base] ?? null;
}

export function frpcDownloadSources(controlPlaneUrl: string, base: string): string[] {
  const controlPlaneBase = controlPlaneUrl.replace(/\/+$/, "");
  return [
    `${controlPlaneBase}/v1/frpc/v${FRP_VERSION}/${base}.tar.gz`,
    `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${base}.tar.gz`,
  ];
}
