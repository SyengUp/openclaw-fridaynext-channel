// Mock module for openclaw/plugin-sdk/device-bootstrap in tests.
// Tests replace these via vi.mock + vi.fn() in hoisted blocks.

export function listDevicePairing(): Promise<any> {
  throw new Error("listDevicePairing not mocked");
}

export function approveDevicePairing(): Promise<any> {
  throw new Error("approveDevicePairing not mocked");
}
