type Row = Record<string, unknown>;
type Node = { parent: string | null; index: number; control: boolean };

const canonical = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "reset",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const record = (value: unknown): Row | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const parent = (value: unknown): string | null | undefined => (value === null ? null : id(value));

/**
 * 对齐 OpenClaw transcript-tree / transcript-visible-events 的活动路径语义。
 * loadTranscriptEventsSync 返回追加式 DAG，leaf 是导航控制而非删除标记；
 * 分页、全文明细和恢复快照都必须先选活动路径，再过滤 message。
 * 旧版无父指针的线性记录继续沿用原有读取行为。
 */
export function activeTranscriptIndices(records: readonly unknown[]): Set<number> | undefined {
  if (
    !records.some((value) => {
      const row = record(value);
      return row?.type === "leaf" || (!!row && Object.hasOwn(row, "parentId"));
    })
  )
    return undefined;

  const nodes = new Map<string, Node>();
  const resetDescendants = new Set<string>();
  let afterReset = false;
  let leaf: string | null = null;
  let appendCursor: string | null = null;
  let selected = false;

  const throughControls = (start: string | null): string | null => {
    let current = start;
    const seen = new Set<string>();
    while (current !== null) {
      if (seen.has(current)) throw new Error("Cyclic transcript leaf control");
      seen.add(current);
      const node = nodes.get(current);
      if (!node?.control) return current;
      current = node.parent;
    }
    return null;
  };

  for (const [index, value] of records.entries()) {
    const row = record(value);
    if (!row || row.type === "session") continue;
    const entryId = id(row.id);
    if (!entryId) continue;
    const explicit = Object.hasOwn(row, "parentId");
    const isCanonical = canonical.has(String(row.type));
    if (!explicit && !isCanonical) continue;
    let entryParent = explicit ? parent(row.parentId) : leaf;
    if (entryParent === undefined) continue;

    if (row.type === "leaf") {
      let target = parent(row.targetId);
      let appendParent = row.appendParentId === undefined ? target : parent(row.appendParentId);
      if (
        afterReset &&
        leaf !== null &&
        (target === null || (target !== undefined && !resetDescendants.has(target)))
      ) {
        target = leaf;
        appendParent = leaf;
      }
      // 不把损坏或未知的切点当作完整历史返回，避免客户端据此恢复已移出的尾部。
      if (
        target === undefined ||
        appendParent === undefined ||
        (target !== null && !nodes.has(target)) ||
        (appendParent !== null && !nodes.has(appendParent))
      ) {
        throw new Error("Invalid transcript leaf control");
      }
      nodes.set(entryId, { parent: throughControls(target), index, control: true });
      leaf = target;
      appendCursor = appendParent;
      selected = true;
      continue;
    }

    if (isCanonical && row.appendMode !== "side") {
      if (
        (afterReset && (entryParent === null || !resetDescendants.has(entryParent))) ||
        (entryParent !== null && !nodes.has(entryParent) && leaf !== null) ||
        (explicit && entryParent === appendCursor && leaf !== appendCursor)
      )
        entryParent = leaf;
    }
    entryParent = throughControls(entryParent);
    nodes.set(entryId, { parent: entryParent, index, control: false });
    if (row.type === "reset") {
      afterReset = true;
      resetDescendants.clear();
      resetDescendants.add(entryId);
    } else if (entryParent !== null && resetDescendants.has(entryParent))
      resetDescendants.add(entryId);
    appendCursor = entryId;
    if (isCanonical && row.appendMode !== "side") {
      leaf = entryId;
      selected = true;
    }
  }
  if (!selected) return undefined;
  const visible = new Set<number>();
  const seen = new Set<string>();
  while (leaf !== null) {
    if (seen.has(leaf)) throw new Error("Cyclic transcript ancestry");
    seen.add(leaf);
    const node = nodes.get(leaf);
    if (!node) break;
    if (!node.control) visible.add(node.index);
    leaf = node.parent;
  }
  return visible;
}
