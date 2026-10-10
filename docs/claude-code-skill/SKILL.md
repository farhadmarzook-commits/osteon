---
name: obsidian-flashcards
description: Write, edit, check and organise flashcards for the Obsidian plugin "Osteon" (Anki-style cards inside notes, FSRS scheduling, image occlusion). Use whenever creating or changing flashcards in an Osteon vault, converting notes or Anki cards into cards, making image-occlusion figures, editing the "My terms" glossary, or explaining the card syntax.
---

# Osteon (flashcard plugin): how cards work and how to write them

Cards live **inside ordinary notes**. The plugin reads them. Review history lives in separate
log files that you must never edit.

## Which notes are scanned

- A note is scanned if it has the tag `#flashcards` (in frontmatter `tags: [flashcards]` or anywhere
  in the body), or if it is in a folder listed in the plugin's "Card folders" setting.
- **Deck** = the `#flashcards/...` sub-tag if present (`#flashcards/ortho/knee` gives the deck
  ortho › knee). Otherwise it's the note's folder path. Notes at the vault root go in "Default".
- **Never put card notes inside `Flashcards/`.** That folder holds review data and is ignored.

## The one rule

**The first line is the front. The lines directly under it are the back** (shown after Space).
The back ends at a blank line, or at the next line that is a card of its own. In a bulleted
note, the card is a bullet and its **indented children** are the back.

## Card types

```md
The ACL originates on the medial wall of the ==lateral femoral condyle==.
Posterior part of the notch wall, behind the resident's ridge.
![[acl-footprint.png]]

Most common nerve injured in a supracondylar humerus fracture? :: AIN
Tested with the OK sign (FPL + FDP to the index finger).

Lachman test ::: Anterior tibial translation at 30° flexion, testing the ACL

Ottawa knee rules (any one = X-ray) ::
- Age ≥ 55
- Isolated patellar tenderness

- Terrible triad = dislocation + radial head fx + ==coronoid fx==
    - Fix order: coronoid → radial head → LCL.
```

| Syntax | Type | Cards |
|---|---|---|
| `==answer==` | Cloze | one per distinct cloze |
| `==answer;;hint==` | Cloze with a hint shown on the front as `[hint]` | 1 |
| `==1;;answer==` | Grouped cloze: all clozes with the same number are hidden on one card | one per number |
| `{{c1::answer}}`, `{{c1::answer::hint}}` | Anki cloze syntax (also works) | one per c-number |
| `front :: back` | Basic | 1 |
| `front ::` then lines below | Basic with a multi-line answer | 1 |
| `front ::: back` | Basic + reversed | 2 |
| a ```` ```fc-occlusion ```` block | Image occlusion (see below) | one per box or group |

- A card that asks for 2+ answers on the same card (e.g. several `{{c1::…}}`, or `==1;;…==` groups)
  reveals them one by one (each hidden behind a 🦴; N or Space for next; the card opens straight to the reveal).
  A list on separate lines inside ONE cloze (`{{c1::A <br> B}}`) counts as several answers too. The user can switch any
  single card to or from one-by-one with the bone button above it in review (stored in the plugin's settings, not the note). So a list of
  answers is fine as ONE card when the items belong together; the Extra shows after the last one.
- Tags on the front line (`#high-yield`) become card tags. They're hidden on the card.
- Pictures (`![[x.png]]`), links (`[[Note]]`), bold, lists and math all work on either side.
- If a card has no picture of its own, the back also shows up to 2 pictures from the same
  heading section of the note.
- **Not scanned for cards:** code blocks, `$$` math blocks, tables, and ordinary callouts or quotes (`>`).
- **Card callouts are scanned:** `> [!card]`, `> [!cards]`, `> [!flashcard]` or `> [!flashcards]` (with an optional
  title). Everything inside follows the same rules, with each line starting `> `; a lone `>` line separates cards.
  Use them to keep a few cards in a tidy, foldable box (`> [!cards]-` starts folded).

## How to write good cards (follow them)

- **One fact per card, as a short declarative statement of about 10–15 words.** Never a vignette
  with one word clozed out.
- **Keep the cloze short (1–4 words): just the answer.** Put the explanation on the line under
  the card, where it becomes the back. Never stuff the explanation inside the cloze or leave it
  trailing on the front line.
- Prefer one cloze per line. If a fact has two parts, make two cards, or use numbered groups
  (`==1;;…==`) deliberately.
- Put pictures that explain the fact on the back lines.
- Check medical facts. If you're unsure, say so instead of writing the card.

## Card IDs and history: never break these

- After a card's first review, the plugin adds an ID at the end of the card:
  - `^fc-xxxxxxxx` (8 characters) at the end of the paragraph's last line.
  - For bullet cards, it goes at the end of the bullet line.
  - For image occlusion, it's an `id: fc-xxxxxxxx` line inside the block.
- **Never delete, change, move or invent an ID.** If you rewrite a card, keep its ID at the end
  of the card's last line (paragraph) or bullet line. The card keeps its history that way.
- **Never copy a card together with its ID.** Two cards would share one history. When
  duplicating a card, remove the `^fc-…` from the copy.
- Editing the wording of a card is fine, and so is fixing a cloze's spelling. The plugin keeps
  the history when a single cloze changes.
- **Never touch `Flashcards/reviews/**`** (review logs) or `Flashcards/glossary/ai/**` (AI
  definitions). They are append-only, per-device files.

## Image occlusion

The user normally draws these in the plugin's editor: right-click an image line and choose
**Create image occlusion**. If you write one by hand:

````md
```fc-occlusion
image: [[knee-lateral.png]]
mode: hide-all
header: Lateral knee radiograph, name the structure
k7fq rect 0.412 0.228 0.12 0.06 "Patella"
9c0d ellipse 0.301 0.64 0.08 0.08 "Tibial tubercle"
p4e1 poly 0.51,0.44 0.57,0.43 0.58,0.49 "Blumensaat's line"
group b8zn = r5tw w1ky
```
Insall–Salvati ratio = tendon length ÷ patellar length (normal 0.8–1.2).
````

- **Coordinates** are fractions of the image (0–1). For `rect` and `ellipse` they are `x y w h`
  (the bounding box). For `poly` they are `x,y` pairs.
- **Box IDs** are 4 lowercase letters or digits, unique within the figure. **Never reuse** the ID
  of a deleted box, and don't change existing IDs.
- **Mode:** `hide-all` is for labelled diagrams; `hide-one` is for X-rays and photos.
- **The back** is the lines directly under the closing fence.

## Term-hover glossary

`Flashcards/glossary/My terms.md` holds his own definitions for the underline/hover feature:

```md
## Define
- AIN (anterior interosseous nerve): Median nerve branch — FPL, FDP to index/middle, PQ.

## Never underline
- Fracture
```

A note whose title or alias matches a term also gives its definition: its first paragraph, plus
its first pictures.

## Anki decks

The user can import `.apkg` files with the plugin's command **Import deck (.apkg)…**. Imported
decks live in `Anki/<deck>/<sub-deck>.md`, tagged `flashcards/<Deck>/<Sub-deck>`, with pictures in
`Anki/media/`.
- They keep Anki's `{{c1::…}}` cloze syntax and have IDs from the start.
- Extra Anki fields appear on the back as `**Field name:** …`.
- You may clean up or rewrite these cards like any others, following the rules above.
- Don't edit `Flashcards/imports/anki.md`: it records what was imported (and lets a re-import of a newer
  deck version update those cards in place, keeping their history). Cards edited in Obsidian since they were imported
  are kept, not replaced (fingerprints in `Flashcards/imports/anki-sources.json`; don't edit it either).

## Linked notes (AnKing ↔ study notes)

A `*.cardlinks.json` file (e.g. one shipped with a shared vault) links imported Anki cards to the
study note that teaches them. N on such a card opens that note; `note:"<path>"` in Browse finds a note's
own and linked cards; **Study this note's cards** (command or the note's ⋯ menu) studies them.
- Don't edit a link table by hand or move the import manifest; both are data.
- A linked card doesn't need to be copied into the note. Write native cards only for facts the deck lacks.

## Exam results

`*.exammap.json` files map practice-exam questions to notes. **Import exam results…** saves a student's
missed item numbers (in `Flashcards/exams/`, don't edit), tags the notes `weak-area-<source>`, and
**What I keep missing** ranks them with Study buttons. `missed:1` in a search = cards of missed topics.

## Moving old cards over

- The plugin's command **Migrate from Spaced Repetition…** converts the old `<!--SR:…-->` cards
  and keeps their schedules. It shows a preview first.
- **Prefer that command over hand-editing SR comments.** Don't delete `<!--SR:…-->` comments
  yourself before migrating: they hold the old schedule.
- **Find cards to rewrite** lists overstuffed cards, such as long clozes.

## Checklist before you finish

1. The note has `#flashcards`, or is in a card folder, and isn't inside `Flashcards/`.
2. Every card is one short fact, with a 1–4-word cloze and the explanation on the line under it.
3. No `^fc-` ID was removed, changed or duplicated.
4. Tell the user how many cards you added or changed, and in which notes.
