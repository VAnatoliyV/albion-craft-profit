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

  // Силовая раскладка: рёбра тянут, узлы расталкиваются. Уже стоявшие узлы
  // начинают с прежнего места и держатся за него пружиной, новые встают
  // рядом с соседом — иначе карта прыгает при каждом обновлении.
  function layout(nodes, edges, prev, seed){
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
      for(const [a,b] of edges){
        const i=at.get(a), j=at.get(b); if(i==null||j==null) continue;
        const dx=list[j].x-list[i].x, dy=list[j].y-list[i].y, d=Math.hypot(dx,dy)||1, k=(d-70)*0.04;
        f[i].x+=dx/d*k*d/10; f[i].y+=dy/d*k*d/10; f[j].x-=dx/d*k*d/10; f[j].y-=dy/d*k*d/10;
      }
      const t=t0*(1-it/iters);
      list.forEach((p,i)=>{
        if(p.ax!==null){ f[i].x+=(p.ax-p.x)*pull; f[i].y+=(p.ay-p.y)*pull; }
        p.x+=Math.max(-8,Math.min(8,f[i].x))*t; p.y+=Math.max(-8,Math.min(8,f[i].y))*t;
      });
    }
    const out=new Map(); nodes.forEach((n,i)=>out.set(n,{x:list[i].x,y:list[i].y}));
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

  g.AvalonCore={key, merge, path, layout, left, soon};
})(typeof globalThis!=='undefined'?globalThis:this);
