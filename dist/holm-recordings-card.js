/* holm-recordings-card — https://github.com/kaaribou/holm-recordings-card — licence MIT — v1.1.0 */
// holm-recordings-card — enregistrements Reolink (NVR / caméras) : caméra, jour, frise 24 h avec les détections, lecture continue
// Lit la source multimédia « reolink » de Home Assistant (aucune configuration nécessaire).
// type: custom:holm-recordings-card
// title: Enregistrements
// resolution: sub | main        (basse / haute résolution)
// cameras:                      (optionnel : ordre, noms, détections à afficher sur la frise)
//   - title: Jardin              (nom de la caméra dans Reolink)
//     name: Jardin
//     events: [binary_sensor.jardin_person, binary_sensor.jardin_vehicle]
(() => {
const pad = (n) => String(n).padStart(2, "0");
const KIND = (id) => (/person|humain|personne/i.test(id) ? ["Personne", "#e05a8a"] : /vehic/i.test(id) ? ["Véhicule", "#4a90d9"] : /anim|pet|dog/i.test(id) ? ["Animal", "#9b6fd6"] : ["Mouvement", "#e3a21a"]);
const parseTs = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)).getTime();
const hms = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

class HolmRecordingsCard extends HTMLElement {
  setConfig(c) {
    this._c = { title: "Enregistrements", resolution: "sub", ...c };
    this._res = this._c.resolution; this._speed = 1; this._off = new Set(); // types de détection masqués
    if (this._hass && this.shadowRoot) { this._skeleton(); this._init(); }
  }
  set hass(h) {
    const first = !this._hass; this._hass = h;
    if (!this.shadowRoot) { this.attachShadow({ mode: "open" }); this._skeleton(); }
    if (first) this._init();
  }
  _ws(type, id) { return this._hass.callWS({ type, media_content_id: id }); }
  async _init() {
    try {
      const root = await this._ws("media_source/browse_media", "media-source://reolink");
      let cams = (root.children || []).map((x) => {
        const [, entry, ch] = x.media_content_id.split("/").pop().split("|");
        const cfg = (this._c.cameras || []).find((k) => k.title === x.title || k.name === x.title);
        return { title: x.title, name: cfg?.name || x.title, entry, ch, thumb: x.thumbnail, events: cfg?.events || [], hide: cfg?.hide };
      }).filter((x) => !x.hide);
      if (this._c.cameras?.length) {
        const order = this._c.cameras.map((k) => k.title);
        cams.sort((a, b) => (order.indexOf(a.title) + 1 || 99) - (order.indexOf(b.title) + 1 || 99));
      }
      this._cams = cams; this._err = null;
      this._cam = cams[0];
      this._renderCams();
      if (this._cam) await this._loadDays();
    } catch (e) { this._err = "Source Reolink introuvable : " + (e?.message || e); this._renderCams(); }
  }
  async _loadDays() {
    const c = this._cam;
    const r = await this._ws("media_source/browse_media", `media-source://reolink/RES|${c.entry}|${c.ch}|${this._res}`);
    this._days = (r.children || []).map((x) => { const p = x.media_content_id.split("|"); return { id: x.media_content_id, y: +p[4], m: +p[5], d: +p[6] }; }).reverse();
    const keep = this._day && this._days.find((d) => d.y === this._day.y && d.m === this._day.m && d.d === this._day.d);
    this._day = keep || this._days[0];
    this._renderDays();
    if (this._day) await this._loadFiles();
  }
  async _loadFiles() {
    const c = this._cam, d = this._day, seq = (this._seq = (this._seq || 0) + 1);
    this.$("tl").innerHTML = `<div class="ld">Chargement des enregistrements…</div>`;
    const r = await this._ws("media_source/browse_media", d.id);
    if (seq !== this._seq) return;
    this._files = (r.children || []).map((x) => { const p = x.media_content_id.split("|"); return { id: x.media_content_id, s: parseTs(p[5]), e: parseTs(p[6]) }; }).sort((a, b) => a.s - b.s);
    this._d0 = new Date(d.y, d.m - 1, d.d).getTime(); this._d1 = this._d0 + 86400000;
    this._events = [];
    if (c.events.length) {
      try {
        const h = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(this._d0).toISOString(), end_time: new Date(Math.min(this._d1, Date.now())).toISOString(),
          entity_ids: c.events, minimal_response: true, no_attributes: true, significant_changes_only: false });
        for (const [id, arr] of Object.entries(h || {})) for (const x of arr) if (x.s === "on") this._events.push({ id, t: (x.lu || x.lc) * 1000 });
        this._events = this._events.filter((e) => e.t >= this._d0).sort((a, b) => a.t - b.t);
      } catch (e) { /* détections facultatives */ }
    }
    if (seq !== this._seq) return;
    this._renderTimeline();
  }
  async _play(file, offset = 0) {
    if (!file) return;
    this._cur = file;
    const v = this.$("vid"), ov = this.$("ov");
    ov.hidden = false; ov.textContent = "Chargement…";
    try {
      const r = await this._ws("media_source/resolve_media", file.id);
      const url = this._hass.hassUrl ? this._hass.hassUrl(r.url) : r.url;
      v.src = url; v.playbackRate = this._speed;
      v.onloadedmetadata = () => { if (offset > 0 && offset < v.duration) v.currentTime = offset; v.playbackRate = this._speed; v.play().catch(() => {}); ov.hidden = true; };
      v.onerror = () => { ov.hidden = false; ov.textContent = "Lecture impossible pour ce fichier"; };
    } catch (e) { ov.textContent = "Erreur : " + (e?.message || e); }
    this._updateNow();
  }
  _step(dir) {
    if (!this._files?.length) return;
    const i = this._cur ? this._files.findIndex((f) => f.id === this._cur.id) : -1;
    const n = this._files[Math.max(0, Math.min(this._files.length - 1, i + dir))];
    if (n && n !== this._cur) this._play(n);
  }
  _at(t) { // fichier qui contient l'instant t (sinon le suivant)
    const f = this._files.find((x) => t >= x.s && t < x.e) || this._files.find((x) => x.s > t);
    if (f) this._play(f, Math.max(0, (t - f.s) / 1000 - 5));
  }
  $(id) { return this.shadowRoot.getElementById(id); }
  _updateNow() {
    const v = this.$("vid"), f = this._cur;
    if (!f) { this.$("now").innerHTML = "Choisis un moment sur la frise ou une détection"; return; }
    const t = f.s + (v.currentTime || 0) * 1000;
    this.$("now").innerHTML = `<b>${this._cam.name}</b> · ${new Date(t).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · <b>${hms(t)}</b>`;
    const ph = this.$("ph"); if (ph && this._d0) { ph.style.left = `${((t - this._d0) / 86400000) * 100}%`; ph.hidden = false; }
    this.shadowRoot.querySelectorAll(".sg.on").forEach((e) => e.classList.remove("on"));
    this.shadowRoot.querySelector(`.sg[data-i="${this._files?.indexOf(f)}"]`)?.classList.add("on");
  }
  _renderCams() {
    const box = this.$("cams");
    if (this._err) { box.innerHTML = `<div class="err">${this._err}</div>`; return; }
    box.innerHTML = (this._cams || []).map((c, i) => `<button class="chip ${c === this._cam ? "on" : ""}" data-i="${i}"><ha-icon icon="mdi:cctv"></ha-icon>${c.name}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = async () => { this._cam = this._cams[+b.dataset.i]; this._cur = null; this._toggleCal(false); this._renderCams(); this._resetPlayer(); await this._loadDays(); });
    this._reveal(box); this._edges(box);
    const st = this._hass.states[(this._cam?.thumb || "").split("/").pop()];
    if (st && !this._cur) this.$("vid").poster = st.attributes.entity_picture || "";
  }
  _resetPlayer() { const v = this.$("vid"); v.removeAttribute("src"); v.load(); this.$("ph").hidden = true; this._updateNow(); this.$("ov").hidden = true; }
  _renderDays() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    this.$("days").innerHTML = (this._days || []).map((d, i) => {
      const t = new Date(d.y, d.m - 1, d.d), diff = Math.round((today - t) / 86400000);
      const l = diff === 0 ? "Aujourd'hui" : diff === 1 ? "Hier" : t.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" });
      return `<button class="day ${d === this._day ? "on" : ""}" data-i="${i}">${l}</button>`;
    }).join("");
    this.$("days").querySelectorAll("button").forEach((b) => b.onclick = () => this._pickDay(this._days[+b.dataset.i]));
    this._reveal(this.$("days"));
    this._edges(this.$("days"));
  }
  _pickDay(d) {
    if (!d) return;
    this._day = d; this._cur = null; this._resetPlayer(); this._renderDays(); this._loadFiles();
  }
  // ----- calendrier : ne propose que les jours qui ont des enregistrements
  _toggleCal(force) {
    const box = this.$("calp"), open = force ?? box.hidden;
    box.hidden = !open;
    this.$("cal").classList.toggle("on", open);
    if (open) { const d = this._day || this._days?.[0]; this._calM = d ? [d.y, d.m] : [new Date().getFullYear(), new Date().getMonth() + 1]; this._renderCal(); }
  }
  _renderCal() {
    const [y, m] = this._calM, box = this.$("calp");
    const has = new Map((this._days || []).map((d) => [`${d.y}-${d.m}-${d.d}`, d]));
    const months = [...new Set((this._days || []).map((d) => d.y * 12 + d.m - 1))].sort((a, b) => a - b);
    const cur = y * 12 + m - 1, minM = months[0] ?? cur, maxM = months[months.length - 1] ?? cur;
    const first = new Date(y, m - 1, 1), lead = (first.getDay() + 6) % 7, n = new Date(y, m, 0).getDate();
    const today = new Date(); const tk = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<span></span>`;
    for (let d = 1; d <= n; d++) {
      const k = `${y}-${m}-${d}`, ok = has.has(k), sel = this._day && `${this._day.y}-${this._day.m}-${this._day.d}` === k;
      cells += `<button class="cd ${ok ? "ok" : ""} ${sel ? "on" : ""} ${k === tk ? "td" : ""}" ${ok ? `data-k="${k}"` : "disabled"}>${d}</button>`;
    }
    box.innerHTML = `<div class="ch"><button class="ib" data-m="-1" ${cur <= minM ? "disabled" : ""}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <b>${first.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}</b>
      <button class="ib" data-m="1" ${cur >= maxM ? "disabled" : ""}><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>
      <div class="cg">${["L", "M", "M", "J", "V", "S", "D"].map((x) => `<em>${x}</em>`).join("")}${cells}</div>
      <div class="cf">${(this._days || []).length} jours enregistrés</div>`;
    box.querySelectorAll("[data-m]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); const t = cur + +b.dataset.m; this._calM = [Math.floor(t / 12), (t % 12) + 1]; this._renderCal(); });
    box.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { this._toggleCal(false); this._pickDay(has.get(b.dataset.k)); });
  }
  // ----- défilement horizontal : molette, glisser à la souris, flèches aux bords
  _scrollable(row) {
    if (row._sc) return; row._sc = true;
    row.addEventListener("wheel", (ev) => {
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || row.scrollWidth <= row.clientWidth) return;
      const before = row.scrollLeft; row.scrollLeft += ev.deltaY;
      if (row.scrollLeft !== before) ev.preventDefault();
    }, { passive: false });
    let x0 = null, l0 = 0, moved = false;
    row.addEventListener("pointerdown", (ev) => { if (ev.pointerType !== "mouse" || ev.button) return; x0 = ev.clientX; l0 = row.scrollLeft; moved = false; });
    row.addEventListener("pointermove", (ev) => {
      if (x0 === null) return; const dx = ev.clientX - x0;
      if (Math.abs(dx) > 4) { moved = true; row.classList.add("drag"); row.scrollLeft = l0 - dx; }
    });
    const end = () => { x0 = null; setTimeout(() => row.classList.remove("drag"), 0); };
    row.addEventListener("pointerup", end); row.addEventListener("pointerleave", end);
    row.addEventListener("click", (ev) => { if (moved) { ev.stopPropagation(); ev.preventDefault(); moved = false; } }, true);
    row.addEventListener("scroll", () => this._edges(row), { passive: true });
    const w = row.parentElement;
    w.querySelector(".sa.l")?.addEventListener("click", () => row.scrollBy({ left: -row.clientWidth * 0.8, behavior: "smooth" }));
    w.querySelector(".sa.r")?.addEventListener("click", () => row.scrollBy({ left: row.clientWidth * 0.8, behavior: "smooth" }));
    if (window.ResizeObserver) { (this._ro ||= new ResizeObserver((es) => es.forEach((e) => this._edges(e.target)))).observe(row); }
  }
  _edges(row) {
    if (!row) return; this._scrollable(row);
    const w = row.parentElement, max = row.scrollWidth - row.clientWidth - 1;
    w.classList.toggle("cl", row.scrollLeft > 1); w.classList.toggle("cr", row.scrollLeft < max);
  }
  _reveal(row) { const el = row?.querySelector(".on"); if (el) requestAnimationFrame(() => { const r = row.getBoundingClientRect(), e = el.getBoundingClientRect(); if (e.left < r.left || e.right > r.right) row.scrollLeft += e.left - r.left - (r.width - e.width) / 2; this._edges(row); }); }
  _renderTimeline() {
    const pct = (t) => (((t - this._d0) / 86400000) * 100).toFixed(3);
    const segs = this._files.map((f, i) => `<i class="sg" data-i="${i}" style="left:${pct(f.s)}%;width:${(((f.e - f.s) / 86400000) * 100).toFixed(3)}%"></i>`).join("");
    const allKinds = [...new Map(this._events.map((e) => KIND(e.id))).entries()];
    const shown = this._events.filter((e) => !this._off.has(KIND(e.id)[0]));
    const ev = shown.map((e) => { const [n, col] = KIND(e.id); return `<b class="ev" data-t="${e.t}" title="${n} · ${hms(e.t)}" style="left:${pct(e.t)}%;background:${col}"></b>`; }).join("");
    const hrs = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<em style="left:${(h / 24) * 100}%">${h}h</em>`).join("");
    const count = (n) => this._events.filter((e) => KIND(e.id)[0] === n).length;
    const list = shown.slice(-200).reverse();
    this.$("tl").innerHTML = `
      <div class="bar" id="bar"><div class="evs">${ev}</div><div class="rec">${segs}</div><div class="ph" id="ph" hidden></div><div class="hv" id="hv" hidden></div></div>
      <div class="ax">${hrs}</div>
      <div class="lg"><span><i class="lr"></i>Enregistré (${this._files.length} fichiers)</span>
        ${allKinds.length > 1 ? `<span class="fl">Afficher :</span><button class="fk ${this._off.size ? "" : "on"}" data-k="*">Tout</button>` : ""}
        ${allKinds.map(([n, c]) => `<button class="fk ${this._off.has(n) ? "" : "on"}" data-k="${n}" style="--c:${c}" title="Afficher / masquer : ${n}"><i></i>${n}<small>${count(n)}</small></button>`).join("")}</div>
      ${list.length ? `<div class="scw"><button class="sa l" aria-label="Précédents"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="evl row" id="evl">${list.map((e) => { const [n, c] = KIND(e.id); return `<button class="ei" data-t="${e.t}" style="--c:${c}"><i></i>${hms(e.t).slice(0, 5)}<small>${n}</small></button>`; }).join("")}</div><button class="sa r" aria-label="Suivants"><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>`
        : this._cam.events.length ? `<div class="nd">${this._events.length ? "Aucune détection pour ce filtre" : "Aucune détection ce jour-là"}</div>` : ""}`;
    const bar = this.$("bar"), hv = this.$("hv");
    const tAt = (ev) => { const r = bar.getBoundingClientRect(); return this._d0 + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 86400000; };
    bar.onpointermove = (ev) => { const t = tAt(ev); hv.hidden = false; hv.style.left = `${pct(t)}%`; hv.textContent = hms(t).slice(0, 5); };
    bar.onpointerleave = () => (hv.hidden = true);
    bar.onclick = (ev) => { const t = ev.target.dataset?.t ? +ev.target.dataset.t : tAt(ev); this._at(t); };
    this.shadowRoot.querySelectorAll(".ei").forEach((b) => b.onclick = () => this._at(+b.dataset.t));
    this.shadowRoot.querySelectorAll(".fk").forEach((b) => b.onclick = () => {
      const k = b.dataset.k;
      if (k === "*") this._off.clear();
      else if (this._off.has(k)) this._off.delete(k);
      else { this._off.add(k); if (allKinds.every(([n]) => this._off.has(n))) this._off.clear(); }
      this._renderTimeline();
    });
    if (this.$("evl")) this._edges(this.$("evl"));
    this._updateNow();
  }
  _skeleton() {
    const c = this._c;
    this.shadowRoot.innerHTML = `
    <style>
      :host { display:block; }
      ha-card { display:block; padding:14px 16px 12px; box-sizing:border-box; height:100%; }
      .hd { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
      .tt { font-size:16px; font-weight:600; color:var(--primary-text-color); }
      .seg { display:flex; background:color-mix(in srgb, var(--primary-text-color) 6%, transparent); border-radius:10px; padding:2px; }
      .seg button { border:none; background:none; color:var(--secondary-text-color); font:inherit; font-size:12px; padding:4px 10px; border-radius:8px; cursor:pointer; }
      .seg button.on { background:color-mix(in srgb, var(--primary-color, #0abfbf) 25%, transparent); color:var(--primary-text-color); font-weight:600; }
      .row { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; padding-bottom:2px; scroll-behavior:smooth; user-select:none; -webkit-user-select:none; }
      .row.drag { scroll-behavior:auto; cursor:grabbing; } .row.drag * { pointer-events:none; }
      .row::-webkit-scrollbar { display:none; }
      .scw { position:relative; min-width:0; flex:1; margin-bottom:8px; }
      .scw .row { --fl:0px; --fr:0px; -webkit-mask-image:linear-gradient(90deg, transparent 0, #000 var(--fl), #000 calc(100% - var(--fr)), transparent 100%); mask-image:linear-gradient(90deg, transparent 0, #000 var(--fl), #000 calc(100% - var(--fr)), transparent 100%); }
      .scw.cl .row { --fl:40px; } .scw.cr .row { --fr:40px; }
      .sa { position:absolute; top:50%; transform:translateY(calc(-50% - 1px)); z-index:2; width:26px; height:26px; border-radius:50%; border:none; cursor:pointer; display:none; align-items:center; justify-content:center; padding:0;
            background:color-mix(in srgb, var(--primary-text-color) 16%, var(--ha-card-background, var(--card-background-color, #1c1c1c))); color:var(--primary-text-color); box-shadow:0 2px 6px rgba(0,0,0,.35); }
      .sa ha-icon { --mdc-icon-size:18px; } .sa.l { left:0; } .sa.r { right:0; }
      .scw.cl .sa.l, .scw.cr .sa.r { display:flex; }
      .dr { position:relative; display:flex; align-items:flex-start; gap:6px; }
      .ib.cal { flex:none; height:28px; width:32px; border-radius:999px; } .ib.cal.on { background:color-mix(in srgb, var(--primary-color, #0abfbf) 30%, transparent); }
      .calp { position:absolute; z-index:5; top:34px; left:0; width:264px; padding:10px; border-radius:14px; box-sizing:border-box;
              background:var(--ha-card-background, var(--card-background-color, #1c2430)); box-shadow:0 12px 32px rgba(0,0,0,.45), 0 0 0 1px var(--divider-color, rgba(255,255,255,.1)); }
      .calp[hidden] { display:none; }
      .ch { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; } .ch b { font-size:13px; text-transform:capitalize; color:var(--primary-text-color); }
      .ch .ib:disabled { opacity:.3; cursor:default; }
      .cg { display:grid; grid-template-columns:repeat(7, 1fr); gap:3px; text-align:center; }
      .cg em { font-style:normal; font-size:10px; color:var(--secondary-text-color); padding:2px 0; }
      .cd { font:inherit; font-size:12px; height:30px; border-radius:8px; border:none; background:none; color:var(--secondary-text-color); opacity:.35; padding:0; }
      .cd.ok { opacity:1; cursor:pointer; color:var(--primary-text-color); background:color-mix(in srgb, var(--primary-color, #0abfbf) 12%, transparent); }
      .cd.ok:hover { background:color-mix(in srgb, var(--primary-color, #0abfbf) 28%, transparent); }
      .cd.td { box-shadow:inset 0 0 0 1px var(--primary-color, #0abfbf); }
      .cd.on { background:var(--primary-color, #0abfbf); color:#fff; font-weight:700; }
      .cf { font-size:11px; color:var(--secondary-text-color); text-align:center; margin-top:6px; }
      .fl { margin-left:6px; }
      .fk { font:inherit; font-size:11px; cursor:pointer; display:flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; background:none; color:var(--secondary-text-color);
            border:1px solid color-mix(in srgb, var(--primary-text-color) 14%, transparent); opacity:.55; }
      .fk i { width:8px; height:8px; border-radius:50%; background:var(--c, var(--primary-color, #0abfbf)); display:inline-block; }
      .fk small { font-size:10px; opacity:.8; }
      .fk.on { opacity:1; color:var(--primary-text-color); border-color:color-mix(in srgb, var(--c, var(--primary-color, #0abfbf)) 60%, transparent); background:color-mix(in srgb, var(--c, var(--primary-color, #0abfbf)) 14%, transparent); }
      .chip, .day { flex:none; font:inherit; font-size:12.5px; cursor:pointer; border-radius:999px; padding:5px 12px; display:flex; align-items:center; gap:5px; white-space:nowrap;
            border:1px solid color-mix(in srgb, var(--primary-text-color) 12%, transparent); background:none; color:var(--secondary-text-color); }
      .chip ha-icon { --mdc-icon-size:15px; }
      .chip.on, .day.on { background:color-mix(in srgb, var(--primary-color, #0abfbf) 22%, transparent); border-color:var(--primary-color, #0abfbf); color:var(--primary-text-color); font-weight:600; }
      .day { font-size:12px; padding:4px 10px; text-transform:capitalize; }
      .pl { position:relative; border-radius:14px; overflow:hidden; background:#000; aspect-ratio:16/9; }
      video { width:100%; height:100%; display:block; object-fit:contain; background:#000; }
      .ov { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:13px; background:rgba(0,0,0,.45); }
      .ov[hidden] { display:none; }
      .ctl { display:flex; align-items:center; gap:8px; margin:8px 0 10px; }
      .now { flex:1; font-size:12.5px; color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .now b { color:var(--primary-text-color); font-weight:600; }
      .ib { border:none; background:color-mix(in srgb, var(--primary-text-color) 7%, transparent); color:var(--primary-text-color); border-radius:10px; width:34px; height:30px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .ib ha-icon { --mdc-icon-size:18px; }
      .bar { position:relative; height:40px; border-radius:8px; background:color-mix(in srgb, var(--primary-text-color) 5%, transparent); cursor:crosshair; }
      .rec { position:absolute; left:0; right:0; bottom:4px; height:14px; }
      .sg { position:absolute; top:0; bottom:0; background:color-mix(in srgb, var(--primary-color, #0abfbf) 35%, transparent); }
      .sg.on { background:var(--primary-color, #0abfbf); }
      .evs { position:absolute; left:0; right:0; top:4px; height:16px; }
      .ev { position:absolute; top:0; width:3px; height:16px; border-radius:2px; transform:translateX(-1px); cursor:pointer; }
      .ev:hover { transform:translateX(-1px) scaleY(1.25); }
      .ph { position:absolute; top:-3px; bottom:-3px; width:2px; background:#fff; box-shadow:0 0 6px rgba(255,255,255,.7); pointer-events:none; }
      .hv { position:absolute; top:-20px; transform:translateX(-50%); font-size:10px; padding:1px 5px; border-radius:5px; background:var(--card-background-color, #111); color:var(--primary-text-color); pointer-events:none; border:1px solid var(--divider-color); }
      .ph[hidden], .hv[hidden] { display:none; }
      .ax { position:relative; height:14px; margin-top:2px; } .ax em { position:absolute; font-style:normal; font-size:10px; color:var(--secondary-text-color); transform:translateX(-50%); }
      .ax em:first-child { transform:none; }
      .lg { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:11px; color:var(--secondary-text-color); margin-top:4px; }
      .lg span { display:flex; align-items:center; gap:4px; } .lg i { width:9px; height:9px; border-radius:3px; display:inline-block; }
      .lg i.lr { background:color-mix(in srgb, var(--primary-color, #0abfbf) 45%, transparent); }
      .evl { gap:5px; margin-top:10px; }
      .ei { flex:none; font:inherit; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:5px; padding:4px 9px; border-radius:10px; border:none;
            color:var(--primary-text-color); background:color-mix(in srgb, var(--c) 14%, transparent); }
      .ei i { width:7px; height:7px; border-radius:50%; background:var(--c); } .ei small { font-weight:400; color:var(--secondary-text-color); }
      .nd, .ld { font-size:12px; color:var(--secondary-text-color); padding:8px 0; }
      .err { color:var(--error-color); font-size:12px; }
    </style>
    <ha-card>
      <div class="hd"><div class="tt">${c.title || ""}</div>
        <div class="seg">${[["sub", "Basse déf."], ["main", "Haute déf."]].map(([k, l]) => `<button data-r="${k}" class="${this._res === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="scw"><button class="sa l" aria-label="Précédentes"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="row" id="cams"></div><button class="sa r" aria-label="Suivantes"><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>
      <div class="dr"><button class="ib cal" id="cal" title="Choisir une date"><ha-icon icon="mdi:calendar-month-outline"></ha-icon></button>
        <div class="scw"><button class="sa l" aria-label="Jours plus récents"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="row" id="days"></div><button class="sa r" aria-label="Jours plus anciens"><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>
        <div class="calp" id="calp" hidden></div></div>
      <div class="pl"><video id="vid" controls playsinline muted preload="metadata"></video><div class="ov" id="ov" hidden></div></div>
      <div class="ctl"><button class="ib" id="prev" title="Clip précédent"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
        <div class="now" id="now"></div>
        <button class="ib" id="spd" title="Vitesse" style="width:auto;padding:0 10px;font:inherit;font-size:12px;font-weight:700">1×</button>
        <button class="ib" id="next" title="Clip suivant"><ha-icon icon="mdi:skip-next"></ha-icon></button></div>
      <div id="tl"><div class="ld">Recherche des caméras…</div></div>
    </ha-card>`;
    const v = this.$("vid");
    v.addEventListener("timeupdate", () => this._updateNow());
    v.addEventListener("ended", () => this._step(1)); // lecture continue
    this.$("cal").onclick = (ev) => { ev.stopPropagation(); this._toggleCal(); };
    this.$("calp").onclick = (ev) => ev.stopPropagation();
    this.shadowRoot.addEventListener("click", () => { if (!this.$("calp").hidden) this._toggleCal(false); });
    this.$("prev").onclick = () => this._step(-1);
    this.$("next").onclick = () => this._step(1);
    this.$("spd").onclick = () => { const s = [1, 2, 4, 8]; this._speed = s[(s.indexOf(this._speed) + 1) % s.length]; v.playbackRate = this._speed; this.$("spd").textContent = this._speed + "×"; };
    this.shadowRoot.querySelectorAll(".seg button").forEach((b) => b.onclick = async () => {
      if (this._res === b.dataset.r) return; this._res = b.dataset.r;
      this.shadowRoot.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
      const keep = this._cur ? this._cur.s + (v.currentTime || 0) * 1000 : null; this._cur = null;
      await this._loadDays(); if (keep) this._at(keep + 5000);
    });
    this._updateNow();
  }
  static getConfigElement() { return document.createElement("holm-recordings-card-editor"); }
  static getStubConfig() { return { title: "Enregistrements" }; }
  getCardSize() { return 9; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
}

const L = { title: "Titre", resolution: "Résolution par défaut", name: "Nom affiché", events: "Détections à afficher sur la frise", hide: "Masquer cette caméra" };
class HolmRecordingsCardEditor extends HTMLElement {
  setConfig(c) { const j = JSON.stringify(c); this._config = JSON.parse(j); if (j === this._last && this._built) return; this._build(); }
  set hass(h) { this._hass = h; if (!this._built) this._build(); else this.querySelectorAll("ha-form").forEach((f) => (f.hass = h)); }
  _emit() { this._last = JSON.stringify(this._config); this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: JSON.parse(this._last) }, bubbles: true, composed: true })); }
  _form(schema, data, cb) { const f = document.createElement("ha-form"); f.hass = this._hass; f.schema = schema; f.data = data; f.computeLabel = (s) => L[s.name] || s.name;
    f.addEventListener("value-changed", (ev) => { ev.stopPropagation(); cb(ev.detail.value); }); return f; }
  async _build() {
    if (!this._hass || !this._config) return;
    this._built = true;
    let titles = [];
    try { const r = await this._hass.callWS({ type: "media_source/browse_media", media_content_id: "media-source://reolink" }); titles = (r.children || []).map((x) => x.title); } catch (e) { /* */ }
    const c = this._config;
    this.innerHTML = `<style>.it{border:1px solid var(--divider-color);border-radius:12px;padding:8px 12px 4px;margin:10px 0}.ih{font-weight:600;margin-bottom:4px}</style><div class="gen"></div><div class="items"></div>`;
    this.querySelector(".gen").appendChild(this._form([{ type: "grid", name: "", schema: [{ name: "title", selector: { text: {} } },
      { name: "resolution", selector: { select: { mode: "dropdown", options: [{ value: "sub", label: "Basse définition (rapide)" }, { value: "main", label: "Haute définition" }] } } }] }],
      { resolution: "sub", ...c }, (v) => { Object.assign(this._config, v); if (v.resolution === "sub") delete this._config.resolution; this._emit(); }));
    const box = this.querySelector(".items");
    titles.forEach((t) => {
      const cur = (c.cameras || []).find((k) => k.title === t) || { title: t };
      const w = document.createElement("div"); w.className = "it"; w.innerHTML = `<div class="ih">${t}</div>`;
      w.appendChild(this._form([{ type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "hide", selector: { boolean: {} } }] },
        { name: "events", selector: { entity: { multiple: true, domain: ["binary_sensor"] } } }], cur, (v) => {
        const list = (this._config.cameras = (this._config.cameras || []).filter((k) => k.title !== t));
        const o = { title: t }; if (v.name) o.name = v.name; if (v.hide) o.hide = true; if (v.events?.length) o.events = v.events;
        list.push(o); this._config.cameras = titles.map((x) => list.find((k) => k.title === x)).filter(Boolean); this._emit(); }));
      box.appendChild(w);
    });
  }
}
if (!customElements.get("holm-recordings-card-editor")) customElements.define("holm-recordings-card-editor", HolmRecordingsCardEditor);
if (!customElements.get("holm-recordings-card")) customElements.define("holm-recordings-card", HolmRecordingsCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "holm-recordings-card", name: "HOLM – Enregistrements caméras", description: "Enregistrements Reolink : caméra, jour, frise 24 h avec les détections et lecture continue", preview: false });
})();

console.info("%c HOLM-RECORDINGS %c 1.1.0 ", "background:#0abfbf;color:#111;border-radius:3px 0 0 3px", "background:#123;color:#fff;border-radius:0 3px 3px 0");
