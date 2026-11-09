# Mana Muchatlu — AI handoff

**Read this before changing anything.** It exists so a new session — human or
AI — can resume without re-deriving what took a long debugging session to
learn the first time. `README.md` is the user-facing document; this one is the
working context.

Last updated: 2026-09-16. Branch: `claude/compassionate-euler-02gjq8`.

---

## 1. What this is, in one paragraph

A private shared journal for two people, live at
`https://mana-muchatlu-shivani.prakyath.dev`. It lives inside a portfolio
website repo but deploys to entirely separate AWS resources. Vanilla
HTML/CSS/JS frontend with no build step, two Node Lambdas with **zero runtime
dependencies**, one DynamoDB table, three S3 buckets, CloudFormation for
everything. Built for two users and roughly ten entries a week — nearly every
design decision follows from that number, so check it before proposing
anything that assumes scale.

## 2. Orientation in five minutes

```bash
# from the repo root
npm install
npx jest mana-muchatlu        # 132 tests. Whole repo (incl. portfolio) is 158.
npm run dev:journal           # http://localhost:4173, both members sign in with "test"

cd mana-muchatlu/infra
./doctor.sh                   # read-only health check of the live deployment
```

**`doctor.sh` is the single most useful thing in this repo.** It checks every
layer independently and prints the exact command to fix whatever is broken.
Run it before and after any infrastructure change. If you are debugging and
have not run it, run it.

```bash
./deploy.sh              # everything: stacks, both Lambdas, frontend
./deploy.sh web          # frontend only — the common case
./deploy.sh api          # both Lambdas' code + config
./deploy.sh archive      # run the backup now, print what it wrote
./deploy.sh report       # send the weekly email now
./pull-backup.sh [dir]   # copy everything out of AWS to local disk
```

## 3. Layout

```
api/            Lambda source. index.js = HTTP API, archive.js = backup/report.
  lib/          Pure functions, no I/O. This is where the logic lives.
  __tests__/    Jest, picked up by the repo-root config. 132 tests.
infra/          CloudFormation + the four scripts above.
scripts/        dev-server.js (local API stand-in), make-icons.js
web/            The PWA. No build step; what is here is what ships.
```

**The `lib/` split is deliberate and load-bearing.** Everything that could be
wrong about *logic* lives in pure functions a unit test can reach; the
handlers around them only do I/O. When adding a feature, put the thinking in
`lib/` with tests and keep the handler flat. Do not reorganise this.

---

## 4. Traps — read this section in full

These cost real time to find. Each one had a failure mode that looked like
something else entirely.

### 4.1 Lambda Function URLs changed in October 2025

A function URL created after that date needs **both** `lambda:InvokeFunctionUrl`
**and** `lambda:InvokeFunction` in the resource policy. With only the first,
the URL answers a bare `Forbidden` **before the handler runs**, so CloudWatch
is completely empty — not "an error logged", genuinely nothing.

The `InvokeFunction` grant is scoped with `InvokedViaFunctionUrl: true`, **not**
`FunctionUrlAuthType` — AWS rejects that pairing outright. The condition is not
cosmetic: without it, `Principal: "*"` lets anyone invoke the function directly
through the Lambda API, bypassing the URL, CORS and the passphrase.

> **Empty CloudWatch logs + `Forbidden` means the request never arrived.**
> Look at infrastructure, not code.

### 4.2 CORS is owned by the Function URL alone

The Function URL has a `Cors` block. The handler **must not** also set
`Access-Control-Allow-Origin`. Two identical headers and every browser rejects
the response — while `curl`, which sends no `Origin` and checks no CORS
headers, reports a perfectly healthy endpoint.

> **Works in the terminal, blocked in the browser = duplicated CORS header.**

`api/lib/http.js` has no CORS helper on purpose. Do not add one back.

### 4.3 The media bucket has its own, separate CORS

Photos and audio upload **straight from the browser to S3**, so the *bucket's*
CORS rules decide whether the upload is allowed. Getting the Function URL's
CORS right tells you nothing about this one. Both are checked by `doctor.sh`.

### 4.4 The service worker was once un-updatable

`sw.js` v1 was cache-first for the whole shell under a fixed cache name, so any
browser that had opened the app once served its own copy **forever**. No deploy
could reach it. Now: shell is network-first with cache as offline fallback,
icons stay cache-first, `/config.js` and `/api/` are never cached.

If you touch `sw.js`, verify that a deployed change reaches a browser that has
already visited. That is not the same test as "it works in a fresh browser".

### 4.5 Your AWS CLI may be behind the service

An older CLI rejects `put-public-access-block-config` and
`--invoked-via-function-url`. **CloudFormation applies template properties
server-side**, so the fix is to put it in the template and run `./deploy.sh`,
not to reach for another CLI command. An old client limits what you can
*express*, never what AWS can *do*.

### 4.6 zsh does not strip `#` comments

`./deploy.sh   # some note` arrives with `#` as `argv[1]`. `deploy.sh` and
`pull-backup.sh` now drop a leading-`#` argument, and an unrecognised target
says **"Nothing was deployed"** rather than printing a bare usage line — because
a usage message scrolling past looks exactly like a deploy that ran and changed
nothing. **Never append an explanatory comment to a command you expect someone
to paste.**

### 4.7 `str.replace` no-ops silently

Two commits claimed README updates that never happened: the patterns used `-`
where the file has `—`. If you script an edit, make it **fail loudly** on a
pattern it cannot find, and verify the result rather than trusting the exit
code.

### 4.8 `pkill -f dev-server.js` kills your own shell

The pattern matches the shell process whose command line contains that string.
Check whether the server is already up instead.

### 4.9 SNS subscriptions must be confirmed

An unconfirmed subscription delivers nothing, forever, silently — while
`publish` returns success. `doctor.sh` checks for this explicitly. It is the
most likely reason for a healthy backup that never reports itself.

---

## 5. Decisions that look wrong but are not

Do not "fix" these without reading the reasoning. Most are argued at greater
length in `README.md`.

| Decision | Why |
|---|---|
| No framework, no build step | ~40KB of app. A framework would cost more bytes than it saves lines, and matches the portfolio it lives beside. |
| Zero runtime dependencies | Node built-ins + the SDK the Lambda runtime ships. CI never runs `npm install`; the artifact is a few KB. DynamoDB marshalling and SigV4 presigning are hand-written for this reason. |
| Hand-rolled SigV4 in `lib/presign.js` | `@aws-sdk/s3-request-presigner` is not reliably bundled in the runtime. **It is checked against AWS's published test vector** — that test is the safety net; keep it. |
| One DynamoDB table, no GSI | `SK = ENTRY#<YYYY-MM-DD>#<id>`. ISO dates sort chronologically as plain strings, so a calendar month is one `begins_with` query. A property test asserts string-order equals date-order; it is the assumption the whole design rests on. |
| No end-to-end encryption | The operator *is* the user here — there is no third party to hide from. E2EE would cost search, thumbnails and any Lambda that touches content. |
| No real-time sync | ~10 entries/week between two people. The app refreshes on window focus. When offline entries land, last-write-wins per entry is correct — **not** CRDTs. |
| Avatars, not per-person colours | Scales past two people, survives export as a plain `author` field, and does not require remembering whose colour is whose. |
| `AuthType: NONE` on the Function URL | Required for the browser to call it unsigned. The passphrase is the gate. See §7. |
| Photo-only entries are valid | The cheapest entry to make, so the one most likely to get made. `validateEntry(input, { hasMedia })`. |
| Backup pull is manual | An automated Drive push needs an OAuth refresh token that expires quietly, leaving a backup that exists only in belief. |
| Durations floored, not rounded | A label reading 0:03 above a player reading 0:02 looks broken. |

---

## 6. State as of this handoff

**Working in production:** passphrase sign-in for two members, author avatars,
month calendar with per-author dots, write/edit/delete, moods, photos (≤10 per
entry), voice notes (record + playback), installable PWA, dark mode, nightly
verified archive, weekly SNS report, off-account pull script.

**Verified end to end**, not just unit-tested: photo upload and display, voice
record/upload/playback (Chromium with a synthetic mic), service-worker update
propagation and recovery, the archive writing and verifying against live data.

**Not built:** video, voice-note transcription, offline entry caching, login
rate-limiting.

**Known gaps:**

- **No rate limiting on login.** The Function URL is public with no throttle;
  at Lambda concurrency that is roughly 1,000 guesses/sec against scrypt. A
  multi-word passphrase puts this far out of reach, and the user was told so.
  A DynamoDB counter rejecting after ~10 failures in 15 minutes is the fix,
  ~30 lines. **Highest-value security work remaining.**
- Session tokens live in `localStorage`. No third-party script on the origin,
  so exposure is small; an httpOnly cookie needs the API same-origin.
- Accent colours are CSS names (`blue`, `pink`) rather than the muted hex the
  palette expects. Cosmetic; fixed by re-running `./init-secrets.sh`.

## 7. Security model, stated plainly

- The passphrase is the **entire** door. `AuthType: NONE` is required for a
  browser to call the URL unsigned; authorization is the app's HMAC session
  token.
- Passphrases are scrypt-hashed locally by `init-secrets.sh`; only hashes reach
  SSM SecureString. **They cannot be recovered** — a forgotten one means
  re-running that script.
- Secrets never enter CloudFormation or git. `deploy.sh` reads SSM and injects
  them via `update-function-configuration`, passing the payload through a
  `chmod 600` temp file rather than argv (argv is world-readable via `ps`).
- The archive writes `publicMembers()` only. **There is a test asserting the
  serialised archive contains no passphrase hash** — keep it.
- Media keys come back from the browser and become S3 paths, so they are
  untrusted: only keys matching the issued shape, under this couple's prefix,
  are accepted. `coupleId` is regex-escaped.
- The archive Lambda's role is **read-only** on the table. A backup process
  with write access to what it backs up is one bug from being the disaster.

## 8. Conventions here

- **Verify in the real client, not just tests.** Several bugs passed every unit
  test and failed in a browser. Playwright is available; Chromium is at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Use
  `--use-fake-device-for-media-stream` for microphone work.
- **A check that can go green while the product is broken is not a check.**
  `doctor.sh` once reported "everything checks out" about an app that had never
  worked in a browser, because it tested with `curl`. Make tests resemble the
  real client.
- Comments explain *why*, not *what*. Match the surrounding density.
- Commit messages explain the reasoning and name what was wrong before.
- The portfolio's `deploy.yml` syncs the repo root with `--delete` and excludes
  `mana-muchatlu/*`. **Do not remove that exclusion.**
- `web/config.js` is generated at deploy time and gitignored. Never commit it.

## 9. If you are resuming work

1. `./doctor.sh` — establish what is actually true before believing anything
   here.
2. `npx jest mana-muchatlu` — should be 132 green.
3. Read `README.md` for the user-facing picture and the backup model.
4. Highest-value next tasks, in order:
   - **Login rate limiting** (~30 lines, closes the one real security gap)
   - **Voice transcription** via Amazon Transcribe — *not* the Whisper API.
     Transcribe is ~4× the price and at this volume that is $12/yr against
     $3/yr, which is not worth sending two people's private voice notes to a
     third party. It is async, so it needs a real pipeline: job start, then
     either completion events or a lazy read of the transcript on entry load.
   - Offline entry caching — hardest thing left, and there is still no evidence
     it is needed. Wait for a real lost entry.
5. Deploy target matters: frontend-only changes take `./deploy.sh web`; anything
   touching `api/` or IAM needs `./deploy.sh` in full.

## 10. What not to do

- Do not add a framework or a build step.
- Do not add npm dependencies to `api/` — the zero-dependency property is why
  CI is simple and cold starts are fast.
- Do not put CORS headers in the handler (§4.2).
- Do not make the service worker cache-first for the shell (§4.4).
- Do not remove the `mana-muchatlu/*` exclusion from the portfolio deploy.
- Do not commit `web/config.js` or anything from `.build/`.
- Do not use `--delete` when syncing *from* S3 in a backup path.
- Do not weaken `isValidMediaKey` — it is the boundary between browser input
  and an S3 path.
