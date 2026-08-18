// «Мини-сервер» Albion Craft Profit: собирает цены с Albion Online Data Project
// и складывает компактный снимок в data.json. Запускается GitHub Actions по расписанию.
// Требует Node 18+ (глобальный fetch). Зависимостей нет.
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://europe.albion-online-data.com/api/v2/stats';
const CITIES = ['Martlock','Bridgewatch','Lymhurst','Fort Sterling','Thetford','Caerleon','Brecilien'];
const CITY_IDX = Object.fromEntries(CITIES.map((c,i)=>[c,i]));
const HIST_DAYS = 7;
// API и так отдаёт 30 суточных точек — раньше мы выбрасывали всё старше недели.
// Теперь считаем по ним «обычную цену» предмета: медиану, которую всплеск не сдвигает.
const BASE_DAYS = 30;
// Окно «стабильности»: за сколько последних суток мы храним ход цены, чтобы сайт мог
// сказать «прибыльно 18 дней из 21», а не только «прибыльно прямо сейчас».
const TREND_DAYS = 21;
// Меньше этого числа дней с торгами ряд не сохраняем: на трёх точках «стабильность»
// — это не вывод, а совпадение, и место в снимке она занимает зря.
const TREND_MIN_DAYS = 5;
const PRICE_BATCH = 80;
const HIST_BATCH = 25;
const DELAY_MS = 120;
const RETRIES = 5;
const CONCURRENCY = 2;
// Лимиты Albion Online Data Project из их документации: 180 запросов в минуту
// и 300 за 5 минут. Берём с запасом — сбор идёт чуть дольше, зато без отказов.
const RL_PER_MIN = 165;
const RL_PER_5MIN = 285;

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const chunks = (a,n) => { const o=[]; for(let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; };
const minutes = iso => Math.round(new Date(iso+'Z').getTime()/6e4); // epoch-минуты
const nowMin = () => Math.round(Date.now()/6e4);
const dayIdx = iso => Math.floor(new Date(iso+'Z').getTime()/864e5);  // номер суток от эпохи
const todayIdx = () => Math.floor(Date.now()/864e5);

// Копилка «предмет → сутки → цены». Цены по городам за один день потом сворачиваем
// в медиану: один город с задранным ордером не должен решать за всё королевство.
function pushDay(map, id, day, price){
  if(!(price>0)) return;
  const byDay = map.get(id) || map.set(id, new Map()).get(id);
  (byDay.get(day) || byDay.set(day, []).get(day)).push(price);
}
// «Обычная цена за месяц» — медиана суточных медиан за BASE_DAYS. Считается из тех же
// точек, что и тренд, поэтому не стоит ни одного лишнего запроса к API. Нужна там же,
// где и для предметов: отличить живую цену от одинокого задранного ордера.
function baseFrom(byDay){
  if(!byDay) return null;
  const last = todayIdx(); const arr = [];
  for(let i=0;i<BASE_DAYS;i++){
    const a = byDay.get(last - i); if(!a || !a.length) continue;
    const srt = [...a].sort((x,y)=>x-y);
    arr.push(srt[Math.floor(srt.length/2)]);
  }
  if(arr.length < 3) return null;                  // на двух точках медиана ничего не стоит
  arr.sort((a,b)=>a-b);
  return [Math.round(arr[Math.floor(arr.length/2)]), arr.length];
}
// Ряд за TREND_DAYS суток в ПРОЦЕНТАХ от самого свежего дня с данными.
// Проценты, а не цены: числа втрое короче (снимок и так 4.5 МБ), а стабильность
// считается по ходу цены, не по её величине. 0 — в этот день торгов не было.
function trendSeries(byDay){
  if(!byDay) return null;
  const last = todayIdx();
  const vals = new Array(TREND_DAYS).fill(0);
  let base = 0, days = 0;
  for(let i=0;i<TREND_DAYS;i++){
    const arr = byDay.get(last - (TREND_DAYS-1-i));
    if(!arr || !arr.length) continue;
    arr.sort((a,b)=>a-b);
    vals[i] = arr[Math.floor(arr.length/2)];
    base = vals[i]; days++;                       // база — последний известный день
  }
  if(days < TREND_MIN_DAYS || !base) return null;
  return vals.map(v => v>0 ? Math.round(v/base*100) : 0);
}

let okCount=0, failCount=0, waitedMs=0;

// Собственный ограничитель: не даём себе выйти за лимиты API ни в минутном,
// ни в пятиминутном окне. Считаем каждую попытку, включая ретраи.
const rlHits = [];
async function rateGate(){
  for(;;){
    const now = Date.now();
    while(rlHits.length && now - rlHits[0] >= 300000) rlHits.shift();
    const in5 = rlHits.length;
    let inMin = 0;
    for(let i=rlHits.length-1; i>=0 && now-rlHits[i] < 60000; i--) inMin++;
    if(inMin < RL_PER_MIN && in5 < RL_PER_5MIN){ rlHits.push(now); return; }
    // ждём, пока освободится ближайший слот в переполненном окне
    let wait = 250;
    if(inMin >= RL_PER_MIN) wait = Math.max(wait, 60000 - (now - rlHits[rlHits.length-inMin]) + 50);
    if(in5   >= RL_PER_5MIN) wait = Math.max(wait, 300000 - (now - rlHits[0]) + 50);
    waitedMs += wait;
    await sleep(wait);
  }
}

// очередь с ограниченной параллельностью + прогресс в лог
async function runPool(jobs, label){
  let done=0;
  const queue=[...jobs];
  const workers = Array.from({length:CONCURRENCY}, async ()=>{
    while(queue.length){
      const job = queue.shift();
      await job();
      done++;
      if(done % 20 === 0 || done===jobs.length) console.log(`  ${label}: ${done}/${jobs.length}`);
      await sleep(DELAY_MS);
    }
  });
  await Promise.all(workers);
}

async function getJSON(url){
  for(let attempt=1; attempt<=RETRIES; attempt++){
    try{
      await rateGate();
      const ctl = new AbortController();
      const timer = setTimeout(()=>ctl.abort(), 60000);
      const r = await fetch(url, {signal: ctl.signal, headers:{'User-Agent':'albion-craft-profit-builder'}});
      clearTimeout(timer);
      if(r.status===429 || r.status===403 || r.status>=500){
        const e=new Error('HTTP '+r.status); e.rate=true; throw e;
      }
      if(!r.ok) throw new Error('HTTP '+r.status);
      okCount++;
      return await r.json();
    }catch(e){
      if(attempt===RETRIES){ failCount++; console.warn('FAIL', e.message, url.slice(0,110)); return null; }
      await sleep((e.rate ? 4000 : 1500) * attempt); // лимит запросов — ждём дольше
    }
  }
  return null;
}

async function main(){
  const items = JSON.parse(await readFile(new URL('./items.json', import.meta.url)));
  const itemIds = items.items.map(i=>i.id);
  const matIds = [
    ...Object.keys(items.resval), ...(items.rawIds||[]),
    ...(items.extraMatIds||[]), ...(items.stoneIds||[]), ...(items.arts||[]),
    ...(items.consMatIds||[]), // ингредиенты алхимии и кухни: травы, яйца, хлеб, экстракты
  ];
  // Зелья и еда: чёрный рынок их не покупает (проверено: 1 мусорный ордер на 55 id),
  // поэтому им нужны только городские цены и объёмы — секции ЧР для них не запускаются.
  const consIds = (items.cons||[]).map(c=>c.id);
  // Журналы: и полные, и ПУСТЫЕ. Пустые тоже торгуются, и цена гуляет по городам
  // (T6 охотника: 4 292 в Лимхёрсте против 9 493 в Мартлоке) — фиксированной ценой
  // из справочника считать нельзя.
  const journalIds = items.journalIds || (()=>{
    const a=[]; for(const arch of ['WARRIOR','HUNTER','MAGE','TOOLMAKER'])
      for(const t of [4,5,6,7,8]) for(const s of ['EMPTY','FULL']) a.push(`T${t}_JOURNAL_${arch}_${s}`);
    return a;
  })();
  const refIds = (items.refining||[]).map(r=>r.id);

  const startedAt = Date.now();
  // t выставим в самом конце: сбор идёт несколько минут, и время старта делает снимок
  // на вид старше, чем он есть. Штамп ставим по факту готовности данных.
  const out = { t: 0, cities: CITIES, m:{}, c:{}, b:{}, h:{} };

  // 1) материалы, артефакты, полные журналы — обычное качество, все города
  const matAll = [...new Set([...matIds, ...journalIds])];
  console.log(`materials/artifacts/journals: ${matAll.length} ids`);
  await runPool(chunks(matAll, PRICE_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/prices/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent(CITIES.join(','))}&qualities=1`);
    for(const e of d||[]){
      const ci = CITY_IDX[e.city]; if(ci===undefined) continue;
      const sell = Math.round(e.sell_price_min||0), buy = Math.round(e.buy_price_max||0);
      if(!sell && !buy) continue;
      const rec = [sell, sell?minutes(e.sell_price_min_date):0];
      if(buy){ rec.push(buy, minutes(e.buy_price_max_date)); }
      (out.m[e.item_id] ||= {})[ci] = rec;
    }
  }), 'mats')

  // 2) цены предметов на городских рынках — все качества
  console.log(`item city prices: ${itemIds.length}+${consIds.length} ids`);
  await runPool(chunks([...itemIds, ...consIds], PRICE_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/prices/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent(CITIES.join(','))}`);
    for(const e of d||[]){
      const ci = CITY_IDX[e.city]; if(ci===undefined) continue;
      const q = e.quality||1;
      const sell = Math.round(e.sell_price_min||0), buy = Math.round(e.buy_price_max||0);
      if(!sell && !buy) continue;
      const rec = [sell, sell?minutes(e.sell_price_min_date):0];
      if(buy){ rec.push(buy, minutes(e.buy_price_max_date)); }
      (((out.c[e.item_id] ||= {})[ci] ||= {}))[q] = rec;
    }
  }), 'city-prices')

  // 3) история чёрного рынка: средняя сделок и объём/день по качествам
  console.log(`black market history: ${itemIds.length} ids`);
  const cutoff = Date.now() - HIST_DAYS*864e5;
  // посуточный ход цены ЧР — из тех же ответов, лишних запросов не делаем
  const bmDays = new Map(), bmAnyDays = new Map();
  await runPool(chunks(itemIds, HIST_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/history/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent('Black Market')}&time-scale=24`);
    for(const e of d||[]){
      const q = e.quality||1;
      let sum=0, cnt=0, vol=0, last=null;
      for(const p of e.data||[]){
        const t = new Date(p.timestamp+'Z').getTime();
        pushDay(q===1?bmDays:bmAnyDays, e.item_id, dayIdx(p.timestamp), p.avg_price);
        if(t < cutoff) continue;
        vol += p.item_count; sum += p.avg_price*p.item_count; cnt += p.item_count;
        if(!last || p.timestamp>last) last=p.timestamp;
      }
      // «обычная цена» за месяц и насколько она гуляет. Медиана и межквартильный
      // размах: всплеск в пару дней их почти не двигает, а ровную цену видно сразу.
      // СЧИТАЕМ ДО проверки на сделки этой недели. Иначе выходит ловушка: по качеству,
      // где торговля заглохла (например у клирики T5.2 «обычное» — последняя сделка
      // 10 дней назад, но до неё 20 дней и 993 штуки по ~61 400), запись выбрасывалась
      // целиком, месячная норма терялась, и задранный бай-ордер НПС в 138 930 шёл
      // в расчёт без всякой защиты — профит завышался вдвое.
      const baseCut = Date.now() - BASE_DAYS*864e5;
      const hist = (e.data||[]).filter(p=>new Date(p.timestamp+'Z').getTime()>=baseCut && p.avg_price>0)
                               .map(p=>p.avg_price).sort((a,b)=>a-b);
      let base=0, spread=0;
      if(hist.length){
        const at = f => hist[Math.min(hist.length-1, Math.max(0, Math.round(f*(hist.length-1))))];
        base = at(0.5);
        spread = base>0 ? Math.round((at(0.75)-at(0.25))/base*100) : 0;
      }
      if(!cnt && !hist.length) continue;   // за месяц вообще ни одной сделки — сохранять нечего
      // последняя суточная точка отдельно: средняя за неделю сильно врёт, когда цена ползёт
      let lastAvg = 0, lastT = 0;
      for(const p of e.data||[]){
        const t = new Date(p.timestamp+'Z').getTime();
        if(t < cutoff) continue;
        if(!lastT || t > lastT){ lastT = t; lastAvg = Math.round(p.avg_price); }
      }
      const rec = (out.b[e.item_id] ||= {q:{}, l:0});
      rec.q[q] = [cnt?Math.round(sum/cnt):0, Math.round(vol/HIST_DAYS*10)/10, lastAvg, lastT?Math.round(lastT/6e4):0,
                  Math.round(base), spread, hist.length];
      if(last){ const lm=minutes(last); if(lm>rec.l) rec.l=lm; }
    }
  }), 'bm-history')

  // 3b) ЖИВЫЕ БАЙ-ОРДЕРА ЧЁРНОГО РЫНКА — то, что реально заплатят прямо сейчас.
  // Это главная цена для канала «ЧР»: средняя сделок за 7 дней систематически
  // завышает выручку, а история к тому же отстаёт на 2-4 дня.
  console.log(`black market orders: ${itemIds.length} ids`);
  out.bo = {};
  await runPool(chunks(itemIds, PRICE_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/prices/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent('Black Market')}`);
    for(const e of d||[]){
      const q = e.quality||1;
      const buy = Math.round(e.buy_price_max||0);
      if(!buy) continue;
      (out.bo[e.item_id] ||= {})[q] = [buy, minutes(e.buy_price_max_date)];
    }
  }), 'bm-orders')

  // 4) объёмы продаж готовых ресурсов на городских рынках (вкладка «Переработка»)
  console.log(`refined resource volumes: ${refIds.length} ids`);
  await runPool(chunks(refIds, HIST_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/history/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent(CITIES.join(','))}&time-scale=24`);
    for(const e of d||[]){
      const ci = CITY_IDX[e.location]; if(ci===undefined) continue;
      let vol=0;
      for(const p of e.data||[]){
        if(new Date(p.timestamp+'Z').getTime() < cutoff) continue;
        vol += p.item_count;
      }
      if(!vol) continue;
      const rec = (out.h[e.item_id] ||= {});
      rec[ci] = Math.round(((rec[ci]||0) + vol/HIST_DAYS)*10)/10;
    }
  }), 'ref-volumes')

  // 5) объёмы продаж предметов на городских рынках (межгородской флип, канал «город»)
  //    Здесь же — «обычная цена по королевству»: медиана суточных сделок за 30 дней по всем
  //    городам сразу. Нужна, чтобы отличать живой селл-ордер от троллевого: минимальный ордер
  //    сам по себе ничего не значит, когда реальные продавцы разобраны (сумка мастера в
  //    Бресильене висела по 799 991 при рынке 50 000 и давала «мне за день 57 млн» из воздуха).
  console.log(`city market volumes: ${itemIds.length}+${consIds.length} ids`);
  out.ch = {}; out.cb = {};
  const cityDays = new Map();          // посуточный ход городской цены, обычное качество
  await runPool(chunks([...itemIds, ...consIds], HIST_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/history/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent(CITIES.join(','))}&time-scale=24`);
    const baseCut = Date.now() - BASE_DAYS*864e5;
    const acc = {};                                  // item|качество -> цены суток за месяц
    for(const e of d||[]){
      const ci = CITY_IDX[e.location]; if(ci===undefined) continue;
      const q = e.quality||1;
      let vol=0;
      for(const p of e.data||[]){
        const t = new Date(p.timestamp+'Z').getTime();
        if(t >= baseCut && p.avg_price>0) (acc[e.item_id+'|'+q] ||= []).push(p.avg_price);
        if(q===1) pushDay(cityDays, e.item_id, dayIdx(p.timestamp), p.avg_price);
        if(t < cutoff) continue;
        vol += p.item_count;
      }
      if(!vol) continue;
      const rec = ((out.ch[e.item_id] ||= {})[ci] ||= {});
      rec[q] = Math.round(((rec[q]||0) + vol/HIST_DAYS)*10)/10;
    }
    for(const [k, arr] of Object.entries(acc)){
      if(arr.length < 3) continue;                   // на двух точках медиана ничего не стоит
      arr.sort((a,b)=>a-b);
      const [id, q] = k.split('|');
      ((out.cb[id] ||= {}))[q] = [Math.round(arr[Math.floor(arr.length/2)]), arr.length];
    }
  }), 'city-volumes')

  // 6) посуточная история материалов: единственный новый блок запросов. Без него
  //    «стабильность» считалась бы по выручке при замороженной себестоимости —
  //    а дорожают обычно именно ресурсы, и как раз это съедает маржу.
  //    Пачки вдвое крупнее, чем у предметов: у материалов одно качество, ответ втрое
  //    легче, а каждый лишний запрос — это секунда общего времени сбора.
  console.log(`material history: ${matAll.length} ids`);
  const matDays = new Map();
  await runPool(chunks(matAll, HIST_BATCH*2).map(ch => async ()=>{
    const d = await getJSON(`${API}/history/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent(CITIES.join(','))}&time-scale=24`);
    for(const e of d||[]){
      if((e.quality||1)!==1) continue;
      for(const p of e.data||[]) pushDay(matDays, e.item_id, dayIdx(p.timestamp), p.avg_price);
    }
  }), 'mat-history')

  // ряды в снимок: проценты от последнего известного дня, окно TREND_DAYS
  out.td = TREND_DAYS;
  out.mh = {}; out.bh = {}; out.ih = {};
  out.mb = {};                                     // материал -> [обычная цена за месяц, дней]
  for(const [id, byDay] of matDays){
    const s = trendSeries(byDay); if(s) out.mh[id] = s;
    const b = baseFrom(byDay);    if(b) out.mb[id] = b;
  }
  for(const id of new Set([...bmDays.keys(), ...bmAnyDays.keys()])){
    const s = trendSeries(bmDays.get(id)) || trendSeries(bmAnyDays.get(id));
    if(s) out.bh[id] = s;
  }
  for(const [id, byDay] of cityDays){ const s = trendSeries(byDay); if(s) out.ih[id] = s; }
  console.log(`месячная норма материалов: ${Object.keys(out.mb).length}`);
  console.log(`тренды: материалы ${Object.keys(out.mh).length}, ЧР ${Object.keys(out.bh).length}, города ${Object.keys(out.ih).length}`);

  out.t = Math.round(Date.now()/1000);
  const json = JSON.stringify(out);
  const stats = {
    collectSec: Math.round((Date.now()-startedAt)/1000),
    materials: Object.keys(out.m).length,
    itemsWithCityPrices: Object.keys(out.c).length,
    itemsWithBM: Object.keys(out.b).length,
    itemsWithBMOrders: Object.keys(out.bo||{}).length,
    resourceVolumes: Object.keys(out.h).length,
    itemsWithCityVolumes: Object.keys(out.ch||{}).length,
    materialsWithBase: Object.keys(out.mb||{}).length,
    requestsOk: okCount, requestsFailed: failCount,
    rateWaitSec: Math.round(waitedMs/1000),
    sizeKB: Math.round(json.length/1024),
  };
  console.log('RESULT', JSON.stringify(stats));

  // защита от порчи данных: не перезаписываем хороший снимок мусором
  if(stats.itemsWithBM < 200 || stats.materials < 50){
    console.error('Слишком мало данных — снимок не сохранён (вероятно, API недоступен).');
    process.exit(1);
  }
  await writeFile(new URL('./data.json', import.meta.url), json);
  await writeFile(new URL('./data-stats.json', import.meta.url), JSON.stringify({...stats, builtAt:new Date().toISOString()}, null, 2));
  console.log('data.json записан:', stats.sizeKB, 'КБ');
}

main().catch(e=>{ console.error(e); process.exit(1); });
