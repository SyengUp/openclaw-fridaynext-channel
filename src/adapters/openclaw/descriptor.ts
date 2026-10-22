import { RUNTIME_CAPABILITIES, type BackendDescriptor } from "@syengup/fridaynext-channel-kit";
import { PLUGIN_VERSION } from "../../version.js";

export const OPENCLAW_CAPABILITIES = [
  ...RUNTIME_CAPABILITIES,
  "approval", "question", "attachments", "push-v1", "prompt-capsules", "progress-card",
  "sessions.settings", "sessions.delete", "sessions.pin", "sessions.title", "sessions.bind", "history.message-detail", "sessions.read-state", "sessions.rewind", "sessions.fork",
  "agent.config", "agent.files", "tools.catalog", "skills.catalog", "commands.catalog", "cron", "talk", "tts",
  "device.health", "device.calendar", "device.location", "inbox",
] as const;

export function openClawDescriptor(): BackendDescriptor {
  return {id:"openclaw",name:"OpenClaw",adapter:{id:"friday-next",version:PLUGIN_VERSION},eventFormats:["canonical-v1"],capabilities:[...OPENCLAW_CAPABILITIES]};
}
