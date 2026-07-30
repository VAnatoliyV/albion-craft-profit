// «Мини-сервер» Albion Craft Profit: собирает цены с Albion Online Data Project
// и складывает компактный снимок в data.json. Запускается GitHub Actions по расписанию.
// Требует Node 18+ (глобальный fetch). Зависимостей нет.
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://europe.albion-online-data.com/api/v2/stats';
const CITIES = ['Martlock','Bridgewatch','Lymhurst','Fort Sterling','Thetford','Caerleon','Brecilien'];
const CITY_IDX = Object.fromEntries(CITIES.map((c,i)=>[c,i]));
const HIST_DAYS = 7;
const PRICE_BATCH = 80;
const HIST_BATCH = 25;
const DELAY_MS = 350;
const RETRIES = 5;
const CONCURRENCY = 2;

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const chunks = (a,n) => { const o=[]; for(let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; };
const minutes = iso => Math.round(new Date(iso+'Z').getTime()/6e4); // epoch-минуты
const nowMin = () => Math.round(Date.now()/6e4);

let okCount=0, failCount=0;

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
  ];
  const journalIds = [];
  for(const arch of ['WARRIOR','HUNTER','MAGE','TOOLMAKER'])
    for(const t of [4,5,6,7,8]) journalIds.push(`T${t}_JOURNAL_${arch}_FULL`);
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
  console.log(`item city prices: ${itemIds.length} ids`);
  await runPool(chunks(itemIds, PRICE_BATCH).map(ch => async ()=>{
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
  await runPool(chunks(itemIds, HIST_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/history/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent('Black Market')}&time-scale=24`);
    for(const e of d||[]){
      const q = e.quality||1;
      let sum=0, cnt=0, vol=0, last=null;
      for(const p of e.data||[]){
        const t = new Date(p.timestamp+'Z').getTime();
        if(t < cutoff) continue;
        vol += p.item_count; sum += p.avg_price*p.item_count; cnt += p.item_count;
        if(!last || p.timestamp>last) last=p.timestamp;
      }
      if(!cnt) continue;
      const rec = (out.b[e.item_id] ||= {q:{}, l:0});
      rec.q[q] = [Math.round(sum/cnt), Math.round(vol/HIST_DAYS*10)/10];
      if(last){ const lm=minutes(last); if(lm>rec.l) rec.l=lm; }
    }
  }), 'bm-history')

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
  console.log(`city market volumes: ${itemIds.length} ids`);
  out.ch = {};
  await runPool(chunks(itemIds, HIST_BATCH).map(ch => async ()=>{
    const d = await getJSON(`${API}/history/${encodeURIComponent(ch.join(','))}.json?locations=${encodeURIComponent(CITIES.join(','))}&time-scale=24`);
    for(const e of d||[]){
      const ci = CITY_IDX[e.location]; if(ci===undefined) continue;
      const q = e.quality||1;
      let vol=0;
      for(const p of e.data||[]){
        if(new Date(p.timestamp+'Z').getTime() < cutoff) continue;
        vol += p.item_count;
      }
      if(!vol) continue;
      const rec = ((out.ch[e.item_id] ||= {})[ci] ||= {});
      rec[q] = Math.round(((rec[q]||0) + vol/HIST_DAYS)*10)/10;
    }
  }), 'city-volumes')

  out.t = Math.round(Date.now()/1000);
  const json = JSON.stringify(out);
  const stats = {
    collectSec: Math.round((Date.now()-startedAt)/1000),
    materials: Object.keys(out.m).length,
    itemsWithCityPrices: Object.keys(out.c).length,
    itemsWithBM: Object.keys(out.b).length,
    resourceVolumes: Object.keys(out.h).length,
    itemsWithCityVolumes: Object.keys(out.ch||{}).length,
    requestsOk: okCount, requestsFailed: failCount,
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
