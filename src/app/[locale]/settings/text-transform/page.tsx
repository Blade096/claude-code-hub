import { getTranslations } from "next-intl/server";
import { SettingsPageHeader } from "../_components/settings-page-header";
import { TextTransformForm } from "./text-transform-form";

export default async function TextTransformPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings.textTransform" });
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} icon="shield-alert" />
      <TextTransformForm />
    </>
  );
}
