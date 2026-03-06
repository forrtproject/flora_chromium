"use strict";(()=>{var z=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function y(s){let r=s.trim();for(let l of z)if(r.toLowerCase().startsWith(l)){r=r.slice(l.length);break}return/^10\.\d{4,}/.test(r)?r.toLowerCase():null}var W="https://api.openalex.org/works",X="https://api.crossref.org/works",D="flora_doi:",k="flora-extension@example.com",C=88,f="[FLoRA:augment]";function b(s){return s.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function T(s){return s.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function R(s,r){let l=s.length>=r.length?s:r;if(l.length===0)return 1;let t=[];for(let a=0;a<=s.length;a++){let n=a;for(let e=0;e<=r.length;e++)if(a===0)t[e]=e;else if(e>0){let o=t[e-1];s.charAt(a-1)!==r.charAt(e-1)&&(o=Math.min(Math.min(o,n),t[e])+1),t[e-1]=n,n=o}a>0&&(t[r.length]=n)}return(l.length-t[r.length])/l.length}function I(s,r){let l=new Set(b(s).split(/\s+/).filter(Boolean)),t=new Set(b(r).split(/\s+/).filter(Boolean)),a=[...l].filter(u=>t.has(u)),n=[...l].filter(u=>!t.has(u)),e=[...t].filter(u=>!l.has(u)),o=a.sort().join(" "),i=[o,...n.sort()].join(" ").trim(),c=[o,...e.sort()].join(" ").trim(),d=R(o,i),m=R(o,c),p=R(i,c);return Math.max(d,m,p)*100}async function Z(s){let r=T(s),l=`${X}?query.title=${encodeURIComponent(r)}&rows=5&mailto=${encodeURIComponent(k)}`;console.log(`${f} Crossref query for: "${s}"`);let t=await fetch(l);if(!t.ok)return console.warn(`${f} Crossref returned ${t.status}`),null;let n=(await t.json()).message?.items??[];console.log(`${f} Crossref returned ${n.length} candidates`);let e=null;for(let o of n){if(!o.DOI||!o.title?.[0])continue;let i=I(s,o.title[0]);if(console.log(`${f}   Crossref candidate: "${o.title[0]}" \u2192 score=${i.toFixed(1)}, DOI=${o.DOI}`),i>=C&&(!e||i>e.score)){let c=y(o.DOI);c&&(e={doi:c,title:o.title[0],score:i,source:"crossref"})}}return console.log(e?`${f} Crossref best match: "${e.title}" (score=${e.score.toFixed(1)}, DOI=${e.doi})`:`${f} Crossref: no match above threshold (${C})`),e}async function K(s){let r=T(s),l=`${W}?filter=title.search:${encodeURIComponent(r)}&select=id,doi,title&per_page=5&mailto=${encodeURIComponent(k)}`;console.log(`${f} OpenAlex query for: "${s}"`);let t=await fetch(l);if(!t.ok)return console.warn(`${f} OpenAlex returned ${t.status}`),null;let n=(await t.json()).results??[];console.log(`${f} OpenAlex returned ${n.length} candidates`);let e=null;for(let o of n){if(!o.doi||!o.title)continue;let i=I(s,o.title);if(console.log(`${f}   OpenAlex candidate: "${o.title}" \u2192 score=${i.toFixed(1)}, DOI=${o.doi}`),i>=C&&(!e||i>e.score)){let c=y(o.doi);c&&(e={doi:c,title:o.title,score:i,source:"openalex"})}}return console.log(e?`${f} OpenAlex best match: "${e.title}" (score=${e.score.toFixed(1)}, DOI=${e.doi})`:`${f} OpenAlex: no match above threshold (${C})`),e}async function M(s){let r=new Map;if(s.length===0)return r;console.log(`${f} Augmenting ${s.length} title(s):`,s);let l=[],t=s.map(n=>D+b(n));try{let n=await chrome.storage.local.get(t);for(let e of s){let o=D+b(e),i=n[o];if(i){let c=i.found&&i.doi?y(i.doi):null;r.set(e,c),console.log(`${f} Cache hit for "${e}": ${c??"not found"}`)}else l.push(e)}}catch{l.push(...s)}if(l.length===0)return r;console.log(`${f} ${l.length} title(s) uncached, querying Crossref + OpenAlex`);let a=l.map(async n=>{let[e,o]=await Promise.allSettled([Z(n),K(n)]),i=[];e.status==="fulfilled"&&e.value?i.push(e.value):e.status==="rejected"&&console.warn(`${f} Crossref query failed:`,e.reason),o.status==="fulfilled"&&o.value?i.push(o.value):o.status==="rejected"&&console.warn(`${f} OpenAlex query failed:`,o.reason);let c=new Map;for(let h of i){let x=c.get(h.doi);(!x||h.score>x.score)&&c.set(h.doi,h)}let d=null;for(let h of c.values())(!d||h.score>d.score)&&(d=h);let m=d?.doi??null;r.set(n,m),console.log(d?`${f} Resolved "${n}" \u2192 ${d.doi} (via ${d.source}, score=${d.score.toFixed(1)})`:`${f} No DOI found for "${n}"`);let p=D+b(n),u={found:m!==null,doi:m};chrome.storage.local.set({[p]:u}).catch(()=>{})});await Promise.allSettled(a);for(let n of l)r.has(n)||r.set(n,null);return r}var F=`.flora-scholar-badge {
  all: initial;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 2px 10px;
  border-radius: 20px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: 0.02em;
  text-decoration: none;
  cursor: pointer;
  color: #fff;
}

.badge--success { background: #1a7f37; }
.badge--neutral { background: #656d76; }

.badge-label {
  font-weight: 700;
  margin-right: 2px;
}

.badge-count {
  font-weight: 500;
  opacity: 0.95;
}

.flora-scholar-badge:hover {
  filter: brightness(1.1);
}

@media print {
  .flora-scholar-badge {
    display: none !important;
  }
}
`;var q="flora-scholar-badge-host";function H(s,r){if(r.status!=="matched"||s.querySelector(`.${q}`))return;let l=r.result,t=l.record.stats;if(!(t.n_replications_total>0||t.n_reproductions_total>0||t.n_originals_total>0))return;let n=t.n_replications_total>0||t.n_reproductions_total>0?"badge--success":"badge--neutral",e=s.querySelector(".gs_ggs")??s.querySelector(".gs_ri")??s,o=document.createElement("div");o.className=q;let i=o.attachShadow({mode:"open"}),c=document.createElement("style");c.textContent=F,i.appendChild(c);let d=t.n_replications_total===1?"replication":"replications",m=t.n_reproductions_total===1?"reproduction":"reproductions",p=t.n_originals_total===1?"original":"originals",u=document.createElement("a");u.className=`flora-scholar-badge ${n}`,u.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(l.doi)}`,u.target="_blank",u.rel="noopener",u.innerHTML=`
    <span class="badge-label">FLoRA</span>
    ${t.n_replications_total>0?`<span class="badge-count">${t.n_replications_total} ${d}</span>`:""}
    ${t.n_reproductions_total>0?`<span class="badge-count">${t.n_reproductions_total} ${m}</span>`:""}
    ${t.n_originals_total>0?`<span class="badge-count">${t.n_originals_total} ${p}</span>`:""}
  `,i.appendChild(u),e.appendChild(o)}var V="#gs_res_ccl",A=".gs_r.gs_or.gs_scl",B="data-flora-processed";function U(){let s=document.querySelector(V);if(!s)return;new MutationObserver(l=>{let t=!1;for(let a of l){for(let n of a.addedNodes)if(n instanceof HTMLElement&&(n.matches(A)||n.querySelector(A))){t=!0;break}if(t)break}t&&E(document)}).observe(s,{childList:!0,subtree:!0})}async function E(s){let r=s.querySelectorAll(`${A}:not([${B}])`);if(r.length===0){console.log("[FLoRA] No unprocessed Scholar rows found");return}console.log(`[FLoRA] Processing ${r.length} Scholar rows`);let l=[],t=[];for(let e of r){e.setAttribute(B,"true");let o=Q(e);if(o)l.push({row:e,doi:o}),P(e,o,"#2e7d32");else{let c=e.querySelector(".gs_rt")?.textContent?.trim();c&&t.push({row:e,title:c})}}if(t.length>0)try{let e=t.map(i=>i.title),o=await M(e);for(let{row:i,title:c}of t){let d=o.get(c);d&&(l.push({row:i,doi:d}),P(i,d,"#1565c0"))}}catch{}if(console.log(`[FLoRA] DOIs found: ${l.length}, titles without DOI: ${t.length}`),l.length===0)return;let a=[...new Set(l.map(e=>e.doi))];console.log("[FLoRA] Looking up DOIs:",a);let n={type:"FLORA_LOOKUP",dois:a};try{let e=await chrome.runtime.sendMessage(n);console.log("[FLoRA] Lookup response:",e);for(let{row:o,doi:i}of l)e.results[i]&&H(o,{status:"matched",result:e.results[i]})}catch(e){console.error("[FLoRA] Lookup failed:",e)}}var J="flora-doi-label";function P(s,r,l){let t=s.querySelector(".gs_ggs")??s.querySelector(".gs_ri")??s,a=document.createElement("div");a.className=J,a.style.cssText="position: relative; display: inline-block; margin-top: 4px;";let n=document.createElement("span");n.textContent="DOI",n.style.cssText=`
    display: inline-block;
    font-size: 12px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: white;
    background: ${l};
    padding: 2px 10px;
    border-radius: 20px;
    cursor: pointer;
    user-select: none;
    line-height: 18px;
    letter-spacing: 0.02em;
  `;let e=document.createElement("div");e.style.cssText=`
    display: none;
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    background: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(27,31,36,0.12), 0 8px 24px rgba(66,74,83,0.12);
    padding: 10px 12px;
    z-index: 10000;
    white-space: nowrap;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12px;
    flex-direction: column;
    gap: 6px;
  `;let o=document.createElement("div");o.style.cssText=`
    font-size: 11px;
    font-weight: 600;
    color: #656d76;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  `,o.textContent="FLoRA";let i=document.createElement("div");i.style.cssText="display: flex; align-items: center;";let c=document.createElement("span");c.textContent=r,c.style.cssText="color: #1f2328; margin-right: 8px; font-size: 12px;";let d='<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block;"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>',m='<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block;"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>',p=document.createElement("button");p.innerHTML=d,p.title="Copy DOI",p.style.cssText=`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    min-width: 14px;
    min-height: 14px;
    padding: 0;
    margin: 0;
    border: none;
    background: none;
    cursor: pointer;
    color: #656d76;
    transition: color 0.15s ease;
    line-height: 0;
    font-size: 0;
  `,p.addEventListener("mouseenter",()=>{p.style.color="#24292f"}),p.addEventListener("mouseleave",()=>{p.style.color="#656d76"}),p.addEventListener("click",g=>{g.stopPropagation(),navigator.clipboard.writeText(r).then(()=>{p.innerHTML=m,p.style.color="#1a7f37",setTimeout(()=>{p.innerHTML=d,p.style.color="#656d76"},1500)})}),i.appendChild(c),i.appendChild(p),e.appendChild(o),e.appendChild(i);let u=null,h=()=>{u&&(clearTimeout(u),u=null),e.style.top="0",e.style.bottom="auto",e.style.left="0",e.style.right="auto",e.style.display="flex";let g=8,$=n.getBoundingClientRect(),S=e.getBoundingClientRect(),j=window.innerWidth,N=window.innerHeight,w=j-$.right-g,_=$.left-g,v=N-$.bottom-g,O=$.top-g;if(w>=S.width)e.style.left=`calc(100% + ${g}px)`,e.style.right="auto",e.style.top="0",e.style.bottom="auto";else if(_>=S.width)e.style.left="auto",e.style.right=`calc(100% + ${g}px)`,e.style.top="0",e.style.bottom="auto";else if(v>=S.height)e.style.top=`calc(100% + ${g}px)`,e.style.bottom="auto",e.style.left="0",e.style.right="auto";else if(O>=S.height)e.style.top="auto",e.style.bottom=`calc(100% + ${g}px)`,e.style.left="0",e.style.right="auto";else{let L=Math.max(w,_,v,O);L===w||L===_?(e.style.top="0",e.style.bottom="auto",L===w?(e.style.left=`calc(100% + ${g}px)`,e.style.right="auto"):(e.style.left="auto",e.style.right=`calc(100% + ${g}px)`)):(e.style.left="0",e.style.right="auto",L===v?(e.style.top=`calc(100% + ${g}px)`,e.style.bottom="auto"):(e.style.top="auto",e.style.bottom=`calc(100% + ${g}px)`))}},x=()=>{u=setTimeout(()=>{e.style.display="none"},200)};n.addEventListener("mouseenter",h),n.addEventListener("mouseleave",x),e.addEventListener("mouseenter",h),e.addEventListener("mouseleave",x),a.appendChild(n),a.appendChild(e),t.appendChild(a)}function Q(s){let r=s.querySelector(".gs_rt a");if(r?.href){let a=y(r.href);if(a)return a}let l=s.querySelector(".gs_a");if(l?.textContent){let a=l.textContent.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(a){let n=y(a[1]);if(n)return n}}let t=s.querySelectorAll("a[href]");for(let a of t)if(a.href.includes("doi.org/")){let n=y(a.href);if(n)return n}return null}console.log("[FLoRA] Scholar content script loaded");E(document);U();})();
