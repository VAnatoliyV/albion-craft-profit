// Запасные иконки предметов в репозитории (ico/<id>.webp).
//
// Обычно сайт берёт иконки с render.albiononline.com. Этот адрес обслуживает
// G-Core, а из России без VPN он не открывается (как и игровые серверы — отсюда
// же чёрный экран при смене зоны). Тогда сайт берёт иконки отсюда, с GitHub Pages.
//
// Список предметов — все id из items.json и сырьё для карты Авалона. Качаем только недостающие, поэтому
// повторный запуск после патча дотягивает лишь новые вещи. Ответ 404 запоминаем
// в ico/none.txt, чтобы не спрашивать render о них на каждой сборке.
//
//   node tools/icons.mjs          скачать недостающие (нужен cwebp)
//   node tools/icons.mjs --count  только сказать, сколько не хватает (код 1, если есть)
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const dir = new URL('ico/', root);
const noneFile = new URL('none.txt', dir);
const SIZE = 128;      // хватает на самые крупные иконки таблиц на плотном экране
const PAR = 6;         // render ограничивает частоту — не больше шести зараз
const enc = s => encodeURIComponent(s).replace(/%40/g, '@');

const raw = await readFile(new URL('items.json', root), 'utf8');
// Сырьё карты Авалона: карточка зоны показывает значок ресурса по тиру узлов,
// а T2 и T3 в items.json не попадают (из них ничего не крафтят на сайте).
const MAP_RES = ['FIBER', 'HIDE', 'ORE', 'ROCK', 'WOOD'].flatMap(k => [2, 3, 4, 5, 6, 7, 8].map(t => `T${t}_${k}`));
const ids = [...new Set([...raw.match(/"[A-Z][A-Z0-9_]*_[A-Z0-9_]+(?:@[1-4])?"/g).map(s => s.slice(1, -1)), ...MAP_RES])].sort();
await mkdir(dir, { recursive: true });
const none = new Set((await readFile(noneFile, 'utf8').catch(() => '')).split('\n').filter(Boolean));
const exists = id => access(new URL(id + '.webp', dir)).then(() => true, () => false);
const missing = [];
for (const id of ids) if (!none.has(id) && !(await exists(id))) missing.push(id);
console.log(`иконок: ${ids.length}, нет в репозитории: ${missing.length}, у render нет вовсе: ${none.size}`);
if (process.argv.includes('--count')) process.exit(missing.length ? 1 : 0);

async function one(id) {
  for (let n = 0; n < 4; n++) {
    try {
      const r = await fetch(`https://render.albiononline.com/v1/item/${enc(id)}.png?size=${SIZE}`);
      if (r.status === 404) { none.add(id); return 'none'; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const png = new URL(id + '.png', dir);
      await writeFile(png, Buffer.from(await r.arrayBuffer()));
      await run('cwebp', ['-quiet', '-q', '85', '-alpha_q', '80', png.pathname, '-o', new URL(id + '.webp', dir).pathname]);
      await unlink(png);
      return 'ok';
    } catch (e) {
      await new Promise(f => setTimeout(f, 500 * (n + 1)));
      if (n === 3) { console.log(`  ${id}: ${e.message}`); return 'fail'; }
    }
  }
}

const got = { ok: 0, none: 0, fail: 0 };
let i = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (i < missing.length) {
    const id = missing[i++];
    got[await one(id)]++;
    if ((got.ok + got.none + got.fail) % 500 === 0) console.log(`  ${got.ok + got.none + got.fail}/${missing.length}`);
  }
}));
await writeFile(noneFile, [...none].sort().join('\n') + '\n');
console.log(`скачано ${got.ok}, нет у render ${got.none}, не вышло ${got.fail}`);
