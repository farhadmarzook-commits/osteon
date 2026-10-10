import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardFaces } from "../src/core/faces";
import { composeCardSource, insertCardId } from "../src/core/ids";
import { clozeSlotForText, parseNote } from "../src/core/parser";

const fixture = (p: string) => readFileSync(join(__dirname, "fixtures/vault", p), "utf8");

describe("parseNote: ACL fixture (paragraph form)", () => {
  const cards = parseNote(fixture("Ortho/Knee/ACL.md"));

  it("finds exactly the three cards and ignores code, math, callouts, tables and plain text", () => {
    expect(cards.map((c) => c.type)).toEqual(["cloze", "reversed", "basic"]);
  });

  it("uses the first line as the front and the lines under it as the back", () => {
    const c = cards[0];
    expect(c.front).toBe("The ACL originates on the medial wall of the ==lateral femoral condyle==.");
    expect(c.back).toBe(
      "Posterior part of the notch wall, behind the lateral intercondylar (resident's) ridge.\n![[acl-femoral-footprint.png]]",
    );
    expect(c.headings).toEqual(["ACL", "Anatomy"]);
    expect(c.slots).toEqual([clozeSlotForText("lateral femoral condyle")]);
    // Paragraph form: the ID goes on the paragraph's last line.
    expect(c.idLine).toBe(c.endLine);
  });

  it("parses reversed cards into two slots", () => {
    const c = cards[1];
    expect(c.front).toBe("Lachman test");
    expect(c.answer).toBe("Anterior tibial translation at 30° flexion, testing the ACL");
    expect(c.slots).toEqual(["fwd", "rev"]);
    const rev = cardFaces(c, "rev");
    expect(rev.question).toBe(c.answer);
    expect(rev.answer).toBe("Lachman test");
  });

  it("uses the lines below as the answer when the right side of :: is empty", () => {
    const c = cards[2];
    expect(c.front).toBe("Ottawa knee rules (any one = X-ray)");
    const f = cardFaces(c, "fwd");
    expect(f.answer.split("\n")).toHaveLength(5);
    expect(f.extra).toBe("");
    expect(c.headings).toEqual(["ACL", "Exam"]);
  });
});

describe("parseNote: Elbow fixture (list form, Anki clozes, IDs, tags)", () => {
  const cards = parseNote(fixture("Ortho/Elbow/Elbow.md"));

  it("finds each card, including one nested under a plain bullet", () => {
    expect(cards.map((c) => [c.type, c.form])).toEqual([
      ["cloze", "list"],
      ["cloze", "list"],
      ["basic", "list"],
      ["cloze", "paragraph"],
      ["cloze", "paragraph"],
    ]);
  });

  it("takes indented children (including across a blank line) as the back, dedented", () => {
    const c = cards[0];
    expect(c.back).toBe(
      "- Posterolateral rotatory mechanism.\n- ![[terrible-triad-ct.png]]\n\n- Fix: coronoid → radial head (fix or replace) → LCL.",
    );
    expect(c.tags).toEqual(["high-yield"]);
    expect(c.front).not.toContain("#high-yield");
    expect(c.idLine).toBe(c.startLine);
  });

  it("reads an existing ID and strips it from the face", () => {
    const c = cards[1];
    expect(c.id).toBe("a1b2c3d4");
    expect(c.front).toBe("Nested card: the ==AIN== supplies FPL.");
  });

  it("supports Anki cloze syntax with hints, numbering, and ignores inline code", () => {
    const scaphoid = cards[3];
    expect(scaphoid.slots).toEqual(["c1"]);
    const f = cardFaces(scaphoid, "c1");
    expect(f.question).toContain("[which surface?]");
    expect(f.answer).toContain('<mark class="fc-answer">dorsally and distally</mark>');

    const pq = cards[4];
    expect(pq.slots).toEqual(["c1", "c2"]);
    const c2 = cardFaces(pq, "c2");
    expect(c2.question).toBe(
      'Pronator quadratus and <span class="fc-cloze">[...]</span> are both innervated by the AIN. `{{c3::code}}`',
    );
  });
});

describe("parseNote: obsidian-spaced-repetition format", () => {
  const cards = parseNote(fixture("Misc/SR-format.md"));

  it("reads SR cards and hides their scheduling comments", () => {
    expect(cards).toHaveLength(2);
    expect(cards[0].back).toBe("");
    expect(cards[1].answer).toBe("Axillary");
  });
});

describe("cloze slots are keyed by text (spec 0002 §3.4)", () => {
  it("adding or reordering other clozes does not change a cloze's slot", () => {
    const a = parseNote("The ==ulnar== nerve.")[0];
    const b = parseNote("The ==median== and ==ulnar== nerves.")[0];
    expect(b.slots).toContain(a.slots[0]);
  });

  it("ignores case, spacing and trailing punctuation", () => {
    expect(clozeSlotForText("Lateral  femoral condyle.")).toBe(clozeSlotForText("lateral femoral condyle"));
  });

  it("identical clozes on one line share one card", () => {
    expect(parseNote("==ulnar== then ==ulnar== again")[0].slots).toHaveLength(1);
  });
});

describe("insertCardId", () => {
  const text = fixture("Ortho/Knee/ACL.md");

  it("appends the ID to the paragraph's last line and survives a re-parse", () => {
    const card = parseNote(text)[0];
    const out = insertCardId(text, card, "k3x9m2qa")!;
    expect(out.split("\n")[card.idLine]).toBe("![[acl-femoral-footprint.png]] ^fc-k3x9m2qa");
    const again = parseNote(out)[0];
    expect(again.id).toBe("k3x9m2qa");
    expect(again.back).not.toContain("^fc-");
    expect(parseNote(out)).toHaveLength(3);
  });

  it("refuses to write if the note changed since it was parsed", () => {
    const card = parseNote(text)[0];
    const edited = text.replace("medial wall", "medial side");
    expect(insertCardId(edited, card, "k3x9m2qa")).toBeNull();
  });

  it("puts the ID on the bullet line in list form, keeping the card intact", () => {
    const t = fixture("Ortho/Elbow/Elbow.md");
    const card = parseNote(t)[0];
    const out = insertCardId(t, card, "zzzzzzzz")!;
    const again = parseNote(out)[0];
    expect(again.id).toBe("zzzzzzzz");
    expect(again.back).toBe(card.back);
    expect(again.tags).toEqual(["high-yield"]);
  });
});

describe("consecutive card lines (no blank line between them)", () => {
  it("each line with its own marker is its own card; plain lines under a card are its back", () => {
    const cards = parseNote(
      [
        "The ==ACL== resists anterior tibial translation.",
        "The ==PCL== resists posterior tibial translation.",
        "Tested with the posterior drawer.",
        "Most common knee ligament injury? :: ACL",
      ].join("\n"),
    );
    expect(cards.map((c) => c.front)).toEqual([
      "The ==ACL== resists anterior tibial translation.",
      "The ==PCL== resists posterior tibial translation.",
      "Most common knee ligament injury?",
    ]);
    expect(cards[0].back).toBe("");
    expect(cards[1].back).toBe("Tested with the posterior drawer.");
    expect(cards[1].idLine).toBe(2);
    expect(cards[0].idLine).toBe(0);
  });
});

describe("cards inside a paragraph of note text", () => {
  it("a card line directly under plain note text is still a card", () => {
    const cards = parseNote("Some context about the knee.\nThe ==ACL== is intra-articular.\nBut extrasynovial.");
    expect(cards).toHaveLength(1);
    expect(cards[0].startLine).toBe(1);
    expect(cards[0].back).toBe("But extrasynovial.");
  });
});

describe("obsidian-spaced-repetition cloze hints and groups (;;)", () => {
  it("==answer;;hint== shows the hint on the front and reveals only the answer", () => {
    const card = parseNote("==Anchoring;;which bias?== bias is fixating on an initial impression.")[0];
    const f = cardFaces(card, card.slots[0]);
    expect(f.question).toBe('<span class="fc-cloze">[which bias?]</span> bias is fixating on an initial impression.');
    expect(f.answer).toBe('<mark class="fc-answer">Anchoring</mark> bias is fixating on an initial impression.');
    expect(card.slots[0]).toBe(clozeSlotForText("Anchoring"));
  });

  it("==1;;x== groups clozes into one card, like Anki's c1", () => {
    const card = parseNote("The ==1;;radial== and ==1;;ulnar== arteries, and the ==2;;palmar arch;;where they join==.")[0];
    expect(card.slots).toEqual(["c1", "c2"]);
    const c1 = cardFaces(card, "c1");
    expect(c1.question).toBe('The <span class="fc-cloze">[...]</span> and <span class="fc-cloze">[...]</span> arteries, and the palmar arch.');
    expect(cardFaces(card, "c2").question).toContain("[where they join]");
  });
});

describe("cards inside card callouts (spec 0002 §3.2)", () => {
  const note = [
    "# Topic",
    "",
    "> [!tip] Buzzword",
    "> The ==classic== sign is not a card here.",
    "",
    "> [!card] Quick review",
    "> The ACL originates on the ==lateral femoral condyle==.",
    "> Posterior notch wall.",
    ">",
    "> Lachman tests the :: ACL",
    "",
    "Outside the callout, ==still a card==.",
  ].join("\n");
  const cards = parseNote(note);

  it("reads only card callouts, with real line numbers and the original lines", () => {
    expect(cards.map((c) => c.answer || c.clozes.map((x) => x.answer).join())).toEqual(["lateral femoral condyle", "ACL", "still a card"]);
    const [acl, lachman] = cards;
    expect(acl.startLine).toBe(6);
    expect(acl.endLine).toBe(7);
    expect(acl.back).toContain("Posterior notch wall.");
    expect(acl.sourceLines).toEqual(["> The ACL originates on the ==lateral femoral condyle==.", "> Posterior notch wall."]);
    expect(acl.quote).toBe("> ");
    expect(lachman.startLine).toBe(9);
  });

  it("writes IDs and rebuilt cards back inside the callout", () => {
    const withId = insertCardId(note, cards[0], "abcd1234")!;
    expect(withId.split("\n")[7]).toBe("> Posterior notch wall. ^fc-abcd1234");
    expect(parseNote(withId)[0].id).toBe("abcd1234");
    const split = composeCardSource({ ...cards[1], id: "zzzz9999" }, "Lachman tests the ACL", ["At 30° of flexion"]);
    expect(split).toBe("> Lachman tests the ACL\n> At 30° of flexion ^fc-zzzz9999");
  });
});
