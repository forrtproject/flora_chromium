"use strict";(()=>{var W=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function h(o){let e=o.trim();for(let n of W)if(e.toLowerCase().startsWith(n)){e=e.slice(n.length);break}return/^10\.\d{4,}/.test(e)?e.toLowerCase():null}var M=/(10\.\d{4,}(?:\.\d+)*\/[^\s,;\]}>'"<#?&]+)/g,S="[FLoRA:extractor]",Q=/[\u200B\u200C\u200D\u00AD\uFEFF\u2060]/g;function B(o){let e=o.indexOf("/");return e===-1?!1:o.slice(e+1).length>=2}function z(o){let e=o.replace(/[.,;:]+$/,""),n=0,i=e.length;for(let s=0;s<e.length;s++)if(e[s]==="(")n++;else if(e[s]===")")if(n>0)n--;else{i=s;break}return e=e.slice(0,i),e=e.replace(/[.,;:]+$/,""),e}function P(o){let e=new Set,n=e.size;Y(o,e),e.size>n&&console.log(`${S} URL layer found ${e.size-n} DOI(s):`,[...e]);let i=e.size;Z(o,e),e.size>i&&console.log(`${S} Meta tag layer found ${e.size-i} new DOI(s)`);let s=e.size;ee(o,e),e.size>s&&console.log(`${S} JSON-LD layer found ${e.size-s} new DOI(s)`);let a=e.size;oe(o,e),e.size>a&&console.log(`${S} DOI link layer found ${e.size-a} new DOI(s)`);let r=e.size;te(o,e),e.size>r&&console.log(`${S} Visible text layer found ${e.size-r} new DOI(s)`);let t=[...e];return t.length>0?console.log(`${S} Total DOIs extracted: ${t.length}`,t):console.log(`${S} No DOIs found on page`),t}function Y(o,e){let i=(o.location?.href??"").matchAll(M);for(let s of i){let a=z(s[1]);if(!B(a))continue;let r=h(a);r&&e.add(r)}}function Z(o,e){let n=['meta[name="citation_doi"]','meta[name="DC.identifier"]','meta[name="dc.identifier"]','meta[name="DOI"]','meta[property="citation_doi"]'];for(let i of n){let s=o.querySelector(i);if(s?.content){let a=h(s.content);a&&e.add(a)}}}function ee(o,e){let n=o.querySelectorAll('script[type="application/ld+json"]');for(let i of n)try{let s=JSON.parse(i.textContent??""),a=Array.isArray(s)?s:[s];for(let r of a){if(typeof r?.["@id"]=="string"){let t=h(r["@id"]);t&&e.add(t)}if(typeof r?.doi=="string"){let t=h(r.doi);t&&e.add(t)}}}catch{}}function oe(o,e){let n=o.querySelectorAll("a[href]");for(let i of n){let s=i.href;if(!s)continue;try{let t=new URL(s).hostname.toLowerCase();if(t!=="doi.org"&&t!=="dx.doi.org")continue}catch{continue}let a=h(s);a&&e.add(a)}}function te(o,e){let s=(o.body?.innerText||o.body?.textContent||"").replace(Q,"").matchAll(M);for(let a of s){let r=z(a[1]);if(!B(r))continue;let t=h(r);t&&e.add(t)}}var ne="https://api.openalex.org/works",re="https://api.crossref.org/works",I="flora_doi:",q="flora-extension@example.com",R=88,u="[FLoRA:augment]";function O(o){return o.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function H(o){return o.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function k(o,e){let n=o.length>=e.length?o:e;if(n.length===0)return 1;let i=[];for(let s=0;s<=o.length;s++){let a=s;for(let r=0;r<=e.length;r++)if(s===0)i[r]=r;else if(r>0){let t=i[r-1];o.charAt(s-1)!==e.charAt(r-1)&&(t=Math.min(Math.min(t,a),i[r])+1),i[r-1]=a,a=t}s>0&&(i[e.length]=a)}return(n.length-i[e.length])/n.length}function N(o,e){let n=new Set(O(o).split(/\s+/).filter(Boolean)),i=new Set(O(e).split(/\s+/).filter(Boolean)),s=[...n].filter(g=>i.has(g)),a=[...n].filter(g=>!i.has(g)),r=[...i].filter(g=>!n.has(g)),t=s.sort().join(" "),l=[t,...a.sort()].join(" ").trim(),d=[t,...r.sort()].join(" ").trim(),f=k(t,l),b=k(t,d),y=k(l,d);return Math.max(f,b,y)*100}async function se(o){let e=H(o),n=`${re}?query.title=${encodeURIComponent(e)}&rows=5&mailto=${encodeURIComponent(q)}`;console.log(`${u} Crossref query for: "${o}"`);let i=await fetch(n);if(!i.ok)return console.warn(`${u} Crossref returned ${i.status}`),null;let a=(await i.json()).message?.items??[];console.log(`${u} Crossref returned ${a.length} candidates`);let r=null;for(let t of a){if(!t.DOI||!t.title?.[0])continue;let l=N(o,t.title[0]);if(console.log(`${u}   Crossref candidate: "${t.title[0]}" \u2192 score=${l.toFixed(1)}, DOI=${t.DOI}`),l>=R&&(!r||l>r.score)){let d=h(t.DOI);d&&(r={doi:d,title:t.title[0],score:l,source:"crossref"})}}return console.log(r?`${u} Crossref best match: "${r.title}" (score=${r.score.toFixed(1)}, DOI=${r.doi})`:`${u} Crossref: no match above threshold (${R})`),r}async function ie(o){let e=H(o),n=`${ne}?filter=title.search:${encodeURIComponent(e)}&select=id,doi,title&per_page=5&mailto=${encodeURIComponent(q)}`;console.log(`${u} OpenAlex query for: "${o}"`);let i=await fetch(n);if(!i.ok)return console.warn(`${u} OpenAlex returned ${i.status}`),null;let a=(await i.json()).results??[];console.log(`${u} OpenAlex returned ${a.length} candidates`);let r=null;for(let t of a){if(!t.doi||!t.title)continue;let l=N(o,t.title);if(console.log(`${u}   OpenAlex candidate: "${t.title}" \u2192 score=${l.toFixed(1)}, DOI=${t.doi}`),l>=R&&(!r||l>r.score)){let d=h(t.doi);d&&(r={doi:d,title:t.title,score:l,source:"openalex"})}}return console.log(r?`${u} OpenAlex best match: "${r.title}" (score=${r.score.toFixed(1)}, DOI=${r.doi})`:`${u} OpenAlex: no match above threshold (${R})`),r}async function U(o){let e=new Map;if(o.length===0)return e;console.log(`${u} Augmenting ${o.length} title(s):`,o);let n=[],i=o.map(a=>I+O(a));try{let a=await chrome.storage.local.get(i);for(let r of o){let t=I+O(r),l=a[t];if(l){let d=l.found&&l.doi?h(l.doi):null;e.set(r,d),console.log(`${u} Cache hit for "${r}": ${d??"not found"}`)}else n.push(r)}}catch{n.push(...o)}if(n.length===0)return e;console.log(`${u} ${n.length} title(s) uncached, querying Crossref + OpenAlex`);let s=n.map(async a=>{let[r,t]=await Promise.allSettled([se(a),ie(a)]),l=[];r.status==="fulfilled"&&r.value?l.push(r.value):r.status==="rejected"&&console.warn(`${u} Crossref query failed:`,r.reason),t.status==="fulfilled"&&t.value?l.push(t.value):t.status==="rejected"&&console.warn(`${u} OpenAlex query failed:`,t.reason);let d=new Map;for(let p of l){let D=d.get(p.doi);(!D||p.score>D.score)&&d.set(p.doi,p)}let f=null;for(let p of d.values())(!f||p.score>f.score)&&(f=p);let b=f?.doi??null;e.set(a,b),console.log(f?`${u} Resolved "${a}" \u2192 ${f.doi} (via ${f.source}, score=${f.score.toFixed(1)})`:`${u} No DOI found for "${a}"`);let y=I+O(a),g={found:b!==null,doi:b};chrome.storage.local.set({[y]:g}).catch(()=>{})});await Promise.allSettled(s);for(let a of n)e.has(a)||e.set(a,null);return e}function v(o,e){let n=null;return(...i)=>{n!==null&&clearTimeout(n),n=setTimeout(()=>{n=null,o(...i)},e)}}var C=`/* === Banner === */
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
`;var E="flora-banner-host",j="flora-inline-badge",_=null;function V(o){G();let e=_,n=e.querySelector(".flora-banner");n.innerHTML=`
    <div class="flora-banner-inner flora-banner--error">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">Error: ${fe(o)}</span>
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,e.querySelector(".flora-banner-close")?.addEventListener("click",()=>w())}function X(o){if(o.length===0){w();return}let e=o.reduce(($,m)=>$+m.result.record.stats.n_replications_total,0),n=o.reduce(($,m)=>$+m.result.record.stats.n_reproductions_total,0),i=o.reduce(($,m)=>$+m.result.record.stats.n_originals_total,0);if(e===0&&n===0&&i===0){w();return}G();let s=_,a=s.querySelector(".flora-banner"),r=e>0||n>0?"flora-banner--success":"flora-banner--info",t=e===1?"replication":"replications",l=n===1?"reproduction":"reproductions",d=i===1?"original":"originals",f=[];e>0&&f.push(`${e} ${t}`),n>0&&f.push(`${n} ${l}`),i>0&&f.push(`${i} ${d}`);let b=f.join(", "),y=o.length,g=y===1?b:`Replication/reproduction data found for ${y} DOIs (${b})`,p=o.map($=>$.doi).join(","),D=`<a class="flora-banner-link" href="https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(p)}" target="_blank" rel="noopener">View details</a>`;a.innerHTML=`
    <div class="flora-banner-inner ${r}">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">${g}</span>
      ${D}
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,s.querySelector(".flora-banner-close")?.addEventListener("click",()=>w())}function G(){let o=document.getElementById(E);if(!o){o=document.createElement("div"),o.id=E,_=o.attachShadow({mode:"open"});let e=document.createElement("style");e.textContent=C,_.appendChild(e);let n=document.createElement("div");n.className="flora-banner",_.appendChild(n),document.body.prepend(o),ce()}}function w(){let o=document.getElementById(E);o&&(o.remove(),_=null,de())}var le=40;function ce(){document.body.style.setProperty("margin-top",`${le}px`,"important")}function de(){document.body.style.removeProperty("margin-top")}function K(o){let e=document.querySelectorAll("a[href]");for(let n of e){if(n.nextElementSibling?.classList.contains(j))continue;let i=n.href.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(!i)continue;let s=h(i[1]);if(!s)continue;let a=o.get(s);if(!a||a.status!=="matched"||!ue(n))continue;let r=a.result,t=r.record.stats;if(!(t.n_replications_total>0||t.n_reproductions_total>0||t.n_originals_total>0))continue;let d=t.n_replications_total>0||t.n_reproductions_total>0?"badge--success":"badge--neutral",f=t.n_replications_total===1?"replication":"replications",b=t.n_reproductions_total===1?"reproduction":"reproductions",y=t.n_originals_total===1?"original":"originals",g=[];t.n_replications_total>0&&g.push(`${t.n_replications_total} ${f}`),t.n_reproductions_total>0&&g.push(`${t.n_reproductions_total} ${b}`),t.n_originals_total>0&&g.push(`${t.n_originals_total} ${y}`);let p=document.createElement("span");p.className=j;let D=p.attachShadow({mode:"open"}),$=document.createElement("style");$.textContent=C,D.appendChild($);let m=document.createElement("a");m.className=`flora-badge ${d}`,m.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(r.doi)}`,m.target="_blank",m.rel="noopener",m.title=`FLoRA: ${g.join(", ")}`,m.innerHTML=`<span class="badge-icon">F</span> ${t.n_replications_total}R`,D.appendChild(m),n.insertAdjacentElement("afterend",p)}}function ue(o){let e=window.getComputedStyle(o);return e.display!=="none"&&e.visibility!=="hidden"}function fe(o){return o.replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]??e)}var c="[FLoRA]",x=new Map,L=new Set,A=location.href,T=!1;async function ge(){if(T)return;T=!0;let o=document.querySelector("h1")?.textContent?.trim()||document.title?.trim();if(!o){console.log(`${c} No page title available for augmentation`);return}console.log(`${c} No DOIs extracted, augmenting from title in background: "${o}"`);try{let n=(await U([o])).get(o);if(n){console.log(`${c} Title augmented to DOI: ${n} (background, no UI)`),L.add(n);let i={type:"FLORA_LOOKUP",dois:[n]};(await chrome.runtime.sendMessage(i)).results[n]?console.log(`${c} Background augmented DOI ${n} has replication data`):console.log(`${c} Background augmented DOI ${n} has no replication data`)}else console.log(`${c} Title augmentation found no DOI`)}catch(e){console.warn(`${c} Background augmentation failed:`,e)}}async function J(){console.log(`${c} Running on ${location.href}`);let o=location.href;o!==A&&(console.log(`${c} URL changed: ${A} \u2192 ${o}`),A=o,L.clear(),x.clear(),T=!1,w());let e=P(document),n=e.filter(s=>!L.has(s));if(n.length===0&&e.length===0){ge(),L.size>0&&console.log(`${c} No new DOIs to process (${L.size} already processed)`);return}if(n.length===0){console.log(`${c} No new DOIs to process (${L.size} already processed)`);return}console.log(`${c} Processing ${n.length} new DOI(s):`,n);for(let s of n)L.add(s);for(let s of n)x.set(s,{status:"loading"});let i={type:"FLORA_LOOKUP",dois:n};try{let s=await chrome.runtime.sendMessage(i);for(let t of n)s.errors[t]?(x.set(t,{status:"error",message:s.errors[t]}),console.warn(`${c} Lookup error for ${t}: ${s.errors[t]}`)):s.results[t]?(x.set(t,{status:"matched",result:s.results[t]}),console.log(`${c} MATCH: ${t} has replication data`)):(x.set(t,{status:"no-match"}),console.log(`${c} No replication data for ${t}`));let r=[...x.keys()].filter(t=>x.get(t)?.status==="matched").map(t=>({doi:t,result:x.get(t).result}));r.length>0?(console.log(`${c} Rendering banner for ${r.length} matched DOI(s)`),X(r)):w(),K(x)}catch(s){console.error(`${c} FLoRA lookup failed:`,s),V("Failed to contact FLoRA service")}}var pe=v(J,1e3);pe();var me=3,F=v(J,2e3);document.body&&new MutationObserver(e=>{let n=0;for(let i of e)for(let s of i.addedNodes)s.nodeType===Node.ELEMENT_NODE&&n++;n>=me&&(console.log(`${c} DOM mutation detected (${n} elements added), re-running`),F())}).observe(document.body,{childList:!0,subtree:!0});window.addEventListener("popstate",()=>{console.log(`${c} popstate event, re-running`),F()});window.addEventListener("hashchange",()=>{console.log(`${c} hashchange event, re-running`),F()});})();
