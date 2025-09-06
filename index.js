/* =========================
   КОНСТАНТИ / СТАН / КУРСИ
   ========================= */

const RULES = {
    natasha: [
        { maxG: 289,  price: 0 },
        { maxG: 540,  price: 50 },
        { maxG: 1040, price: 100 },
        { maxG: Infinity, price: 150 }
    ],
    maxim: { smallG: 250, priceSmall: 10, priceLarge: 25 },
    over:  { priceMaxim: 20, priceClient: 70 },   // +20 для Максима, +70 до рахунку клієнта
    roundingMoney: 1,
    noDiscountUpToG: 259,
    smallTxnFeeUah: 20
};

const FX_DEFAULT = { UAH: 1, USD: 41.00, EUR: 44.00, GBP: 51.00 };

const state = {
    clients: [],  // {id,name,items:[...], overCount, actualPostPaidUah}
    selectedClientId: null,
    discounts: { clientPct: 30, natashaPct: 20 },
    natashaManual: null,
    nbuRates: { ...FX_DEFAULT },
    nbuRatesUpdatedAt: null
};

/* ===============
   УТІЛІТИ
   =============== */

function toast(msg){ const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2200); }
const uniqId = ()=> Date.now()+"-"+Math.random().toString(36).slice(2,7);
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
const roundMoney = (x, step=RULES.roundingMoney)=> Math.round((x??0)/step)*step;

/* ===============
   КУРС НБУ
   =============== */

async function refreshNbuRates(){
    try{
        const get = (code)=> fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${code}&json`, {cache:'no-store'})
            .then(r=>r.json()).then(a=>Number(a?.[0]?.rate));
        const [usd, eur, gbp] = await Promise.all([get('USD'),get('EUR'),get('GBP')]);
        if ([usd,eur,gbp].every(Number.isFinite)){
            state.nbuRates = { UAH:1, USD:usd, EUR:eur, GBP:gbp };
            state.nbuRatesUpdatedAt = new Date().toISOString();
            recalcAllClientPrices(); renderClients(); renderTotals();
            paintFxPanel();
            toast(`Курс НБУ оновлено: USD=${usd.toFixed(2)}, EUR=${eur.toFixed(2)}, GBP=${gbp.toFixed(2)}`);
        }
    }catch(e){ console.warn('NBU fetch failed', e); }
}
window.setNbuRates = (patch)=>{
    state.nbuRates = { ...state.nbuRates, ...patch };
    state.nbuRatesUpdatedAt = new Date().toISOString();
    recalcAllClientPrices(); renderClients(); renderTotals(); paintFxPanel();
};

function paintFxPanel(){
    const u = document.getElementById('fxUSD');
    const e = document.getElementById('fxEUR');
    const g = document.getElementById('fxGBP');
    const s = document.getElementById('fxStamp');
    if (!u) return;
    u.value = (state.nbuRates.USD ?? 0).toFixed(2);
    e.value = (state.nbuRates.EUR ?? 0).toFixed(2);
    g.value = (state.nbuRates.GBP ?? 0).toFixed(2);
    if (s) s.textContent = state.nbuRatesUpdatedAt ? `оновлено: ${new Date(state.nbuRatesUpdatedAt).toLocaleString()}` : '';
}

/* ===============
   ВАЛЮТИ / ЧИСЛА
   =============== */

function normCurrency(s){
    if (!s) return null;
    s = String(s).trim().toUpperCase();
    if (s==='₴'||s==='UAH'||/ГРН|ГРИВН/.test(s)) return 'UAH';
    if (s==='$'||s==='USD'||/ДОЛАР|ДОЛ\.?\s*США/.test(s)) return 'USD';
    if (s==='EUR'||s==='€'||/ЄВРО/.test(s)) return 'EUR';
    if (s==='GBP'||s==='£'||/ФУНТ|СТЕРЛИН|СТЕРЛІН/.test(s)) return 'GBP';
    return null;
}
function fxToUah(amount, currency){ const cur=normCurrency(currency); if(!Number.isFinite(amount)||!cur||!state.nbuRates[cur]) return null; return amount*state.nbuRates[cur]; }
function uahToUsd(amountUah){ const r=state.nbuRates.USD||FX_DEFAULT.USD; return amountUah/r; }
function parseNumberSmart(s){
    if (!s) return NaN; s=String(s).trim(); let t=s.replace(/[^\d.,]/g,''); if(!t) return NaN;
    const hasDot=t.includes('.'), hasComma=t.includes(',');
    if (hasDot&&hasComma){ if(t.indexOf(',')<t.indexOf('.')) t=t.replace(/,/g,''); else { t=t.replace(/\./g,''); t=t.replace(',', '.'); } }
    else if (hasComma) t=t.replace(',', '.');
    return Number(t);
}

/* =========================
   НАЛОГ США + ЦЕНА ДЛЯ КЛІЄНТА
   ========================= */

function computeUsTaxUah({ isUS, status, declaredValue, declaredCurrency }){
    if (!isUS) return 0;
    if (status === 'documents') return 0;

    if (!Number.isFinite(declaredValue) || !declaredCurrency) return null;
    const cur = normCurrency(declaredCurrency); if(!cur) return null;

    if (status === 'gift'){
        const usd = (cur==='USD') ? declaredValue
            : (cur==='UAH') ? uahToUsd(declaredValue)
                : (cur==='EUR'||cur==='GBP') ? (declaredValue * state.nbuRates[cur] / state.nbuRates.USD)
                    : null;
        if (!Number.isFinite(usd)) return null;
        if (usd <= 99) return 0;
    }

    const uah = (cur==='UAH') ? declaredValue : fxToUah(declaredValue, cur);
    if (!Number.isFinite(uah)) return null;
    return roundMoney(0.10 * uah);
}

function clientPriceFor(item){
    const label = Number(item.labelPriceUah);
    if (!Number.isFinite(label)) return null;

    const taxUah = computeUsTaxUah({
        isUS: !!item.isUS,
        status: item.status || 'unknown',
        declaredValue: Number(item.declaredValue),
        declaredCurrency: item.declaredCurrency
    });

    item.needAttention = !!(item.isUS && taxUah === null);

    const tax = Number.isFinite(taxUah) ? taxUah : 0;
    const baseUah = Math.max(0, label - tax);
    item.taxUah  = Number.isFinite(taxUah) ? taxUah : null;
    item.baseUah = baseUah;

    let postagePart;
    if (typeof item.weightG==="number" && item.weightG <= RULES.noDiscountUpToG){
        postagePart = baseUah + RULES.smallTxnFeeUah;
    } else {
        const disc = (state.discounts.clientPct ?? 30)/100;
        postagePart = baseUah * (1 - disc);
    }

    const total = roundMoney(postagePart + tax);
    item.savingsUah = Number.isFinite(label) ? roundMoney(label - total) : null;
    return total;
}
function recalcAllClientPrices(){
    for (const c of state.clients)
        for (const it of c.items)
            if (it.labelPriceUah!=null) it.clientPriceUah = clientPriceFor(it);
}

/* =========================
   PDF: ТЕКСТ / ГЕОМЕТРІЯ / ДЕТЕКТОРИ
   ========================= */

const RE_TRACK  = /\b([A-Z]{2})\s?(\d{3})\s?(\d{3})\s?(\d{3})\s?([A-Z]{2})\b/;
const RE_WEIGHT = /(\d+(?:[.,]\d+)?)\s?(?:kg|кг)\b/i;
const RE_PRICE  = /(\d[\d\s]*(?:[.,]\d{1,2})?)\s?(?:UAH|грн\.?|₴)/i;

function groupTextByLines(items){
    const rows=[], TOL=3;
    for (const it of items){
        let str=(it.str??'').replace(/\u00A0/g,' ').trim(); if(!str) continue;
        const y=Math.round(it.transform[5]);
        let row=rows.find(r=>Math.abs(r.y-y)<=TOL); if(!row){row={y,parts:[]}; rows.push(row);}
        row.parts.push({ x: it.transform[4], text:str });
    }
    rows.sort((a,b)=>b.y-a.y);
    return rows.map(r=>{ r.parts.sort((a,b)=>a.x-b.x); return r.parts.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(); });
}
function toNumber(s){ if(typeof s!=='string') return NaN; return parseNumberSmart(s); }

function extractShipmentsFromLines(lines){
    const blocks=[], tracks=[];
    for (let i=0;i<lines.length;i++){
        const L0=lines[i], L01=(i+1<lines.length)? (L0+' '+lines[i+1]) : L0;
        const m=L0.match(RE_TRACK) || L01.match(RE_TRACK);
        if (m){ const track=(m[1]+m[2]+m[3]+m[4]+m[5]).replace(/\s+/g,''); tracks.push({i,track}); }
    }
    for (let k=0;k<tracks.length;k++){
        const start=tracks[k].i, end=(k+1<tracks.length)? tracks[k+1].i-1 : lines.length-1;
        blocks.push({ start, end, track: tracks[k].track });
    }

    const results=[], seen=new Set();
    for (const b of blocks){
        const aroundStart=clamp(b.start-3,0,lines.length-1);
        const aroundEnd  =clamp(b.start+6,0,lines.length-1);
        let bestW=null, bestWdist=1e9, bestP=null, bestPdist=1e9;

        for (let j=aroundStart;j<=aroundEnd;j++){
            const line=lines[j];
            const w=line.match(RE_WEIGHT);
            if (w){ const val=Math.round(toNumber(w[1])*1000); const d=Math.abs(j-b.start); if(Number.isFinite(val)&&d<bestWdist){bestW=val; bestWdist=d;} }
            const p=line.match(RE_PRICE);
            if (p){ const val=toNumber(p[1]); const d=Math.abs(j-b.start); if(Number.isFinite(val)&&d<bestPdist){bestP=val; bestPdist=d;} }
        }

        const track=b.track; if (seen.has(track)) continue; seen.add(track);
        const labelPriceUah=bestP!=null?bestP:null;
        const weightG=(bestW!=null?bestW:null);
        const item={ track, weightG, labelPriceUah };
        item.clientPriceUah=(labelPriceUah!=null)?clientPriceFor(item):null;
        results.push(item);
    }
    return results;
}

/* --- Геометрія для чекбоксів --- */
function norm(s){ return (s||'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim(); }
function toXY(it, viewport){
    const M = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const x=M[4], y=M[5], h=Math.hypot(M[2],M[3])||Math.abs(M[3])||14; return {x,y,h};
}
function getElems(items, viewport){ return items.map(it=>{ const {x,y,h}=toXY(it,viewport); return {x,y,h,str:norm(it.str||'')}; }).filter(e=>e.str); }
function groupElemsToLines(elems,tolY=3){
    const rows=[]; for(const e of elems){ let r=rows.find(R=>Math.abs(R.y-e.y)<=tolY); if(!r){r={y:e.y,parts:[]}; rows.push(r);} r.parts.push(e); }
    rows.sort((a,b)=>b.y-a.y);
    return rows.map(r=>{ r.parts.sort((a,b)=>a.x-b.x); return {y:r.y,h:(r.parts[0]?.h||14),x:(r.parts[0]?.x||0), text:norm(r.parts.map(p=>p.str).join(' '))}; });
}
function findTrackElems(elems){
    const list=[]; for(const e of elems){ const m=e.str.match(RE_TRACK); if(m) list.push({y:e.y,track:(m[1]+m[2]+m[3]+m[4]+m[5]).replace(/\s+/g,'')}); }
    list.sort((a,b)=>b.y-a.y); return list;
}
function blocksByTracks(trackElems){
    const blocks=[]; for(let i=0;i<trackElems.length;i++){ const y=trackElems[i].y;
        const yTop=(i===0)?Infinity:(trackElems[i-1].y+y)/2; const yBot=(i===trackElems.length-1)?-Infinity:(y+trackElems[i+1].y)/2;
        blocks.push({track:trackElems[i].track,yTop,yBot});
    } return blocks;
}
const inBlock = (b)=>(e)=> e.y<=b.yTop && e.y>b.yBot;

/* --- чекбокси: 2 колонки --- */
const LABELS_LEFT  = [
    { key:'gift',      re:/\b(gift|подар(о|у)к|подарунок)\b/i },
    { key:'documents', re:/\b(documents?|документ(и|ы))\b/i },
    { key:'sale',      re:/(sale\s*of\s*goods|продаж[ау]\s+товар(ів|ов)|продажа\s+товаров)/i },
];
const LABELS_RIGHT = [
    { key:'sample',    re:/(commercial\s*sample|комерційн(ий|ый)\s+зразок|коммерч\.*\s*образец)/i },
    { key:'returned',  re:/(returned\s*goods|повернен(ня|ие)\s+товар(ів|ов))/i },
    { key:'mixed',     re:/(mixed\s*content|змішан(ий|ое)\s+вміст)/i },
];

const PX_SCALE = 3.2, RIGHT_PAD=14, X_SCAN=360, STEP_X=2, Y_ROW_PAD=0.8, BOX_K=0.9;

function rectDarkness(ctx,x,y,w,h){
    x=Math.max(0,Math.min(x,ctx.canvas.width-1));
    y=Math.max(0,Math.min(y,ctx.canvas.height-1));
    w=Math.max(1,Math.min(w,ctx.canvas.width-x));
    h=Math.max(1,Math.min(h,ctx.canvas.height-y));
    const d=ctx.getImageData(x,y,w,h).data; let dark=0, tot=w*h;
    for(let i=0;i<d.length;i+=4){ const l=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; if(l<150) dark++; }
    return dark/tot;
}
function findCommonCheckboxX(ctx, rows){
    const hAvg=Math.max(12,Math.round(rows.reduce((s,r)=>s+r.h,0)/rows.length));
    const size=Math.round(hAvg*BOX_K);
    const minXText=Math.min(...rows.map(r=>r.x));
    const xRight=Math.round(minXText - RIGHT_PAD - size);
    const xLeft=Math.max(0, xRight - X_SCAN);
    let bestX=xLeft, bestSum=-1;
    for(let x=xLeft;x<=xRight;x+=STEP_X){
        let sum=0; for(const r of rows){ const y=Math.round(r.y - size*Y_ROW_PAD); sum+=rectDarkness(ctx,x,y,size,size); }
        if(sum>bestSum){ bestSum=sum; bestX=x; }
    }
    return { x:bestX, size };
}
function categoryByCommonX(ctx, rows, colX, size){
    let best={key:null,score:-1};
    for(const r of rows){ const d=rectDarkness(ctx,colX,Math.round(r.y-size*Y_ROW_PAD),size,size); if(d>best.score) best={key:r.key,score:d}; }
    return best.key;
}
async function detectStatusByCheckboxes(page, viewport, blElems, pageCtx){
    const lines=groupElemsToLines(blElems);
    const rowsLeft=[], rowsRight=[];
    for(const ln of lines){
        const L=LABELS_LEFT.find(L=>L.re.test(ln.text)); if(L){ rowsLeft.push({x:ln.x,y:ln.y,h:ln.h,key:L.key}); continue; }
        const R=LABELS_RIGHT.find(R=>R.re.test(ln.text)); if(R){ rowsRight.push({x:ln.x,y:ln.y,h:ln.h,key:R.key}); continue; }
    }
    if(!rowsLeft.length && !rowsRight.length) return null;
    const ctx=pageCtx;
    let bestKey=null, flag=false;
    if(rowsLeft.length){ const {x:cx,size}=findCommonCheckboxX(ctx,rowsLeft); const k=categoryByCommonX(ctx,rowsLeft,cx,size); if(k){bestKey=k; flag=true;} }
    if(rowsRight.length){ const {x:cx2,size:s2}=findCommonCheckboxX(ctx,rowsRight); const k2=categoryByCommonX(ctx,rowsRight,cx2,s2); if(k2 && !flag){bestKey=k2;} }
    return bestKey;
}

/* --- країна + declared --- */
function detectCountryFromLines(blockLines){
    const t=blockLines.join(' \n ').toLowerCase();
    if (/\b(united\s*states|u\.s\.a\.?|usa|америк|штат[иів])\b/.test(t)) return {isUS:true, canon:'United States of America'};
    if (/\b(united\s*kingdom|u\.k\.|uk|great\s*britain|britain|велика|британ)\b/.test(t)) return {isUS:false, canon:'United Kingdom'};
    return {isUS:false, canon:'—'};
}
const DECL_ANCHOR = /(value(?:\s*and\s*currency)?|declared\s*value|customs\s*value|вартіст|вартість|валют[а-и])/i;
const CURRENCY_TOKEN = /\b(USD|UAH|EUR|GBP)\b|[$€£₴]|грн|гривн|долар|дол\.?\s*сша|євро|фунт/iu;
const NUM_TOKEN = /[0-9][\d\s.,]*/;
function currencyFromText(s){
    if (!s) return null;
    if (/\bUSD\b|[$]|долар|дол\.?\s*сша/i.test(s)) return 'USD';
    if (/\bUAH\b|₴|грн|гривн/i.test(s)) return 'UAH';
    if (/\bEUR\b|€|євро/i.test(s)) return 'EUR';
    if (/\bGBP\b|£|фунт|стерлін|стерлин/i.test(s)) return 'GBP';
    return null;
}
function detectDeclaredFromLines(blockLines){
    let windows=[];
    for(let i=0;i<blockLines.length;i++) if(DECL_ANCHOR.test(blockLines[i])) windows.push(...blockLines.slice(i, Math.min(blockLines.length,i+3)));
    if(!windows.length) windows=blockLines.slice();

    for(const line of windows){
        let m=new RegExp(NUM_TOKEN.source+"\\s*("+CURRENCY_TOKEN.source+")","iu").exec(line);
        if(m){ const val=parseNumberSmart(m[0]); const cur=currencyFromText(m[1])||currencyFromText(line); if(Number.isFinite(val)&&cur) return {value:val,cur}; }
        m=new RegExp("("+CURRENCY_TOKEN.source+")\\s*"+NUM_TOKEN.source,"iu").exec(line);
        if(m){ const after=line.slice(m.index+m[0].length); const num=(after.match(NUM_TOKEN)||[])[0]; const val=parseNumberSmart(num); const cur=currencyFromText(m[0])||currencyFromText(line); if(Number.isFinite(val)&&cur) return {value:val,cur}; }
    }
    for(let i=0;i<windows.length;i++){
        const a=windows[i], b=windows[i+1]||''; const numA=(a.match(NUM_TOKEN)||[])[0]; const numB=(b.match(NUM_TOKEN)||[])[0]; const curA=currencyFromText(a); const curB=currencyFromText(b);
        if(numA && curB){ const val=parseNumberSmart(numA); if(Number.isFinite(val)) return {value:val,cur:curB}; }
        if(curA && numB){ const val=parseNumberSmart(numB); if(Number.isFinite(val)) return {value:val,cur:curA}; }
    }
    const big=blockLines.join(' \n ');
    let m=new RegExp(NUM_TOKEN.source+"\\s*("+CURRENCY_TOKEN.source+")","iu").exec(big);
    if(m){ const val=parseNumberSmart(m[0]); const cur=currencyFromText(m[1])||currencyFromText(big); if(Number.isFinite(val)&&cur) return {value:val,cur}; }
    m=new RegExp("("+CURRENCY_TOKEN.source+")\\s*"+NUM_TOKEN.source,"iu").exec(big);
    if(m){ const after=big.slice(m.index+m[0].length); const num=(after.match(NUM_TOKEN)||[])[0]; const val=parseNumberSmart(num); const cur=currencyFromText(m[0])||currencyFromText(big); if(Number.isFinite(val)&&cur) return {value:val,cur}; }
    return {value:null,cur:null};
}

/* =========================
   ПАРСИНГ PDF
   ========================= */

async function parseSinglePdf(file){
    const arrBuf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrBuf }).promise;
    const shipments = [];

    for (let p=1; p<=pdf.numPages; p++){
        try{
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const lines = groupTextByLines(content.items);

            const viewport = page.getViewport({ scale: PX_SCALE });
            const elems = getElems(content.items, viewport);
            const trackElems = findTrackElems(elems); if(!trackElems.length) continue;
            const blocksGeo = blocksByTracks(trackElems);

            const found = extractShipmentsFromLines(lines);

            // render page once
            const canvas=document.createElement('canvas');
            canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
            const ctx=canvas.getContext('2d', {willReadFrequently:true});
            await page.render({ canvasContext: ctx, viewport }).promise;

            const count=Math.min(found.length, blocksGeo.length);
            for(let i=0;i<count;i++){
                const b=blocksGeo[i];
                const blElems=elems.filter(inBlock(b));
                const blLinesText=groupElemsToLines(blElems).map(l=>l.text);

                const { isUS, canon } = detectCountryFromLines(blLinesText);
                let status = await detectStatusByCheckboxes(page, viewport, blElems, ctx);
                if (!status){
                    const low=blLinesText.join(' \n ').toLowerCase();
                    if (/\bgift|подар(о|у)к|подарунок\b/.test(low)) status='gift';
                    else if (/\bdocuments?|документ(и|ы)\b/.test(low)) status='documents';
                    else status='other';
                }
                const { value:declVal, cur:declCur } = detectDeclaredFromLines(blLinesText);

                const item=found[i];
                item.countryCanon=canon;
                item.isUS=isUS;
                item.status=status;           // gift/documents/sale/sample/returned/mixed/other
                item.declaredValue=declVal;
                item.declaredCurrency=declCur;
                item.clientPriceUah=clientPriceFor(item);

                shipments.push(item);
            }
        }catch(e){ console.warn('Skip page', p, e); }
    }
    return shipments;
}

/* =========================
   РЕНДЕР І ЛОГІКА UI
   ========================= */

const clientsEl = document.getElementById('clients');

function renderClients(){
    clientsEl.innerHTML='';
    state.clients.forEach((c,idx)=>{
        const sec=document.createElement('section'); sec.className='card'; sec.dataset.id=c.id;
        const needsPost=needsActualPost(c); sec.style.borderColor = needsPost ? '#ff6b6b' : '';

        sec.innerHTML = `
      <div class="row" style="justify-content:space-between;cursor:pointer" data-act="select-card">
        <div><b>${c.name}</b> <span class="pill">#${idx+1}</span></div>
        <div class="row" style="cursor:auto">
          <label>Фактична оплата за пошту (грн)</label>
          <input type="number" min="0" step="1" value="${c.actualPostPaidUah ?? ''}" data-act="actual-post" style="width:120px" />
          <label>Перевіси</label>
          <select data-act="over-sel">${[...Array(11).keys()].map(n=>`<option value="${n}" ${c.overCount===n?'selected':''}>${n}</option>`).join('')}</select>
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
              <th>США</th>
              <th>Вага (г)</th>
              <th>Declared</th>
              <th>Статус</th>
              <th>Ціна за наклейкою (грн)</th>
              <th>До оплати (грн)</th>
              <th>Економія (грн)</th>
              <th>Наталі</th>
              <th>Мал/Вел</th>
              <th class="right">Дія</th>
            </tr>
          </thead>
          <tbody>${c.items.map((it,i)=>renderRow(it,i)).join('')}</tbody>
        </table>
      </div>
    `;
        clientsEl.appendChild(sec);

        sec.addEventListener('click',(e)=>{
            const t=e.target; if(!(t instanceof HTMLElement)) return;
            if (t.dataset.act==='select-card' || t.closest("[data-act='select-card']")){ state.selectedClientId=c.id; highlightSelection(); }
            if (t.dataset.act==='delete-card'){ if(confirm('Видалити картку?')){ const pos=state.clients.findIndex(x=>x.id===c.id); if(pos>=0) state.clients.splice(pos,1); renderClients(); renderTotals(); } return; }
            if (t.dataset.act==='add-row'){ c.items.push({track:'',weightG:null,labelPriceUah:null,clientPriceUah:null}); renderClients(); renderTotals(); return; }
            if (t.dataset.act==='copy-client'){ const msg=buildClientMessage(c); navigator.clipboard.writeText(msg); toast('Повідомлення скопійовано'); return; }

            const tr=t.closest('tr'); if(!tr) return;
            if (t.dataset.act==='row-del'){ const i=Number(tr.dataset.idx); c.items.splice(i,1); renderClients(); renderTotals(); return; }
            if (t.dataset.act==='row-edit'){ const i=Number(tr.dataset.idx); editRowInline(tr,c.items[i],c); return; }
        });

        sec.querySelectorAll("[data-act='actual-post']").forEach(inp=>{
            inp.addEventListener('input', e=>{ const val=e.target.value; c.actualPostPaidUah = val==="" ? null : Number(val); sec.style.borderColor=needsActualPost(c)?'#ff6b6b':''; renderTotals(); });
        });
        sec.querySelectorAll("[data-act='over-sel']").forEach(sel=>{
            sel.addEventListener('change', e=>{ c.overCount = Number(e.target.value)||0; renderTotals(); });
        });
    });
    highlightSelection();
}

function renderRow(it, i){
    const isSmall = typeof it.weightG==="number" && it.weightG <= RULES.maxim.smallG;
    const natasha = calcNatasha(it.weightG);

    const usMark = it.isUS ? '✓' : '—';
    const declaredTxt = (()=>{ const val=it.declaredValue,cur=it.declaredCurrency; const warn=(it.needAttention?` <span style="color:#d00;font-weight:700">ПОТРІБНА ПЕРЕВІРКА</span>`:''); if(val==null||!cur) return `<span class="mut">нема</span>${warn}`; return `${val} ${cur}${warn}`; })();
    const statusTxt = (it.status ? it.status.toUpperCase() : '<span class="mut">—</span>');
    const savings = (Number.isFinite(it.labelPriceUah) && Number.isFinite(it.clientPriceUah)) ? (roundMoney(it.labelPriceUah - it.clientPriceUah)) : '<span class="mut">нема</span>';

    const needRowAlert = !!(it.isUS && (it.status || 'unknown') !== 'sale');
    const rowClass = [ (!it.track || it.labelPriceUah==null) ? 'warn':'' , needRowAlert ? 'row-alert':'' ].join(' ').trim();

    return `
    <tr data-idx="${i}" class="${rowClass}">
      <td>${i+1}</td>
      <td>${it.track || '<span class="mut">нема</span>'}</td>
      <td>${usMark}</td>
      <td>${it.weightG ?? '<span class="mut">нема</span>'}</td>
      <td>${declaredTxt}</td>
      <td>${statusTxt}</td>
      <td>${it.labelPriceUah ?? '<span class="mut">нема</span>'}</td>
      <td>${it.clientPriceUah ?? '<span class="mut">нема</span>'}</td>
      <td>${savings}</td>
      <td>${natasha}</td>
      <td>${isSmall ? 'Мал' : 'Вел'}</td>
      <td class="right">
        <button data-act="row-edit">Редагувати</button>
        <button data-act="row-del">Видалити</button>
      </td>
    </tr>
  `;
}

function editRowInline(tr,it,client){
    tr.innerHTML = `
    <td></td>
    <td><input value="${it.track||''}" data-f="track" /></td>
    <td class="mut">(авто)</td>
    <td><input type="number" value="${it.weightG??''}" data-f="weightG" /></td>
    <td>
      <input type="text" value="${it.declaredValue ?? ''}" data-f="declv" style="width:90px" />
      <select data-f="declc" style="width:70px">${['','USD','UAH','EUR','GBP'].map(c=>`<option value="${c}" ${it.declaredCurrency===c?'selected':''}>${c||'вал.'}</option>`).join('')}</select>
    </td>
    <td class="mut">(авто)</td>
    <td><input type="number" step="0.01" value="${it.labelPriceUah??''}" data-f="labelPriceUah" /></td>
    <td class="mut">(авто)</td>
    <td class="mut">(авто)</td>
    <td class="mut">(розрах.)</td>
    <td class="mut">(мал/вел)</td>
    <td class="right"><button data-act="row-save">Зберегти</button></td>
  `;
    tr.querySelector("[data-act='row-save']").addEventListener('click', ()=>{
        const get=f=>tr.querySelector(`[data-f='${f}']`);
        it.track = get('track').value.trim();
        it.weightG = get('weightG').value ? Number(get('weightG').value) : null;
        const declRaw=get('declv').value; it.declaredValue = declRaw ? parseNumberSmart(declRaw) : null;
        it.declaredCurrency = get('declc').value || null;
        it.labelPriceUah = get('labelPriceUah').value ? Number(get('labelPriceUah').value) : null;
        it.clientPriceUah = (it.labelPriceUah!=null) ? clientPriceFor(it) : null;
        renderClients(); renderTotals();
    });
}

function highlightSelection(){
    document.querySelectorAll("#clients .card").forEach(sec=>{
        sec.classList.toggle('outline', sec.dataset.id===String(state.selectedClientId));
    });
}

/* =========================
   ПІДСУМКИ / АГРЕГАТИ
   ========================= */

function calcNatasha(weightG){ if(typeof weightG!=='number'||Number.isNaN(weightG)) return 0; for(const r of RULES.natasha) if(weightG<=r.maxG) return r.price; return 0; }
function needsActualPost(c){ const hasRows=(c.items&&c.items.length>0); const val=Number(c.actualPostPaidUah); const entered=Number.isFinite(val)&&val>0; return hasRows && !entered; }
function anyClientMissingPost(){ return state.clients.some(needsActualPost); }

function aggregate() {
    let natashaFull=0, cntSmall=0, cntLarge=0, cntOver=0;
    let clientsSum=0, postFact=0, overServices=0;

    for (const c of state.clients) {
        postFact += Number(c.actualPostPaidUah)||0;

        const overCnt = Number(c.overCount)||0;
        cntOver += overCnt;

        // клиентская доплата за перевіс (идет в Сума клієнтів)
        overServices += overCnt * (RULES.over.priceClient || 0);

        for (const it of c.items) {
            if (it.clientPriceUah != null) clientsSum += it.clientPriceUah;
            natashaFull += calcNatasha(it.weightG);
            if (typeof it.weightG === "number") {
                if (it.weightG <= RULES.maxim.smallG) cntSmall++; else cntLarge++;
            }
        }
    }

    // Максим: только +20 за перевіс
    const maxim = cntSmall*RULES.maxim.priceSmall
        + cntLarge*RULES.maxim.priceLarge
        + cntOver*RULES.over.priceMaxim;

    // клиентская доплата за перевіс прибавляется к сумме клиентов
    clientsSum += overServices;

    const natashaPayAuto = roundMoney(natashaFull * (1 - (state.discounts.natashaPct ?? 20)/100));
    const natashaPay = (typeof state.natashaManual === "number" && !isNaN(state.natashaManual))
        ? state.natashaManual : natashaPayAuto;

    const finalProfit = roundMoney((clientsSum - postFact - natashaPay - maxim) / 2);

    return {
        clientsSum: roundMoney(clientsSum),
        postFact: roundMoney(postFact),
        natashaFull: roundMoney(natashaFull),
        natashaPay, maxim, finalProfit,
        cntSmall, cntLarge, cntOver,
        natashaPayAuto,
        overServices: roundMoney(overServices)
    };
}

function renderTotals(){
    const t=aggregate(); const box=document.getElementById('totals'); if(!box) return;
    const missing=anyClientMissingPost(); const profitClass = missing ? 'bad' : (t.finalProfit>=0?'ok':'bad');

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
      <div><label>Максим</label><div>${t.maxim} <span class="mut">(${t.cntSmall} мал / ${t.cntLarge} вел / перевіс ${t.cntOver})</span></div>
    </div>
  `;
    const nm=document.getElementById('natashaManual');
    if (nm){
        nm.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const v=Number(e.target.value); state.natashaManual=isNaN(v)?null:v; renderTotals(); }});
        nm.addEventListener('blur',e=>{ const v=Number(e.target.value); state.natashaManual=isNaN(v)?null:v; renderTotals(); });
    }
}

/* =========================
   ЕКСПОРТ / ПОВІДОМЛЕННЯ
   ========================= */

function exportCSV(){
    const rows=[["client","track","weight_g","country","is_us","status","declared_value","declared_currency","label_price_uah","tax_uah","base_uah","client_price_uah","savings_uah","natasha"]];
    for (const c of state.clients)
        for (const it of c.items)
            rows.push([ c.name||"", it.track||"", it.weightG??"", it.countryCanon||"", it.isUS?1:0, it.status||"", it.declaredValue??"", it.declaredCurrency||"", it.labelPriceUah??"", it.taxUah??"", it.baseUah??"", it.clientPriceUah??"", it.savingsUah??"", calcNatasha(it.weightG) ]);
    const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8"}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='shipments.csv'; a.click();
}
function buildClientMessage(client){
    const items = client.items || [];

    // позиционные суммы
    const totalLabel  = roundMoney(items.reduce((s,it)=> s + (Number(it.labelPriceUah)||0), 0));
    const totalClientBase = roundMoney(items.reduce((s,it)=> s + (Number(it.clientPriceUah)||0), 0));

    // доплата за перевіс входит в «До оплати», но не выводится отдельной строкой
    const overCnt  = Number(client.overCount)||0;
    const overAdd  = roundMoney(overCnt * (RULES.over.priceClient || 0));
    const totalClient = roundMoney(totalClientBase + overAdd);

    const count = items.filter(it => it.clientPriceUah!=null || it.labelPriceUah!=null).length;
    const savings = roundMoney(totalLabel - totalClient);

    return [
        `Відправлень: ${count}`,
        `За тарифами Укрпошти: ${totalLabel} грн`,
        `До оплати: ${totalClient} грн`,
        `Чиста вигода: ${savings} грн`
    ].join("\n");
}

/* =========================
   КНОПКИ / СТАРТ
   ========================= */

document.getElementById('btnParse').addEventListener('click', async ()=>{
    const file=document.getElementById('pdfInput').files[0];
    const startEl=document.getElementById('startLabel'); const endEl=document.getElementById('endLabel');
    const start=Number(startEl.value)||1; const end=Number(endEl.value)||Infinity;
    if(!file){ toast('Оберіть PDF'); return; }
    try{
        const parsedAll=await parseSinglePdf(file);
        const endIdx=Number.isFinite(end)? end : parsedAll.length;
        const items=parsedAll.slice(start-1,endIdx);
        const id=uniqId(); const fname=file.name.replace(/\.pdf$/i,'');
        state.clients.push({ id, name: fname, items, actualPostPaidUah:null, overCount:0 });
        state.selectedClientId=id;
        document.getElementById('pdfInput').value=""; startEl.value=""; endEl.value="";
        renderClients(); renderTotals();
        toast(`Додано рядків: ${items.length}`);
    }catch(e){ console.error(e); toast(`Помилка обробки: ${e?.message||e}`); }
});

document.getElementById('btnAddManual').addEventListener('click', ()=>{
    const id=uniqId(); const name=`Клієнт ${state.clients.length+1}`;
    state.clients.push({ id, name, items:[{track:'',weightG:null,labelPriceUah:null,clientPriceUah:null}], actualPostPaidUah:null, overCount:0 });
    state.selectedClientId=id; renderClients(); renderTotals(); toast('Додано порожню картку');
});
document.getElementById('btnMergeNext').addEventListener('click', ()=>{
    const idx=state.clients.findIndex(c=>c.id===state.selectedClientId);
    if (idx<0 || idx===state.clients.length-1){ toast('Нема чого об’єднувати'); return; }
    const A=state.clients[idx], B=state.clients[idx+1];
    A.items.push(...B.items); A.actualPostPaidUah=(Number(A.actualPostPaidUah)||0)+(Number(B.actualPostPaidUah)||0); A.overCount += Number(B.overCount)||0;
    state.clients.splice(idx+1,1); renderClients(); renderTotals();
});
document.getElementById('btnExport').addEventListener('click', exportCSV);

document.getElementById('btnRecalc').addEventListener('click', ()=>{
    state.discounts.clientPct = Number(document.getElementById('clientDiscountPct').value)||30;
    state.discounts.natashaPct = Number(document.getElementById('natashaDiscountPct').value)||20;
    recalcAllClientPrices(); renderClients(); renderTotals(); toast('Перераховано');
});

document.getElementById('fxApply').addEventListener('click', ()=>{
    const usd=Number(document.getElementById('fxUSD').value);
    const eur=Number(document.getElementById('fxEUR').value);
    const gbp=Number(document.getElementById('fxGBP').value);
    const patch={}; if(Number.isFinite(usd)&&usd>0) patch.USD=usd; if(Number.isFinite(eur)&&eur>0) patch.EUR=eur; if(Number.isFinite(gbp)&&gbp>0) patch.GBP=gbp;
    window.setNbuRates(patch); toast('Курс застосовано');
});
document.getElementById('fxRefresh').addEventListener('click', async ()=>{ await refreshNbuRates(); });

function renderInit(){ renderClients(); renderTotals(); paintFxPanel(); }
refreshNbuRates(); // асинхронно підтягне курс і перемалює
renderInit();
