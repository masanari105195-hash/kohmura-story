/**
 * こうむら接骨院 予約システム 共通ロジック
 * reservation.html（患者用）と staff.html（スタッフ用）の両方から読み込みます。
 * このファイルも同じ場所（同じホスティング）にアップロードしてください。
 */

const DOW = ["日","月","火","水","木","金","土"];
// 30分枠1つあたりの受付上限人数。スタッフページの「1枠あたりの受付人数」で変更でき、
// ページを開くたびにサーバーの値で置き換えられる（setCapacity）。ここは読み込み前・通信失敗時の初期値。
const DEFAULT_CAPACITY = 3;
const MAX_CAPACITY = 20;
let CAPACITY_PER_SLOT = DEFAULT_CAPACITY;
// 0名（その枠・全体の受付停止）も指定できる。未設定（null・空）は0名ではなく初期値として扱う。
function normalizeCapacity(v){
  if (v === null || v === undefined || v === "") return DEFAULT_CAPACITY;
  const n = Math.floor(Number(v));
  return (n >= 0 && n <= MAX_CAPACITY) ? n : DEFAULT_CAPACITY;
}
function setCapacity(v){ CAPACITY_PER_SLOT = normalizeCapacity(v); }

// 枠ごとの受付人数（「◯月◯日の9:00の枠だけ◯名」）。個別に指定された枠は、通常の人数より優先される。
// 形式：[{date:"2026-10-05", time:"9:00", capacity:5}, ...]
let SLOT_CAPACITIES = {};
function setSlotCapacities(list){
  SLOT_CAPACITIES = {};
  (Array.isArray(list) ? list : []).forEach(o=>{
    if (!o || !o.date || !o.time || o.capacity === null || o.capacity === undefined || o.capacity === "") return;
    SLOT_CAPACITIES[normDateStr(o.date) + "|" + normTimeStr(o.time)] = normalizeCapacity(o.capacity);
  });
}
function capacityFor(date, time){
  const k = date + "|" + time;
  return (k in SLOT_CAPACITIES) ? SLOT_CAPACITIES[k] : CAPACITY_PER_SLOT;
}
function hasSlotCapacity(date, time){ return (date + "|" + time) in SLOT_CAPACITIES; }
// 開始時刻startから所要時間分の枠それぞれについて、残り人数の最小値を返す（個別指定も考慮）。
// 戻り値：{ req: 使う枠の一覧 or null, remaining: 残り人数, stopped: 受付停止（0名）の枠を含むか,
//          touched: すでに予約が入っている、または人数を個別指定した枠を含むか（「残◯」を表示するかの判断用） }
// menuLimit（任意）：選んだメニューの「同時に予約できる人数」の制限（menuLimitFor の戻り値）。
// 指定すると、全体の定員と、メニューごとの人数の両方で、残り人数の少ない方を残りとして返す。
// optionOnly（任意）：「オプションのみ」のメニューか。trueなら、メインの枠・枠内の人数（全体の定員、枠ごとの人数指定）は
// 一切見ず、診療時間内の枠かどうか（と、メニューごとの人数制限）だけで判定する。
function slotAvailability(date, start, duration, slotsForDay, counts, menuLimit, optionOnly){
  const req = getRequiredSlots(start, optionOnly ? 30 : duration, slotsForDay);
  if (!req) return { req: null, remaining: 0, stopped: false, touched: false };
  let remaining = Infinity, stopped = false, touched = false;
  req.forEach(s=>{
    if (!optionOnly) {
      const cap = capacityFor(date, s);
      if (cap === 0) stopped = true;
      if ((counts[s]||0) > 0 || hasSlotCapacity(date, s)) touched = true;
      remaining = Math.min(remaining, cap - (counts[s]||0));
    }
    if (menuLimit) {
      if (menuLimit.capacity === 0) stopped = true;
      touched = true; // メニューに人数制限がある時は、残り人数を表示する
      remaining = Math.min(remaining, menuLimit.capacity - ((menuLimit.counts && menuLimit.counts[s]) || 0));
    }
  });
  return { req, remaining, stopped, touched };
}

// 祝日（YYYY-MM-DD）。年が変わったらここに追記してください。
const HOLIDAYS = new Set([
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29",
  "2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11",
  "2026-09-21","2026-09-22","2026-09-23","2026-10-12","2026-11-03","2026-11-23",
  "2027-01-01","2027-01-11"
]);
function isHoliday(iso){ return HOLIDAYS.has(iso); }

// 臨時休診日・特別営業日は、{date, ranges:[{start,end}, ...]} の形で保持する。
// ranges が空なら「終日」、1つ以上あれば「その時間帯（複数可）だけ」の指定になる。
// 例：午前9〜10時と午後16〜18時の2つを指定 → ranges: [{start:"9:00",end:"10:00"},{start:"16:00",end:"18:00"}]
// 旧バージョン（日付の文字列だけ、または単一のstart/end）が来た場合も読み込めるよう変換する。
function normalizeDateOverrides(list){
  if(!Array.isArray(list)) return [];
  return list.map(o=>{
    if (typeof o === "string") return { date: o, ranges: [] };
    let ranges = [];
    if (Array.isArray(o.ranges)) ranges = o.ranges.filter(r=>r && r.start && r.end).map(r=>({start:r.start, end:r.end}));
    else if (o.start && o.end) ranges = [{start:o.start, end:o.end}]; // 旧形式（単一のstart/end）からの移行
    return { date: o.date, ranges: ranges };
  });
}
// 一覧表示用の文言。「終日」、または「9:00〜10:00、16:00〜18:00」のように時間帯を列挙する。
function describeDateOverride(o){
  if(!o.ranges || o.ranges.length===0) return "終日";
  return o.ranges.map(r=>r.start+"〜"+r.end).join("、");
}

// スタッフが設定した臨時休診日（祝日以外の急な休診。終日 or 時間帯指定、複数可）。ページ読み込み時にサーバーの値で置き換える。
let EXTRA_CLOSURES = [];
function setExtraClosures(list){ EXTRA_CLOSURES = normalizeDateOverrides(list); }
function findClosure(iso){ return EXTRA_CLOSURES.find(o => o.date === iso); }

// スタッフが設定した特別営業日（本来は祝日・日曜で休診の日に、あえて予約を受け付ける。終日 or 時間帯指定、複数可）。
let EXTRA_OPEN_DAYS = [];
function setExtraOpenDays(list){ EXTRA_OPEN_DAYS = normalizeDateOverrides(list); }
function findOpenDay(iso){ return EXTRA_OPEN_DAYS.find(o => o.date === iso); }

function fmtDate(d){
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function toMinutes(t){ const [h,m] = t.split(":").map(Number); return h*60+m; }

// 30分刻みの時刻文字列を start〜end（両端含む開始時刻）で生成
function genRange(startH,startM,endH,endM){
  const out = [];
  let h = startH, m = startM;
  while (h < endH || (h===endH && m<=endM)){
    out.push(h + ":" + String(m).padStart(2,"0"));
    m += 30; if(m>=60){ m=0; h++; }
  }
  return out;
}
// "10:00"のような文字列2つから、genRangeと同じ形で30分刻みの一覧を作る
function genRangeFromTimes(startStr, endStr){
  const [sh,sm] = startStr.split(":").map(Number);
  const [eh,em] = endStr.split(":").map(Number);
  return genRange(sh, sm, eh, em);
}

// 診療時間ルール：
// 平日(月〜金) 午前8:30〜12:00 / 午後15:30〜19:00
// 土曜 午前8:00〜12:00のみ（午後休診）
// 日曜・祝日は休診（ただしスタッフが「特別営業日」に指定した日は、平日と同じ時間で営業する）
// スタッフが「臨時休診日」に指定した日は、曜日や祝日にかかわらず休診になる
//   （終日、または指定した時間帯のみ。時間帯は複数指定できる＝例：午前9〜10時と午後16〜18時の両方を休診に）
// スタッフが「特別営業日」を時間帯指定にした場合は、指定した時間帯（複数可）の合計だけで営業する
//   （通常の診療時間とは独立。例：本来休診の祝日に、午前9〜10時と午後16〜18時だけ営業）
// ※11:30・18:30開始の枠は30分メニューのみ受付可（60分メニューは続きの枠が無いため自動的に選択不可になる）
function getSlotsForDate(iso){
  const closure = findClosure(iso);
  if (closure && closure.ranges.length === 0) return []; // 終日休診

  const openOv = findOpenDay(iso);
  const dow = new Date(iso+"T00:00:00").getDay();
  let base;

  if (openOv && openOv.ranges.length > 0) {
    // 指定した時間帯（複数可）の和集合だけで特別営業
    const set = new Set();
    openOv.ranges.forEach(r => genRangeFromTimes(r.start, r.end).forEach(t => set.add(t)));
    base = Array.from(set).sort((a,b)=> toMinutes(a) - toMinutes(b));
  } else {
    const closedByDefault = isHoliday(iso) || dow === 0;
    const forcedOpenAllDay = !!openOv; // 時間帯指定が無い特別営業＝終日
    if (closedByDefault && !forcedOpenAllDay) return [];
    base = (dow === 6) ? genRange(8,0, 11,30) : [...genRange(8,30, 11,30), ...genRange(15,30, 18,30)];
  }

  if (closure && closure.ranges.length > 0) {
    // 指定した時間帯（複数可）のいずれかに入る枠を取り除く
    base = base.filter(t => !closure.ranges.some(r =>
      toMinutes(t) >= toMinutes(r.start) && toMinutes(t) < toMinutes(r.end)
    ));
  }
  return base;
}

// startの時刻からduration分の予約に必要な、連続した30分枠の一覧を返す。
// 診療時間の終わりを超える・昼休みをまたぐなど確保できない場合はnullを返す。
function getRequiredSlots(start, duration, slotsForDay){
  const count = Math.max(1, Math.round((duration||30) / 30));
  const startIdx = slotsForDay.indexOf(start);
  if (startIdx === -1) return null;
  const out = [start];
  for (let i=1; i<count; i++){
    const idx = startIdx + i;
    if (idx >= slotsForDay.length) return null;
    if (toMinutes(slotsForDay[idx]) - toMinutes(slotsForDay[idx-1]) !== 30) return null;
    out.push(slotsForDay[idx]);
  }
  return out;
}

function getMenuDuration(menuName, menuItems){
  const found = (menuItems||[]).find(m => m.name === menuName);
  return found ? (found.duration || 30) : 30;
}

// 予約1件が実際に占有する30分枠の一覧（登録時点のdurationを使うので、後でメニューの設定を変えても過去の予約はズレない）
function occupiedSlotsFor(b){
  const slotsForDay = getSlotsForDate(b.date);
  return getRequiredSlots(b.time, b.duration || 30, slotsForDay) || [b.time];
}

function getCountsForDate(date, bookings){
  const counts = {};
  // 「オプションのみ」の予約は、メインの30分枠・枠内の人数に数えない
  bookings.filter(b=>b.date===date && !isTrueValue(b.optionOnly)).forEach(b=>{
    occupiedSlotsFor(b).forEach(t=>{ counts[t] = (counts[t]||0) + 1; });
  });
  return counts;
}

// 治療メニュー：{ name, duration, capacity }
//   duration … 使う30分枠の数を決める所要時間（分）
//   capacity … 同じ時間（30分の枠）に、このメニューを予約できる人数（ベッド・機械などの都合）。
//              null＝制限なし、0＝受付停止。全体の定員（受付人数）とは別に、メニューごとに設定できる。
//   optionOnly … 「オプションだけを希望する方」用のメニュー。メインの30分枠・枠内の人数に影響しない。
//                予約にはオプションを1つ以上選ぶ必要があり、オプションの所要時間・同時に使える人数だけで、空きが決まる。
const MENU_MAX_CAPACITY = 20;
function normalizeMenuCapacity(v){
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0 && n <= MENU_MAX_CAPACITY) ? n : null;
}
function normalizeMenu(list, defaultMenu){
  if(!Array.isArray(list) || list.length===0) return defaultMenu.map(m=>Object.assign({capacity:null, optionOnly:false}, m));
  return list.map(m => typeof m === "string"
    ? {name:m, duration:30, capacity:null, optionOnly:false}
    : {name:m.name, duration:Number(m.duration)||30, capacity:normalizeMenuCapacity(m.capacity), optionOnly:isTrueValue(m.optionOnly)});
}
// 選んだメニューが「オプションのみ」か
function isOptionOnlyMenu(menuName, menuItems){
  const m = (menuItems || []).find(x => x.name === menuName);
  return !!(m && isTrueValue(m.optionOnly));
}
// その日の、メニューごと・30分の枠ごとの予約人数：{ "初診": { "9:00": 2, "9:30": 2 }, ... }
// 予約が占める枠は、登録時点のdurationで数える。excludeId を渡すと、その予約（編集中など）は数えない。
function getMenuCountsForDate(date, bookings, excludeId){
  const out = {};
  (bookings || []).filter(b => b.date === date && b.menu && (!excludeId || b.id !== excludeId)).forEach(b => {
    occupiedSlotsFor(b).forEach(t => {
      out[b.menu] = out[b.menu] || {};
      out[b.menu][t] = (out[b.menu][t] || 0) + 1;
    });
  });
  return out;
}
// そのメニューの人数制限（無ければnull）：{ capacity, counts:{時間:人数} }。slotAvailabilityに渡す
function menuLimitFor(menuName, menuItems, menuCounts){
  const m = (menuItems || []).find(x => x.name === menuName);
  if (!m || m.capacity === null || m.capacity === undefined) return null;
  return { capacity: m.capacity, counts: (menuCounts && menuCounts[menuName]) || {} };
}

// 日本の電話番号のゆるいチェック（ハイフン任意、市外局番＋市内局番＋番号で合計9〜10桁）
function isValidPhone(v){
  const digits = String(v||"").replace(/[-‐－ｰ\s]/g, "");
  return /^0\d{9,10}$/.test(digits);
}

function isValidEmail(v){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||"").trim());
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// スプレッドシート由来の値のゆらぎ（"2026/10/1"、"8:30:00"、ISO形式の日付など）を "YYYY-MM-DD" / "H:mm" にそろえる
function normDateStr(v){
  const s = String(v == null ? "" : v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); if (!isNaN(d)) return fmtDate(d); }
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  return m ? m[1] + "-" + String(m[2]).padStart(2,"0") + "-" + String(m[3]).padStart(2,"0") : s;
}
function normTimeStr(v){
  const s = String(v == null ? "" : v);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + ":" + m[2] : s;
}
function normalizeBooking(b){
  return Object.assign({}, b, {
    date: normDateStr(b.date),
    time: normTimeStr(b.time),
    duration: Number(b.duration) || 30,
    options: b.options ? String(b.options) : "",
    optionOnly: isTrueValue(b.optionOnly)
  });
}
function isTrueValue(v){ return v === true || String(v).toLowerCase() === "true"; }

// ---- オプション（特殊電気治療・トレーニングなど） ----
// 治療メニューに付け足せる項目。メインの予約枠（治療の枠数・定員）には影響しない。
// ただしオプション自体にも、次の2つの制限を設定できる。
//   duration … そのオプションにかかる時間（分）。10分程度のものから、30分・60分かかるものまで。
//              30分の枠を何枠ぶん使うかは、ceil(duration÷30)。60分なら2枠（次の枠も同じオプションが使えなくなる）。
//   capacity … 同じ時間（30分の枠）に、そのオプションを選べる人数（機械の台数などの都合）。
//              null＝制限なし。0＝利用停止。
//   showOnStory … Instagramのストーリー（今日の予約状況）に、そのオプションの予約状況を載せるか（既定：載せる）。
// オプションは、予約の開始時刻から使い始めるものとして数える。
// 予約には「、」区切りの名前（例：「特殊電気治療、トレーニング」）と、
// 予約した時点の使用枠数（optionUse：{"特殊電気治療":2}）を保存する。
// 予約後にオプションの所要時間を変更しても、すでに入っている予約の枠数は変わらない。
const DEFAULT_OPTIONS = [
  { name: "特殊電気治療", duration: 30, capacity: null, showOnStory: true },
  { name: "トレーニング", duration: 30, capacity: null, showOnStory: true }
];
const OPTION_SEPARATOR = "、";
const OPTION_MAX_CAPACITY = 20;
const OPTION_DURATION_CHOICES = [10, 20, 30, 40, 50, 60, 90, 120];
function normalizeShowOnStory(v){ return !(v === false || String(v).toLowerCase() === "false"); }
function normalizeOption(o){
  if (typeof o === "string") { const n = o.trim(); return n ? { name: n, duration: 30, capacity: null, showOnStory: true } : null; }
  if (!o || !o.name) return null;
  const dur = Math.round(Number(o.duration));
  const hasCap = !(o.capacity === null || o.capacity === undefined || o.capacity === "");
  const cap = hasCap ? Number(o.capacity) : null;
  return {
    name: String(o.name).trim(),
    duration: (Number.isFinite(dur) && dur >= 5 && dur <= 480) ? dur : 30,
    capacity: (hasCap && Number.isInteger(cap) && cap >= 0 && cap <= OPTION_MAX_CAPACITY) ? cap : null,
    showOnStory: normalizeShowOnStory(o.showOnStory)
  };
}
// サーバーから来た一覧を {name, duration, capacity} の配列にそろえる（古い形式＝名前だけの文字列にも対応）。
// 配列でない（未対応の古いサーバー等）場合のみ初期値にする。空の配列は「全部削除した状態」なのでそのまま空として扱う。
function normalizeOptions(list){
  if(!Array.isArray(list)) return DEFAULT_OPTIONS.map(o => Object.assign({}, o));
  return list.map(normalizeOption).filter(o => o && o.name);
}
// いま有効なオプションの一覧。各ページが読み込み後・編集後に setOptionDefs で更新する。
let OPTION_DEFS = DEFAULT_OPTIONS.map(o => Object.assign({}, o));
function setOptionDefs(list){ OPTION_DEFS = normalizeOptions(list); }
function findOptionDef(name){ return OPTION_DEFS.find(o => o.name === name); }
// 予約ページに、オプションの所要時間（約◯分）を表示するか。スタッフページで切り替える（既定は表示する）。
// 表示しない場合も、時間の判定（枠の数え方）は、これまで通り所要時間をもとに行う。
let SHOW_OPTION_DURATION = true;
function setShowOptionDuration(v){ SHOW_OPTION_DURATION = !(v === false || v === "false" || v === 0 || v === "0"); }
function optionSlotCount(opt){ return Math.max(1, Math.ceil((Number(opt && opt.duration) || 30) / 30)); }
function optionCapacityLabel(opt){ return (opt.capacity === null || opt.capacity === undefined) ? "制限なし" : (opt.capacity === 0 ? "利用停止" : "同時に" + opt.capacity + "名まで"); }
function parseOptions(str){ return String(str||"").split(OPTION_SEPARATOR).map(s=>s.trim()).filter(Boolean); }
function joinOptions(arr){ return (arr||[]).join(OPTION_SEPARATOR); }

// 予約1件が使うオプションの枠数：{ "特殊電気治療": 2, ... }
// 予約時点の値（optionUse）があればそれを使う。古い予約など無い場合は、いまのオプション設定から求める。
function optionUseFor(b){
  let u = b && b.optionUse;
  if (typeof u === "string" && u) { try { u = JSON.parse(u); } catch (e) { u = null; } }
  if (u && typeof u === "object") return u;
  const out = {};
  parseOptions(b && b.options).forEach(n => { const d = findOptionDef(n); out[n] = d ? optionSlotCount(d) : 1; });
  return out;
}
// その日の、オプションごと・30分の枠ごとの使用人数：{ "特殊電気治療": { "9:00": 1, "9:30": 1 }, ... }
// excludeId を渡すと、その予約（編集中の予約など）は数えない。
function getOptionCountsForDate(date, bookings, excludeId){
  const slotsForDay = getSlotsForDate(date), out = {};
  (bookings || []).filter(b => b.date === date && (!excludeId || b.id !== excludeId)).forEach(b => {
    const use = optionUseFor(b);
    Object.keys(use).forEach(name => {
      const slots = getRequiredSlots(b.time, (Number(use[name]) || 1) * 30, slotsForDay) || [b.time];
      out[name] = out[name] || {};
      slots.forEach(t => { out[name][t] = (out[name][t] || 0) + 1; });
    });
  });
  return out;
}
// そのオプションを、start時刻から使えるか。診療時間の終わりや昼休みをまたぐ場合（reason:"time"）、
// 機械の都合の人数に達している場合（reason:"full"）は使えない。
function optionAvailability(date, start, opt, slotsForDay, optCounts){
  const req = getRequiredSlots(start, optionSlotCount(opt) * 30, slotsForDay);
  if (!req) return { ok: false, reason: "time", remaining: 0 };
  if (opt.capacity === null || opt.capacity === undefined) return { ok: true, reason: "", remaining: Infinity };
  const used = (optCounts && optCounts[opt.name]) || {};
  let remaining = Infinity;
  req.forEach(t => { remaining = Math.min(remaining, opt.capacity - (used[t] || 0)); });
  return { ok: remaining > 0, reason: remaining > 0 ? "" : "full", remaining };
}
// 一覧などに出す「初診 ＋ 特殊電気治療、トレーニング」の形
function menuLabel(b){ return (b.menu||"") + (b.options ? " ＋ " + b.options : ""); }
// 治療メニューの所要時間の表示。1枠＝30分。例：90分 → 「3枠（90分）」
function durationLabel(min){
  const m = Number(min) || 30;
  return Math.max(1, Math.round(m/30)) + "枠（" + m + "分）";
}

// ============================================================================
// 配色テーマ（標準 / 見やすい配色）
// 画面上部の「配色を切り替え」ボタンで切り替えられ、選んだ配色はその端末に記憶される。
// URLの末尾に ?theme=contrast（見やすい配色）または ?theme=standard（標準）を付けて開くと、
// その配色に切り替わる（確認用）。
// 全員の既定の配色を変えたい場合は、下のDEFAULT_THEMEを "contrast" に書き換えるだけでよい。
// ============================================================================
const THEME_KEY = "kohmura-seikotsuin-theme";
const DEFAULT_THEME = "standard"; // "standard"（標準）または "contrast"（見やすい配色）

const THEME_CSS = `
  #theme-bar{max-width:920px; margin:0 auto; padding:10px 20px 0; display:flex; justify-content:flex-end}
  #theme-toggle{border:1px solid var(--sub); background:var(--panel); color:var(--ink); border-radius:999px; padding:5px 14px; font-size:12px; font-family:inherit; cursor:pointer}

  html:root[data-palette="contrast"]{
    color-scheme:light;
    --bg:#FFFFFF; --panel:#FFFFFF; --ink:#111111; --sub:#333B45; --line:#6B7683;
    --teal:#005B4A; --teal-dark:#00392E; --amber:#8A3B00; --danger:#B00020;
  }
  html[data-palette="contrast"] body{background:#E4E8EC; font-size:16px}
  html[data-palette="contrast"] header p,
  html[data-palette="contrast"] #liff-banner{font-size:14px; color:#111}
  html[data-palette="contrast"] .card{border:1.5px solid #5B6773}
  html[data-palette="contrast"] .card h2{font-size:18px}
  html[data-palette="contrast"] label{font-size:15px; font-weight:700; color:#111}
  html[data-palette="contrast"] input,
  html[data-palette="contrast"] select,
  html[data-palette="contrast"] textarea{font-size:16px; border:1.5px solid #4B5563; background:#fff; color:#111}
  html[data-palette="contrast"] input:focus,
  html[data-palette="contrast"] select:focus,
  html[data-palette="contrast"] textarea:focus,
  html[data-palette="contrast"] button:focus-visible{outline:3px solid #1D4ED8; outline-offset:1px}
  html[data-palette="contrast"] ::placeholder{color:#59636E}
  html[data-palette="contrast"] .note{font-size:13px; color:#333B45}

  /* 文字を大きくした分、列が画面からはみ出さないよう、各列の幅の下限を0にして均等に割り振る */
  html[data-palette="contrast"] .grid > *{min-width:0}
  html[data-palette="contrast"] .dates{grid-template-columns:repeat(7,minmax(0,1fr)); gap:5px}
  html[data-palette="contrast"] .slots-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  html[data-palette="contrast"] .date-btn{border:1.5px solid #4B5563; background:#fff; color:#111; padding:8px 1px; min-width:0}
  html[data-palette="contrast"] .date-btn .dow{font-size:12px; color:#333B45}
  html[data-palette="contrast"] .date-btn .num{font-size:14px}
  html[data-palette="contrast"] .date-btn.selected{background:#005B4A; border-color:#00392E; color:#fff}
  html[data-palette="contrast"] .date-btn.selected .dow{color:#fff}
  html[data-palette="contrast"] .date-btn:disabled{opacity:1; background:#E1E5EA; border:1.5px dashed #B0B8C0; color:#6B7480}
  html[data-palette="contrast"] .date-btn:disabled .dow{color:#6B7480}

  html[data-palette="contrast"] .slot-group-label{font-size:14px; color:#111}
  html[data-palette="contrast"] .slot-btn{font-size:16px; border:1.5px solid #4B5563; background:#fff; color:#111; padding:11px 4px}
  html[data-palette="contrast"] .slot-btn.selected{background:#8A3B00; border-color:#5A2600; color:#fff}
  html[data-palette="contrast"] .slot-btn:disabled{opacity:1; background:#E1E5EA; border:1.5px dashed #B0B8C0; color:#6B7480; text-decoration:line-through}

  html[data-palette="contrast"] .submit-btn{font-size:17px}
  html[data-palette="contrast"] .submit-btn:disabled{background:#CDD3DA; color:#3F4954}
  html[data-palette="contrast"] .month-nav-btn,
  html[data-palette="contrast"] .small-btn,
  html[data-palette="contrast"] .edit-btn{border:1.5px solid #005B4A; color:#00392E; font-weight:700; background:#fff}
  html[data-palette="contrast"] .month-nav-btn:disabled{opacity:1; border-color:#B0B8C0; color:#6B7480; background:#E1E5EA}
  html[data-palette="contrast"] .cancel-btn{border:1.5px solid #B00020; color:#B00020; font-weight:700; background:#fff}
  html[data-palette="contrast"] .logout-btn{border:1.5px solid #4B5563; color:#111; background:#fff}

  html[data-palette="contrast"] .tab-btn{color:#333B45; font-size:15px; font-weight:700}
  html[data-palette="contrast"] .tab-btn.active{color:#00392E; border-bottom:3px solid #005B4A}
  html[data-palette="contrast"] .tabs{border-bottom:1.5px solid #5B6773}
  @media (max-width:560px){ html[data-palette="contrast"] .tab-btn{font-size:13px} }
  html[data-palette="contrast"] table{font-size:14px}
  html[data-palette="contrast"] th{color:#111; font-weight:700; background:#EEF1F4}
  html[data-palette="contrast"] th,
  html[data-palette="contrast"] td{border-bottom:1px solid #8A949F}
  html[data-palette="contrast"] .date-group-label{font-size:16px; color:#00392E; border-bottom:2px solid #005B4A}
  html[data-palette="contrast"] .menu-item{border:1.5px solid #4B5563; font-size:15px}
  html[data-palette="contrast"] label.opt-item{font-size:15px; font-weight:500; color:#111}
  html[data-palette="contrast"] .opt-item input{width:20px; height:20px}
  html[data-palette="contrast"] .empty{color:#333B45}
  html[data-palette="contrast"] .my-booking-row{border-bottom-color:#8A949F}
`;

function currentTheme(){
  try {
    const q = new URLSearchParams(location.search).get("theme");
    if (q === "contrast" || q === "standard") { localStorage.setItem(THEME_KEY, q); return q; }
    return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
  } catch (e) { return DEFAULT_THEME; }
}
function applyTheme(t){
  document.documentElement.setAttribute("data-palette", t === "contrast" ? "contrast" : "standard");
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = (t === "contrast") ? "標準の配色に戻す" : "見やすい配色にする";
}

if (typeof document !== "undefined") {
  const styleEl = document.createElement("style");
  styleEl.textContent = THEME_CSS;
  document.head.appendChild(styleEl);
  applyTheme(currentTheme()); // 画面が表示される前に反映して、一瞬だけ色が違って見えることを防ぐ

  document.addEventListener("DOMContentLoaded", ()=>{
    const bar = document.createElement("div");
    bar.id = "theme-bar";
    const btn = document.createElement("button");
    btn.id = "theme-toggle"; btn.type = "button";
    btn.addEventListener("click", ()=>{
      const next = (document.documentElement.getAttribute("data-palette") === "contrast") ? "standard" : "contrast";
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      applyTheme(next);
    });
    bar.appendChild(btn);
    document.body.insertBefore(bar, document.body.firstChild);
    applyTheme(currentTheme());
  });
}
