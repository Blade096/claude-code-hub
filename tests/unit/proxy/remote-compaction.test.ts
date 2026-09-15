import { describe, expect, it } from "vitest";
import {
  buildCompactionSummaryInput,
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_SUMMARY_INSTRUCTION,
  decodeCompactionSummary,
  encodeCompactionSummary,
  expandCompactionReplayItems,
  isCchCompactionReplayItem,
  isRemoteCompactionV2Request,
  normalizeInputWithoutTrigger,
  REMOTE_COMPACTION_TOKEN_PREFIX,
  RemoteCompactionTokenError,
} from "@/app/v1/_lib/proxy/remote-compaction";

const RESPONSES_PATH = "/v1/responses";

function token(summary: string): string {
  return encodeCompactionSummary({
    summary,
    model: "deepseek-v4-pro",
    createdAtSeconds: 1_700_000_000,
  });
}

describe("remote compaction v2 request classification", () => {
  it("recognizes an exact compaction_trigger item on the Responses endpoint", () => {
    expect(
      isRemoteCompactionV2Request(RESPONSES_PATH, {
        input: [{ role: "user", content: "keep this" }, { type: "compaction_trigger" }],
      })
    ).toBe(true);
  });

  it("recognizes a single compaction_trigger input object", () => {
    expect(
      isRemoteCompactionV2Request(RESPONSES_PATH, { input: { type: "compaction_trigger" } })
    ).toBe(true);
  });

  it.each([
    ["different endpoint", "/v1/chat/completions", [{ type: "compaction_trigger" }]],
    ["future item type", RESPONSES_PATH, [{ type: "compaction_trigger_v2" }]],
    ["nested marker", RESPONSES_PATH, [{ content: { type: "compaction_trigger" } }]],
    ["string marker", RESPONSES_PATH, ["compaction_trigger"]],
    ["replay item only", RESPONSES_PATH, [{ type: "compaction", encrypted_content: "opaque" }]],
    ["empty input", RESPONSES_PATH, []],
  ])("does not infer compaction from %s", (_label, pathname, input) => {
    expect(isRemoteCompactionV2Request(pathname, { input })).toBe(false);
  });

  it("ignores non-object bodies", () => {
    expect(isRemoteCompactionV2Request(RESPONSES_PATH, null)).toBe(false);
    expect(isRemoteCompactionV2Request(RESPONSES_PATH, "input")).toBe(false);
  });
});

describe("compaction token codec", () => {
  it("round-trips a summary", () => {
    const encoded = token("keep the migration plan");
    expect(encoded.startsWith(REMOTE_COMPACTION_TOKEN_PREFIX)).toBe(true);

    const decoded = decodeCompactionSummary(encoded);
    expect(decoded.s).toBe("keep the migration plan");
    expect(decoded.m).toBe("deepseek-v4-pro");
    expect(decoded.v).toBe(2);
  });

  it("rejects tokens that were not produced by CCH", () => {
    expect(() => decodeCompactionSummary("gAAAAABopaque-openai-token")).toThrow(
      RemoteCompactionTokenError
    );
    try {
      decodeCompactionSummary("gAAAAABopaque-openai-token");
    } catch (error) {
      expect((error as RemoteCompactionTokenError).code).toBe(
        "REMOTE_COMPACTION_TOKEN_UNSUPPORTED"
      );
      expect((error as RemoteCompactionTokenError).status).toBe(422);
    }
  });

  it("rejects corrupt payloads", () => {
    expect(() => decodeCompactionSummary(`${REMOTE_COMPACTION_TOKEN_PREFIX}not-base64!!`)).toThrow(
      RemoteCompactionTokenError
    );
  });

  it("rejects unsupported versions and empty summaries", () => {
    const wrongVersion = `${REMOTE_COMPACTION_TOKEN_PREFIX}${Buffer.from(
      JSON.stringify({ v: 1, s: "old", m: null, t: 0 }),
      "utf8"
    ).toString("base64url")}`;
    expect(() => decodeCompactionSummary(wrongVersion)).toThrow(RemoteCompactionTokenError);

    const emptySummary = `${REMOTE_COMPACTION_TOKEN_PREFIX}${Buffer.from(
      JSON.stringify({ v: 2, s: "   ", m: null, t: 0 }),
      "utf8"
    ).toString("base64url")}`;
    expect(() => decodeCompactionSummary(emptySummary)).toThrow(RemoteCompactionTokenError);
  });
});

describe("compaction replay expansion", () => {
  it("replaces CCH tokens in place and keeps order", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "early" }] },
      { type: "compaction", id: "cmp_1", encrypted_content: token("summary one") },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "middle" }] },
      { type: "compaction", id: "cmp_2", encrypted_content: token("summary two") },
      { type: "message", role: "user", content: [{ type: "input_text", text: "late" }] },
    ];

    const { items, expanded } = expandCompactionReplayItems(input);

    expect(expanded).toBe(2);
    expect(items).toHaveLength(5);
    expect((items[0] as Record<string, unknown>).type).toBe("message");
    expect(JSON.stringify(items[1])).toContain(COMPACTION_CHECKPOINT_MARKER);
    expect(JSON.stringify(items[1])).toContain("summary one");
    expect((items[2] as Record<string, unknown>).type).toBe("message");
    expect(JSON.stringify(items[3])).toContain("summary two");
    expect((items[4] as Record<string, unknown>).type).toBe("message");
  });

  it("leaves native OpenAI tokens untouched", () => {
    const native = { type: "compaction", id: "cmp_native", encrypted_content: "gAAAAABopaque" };
    expect(isCchCompactionReplayItem(native)).toBe(false);

    const { items, expanded } = expandCompactionReplayItems([native]);
    expect(expanded).toBe(0);
    expect(items[0]).toBe(native);
  });

  it("fails loudly instead of dropping broken history", () => {
    const broken = {
      type: "compaction",
      id: "cmp_broken",
      encrypted_content: `${REMOTE_COMPACTION_TOKEN_PREFIX}@@@`,
    };
    expect(() => expandCompactionReplayItems([broken])).toThrow(RemoteCompactionTokenError);
  });
});

describe("compaction summary input", () => {
  it("drops the trigger, expands old tokens and appends the instruction last", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
      { type: "compaction", id: "cmp_old", encrypted_content: token("older summary") },
      { type: "message", role: "user", content: [{ type: "input_text", text: "recent" }] },
      { type: "compaction_trigger" },
    ];

    const result = buildCompactionSummaryInput(input);

    expect(result).toHaveLength(4);
    expect(JSON.stringify(result[0])).toContain("task");
    expect(JSON.stringify(result[1])).toContain("older summary");
    expect(JSON.stringify(result[2])).toContain("recent");
    expect(JSON.stringify(result.at(-1))).toContain(COMPACTION_SUMMARY_INSTRUCTION.slice(0, 20));
    expect(JSON.stringify(result.at(-1))).toContain("不要调用任何工具");
    expect(JSON.stringify(result)).not.toContain("compaction_trigger");
  });

  it("normalizes a single-object input", () => {
    const { items, removedTrigger } = normalizeInputWithoutTrigger({ type: "compaction_trigger" });
    expect(items).toHaveLength(0);
    expect(removedTrigger).toBe(true);
  });
});
