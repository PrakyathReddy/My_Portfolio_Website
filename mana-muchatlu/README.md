# మన ముచ్చట్లు — Mana Muchatlu

A private shared journal for two people, at `mana-muchatlu-shivani.prakyath.dev`.

Lives in this repo but deploys to **its own bucket, its own CloudFront
distribution, its own subdomain**. It shares nothing with the portfolio except
the Route53 hosted zone. That isolation is deliberate — see
[Why it is not at `/journal`](#why-it-is-not-at-journal).

---

## What works today

| | |
|---|---|
| Two members, passphrase sign-in | scrypt hashes, HMAC session tokens, 30-day sessions |
| Author avatars | every entry carries its author; initials + accent colour |
| Month calendar | one dot per person who wrote that day; tap a day to filter |
| Write / edit / delete | both people can edit either entry — it is one shared journal |
| Moods | eight of them, optional |
| Installable PWA | add to home screen on iOS and Android; no App Store, no `$99/yr` |
| Photos | up to 10 per entry, uploaded straight to S3; thumbnail grid + full-screen viewer |
| Dark mode | follows the system |
| Nightly archive | full JSON snapshot to a separate bucket, verified before it is written |
| Weekly note | one email: what you wrote, and whether the backup is healthy |
| Offline shell | the app opens without a connection; entries still need one |

## Not built yet

Video, voice notes, transcription, offline entry cache.

## Backups

Four layers, and it is worth being precise about what each one actually covers:

| Layer | Protects against | Does not cover |
|---|---|---|
| DynamoDB point-in-time recovery (35 days) | a bad deploy, a corrupting bug | losing the account |
| S3 versioning (90 days) | deleting a photo by accident | losing the account |
| Nightly archive to `BackupBucket` | the app's data model changing under you | losing the account |
| **`./infra/pull-backup.sh`** | **losing the account** | whatever you have not pulled yet |

The first three all live *inside the account they protect*. That is the entire
reason for the fourth: `pull-backup.sh` copies the archive and every photo onto
your machine and verifies what arrived. Nothing it writes needs this app, or
AWS, to read. Point it at a synced folder and the sync client does the
off-machine hop:

```bash
./infra/pull-backup.sh ~/"Google Drive"/mana-muchatlu
```

It is a command a person runs, not a cron job, on purpose. An automated Drive
push needs an OAuth refresh token that expires quietly, leaving a backup you
believe in but do not have. A copy made deliberately four times a year beats an
automated one you cannot see failing. It never passes `--delete` either: a
local mirror of a deletion is not a backup, it is a faithful reproduction of
the accident.

The nightly job verifies the snapshot **before** writing it and refuses to
replace a good archive with a failing one — a backup that faithfully preserves
corruption is worse than one that stops. Its IAM role is read-only on the
table, because a backup process with write access to what it backs up is one
bug away from being the disaster.

The Sunday email then re-reads what was written and reports it. That is what
lets it say *verified* rather than *ran*: a backup that reports nothing is
indistinguishable from one that stopped, and the difference only surfaces on
the day it matters.

---

## Architecture

```
  phone / browser
        │  HTTPS
        ▼
  CloudFront ─── OAC ───▶ S3 (private, static app)
        │
        │  fetch()
        ▼
  Lambda Function URL ──▶ DynamoDB  (single table)
                     └──▶ S3 media  (presigned PUT/GET, direct to browser)

  EventBridge ──▶ Archive Lambda ──▶ S3 backup  (nightly snapshot)
                                 └──▶ SNS        (weekly note)
```

**One DynamoDB table, no GSI:**

```
PK = COUPLE#<coupleId>
SK = ENTRY#<YYYY-MM-DD>#<entryId>
```

Because the sort key is lexicographic and ISO dates sort chronologically as
plain strings, "give me September" is a single `begins_with` query. The whole
calendar month costs one read. There is no second access pattern, so there is
no index to keep in sync. `api/__tests__/entries.test.js` asserts that
string-ordering-equals-date-ordering property directly — it is the assumption
the entire design rests on.

**Zero runtime dependencies.** The Lambda uses Node built-ins plus the AWS SDK
the runtime already ships. CI never runs `npm install`, the artifact is a few
KB, and there is no dependency tree to audit. DynamoDB attribute marshalling is
~40 hand-written lines in `api/lib/ddb.js`, and S3 presigning is SigV4 signed by
hand in `api/lib/presign.js` — checked against AWS's own published test vector,
so a refactor that breaks the canonical request fails a test rather than
producing an opaque S3 rejection.

**Photos never pass through Lambda.** The browser asks for a presigned PUT and
uploads straight to S3: no request-size limit, no invocation billed for the
transfer, no base64 round trip. Reads mirror it — the bucket stays private and
each photo is served through a one-hour presigned GET signed at read time.

**Costs.** ~40 writes/month never leaves the DynamoDB free tier. Lambda,
CloudFront and SNS likewise. Photos are the only part that grows: roughly
7GB/year at a few a week, which the 90-day Glacier Instant Retrieval rule keeps
near **$25 over a decade**. Realistic bill: **$1–3/month**, mostly the Route53
hosted zone already being paid for.

---

## Setup

Once, on a machine with AWS credentials:

```bash
cd mana-muchatlu/infra
./init-secrets.sh     # prompts for passphrases, writes scrypt hashes to SSM
NOTIFY_EMAIL=you@example.com ./deploy.sh
```

`NOTIFY_EMAIL` subscribes an address to the weekly report. SNS sends one
confirmation link that must be clicked before anything is delivered; leave the
variable out to skip it and add addresses later.

The first `deploy.sh` issues an ACM certificate and waits on DNS validation —
budget 5–30 minutes. Later runs take seconds.

Afterwards:

```bash
./deploy.sh web       # frontend only — the common case
./deploy.sh api       # Lambda code + config only
./deploy.sh archive   # run the backup now and print what it wrote
```

Passphrases are hashed locally with scrypt; only the hash leaves the machine.
Nobody, including you, can recover a forgotten one — re-run `init-secrets.sh`.

## Local development

```bash
node scripts/dev-server.js     # http://localhost:4173
```

Serves `web/` and stands in for the API using the **real** `lib/auth.js` and
`lib/entries.js`, so sign-in and validation behave exactly as in Lambda. Only
DynamoDB is swapped for an in-memory `Map`.

Both members sign in with `test`. Override with `MANA_DEV_PASSPHRASE=… node
scripts/dev-server.js` if you want something else. It is printed at startup,
binds to localhost only, and has nothing to do with the real passphrases —
those live in SSM and are set by `init-secrets.sh`.

```bash
npx jest mana-muchatlu          # 151 unit + property tests
node scripts/make-icons.js      # regenerate app icons
```

---

## Decisions worth knowing

### Why it is not at `/journal`

The portfolio deploys with `aws s3 sync . --delete` from the repo root. Had the
journal shared that bucket, every routine portfolio commit would have been one
`--delete` away from erasing it. A subdomain costs 20 minutes and removes the
failure mode entirely. `deploy.yml` now also excludes `mana-muchatlu/*`
explicitly, so journal source never reaches the public bucket.

The journal is also `noindex` at the edge via `X-Robots-Tag` on every
CloudFront response — `robots.txt` is a polite request, a header is closer to
an instruction.

### Why no end-to-end encryption

Day One needs E2EE because *Automattic* is the adversary — a third party
holding your data. Here, you are the operator; there is no third party to hide
from. E2EE would buy protection against a compromised AWS account and cost
server-side search, thumbnails, transcription, and any Lambda that touches
content.

Instead: SSE at rest, TLS in transit, IAM scoped to four verbs on one table,
private bucket behind OAC. Roughly 95% of the security for 5% of the
complexity. The data model does not preclude revisiting this later.

### Why no real-time sync

Two people writing ~10 entries a week. The chance of a genuine concurrent edit
on the same entry is well under 1%. A WebSocket would hold a connection open
for an event that fires about twice a day. The app refreshes on window focus
instead. When offline entry caching lands, last-write-wins per entry is the
correct resolution strategy — not CRDTs.

### Why avatars rather than per-person colours

Colour-coding was the original ask. Avatars are strictly better: they scale
past two people, survive export as a plain `author` field, and do not require
both of you to remember whose colour is whose. Accent colours are still there —
as the avatar fill, the entry's left border, and the calendar dot.

---

## Known gaps

- **Telugu conjunct rendering is unverified on real devices.** The headless
  browser used for testing lacks a proper Telugu font and renders
  `ముచ్చట్లు` with broken conjuncts. This is expected to be correct on any
  phone with Telugu support — but it has not been confirmed on a real handset.
- **Session tokens live in `localStorage`**, which is readable by any script on
  the origin. There is no third-party script on this origin and no CDN
  dependency, so the exposure is small — but an httpOnly cookie would be
  stronger, and needs the API behind the same origin as the site to work
  cleanly.
- **`--delete` on the media bucket is never used**, but the site bucket sync
  does use it. Media and entries are in different buckets for this reason.
