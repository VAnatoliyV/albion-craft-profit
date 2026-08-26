// Приёмник своих цен для Albion Craft Profit.
//
// Что делает: слушает у тебя на компьютере, принимает то, что присылает
// albiondata-client с флагом -p, и складывает в один файл рядом с собой.
// Наружу ничего не отдаёт и никуда не ходит, кроме как за самим сайтом.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultPort = "7777" // 5000 на маке занят AirPlay, поэтому не он
	fileName    = "acp-own-prices.json"
	// Одна страница аукциона это 50 ордеров, а список бывает длиннее.
	// Пока идут страницы одного и того же предмета, берём минимум по ним,
	// а не затираем предыдущую страницу. Через это окно счёт начинается заново.
	pageWindow = 45 * time.Second
)

// Номера рынков из дампа игры (formatted/world.txt) и с публичного API.
// 3003 это Чёрный рынок: в дампе зона называется просто Caerleon, а рынок там
// отдельный, и Albion Online Data Project зовёт его именно Black Market.
var cityByID = map[string]string{
	"0007": "Thetford", "1002": "Lymhurst", "2004": "Bridgewatch",
	"3005": "Caerleon", "3008": "Martlock", "4002": "Fort Sterling",
	"5003": "Brecilien", "3003": "Black Market",
}

// Каталог для базы: приложение подставляет свой, чтобы не писать внутрь бандла.
var dataDir string

// Неизвестные номера не выбрасываем молча: раньше ордера с Чёрного рынка
// уходили в никуда, а снаружи всё выглядело успешно, ответ-то 200.
var unknownSeen = map[string]bool{}

// Метка локации приходит от игры и бывает неверной, поэтому её надо не лечить
// вслепую, а мерить. Считаем, сколько ордеров пришло под каждой меткой и
// сколько раз метка сменилась между посылками.
var (
	locMu     sync.Mutex
	locCount  = map[string]int64{}
	locLast   string
	locSwitch int64
)

func noteLoc(id string) {
	locMu.Lock()
	locCount[id]++
	if locLast != "" && locLast != id {
		locSwitch++
	}
	locLast = id
	locMu.Unlock()
}

// Локация может прийти и строкой "3005", и числом 3005. Принимаем оба вида:
// если ошибиться типом, json-разбор валит ВСЮ посылку целиком, и сбор молча
// стоит на нуле, а выглядит это как «ничего не ловится».
type locID string

func (l *locID) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		*l = ""
		return nil
	}
	if len(s) > 1 && s[0] == '"' {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		*l = locID(str)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*l = locID(n.String())
	return nil
}

type order struct {
	ItemID     string `json:"ItemTypeId"`
	LocationID locID  `json:"LocationId"`
	Quality    int    `json:"QualityLevel"`
	Price      int64  `json:"UnitPriceSilver"`
	Amount     int    `json:"Amount"`
	Type       string `json:"AuctionType"`
}

type marketUpload struct {
	Orders []order `json:"Orders"`
}

// Что мы храним по каждому сочетанию предмет + город + качество
type entry struct {
	Sell    int64 `json:"sell,omitempty"`   // самый дешёвый селл-ордер: почём купить
	SellTS  int64 `json:"sellTs,omitempty"` // unix-секунды
	Buy     int64 `json:"buy,omitempty"`    // самый дорогой бай-ордер: почём сдать
	BuyTS   int64 `json:"buyTs,omitempty"`
	sellWin time.Time
	buyWin  time.Time
}

type store struct {
	mu    sync.Mutex
	Data  map[string]*entry `json:"prices"`
	Built int64             `json:"built"`
	Seen  int64             `json:"seenOrders"`
	dirty bool
}

var (
	st       = &store{Data: map[string]*entry{}}
	saveFile string // абсолютный путь, считается один раз при старте
	port     string
)

// Где держать базу цен. Порядок такой: флаг -data, потом переменная окружения
// AJ_DATA (её ставит приложение, когда кладёт нас внутрь бандла), и только потом
// каталог рядом с исполняемым файлом. Внутри подписанного бандла писать нельзя,
// поэтому без первых двух вариантов приложению пришлось бы копировать нас наружу.
func resolveSaveFile() string {
	if dataDir != "" {
		os.MkdirAll(dataDir, 0755)
		return filepath.Join(dataDir, fileName)
	}
	if d := os.Getenv("AJ_DATA"); d != "" {
		os.MkdirAll(d, 0755)
		return filepath.Join(d, fileName)
	}
	exe, err := os.Executable()
	if err == nil {
		if real, err2 := filepath.EvalSymlinks(exe); err2 == nil {
			exe = real
		}
		return filepath.Join(filepath.Dir(exe), fileName)
	}
	return fileName
}

func key(item, city string, q int) string {
	return fmt.Sprintf("%s|%s|%d", item, city, q)
}

// Цена в протоколе идёт умноженной на 10000
func silver(v int64) int64 { return v / 10000 }

func (s *store) put(o order) *caught {
	if id := string(o.LocationID); id != "" {
		noteLoc(id)
	}
	city, ok := cityByID[string(o.LocationID)]
	if !ok {
		if id := string(o.LocationID); id != "" && !unknownSeen[id] {
			unknownSeen[id] = true
			say(true, "Незнакомая локация %s, ордера оттуда пропускаю", id)
		}
		return nil
	}
	if o.ItemID == "" || o.Price <= 0 {
		return nil
	}
	q := o.Quality
	if q < 1 {
		q = 1
	}
	p := silver(o.Price)
	if p <= 0 {
		return nil
	}
	now := time.Now()
	k := key(o.ItemID, city, q)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.Seen++
	e := s.Data[k]
	if e == nil {
		e = &entry{}
		s.Data[k] = e
	}
	s.dirty = true

	switch strings.ToLower(o.Type) {
	case "offer": // кто-то продаёт, значит это цена покупки для нас
		fresh := now.Sub(e.sellWin) > pageWindow
		if fresh || e.Sell == 0 || p < e.Sell {
			e.Sell = p
		}
		if fresh {
			e.sellWin = now
		}
		e.SellTS = now.Unix()
	case "request": // кто-то покупает, значит это цена мгновенной сдачи
		fresh := now.Sub(e.buyWin) > pageWindow
		if fresh || e.Buy == 0 || p > e.Buy {
			e.Buy = p
		}
		if fresh {
			e.buyWin = now
		}
		e.BuyTS = now.Unix()
	}
	return &caught{item: o.ItemID, city: city, sell: e.Sell, buy: e.Buy, at: now}
}

func (s *store) save() {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	s.Built = time.Now().Unix()
	s.dirty = false
	b, err := json.Marshal(s)
	s.mu.Unlock()
	if err != nil {
		return
	}
	tmp := saveFile + ".tmp"
	if os.WriteFile(tmp, b, 0644) == nil {
		os.Rename(tmp, saveFile)
	}
}

func (s *store) load() {
	b, err := os.ReadFile(saveFile)
	if err != nil {
		return
	}
	json.Unmarshal(b, s)
	if s.Data == nil {
		s.Data = map[string]*entry{}
	}
	log.Printf("Поднял из файла: %d позиций", len(s.Data))
}

func ingestOrders(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	var up marketUpload
	if err := json.Unmarshal(body, &up); err != nil {
		say(true, "Не разобрал посылку с ордерами: %v", err)
		http.Error(w, "bad json", 400)
		return
	}
	var got []caught
	for _, o := range up.Orders {
		if c := st.put(o); c != nil {
			got = append(got, *c)
		}
	}
	remember(got)
	n := len(up.Orders)
	say(false, "Принял %d %s с рынка", n, plural(n, "ордер", "ордера", "ордеров"))
	w.WriteHeader(200)
}

func swallow(w http.ResponseWriter, r *http.Request) {
	io.Copy(io.Discard, io.LimitReader(r.Body, 8<<20))
	w.WriteHeader(200)
}

func ownJSON(w http.ResponseWriter, r *http.Request) {
	st.mu.Lock()
	b, _ := json.Marshal(st)
	st.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

type row struct {
	item, city string
	q          int
	e          entry
}

func status(w http.ResponseWriter, r *http.Request) {
	st.mu.Lock()
	rows := make([]row, 0, len(st.Data))
	for k, e := range st.Data {
		p := strings.Split(k, "|")
		if len(p) != 3 {
			continue
		}
		q, _ := strconv.Atoi(p[2])
		rows = append(rows, row{p[0], p[1], q, *e})
	}
	seen := st.Seen
	st.mu.Unlock()

	seenAt := func(e entry) int64 {
		if e.BuyTS > e.SellTS {
			return e.BuyTS
		}
		return e.SellTS
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := seenAt(rows[i].e), seenAt(rows[j].e)
		if a != b {
			return a > b
		}
		return rows[i].item < rows[j].item
	})

	var sb strings.Builder
	sb.WriteString(`<!doctype html><meta charset="utf-8"><title>Свои цены</title>
<style>body{background:#0f1218;color:#e8ecf3;font:14px/1.5 -apple-system,system-ui,sans-serif;padding:24px}
h1{font-size:19px;margin:0 0 4px}.m{color:#8b93a3}table{border-collapse:collapse;margin-top:16px;width:100%;max-width:900px}
th,td{padding:6px 10px;border-bottom:1px solid #222a36;text-align:right}th:first-child,td:first-child{text-align:left}
th{color:#8b93a3;font-weight:600;font-size:12px;text-transform:uppercase}b{color:#eebc4e}</style>`)
	fmt.Fprintf(&sb, "<h1>Свои цены собираются</h1><div class=m>Позиций в базе: <b>%d</b> · ордеров принято: <b>%d</b> · файл: <code>%s</code></div>",
		len(rows), seen, saveFile)
	if marks, sw := locSummary(); marks != "" {
		fmt.Fprintf(&sb, "<div class=m style=\"margin-top:6px\">Метки локаций от игры: %s · метка менялась <b>%d</b> раз</div>",
			strings.ReplaceAll(marks, cMuted, ""), sw)
	}
	if len(rows) == 0 {
		sb.WriteString(`<p class=m style="margin-top:20px">Пока пусто. Запусти сборщик с флагом <code>-p http://localhost:` + port + `</code>, зайди в игре на аукцион и полистай ордера.</p>`)
	} else {
		sb.WriteString("<table><tr><th>Предмет</th><th>Город</th><th>Кач.</th><th>Купить</th><th>Сдать</th><th>Когда</th></tr>")
		lim := len(rows)
		if lim > 200 {
			lim = 200
		}
		for _, x := range rows[:lim] {
			ago := "нет"
			if t := seenAt(x.e); t > 0 {
				ago = fmt.Sprintf("%d мин назад", (time.Now().Unix()-t)/60)
			}
			fmt.Fprintf(&sb, "<tr><td>%s</td><td>%s</td><td>%d</td><td><b>%s</b></td><td>%s</td><td class=m>%s</td></tr>",
				x.item, x.city, x.q, num(x.e.Sell), num(x.e.Buy), ago)
		}
		sb.WriteString("</table>")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, sb.String())
}

// Адрес в домашней сети, чтобы не искать его руками в настройках
func localIP() string {
	c, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer c.Close()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok {
		return a.IP.String()
	}
	return ""
}

// ─── Раздача сайта ───
// Браузер не пустит страницу с https на http://localhost, это смешанное содержимое.
// Поэтому сайт отдаём с того же адреса: качаем его с GitHub Pages и держим в памяти.
const siteBase = "https://vanatoliyv.github.io/albion-craft-profit/"

type cached struct {
	body  []byte
	ctype string
	at    time.Time
}

// Файлы сайта. data.json это снимок цен на десяток мегабайт: если тянуть его
// в тот момент, когда страница уже открыта, она успевает сдаться по таймауту
// и уходит опрашивать чужой API напрямую. Поэтому качаем всё заранее, при старте.
var siteFiles = []string{"index.html", "items.json", "data.json", "data-stats.json"}

func fetchToCache(name string) error {
	resp, err := http.Get(siteBase + name)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("сайт ответил %s", resp.Status)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	cacheMu.Lock()
	cache[name] = cached{body: b, ctype: resp.Header.Get("Content-Type"), at: time.Now()}
	cacheMu.Unlock()
	return nil
}

// Скачиваем сайт заранее, дальше освежаем в фоне
func warmSite() {
	for _, n := range siteFiles {
		say(false, "Готовлю сайт: качаю %s", n)
		if err := fetchToCache(n); err != nil {
			if n == "data-stats.json" {
				continue // необязательный файл, без него сайт работает
			}
			say(true, "Не смог скачать %s: %v", n, err)
			continue
		}
		cacheMu.Lock()
		kb := len(cache[n].body) / 1024
		cacheMu.Unlock()
		say(false, "Готовлю сайт: %s готов (%d КБ)", n, kb)
	}
	siteReadyFlag(true)
	say(false, "Сайт готов, открывай http://localhost:%s", port)
	for range time.Tick(5 * time.Minute) {
		for _, n := range siteFiles {
			fetchToCache(n)
		}
	}
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cached{}
)

func siteProxy(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	cacheMu.Lock()
	c, ok := cache[name]
	cacheMu.Unlock()
	// Отдаём даже слегка протухшее, лишь бы страница не ждала: свежее приедет фоном.
	// Качаем прямо сейчас, только если файла нет вообще.
	if !ok {
		if err := fetchToCache(name); err != nil {
			http.Error(w, "Не смог скачать сайт: "+err.Error(), 502)
			return
		}
		cacheMu.Lock()
		c = cache[name]
		cacheMu.Unlock()
	}
	if c.ctype != "" {
		w.Header().Set("Content-Type", c.ctype)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Write(c.body)
}

func num(v int64) string {
	if v == 0 {
		return "нет"
	}
	s := fmt.Sprintf("%d", v)
	out := ""
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out += " "
		}
		out += string(c)
	}
	return out
}

func main() {
	lan := flag.Bool("lan", false, "Открыть доступ всей домашней сети, чтобы смотреть цены с телефона. По умолчанию только этот компьютер.")
	reset := flag.Bool("reset", false, "Стереть накопленное и начать с чистого листа.")
	flag.StringVar(&port, "port", defaultPort, "Порт, который слушать.")
	flag.StringVar(&dataDir, "data", "", "Каталог для базы цен. По умолчанию рядом с программой или AJ_DATA.")
	flag.Parse()

	saveFile = resolveSaveFile()
	if *reset {
		os.Remove(saveFile)
		log.Printf("База стёрта: %s", saveFile)
	}
	st.load()
	go func() {
		for range time.Tick(5 * time.Second) {
			st.save()
		}
	}()

	http.HandleFunc("/marketorders.ingest", ingestOrders)
	http.HandleFunc("/markethistories.ingest", swallow)
	http.HandleFunc("/goldprices.ingest", swallow)
	http.HandleFunc("/mapdata.ingest", swallow)
	http.HandleFunc("/own.json", ownJSON)
	http.HandleFunc("/status", status)
	http.HandleFunc("/", siteProxy)

	host := "127.0.0.1"
	lanAddr := ""
	if *lan {
		host = "0.0.0.0"
		if ip := localIP(); ip != "" {
			lanAddr = "http://" + ip + ":" + port
		}
	}
	addr := net.JoinHostPort(host, port)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Printf("\n  Не смог занять порт %s: %v\n  Наверное, приёмник уже запущен в другом окне.\n  Можно взять другой порт: acp-prices -port 7778\n\n", port, err)
		os.Exit(1)
	}

	go warmSite()
	if isTTY() {
		go runUI(lanAddr)
	} else {
		log.Printf("Сайт со своими ценами: http://localhost:%s", port)
		log.Printf("База: %s", saveFile)
	}
	if err := http.Serve(ln, nil); err != nil {
		log.Fatal(err)
	}
}
