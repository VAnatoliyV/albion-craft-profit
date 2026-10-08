// Таблица «номер предмета в игре → внутреннее имя» для счётчика урона
// Albion Journal (по ней показывается оружие бойца). Номера сдвигаются с каждым
// патчем игры, поэтому берём свежий список из ao-bin-dumps при каждой сборке
// сайта, а программы забирают его отсюда (GitHub Pages открывается и в России).
//
//   node tools/items-by-id.mjs OUT.json
//
// Если список не скачался или выглядит битым — оставляем OUT как есть
// (в репозитории лежит последняя удачная копия) и выходим без ошибки.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SRC = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.txt';
const out = process.argv[2] || 'items_by_id.json';

try {
  const res = await fetch(SRC, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const table = { '0': { id: 0, unique_name: 'None', name: 'None' } };
  for (const line of (await res.text()).split('\n')) {
    const m = line.match(/^\s*(\d+):\s*(\S+)\s*(?::\s*(.*))?$/);
    if (m) table[m[1]] = { id: m[1], unique_name: m[2], name: (m[3] || '').trim() };
  }
  const n = Object.keys(table).length;
  if (n < 10000) throw new Error(`слишком мало предметов: ${n}`);
  const json = JSON.stringify(table);
  if (existsSync(out) && readFileSync(out, 'utf8') === json) {
    console.log(`items_by_id: без изменений (${n})`);
  } else {
    writeFileSync(out, json);
    console.log(`items_by_id: обновлено (${n})`);
  }
} catch (e) {
  console.log(`items_by_id: не обновилось (${e.message}), остаётся прежняя копия`);
}
