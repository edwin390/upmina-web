import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import CosplaySection from "@/components/cosplay/CosplaySection";

export default function CosplayPage() {
  return (
    <CosplayLocaleProvider>
      <CosplaySection />
    </CosplayLocaleProvider>
  );
}
