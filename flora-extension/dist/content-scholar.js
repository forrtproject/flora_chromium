"use strict";(()=>{var T=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function g(n){let r=n.trim();for(let i of T)if(r.toLowerCase().startsWith(i)){r=r.slice(i.length);break}return/^10\.\d{4,}/.test(r)?r.toLowerCase():null}var q="https://api.openalex.org/works",v="https://api.crossref.org/works",_="flora_doi:",L="flora-extension@example.com",b=88,d="[FLoRA:augment]";function $(n){return n.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function w(n){return n.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function S(n,r){let i=n.length>=r.length?n:r;if(i.length===0)return 1;let o=[];for(let a=0;a<=n.length;a++){let s=a;for(let e=0;e<=r.length;e++)if(a===0)o[e]=e;else if(e>0){let t=o[e-1];n.charAt(a-1)!==r.charAt(e-1)&&(t=Math.min(Math.min(t,s),o[e])+1),o[e-1]=s,s=t}a>0&&(o[r.length]=s)}return(i.length-o[r.length])/i.length}function R(n,r){let i=new Set($(n).split(/\s+/).filter(Boolean)),o=new Set($(r).split(/\s+/).filter(Boolean)),a=[...i].filter(f=>o.has(f)),s=[...i].filter(f=>!o.has(f)),e=[...o].filter(f=>!i.has(f)),t=a.sort().join(" "),l=[t,...s.sort()].join(" ").trim(),c=[t,...e.sort()].join(" ").trim(),u=S(t,l),p=S(t,c),m=S(l,c);return Math.max(u,p,m)*100}async function M(n){let r=w(n),i=`${v}?query.title=${encodeURIComponent(r)}&rows=5&mailto=${encodeURIComponent(L)}`;console.log(`${d} Crossref query for: "${n}"`);let o=await fetch(i);if(!o.ok)return console.warn(`${d} Crossref returned ${o.status}`),null;let s=(await o.json()).message?.items??[];console.log(`${d} Crossref returned ${s.length} candidates`);let e=null;for(let t of s){if(!t.DOI||!t.title?.[0])continue;let l=R(n,t.title[0]);if(console.log(`${d}   Crossref candidate: "${t.title[0]}" \u2192 score=${l.toFixed(1)}, DOI=${t.DOI}`),l>=b&&(!e||l>e.score)){let c=g(t.DOI);c&&(e={doi:c,title:t.title[0],score:l,source:"crossref"})}}return console.log(e?`${d} Crossref best match: "${e.title}" (score=${e.score.toFixed(1)}, DOI=${e.doi})`:`${d} Crossref: no match above threshold (${b})`),e}async function H(n){let r=w(n),i=`${q}?filter=title.search:${encodeURIComponent(r)}&select=id,doi,title&per_page=5&mailto=${encodeURIComponent(L)}`;console.log(`${d} OpenAlex query for: "${n}"`);let o=await fetch(i);if(!o.ok)return console.warn(`${d} OpenAlex returned ${o.status}`),null;let s=(await o.json()).results??[];console.log(`${d} OpenAlex returned ${s.length} candidates`);let e=null;for(let t of s){if(!t.doi||!t.title)continue;let l=R(n,t.title);if(console.log(`${d}   OpenAlex candidate: "${t.title}" \u2192 score=${l.toFixed(1)}, DOI=${t.doi}`),l>=b&&(!e||l>e.score)){let c=g(t.doi);c&&(e={doi:c,title:t.title,score:l,source:"openalex"})}}return console.log(e?`${d} OpenAlex best match: "${e.title}" (score=${e.score.toFixed(1)}, DOI=${e.doi})`:`${d} OpenAlex: no match above threshold (${b})`),e}async function C(n){let r=new Map;if(n.length===0)return r;console.log(`${d} Augmenting ${n.length} title(s):`,n);let i=[],o=n.map(s=>_+$(s));try{let s=await chrome.storage.local.get(o);for(let e of n){let t=_+$(e),l=s[t];if(l){let c=l.found&&l.doi?g(l.doi):null;r.set(e,c),console.log(`${d} Cache hit for "${e}": ${c??"not found"}`)}else i.push(e)}}catch{i.push(...n)}if(i.length===0)return r;console.log(`${d} ${i.length} title(s) uncached, querying Crossref + OpenAlex`);let a=i.map(async s=>{let[e,t]=await Promise.allSettled([M(s),H(s)]),l=[];e.status==="fulfilled"&&e.value?l.push(e.value):e.status==="rejected"&&console.warn(`${d} Crossref query failed:`,e.reason),t.status==="fulfilled"&&t.value?l.push(t.value):t.status==="rejected"&&console.warn(`${d} OpenAlex query failed:`,t.reason);let c=new Map;for(let h of l){let D=c.get(h.doi);(!D||h.score>D.score)&&c.set(h.doi,h)}let u=null;for(let h of c.values())(!u||h.score>u.score)&&(u=h);let p=u?.doi??null;r.set(s,p),console.log(u?`${d} Resolved "${s}" \u2192 ${u.doi} (via ${u.source}, score=${u.score.toFixed(1)})`:`${d} No DOI found for "${s}"`);let m=_+$(s),f={found:p!==null,doi:p};chrome.storage.local.set({[m]:f}).catch(()=>{})});await Promise.allSettled(a);for(let s of i)r.has(s)||r.set(s,null);return r}var A=`.flora-scholar-badge {
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
`;var E="flora-scholar-badge-host";function O(n,r){if(r.status!=="matched"||n.querySelector(`.${E}`))return;let i=r.result,o=i.record.stats;if(!(o.n_replications_total>0||o.n_reproductions_total>0||o.n_originals_total>0))return;let s=o.n_replications_total>0||o.n_reproductions_total>0?"badge--success":"badge--neutral",e=n.querySelector(".gs_rt");if(!e)return;let t=document.createElement("div");t.className=E;let l=t.attachShadow({mode:"open"}),c=document.createElement("style");c.textContent=A,l.appendChild(c);let u=o.n_replications_total===1?"replication":"replications",p=o.n_reproductions_total===1?"reproduction":"reproductions",m=o.n_originals_total===1?"original":"originals",f=document.createElement("a");f.className=`flora-scholar-badge ${s}`,f.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(i.doi)}`,f.target="_blank",f.rel="noopener",f.innerHTML=`
    <span class="badge-label">FLoRA</span>
    ${o.n_replications_total>0?`<span class="badge-count">${o.n_replications_total} ${u}</span>`:""}
    ${o.n_reproductions_total>0?`<span class="badge-count">${o.n_reproductions_total} ${p}</span>`:""}
    ${o.n_originals_total>0?`<span class="badge-count">${o.n_originals_total} ${m}</span>`:""}
  `,l.appendChild(f),e.insertAdjacentElement("afterend",t)}var U="#gs_res_ccl",x=".gs_r.gs_or.gs_scl",k="data-flora-processed";function F(){let n=document.querySelector(U);if(!n)return;new MutationObserver(i=>{let o=!1;for(let a of i){for(let s of a.addedNodes)if(s instanceof HTMLElement&&(s.matches(x)||s.querySelector(x))){o=!0;break}if(o)break}o&&y(document)}).observe(n,{childList:!0,subtree:!0})}async function y(n){let r=n.querySelectorAll(`${x}:not([${k}])`);if(r.length===0){console.log("[FLoRA] No unprocessed Scholar rows found");return}console.log(`[FLoRA] Processing ${r.length} Scholar rows`);let i=[],o=[];for(let e of r){e.setAttribute(k,"true");let t=B(e);if(t)i.push({row:e,doi:t}),I(e,`DOI: ${t}`,"#2e7d32");else{let c=e.querySelector(".gs_rt")?.textContent?.trim();c&&o.push({row:e,title:c})}}if(o.length>0)try{let e=o.map(l=>l.title),t=await C(e);for(let{row:l,title:c}of o){let u=t.get(c);u&&(i.push({row:l,doi:u}),I(l,`DOI: ${u}`,"#1565c0"))}}catch{}if(console.log(`[FLoRA] DOIs found: ${i.length}, titles without DOI: ${o.length}`),i.length===0)return;let a=[...new Set(i.map(e=>e.doi))];console.log("[FLoRA] Looking up DOIs:",a);let s={type:"FLORA_LOOKUP",dois:a};try{let e=await chrome.runtime.sendMessage(s);console.log("[FLoRA] Lookup response:",e);for(let{row:t,doi:l}of i)e.results[l]&&O(t,{status:"matched",result:e.results[l]})}catch(e){console.error("[FLoRA] Lookup failed:",e)}}var j="flora-debug-label";function I(n,r,i){let o=n.querySelector(".gs_rt");if(!o)return;let a=document.createElement("span");a.className=j,a.textContent=`[FLoRA] ${r}`,a.style.cssText=`
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${i};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: middle;
  `,o.appendChild(a)}function B(n){let r=n.querySelector(".gs_rt a");if(r?.href){let a=g(r.href);if(a)return a}let i=n.querySelector(".gs_a");if(i?.textContent){let a=i.textContent.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(a){let s=g(a[1]);if(s)return s}}let o=n.querySelectorAll("a[href]");for(let a of o)if(a.href.includes("doi.org/")){let s=g(a.href);if(s)return s}return null}console.log("[FLoRA] Scholar content script loaded");y(document);F();})();
