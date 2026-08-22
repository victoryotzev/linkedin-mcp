# LinkedIn developer app setup

Recorded 2026-08-09/10 by walking the LinkedIn developer portal. Several of the
constraints below appear nowhere in the documentation and were only visible in
the UI.

> **Before you start:** LinkedIn issues Member Data Portability tokens only to
> members located in the European Economic Area or Switzerland. Outside that
> region the read lane cannot be provisioned at all; the rest of the product
> works without it.

## The two apps

LinkedIn forces the read and write lanes into **separate applications**. Binding
an app to the Data Portability default Company Page permanently disables Sign In
with LinkedIn and Share on LinkedIn on that app; the tooltip says so outright:

> This product cannot be requested as you have chosen a dedicated Company page,
> rather than a Company page associated with your company, while creating this
> application. A new developer application can be created to request this
> product.

| | App 1 — read lane | App 2 — write lane |
|---|---|---|
| Name | `<your name> - Personal Brand Agent` | `<your name> - Personal Brand Publisher` |
| Client ID | `<your read-lane client id>` | `<your write-lane client id>` |
| Portal ID | `<shown in your app's URL>` | `<shown in your app's URL>` |
| LinkedIn Page | [Member Data Portability (Member-Only Default Company Page)](https://www.linkedin.com/company/member-data-portability-member-default-company) | [Default Company Page for Individual Developer](https://www.linkedin.com/company/default-company-page-for-individual-developer) |
| Products | Member Data Portability API (Member) | Share on LinkedIn · Sign In with LinkedIn (OIDC) |
| Scope offered | `r_dma_portability_self_serve` | `openid`, `profile`, `email`, `w_member_social` |
| Granted | instantly, no review | instantly, no review |

Both apps need a privacy policy URL you control.

### Picking the Page is the whole game

The Page association **cannot be undone** and silently decides which products
the app may ever request. Searching the page field by name returns several
near-identical results. Do not pick by name: paste the canonical URL from the
table above, which the field accepts and resolves unambiguously. That URL comes
from LinkedIn's own product documentation, which is the only authoritative
source for it.

Confirm the binding worked before going further: the correct Page makes the
products listed above requestable. If the Page you chose does not, delete the
application and rebuild it against a Page you administer. The association
cannot be changed afterwards.

## Scopes: the documentation was ambiguous, the portal is not

Research found three candidate DMA scope names. The portal offers exactly one:

- **`r_dma_portability_self_serve`** — "Access (up to 1 Year) and use your
  LinkedIn data… This application can only access your LinkedIn data if you are
  the admin of this application."

Note **up to one year**, not the 60 days the general OAuth documentation
describes. The code never hard-codes either: expiry is recorded from whatever
the token generator reports.

## Do not touch: Community Management API

Rejection is permanent **per app**, and LinkedIn requires it be requested only
from a fresh application holding no other products. It is also restricted to
registered companies for commercial use, so it is out of reach for an individual
regardless. Requesting it on either app would burn that app for nothing.

## Minting a token (the member does this, not the agent)

The agent will not enter a token into any field. The flow is:

1. Open the token generator for the lane:
   - read: `https://www.linkedin.com/developers/tools/oauth/token-generator?clientId=<your read-lane client id>`
   - write: `https://www.linkedin.com/developers/tools/oauth/token-generator?clientId=<your write-lane client id>`
2. Leave **Member authorization code (3-legged)** selected, tick every scope
   offered, tick the redirect-URL acknowledgement, and press **Request access
   token**. The tool adds its own redirect URL to the app; that is expected and
   can be removed afterwards in app settings.
3. Copy the token, open the dashboard (`npm run dashboard`) → **Analytics &
   system** → **Credentials**, paste the client ID and token into the matching
   lane, and press **Save encrypted**. The value is encrypted before it reaches the
   database, under a master key sealed by the platform's OS facility (DPAPI on
   Windows, the login Keychain on macOS, a machine-id-derived key on Linux), and
   is never returned by any read path.
4. Press **Verify against LinkedIn**. The read lane is proved with a real DMA
   snapshot read (the read app has no OIDC product, so `/v2/userinfo` would 403
   there); the write lane is proved with `/v2/userinfo`, which also yields the
   Person URN that authoring posts requires.
5. Publishing stays shut even then. It requires one further explicit toggle —
   proving a credential works is not the same as deciding to post.

Once the read lane verifies, `linkedin_dma_sync` pulls all ten profile Snapshot
domains (profile, positions, education, skills, certifications, courses, honors,
languages, projects, publications) plus full post history, and
`linkedin_profile_read_latest` performs a profile-focused live read that
reconciles the Member Changelog first and reports whether LinkedIn's Snapshot is
lagging behind it. Snapshot calls send `LinkedIn-Version: 202312`; any other
value returns 426. Neither tool can promise the profile it returns is current —
LinkedIn's Snapshot response carries no generation timestamp and no completeness
marker. See [reading the latest LinkedIn profile](../linkedin-mcp-server/README.md#reading-the-latest-linkedin-profile).
