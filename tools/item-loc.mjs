// Названия предметов на языках Albion Journal для сверки лога сундука: игрок
// копирует лог из игры, а там предметы записаны названиями на языке клиента.
// Приложение по этой таблице находит, какой это предмет.
//
//   node tools/item-loc.mjs OUT.json
//
// Формат: {"T6_MAIN_SWORD": ["Master's Broadsword", "Палаш (мастер)", …]} в
// порядке LANGS. Варианты с @N пропускаются, если названия у них те же, что у
// основы (у снаряжения зачарование в названии не пишется).
//
// Если список не скачался или выглядит битым — оставляем OUT как есть
// (в репозитории лежит последняя удачная копия) и выходим без ошибки.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SRC = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json';
const LANGS = ['EN-US', 'RU-RU', 'ES-ES', 'PL-PL', 'DE-DE', 'TR-TR', 'FR-FR', 'PT-BR', 'IT-IT'];
const out = process.argv[2] || 'item_loc.json';

try {
  const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const table = {};
  for (const x of await res.json()) {
    const names = x.LocalizedNames;
    if (!x.UniqueName || !names) continue;
    const row = LANGS.map(l => names[l] || '');
    const base = x.UniqueName.split('@')[0];
    if (base !== x.UniqueName && table[base] && table[base].join('\n') === row.join('\n')) continue;
    table[x.UniqueName] = row;
  }
  const n = Object.keys(table).length;
  if (n < 4000) throw new Error(`слишком мало предметов: ${n}`);
  const json = JSON.stringify({ langs: LANGS, items: table });
  if (existsSync(out) && readFileSync(out, 'utf8') === json) {
    console.log(`item_loc: без изменений (${n})`);
  } else {
    writeFileSync(out, json);
    console.log(`item_loc: обновлено (${n})`);
  }
} catch (e) {
  console.log(`item_loc: не обновилось (${e.message}), остаётся прежняя копия`);
}
