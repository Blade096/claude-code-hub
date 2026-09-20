import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(__dirname, "../../..");
const operationsPath = resolve(repositoryRoot, "docs/codex-multi-agent-v2-portable-operations.md");
const operations = readFileSync(operationsPath, "utf8");

describe("Codex MultiAgentV2 portable operations documentation", () => {
  test("documents opt-in modes, plaintext disclosures and rollback without database downgrade", () => {
    expect(operations).toContain("默认关闭");
    expect(operations).toContain("`native`");
    expect(operations).toContain("`portable`");
    expect(operations).toContain("`disabled`");
    expect(operations).toContain("不是解密");
    expect(operations).toContain("STORE_SESSION_MESSAGES=true");
    expect(operations).toContain("LANGFUSE_PUBLIC_KEY");
    expect(operations).toContain("回滚不需要数据库降级");
  });

  test("documents qualification lifecycle, histories, transports and failure isolation", () => {
    for (const required of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "fork_turns=none",
      "Responses WebSocket",
      "compatibility_transport_unsupported",
      "主动取消",
      "idle timeout",
      "上游错误",
      "JSONL",
    ]) {
      expect(operations).toContain(required);
    }
  });

  test("documents fake-stream bypass, compaction semantics and product limits", () => {
    expect(operations).toContain("始终绕过 fake streaming");
    expect(operations).toContain("Remote compaction");
    for (const limitation of [
      "推理质量",
      "工具调用正确率",
      "上下文长度",
      "速率限制",
      "并发可靠性",
    ]) {
      expect(operations).toContain(limitation);
    }
  });

  test("keeps request collisions separate from response restoration failures", () => {
    expect(operations).toContain(
      "`compatibility_name_collision` | 请求工具名与 portable 保留名称冲突"
    );
    expect(operations).toContain(
      "`compatibility_restore_failed` | 上游响应缺失映射、名称无法唯一恢复"
    );
  });

  test("never contains credential-shaped example values", () => {
    expect(operations).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(operations).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
    expect(operations).not.toContain("example key");
  });
});
