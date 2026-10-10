import { describe, expect, it } from "vitest";
import { escapeCardText, htmlToMarkdown } from "../src/core/anki/html";

const media = (f: string) => `Anki/Deck/media/${f}`;

describe("Anki HTML → Markdown", () => {
  it("handles breaks, divs, bold/italic, entities and images", () => {
    expect(htmlToMarkdown('The <b>ACL</b>&nbsp;is <i>intra</i>-articular<br><div>Second line</div><img src="acl%20x.png">', media)).toBe(
      "The **ACL** is *intra*-articular\nSecond line\n![[Anki/Deck/media/acl x.png]]",
    );
  });

  it("converts lists (nested and ordered), links, sounds and MathJax", () => {
    const md = htmlToMarkdown(
      'Causes:<ul><li>A</li><li>B<ol><li>b1</li><li>b2</li></ol></li></ul><a href="https://x.org">ref</a> [sound:beat.mp3] \\(x^2\\) \\[y\\]',
      media,
    );
    expect(md).toBe("Causes:\n- A\n- B\n    1. b1\n    2. b2\n[ref](https://x.org) ![[Anki/Deck/media/beat.mp3]] $x^2$ $y$");
  });

  it("drops styles, scripts, spans and comments but keeps text", () => {
    expect(htmlToMarkdown('<style>.x{}</style><span style="color:red">red</span><!-- c --> text', media)).toBe("red text");
  });
});

describe("escaping for #flashcards notes", () => {
  it("escapes stray markers but keeps Anki clozes", () => {
    expect(escapeCardText("a == b, ratio 3::1, #hashtag {{c1::x::y}}", { keepAnkiCloze: true })).toBe(
      "a \\=\\= b, ratio 3:\\:1, \\#hashtag {{c1::x::y}}",
    );
    expect(escapeCardText("# heading-like", { keepAnkiCloze: false })).toBe("\\# heading-like");
    expect(escapeCardText("> quote", { keepAnkiCloze: false })).toBe("\\> quote");
  });

  it("keeps emphasis markers tight against the text, whichever side Anki's spaces were on", () => {
    const md = (h: string) => htmlToMarkdown(h, () => null);
    expect(md("<b>layers </b>{{c2::<b>1</b> and <b>2</b>}}<b> on the </b>{{c2::<b>medial</b>}} knee")).toBe("**layers** {{c2::**1** and **2**}} **on the** {{c2::**medial**}} knee");
    expect(md("during <b>TKA </b>for a <b> valgus knee</b>, x")).toBe("during **TKA** for a **valgus knee**, x");
    expect(md("<i>Structures </i>that <b><i> both </i></b>end")).toBe("*Structures* that ***both*** end");
  });
  it("writes bold inside bold as one bold", () => {
    expect(htmlToMarkdown("<b>a <b>b</b> c</b> d", () => null)).toBe("**a b c** d");
  });
  it("drops empty bold from Anki (<b> </b>), which broke the whole line's rendering", () => {
    const md = htmlToMarkdown("<i>Structures</i> of the {{c2::<b>posterior</b>}}<b> </b>column <br>{{c1::<b>Posterior wall</b>}}", () => null);
    expect(md).toBe("*Structures* of the {{c2::**posterior**}} column\n{{c1::**Posterior wall**}}");
    expect(htmlToMarkdown("<b>a</b> <b>b</b>", () => null)).toBe("**a b**");
  });
});
