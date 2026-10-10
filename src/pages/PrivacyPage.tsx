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
          You can browse the public parts of the Site without an account and without
          providing personal information. Creating an account is optional and is described
          in section 5. We do not include analytics or advertising tools in the Site, and
          we do not build profiles of visitors.
        </p>
        <p>
          The Site does not set its own cookies. Your browser&rsquo;s local storage is
          used for your language preference and, if you sign in, for the session that
          keeps you signed in. Content you view is also cached temporarily in your
          browser&rsquo;s memory to make navigation faster and is discarded when you close
          the page.
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
            <strong className="text-text-primary">Accounts and Community.</strong> Account
            sign-in and the data described in section 5 are handled with Supabase
            (database and authentication). Photos and videos posted to the Community are
            stored with Cloudflare R2 and delivered through Cloudflare.
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

      <LegalSection title="5. Community features">
        {/* LEGAL-REVIEW: este texto solo describe lo que el Site hace hoy. Pendiente de revisión
            jurídica: responsable del tratamiento, bases legales, plazos de conservación, derechos
            y cómo ejercerlos, transferencias internacionales (docs/REP-1-COPY-1.md §5.4). */}
        <p>
          The Site lets people create an account and take part in the Community. Creating
          an account is optional.
        </p>
        <LegalList>
          <li>
            <strong className="text-text-primary">Account.</strong> When you sign up we
            process your email address, which you must confirm, and your password for
            signing in.
          </li>
          <li>
            <strong className="text-text-primary">Profile.</strong> You choose a username
            and may add a display name. Both are public. Your username is shown with
            everything you post and on your public profile.
          </li>
          <li>
            <strong className="text-text-primary">Posts.</strong> Text, photos and videos
            you publish in the Community are public, together with your username and the
            date. Likes are recorded against your account.
          </li>
          <li>
            <strong className="text-text-primary">Reports and moderation.</strong> If you
            report a post, we store the report and any explanation you add, linked to your
            account, so the moderation team can review it. Other users are not shown who
            reported a post. Moderation decisions and actions on posts and accounts are
            also recorded.
          </li>
        </LegalList>
        <p>
          How long this data is kept, who is responsible for it and how to exercise your
          rights over it are being defined and will be added to this policy. Account
          deletion by users is not available yet.
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
