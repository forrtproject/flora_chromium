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
