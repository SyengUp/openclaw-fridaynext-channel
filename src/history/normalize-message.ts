/**
 * Normalizes raw OpenClaw session transcript messages (as returned by the
 * gateway `sessions.get` method / `runtime.subagent.getSessionMessages`) into a
 * stable wire DTO the Friday app can parse without guessing at the upstream
 * content-block shape.
 *
 * Each raw message is one persisted LLM message (UserMessage / AssistantMessage
 * / ToolResultMessage) with an `__openclaw` metadata envelope attached by the
 * gateway carrying the stable transcript entry `id`, a positional `seq`, and the
 * record timestamp. That `id` is the durable, channel-agnostic identity the app
 * uses as its sync/dedup key — runId is NOT persisted upstream.
 */

export interface FridayHistoryImage {
  mimeType?: string;
  /** Base64 payload for inline ImageContent blocks. */
  data?: string;
  /** URL for `[media attached: ...]` markers or resolved `MEDIA:` attachments. */
  url?: string;
  /** Display/download filename (set for resolved `MEDIA:` attachments). */
  filename?: string;
}

export interface FridayHistoryToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface FridayHistoryToolResult {
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  text?: string;
  images?: FridayHistoryImage[];
}

export interface FridayHistoryUsage {
  totalTokens?: number;
  input?: number;
  output?: number;
}

export type FridayHistoryRole = "user" | "assistant" | "toolResult" | "system";

export interface FridayHistoryMessage {
  /** Stable transcript entry id (sync key). Synthetic when upstream omitted it. */
  id: string;
  seq: number;
  ts?: number;
  role: FridayHistoryRole;
  text?: string;
  thinking?: string;
  toolCalls?: FridayHistoryToolCall[];
  toolResult?: FridayHistoryToolResult;
  images?: FridayHistoryImage[];
  /** Raw `MEDIA:<path>` server paths stripped from text; the handler resolves
   *  them to downloadable `/friday-next/files/...` attachment URLs. */
  mediaPaths?: string[];
  model?: string;
  usage?: FridayHistoryUsage;
  /** Non-message records surfaced for context (e.g. compaction dividers). */
  kind?: "compaction";
  /** True when `id` was synthesized because upstream had no stable id. */
  synthetic?: boolean;
}

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** `MEDIA:<path>` lines emitted for outbound attachments (e.g. generated images). */
const MEDIA_LINE_RE = /^[ \t]*MEDIA:[ \t]*(\S.*?)[ \t]*$/gim;

/** Strips `MEDIA:<path>` lines from text, returning the cleaned text + the paths. */
function splitMediaLines(text: string): { text: string; paths: string[] } {
  if (!text.includes("MEDIA:")) return { text, paths: [] };
  const paths: string[] = [];
  const cleaned = text
    .replace(MEDIA_LINE_RE, (_m, p: string) => {
      const v = p.trim();
      if (v) paths.push(v);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, paths };
}

const MEDIA_MARKER_RE = /\[media attached:\s*([^\]]+)\]/gi;

/** Pull `[media attached: <url>]` markers out of free text into image refs. */
function extractMediaMarkers(text: string): FridayHistoryImage[] {
  const images: FridayHistoryImage[] = [];
  for (const match of text.matchAll(MEDIA_MARKER_RE)) {
    const url = match[1]?.trim();
    if (url) images.push({ url });
  }
  return images;
}

interface ParsedContent {
  text: string;
  thinking: string;
  toolCalls: FridayHistoryToolCall[];
  images: FridayHistoryImage[];
}

function parseContent(content: unknown): ParsedContent {
  const out: ParsedContent = { text: "", thinking: "", toolCalls: [], images: [] };

  if (typeof content === "string") {
    out.text = content;
    out.images.push(...extractMediaMarkers(content));
    return out;
  }
  if (!Array.isArray(content)) return out;

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    switch (block.type) {
      case "text": {
        const t = readString(block.text);
        if (t) {
          textParts.push(t);
          out.images.push(...extractMediaMarkers(t));
        }
        break;
      }
      case "thinking": {
        const t = readString(block.thinking);
        if (t) thinkingParts.push(t);
        break;
      }
      case "image": {
        const data = readString(block.data);
        const url = readString(block.url);
        // Skip empty image blocks (no payload and no URL) — they'd render as
        // broken attachment bubbles in the app.
        if (data || url) {
          out.images.push({
            ...(readString(block.mimeType) ? { mimeType: readString(block.mimeType) } : {}),
            ...(data ? { data } : {}),
            ...(url ? { url } : {}),
          });
        }
        break;
      }
      case "toolCall": {
        const id = readString(block.id);
        const name = readString(block.name);
        if (id && name) {
          out.toolCalls.push({
            id,
            name,
            ...(asRecord(block.arguments) ? { arguments: asRecord(block.arguments) } : {}),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  out.text = textParts.join("");
  out.thinking = thinkingParts.join("");
  return out;
}

function parseUsage(raw: unknown): FridayHistoryUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const totalTokens = readFiniteNumber(usage.totalTokens) ?? readFiniteNumber(usage.total);
  const input = readFiniteNumber(usage.input);
  const output = readFiniteNumber(usage.output);
  if (totalTokens === undefined && input === undefined && output === undefined) return undefined;
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function normalizeRole(raw: unknown): FridayHistoryRole {
  const role = readString(raw)?.toLowerCase();
  switch (role) {
    case "user":
      return "user";
    case "toolresult":
      return "toolResult";
    case "system":
      return "system";
    default:
      return "assistant";
  }
}

/**
 * Normalize one raw transcript message. `index` is the position in the returned
 * batch, used only to synthesize a stable-ish id when upstream omits one.
 */
export function normalizeHistoryMessage(
  raw: unknown,
  index: number,
): FridayHistoryMessage | null {
  const record = asRecord(raw);
  if (!record) return null;

  const meta = asRecord(record.__openclaw);
  const role = normalizeRole(record.role);
  const parsed = parseContent(record.content);

  const seq = readFiniteNumber(meta?.seq) ?? index + 1;
  const metaId = readString(meta?.id);
  const id = metaId ?? `seq:${seq}`;
  const synthetic = metaId === undefined;
  const ts = readFiniteNumber(meta?.recordTimestampMs) ?? readFiniteNumber(record.timestamp);
  const kind = readString(meta?.kind) === "compaction" ? "compaction" : undefined;

  const message: FridayHistoryMessage = {
    id,
    seq,
    role,
    ...(ts !== undefined ? { ts } : {}),
    ...(synthetic ? { synthetic: true } : {}),
    ...(kind ? { kind } : {}),
  };

  if (kind === "compaction") {
    message.text = parsed.text || "Compaction";
    return message;
  }

  if (role === "toolResult") {
    const split = splitMediaLines(parsed.text);
    const toolResult: FridayHistoryToolResult = {
      ...(readString(record.toolCallId) ? { toolCallId: readString(record.toolCallId) } : {}),
      ...(readString(record.toolName) ? { toolName: readString(record.toolName) } : {}),
      ...(record.isError === true ? { isError: true } : {}),
      ...(split.text ? { text: split.text } : {}),
      ...(parsed.images.length ? { images: parsed.images } : {}),
    };
    message.toolResult = toolResult;
    if (split.paths.length) message.mediaPaths = split.paths;
    return message;
  }

  const split = splitMediaLines(parsed.text);
  if (split.text) message.text = split.text;
  if (split.paths.length) message.mediaPaths = split.paths;
  if (parsed.thinking) message.thinking = parsed.thinking;
  if (parsed.toolCalls.length) message.toolCalls = parsed.toolCalls;
  if (parsed.images.length) message.images = parsed.images;

  const model = readString(record.model) ?? readString(record.responseModel);
  if (model) message.model = model;
  const usage = parseUsage(record.usage);
  if (usage) message.usage = usage;

  return message;
}

/** Normalize a batch of raw transcript messages, dropping unparseable entries. */
export function normalizeHistoryMessages(rawMessages: unknown[]): FridayHistoryMessage[] {
  const out: FridayHistoryMessage[] = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    const normalized = normalizeHistoryMessage(rawMessages[i], i);
    if (normalized) out.push(normalized);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
