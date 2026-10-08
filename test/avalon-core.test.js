const test = require('node:test');
const assert = require('node:assert');
require('../avalon-core.js');
const C = globalThis.AvalonCore;
const L = (a,b,c,conf=false)=>({a,b,closesAt:c,confirmed:conf,n:1});

test('merge: full заменяет, since дополняет, gone удаляет', ()=>{
  let s = C.merge(new Map(), {full:true, links:[L('A','B',100), L('B','C',200)], gone:[]});
  assert.equal(s.size, 2);
  s = C.merge(s, {full:false, links:[L('C','D',300)], gone:['A|B']});
  assert.deepEqual([...s.keys()].sort(), ['B|C','C|D']);
  s = C.merge(s, {full:true, links:[L('X','Y',1)], gone:[]});
  assert.deepEqual([...s.keys()], ['X|Y']);
});

test('path: кратчайший, в обе стороны, с фильтром подтверждённых', ()=>{
  const links = [L('A','B',1,true), L('B','C',1,false), L('A','D',1,true), L('D','C',1,true)];
  assert.deepEqual(C.path(links,'C','A',false).length, 3);
  assert.deepEqual(C.path(links,'A','C',true), ['A','D','C']);
  assert.equal(C.path(links,'A','Z',false), null);
  assert.deepEqual(C.path(links,'A','A',false), ['A']);
});

test('layout: детерминирован и не двигает старые узлы далеко', ()=>{
  const nodes=['A','B','C'], edges=[['A','B'],['B','C']];
  const p1=C.layout(nodes,edges,new Map(),7), p2=C.layout(nodes,edges,new Map(),7);
  assert.deepEqual([...p1], [...p2]);
  const p3=C.layout([...nodes,'D'],[...edges,['C','D']],p1,7);
  for(const k of nodes){
    const d=Math.hypot(p3.get(k).x-p1.get(k).x, p3.get(k).y-p1.get(k).y);
    assert.ok(d<60, k+' уехал на '+d);
  }
});

test('left и soon', ()=>{
  assert.equal(C.left(1000+5*3600+12*60, 1000), '5 ч 12 м');
  assert.equal(C.left(1000+23*60+5, 1000), '23 м');
  assert.equal(C.left(900, 1000), 'закрыт');
  const s=C.soon([L('A','B',1000+7200), L('C','D',1000+600), L('E','F',1000+90000)], 1000, 3);
  assert.deepEqual(s.map(x=>x.a), ['C','A']);
});
