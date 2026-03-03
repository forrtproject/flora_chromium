"use strict";(()=>{var b=["https://doi.org/","http://doi.org/","https://dx.doi.org/","http://dx.doi.org/","doi:"];function l(n){let o=n.trim();for(let t of b)if(o.toLowerCase().startsWith(t)){o=o.slice(t.length);break}return/^10\.\d{4,}/.test(o)?o.toLowerCase():null}var p=`.flora-scholar-badge {
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
`;var f="flora-scholar-badge-host";function g(n,o){if(o.status!=="matched"||n.querySelector(`.${f}`))return;let t=o.result,s=t.has_failed_replication?"badge--warning":"badge--success",r=n.querySelector(".gs_rt");if(!r)return;let e=document.createElement("div");e.className=f;let a=e.attachShadow({mode:"open"}),c=document.createElement("style");c.textContent=p,a.appendChild(c);let i=document.createElement("a");i.className=`flora-scholar-badge ${s}`,i.href=t.flora_url,i.target="_blank",i.rel="noopener",i.innerHTML=`
    <span class="badge-label">FLoRA</span>
    <span class="badge-count">${t.replication_count} repl</span>
    ${t.reproduction_count>0?`<span class="badge-count">${t.reproduction_count} repro</span>`:""}
    ${t.has_failed_replication?'<span class="badge-alert">failed replication</span>':""}
  `,a.appendChild(i),r.insertAdjacentElement("afterend",e)}var y="#gs_res_ccl",d=".gs_r.gs_or.gs_scl",m="data-flora-processed";function h(){let n=document.querySelector(y);if(!n)return;new MutationObserver(t=>{let s=!1;for(let r of t){for(let e of r.addedNodes)if(e instanceof HTMLElement&&(e.matches(d)||e.querySelector(d))){s=!0;break}if(s)break}s&&u(document)}).observe(n,{childList:!0,subtree:!0})}async function u(n){let o=n.querySelectorAll(`${d}:not([${m}])`);if(o.length===0)return;let t=[];for(let e of o){e.setAttribute(m,"true");let a=L(e);a&&t.push({row:e,doi:a})}if(t.length===0)return;let r={type:"FLORA_LOOKUP",dois:[...new Set(t.map(e=>e.doi))]};try{let e=await chrome.runtime.sendMessage(r);for(let{row:a,doi:c}of t)e.results[c]&&g(a,{status:"matched",result:e.results[c]})}catch{}}function L(n){let o=n.querySelector(".gs_rt a");if(o?.href){let r=l(o.href);if(r)return r}let t=n.querySelector(".gs_a");if(t?.textContent){let r=t.textContent.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);if(r){let e=l(r[1]);if(e)return e}}let s=n.querySelectorAll("a[href]");for(let r of s)if(r.href.includes("doi.org/")){let e=l(r.href);if(e)return e}return null}u(document);h();})();
