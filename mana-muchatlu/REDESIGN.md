# Pearl & Ink implementation checkpoint

Approved by the user on 2026-11-09. Build and deploy is authorized.

## Design and behaviour

- Phone-first, simple, classy, quietly romantic. Pearl `#fbf8f7`, ink
  `#2e2528`, blush `#f6e9ed`, rose rules `#cba7ae`. No playful illustrations.
- Classic fine-calligraphy wordmark (comparison option D) with one small rose
  heart. Refined serif headings and readable controls; self-host the fonts.
- Three views: Ee roju (default, immediately ready to write), Gnapakalu
  (month navigation, author filters, existing text/photos/audio), Calendar
  (Monday-first, author dots, selected-day entries, backdated composition).
- Keep passphrase authentication, token/member storage keys, API endpoint,
  table keys, media keys, author attribution and existing records intact.
  Do not seed, migrate, clear or translate production entries.
- New entries are blank: the following hints are placeholders, never values.

| Signed-in member | Title placeholder | Body placeholder |
| --- | --- | --- |
| Shivani / bujjuluu / bujji | Emaina sare, I’ll always love you, bujji ♥️🫂 | idi mana safe space bujji… judgement-free. Emaina raskovachu |
| Prakyath / bangaram | Emaina sare, I’ll always love you, bangaaramm ♥️🫂 | idi mana safe space Bangaaramm… judgement-free. Emaina raskovachu |

- Tinglish UI: Ee roju ela gadichindi? / Mana gnapakalu. / Chinna moments…
  manake sontham. / Maniddaram / Mana rojulu. / Ee rojuki oka note.
- Keep practical labels such as Photo, Voice note and Save entry in English.
- Mood is mandatory on every new save and edit, with NO default selection;
  disable Save until chosen and enforce validation in the API. Existing
  records without moods remain readable and unchanged until explicitly edited.
- Quick moods: Perfect day, Normal day, Badhestundi. More moods opens an
  accessible bottom sheet; clearing a choice disables Save again.
- Twelve mood labels: Perfect day, Happy ga undi, Normal day, Peaceful ga
  undi, Grateful, Excited, Allari mood, Tired ga undi, Badhestundi,
  Chirakuga undi, Overthinking, Missing you. Preserve the eight old canonical
  IDs; add perfect-day, normal-day, irritated and overthinking.
- Preserve photos, voice recording/playback, lightbox, editing, deletion,
  date handling and installable PWA. No mock content in production.

## Delivery plan / checkpoint

Base: `464f760c8e1973bf7d1a63c86438e05f657a5131` on main.
Working branch: `codex/journal-pearl-blush`.

1. Implement the responsive three-view UI, shared form/media handling and moods.
2. Test backend validation/legacy records and both personalised placeholders.
3. Browser-test the real local dev server using its isolated in-memory data.
4. Push a PR, run CI, merge and verify Lambda + web deployment and invalidation.

Deployment must upload API code before frontend code: new moods are not accepted
by the old Lambda. Use existing AWS resources and secrets, without deploying
CloudFormation or resetting credentials. Keep portfolio deployment exclusions.

Initial checkpoint: source reviewed; implementation and tests pending.
