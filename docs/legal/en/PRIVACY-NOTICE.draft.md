# Privacy Notice — DRAFT v0.3 (unpublished · working translation · pending legal review)

> Working translation of `AVISO-DE-PRIVACIDAD.borrador.md` (the Spanish text is the reference until reviewed). Not legal advice; it does not guarantee compliance with Mexican law (LFPDPPP) or the EU GDPR. `[PENDING]` items must be supplied or decided by the controller; nothing has been invented. Legal bases and retention periods are **proposals** for professional validation.

## 1. Controller
- Controller: a natural person established in Mexico who operates UPMINA Web in a personal capacity (not a company). Legal identity: `[PENDING]`.
- Official contact for privacy, exercising rights and legal matters: **upminaaweb@gmail.com**.
- Address or notification channel required: `[PENDING: legal review; no private home address is published without verifying the applicable obligations]`.
- Identification and international obligations: `[PENDING: assess identification requirements and possible obligations when offering the service internationally (e.g. EU representative or data protection officer, GDPR Arts. 3, 27, 37); none is asserted]`.
- UPMINA Web is an **independent fan-made project**; it is not officially affiliated with, sponsored by or endorsed by UPMINA or her team.

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
### 6.1 Account deletion (current behaviour)
1. You request deletion from "Account" while signed in and confirm with a link sent to your email (valid 30 minutes, single use).
2. On confirmation your access is **revoked immediately and irreversibly**; sessions are closed.
3. Cleanup starts and may continue **asynchronously**: it removes your profile, posts, likes, uploaded files and your credentials. **We do not claim that everything disappears instantly.**
4. If a step fails, **the account stays blocked** and cleanup remains pending; a cleanup error never restores access.
5. Failures are logged and raise alerts for the technical team (Developer role). Today a failed cleanup **may require a manual retry** by that team. **We do not promise unattended automatic retries.**
6. Your username becomes free without anyone inheriting anything from your account. Accounts with a team role cannot be deleted via self-service.

### 6.2 What is deleted and what is kept
- **Deleted** (in the cleanup above): profile, posts, likes, files used only by your posts and the sign-in identity. Files shared with another resource are kept until released.
- **Kept**, under restricted access, not shown publicly and linked to an internal identifier: reports, moderation cases and decisions, strikes (which, while the account exists, are used to apply the sanctions system), moderation audit records, copyright claims and appeals (including the appeal contact, not anonymised) and the deletion record (no email or token). **There is currently no defined retention period and no automatic purge for these records, and we do not promise deletion periods.** `[PENDING: legal review of whether and for how long they must be kept]`
- The deletion token (only its hash) expires after 30 minutes.

### 6.3 Existing copies
Backups and manual copies of the database, our own or our providers', may exist and contain data of accounts that have already been deleted. They are not deleted immediately or automatically, and we do not promise a rotation schedule. `[PENDING: verify with providers]`

### 6.4 Exceptions
We may keep data when necessary to comply with a legal obligation, handle or defend a claim, investigate a security incident or prevent abuse, in a justified and limited way. `[PENDING: legal review]`

### 6.5 Data managed by UPMINA Web and data processed by third parties
The above describes the data UPMINA Web stores directly (database, files). Providers (hosting, database, storage, email and content platforms) keep data under their own policies and periods `[PENDING: verify]`.

## 7. Rights
- **Mexico (ARCO):** access, rectification, cancellation and objection; withdrawal of consent.
- **EU (GDPR):** also restriction, portability, objection to processing based on legitimate interest and the right to complain to your supervisory authority.

To exercise them, write to **upminaaweb@gmail.com** with your username, account email and your request (we may ask for the minimum data needed to verify your identity). Profile editing and account deletion can be done directly on the site. Response time: `[PENDING: applicable legal deadlines]`. Mexican authority: `[PENDING: confirm the current authority]`.

## 8. Security
Authentication handled by a specialised provider, restricted access to moderation data, mandatory multi-factor authentication for team roles and audit logs. No system is infallible. `[PENDING: incident notification procedure and deadline]`.

## 9. Minors
- **Under 13:** may not create an account. They may view the site's public content, which is suitable for all audiences.
- **13 to 17:** registration depends on the legal obligations applicable in their country, including authorisation from a parent or guardian where applicable. **Being 13 is not, by itself, enough to register lawfully in every country.**
- **Current status:** sign-up **does not verify age or parental authorisation**; those measures are pending implementation and we do not claim they exist. We do not ask for full dates of birth or identity documents.
- **Public profiles and posts:** your profile (username, name, bio and avatar if you add them) and your posts are **public**; there are no private profiles or age labels, and we do not publicly identify anyone as a minor. We recommend not including personal data in your profile or posts, especially if you are a minor.
- If we detect an account of a person under 13, we will close it and delete its data.
- We use no advertising, tracking or profiling, of minors or anyone else.
- Principles: data minimisation and privacy. Additional measures for minors are **not implemented**.

## 10. Changes
We will publish any change with a date and version and notify substantial ones. Version v0.3 · Date `[PENDING on publication]`.
