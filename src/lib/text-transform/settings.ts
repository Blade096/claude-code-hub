import "server-only";
import { getTextTransformSettings } from "@/repository/text-transform";
import {
  emptyTextTransformConfig,
  type TextTransformSettings,
  textTransformConfigSchema,
} from "./schema";

type Stored = Awaited<ReturnType<typeof getTextTransformSettings>>;
let cache: { value: Stored; expires: number } | undefined;
let pending: Promise<Stored> | undefined;
let generation = 0;

export function invalidateTextTransformSettings(): void {
  generation++;
  cache = undefined;
  pending = undefined;
}

async function readStored(): Promise<Stored> {
  if (cache && cache.expires > Date.now()) return cache.value;
  if (pending) return pending;
  const version = generation;
  const task = getTextTransformSettings()
    .then((value) => {
      if (generation !== version) return readStored();
      cache = { value, expires: Date.now() + 5000 };
      return value;
    })
    .finally(() => {
      if (pending === task) pending = undefined;
    });
  pending = task;
  return task;
}

/** 数据库记录优先；仅尚未保存时继承环境配置。读取失败不使用旧缓存或默认值。 */
export async function getEffectiveTextTransformSettings(
  fresh = false
): Promise<TextTransformSettings> {
  const stored = fresh ? await getTextTransformSettings() : await readStored();
  if (stored) return { ...stored, source: "database" };
  const raw = process.env.CCH_TEXT_TRANSFORM;
  if (raw)
    return {
      config: textTransformConfigSchema.parse(JSON.parse(raw)),
      revision: 0,
      source: "environment",
    };
  return { config: structuredClone(emptyTextTransformConfig), revision: 0, source: "default" };
}
