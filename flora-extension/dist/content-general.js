"use strict";(()=>{var E=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function l(t){let e=t.trim();for(let o of E)if(e.toLowerCase().startsWith(o)){e=e.slice(o.length);break}return/^10\.\d{4,}/.test(e)?e.toLowerCase():null}var x=/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/g;function S(t){let e=new Set;return w(t,e),_(t,e),R(t,e),[...e]}function w(t,e){let o=['meta[name="citation_doi"]','meta[name="DC.identifier"]','meta[name="dc.identifier"]','meta[name="DOI"]','meta[property="citation_doi"]'];for(let r of o){let i=t.querySelector(r);if(i?.content){let n=l(i.content);n&&e.add(n)}}}function _(t,e){let o=t.querySelectorAll('script[type="application/ld+json"]');for(let r of o)try{let i=JSON.parse(r.textContent??""),n=Array.isArray(i)?i:[i];for(let a of n){if(typeof a?.["@id"]=="string"){let s=l(a["@id"]);s&&e.add(s)}if(typeof a?.doi=="string"){let s=l(a.doi);s&&e.add(s)}}}catch{}}function R(t,e){let o=t.querySelectorAll("a[href]");for(let n of o){let a=n.href.matchAll(x);for(let s of a){let f=l(s[1]);f&&e.add(f)}}let i=(t.body?.innerText||t.body?.textContent||"").matchAll(x);for(let n of i){let a=l(n[1]);a&&e.add(a)}}function k(t,e){let o=null;return(...r)=>{o!==null&&clearTimeout(o),o=setTimeout(()=>{o=null,t(...r)},e)}}var g=`/* === Banner === */
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
`;var b="flora-banner-host",L="flora-inline-badge",p=null;function m(t,e){let o=document.getElementById(b);if(!o){o=document.createElement("div"),o.id=b,p=o.attachShadow({mode:"open"});let n=document.createElement("style");n.textContent=g,p.appendChild(n);let a=document.createElement("div");a.className="flora-banner",p.appendChild(a),document.body.prepend(o),I()}let r=p??o.shadowRoot,i=r.querySelector(".flora-banner");switch(e.status){case"loading":i.innerHTML=`
        <div class="flora-banner-inner flora-banner--loading">
          <span class="flora-logo">FLoRA</span>
          <span class="flora-banner-text">Checking replication data\u2026</span>
        </div>`;break;case"matched":{let n=e.result,a=n.has_failed_replication?"flora-banner--warning":"flora-banner--success";i.innerHTML=`
        <div class="flora-banner-inner ${a}">
          <span class="flora-logo">FLoRA</span>
          <span class="flora-banner-text">
            ${n.replication_count} replication(s), ${n.reproduction_count} reproduction(s)${n.has_failed_replication?" \u2014 includes failed replications":""}
          </span>
          <a class="flora-banner-link" href="${B(n.flora_url)}" target="_blank" rel="noopener">View on FLoRA</a>
          <button class="flora-banner-close" aria-label="Close">\xD7</button>
        </div>`,r.querySelector(".flora-banner-close")?.addEventListener("click",()=>u());break}case"error":i.innerHTML=`
        <div class="flora-banner-inner flora-banner--error">
          <span class="flora-logo">FLoRA</span>
          <span class="flora-banner-text">Error: ${D(e.message)}</span>
          <button class="flora-banner-close" aria-label="Close">\xD7</button>
        </div>`,r.querySelector(".flora-banner-close")?.addEventListener("click",()=>u());break;case"no-match":case"idle":u();break}}function u(){let t=document.getElementById(b);t&&(t.remove(),p=null,C())}var T=40;function I(){document.body.style.setProperty("margin-top",`${T}px`,"important")}function C(){document.body.style.removeProperty("margin-top")}function v(t){let e=document.querySelectorAll("a[href]");for(let o of e){if(o.nextElementSibling?.classList.contains(L))continue;let r=o.href.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(!r)continue;let i=l(r[1]);if(!i)continue;let n=t.get(i);if(!n||n.status!=="matched"||!M(o))continue;let a=n.result,s=a.has_failed_replication?"badge--warning":"badge--success",f=document.createElement("span");f.className=L;let h=f.attachShadow({mode:"open"}),y=document.createElement("style");y.textContent=g,h.appendChild(y);let d=document.createElement("a");d.className=`flora-badge ${s}`,d.href=a.flora_url,d.target="_blank",d.rel="noopener",d.title=`FLoRA: ${a.replication_count} replication(s), ${a.reproduction_count} reproduction(s)`,d.innerHTML=`<span class="badge-icon">F</span> ${a.replication_count}R`,h.appendChild(d),o.insertAdjacentElement("afterend",f)}}function M(t){let e=window.getComputedStyle(t);return e.display!=="none"&&e.visibility!=="hidden"}function D(t){return t.replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]??e)}function B(t){return D(t)}var c=new Map;async function F(){let t=S(document);if(t.length===0)return;let e=t[0];for(let r of t)c.set(r,{status:"loading"});m(e,{status:"loading"});let o={type:"FLORA_LOOKUP",dois:t};try{let r=await chrome.runtime.sendMessage(o);for(let n of t)r.errors[n]?c.set(n,{status:"error",message:r.errors[n]}):r.results[n]?c.set(n,{status:"matched",result:r.results[n]}):c.set(n,{status:"no-match"});let i=c.get(e);i.status==="no-match"?u():m(e,i),v(c)}catch{c.set(e,{status:"error",message:"Failed to contact FLoRA service"}),m(e,c.get(e))}}var H=k(F,300);H();})();
