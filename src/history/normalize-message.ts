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

/**
 * Tools whose `toolResult` carries a user-facing PRODUCED image, which stays a
 * chat attachment. Every OTHER tool's inline image block is the agent's visual
 * INPUT — a file the `read` tool fed to the model, a `canvas` snapshot, a
 * browser screenshot — and must NOT surface as an attachment on history rebuild
 * (it spawns phantom, often-corrupt bubbles for turns where the agent never
 * sent a file). Keep this a whitelist so any new image-CONSUMING tool is safe by
 * default; add new image-PRODUCING tools here explicitly.
 */
const IMAGE_PRODUCING_TOOLS = new Set(["image_generation"]);

const MEDIA_MARKER_RE = /\[media attached:\s*([^\]]+)\]/gi;

/**
 * Parse both Friday's legacy marker and core's facts-first persisted projection:
 *
 *   [media attached: file:///path/photo.jpg]
 *   [media attached: /staged/input-photo.jpg (image/jpeg) |
 *                    /friday-next/files/token.jpg "photo.jpg"]
 *
 * The latter must use the stable channel URL, not the gateway-local staged path.
 */
function parseMediaMarker(payload: string): FridayHistoryImage | null {
  const value = payload.trim();
  if (!value) return null;

  const projected = value.match(
    /^(.*?)\s+\(([^()]+)\)\s+\|\s+(\S+?)(?:\s+"([^"]+)")?\s*$/,
  );
  if (projected) {
    const url = projected[3]?.trim();
    if (!url) return null;
    const mimeType = projected[2]?.trim();
    const filename = projected[4]?.trim();
    return {
      url,
      ...(mimeType ? { mimeType } : {}),
      ...(filename ? { filename } : {}),
    };
  }

  return { url: value };
}

/** Pull `[media attached: ...]` markers out of free text into image refs. */
function extractMediaMarkers(text: string): FridayHistoryImage[] {
  const images: FridayHistoryImage[] = [];
  for (const match of text.matchAll(MEDIA_MARKER_RE)) {
    const image = match[1] ? parseMediaMarker(match[1]) : null;
    if (image) images.push(image);
  }
  return images;
}

/** Media markers are transport metadata, never user-visible prompt text. */
function stripMediaMarkers(text: string): string {
  return text
    .replace(MEDIA_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ParsedContent {
  text: string;
  thinking: string;
  toolCalls: FridayHistoryToolCall[];
  images: FridayHistoryImage[];
}

/**
 * OpenClaw often persists the same inbound photos twice on one user record:
 * `[media attached: file://…]` in the text (plugin injection) AND `{type:image,data}`
 * blocks of the same bytes (core). Prefer the file-backed markers — history can
 * resolve them to `/friday-next/files/…` — and drop as many leftover inline blocks
 * as there were markers. Extra inline-only images (no matching marker) stay.
 */
function collapseDuplicateInlineImages(images: FridayHistoryImage[]): FridayHistoryImage[] {
  const markerCount = images.filter((img) => Boolean(img.url) && !img.data).length;
  if (markerCount === 0) return images;
  let remaining = markerCount;
  const out: FridayHistoryImage[] = [];
  for (const img of images) {
    if (img.data && !img.url && remaining > 0) {
      remaining -= 1;
      continue;
    }
    out.push(img);
  }
  return out;
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
      case "toolResult":
      case "tool_result": {
        // Codex (app-server backend) persists an exec/bash tool's STDOUT in a content
        // block whose `type` is "toolResult" (not "text") — the output lives in the
        // block's `text`/`content`. The native/Anthropic path uses plain "text" blocks,
        // so this case was never hit and the command output was silently dropped from
        // history (`parsed.text` stayed ""), leaving the app's trace tool row with no
        // result. ControlUI shows it because its projection reads these blocks.
        const t = readString(block.text) || readString(block.content);
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
  out.images = collapseDuplicateInlineImages(out.images);
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
export function normalizeHistoryMessage(raw: unknown, index: number): FridayHistoryMessage | null {
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
    const toolName = readString(record.toolName);
    // Inline image blocks on a toolResult are almost always the agent's visual
    // INPUT — a file the `read` tool fed to the model, a `canvas` snapshot (so the
    // agent can "see" the rendered page), a browser screenshot — NOT a user-facing
    // attachment. Surfacing them spawns phantom, often-corrupt attachment bubbles on
    // history rebuild for turns where the agent never sent a file. Only tools that
    // PRODUCE a user-facing image keep their blocks. (This was a `canvas`-only
    // blacklist, which still leaked `read`/screenshot images.) The streaming deliver
    // path drops the canvas temp-file form separately (isCanvasSnapshotMediaPath in
    // http/handlers/messages.ts); this is the transcript-rebuild counterpart.
    const keepInlineImages = toolName ? IMAGE_PRODUCING_TOOLS.has(toolName) : false;
    const images = keepInlineImages ? parsed.images : [];
    const mediaPaths = toolName === "canvas" ? [] : split.paths;
    const toolResult: FridayHistoryToolResult = {
      ...(readString(record.toolCallId) ? { toolCallId: readString(record.toolCallId) } : {}),
      ...(toolName ? { toolName } : {}),
      ...(record.isError === true ? { isError: true } : {}),
      ...(split.text ? { text: split.text } : {}),
      ...(images.length ? { images } : {}),
    };
    message.toolResult = toolResult;
    if (mediaPaths.length) message.mediaPaths = mediaPaths;
    return message;
  }

  const visibleText = role === "user" ? stripMediaMarkers(parsed.text) : parsed.text;
  const split = splitMediaLines(visibleText);
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

/**
 * Normalize a batch of raw transcript messages, dropping unparseable entries.
 *
 * Also collapses records sharing an `idempotencyKey` (first record wins).
 * Codex-backed sessions can persist the same user prompt twice — once at run
 * start and once inside the run-end mirror batch — with distinct transcript
 * entry ids but the identical key (an upstream session-cache bug the key was
 * meant to prevent); without this the app renders duplicate user bubbles on
 * every history rebuild. Records without a key are still collapsed when they
 * are consecutive identical user prompts with no visible assistant between
 * them (OpenClaw 8.1 inbound+run-start replica, or a model-error restart
 * mirror with an empty assistant in between — see `collapseMirroredUserPrompts`).
 */
export function normalizeHistoryMessages(rawMessages: unknown[]): FridayHistoryMessage[] {
  const out: FridayHistoryMessage[] = [];
  const seenIdempotencyKeys = new Set<string>();
  for (let i = 0; i < rawMessages.length; i += 1) {
    const idempotencyKey = readString(asRecord(rawMessages[i])?.idempotencyKey);
    if (idempotencyKey) {
      if (seenIdempotencyKeys.has(idempotencyKey)) continue;
      seenIdempotencyKeys.add(idempotencyKey);
    }
    const normalized = normalizeHistoryMessage(rawMessages[i], i);
    if (normalized) out.push(normalized);
  }
  out.sort((a, b) => a.seq - b.seq);
  return collapseMirroredUserPrompts(out);
}

function historyMessageHasVisibleAssistantBody(message: FridayHistoryMessage): boolean {
  if (message.role !== "assistant") return false;
  if ((message.text ?? "").trim().length > 0) return true;
  if (message.thinking && message.thinking.trim().length > 0) return true;
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  if (message.images && message.images.length > 0) return true;
  if (message.mediaPaths && message.mediaPaths.length > 0) return true;
  return false;
}

/**
 * OpenClaw can persist the same user prompt twice without `idempotencyKey`:
 *
 *   - 8.1 SQLite: inbound user, then a run-start replica. Non-message events
 *     between them (`thinking_level_change` / `leaf` / `custom`) drop out of
 *     normalize, so the copies become adjacent.
 *   - Older hosts: send-time record, then a run-end mirror ~300ms later with
 *     an empty assistant in between (model-error restart-recovery).
 *
 * History rebuild would otherwise open a second user-only round and the iOS
 * surface paints two identical bubbles. Collapse when the previous user text
 * matches and nothing visible from the assistant sits between them — including
 * the adjacent case. A repeated prompt after a real reply is kept.
 */
function collapseMirroredUserPrompts(messages: FridayHistoryMessage[]): FridayHistoryMessage[] {
  const collapsed: FridayHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const incoming = (message.text ?? "").trim();
      if (incoming.length > 0) {
        let lastUserIndex = -1;
        let hasVisibleAssistantAfter = false;
        for (let i = collapsed.length - 1; i >= 0; i -= 1) {
          const prior = collapsed[i];
          if (prior.role === "user") {
            lastUserIndex = i;
            break;
          }
          if (historyMessageHasVisibleAssistantBody(prior)) {
            hasVisibleAssistantAfter = true;
            break;
          }
        }
        const lastUser = lastUserIndex >= 0 ? collapsed[lastUserIndex] : undefined;
        if (lastUser && (lastUser.text ?? "").trim() === incoming && !hasVisibleAssistantAfter) {
          continue;
        }
      }
    }
    collapsed.push(message);
  }
  return collapsed;
}
