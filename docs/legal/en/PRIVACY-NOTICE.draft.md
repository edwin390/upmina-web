# Privacy Notice — DRAFT v0.2 (unpublished · working translation · pending legal review)

> Working translation of `AVISO-DE-PRIVACIDAD.borrador.md` (the Spanish text is the reference until reviewed). Not legal advice; it does not guarantee compliance with Mexican law (LFPDPPP) or the EU GDPR. `[PENDING]` items must be supplied or decided by the controller; nothing has been invented. Legal bases and retention periods are **proposals** for professional validation.

## 1. Controller
- Controller: natural person `[PENDING: full name]`, resident in Mexico, running UPMINA Web in a personal capacity (not a company).
- Postal contact, if legally required: `[PENDING: decide what is legally necessary and publishable]`.
- Privacy and data-rights contact: `[PENDING: dedicated email]`.
- UPMINA Web is an **independent fan-made project**; it is not officially affiliated with, sponsored by or endorsed by UPMINA or her team.
- EU representative / data protection officer: `[PENDING: determine whether required (GDPR Arts. 3, 27, 37); no obligation is asserted]`.

## 2. Data we process
| Context | Data | Source |
|---|---|---|
| Browsing (no account) | Technical connection data (IP, browser, pages, time) on the hosting infrastructure | Automatic |
| Account | Email address (confirmed), password (held by the authentication provider) | You |
| Profile | Username (public), display name (public), bio and avatar if you add them | You |
| Community | Text, photos and videos you post (public, with your username and date); likes | You |
| Reports | Reports you submit (reason, explanation up to 1000 characters), linked to your account; not shown to other users | You |
| Moderation | Cases, decisions, sanctions (strikes), notices, audit logs about content or accounts | Team |
| Copyright | Claimants: name, email, organisation and relationship to the work, descriptions, evidence links, declaration and signature. Affected authors: notices, appeals and appeal contact | Claimant / author |
| Team (moderation/admin) | Multi-factor authentication factors, roles and action logs | Team |
| Account deletion | Internal identifier, states and dates of the process (no email or token) | System |

We do not deliberately process sensitive data and we do not ask for date of birth or identity documents. What you write or upload voluntarily is your responsibility. **Minors:** see section 9.

## 3. Purposes and legal bases (proposal)
| Purpose | Basis (GDPR, proposal) | Necessary |
|---|---|---|
| Create and authenticate your account; verification, recovery and security emails (including MFA) | Performance of the requested service | Yes |
| Display your profile and posts; likes | Performance of the service | Yes |
| Moderate content, apply rules and strikes; handle reports | Legitimate interest in a safe space | Yes |
| Handle copyright claims and appeals | Legitimate interest; legal obligation where applicable `[PENDING]` | Yes |
| Security, abuse prevention and audit logs | Legitimate interest | Yes |
| Handle your deletion request and keep minimal evidence | Legitimate interest / legal obligation `[PENDING]` | Yes |

There are **currently no optional purposes** (marketing, profiling, analytics, newsletters, advertising). If added, they will require separate, withdrawable consent. For the LFPDPPP, `[PENDING: confirm whether express consent applies to any processing]`.
We take no automated decisions with legal effects: every sanction is decided by a person.

## 4. Providers and international transfers
| Provider | Function | Data | Location |
|---|---|---|---|
| Vercel | Hosting and functions | Technical connection data | `[PENDING: region]` |
| Supabase | Database and authentication | Account, profile, content, moderation | `[PENDING: project region]` |
| Cloudflare (R2 and delivery) | Store and deliver photos/videos | Community files, connection data | `[PENDING]` |
| Resend | Transactional emails | Email address and message content | `[PENDING]` |
| Google Fonts | Typefaces | Browser IP address | `[PENDING]` |
| Twitch, YouTube, Instagram, TikTok | Embedded content, thumbnails and public channel data | Technical data your browser sends when loading them | per provider |

The service is international and several providers operate outside Mexico and the EU: there are international transfers. `[PENDING: per provider, role (processor / controller), transfer mechanism (e.g. standard contractual clauses, EU–US Data Privacy Framework if certified) and applicable clauses.]` We do not sell personal data.

## 5. Cookies and local storage
We set no first-party cookies and use no analytics or advertising. We use browser local storage for your language and, if you sign in, to keep your session. Embedded third-party content may use its own cookies (see their notices). `[PENDING: after a technical review of embeds, confirm whether an EU consent banner is needed]`.

## 6. Retention and deletion
- You can request permanent deletion of your account from "Account": an email link (valid 30 minutes, single use), sign-in and confirmation. It is **irreversible**: access is blocked on confirmation and a background process removes your profile, posts, likes, files and credentials. Your username becomes available without anyone inheriting anything.
- **Retained**, under restricted access, not shown publicly and linked to an internal identifier: reports, cases and decisions, strikes, copyright claims and appeals, audit records and the record of the deletion. Purpose: security, defence against claims and traceability.
- **Periods:** `[PENDING: the code defines NO periods; the controller must set and justify them per category]`.
- **Limits:** provider backups and already-issued signed URLs may persist until they expire; caches may show old content for a few minutes. Accounts with a team role cannot be deleted via self-service.
- Copyright appeal contact: currently retained; `[PENDING: anonymisation policy]`.

## 7. Rights
- **Mexico (ARCO):** access, rectification, cancellation and objection; withdrawal of consent.
- **EU (GDPR):** also restriction, portability, objection to processing based on legitimate interest and the right to complain to your supervisory authority.

To exercise them, write to `[PENDING: email]` with your username, account email and your request (we may ask for the minimum data needed to verify your identity). Profile editing and account deletion can be done directly on the site. Response time: `[PENDING: applicable legal deadlines]`. Mexican authority: `[PENDING: confirm the current authority]`.

## 8. Security
Authentication handled by a specialised provider, restricted access to moderation data, mandatory multi-factor authentication for team roles and audit logs. No system is infallible. `[PENDING: incident notification procedure and deadline]`.

## 9. Minors
- **Under 13:** may not create an account. They may view the site's public content. If we detect an account of a person under 13, we will close it and delete its data.
- **13 to 17:** may register subject to the legal conditions of their country, including authorisation from a parent or guardian where the law requires it. **Being 13 is not, by itself, enough to register lawfully in every country.**
- The sign-up currently does **not** ask for or verify age; the measures (age declaration, parental consent, privacy by default) are **proposed, not implemented** (see `MENORES-EVALUACION.md`).
- We use no advertising, tracking or profiling, of minors or anyone else.

## 10. Changes
We will publish any change with a date and version and notify substantial ones. Version v0.2 · Date `[PENDING on publication]`.
