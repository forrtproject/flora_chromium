"use strict";(()=>{var Z=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function g(o){let e=o.trim();for(let t of Z)if(e.toLowerCase().startsWith(t)){e=e.slice(t.length);break}return/^10\.\d{4,}/.test(e)?e.toLowerCase():null}var P=/(10\.\d{4,}(?:\.\d+)*\/[^\s,;\]}>'"<#?&]+)/g,S="[FLoRA:extractor]",ee=/[\u200B\u200C\u200D\u00AD\uFEFF\u2060]/g;function q(o){let e=o.indexOf("/");return e===-1?!1:o.slice(e+1).length>=2}function H(o){let e=o.replace(/[.,;:]+$/,""),t=0,i=e.length;for(let s=0;s<e.length;s++)if(e[s]==="(")t++;else if(e[s]===")")if(t>0)t--;else{i=s;break}return e=e.slice(0,i),e=e.replace(/[.,;:]+$/,""),e}function N(o){let e=new Set,t=e.size;oe(o,e),e.size>t&&console.log(`${S} URL layer found ${e.size-t} DOI(s):`,[...e]);let i=e.size;te(o,e),e.size>i&&console.log(`${S} Meta tag layer found ${e.size-i} new DOI(s)`);let s=e.size;ne(o,e),e.size>s&&console.log(`${S} JSON-LD layer found ${e.size-s} new DOI(s)`);let a=e.size;re(o,e),e.size>a&&console.log(`${S} DOI link layer found ${e.size-a} new DOI(s)`);let r=e.size;se(o,e),e.size>r&&console.log(`${S} Visible text layer found ${e.size-r} new DOI(s)`);let n=[...e];return n.length>0?console.log(`${S} Total DOIs extracted: ${n.length}`,n):console.log(`${S} No DOIs found on page`),n}function oe(o,e){let i=(o.location?.href??"").matchAll(P);for(let s of i){let a=H(s[1]);if(!q(a))continue;let r=g(a);r&&e.add(r)}}function te(o,e){let t=['meta[name="citation_doi"]','meta[name="DC.identifier"]','meta[name="dc.identifier"]','meta[name="DOI"]','meta[property="citation_doi"]'];for(let i of t){let s=o.querySelector(i);if(s?.content){let a=g(s.content);a&&e.add(a)}}}function ne(o,e){let t=o.querySelectorAll('script[type="application/ld+json"]');for(let i of t)try{let s=JSON.parse(i.textContent??""),a=Array.isArray(s)?s:[s];for(let r of a){if(typeof r?.["@id"]=="string"){let n=g(r["@id"]);n&&e.add(n)}if(typeof r?.doi=="string"){let n=g(r.doi);n&&e.add(n)}}}catch{}}function re(o,e){let t=o.querySelectorAll("a[href]");for(let i of t){let s=i.href;if(!s)continue;try{let n=new URL(s).hostname.toLowerCase();if(n!=="doi.org"&&n!=="dx.doi.org")continue}catch{continue}let a=g(s);a&&e.add(a)}}function se(o,e){let s=(o.body?.innerText||o.body?.textContent||"").replace(ee,"").matchAll(P);for(let a of s){let r=H(a[1]);if(!q(r))continue;let n=g(r);n&&e.add(n)}}var ie="https://api.openalex.org/works",ae="https://api.crossref.org/works",k="flora_doi:",U="flora-extension@example.com",I=88,f="[FLoRA:augment]";function R(o){return o.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function j(o){return o.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function C(o,e){let t=o.length>=e.length?o:e;if(t.length===0)return 1;let i=[];for(let s=0;s<=o.length;s++){let a=s;for(let r=0;r<=e.length;r++)if(s===0)i[r]=r;else if(r>0){let n=i[r-1];o.charAt(s-1)!==e.charAt(r-1)&&(n=Math.min(Math.min(n,a),i[r])+1),i[r-1]=a,a=n}s>0&&(i[e.length]=a)}return(t.length-i[e.length])/t.length}function V(o,e){let t=new Set(R(o).split(/\s+/).filter(Boolean)),i=new Set(R(e).split(/\s+/).filter(Boolean)),s=[...t].filter(m=>i.has(m)),a=[...t].filter(m=>!i.has(m)),r=[...i].filter(m=>!t.has(m)),n=s.sort().join(" "),c=[n,...a.sort()].join(" ").trim(),d=[n,...r.sort()].join(" ").trim(),l=C(n,c),b=C(n,d),D=C(c,d);return Math.max(l,b,D)*100}async function le(o){let e=j(o),t=`${ae}?query.title=${encodeURIComponent(e)}&rows=5&mailto=${encodeURIComponent(U)}`;console.log(`${f} Crossref query for: "${o}"`);let i=await fetch(t);if(!i.ok)return console.warn(`${f} Crossref returned ${i.status}`),null;let a=(await i.json()).message?.items??[];console.log(`${f} Crossref returned ${a.length} candidates`);let r=null;for(let n of a){if(!n.DOI||!n.title?.[0])continue;let c=V(o,n.title[0]);if(console.log(`${f}   Crossref candidate: "${n.title[0]}" \u2192 score=${c.toFixed(1)}, DOI=${n.DOI}`),c>=I&&(!r||c>r.score)){let d=g(n.DOI);d&&(r={doi:d,title:n.title[0],score:c,source:"crossref"})}}return console.log(r?`${f} Crossref best match: "${r.title}" (score=${r.score.toFixed(1)}, DOI=${r.doi})`:`${f} Crossref: no match above threshold (${I})`),r}async function ce(o){let e=j(o),t=`${ie}?filter=title.search:${encodeURIComponent(e)}&select=id,doi,title&per_page=5&mailto=${encodeURIComponent(U)}`;console.log(`${f} OpenAlex query for: "${o}"`);let i=await fetch(t);if(!i.ok)return console.warn(`${f} OpenAlex returned ${i.status}`),null;let a=(await i.json()).results??[];console.log(`${f} OpenAlex returned ${a.length} candidates`);let r=null;for(let n of a){if(!n.doi||!n.title)continue;let c=V(o,n.title);if(console.log(`${f}   OpenAlex candidate: "${n.title}" \u2192 score=${c.toFixed(1)}, DOI=${n.doi}`),c>=I&&(!r||c>r.score)){let d=g(n.doi);d&&(r={doi:d,title:n.title,score:c,source:"openalex"})}}return console.log(r?`${f} OpenAlex best match: "${r.title}" (score=${r.score.toFixed(1)}, DOI=${r.doi})`:`${f} OpenAlex: no match above threshold (${I})`),r}async function X(o){let e=new Map;if(o.length===0)return e;console.log(`${f} Augmenting ${o.length} title(s):`,o);let t=[],i=o.map(a=>k+R(a));try{let a=await chrome.storage.local.get(i);for(let r of o){let n=k+R(r),c=a[n];if(c){let d=c.found&&c.doi?g(c.doi):null;e.set(r,d),console.log(`${f} Cache hit for "${r}": ${d??"not found"}`)}else t.push(r)}}catch{t.push(...o)}if(t.length===0)return e;console.log(`${f} ${t.length} title(s) uncached, querying Crossref + OpenAlex`);let s=t.map(async a=>{let[r,n]=await Promise.allSettled([le(a),ce(a)]),c=[];r.status==="fulfilled"&&r.value?c.push(r.value):r.status==="rejected"&&console.warn(`${f} Crossref query failed:`,r.reason),n.status==="fulfilled"&&n.value?c.push(n.value):n.status==="rejected"&&console.warn(`${f} OpenAlex query failed:`,n.reason);let d=new Map;for(let h of c){let O=d.get(h.doi);(!O||h.score>O.score)&&d.set(h.doi,h)}let l=null;for(let h of d.values())(!l||h.score>l.score)&&(l=h);let b=l?.doi??null;e.set(a,b),console.log(l?`${f} Resolved "${a}" \u2192 ${l.doi} (via ${l.source}, score=${l.score.toFixed(1)})`:`${f} No DOI found for "${a}"`);let D=k+R(a),m={found:b!==null,doi:b};chrome.storage.local.set({[D]:m}).catch(()=>{})});await Promise.allSettled(s);for(let a of t)e.has(a)||e.set(a,null);return e}function v(o,e){let t=null;return(...i)=>{t!==null&&clearTimeout(t),t=setTimeout(()=>{t=null,o(...i)},e)}}var E=`/* === Banner === */
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
`;var A="flora-banner-host",G="flora-inline-badge",_=null;function K(o){W();let e=_,t=e.querySelector(".flora-banner");t.innerHTML=`
    <div class="flora-banner-inner flora-banner--error">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">Error: ${me(o)}</span>
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,e.querySelector(".flora-banner-close")?.addEventListener("click",()=>w())}function J(o){if(o.length===0){w();return}let e=o.reduce((p,$)=>p+$.result.record.stats.n_replications_total,0),t=o.reduce((p,$)=>p+$.result.record.stats.n_reproductions_total,0),i=o.reduce((p,$)=>p+$.result.record.stats.n_originals_total,0);if(e===0&&t===0&&i===0){w();return}W();let s=_,a=s.querySelector(".flora-banner"),r=e>0||t>0?"flora-banner--success":"flora-banner--info",n=e===1?"replication":"replications",c=t===1?"reproduction":"reproductions",d=i===1?"original":"originals",l=[];e>0&&l.push(`${e} ${n}`),t>0&&l.push(`${t} ${c}`),i>0&&l.push(`${i} ${d}`);let b=l.join(", "),D=o.length,m=D===1?b:`Replication/reproduction data found for ${D} DOIs (${b})`,h=o.map(p=>p.doi).join(","),O=`<a class="flora-banner-link" href="https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(h)}" target="_blank" rel="noopener">View details</a>`;a.innerHTML=`
    <div class="flora-banner-inner ${r}">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">${m}</span>
      ${O}
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,s.querySelector(".flora-banner-close")?.addEventListener("click",()=>w())}function W(){let o=document.getElementById(A);if(!o){o=document.createElement("div"),o.id=A,_=o.attachShadow({mode:"open"});let e=document.createElement("style");e.textContent=E,_.appendChild(e);let t=document.createElement("div");t.className="flora-banner",_.appendChild(t),document.body.prepend(o),fe()}}function w(){let o=document.getElementById(A);o&&(o.remove(),_=null,ge())}var ue=40;function fe(){document.body.style.setProperty("margin-top",`${ue}px`,"important")}function ge(){document.body.style.removeProperty("margin-top")}function Q(o){let e=document.querySelectorAll("a[href]");for(let t of e){if(t.nextElementSibling?.classList.contains(G))continue;let i=t.textContent?.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/),a=/^https?:\/\/(dx\.)?doi\.org\//i.test(t.href)?t.href.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/):null,r=i?.[1]??a?.[1];if(!r)continue;let n=g(r);if(!n)continue;let c=o.get(n);if(!c||c.status!=="matched"||!pe(t))continue;let d=c.result,l=d.record.stats;if(!(l.n_replications_total>0||l.n_reproductions_total>0||l.n_originals_total>0))continue;let D=l.n_replications_total>0||l.n_reproductions_total>0?"badge--success":"badge--neutral",m=l.n_replications_total===1?"replication":"replications",h=l.n_reproductions_total===1?"reproduction":"reproductions",O=l.n_originals_total===1?"original":"originals",p=[];l.n_replications_total>0&&p.push(`${l.n_replications_total} ${m}`),l.n_reproductions_total>0&&p.push(`${l.n_reproductions_total} ${h}`),l.n_originals_total>0&&p.push(`${l.n_originals_total} ${O}`);let $=document.createElement("span");$.className=G;let B=$.attachShadow({mode:"open"}),z=document.createElement("style");z.textContent=E,B.appendChild(z);let y=document.createElement("a");y.className=`flora-badge ${D}`,y.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(d.doi)}`,y.target="_blank",y.rel="noopener",y.title=`FLoRA: ${p.join(", ")}`,y.innerHTML=`<span class="badge-icon">F</span> ${l.n_replications_total}R`,B.appendChild(y),t.insertAdjacentElement("afterend",$)}}function pe(o){let e=window.getComputedStyle(o);return e.display!=="none"&&e.visibility!=="hidden"}function me(o){return o.replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]??e)}var u="[FLoRA]",x=new Map,L=new Set,T=location.href,F=!1;async function he(){if(F)return;F=!0;let o=document.querySelector("h1")?.textContent?.trim()||document.title?.trim();if(!o){console.log(`${u} No page title available for augmentation`);return}console.log(`${u} No DOIs extracted, augmenting from title in background: "${o}"`);try{let t=(await X([o])).get(o);if(t){console.log(`${u} Title augmented to DOI: ${t} (background, no UI)`),L.add(t);let i={type:"FLORA_LOOKUP",dois:[t]};(await chrome.runtime.sendMessage(i)).results[t]?console.log(`${u} Background augmented DOI ${t} has replication data`):console.log(`${u} Background augmented DOI ${t} has no replication data`)}else console.log(`${u} Title augmentation found no DOI`)}catch(e){console.warn(`${u} Background augmentation failed:`,e)}}async function Y(){console.log(`${u} Running on ${location.href}`);let o=location.href;o!==T&&(console.log(`${u} URL changed: ${T} \u2192 ${o}`),T=o,L.clear(),x.clear(),F=!1,w());let e=N(document),t=e.filter(s=>!L.has(s));if(t.length===0&&e.length===0){he(),L.size>0&&console.log(`${u} No new DOIs to process (${L.size} already processed)`);return}if(t.length===0){console.log(`${u} No new DOIs to process (${L.size} already processed)`);return}console.log(`${u} Processing ${t.length} new DOI(s):`,t);for(let s of t)L.add(s);for(let s of t)x.set(s,{status:"loading"});let i={type:"FLORA_LOOKUP",dois:t};try{let s=await chrome.runtime.sendMessage(i);for(let n of t)s.errors[n]?(x.set(n,{status:"error",message:s.errors[n]}),console.warn(`${u} Lookup error for ${n}: ${s.errors[n]}`)):s.results[n]?(x.set(n,{status:"matched",result:s.results[n]}),console.log(`${u} MATCH: ${n} has replication data`)):(x.set(n,{status:"no-match"}),console.log(`${u} No replication data for ${n}`));let r=[...x.keys()].filter(n=>x.get(n)?.status==="matched").map(n=>({doi:n,result:x.get(n).result}));r.length>0?(console.log(`${u} Rendering banner for ${r.length} matched DOI(s)`),J(r)):w(),Q(x)}catch(s){console.error(`${u} FLoRA lookup failed:`,s),K("Failed to contact FLoRA service")}}var be=v(Y,1e3);be();var $e=3,M=v(Y,2e3);document.body&&new MutationObserver(e=>{let t=0;for(let i of e)for(let s of i.addedNodes)s.nodeType===Node.ELEMENT_NODE&&t++;t>=$e&&(console.log(`${u} DOM mutation detected (${t} elements added), re-running`),M())}).observe(document.body,{childList:!0,subtree:!0});window.addEventListener("popstate",()=>{console.log(`${u} popstate event, re-running`),M()});window.addEventListener("hashchange",()=>{console.log(`${u} hashchange event, re-running`),M()});})();
