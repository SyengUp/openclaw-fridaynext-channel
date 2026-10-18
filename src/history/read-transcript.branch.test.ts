import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { transcriptRecordsToRawMessagePage } from "./read-transcript.js";

const records: Array<Record<string, unknown>> = [
  { type: "session", id: "header" },
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "第一条" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "第一答" } },
  { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "第二条" } },
  { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "第二答" } },
];
function ids(rows: unknown[]) {
  return rows.map((row) => (row as { __openclaw: { id: string } }).__openclaw.id);
}

describe("活动分支历史投影", () => {
  it("真实 2026.10.1 追加式记录的两次回退不会泄漏保留分支", () => {
    const fixture = JSON.parse(
      fs.readFileSync(new URL("./fixtures/rewind-active-path.json", import.meta.url), "utf8"),
    ) as { records: Array<Record<string, unknown>> };
    expect(transcriptRecordsToRawMessagePage(fixture.records, 200, 0)).toEqual({
      rawMessages: [],
      totalRecords: 0,
    });
    const beforeLastRewind = fixture.records.slice(0, -1);
    expect(ids(transcriptRecordsToRawMessagePage(beforeLastRewind, 200, 0).rawMessages)).toEqual(
      fixture.records
        .filter((row) => row.type === "message")
        .slice(0, 2)
        .map((row) => row.id),
    );
  });
  it("回退保留的旧尾部不能进入当前历史窗口", () => {
    const page = transcriptRecordsToRawMessagePage(
      [...records, { type: "leaf", id: "rewind", parentId: "a2", targetId: "a1" }],
      200,
      0,
    );
    expect(ids(page.rawMessages)).toEqual(["u1", "a1"]);
    expect(page.totalRecords).toBe(2);
  });

  it("回退到第一条之前产生权威空路径", () => {
    const page = transcriptRecordsToRawMessagePage(
      [...records, { type: "leaf", id: "rewind", parentId: "a2", targetId: null }],
      200,
      0,
    );
    expect(page).toEqual({ rawMessages: [], totalRecords: 0 });
  });

  it("新回复跨过 leaf 控制记录继续，分页只计算活动路径", () => {
    const branched = [
      ...records,
      { type: "leaf", id: "rewind", parentId: "a2", targetId: "a1" },
      {
        type: "message",
        id: "u3",
        parentId: "rewind",
        message: { role: "user", content: "新分支" },
      },
      {
        type: "message",
        id: "a3",
        parentId: "u3",
        message: { role: "assistant", content: "新回复" },
      },
    ];
    expect(ids(transcriptRecordsToRawMessagePage(branched, 2, 0).rawMessages)).toEqual([
      "u3",
      "a3",
    ]);
    expect(ids(transcriptRecordsToRawMessagePage(branched, 2, 2).rawMessages)).toEqual([
      "u1",
      "a1",
    ]);
    expect(transcriptRecordsToRawMessagePage(branched, 2, 0).totalRecords).toBe(4);
  });

  it("旧版无 parentId 的线性记录继续完整读取", () => {
    const legacy = records.map(({ parentId: _parent, ...row }) => row);
    expect(ids(transcriptRecordsToRawMessagePage(legacy, 200, 0).rawMessages)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  it("旧追加游标不会把新消息接回已移出的尾部", () => {
    const page = transcriptRecordsToRawMessagePage(
      [
        ...records,
        { type: "leaf", id: "rewind", parentId: "a2", targetId: "a1", appendParentId: "a2" },
        { type: "message", id: "u3", parentId: "a2", message: { role: "user", content: "新消息" } },
      ],
      200,
      0,
    );
    expect(ids(page.rawMessages)).toEqual(["u1", "a1", "u3"]);
  });

  it("侧边元数据不改变当前路径，后续正文接回可见叶子", () => {
    const page = transcriptRecordsToRawMessagePage(
      [
        ...records,
        { type: "leaf", id: "rewind", parentId: "a2", targetId: "a1" },
        { type: "custom", id: "side", parentId: "a2", appendMode: "side" },
        {
          type: "message",
          id: "u3",
          parentId: "side",
          message: { role: "user", content: "新消息" },
        },
      ],
      200,
      0,
    );
    expect(ids(page.rawMessages)).toEqual(["u1", "a1", "u3"]);
  });

  it("未知切点拒绝返回旧分支", () => {
    expect(() =>
      transcriptRecordsToRawMessagePage(
        [...records, { type: "leaf", id: "invalid", parentId: "a2", targetId: "missing" }],
        200,
        0,
      ),
    ).toThrow("Invalid transcript leaf control");
  });

  it("压缩边界投影成系统消息并带上 tokensBefore", () => {
    // Core appends the boundary onto the live leaf and continues from it, so the
    // records after it must be re-parented onto the boundary (a sibling would be
    // an abandoned branch and correctly fall out of the active path).
    const withCompaction = [
      ...records.slice(0, 3),
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: "2026-10-01T00:00:00.000Z",
        summary: "早期对话摘要",
        firstKeptEntryId: "u2",
        tokensBefore: 185_000,
        __openclaw: { runId: "run-7", itemId: "item-2" },
      },
      { ...records[3], parentId: "c1" },
      records[4],
    ];
    const page = transcriptRecordsToRawMessagePage(withCompaction, 200, 0);
    expect(ids(page.rawMessages)).toEqual(["u1", "a1", "c1", "u2", "a2"]);
    expect(page.rawMessages[2]).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      __openclaw: {
        kind: "compaction",
        id: "c1",
        seq: 3,
        runId: "run-7",
        itemId: "item-2",
        tokensBefore: 185_000,
      },
    });
  });

  it("被回退移出的压缩边界不进入当前历史窗口", () => {
    const page = transcriptRecordsToRawMessagePage(
      [
        ...records.slice(0, 3),
        { type: "compaction", id: "c-old", parentId: "u2", tokensBefore: 10 },
        ...records.slice(3),
        { type: "leaf", id: "rewind", parentId: "a2", targetId: "a1" },
      ],
      200,
      0,
    );
    expect(ids(page.rawMessages)).toEqual(["u1", "a1"]);
  });
});
