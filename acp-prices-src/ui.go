package main

// Живая панель в терминале. Без сторонних библиотек, только escape-последовательности,
// чтобы программа осталась одним файлом без установки.

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	cReset = "\033[0m"
	cBold  = "\033[1m"
	cMuted = "\033[38;5;245m"
	cGold  = "\033[38;5;179m"
	cGreen = "\033[38;5;108m"
	cBlue  = "\033[38;5;110m"
	cRed   = "\033[38;5;174m"
)

type caught struct {
	item, city string
	sell, buy  int64
	at         time.Time
}

var (
	uiMu     sync.Mutex
	recents  []caught
	note     string // что происходит прямо сейчас
	noteBad  bool
	started  = time.Now()
	uiActive bool
)

func isTTY() bool {
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// Сообщение в панель, а если панели нет, обычной строкой
func say(bad bool, format string, a ...interface{}) {
	msg := fmt.Sprintf(format, a...)
	uiMu.Lock()
	note, noteBad = msg, bad
	active := uiActive
	uiMu.Unlock()
	if !active {
		fmt.Println(msg)
	}
}

// Кладём наверх, а повтор того же предмета в том же городе не плодим,
// иначе одна пролистанная страница забьёт весь список одной строкой.
func remember(list []caught) {
	uiMu.Lock()
	defer uiMu.Unlock()
	for i := 0; i < len(list); i++ {
		c := list[i] // идём вперёд, чтобы наверх лёг самый свежий вид позиции
		out := recents[:0]
		for _, r := range recents {
			if r.item != c.item || r.city != c.city {
				out = append(out, r)
			}
		}
		recents = append([]caught{c}, out...)
	}
	if len(recents) > 7 {
		recents = recents[:7]
	}
}

func pad(s string, n int) string {
	r := []rune(s)
	if len(r) >= n {
		return string(r[:n])
	}
	return s + strings.Repeat(" ", n-len(r))
}

// «3 сек», «4 мин», «2 ч» без хвоста «назад»
func dur(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d сек", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d мин", int(d.Minutes()))
	default:
		return fmt.Sprintf("%d ч", int(d.Hours()))
	}
}

// Русские окончания: 1 ордер, 2 ордера, 5 ордеров
func plural(n int, one, few, many string) string {
	a, b := n%100, n%10
	switch {
	case a >= 11 && a <= 14:
		return many
	case b == 1:
		return one
	case b >= 2 && b <= 4:
		return few
	}
	return many
}

func ago(t time.Time) string {
	if t.IsZero() {
		return "пока ничего"
	}
	return dur(time.Since(t)) + " назад"
}

func draw(lanAddr string) {
	st.mu.Lock()
	positions := len(st.Data)
	orders := st.Seen
	cities := map[string]bool{}
	var newest int64
	for k, e := range st.Data {
		if p := strings.Split(k, "|"); len(p) == 3 {
			cities[p[1]] = true
		}
		if e.SellTS > newest {
			newest = e.SellTS
		}
		if e.BuyTS > newest {
			newest = e.BuyTS
		}
	}
	st.mu.Unlock()

	uiMu.Lock()
	rec := append([]caught(nil), recents...)
	msg, bad := note, noteBad
	uiMu.Unlock()

	var b strings.Builder
	line := func(s string) { b.WriteString(s + "\033[K\n") }

	b.WriteString("\033[H") // курсор в начало, экран не мигает
	line("")
	line("  " + cGold + cBold + "⚒  ALBION CRAFT PROFIT" + cReset + cMuted + "  ·  свои цены с твоего клиента" + cReset)
	line("  " + cMuted + strings.Repeat("─", 62) + cReset)
	line("")
	line("  " + cMuted + pad("Сайт", 14) + cReset + cBlue + "http://localhost:" + port + cReset)
	line("  " + cMuted + pad("Что собрано", 14) + cReset + cBlue + "http://localhost:" + port + "/status" + cReset)
	if lanAddr != "" {
		line("  " + cMuted + pad("С телефона", 14) + cReset + cBlue + lanAddr + cReset)
	} else {
		line("  " + cMuted + pad("Доступ", 14) + "только этот компьютер, флаг -lan откроет сети" + cReset)
	}
	line("  " + cMuted + pad("База", 14) + saveFile + cReset)
	uiMu.Lock()
	ready := siteReady
	uiMu.Unlock()
	if ready {
		line("  " + cMuted + pad("Сайт", 14) + cReset + cGreen + "готов" + cReset)
	} else {
		line("  " + cMuted + pad("Сайт", 14) + "качаю страницу и цены, подожди" + cReset)
	}
	line("")

	nv := time.Time{}
	if newest > 0 {
		nv = time.Unix(newest, 0)
	}
	line("  " + cMuted + pad("ПОЗИЦИЙ", 14) + pad("ОРДЕРОВ", 14) + pad("ГОРОДОВ", 12) + "ПОСЛЕДНЯЯ ЦЕНА" + cReset)
	line("  " + cBold + cGold + pad(fmt.Sprintf("%d", positions), 14) + pad(fmt.Sprintf("%d", orders), 14) +
		pad(fmt.Sprintf("%d", len(cities)), 12) + cReset + cBold + ago(nv) + cReset)
	line("")

	if len(rec) == 0 {
		line("  " + cMuted + "Жду данные. Запусти сборщик с  -p http://localhost:" + port + cReset)
		line("  " + cMuted + "и зайди в игре на аукцион." + cReset)
	} else {
		line("  " + cMuted + "Последнее пойманное" + cReset)
		for _, c := range rec {
			s := "  " + cMuted + "  " + cReset + pad(c.item, 26) + cMuted + pad(c.city, 14) + cReset
			if c.sell > 0 {
				s += cGreen + pad("купить "+num(c.sell), 20) + cReset
			} else {
				s += pad("", 20)
			}
			if c.buy > 0 {
				s += cMuted + "сдать " + num(c.buy) + cReset
			}
			line(s)
		}
	}
	for i := len(rec); i < 7; i++ {
		line("")
	}
	line("")
	if marks, sw := locSummary(); marks != "" {
		line("  " + cMuted + "Метки от игры  " + marks + cReset)
		if sw > 0 {
			line("  " + cMuted + fmt.Sprintf("Метка менялась %d %s. Если ты стоял на месте, игра врёт и цены разъедутся по городам.", sw, plural(int(sw), "раз", "раза", "раз")) + cReset)
		} else {
			line("")
		}
	} else {
		line("")
		line("")
	}
	if msg != "" {
		c := cMuted
		if bad {
			c = cRed
		}
		line("  " + c + msg + cReset)
	} else {
		line("")
	}
	line("  " + cMuted + "Работает " + dur(time.Since(started)) + " · сохраняю каждые 5 сек · Ctrl+C чтобы выйти" + cReset)
	b.WriteString("\033[J") // подчистить остаток экрана
	fmt.Print(b.String())
}

func runUI(lanAddr string) {
	uiMu.Lock()
	uiActive = true
	uiMu.Unlock()
	fmt.Print("\033[2J") // один раз чистим
	for {
		draw(lanAddr)
		time.Sleep(time.Second)
	}
}

// для страницы /status: города по алфавиту
func sortedCities() []string {
	st.mu.Lock()
	m := map[string]bool{}
	for k := range st.Data {
		if p := strings.Split(k, "|"); len(p) == 3 {
			m[p[1]] = true
		}
	}
	st.mu.Unlock()
	out := make([]string, 0, len(m))
	for c := range m {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Готовность сайта показываем отдельной строкой: пока файлы качаются,
// открывать страницу рано, она успеет сдаться по таймауту.
var siteReady bool

func siteReadyFlag(v bool) {
	uiMu.Lock()
	siteReady = v
	uiMu.Unlock()
}

// Сводка по меткам локаций: что прислала игра и сколько раз метка сменилась.
func locSummary() (string, int64) {
	locMu.Lock()
	ids := make([]string, 0, len(locCount))
	for id := range locCount {
		ids = append(ids, id)
	}
	cnt := make(map[string]int64, len(locCount))
	for id, n := range locCount {
		cnt[id] = n
	}
	sw := locSwitch
	locMu.Unlock()
	if len(ids) == 0 {
		return "", 0
	}
	sort.Slice(ids, func(i, j int) bool { return cnt[ids[i]] > cnt[ids[j]] })
	if len(ids) > 4 {
		ids = ids[:4]
	}
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		name := cityByID[id]
		if name == "" {
			name = "?"
		}
		parts = append(parts, fmt.Sprintf("%s %s ×%d", id, name, cnt[id]))
	}
	return strings.Join(parts, cMuted+" · "), sw
}
