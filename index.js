// ===== Правила =====
const RULES = {
    natasha: [
        { maxG: 289,  price: 0 },
        { maxG: 540,  price: 50 },
        { maxG: 1040, price: 100 },
        { maxG: Infinity, price: 150 }
    ],
    maxim: { smallG: 250, priceSmall: 10, priceLarge: 25 },
    over:  { priceMaxim: 20 },
    roundingMoney: 1,
    noDiscountUpToG: 259,    // <= 259 г — без знижки
    smallTxnFeeUah: 20       // +20 грн до оплати для малих
};

const state = {
    clients: [], // {id,name,items:[{track,weightG,labelPriceUah,clientPriceUah}], overCount, actualPostPaidUah}
    selectedClientId: null,
    discounts: { clientPct: 30, natashaPct: 20 },
    natashaManual: null, // ручна сума Наталі (після знижки). Якщо null -> авто
};

// ===== Утіліти =====
function toast(msg) {
    const t = document.getElementById("toast"); if (!t) return;
    t.textContent = msg; t.style.display = "block";
    setTimeout(()=>{ t.style.display="none"; }, 2200);
}
function roundMoney(x, step = RULES.roundingMoney) {
    return Math.round((x ?? 0) / step) * step;
}
function uniqId(){ return Date.now()+"-"+Math.random().toString(36).slice(2,7); }
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));

// Цена для клиента с учётом правила "до 259 г — без скидки, +20 грн"
function clientPriceFor(item) {
    const label = Number(item.labelPriceUah);
    if (!Number.isFinite(label)) return null;

    if (typeof item.weightG === "number" && item.weightG <= RULES.noDiscountUpToG) {
        // малые отправления — без скидки, +20 грн комиссия
        return roundMoney(label + RULES.smallTxnFeeUah);
    }
    // обычный случай — скидка от цены на наклейке
    const disc = (state.discounts.clientPct ?? 30) / 100;
    return roundMoney(label * (1 - disc));
}

// ===== Парсинг PDF (1 файл) =====
async function parseSinglePdf(file) {
    const arrBuf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrBuf }).promise;
    const shipments = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        try {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const lines = groupTextByLines(content.items);
            const found = extractShipmentsFromLines(lines);
            shipments.push(...found);
        } catch (e) {
            console.warn("Skip page", p, e);
        }
    }
    return shipments;
}

function groupTextByLines(items) {
    const rows = [];
    const TOL = 3;
    for (const it of items) {
        let str = (it.str ?? "").replace(/\u00A0/g, " ").trim(); // NBSP -> space
        if (!str) continue;
        const y = Math.round(it.transform[5]);
        let row = rows.find(r => Math.abs(r.y - y) <= TOL);
        if (!row) { row = { y, parts: [] }; rows.push(row); }
        row.parts.push({ x: it.transform[4], text: str });
    }
    rows.sort((a,b)=>b.y - a.y);
    return rows.map(r => {
        r.parts.sort((a,b)=>a.x - b.x);
        return r.parts.map(p=>p.text).join(" ").replace(/\s+/g," ").trim();
    });
}

// Регекси
const RE_TRACK  = /\b([A-Z]{2})\s?(\d{3})\s?(\d{3})\s?(\d{3})\s?([A-Z]{2})\b/;
const RE_WEIGHT = /(\d+(?:[.,]\d+)?)\s?(?:kg|кг)\b/i;
const RE_PRICE  = /(\d[\d\s]*(?:[.,]\d{1,2})?)\s?(?:UAH|грн\.?|₴)/i;

function toNumber(s) {
    if (typeof s !== "string") return NaN;
    return Number(s.replace(/\s+/g,"").replace(",","."));
}

// ——— Одна наклейка = блок навколо треку + дедуп по треку
function extractShipmentsFromLines(lines) {
    const blocks = [];
    const tracks = [];
    for (let i=0;i<lines.length;i++) {
        const L0 = lines[i];
        const L01 = (i+1<lines.length) ? (L0 + " " + lines[i+1]) : L0;
        let m = L0.match(RE_TRACK) || L01.match(RE_TRACK);
        if (m) {
            const track = (m[1] + m[2] + m[3] + m[4] + m[5]).replace(/\s+/g,"");
            tracks.push({ i, track });
        }
    }
    for (let k=0;k<tracks.length;k++) {
        const start = tracks[k].i;
        const end = (k+1<tracks.length) ? tracks[k+1].i - 1 : lines.length - 1;
        blocks.push({ start, end, track: tracks[k].track });
    }

    const results = [];
    const seenTracks = new Set();
    for (const b of blocks) {
        const aroundStart = clamp(b.start-3, 0, lines.length-1);
        const aroundEnd   = clamp(b.start+6, 0, lines.length-1);
        let bestW = null, bestWdist = 1e9;
        let bestP = null, bestPdist = 1e9;

        for (let j=aroundStart; j<=aroundEnd; j++) {
            const line = lines[j];
            const w = line.match(RE_WEIGHT);
            if (w) {
                const val = Math.round(toNumber(w[1]) * 1000);
                const dist = Math.abs(j - b.start);
                if (Number.isFinite(val) && dist < bestWdist) { bestW = val; bestWdist = dist; }
            }
            const p = line.match(RE_PRICE);
            if (p) {
                const val = toNumber(p[1]);
                const dist = Math.abs(j - b.start);
                if (Number.isFinite(val) && dist < bestPdist) { bestP = val; bestPdist = dist; }
            }
        }

        const track = b.track;
        if (seenTracks.has(track)) continue;
        seenTracks.add(track);

        const labelPriceUah = bestP!=null ? bestP : null;
        const weightG = (bestW!=null ? bestW : null);
        const clientPriceUah = labelPriceUah!=null ? clientPriceFor({ labelPriceUah, weightG }) : null;

        results.push({ track, weightG, labelPriceUah, clientPriceUah });
    }

    return results;
}

// ===== Рендер карток =====
const clientsEl = document.getElementById("clients");

function renderClients() {
    clientsEl.innerHTML = "";
    state.clients.forEach((c, idx) => {
        const sec = document.createElement("section");
        sec.className = "card";
        sec.dataset.id = c.id;

        // Подсветка рамкой, если не введена фактическая сумма (и есть отправления)
        const needsPost = needsActualPost(c);
        sec.style.borderColor = needsPost ? "#ff6b6b" : ""; // красная окантовка

        sec.innerHTML = `
      <div class="row" style="justify-content:space-between;cursor:pointer" data-act="select-card">
        <div><b>${c.name}</b> <span class="pill">#${idx+1}</span></div>
        <div class="row" style="cursor:auto">
          <label>Фактична оплата за пошту (грн)</label>
          <input type="number" min="0" step="1" value="${c.actualPostPaidUah ?? ''}" data-act="actual-post" style="width:120px" />
          <label>Перевіси</label>
          <select data-act="over-sel">${[...Array(11).keys()].map(n=>`<option value="${n}" ${c.overCount===n?'selected':''}>${n}</option>`).join("")}</select>
          <button data-act="add-row">+ Відправлення</button>
          <button data-act="copy-client">Скопіювати повідомлення клієнту</button>
          <button data-act="delete-card">Видалити картку</button>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:6px">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Трек</th>
              <th>Вага (г)</th>
              <th>Ціна за наклейкою (грн)</th>
              <th>До оплати (грн)</th>
              <th>Наталі</th>
              <th>Мал/Вел</th>
              <th class="right">Дія</th>
            </tr>
          </thead>
          <tbody>
            ${c.items.map((it,i)=>renderRow(it,i)).join("")}
          </tbody>
        </table>
      </div>
    `;
        clientsEl.appendChild(sec);

        // події
        sec.addEventListener("click", (e)=>{
            const t = e.target;
            if (!(t instanceof HTMLElement)) return;

            if (t.dataset.act === "select-card" || t.closest("[data-act='select-card']")) {
                state.selectedClientId = c.id; highlightSelection();
            }
            if (t.dataset.act === "delete-card") {
                if (confirm("Видалити картку?")) {
                    const pos = state.clients.findIndex(x=>x.id===c.id);
                    if (pos>=0) state.clients.splice(pos,1);
                    renderClients(); renderTotals();
                }
                return;
            }
            if (t.dataset.act === "add-row") {
                c.items.push({ track:"", weightG:null, labelPriceUah:null, clientPriceUah:null });
                renderClients(); renderTotals(); return;
            }
            if (t.dataset.act === "copy-client") {
                const msg = buildClientMessage(c);
                navigator.clipboard.writeText(msg);
                toast("Повідомлення скопійовано");
                return;
            }

            const tr = t.closest("tr");
            if (!tr) return;

            if (t.dataset.act === "row-del") {
                const idx = Number(tr.dataset.idx);
                c.items.splice(idx,1);
                renderClients(); renderTotals();
                return;
            }
            if (t.dataset.act === "row-edit") {
                const idx = Number(tr.dataset.idx);
                editRowInline(tr, c.items[idx], c);
                return;
            }
        });

        // ввод фактичної суми: подсветка исчезает сразу
        sec.querySelectorAll("[data-act='actual-post']").forEach(inp=>{
            inp.addEventListener("input", e => {
                const val = e.target.value;
                c.actualPostPaidUah = val === "" ? null : Number(val);
                // обновим только рамку и итоги (без полной перерисовки таблицы)
                sec.style.borderColor = needsActualPost(c) ? "#ff6b6b" : "";
                renderTotals();
            });
        });
        sec.querySelectorAll("[data-act='over-sel']").forEach(sel=>{
            sel.addEventListener("change", e=>{
                c.overCount = Number(e.target.value)||0;
                renderTotals();
            });
        });
    });
    highlightSelection();
}

function renderRow(it, i){
    const isSmall = typeof it.weightG==="number" && it.weightG <= RULES.maxim.smallG;
    const natasha = calcNatasha(it.weightG);
    return `
    <tr data-idx="${i}" class="${(!it.track || it.labelPriceUah==null) ? 'warn':''}">
      <td>${i+1}</td>
      <td>${it.track || '<span class="mut">нема</span>'}</td>
      <td>${it.weightG ?? '<span class="mut">нема</span>'}</td>
      <td>${it.labelPriceUah ?? '<span class="mut">нема</span>'}</td>
      <td>${it.clientPriceUah ?? '<span class="mut">нема</span>'}</td>
      <td>${natasha}</td>
      <td>${isSmall ? 'Мал' : 'Вел'}</td>
      <td class="right">
        <button data-act="row-edit">Редагувати</button>
        <button data-act="row-del">Видалити</button>
      </td>
    </tr>
  `;
}

function editRowInline(tr, it, client){
    tr.innerHTML = `
    <td></td>
    <td><input value="${it.track||''}" data-f="track" /></td>
    <td><input type="number" value="${it.weightG??''}" data-f="weightG" /></td>
    <td><input type="number" step="0.01" value="${it.labelPriceUah??''}" data-f="labelPriceUah" /></td>
    <td class="mut">(авто)</td>
    <td class="mut">(розрах.)</td>
    <td class="mut">(мал/вел)</td>
    <td class="right"><button data-act="row-save">Зберегти</button></td>
  `;
    tr.querySelector("[data-act='row-save']").addEventListener("click", ()=>{
        const get = (f)=> tr.querySelector(`[data-f='${f}']`);
        it.track = get("track").value.trim();
        it.weightG = get("weightG").value ? Number(get("weightG").value) : null;
        it.labelPriceUah = get("labelPriceUah").value ? Number(get("labelPriceUah").value) : null;
        it.clientPriceUah = (it.labelPriceUah!=null) ? clientPriceFor(it) : null;
        renderClients(); renderTotals();
    });
}

function highlightSelection(){
    document.querySelectorAll("#clients .card").forEach(sec=>{
        sec.classList.toggle("outline", sec.dataset.id === String(state.selectedClientId));
    });
}

// ===== Розрахунки =====
function calcNatasha(weightG) {
    if (typeof weightG !== "number" || Number.isNaN(weightG)) return 0;
    for (const r of RULES.natasha) if (weightG <= r.maxG) return r.price;
    return 0;
}

function needsActualPost(c){
    const hasRows = (c.items && c.items.length > 0);
    const val = Number(c.actualPostPaidUah);
    // считаем "введено" только если число > 0 и не NaN
    const entered = Number.isFinite(val) && val > 0;
    return hasRows && !entered;
}

function anyClientMissingPost(){
    return state.clients.some(needsActualPost);
}

function aggregate() {
    let natashaFull = 0;
    let cntSmall=0, cntLarge=0, cntOver=0;
    let clientsSum = 0;
    let postFact = 0;

    for (const c of state.clients) {
        postFact += Number(c.actualPostPaidUah)||0;
        cntOver += Number(c.overCount)||0;

        for (const it of c.items) {
            if (it.clientPriceUah != null) clientsSum += it.clientPriceUah;
            natashaFull += calcNatasha(it.weightG);
            if (typeof it.weightG === "number") {
                if (it.weightG <= RULES.maxim.smallG) cntSmall++; else cntLarge++;
            }
        }
    }

    const maxim = cntSmall*RULES.maxim.priceSmall + cntLarge*RULES.maxim.priceLarge + cntOver*RULES.over.priceMaxim;

    const natashaPayAuto = roundMoney(natashaFull * (1 - (state.discounts.natashaPct ?? 20)/100));
    const natashaPay = (typeof state.natashaManual === "number" && !isNaN(state.natashaManual))
        ? state.natashaManual
        : natashaPayAuto;

    const finalProfit = roundMoney((clientsSum - postFact - natashaPay - maxim) / 2);

    return {
        clientsSum: roundMoney(clientsSum),
        postFact:   roundMoney(postFact),
        natashaFull:roundMoney(natashaFull),
        natashaPay, maxim, finalProfit,
        cntSmall, cntLarge, cntOver,
        natashaPayAuto
    };
}

function renderTotals(){
    const t = aggregate();
    const box = document.getElementById("totals");
    if (!box) return;

    const missing = anyClientMissingPost();
    const profitClass = missing ? 'bad' : (t.finalProfit>=0?'ok':'bad');

    box.innerHTML = `
    <div class="grid-3">
      <div><label>Сума клієнтів (грн)</label><div><b>${t.clientsSum}</b></div></div>
      <div><label>Пошта фактично (грн)</label><div>${t.postFact}</div></div>
      <div><label>Фін.прибуток (грн)</label><div class="${profitClass}"><b>${t.finalProfit}</b></div></div>
    </div>
    <div class="grid-3" style="margin-top:10px">
      <div><label>Наталі (повна)</label><div>${t.natashaFull}</div></div>
      <div>
        <label>Наталі (з урахуванням знижки / вручну):</label>
        <input type="number" id="natashaManual" value="${t.natashaPay}" style="width:120px" />
        <small class="mut">Авто = ${t.natashaPayAuto}</small>
      </div>
      <div><label>Максим</label><div>${t.maxim} <span class="mut">(${t.cntSmall} мал / ${t.cntLarge} вел / перевіс ${t.cntOver})</span></div></div>
    </div>
  `;

    // Наталі: пересчитываем ТОЛЬКО по Enter/blur
    const nm = document.getElementById("natashaManual");
    nm.addEventListener("keydown", e=>{
        if (e.key === "Enter") {
            const val = Number(e.target.value);
            state.natashaManual = isNaN(val) ? null : val;
            renderTotals();
        }
    });
    nm.addEventListener("blur", e=>{
        const val = Number(e.target.value);
        state.natashaManual = isNaN(val) ? null : val;
        renderTotals();
    });
}

// ===== Об’єднання карток =====
function mergeSelectedWithNext() {
    const idx = state.clients.findIndex(c=>c.id===state.selectedClientId);
    if (idx<0 || idx===state.clients.length-1) { toast("Нема чого об’єднувати"); return; }
    const A = state.clients[idx], B = state.clients[idx+1];
    A.items.push(...B.items);
    A.actualPostPaidUah = (Number(A.actualPostPaidUah)||0) + (Number(B.actualPostPaidUah)||0);
    A.overCount += Number(B.overCount)||0;
    // Ім'я лишається від першої картки (A.name)
    state.clients.splice(idx+1,1);
    renderClients(); renderTotals();
}

// ===== Експорт CSV =====
function exportCSV() {
    const rows = [["client","track","weight_g","label_price_uah","client_price_uah","natasha"]];
    for (const c of state.clients)
        for (const it of c.items)
            rows.push([
                c.name||"",
                it.track||"",
                it.weightG??"",
                it.labelPriceUah??"",
                it.clientPriceUah??"",
                calcNatasha(it.weightG)
            ]);
    const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shipments.csv"; a.click();
}

// ===== Повідомлення для клієнта (4 рядки) =====
function buildClientMessage(client){
    const items = client.items || [];
    const count = items.filter(it => it.clientPriceUah!=null || it.labelPriceUah!=null).length;
    const totalLabel  = roundMoney(items.reduce((s,it)=> s + (Number(it.labelPriceUah)||0), 0));
    const totalClient = roundMoney(items.reduce((s,it)=> s + (Number(it.clientPriceUah)||0), 0));
    const savings     = roundMoney(totalLabel - totalClient);
    return [
        `Відправлень: ${count}`,
        `За тарифами Укрпошти: ${totalLabel} грн`,
        `До оплати: ${totalClient} грн`,
        `Чиста вигода: ${savings} грн`
    ].join("\n");
}

// ===== Кнопки =====
document.getElementById("btnParse").addEventListener("click", async ()=>{
    const file  = document.getElementById("pdfInput").files[0];
    const startEl = document.getElementById("startLabel");
    const endEl   = document.getElementById("endLabel");
    const start = Number(startEl.value)||1;
    const end   = Number(endEl.value)||Infinity;

    if (!file) { toast("Оберіть PDF"); return; }

    try {
        const parsedAll = await parseSinglePdf(file);
        const endIdx = Number.isFinite(end) ? end : parsedAll.length;
        let items = parsedAll.slice(start-1, endIdx);
        const id = uniqId();
        const fname = file.name.replace(/\.pdf$/i, "");
        state.clients.push({ id, name: fname, items, actualPostPaidUah: null, overCount: 0 });
        state.selectedClientId = id;

        // Обнуление полей после успешной обработки
        document.getElementById("pdfInput").value = "";
        startEl.value = "";
        endEl.value = "";

        renderClients(); renderTotals();
        toast(`Додано рядків: ${items.length}`);
    } catch (e) {
        console.error(e);
        toast(`Помилка обробки: ${e?.message||e}`);
    }
});

document.getElementById("btnAddManual").addEventListener("click", ()=>{
    const id = uniqId();
    const name = `Клієнт ${state.clients.length+1}`;
    state.clients.push({ id, name, items:[{track:"",weightG:null,labelPriceUah:null,clientPriceUah:null}], actualPostPaidUah:null, overCount:0 });
    state.selectedClientId = id;
    renderClients(); renderTotals();
    toast("Додано порожню картку");
});

document.getElementById("btnRecalc").addEventListener("click", ()=>{
    state.discounts.clientPct  = Number(document.getElementById("clientDiscountPct").value)||30;
    state.discounts.natashaPct = Number(document.getElementById("natashaDiscountPct").value)||20;
    for (const c of state.clients)
        for (const it of c.items)
            if (it.labelPriceUah!=null) it.clientPriceUah = clientPriceFor(it);
    renderClients(); renderTotals();
    toast("Перераховано");
});

document.getElementById("btnMergeNext").addEventListener("click", mergeSelectedWithNext);
document.getElementById("btnExport").addEventListener("click", exportCSV);

// Старт
renderClients();
renderTotals();
