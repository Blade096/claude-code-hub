import { beforeEach, expect, it, vi } from "vitest";
vi.unmock("@/repository/text-transform");
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  values: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  conflict: vi.fn(),
}));
vi.mock("@/drizzle/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows }) }) }),
    insert: () => ({
      values: (data: unknown) => {
        mocks.values(data);
        return {
          onConflictDoNothing: () => {
            mocks.conflict();
            return { returning: async () => mocks.rows };
          },
        };
      },
    }),
    update: () => ({
      set: (data: unknown) => {
        mocks.set(data);
        return {
          where: (condition: unknown) => {
            mocks.where(condition);
            return { returning: async () => mocks.rows };
          },
        };
      },
    }),
  },
}));
import { PgDialect } from "drizzle-orm/pg-core";
import { getTextTransformSettings, saveTextTransformSettings } from "@/repository/text-transform";
const config = { enabled: false, caseSensitive: true, rules: [] };
beforeEach(() => {
  mocks.rows = [];
});
it("不存在记录时返回 null，已有记录严格验证", async () => {
  expect(await getTextTransformSettings()).toBeNull();
  mocks.rows = [{ config, revision: 2 }];
  expect(await getTextTransformSettings()).toEqual({ config, revision: 2 });
  mocks.rows = [{ config: {}, revision: 2 }];
  await expect(getTextTransformSettings()).rejects.toThrow();
});
it("首次保存不覆盖并发插入，已有记录使用 ID 和版本共同约束", async () => {
  expect(await saveTextTransformSettings(config, 0)).toBeNull();
  expect(mocks.conflict).toHaveBeenCalled();
  mocks.rows = [{ config, revision: 1 }];
  expect(await saveTextTransformSettings(config, 0)).toEqual({ config, revision: 1 });
  expect(mocks.values).toHaveBeenCalledWith({ id: 1, config, revision: 1 });
  mocks.rows = [{ config, revision: 3 }];
  expect(await saveTextTransformSettings(config, 2)).toEqual({ config, revision: 3 });
  const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
  expect(query.params).toEqual([1, 2]);
  expect(mocks.set.mock.calls[0][0]).toMatchObject({ revision: 3, config });
  mocks.rows = [];
  expect(await saveTextTransformSettings(config, 2)).toBeNull();
});
