import LegalLayout, {
  ContactLink,
  LegalList,
  LegalSection,
} from "@/components/legal/LegalLayout";

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <LegalSection title="1. About Upmina Web">
        <p>
          Upmina Web (the &ldquo;Site&rdquo;) is an independent, fan-made website
          dedicated to the content creator UpMinaa. It brings together links, embedded
          players and previews of content that UpMinaa publishes on other platforms. The
          Site is provided free of charge by the fans who maintain it (&ldquo;we&rdquo;,
          &ldquo;us&rdquo;).
        </p>
        <p>
          The Site is not an official website or application of UpMinaa, TikTok, Twitch,
          YouTube, Instagram, or any other platform mentioned on it, and it is not
          affiliated with, endorsed by, or sponsored by any of them.
        </p>
      </LegalSection>

      <LegalSection title="2. Acceptance of these terms">
        <p>
          By accessing or using the Site you agree to these Terms of Service. If you do
          not agree, please do not use the Site.
        </p>
      </LegalSection>

      <LegalSection title="3. Acceptable use">
        <p>
          You may browse the Site for personal, non-commercial purposes. You agree not to:
        </p>
        <LegalList>
          <li>use the Site in violation of any applicable law or third-party right;</li>
          <li>
            attempt to gain unauthorized access to the Site, its servers or related
            systems, or interfere with or overload them;
          </li>
          <li>
            use automated means to copy, scrape or overload the Site in a way that harms
            its operation;
          </li>
          <li>
            present the Site, or yourself, as officially connected to UpMinaa or to any
            platform displayed on the Site.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="4. Content from external platforms">
        <p>
          Much of what appears on the Site &mdash; live stream status, videos, Shorts,
          clips, photos and similar material &mdash; comes from external platforms such as
          Twitch, YouTube, Instagram and TikTok, through their embeds or public
          interfaces. We do not host, control or moderate that content, and it may change,
          move or disappear at any time without notice.
        </p>
        <p>
          Use of that content is also subject to the terms and policies of the platform
          that provides it.
        </p>
      </LegalSection>

      <LegalSection title="5. Ownership and trademarks">
        <p>
          All content displayed on the Site belongs to its respective owners, including
          UpMinaa and the authors of clips and other material. Names, logos and trademarks
          of UpMinaa, TikTok, Twitch, YouTube, Instagram and other third parties belong to
          their respective owners and are used only to identify them. The Site claims no
          ownership over that content or those marks.
        </p>
        <p>
          The source code of the Site is distributed under the MIT License. That license
          does not apply to third-party content shown on the Site.
        </p>
        <p>
          If you are a rights holder and believe something on the Site infringes your
          rights, please contact us (see &ldquo;Contact&rdquo; below) and we will review
          the request and remove the content where appropriate.
        </p>
      </LegalSection>

      <LegalSection title="6. Links and external services">
        <p>
          The Site contains links to, and embeds of, services we do not own or operate. We
          are not responsible for their content, availability, privacy practices or terms.
          You use those services at your own discretion and under their own terms.
        </p>
      </LegalSection>

      <LegalSection title="7. Fan-submitted content">
        <p>
          Some sections of the Site are designed for content shared by the fan community.
          If such features are made available, people who submit content must be its
          authors or have the right to share it, and we may remove any content at our
          discretion, in particular content that infringes rights or is unlawful, harmful
          or misleading.
        </p>
      </LegalSection>

      <LegalSection title="8. Availability of the Site">
        <p>
          The Site is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We do
          not guarantee that it will be uninterrupted, error-free or that any particular
          content or feature will remain available. We may change, suspend or discontinue
          any part of the Site at any time.
        </p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>
          To the extent permitted by applicable law, we are not liable for any loss or
          damage arising from your use of, or inability to use, the Site, or from
          third-party content, links or services accessed through it. Nothing in these
          terms limits any liability that cannot be limited by law.
        </p>
      </LegalSection>

      <LegalSection title="10. Changes to these terms">
        <p>
          We may update these Terms of Service from time to time. The current version is
          published on this page with its effective date. Continuing to use the Site after
          a change means you accept the updated terms.
        </p>
      </LegalSection>

      <LegalSection title="11. Contact">
        <p>
          Questions about these terms, or requests related to content on the Site, can be
          sent to <ContactLink />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
