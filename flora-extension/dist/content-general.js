"use strict";(()=>{var B=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function p(e){let t=e.trim();for(let n of B)if(t.toLowerCase().startsWith(n)){t=t.slice(n.length);break}return/^10\.\d{4,}/.test(t)?t.toLowerCase():null}var R=/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/g;function w(e){let t=new Set;return H(e,t),O(e,t),$(e,t),[...t]}function H(e,t){let n=['meta[name="citation_doi"]','meta[name="DC.identifier"]','meta[name="dc.identifier"]','meta[name="DOI"]','meta[property="citation_doi"]'];for(let i of n){let s=e.querySelector(i);if(s?.content){let o=p(s.content);o&&t.add(o)}}}function O(e,t){let n=e.querySelectorAll('script[type="application/ld+json"]');for(let i of n)try{let s=JSON.parse(i.textContent??""),o=Array.isArray(s)?s:[s];for(let r of o){if(typeof r?.["@id"]=="string"){let a=p(r["@id"]);a&&t.add(a)}if(typeof r?.doi=="string"){let a=p(r.doi);a&&t.add(a)}}}catch{}}function $(e,t){let n=e.querySelectorAll("a[href]");for(let o of n){let r=o.href.matchAll(R);for(let a of r){let c=p(a[1]);c&&t.add(c)}}let s=(e.body?.innerText||e.body?.textContent||"").matchAll(R);for(let o of s){let r=p(o[1]);r&&t.add(r)}}var F="https://api.openalex.org/works",S="flora_doi:",q="flora-extension@example.com",P=.8;function b(e){return e.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()}function N(e){return e.replace(/[:()\[\]&|\\,;'"]/g," ").replace(/\s+/g," ").trim()}function z(e,t){let n=e.length>=t.length?e:t,i=e.length>=t.length?t:e;if(n.length===0)return 1;let s=[];for(let o=0;o<=e.length;o++){let r=o;for(let a=0;a<=t.length;a++)if(o===0)s[a]=a;else if(a>0){let c=s[a-1];e.charAt(o-1)!==t.charAt(a-1)&&(c=Math.min(Math.min(c,r),s[a])+1),s[a-1]=r,r=c}o>0&&(s[t.length]=r)}return(n.length-s[t.length])/n.length}async function k(e){let t=new Map;if(e.length===0)return t;let n=[],i=e.map(r=>S+b(r));try{let r=await chrome.storage.local.get(i);for(let a of e){let c=S+b(a),l=r[c];l?t.set(a,l.found&&l.doi?p(l.doi):null):n.push(a)}}catch{n.push(...e)}if(n.length===0)return t;let s=n.map(r=>encodeURIComponent(N(r))).join("|"),o=`${F}?filter=title.search:${s}&select=id,doi,title&per_page=50&mailto=${encodeURIComponent(q)}`;try{let r=await fetch(o);if(!r.ok){for(let l of n)t.set(l,null);return t}let a=await r.json(),c=new Set;for(let l of a.results??[]){if(!l.doi||!l.title)continue;let f=b(l.title),d=null,u=0;for(let g of n){if(c.has(g))continue;let y=z(f,b(g));y>u&&y>P&&(u=y,d=g)}if(d){c.add(d);let g=p(l.doi);t.set(d,g);let y=S+b(d),M={found:g!==null,doi:g};chrome.storage.local.set({[y]:M}).catch(()=>{})}}for(let l of n)if(!t.has(l)){t.set(l,null);let f=S+b(l),d={found:!1,doi:null};chrome.storage.local.set({[f]:d}).catch(()=>{})}}catch{for(let r of n)t.has(r)||t.set(r,null)}return t}function v(e,t){let n=null;return(...i)=>{n!==null&&clearTimeout(n),n=setTimeout(()=>{n=null,e(...i)},t)}}var D=`/* === Banner === */
.flora-banner {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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

.flora-banner--loading { background: #6b7280; }
.flora-banner--success { background: #16a34a; }
.flora-banner--warning { background: #ea580c; }
.flora-banner--error   { background: #dc2626; }

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
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  text-decoration: none;
  cursor: pointer;
  vertical-align: middle;
  color: #fff;
}

.badge--success { background: #16a34a; }
.badge--warning { background: #ea580c; }

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
`;var E="flora-banner-host",_="flora-inline-badge",m=null;function T(){L();let t=m.querySelector(".flora-banner");t.innerHTML=`
    <div class="flora-banner-inner flora-banner--loading">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">Checking replication data\u2026</span>
    </div>`}function A(e){L();let t=m,n=t.querySelector(".flora-banner");n.innerHTML=`
    <div class="flora-banner-inner flora-banner--error">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">Error: ${G(e)}</span>
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,t.querySelector(".flora-banner-close")?.addEventListener("click",()=>x())}function C(e){if(e.length===0){x();return}L();let t=m,n=t.querySelector(".flora-banner"),i=e.reduce((f,d)=>f+d.result.record.stats.n_replications_total,0),s=e.reduce((f,d)=>f+d.result.record.stats.n_reproductions_total,0),o=i>0?"flora-banner--success":"flora-banner--info",r=e.length,a=r===1?`${i} replication(s), ${s} reproduction(s)`:`Replication/reproduction data found for ${r} DOIs (${i} replication(s), ${s} reproduction(s))`,c=e.map(f=>f.doi).join(","),l=`<a class="flora-banner-link" href="https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(c)}" target="_blank" rel="noopener">View details</a>`;n.innerHTML=`
    <div class="flora-banner-inner ${o}">
      <span class="flora-logo">FLoRA</span>
      <span class="flora-banner-text">${a}</span>
      ${l}
      <button class="flora-banner-close" aria-label="Close">\xD7</button>
    </div>`,t.querySelector(".flora-banner-close")?.addEventListener("click",()=>x())}function L(){let e=document.getElementById(E);if(!e){e=document.createElement("div"),e.id=E,m=e.attachShadow({mode:"open"});let t=document.createElement("style");t.textContent=D,m.appendChild(t);let n=document.createElement("div");n.className="flora-banner",m.appendChild(n),document.body.prepend(e),K()}}function x(){let e=document.getElementById(E);e&&(e.remove(),m=null,V())}var j=40;function K(){document.body.style.setProperty("margin-top",`${j}px`,"important")}function V(){document.body.style.removeProperty("margin-top")}function I(e){let t=document.querySelectorAll("a[href]");for(let n of t){if(n.nextElementSibling?.classList.contains(_))continue;let i=n.href.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(!i)continue;let s=p(i[1]);if(!s)continue;let o=e.get(s);if(!o||o.status!=="matched"||!X(n))continue;let r=o.result,a=r.record.stats,c=a.n_replications_total>0?"badge--success":"badge--neutral",l=document.createElement("span");l.className=_;let f=l.attachShadow({mode:"open"}),d=document.createElement("style");d.textContent=D,f.appendChild(d);let u=document.createElement("a");u.className=`flora-badge ${c}`,u.href=`https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(r.doi)}`,u.target="_blank",u.rel="noopener",u.title=`FLoRA: ${a.n_replications_total} replication(s), ${a.n_reproductions_total} reproduction(s)`,u.innerHTML=`<span class="badge-icon">F</span> ${a.n_replications_total}R`,f.appendChild(u),n.insertAdjacentElement("afterend",l)}}function X(e){let t=window.getComputedStyle(e);return t.display!=="none"&&t.visibility!=="hidden"}function G(e){return e.replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t]??t)}var h=new Map;async function J(){let e=w(document);if(e.length===0){let i=document.querySelector("h1")?.textContent?.trim()||document.title?.trim();if(i)try{let o=(await k([i])).get(i);o&&(e=[o])}catch{}}if(e.length===0)return;let t=e[0];for(let i of e)h.set(i,{status:"loading"});T();let n={type:"FLORA_LOOKUP",dois:e};try{let i=await chrome.runtime.sendMessage(n);for(let o of e)i.errors[o]?h.set(o,{status:"error",message:i.errors[o]}):i.results[o]?h.set(o,{status:"matched",result:i.results[o]}):h.set(o,{status:"no-match"});let s=e.filter(o=>h.get(o)?.status==="matched").map(o=>({doi:o,result:h.get(o).result}));s.length>0?C(s):x(),I(h)}catch{A("Failed to contact FLoRA service")}}var W=v(J,300);W();})();
