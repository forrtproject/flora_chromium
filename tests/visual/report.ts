// Package captured images into a portable review page (no hosting required).
import {readFileSync, writeFileSync, existsSync, mkdirSync} from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "tests/visual/output");
let results: Array<{name: string; status: string; detail?: string; changed?: boolean}>;
try {
  results = JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8"));
} catch {
  results = [{name: "capture", status: "fail", detail: "Capture did not produce valid results. See the capture job log for the original error."}];
}
mkdirSync(dir, {recursive: true});
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]!));
const picture = (name: string, kind: string) => {
  const file = path.join(dir, `${name}.${kind}.png`);
  if (!existsSync(file)) return `<p>${escape(kind)} unavailable</p>`;
  return `<img alt="${escape(name)} ${kind}" src="data:image/png;base64,${readFileSync(file).toString("base64")}">`;
};
const rows = [...results].sort((a, b) => Number(!!b.changed) - Number(!!a.changed));
writeFileSync(path.join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Visual PR review</title>
<style>body{font:16px system-ui;margin:2rem;color:#222}section{border-top:1px solid #aaa;padding:1rem 0}.shots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}img{width:100%;border:1px solid #aaa}summary{cursor:pointer}h2{font-size:1.2rem}</style>
<h1>Visual PR review</h1><p>Base and PR rendered with the same Chrome version and fixtures. Inspect placement, clipping, readability, and missing badges. Changed fixtures appear first. Open the PNG files for full resolution.</p>
${rows.map((r) => `<section><details ${r.status === "fail" ? "open" : ""}><summary>${escape(r.name)} — ${escape(r.detail ?? r.status)}</summary><div class="shots">${["before", "actual", "diff"].map((kind) => `<div><h2>${kind === "actual" ? "PR" : kind}</h2>${picture(r.name, kind)}</div>`).join("")}</div></details></section>`).join("")}`);
