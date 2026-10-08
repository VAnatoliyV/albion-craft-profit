// Ядро карты Авалона: чистые функции без DOM. Подключается сайтом обычным
// <script>, а тестами — через require (test/avalon-core.test.js).
(function(g){
  const key=(a,b)=> a<b ? a+'|'+b : b+'|'+a;

  function merge(state, d){
    const s = d.full ? new Map() : new Map(state);
    for(const k of d.gone||[]) s.delete(k);
    for(const l of d.links||[]) s.set(key(l.a,l.b), l);
    return s;
  }

  function path(links, from, to, onlyConfirmed){
    if(from===to) return [from];
    const adj=new Map();
    const add=(x,y)=>{ if(!adj.has(x)) adj.set(x,[]); adj.get(x).push(y); };
    for(const l of links){ if(onlyConfirmed && !l.confirmed) continue; add(l.a,l.b); add(l.b,l.a); }
    const prev=new Map([[from,null]]), q=[from];
    while(q.length){
      const x=q.shift();
      for(const y of adj.get(x)||[]){
        if(prev.has(y)) continue;
        prev.set(y,x);
        if(y===to){ const p=[y]; let c=x; while(c!==null){ p.push(c); c=prev.get(c); } return p.reverse(); }
        q.push(y);
      }
    }
    return null;
  }

  // Псевдослучайность с зерном: одна и та же сеть раскладывается одинаково.
  function rnd(seed){ let s=seed>>>0||1; return ()=>((s=Math.imul(s^s>>>15, 2246822507)^Math.imul(s^s>>>13,3266489909))>>>0)/4294967296; }

  // Ближайшая точка отрезка a–b к точке p: доля t вдоль отрезка и расстояние.
  function toSeg(p, a, b){
    const dx=b.x-a.x, dy=b.y-a.y, l2=dx*dx+dy*dy;
    const t=l2 ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)) : 0;
    const qx=a.x+t*dx, qy=a.y+t*dy;
    return {t, d:Math.hypot(p.x-qx, p.y-qy), qx, qy, dx, dy};
  }
  // Направление «от линии к узлу»; если узел ровно на линии — перпендикуляр.
  function away(p, s){
    let nx=p.x-s.qx, ny=p.y-s.qy, n=Math.hypot(nx,ny);
    if(n<1e-6){ nx=-s.dy; ny=s.dx; n=Math.hypot(nx,ny)||1; }
    return {x:nx/n, y:ny/n};
  }

  // До стольких узлов карту раскладываем заново на каждой смене связей:
  // это быстро и даёт чистую картинку. Большие карты держатся за прежние
  // места, иначе при каждом обновлении всё прыгает.
  const COLD=80, GAP=40;
  // Быстрый отсев: точка далеко от прямоугольника ребра — считать нечего.
  const outBox=(p,a,b,g)=>p.x<Math.min(a.x,b.x)-g || p.x>Math.max(a.x,b.x)+g || p.y<Math.min(a.y,b.y)-g || p.y>Math.max(a.y,b.y)+g;

  // Силовая раскладка: рёбра тянут, узлы расталкиваются, а чужие рёбра
  // отталкивают узел — иначе линия идёт прямо через зону, которой она не
  // касается, и кажется, что дорога ведёт через неё.
  function layout(nodes, edges, prev, seed){
    if(nodes.length<=COLD) prev=new Map();
    // list[i] всегда соответствует nodes[i]: по этой нумерации идут и силы,
    // и итог. Сначала ставим известные узлы, потом новые рядом с соседом.
    const R=rnd(seed), list=new Array(nodes.length), at=new Map(nodes.map((n,i)=>[n,i]));
    nodes.forEach((n,i)=>{ if(prev.has(n)){ const p=prev.get(n); list[i]={x:p.x,y:p.y,ax:p.x,ay:p.y}; } });
    nodes.forEach((n,i)=>{
      if(list[i]) return;
      const nb=edges.find(e=>(e[0]===n&&list[at.get(e[1])])||(e[1]===n&&list[at.get(e[0])]));
      const o=nb ? list[at.get(nb[0]===n?nb[1]:nb[0])] : {x:0,y:0};
      list[i]={x:o.x+(R()-.5)*80, y:o.y+(R()-.5)*80, ax:null, ay:null};
    });
    const E=[];
    for(const [a,b] of edges){ const i=at.get(a), j=at.get(b); if(i!=null&&j!=null&&i!==j) E.push([i,j]); }
    // Длина ребра побольше на маленькой карте: между узлами помещается подпись.
    const rest=nodes.length<=COLD ? 100 : 70;
    // Тёплый старт: если есть прежние позиции, сеть уже устоялась — мало шагов,
    // низкая температура и жёсткая привязка, чтобы карта не прыгала.
    const warm=list.some(p=>p.ax!==null), iters=warm?80:300, t0=warm?0.04:1, pull=warm?1.0:0.3;
    for(let it=0; it<iters; it++){
      const f=list.map(()=>({x:0,y:0}));
      for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++){
        let dx=list[i].x-list[j].x, dy=list[i].y-list[j].y, d2=dx*dx+dy*dy+0.01;
        if(d2>250000) continue;
        const k=2400/d2; f[i].x+=dx*k; f[i].y+=dy*k; f[j].x-=dx*k; f[j].y-=dy*k;
      }
      for(const [i,j] of E){
        const dx=list[j].x-list[i].x, dy=list[j].y-list[i].y, d=Math.hypot(dx,dy)||1, k=(d-rest)*0.04;
        f[i].x+=dx/d*k*d/10; f[i].y+=dy/d*k*d/10; f[j].x-=dx/d*k*d/10; f[j].y-=dy/d*k*d/10;
      }
      // Чужое ребро ближе GAP — узел отходит по нормали, концы ребра в другую сторону.
      if(it>iters/3) for(let k=0;k<list.length;k++) for(const [i,j] of E){
        if(k===i||k===j || outBox(list[k],list[i],list[j],GAP)) continue;
        const p=list[k], s=toSeg(p, list[i], list[j]); if(s.d>=GAP) continue;
        const n=away(p,s), push=(GAP-s.d)*0.6;
        f[k].x+=n.x*push; f[k].y+=n.y*push;
        f[i].x-=n.x*push*(1-s.t)*0.5; f[i].y-=n.y*push*(1-s.t)*0.5;
        f[j].x-=n.x*push*s.t*0.5; f[j].y-=n.y*push*s.t*0.5;
      }
      const t=t0*(1-it/iters);
      list.forEach((p,i)=>{
        if(p.ax!==null){ f[i].x+=(p.ax-p.x)*pull; f[i].y+=(p.ay-p.y)*pull; }
        p.x+=Math.max(-8,Math.min(8,f[i].x))*t; p.y+=Math.max(-8,Math.min(8,f[i].y))*t;
      });
    }
    // Дочистка: сила к концу остывает, поэтому последние нарушения правим
    // прямо сдвигом. Двигаем в основном узел, концы ребра — чуть-чуть.
    for(let it=0; it<60; it++){
      let bad=false;
      for(let k=0;k<list.length;k++) for(const [i,j] of E){
        if(k===i||k===j || outBox(list[k],list[i],list[j],GAP)) continue;
        const p=list[k], s=toSeg(p, list[i], list[j]); if(s.d>=GAP*0.8) continue;
        bad=true;
        const n=away(p,s), m=(GAP*0.8-s.d)+1;
        p.x+=n.x*m*0.7; p.y+=n.y*m*0.7;
        list[i].x-=n.x*m*0.3*(1-s.t); list[i].y-=n.y*m*0.3*(1-s.t);
        list[j].x-=n.x*m*0.3*s.t; list[j].y-=n.y*m*0.3*s.t;
      }
      if(!bad) break;
    }
    const out=new Map(); nodes.forEach((n,i)=>out.set(n,{x:list[i].x,y:list[i].y}));
    return out;
  }

  // Подписи рёбер. Каждая — у середины своего ребра: x,y середина, dx,dy
  // единичный вектор вдоль ребра, len его длина, w,h размер подписи.
  // Ставим сбоку от линии с зазором 8 px и по очереди: подпись берёт
  // ближайшее к середине место (сдвиг вдоль ребра, потом другая сторона),
  // где не накрывает узлы, имена узлов (obs: {x,y,r} круг или {x,y,w,h}
  // прямоугольник по центру) и уже поставленные подписи. Если места нет
  // вовсе — где меньше всего налезаний. Возвращает центры подписей.
  function labels(items, obs){
    const PAD=2, placed=[], out=[];
    const hitRect=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2+PAD && Math.abs(a.y-b.y)<(a.h+b.h)/2+PAD;
    const hitCircle=(a,c)=>{
      const px=Math.max(a.x-a.w/2,Math.min(c.x,a.x+a.w/2)), py=Math.max(a.y-a.h/2,Math.min(c.y,a.y+a.h/2));
      return Math.hypot(px-c.x,py-c.y)<c.r+PAD;
    };
    const cost=r=>{
      let n=0;
      for(const o of obs) if(o.r!=null ? hitCircle(r,o) : hitRect(r,o)) n++;
      for(const q of placed) if(hitRect(r,q)) n++;
      return n;
    };
    for(const it of items){
      // Нормаль смотрит вверх (а у вертикали — вправо): первая попытка у всех одинаковая.
      let nx=-it.dy, ny=it.dx;
      if(ny>0 || (ny===0 && nx<0)){ nx=-nx; ny=-ny; }
      const off=8+Math.abs(nx)*it.w/2+Math.abs(ny)*it.h/2;
      const lim=Math.max(0,(it.len||0)/2-12), step=10;
      let best=null, bestCost=Infinity;
      for(let k=0; k*step<=lim+step && bestCost>0; k++){
        for(const sh of k ? [k*step,-k*step] : [0]){
          const s=Math.max(-lim,Math.min(lim,sh));
          for(const side of [1,-1]){
            const r={x:it.x+it.dx*s+nx*off*side, y:it.y+it.dy*s+ny*off*side, w:it.w, h:it.h};
            const c=cost(r);
            if(c<bestCost){ best=r; bestCost=c; if(!c) break; }
          }
          if(!bestCost) break;
        }
      }
      placed.push(best); out.push({x:best.x, y:best.y});
    }
    return out;
  }

  function left(closesAt, now){
    const s=closesAt-now; if(s<=0) return 'закрыт';
    const h=Math.floor(s/3600), m=Math.floor(s%3600/60);
    return h ? `${h} ч ${m} м` : m ? `${m} м` : '<1 м';
  }

  function soon(links, now, hours){
    return links.filter(l=>l.closesAt-now<hours*3600 && l.closesAt>now).sort((a,b)=>a.closesAt-b.closesAt);
  }

  // Связь, у которой вышло время, убираем сами, не дожидаясь сервера: вкладка
  // могла не достучаться до него, а мёртвый портал на карте хуже пустоты.
  function prune(state, now){
    let gone=false;
    for(const l of state.values()) if(l.closesAt<=now){ gone=true; break; }
    if(!gone) return state;
    const s=new Map();
    for(const [k,l] of state) if(l.closesAt>now) s.set(k,l);
    return s;
  }

  // Пауза перед следующим опросом после fails неудач подряд: 30 с, 1 мин,
  // 2 мин… но не больше 10 минут, чтобы починенный сервер подхватился сам.
  function backoff(fails){ return Math.min(600000, 15000*2**fails); }

  g.AvalonCore={key, merge, path, layout, labels, left, soon, prune, backoff};
})(typeof globalThis!=='undefined'?globalThis:this);
