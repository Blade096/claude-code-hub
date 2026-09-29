import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { textTransformSettings } from "@/drizzle/schema";
import { type TextTransformConfig, textTransformConfigSchema } from "@/lib/text-transform/schema";

export async function getTextTransformSettings() {
  const [row] = await db
    .select()
    .from(textTransformSettings)
    .where(eq(textTransformSettings.id, 1))
    .limit(1);
  return row
    ? { config: textTransformConfigSchema.parse(row.config), revision: row.revision }
    : null;
}

/** revision 条件在数据库中原子执行，避免旧页面覆盖新配置。 */
export async function saveTextTransformSettings(config: TextTransformConfig, revision: number) {
  const validated = textTransformConfigSchema.parse(config);
  if (revision === 0) {
    const [row] = await db
      .insert(textTransformSettings)
      .values({ id: 1, config: validated, revision: 1 })
      .onConflictDoNothing()
      .returning();
    return row ? { config: validated, revision: row.revision } : null;
  }
  const [row] = await db
    .update(textTransformSettings)
    .set({ config: validated, revision: revision + 1, updatedAt: new Date() })
    .where(and(eq(textTransformSettings.id, 1), eq(textTransformSettings.revision, revision)))
    .returning();
  return row ? { config: validated, revision: row.revision } : null;
}
