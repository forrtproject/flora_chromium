import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";
import { extractDOIs } from "../../src/shared/doi-extractor";

function loadFixture(name: string): Document {
  const html = readFileSync(
    join(__dirname, "..", "fixtures", name),
    "utf-8"
  );
  return new JSDOM(html).window.document;
}

describe("extractDOIs", () => {
  it("extracts DOI from citation_doi meta tag", () => {
    const doc = loadFixture("meta-tags.html");
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1038/nature12373");
  });

  it("extracts DOI from JSON-LD @id", () => {
    const doc = loadFixture("json-ld.html");
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1126/science.1234567");
  });

  it("extracts DOI from visible body text via regex", () => {
    const doc = loadFixture("doi-in-text.html");
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1371/journal.pone.0012345");
  });

  it("extracts DOI from link href", () => {
    const doc = loadFixture("doi-in-href.html");
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1016/j.cell.2020.01.001");
  });

  it("returns empty array when no DOIs present", () => {
    const doc = loadFixture("no-dois.html");
    const dois = extractDOIs(doc);
    expect(dois).toHaveLength(0);
  });

  it("deduplicates DOIs found in multiple layers", () => {
    const html = `<!DOCTYPE html>
    <html><head>
      <meta name="citation_doi" content="10.1038/nature12373">
    </head><body>
      <a href="https://doi.org/10.1038/nature12373">link</a>
      <p>Also see 10.1038/nature12373 in text.</p>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    expect(dois).toHaveLength(1);
    expect(dois[0]).toBe("10.1038/nature12373");
  });

  it("extracts DOI from table cell and data attributes", () => {
    const doc = loadFixture("doi-in-table.html");
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1037/pspa0000345");
    expect(dois).toContain("10.1177/0956797620904990");
  });

  it("strips trailing punctuation from DOIs", () => {
    const html = `<!DOCTYPE html>
    <html><head></head><body>
      <p>See 10.1038/nature12373, and also (10.1126/science.9999999).</p>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1038/nature12373");
    expect(dois).toContain("10.1126/science.9999999");
    // Should NOT include trailing comma or unbalanced parenthesis
    expect(dois.some(d => d.endsWith(","))).toBe(false);
    expect(dois.some(d => d.endsWith(")"))).toBe(false);
  });

  it("preserves balanced parentheses inside DOIs", () => {
    const html = `<!DOCTYPE html>
    <html><head></head><body>
      <p>See 10.1016/S0924-9338(98)80023-0 and 10.1016/S0924-9338(97)83297-X for details.</p>
      <p>Also (10.1016/S0924-9338(98)80023-0) in parens.</p>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    // normaliseDOI lowercases all DOIs
    expect(dois).toContain("10.1016/s0924-9338(98)80023-0");
    expect(dois).toContain("10.1016/s0924-9338(97)83297-x");
  });

  it("extracts DOI from full URL in body text", () => {
    const html = `<!DOCTYPE html>
    <html><head></head><body>
      <p>Available at https://doi.org/10.1016/j.jep.2021.114500 for review.</p>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1016/j.jep.2021.114500");
  });

  it("extracts DOI hidden in raw HTML but not visible text", () => {
    const html = `<!DOCTYPE html>
    <html><head></head><body>
      <div style="display:none" data-ref="10.1080/23311908.2020.1823255">hidden</div>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1080/23311908.2020.1823255");
  });

  it("extracts DOI from page URL (e.g. SAGE journal URLs)", () => {
    const html = `<!DOCTYPE html><html><head></head><body><p>Abstract text</p></body></html>`;
    const doc = new JSDOM(html, {
      url: "https://journals.sagepub.com/doi/abs/10.1177/13634615211043764",
    }).window.document;
    const dois = extractDOIs(doc);
    expect(dois).toContain("10.1177/13634615211043764");
  });

  it("strips URL fragments, query strings, and supplementary paths from DOIs", () => {
    const html = `<!DOCTYPE html>
    <html><head></head><body>
      <a href="https://doi.org/10.1177/13634615211043764#skipnavigationto">link1</a>
      <a href="https://doi.org/10.1177/13634615211043764#pane-91a67f5d">link2</a>
      <a href="https://doi.org/10.1177/13634615211043764/suppl_file/sj-doc-3-tps-10.1177_13634615211043764.doc">supp</a>
      <a href="https://doi.org/10.1046/j.1440-1614.2003.01087.x?icid=int.sj-abstract.similar-articles.5">link3</a>
      <a href="https://doi.org/10.1177/13634615211043764&anti-forgery-token=abc123">link4</a>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    // Should extract the clean DOIs, not the junk suffixes
    expect(dois).toContain("10.1177/13634615211043764");
    expect(dois).toContain("10.1046/j.1440-1614.2003.01087.x");
    // Should NOT contain any of the polluted versions
    expect(dois.some(d => d.includes("#"))).toBe(false);
    expect(dois.some(d => d.includes("?"))).toBe(false);
    expect(dois.some(d => d.includes("&"))).toBe(false);
    expect(dois.some(d => d.includes("suppl_file"))).toBe(false);
  });

  it("extracts multiple distinct DOIs from one page", () => {
    const html = `<!DOCTYPE html>
    <html><head>
      <meta name="citation_doi" content="10.1038/nature12373">
    </head><body>
      <a href="https://doi.org/10.1126/science.9999999">ref</a>
    </body></html>`;
    const doc = new JSDOM(html).window.document;
    const dois = extractDOIs(doc);
    expect(dois).toHaveLength(2);
    expect(dois).toContain("10.1038/nature12373");
    expect(dois).toContain("10.1126/science.9999999");
  });
});
