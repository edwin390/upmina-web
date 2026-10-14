import LegalLayout, {
  ContactLink,
  LegalList,
  LegalSection,
} from "@/components/legal/LegalLayout";

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <LegalSection title="1. Overview">
        <p>
          This Privacy Policy explains what information may be processed when you visit
          Upmina Web (the &ldquo;Site&rdquo;), an independent fan website dedicated to
          UpMinaa. The Site is not an official website or application of UpMinaa, TikTok,
          Twitch, YouTube, Instagram, or any other platform it displays.
        </p>
      </LegalSection>

      <LegalSection title="2. Information Upmina Web processes directly">
        <p>
          You can browse the Site without an account and without providing personal
          information. Community features are optional and require an account; the data
          involved is described in section 5. We do not include analytics or advertising
          tools in the Site, and we do not build profiles of visitors.
        </p>
        <p>
          The Site does not set its own cookies. If you sign in, your browser&rsquo;s
          local storage keeps your session so that you stay signed in until you sign out,
          and your language preference may also be stored there. Content you view is
          cached temporarily in your browser&rsquo;s memory to make navigation faster and
          is discarded when you close the page.
        </p>
      </LegalSection>

      <LegalSection title="3. Requests to external services">
        <p>Using the Site involves requests to services operated by third parties:</p>
        <LegalList>
          <li>
            <strong className="text-text-primary">Hosting.</strong> The Site is hosted on
            Vercel. As with any web hosting, your connection data (such as IP address,
            browser type, pages requested and time of the request) is technically handled
            by the hosting infrastructure to deliver the Site.
          </li>
          <li>
            <strong className="text-text-primary">Fonts.</strong> The Site loads fonts
            from Google Fonts, so your browser connects to Google servers when a page
            loads.
          </li>
          <li>
            <strong className="text-text-primary">Channel data.</strong> The Site&rsquo;s
            servers request public information about UpMinaa&rsquo;s channels (for example
            live status, latest videos and clips) from the Twitch, YouTube, Instagram and
            TikTok interfaces, where those integrations are enabled. These requests are
            made by our servers, not by your browser, and they do not contain information
            about you.
          </li>
          <li>
            <strong className="text-text-primary">Images and thumbnails.</strong> Preview
            images are loaded directly from the platforms&rsquo; servers (for example
            Twitch and YouTube).
          </li>
        </LegalList>
        <p>
          Those services receive the normal technical information that any web connection
          involves, such as your IP address and browser details, and handle it under their
          own privacy policies. We do not control how long they keep it.
        </p>
      </LegalSection>

      <LegalSection title="4. Embedded content and external links">
        <p>
          Some pages embed players and posts from third parties, such as the Twitch player
          and clips, YouTube videos, and TikTok or Instagram content. When that content
          loads, the provider may receive technical information from your browser and may
          set its own cookies or use similar technologies. We do not control this; please
          refer to the privacy policies of each provider.
        </p>
        <p>
          The Site also links to external websites. We are not responsible for their
          privacy practices once you leave the Site.
        </p>
      </LegalSection>

      <LegalSection title="5. Community accounts and account deletion">
        <p>
          Community features require an account. To run them we process your email address
          (to sign in and to send verification and account emails), the username and
          profile you choose, and the posts, likes and files you create, together with the
          reports, moderation records and copyright notices that relate to content on the
          Site.
        </p>
        <p>
          <strong className="text-text-primary">Deleting your account.</strong> You can
          request the permanent deletion of your account from your account settings. We
          send a confirmation link to your email address; it is valid for 30 minutes and
          works only once. To finish, you must open it, sign in with the same account and
          confirm explicitly. Deletion is irreversible: as soon as you confirm, access to
          the account is blocked, your sessions end and the account cannot be restored.
        </p>
        <p>
          After access is blocked, a cleanup process removes your profile, your posts and
          likes and the files you uploaded, and your username becomes available for other
          people to register; they do not inherit anything from your account. The cleanup
          runs in the background and may take some time; if a step fails it is retried.
        </p>
        <p>
          Some records may be kept under restricted access when they are needed for
          moderation, copyright claims, security and audit purposes, for example reports,
          moderation cases and decisions, sanctions, copyright claims and related notices,
          and the record of the deletion itself. They are used internally, are not shown
          publicly and may be linked to an internal account identifier. We have not yet
          defined how long each of these records is kept; this policy will be updated when
          that is decided.
        </p>
        <p>
          Backups maintained by our providers, caches and signed links that were already
          issued may still contain data for a limited time until they expire or are
          rotated; they are not erased instantly. Accounts with team roles follow a
          separate administrative procedure. To ask questions about your data, contact us
          at <ContactLink />.
        </p>
      </LegalSection>

      <LegalSection title="6. Future features that use OAuth">
        <p>
          Some future integrations (for example connecting a TikTok account) may use
          OAuth, where you or the account owner authorize Upmina Web through the
          platform&rsquo;s own consent screen. If that happens:
        </p>
        <LegalList>
          <li>we would process only the data that you authorize on that screen;</li>
          <li>
            we would use it only to provide the feature that requested it, such as
            displaying content from the authorized account on the Site;
          </li>
          <li>
            you could revoke the authorization at any time from that platform&rsquo;s
            settings, and you can also contact us to ask questions about it.
          </li>
        </LegalList>
        <p>These features are not currently active.</p>
      </LegalSection>

      <LegalSection title="7. No sale of personal data">
        <p>Upmina Web does not sell personal data.</p>
      </LegalSection>

      <LegalSection title="8. Your questions and requests">
        <p>
          If you have questions about this policy, or believe we hold personal information
          about you and want to ask about it, contact us at <ContactLink />.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to this policy">
        <p>
          We may update this Privacy Policy as the Site changes, for example if new
          features are added. The current version is published on this page with its
          effective date.
        </p>
      </LegalSection>

      <LegalSection title="10. Contact">
        <p>
          Privacy questions can be sent to <ContactLink />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
