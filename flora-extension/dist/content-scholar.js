"use strict";(()=>{var q=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function f(n){let s=n.trim();for(let r of q)if(s.toLowerCase().startsWith(r)){s=s.slice(r.length);break}return/^10\.\d{4,}/.test(s)?s.toLowerCase():null}var H="https://api.openalex.org/works",P="https://api.crossref.org/works",S="flora_doi:",C="flora-extension@example.com",b=88,d="[FLoRA:augment]";function h(n){return n.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function w(n){return n.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function L(n,s){let r=n.length>=s.length?n:s;if(r.length===0)return 1;let t=[];for(let l=0;l<=n.length;l++){let i=l;for(let e=0;e<=s.length;e++)if(l===0)t[e]=e;else if(e>0){let o=t[e-1];n.charAt(l-1)!==s.charAt(e-1)&&(o=Math.min(Math.min(o,i),t[e])+1),t[e-1]=i,i=o}l>0&&(t[s.length]=i)}return(r.length-t[s.length])/r.length}function E(n,s){let r=new Set(h(n).split(/\s+/).filter(Boolean)),t=new Set(h(s).split(/\s+/).filter(Boolean)),l=[...r].filter(g=>t.has(g)),i=[...r].filter(g=>!t.has(g)),e=[...t].filter(g=>!r.has(g)),o=l.sort().join(" "),c=[o,...i.sort()].join(" ").trim(),a=[o,...e.sort()].join(" ").trim(),u=L(o,c),m=L(o,a),y=L(c,a);return Math.max(u,m,y)*100}async function N(n){let s=w(n),r=`${P}?query.title=${encodeURIComponent(s)}&rows=5&mailto=${encodeURIComponent(C)}`;console.log(`${d} Crossref query for: "${n}"`);let t=await fetch(r);if(!t.ok)return console.warn(`${d} Crossref returned ${t.status}`),null;let i=(await t.json()).message?.items??[];console.log(`${d} Crossref returned ${i.length} candidates`);let e=null;for(let o of i){if(!o.DOI||!o.title?.[0])continue;let c=E(n,o.title[0]);if(console.log(`${d}   Crossref candidate: "${o.title[0]}" \u2192 score=${c.toFixed(1)}, DOI=${o.DOI}`),c>=b&&(!e||c>e.score)){let a=f(o.DOI);a&&(e={doi:a,title:o.title[0],score:c,source:"crossref"})}}return console.log(e?`${d} Crossref best match: "${e.title}" (score=${e.score.toFixed(1)}, DOI=${e.doi})`:`${d} Crossref: no match above threshold (${b})`),e}async function U(n){let s=w(n),r=`${H}?filter=title.search:${encodeURIComponent(s)}&select=id,doi,title&per_page=5&mailto=${encodeURIComponent(C)}`;console.log(`${d} OpenAlex query for: "${n}"`);let t=await fetch(r);if(!t.ok)return console.warn(`${d} OpenAlex returned ${t.status}`),null;let i=(await t.json()).results??[];console.log(`${d} OpenAlex returned ${i.length} candidates`);let e=null;for(let o of i){if(!o.doi||!o.title)continue;let c=E(n,o.title);if(console.log(`${d}   OpenAlex candidate: "${o.title}" \u2192 score=${c.toFixed(1)}, DOI=${o.doi}`),c>=b&&(!e||c>e.score)){let a=f(o.doi);a&&(e={doi:a,title:o.title,score:c,source:"openalex"})}}return console.log(e?`${d} OpenAlex best match: "${e.title}" (score=${e.score.toFixed(1)}, DOI=${e.doi})`:`${d} OpenAlex: no match above threshold (${b})`),e}async function O(n){let s=new Map;if(n.length===0)return s;console.log(`${d} Augmenting ${n.length} title(s):`,n);let r=[],t=n.map(i=>S+h(i));try{let i=await chrome.storage.local.get(t);for(let e of n){let o=S+h(e),c=i[o];if(c){let a=c.found&&c.doi?f(c.doi):null;s.set(e,a),console.log(`${d} Cache hit for "${e}": ${a??"not found"}`)}else r.push(e)}}catch{r.push(...n)}if(r.length===0)return s;console.log(`${d} ${r.length} title(s) uncached, querying Crossref + OpenAlex`);let l=r.map(async i=>{let[e,o]=await Promise.allSettled([N(i),U(i)]),c=[];e.status==="fulfilled"&&e.value?c.push(e.value):e.status==="rejected"&&console.warn(`${d} Crossref query failed:`,e.reason),o.status==="fulfilled"&&o.value?c.push(o.value):o.status==="rejected"&&console.warn(`${d} OpenAlex query failed:`,o.reason);let a=new Map;for(let p of c){let A=a.get(p.doi);(!A||p.score>A.score)&&a.set(p.doi,p)}let u=null;for(let p of a.values())(!u||p.score>u.score)&&(u=p);let m=u?.doi??null;s.set(i,m),console.log(u?`${d} Resolved "${i}" \u2192 ${u.doi} (via ${u.source}, score=${u.score.toFixed(1)})`:`${d} No DOI found for "${i}"`);let y=S+h(i),g={found:m!==null,doi:m};chrome.storage.local.set({[y]:g}).catch(()=>{})});await Promise.allSettled(l);for(let i of r)s.has(i)||s.set(i,null);return s}var _=`.flora-scholar-badge {
  all: initial;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 3px 10px;
  border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  text-decoration: none;
  cursor: pointer;
  color: #fff;
}

.badge--success { background: #16a34a; }
.badge--warning { background: #ea580c; }

.badge-label {
  font-weight: 700;
  margin-right: 2px;
}

.badge-count {
  font-weight: 500;
  opacity: 0.95;
}

.badge-alert {
  font-weight: 600;
  background: rgba(255, 255, 255, 0.2);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.flora-scholar-badge:hover {
  filter: brightness(1.15);
}

@media print {
  .flora-scholar-badge {
    display: none !important;
  }
}
`;var k="flora-scholar-badge-host";function I(n,s){if(s.status!=="matched"||n.querySelector(`.${k}`))return;let r=s.result,t=r.record.stats,l=t.n_replications_total>0?"badge--success":"badge--neutral",i=n.querySelector(".gs_rt");if(!i)return;let e=document.createElement("div");e.className=k;let o=e.attachShadow({mode:"open"}),c=document.createElement("style");c.textContent=_,o.appendChild(c);let a=document.createElement("a");a.className=`flora-scholar-badge ${l}`,a.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(r.doi)}`,a.target="_blank",a.rel="noopener",a.innerHTML=`
    <span class="badge-label">FLoRA</span>
    <span class="badge-count">${t.n_replications_total} repl</span>
    ${t.n_reproductions_total>0?`<span class="badge-count">${t.n_reproductions_total} repro</span>`:""}
  `,o.appendChild(a),i.insertAdjacentElement("afterend",e)}var B="#gs_res_ccl",D=".gs_r.gs_or.gs_scl",F="data-flora-processed";function v(){let n=document.querySelector(B);if(!n)return;new MutationObserver(r=>{let t=!1;for(let l of r){for(let i of l.addedNodes)if(i instanceof HTMLElement&&(i.matches(D)||i.querySelector(D))){t=!0;break}if(t)break}t&&R(document)}).observe(n,{childList:!0,subtree:!0})}async function R(n){let s=n.querySelectorAll(`${D}:not([${F}])`);if(s.length===0){console.log("[FLoRA] No unprocessed Scholar rows found");return}console.log(`[FLoRA] Processing ${s.length} Scholar rows`);let r=[],t=[];for(let e of s){e.setAttribute(F,"true");let o=z(e);if(o)r.push({row:e,doi:o}),x(e,`DOI: ${o}`,"#2e7d32");else{let a=e.querySelector(".gs_rt")?.textContent?.trim();a?(t.push({row:e,title:a}),x(e,"no DOI \u2014 resolving\u2026","#e65100")):x(e,"no DOI, no title","#b71c1c")}}if(t.length>0)try{let e=t.map(c=>c.title),o=await O(e);for(let{row:c,title:a}of t){let u=o.get(a);u?(r.push({row:c,doi:u}),T(c,`DOI (resolved): ${u}`,"#1565c0")):T(c,"no DOI found","#b71c1c")}}catch{}if(console.log(`[FLoRA] DOIs found: ${r.length}, titles without DOI: ${t.length}`),r.length===0)return;let l=[...new Set(r.map(e=>e.doi))];console.log("[FLoRA] Looking up DOIs:",l);let i={type:"FLORA_LOOKUP",dois:l};try{let e=await chrome.runtime.sendMessage(i);console.log("[FLoRA] Lookup response:",e);for(let{row:o,doi:c}of r)e.results[c]?(I(o,{status:"matched",result:e.results[c]}),$(o,"FLoRA: MATCH \u2713","#2e7d32")):e.errors[c]?$(o,`FLoRA: error \u2014 ${e.errors[c]}`,"#b71c1c"):$(o,"FLoRA: no replication data","#757575")}catch(e){console.error("[FLoRA] Lookup failed:",e);for(let{row:o}of r)$(o,"FLoRA: lookup failed","#b71c1c")}}var M="flora-debug-label";function x(n,s,r){let t=n.querySelector(".gs_rt");if(!t)return;let l=document.createElement("span");l.className=M,l.textContent=`[FLoRA] ${s}`,l.style.cssText=`
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${r};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: middle;
  `,t.appendChild(l)}function $(n,s,r){let t=n.querySelector(".gs_rt");if(!t)return;let l=document.createElement("span");l.className="flora-debug-flora-status",l.textContent=`[${s}]`,l.style.cssText=`
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${r};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 4px;
    vertical-align: middle;
  `,t.appendChild(l)}function T(n,s,r){let t=n.querySelector(`.${M}`);t?(t.textContent=`[FLoRA] ${s}`,t.style.background=r):x(n,s,r)}function z(n){let s=n.querySelector(".gs_rt a");if(s?.href){let l=f(s.href);if(l)return l}let r=n.querySelector(".gs_a");if(r?.textContent){let l=r.textContent.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(l){let i=f(l[1]);if(i)return i}}let t=n.querySelectorAll("a[href]");for(let l of t)if(l.href.includes("doi.org/")){let i=f(l.href);if(i)return i}return null}console.log("[FLoRA] Scholar content script loaded");R(document);v();})();
