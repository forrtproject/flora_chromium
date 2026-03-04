"use strict";(()=>{var O=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function g(n){let e=n.trim();for(let o of O)if(e.toLowerCase().startsWith(o)){e=e.slice(o.length);break}return/^10\.\d{4,}/.test(e)?e.toLowerCase():null}var M="https://api.openalex.org/works",m="flora_doi:",$="flora-extension@example.com",I=.8;function p(n){return n.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function F(n){return n.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function H(n,e){let o=n.length>=e.length?n:e,i=n.length>=e.length?e:n;if(o.length===0)return 1;let r=[];for(let a=0;a<=n.length;a++){let t=a;for(let s=0;s<=e.length;s++)if(a===0)r[s]=s;else if(s>0){let c=r[s-1];n.charAt(a-1)!==e.charAt(s-1)&&(c=Math.min(Math.min(c,t),r[s])+1),r[s-1]=t,t=c}a>0&&(r[e.length]=t)}return(o.length-r[e.length])/o.length}async function E(n){let e=new Map;if(n.length===0)return e;let o=[],i=n.map(t=>m+p(t));try{let t=await chrome.storage.local.get(i);for(let s of n){let c=m+p(s),l=t[c];l?e.set(s,l.found&&l.doi?g(l.doi):null):o.push(s)}}catch{o.push(...n)}if(o.length===0)return e;let r=o.map(t=>encodeURIComponent(F(t))).join("|"),a=`${M}?filter=title.search:${r}&select=id,doi,title&per_page=50&mailto=${encodeURIComponent($)}`;try{let t=await fetch(a);if(!t.ok){for(let l of o)e.set(l,null);return e}let s=await t.json(),c=new Set;for(let l of s.results??[]){if(!l.doi||!l.title)continue;let d=p(l.title),u=null,x=0;for(let f of o){if(c.has(f))continue;let h=H(d,p(f));h>x&&h>I&&(x=h,u=f)}if(u){c.add(u);let f=g(l.doi);e.set(u,f);let h=m+p(u),T={found:f!==null,doi:f};chrome.storage.local.set({[h]:T}).catch(()=>{})}}for(let l of o)if(!e.has(l)){e.set(l,null);let d=m+p(l),u={found:!1,doi:null};chrome.storage.local.set({[d]:u}).catch(()=>{})}}catch{for(let t of o)e.has(t)||e.set(t,null)}return e}var R=`.flora-scholar-badge {
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
`;var D="flora-scholar-badge-host";function A(n,e){if(e.status!=="matched"||n.querySelector(`.${D}`))return;let o=e.result,i=o.record.stats,r=i.n_replications_total>0?"badge--success":"badge--neutral",a=n.querySelector(".gs_rt");if(!a)return;let t=document.createElement("div");t.className=D;let s=t.attachShadow({mode:"open"}),c=document.createElement("style");c.textContent=R,s.appendChild(c);let l=document.createElement("a");l.className=`flora-scholar-badge ${r}`,l.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(o.doi)}`,l.target="_blank",l.rel="noopener",l.innerHTML=`
    <span class="badge-label">FLoRA</span>
    <span class="badge-count">${i.n_replications_total} repl</span>
    ${i.n_reproductions_total>0?`<span class="badge-count">${i.n_reproductions_total} repro</span>`:""}
  `,s.appendChild(l),a.insertAdjacentElement("afterend",t)}var q="#gs_res_ccl",y=".gs_r.gs_or.gs_scl",_="data-flora-processed";function k(){let n=document.querySelector(q);if(!n)return;new MutationObserver(o=>{let i=!1;for(let r of o){for(let a of r.addedNodes)if(a instanceof HTMLElement&&(a.matches(y)||a.querySelector(y))){i=!0;break}if(i)break}i&&S(document)}).observe(n,{childList:!0,subtree:!0})}async function S(n){let e=n.querySelectorAll(`${y}:not([${_}])`);if(e.length===0){console.log("[FLoRA] No unprocessed Scholar rows found");return}console.log(`[FLoRA] Processing ${e.length} Scholar rows`);let o=[],i=[];for(let t of e){t.setAttribute(_,"true");let s=N(t);if(s)o.push({row:t,doi:s}),L(t,`DOI: ${s}`,"#2e7d32");else{let l=t.querySelector(".gs_rt")?.textContent?.trim();l?(i.push({row:t,title:l}),L(t,"no DOI \u2014 trying OpenAlex\u2026","#e65100")):L(t,"no DOI, no title","#b71c1c")}}if(i.length>0)try{let t=i.map(c=>c.title),s=await E(t);for(let{row:c,title:l}of i){let d=s.get(l);d?(o.push({row:c,doi:d}),w(c,`DOI (via OpenAlex): ${d}`,"#1565c0")):w(c,"no DOI found","#b71c1c")}}catch{}if(console.log(`[FLoRA] DOIs found: ${o.length}, titles without DOI: ${i.length}`),o.length===0)return;let r=[...new Set(o.map(t=>t.doi))];console.log("[FLoRA] Looking up DOIs:",r);let a={type:"FLORA_LOOKUP",dois:r};try{let t=await chrome.runtime.sendMessage(a);console.log("[FLoRA] Lookup response:",t);for(let{row:s,doi:c}of o)t.results[c]?(A(s,{status:"matched",result:t.results[c]}),b(s,"FLoRA: MATCH \u2713","#2e7d32")):t.errors[c]?b(s,`FLoRA: error \u2014 ${t.errors[c]}`,"#b71c1c"):b(s,"FLoRA: no replication data","#757575")}catch(t){console.error("[FLoRA] Lookup failed:",t);for(let{row:s}of o)b(s,"FLoRA: lookup failed","#b71c1c")}}var C="flora-debug-label";function L(n,e,o){let i=n.querySelector(".gs_rt");if(!i)return;let r=document.createElement("span");r.className=C,r.textContent=`[FLoRA] ${e}`,r.style.cssText=`
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${o};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: middle;
  `,i.appendChild(r)}function b(n,e,o){let i=n.querySelector(".gs_rt");if(!i)return;let r=document.createElement("span");r.className="flora-debug-flora-status",r.textContent=`[${e}]`,r.style.cssText=`
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${o};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 4px;
    vertical-align: middle;
  `,i.appendChild(r)}function w(n,e,o){let i=n.querySelector(`.${C}`);i?(i.textContent=`[FLoRA] ${e}`,i.style.background=o):L(n,e,o)}function N(n){let e=n.querySelector(".gs_rt a");if(e?.href){let r=g(e.href);if(r)return r}let o=n.querySelector(".gs_a");if(o?.textContent){let r=o.textContent.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(r){let a=g(r[1]);if(a)return a}}let i=n.querySelectorAll("a[href]");for(let r of i)if(r.href.includes("doi.org/")){let a=g(r.href);if(a)return a}return null}console.log("[FLoRA] Scholar content script loaded");S(document);k();})();
