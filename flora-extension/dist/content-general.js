"use strict";(()=>{var G=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function g(o){let e=o.trim();for(let r of G)if(e.toLowerCase().startsWith(r)){e=e.slice(r.length);break}return/^10\.\d{4,}/.test(e)?e.toLowerCase():null}var T=/(10\.\d{4,}(?:\.\d+)*\/[^\s,;\]}>'"<#?&]+)/g,x="[FLoRA:extractor]",J=/[\u200B\u200C\u200D\u00AD\uFEFF\u2060]/g;function _(o){let e=o.indexOf("/");return e===-1?!1:o.slice(e+1).length>=2}function F(o){let e=o.replace(/[.,;:]+$/,""),r=0,a=e.length;for(let s=0;s<e.length;s++)if(e[s]==="(")r++;else if(e[s]===")")if(r>0)r--;else{a=s;break}return e=e.slice(0,a),e=e.replace(/[.,;:]+$/,""),e}function M(o){let e=new Set,r=e.size;K(o,e),e.size>r&&console.log(`${x} URL layer found ${e.size-r} DOI(s):`,[...e]);let a=e.size;W(o,e),e.size>a&&console.log(`${x} Meta tag layer found ${e.size-a} new DOI(s)`);let s=e.size;Y(o,e),e.size>s&&console.log(`${x} JSON-LD layer found ${e.size-s} new DOI(s)`);let i=e.size;Q(o,e),e.size>i&&console.log(`${x} DOI link layer found ${e.size-i} new DOI(s)`);let t=e.size;Z(o,e),e.size>t&&console.log(`${x} Visible text layer found ${e.size-t} new DOI(s)`);let n=[...e];return n.length>0?console.log(`${x} Total DOIs extracted: ${n.length}`,n):console.log(`${x} No DOIs found on page`),n}function K(o,e){let a=(o.location?.href??"").matchAll(T);for(let s of a){let i=F(s[1]);if(!_(i))continue;let t=g(i);t&&e.add(t)}}function W(o,e){let r=['meta[name="citation_doi"]','meta[name="DC.identifier"]','meta[name="dc.identifier"]','meta[name="DOI"]','meta[property="citation_doi"]'];for(let a of r){let s=o.querySelector(a);if(s?.content){let i=g(s.content);i&&e.add(i)}}}function Y(o,e){let r=o.querySelectorAll('script[type="application/ld+json"]');for(let a of r)try{let s=JSON.parse(a.textContent??""),i=Array.isArray(s)?s:[s];for(let t of i){if(typeof t?.["@id"]=="string"){let n=g(t["@id"]);n&&e.add(n)}if(typeof t?.doi=="string"){let n=g(t.doi);n&&e.add(n)}}}catch{}}function Q(o,e){let r=o.querySelectorAll("a[href]");for(let a of r){let s=a.href;if(!s)continue;try{let n=new URL(s).hostname.toLowerCase();if(n!=="doi.org"&&n!=="dx.doi.org")continue}catch{continue}let i=g(s);i&&e.add(i)}}function Z(o,e){let s=(o.body?.innerText||o.body?.textContent||"").replace(J,"").matchAll(T);for(let i of s){let t=F(i[1]);if(!_(t))continue;let n=g(t);n&&e.add(n)}}var ee="https://api.openalex.org/works",oe="https://api.crossref.org/works",O="flora_doi:",B="flora-extension@example.com",w=88,f="[FLoRA:augment]";function S(o){return o.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function N(o){return o.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function I(o,e){let r=o.length>=e.length?o:e;if(r.length===0)return 1;let a=[];for(let s=0;s<=o.length;s++){let i=s;for(let t=0;t<=e.length;t++)if(s===0)a[t]=t;else if(t>0){let n=a[t-1];o.charAt(s-1)!==e.charAt(t-1)&&(n=Math.min(Math.min(n,i),a[t])+1),a[t-1]=i,i=n}s>0&&(a[e.length]=i)}return(r.length-a[e.length])/r.length}function H(o,e){let r=new Set(S(o).split(/\s+/).filter(Boolean)),a=new Set(S(e).split(/\s+/).filter(Boolean)),s=[...r].filter(b=>a.has(b)),i=[...r].filter(b=>!a.has(b)),t=[...a].filter(b=>!r.has(b)),n=s.sort().join(" "),l=[n,...i.sort()].join(" ").trim(),c=[n,...t.sort()].join(" ").trim(),d=I(n,l),p=I(n,c),m=I(l,c);return Math.max(d,p,m)*100}async function te(o){let e=N(o),r=`${oe}?query.title=${encodeURIComponent(e)}&rows=5&mailto=${encodeURIComponent(B)}`;console.log(`${f} Crossref query for: "${o}"`);let a=await fetch(r);if(!a.ok)return console.warn(`${f} Crossref returned ${a.status}`),null;let i=(await a.json()).message?.items??[];console.log(`${f} Crossref returned ${i.length} candidates`);let t=null;for(let n of i){if(!n.DOI||!n.title?.[0])continue;let l=H(o,n.title[0]);if(console.log(`${f}   Crossref candidate: "${n.title[0]}" \u2192 score=${l.toFixed(1)}, DOI=${n.DOI}`),l>=w&&(!t||l>t.score)){let c=g(n.DOI);c&&(t={doi:c,title:n.title[0],score:l,source:"crossref"})}}return console.log(t?`${f} Crossref best match: "${t.title}" (score=${t.score.toFixed(1)}, DOI=${t.doi})`:`${f} Crossref: no match above threshold (${w})`),t}async function ne(o){let e=N(o),r=`${ee}?filter=title.search:${encodeURIComponent(e)}&select=id,doi,title&per_page=5&mailto=${encodeURIComponent(B)}`;console.log(`${f} OpenAlex query for: "${o}"`);let a=await fetch(r);if(!a.ok)return console.warn(`${f} OpenAlex returned ${a.status}`),null;let i=(await a.json()).results??[];console.log(`${f} OpenAlex returned ${i.length} candidates`);let t=null;for(let n of i){if(!n.doi||!n.title)continue;let l=H(o,n.title);if(console.log(`${f}   OpenAlex candidate: "${n.title}" \u2192 score=${l.toFixed(1)}, DOI=${n.doi}`),l>=w&&(!t||l>t.score)){let c=g(n.doi);c&&(t={doi:c,title:n.title,score:l,source:"openalex"})}}return console.log(t?`${f} OpenAlex best match: "${t.title}" (score=${t.score.toFixed(1)}, DOI=${t.doi})`:`${f} OpenAlex: no match above threshold (${w})`),t}async function z(o){let e=new Map;if(o.length===0)return e;console.log(`${f} Augmenting ${o.length} title(s):`,o);let r=[],a=o.map(i=>O+S(i));try{let i=await chrome.storage.local.get(a);for(let t of o){let n=O+S(t),l=i[n];if(l){let c=l.found&&l.doi?g(l.doi):null;e.set(t,c),console.log(`${f} Cache hit for "${t}": ${c??"not found"}`)}else r.push(t)}}catch{r.push(...o)}if(r.length===0)return e;console.log(`${f} ${r.length} title(s) uncached, querying Crossref + OpenAlex`);let s=r.map(async i=>{let[t,n]=await Promise.allSettled([te(i),ne(i)]),l=[];t.status==="fulfilled"&&t.value?l.push(t.value):t.status==="rejected"&&console.warn(`${f} Crossref query failed:`,t.reason),n.status==="fulfilled"&&n.value?l.push(n.value):n.status==="rejected"&&console.warn(`${f} OpenAlex query failed:`,n.reason);let c=new Map;for(let $ of l){let k=c.get($.doi);(!k||$.score>k.score)&&c.set($.doi,$)}let d=null;for(let $ of c.values())(!d||$.score>d.score)&&(d=$);let p=d?.doi??null;e.set(i,p),console.log(d?`${f} Resolved "${i}" \u2192 ${d.doi} (via ${d.source}, score=${d.score.toFixed(1)})`:`${f} No DOI found for "${i}"`);let m=O+S(i),b={found:p!==null,doi:p};chrome.storage.local.set({[m]:b}).catch(()=>{})});await Promise.allSettled(s);for(let i of r)e.has(i)||e.set(i,null);return e}function L(o,e){let r=null;return(...a)=>{r!==null&&clearTimeout(r),r=setTimeout(()=>{r=null,o(...a)},e)}}var E=`/* === Banner === */
.flora-banner {
  all: initial;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.flora-banner-inner {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  font-size: 14px;
  line-height: 1.4;
  box-sizing: border-box;
  color: #fff;
}

.flora-banner--loading {
  background: #6b7280;
}
.flora-banner--success {
  background: #16a34a;
}
.flora-banner--warning {
  background: #ea580c;
}
.flora-banner--error {
  background: #dc2626;
}

.flora-logo {
  font-weight: 700;
  font-size: 15px;
  color: #fff;
  background: rgba(255, 255, 255, 0.15);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.flora-banner-text {
  flex: 1;
}

.flora-banner-link {
  color: #fff;
  text-decoration: underline;
  text-underline-offset: 2px;
  white-space: nowrap;
}

.flora-banner-close {
  all: unset;
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  padding: 0 4px;
  color: rgba(255, 255, 255, 0.8);
}

.flora-banner-close:hover {
  color: #fff;
}

/* === Inline badges === */
.flora-badge {
  all: initial;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 12px;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  text-decoration: none;
  cursor: pointer;
  vertical-align: middle;
  color: #fff;
  z-index: 9999;
}

.badge--success {
  background: #16a34a;
}
.badge--warning {
  background: #ea580c;
}

.badge-icon {
  font-weight: 800;
  font-size: 11px;
}

.flora-badge:hover {
  filter: brightness(1.15);
}

@media print {
  .flora-banner,
  .flora-badge {
    display: none !important;
  }
}
`;var C="flora-banner-host",P="flora-inline-badge",y=null;function q(o){j();let e=y,r=e.querySelector(".flora-banner");r.innerHTML=`
    <div class="flora-banner-inner flora-banner--error">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">Error: ${ce(o)}</span>
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,e.querySelector(".flora-banner-close")?.addEventListener("click",()=>D())}function U(o){if(o.length===0){D();return}j();let e=y,r=e.querySelector(".flora-banner"),a=o.reduce((d,p)=>d+p.result.record.stats.n_replications_total,0),s=o.reduce((d,p)=>d+p.result.record.stats.n_reproductions_total,0),i=a>0?"flora-banner--success":"flora-banner--info",t=o.length,n=t===1?`${a} replication(s), ${s} reproduction(s)`:`Replication/reproduction data found for ${t} DOIs (${a} replication(s), ${s} reproduction(s))`,l=o.map(d=>d.doi).join(","),c=`<a class="flora-banner-link" href="https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(l)}" target="_blank" rel="noopener">View details</a>`;r.innerHTML=`
    <div class="flora-banner-inner ${i}">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">${n}</span>
      ${c}
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,e.querySelector(".flora-banner-close")?.addEventListener("click",()=>D())}function j(){let o=document.getElementById(C);if(!o){o=document.createElement("div"),o.id=C,y=o.attachShadow({mode:"open"});let e=document.createElement("style");e.textContent=E,y.appendChild(e);let r=document.createElement("div");r.className="flora-banner",y.appendChild(r),document.body.prepend(o),ie()}}function D(){let o=document.getElementById(C);o&&(o.remove(),y=null,ae())}var se=40;function ie(){document.body.style.setProperty("margin-top",`${se}px`,"important")}function ae(){document.body.style.removeProperty("margin-top")}function V(o){let e=document.querySelectorAll("a[href]");for(let r of e){if(r.nextElementSibling?.classList.contains(P))continue;let a=r.href.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(!a)continue;let s=g(a[1]);if(!s)continue;let i=o.get(s);if(!i||i.status!=="matched"||!le(r))continue;let t=i.result,n=t.record.stats,l=n.n_replications_total>0?"badge--success":"badge--neutral",c=document.createElement("span");c.className=P;let d=c.attachShadow({mode:"open"}),p=document.createElement("style");p.textContent=E,d.appendChild(p);let m=document.createElement("a");m.className=`flora-badge ${l}`,m.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(t.doi)}`,m.target="_blank",m.rel="noopener",m.title=`FLoRA: ${n.n_replications_total} replication(s), ${n.n_reproductions_total} reproduction(s)`,m.innerHTML=`<span class="badge-icon">F</span> ${n.n_replications_total}R`,d.appendChild(m),r.insertAdjacentElement("afterend",c)}}function le(o){let e=window.getComputedStyle(o);return e.display!=="none"&&e.visibility!=="hidden"}function ce(o){return o.replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]??e)}var u="[FLoRA]";function de(o){if(o.length===0)return;let e=o.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")),r=new RegExp(`(${e.join("|")})`,"gi"),a=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),s=[],i;for(;i=a.nextNode();){if(!i.nodeValue||!r.test(i.nodeValue))continue;r.lastIndex=0;let t=i.parentElement;if(!t||t.tagName==="SCRIPT"||t.tagName==="STYLE")continue;let n=i.nodeValue.replace(r,'<span style="background:#ffeb3b;outline:2px solid #f57f17;border-radius:2px;padding:0 2px" title="FLoRA DOI">$1</span>');s.push({node:i,html:n})}for(let{node:t,html:n}of s){let l=document.createElement("span");l.innerHTML=n,t.parentNode?.replaceChild(l,t)}console.log(`${u} DEBUG: Highlighted ${s.length} text occurrence(s) of ${o.length} DOI(s)`)}var h=new Map,R=new Set,v=location.href;async function X(){console.log(`${u} Running on ${location.href}`);let o=location.href;o!==v&&(console.log(`${u} URL changed: ${v} \u2192 ${o}`),v=o,R.clear(),h.clear(),D());let e=M(document);if(e.length===0){let s=document.querySelector("h1")?.textContent?.trim()||document.title?.trim();if(s){console.log(`${u} No DOIs extracted, augmenting from title: "${s}"`);try{let t=(await z([s])).get(s);t?(console.log(`${u} Title augmented to DOI: ${t}`),e=[t]):console.log(`${u} Title augmentation found no DOI`)}catch(i){console.warn(`${u} Augmentation failed:`,i)}}else console.log(`${u} No DOIs found and no page title available`)}let r=e.filter(s=>!R.has(s));if(r.length===0){console.log(`${u} No new DOIs to process (${R.size} already processed)`);return}console.log(`${u} Processing ${r.length} new DOI(s):`,r),de(r);for(let s of r)R.add(s);for(let s of r)h.set(s,{status:"loading"});let a={type:"FLORA_LOOKUP",dois:r};try{let s=await chrome.runtime.sendMessage(a);for(let n of r)s.errors[n]?(h.set(n,{status:"error",message:s.errors[n]}),console.warn(`${u} Lookup error for ${n}: ${s.errors[n]}`)):s.results[n]?(h.set(n,{status:"matched",result:s.results[n]}),console.log(`${u} MATCH: ${n} has replication data`)):(h.set(n,{status:"no-match"}),console.log(`${u} No replication data for ${n}`));let t=[...h.keys()].filter(n=>h.get(n)?.status==="matched").map(n=>({doi:n,result:h.get(n).result}));t.length>0?(console.log(`${u} Rendering banner for ${t.length} matched DOI(s)`),U(t)):D(),V(h)}catch(s){console.error(`${u} FLoRA lookup failed:`,s),q("Failed to contact FLoRA service")}}var fe=L(X,1e3);fe();var ue=3,A=L(X,2e3);document.body&&new MutationObserver(e=>{let r=0;for(let a of e)for(let s of a.addedNodes)s.nodeType===Node.ELEMENT_NODE&&r++;r>=ue&&(console.log(`${u} DOM mutation detected (${r} elements added), re-running`),A())}).observe(document.body,{childList:!0,subtree:!0});window.addEventListener("popstate",()=>{console.log(`${u} popstate event, re-running`),A()});window.addEventListener("hashchange",()=>{console.log(`${u} hashchange event, re-running`),A()});})();
