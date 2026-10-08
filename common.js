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


// =====================================================================
// Instagramストーリー画像の配色（標準7色＋スタッフが作る配色）、曜日ごとの切り替え、背景画像
//   ・ストーリー画像（story.html）とスタッフページのプレビューで、同じ関数を使う
//   ・Code.gs の STORY_* と同じ上限・同じ項目にすること
// =====================================================================
const STORY_MAX_THEMES = 15;     // 標準＋自作の合計の上限
const STORY_NAME_MAX = 12;       // 配色の名前の最大文字数
const STORY_IMAGE_POS = ["tl","tc","tr","ml","mc","mr","bl","bc","br"]; // 9分割の位置（上/中/下 × 左/中央/右）
const STORY_COLOR_KEYS = ["bgTop","bgMid","bgBottom","ink","ok","few","cardColor"];
const STORY_WEEK_LABELS = ["月","火","水","木","金","土","日"];

function storyHex_(v, fb){ return /^#[0-9a-f]{6}$/i.test(String(v||"")) ? String(v).toLowerCase() : fb; }
function storyRgb_(hex){ const h = storyHex_(hex, "#000000"); return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }
function storyRgba_(hex, a){ const c = storyRgb_(hex); return "rgba("+c[0]+","+c[1]+","+c[2]+","+(Math.round(a*100)/100)+")"; }
function storyMix_(h1, h2, t){ // h1 と h2 を t:(1-t) で混ぜた色
  const a = storyRgb_(h1), b = storyRgb_(h2);
  return "#" + [0,1,2].map(i => ("0" + Math.round(a[i]*t + b[i]*(1-t)).toString(16)).slice(-2)).join("");
}
function storyLum_(hex){
  const c = storyRgb_(hex).map(v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
  return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
}
function storyContrast_(h1, h2){
  const a = storyLum_(h1), b = storyLum_(h2);
  return (Math.max(a,b)+0.05) / (Math.min(a,b)+0.05);
}

// 標準の配色。vars があるものは、その見た目をそのまま使う（f は「複製して作る」ときの元になる色）
const STORY_BUILTIN_THEMES = [
  { id:"milk", name:"ミルク", builtin:true,
    f:{ bgTop:"#f7fbf9", bgMid:"#e0f3ec", bgBottom:"#fdf1e0", ink:"#1d3a33", ok:"#1f9d74", few:"#d98a16", cardColor:"#ffffff", cardAlpha:72 },
    vars:{ "--bg":"linear-gradient(165deg,#f7fbf9 0%,#e0f3ec 48%,#fdf1e0 100%)",
      "--blob1":"rgba(110,205,170,.34)", "--blob2":"rgba(255,196,120,.34)", "--blob3":"rgba(130,190,235,.26)",
      "--ink":"#1d3a33", "--sub":"#4f6b63", "--card":"rgba(255,255,255,.72)", "--cardline":"rgba(47,111,98,.20)", "--rowline":"rgba(47,111,98,.20)",
      "--ok":"#1f9d74", "--few":"#d98a16", "--full":"#93a69d", "--accent":"#2f6f62", "--chip":"rgba(47,111,98,.10)", "--glow-ok":"none", "--glow-few":"none" } },
  { id:"ocean", name:"青緑", builtin:true,
    f:{ bgTop:"#052a40", bgMid:"#0f7f94", bgBottom:"#86e3b4", ink:"#ffffff", ok:"#9bf6c4", few:"#ffd166", cardColor:"#ffffff", cardAlpha:13 },
    vars:{ "--bg":"linear-gradient(165deg,#052a40 0%,#0a5c7a 34%,#0f9ea3 68%,#86e3b4 100%)",
      "--blob1":"rgba(134,239,196,.38)", "--blob2":"rgba(255,226,140,.30)", "--blob3":"rgba(120,200,255,.28)",
      "--ink":"#ffffff", "--sub":"rgba(255,255,255,.78)", "--card":"rgba(255,255,255,.13)", "--cardline":"rgba(255,255,255,.38)", "--rowline":"rgba(255,255,255,.28)",
      "--ok":"#9bf6c4", "--few":"#ffd166", "--full":"rgba(255,255,255,.50)", "--accent":"#ffffff", "--chip":"rgba(255,255,255,.18)",
      "--glow-ok":"drop-shadow(0 0 10px rgba(155,246,196,.45))", "--glow-few":"drop-shadow(0 0 10px rgba(255,209,102,.45))" } },
  { id:"sunset", name:"夕焼け", builtin:true,
    f:{ bgTop:"#34195f", bgMid:"#b2557f", bgBottom:"#ffbf8b", ink:"#ffffff", ok:"#c3fadc", few:"#ffe38e", cardColor:"#ffffff", cardAlpha:14 },
    vars:{ "--bg":"linear-gradient(165deg,#34195f 0%,#a24b8a 38%,#f0777f 70%,#ffbf8b 100%)",
      "--blob1":"rgba(255,214,170,.40)", "--blob2":"rgba(255,120,170,.34)", "--blob3":"rgba(150,120,255,.30)",
      "--ink":"#ffffff", "--sub":"rgba(255,255,255,.82)", "--card":"rgba(255,255,255,.14)", "--cardline":"rgba(255,255,255,.40)", "--rowline":"rgba(255,255,255,.30)",
      "--ok":"#c3fadc", "--few":"#ffe38e", "--full":"rgba(255,255,255,.52)", "--accent":"#ffffff", "--chip":"rgba(255,255,255,.20)",
      "--glow-ok":"drop-shadow(0 0 10px rgba(195,250,220,.45))", "--glow-few":"drop-shadow(0 0 10px rgba(255,227,142,.45))" } },
  { id:"sakura", name:"さくら", builtin:true,
    f:{ bgTop:"#fff6f8", bgMid:"#ffe2ec", bgBottom:"#fff0dd", ink:"#4a2a36", ok:"#d63f7a", few:"#e0881a", cardColor:"#ffffff", cardAlpha:70 } },
  { id:"lemon", name:"レモン", builtin:true,
    f:{ bgTop:"#fffdf0", bgMid:"#fff3b8", bgBottom:"#e4f5d4", ink:"#3b3a14", ok:"#3c8d2b", few:"#d9701a", cardColor:"#ffffff", cardAlpha:70 } },
  { id:"forest", name:"森", builtin:true,
    f:{ bgTop:"#0d2a21", bgMid:"#1f5d47", bgBottom:"#7fb892", ink:"#ffffff", ok:"#b9f6d2", few:"#ffdc8a", cardColor:"#ffffff", cardAlpha:12 } },
  { id:"night", name:"夜空", builtin:true,
    f:{ bgTop:"#0a0f2e", bgMid:"#1c2a68", bgBottom:"#4a5fb0", ink:"#ffffff", ok:"#9fe9ff", few:"#ffd166", cardColor:"#ffffff", cardAlpha:12 } }
];
const STORY_DEFAULT_WEEKLY = ["milk","ocean","sunset","sakura","lemon","forest","night"]; // 月〜日

// 色の設定（f）から、画面で使う変数を作る
function storyDeriveVars(f){
  const light = storyLum_(f.ink) > 0.5; // 文字が明るい色＝暗い背景の配色。◯△にほんのり光を付ける
  return {
    "--bg":"linear-gradient(165deg,"+f.bgTop+" 0%,"+f.bgMid+" 50%,"+f.bgBottom+" 100%)",
    "--blob1":storyRgba_(f.ok,.30), "--blob2":storyRgba_(f.few,.30), "--blob3":storyRgba_(storyMix_(f.ok,f.few,.5),.24),
    "--ink":f.ink, "--sub":storyRgba_(f.ink,.74),
    "--card":storyRgba_(f.cardColor, f.cardAlpha/100), "--cardline":storyRgba_(f.ink,.22), "--rowline":storyRgba_(f.ink,.20),
    "--ok":f.ok, "--few":f.few, "--full":storyRgba_(f.ink,.42), "--accent":f.ok, "--chip":storyRgba_(f.ink,.10),
    "--glow-ok":light ? "drop-shadow(0 0 10px "+storyRgba_(f.ok,.45)+")" : "none",
    "--glow-few":light ? "drop-shadow(0 0 10px "+storyRgba_(f.few,.45)+")" : "none"
  };
}
function storyVarsFor(theme){ return theme.vars || storyDeriveVars(theme.f); }
function storyVarsToStyle(vars){ return Object.keys(vars).map(k => k + ":" + vars[k]).join(";"); }

// 自作配色の入力を、安全な形に整える（足りない・不正な項目は、ミルクの値で埋める）
function storyNormalizeTheme(t){
  t = t || {};
  const base = STORY_BUILTIN_THEMES[0].f, src = t.f || {};
  const f = {};
  STORY_COLOR_KEYS.forEach(k => { f[k] = storyHex_(src[k], base[k]); });
  const ca = Math.round(Number(src.cardAlpha)); f.cardAlpha = (ca >= 0 && ca <= 100) ? ca : base.cardAlpha;
  const out = { id:String(t.id || "").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,40), name:String(t.name || "").trim().slice(0, STORY_NAME_MAX), f:f };
  const im = t.image;
  if (im && typeof im === "object" && String(im.imageId || "").replace(/[^a-zA-Z0-9_-]/g,"")) {
    const size = Math.round(Number(im.size)), op = Math.round(Number(im.opacity)), ov = Math.round(Number(im.overlay));
    out.image = {
      imageId: String(im.imageId).replace(/[^a-zA-Z0-9_-]/g,"").slice(0,40),
      mode: im.mode === "cover" ? "cover" : "logo",
      pos: STORY_IMAGE_POS.indexOf(im.pos) !== -1 ? im.pos : "mc",
      size: (size >= 10 && size <= 100) ? size : 50,
      opacity: (op >= 5 && op <= 100) ? op : 100,
      overlay: (ov >= 0 && ov <= 90) ? ov : 0
    };
  }
  return out;
}
// 標準7色＋自作配色。自作配色の id が標準と重なるものは無視する
function storyAllThemes(customList){
  const out = STORY_BUILTIN_THEMES.slice();
  (Array.isArray(customList) ? customList : []).forEach(c => {
    const n = storyNormalizeTheme(c);
    if (n.id && n.name && !out.some(o => o.id === n.id) && out.length < STORY_MAX_THEMES) out.push(n);
  });
  return out;
}
function storyFindTheme(id, customList){
  const all = storyAllThemes(customList);
  return all.find(t => t.id === id) || all[0]; // 見つからない（削除済みなど）ときは、ミルク
}
function storyDefaultConfig(){ return { mode:"weekly", fixedId:"milk", weekly:STORY_DEFAULT_WEEKLY.slice(), themes:[] }; }
function storyNormalizeConfig(raw){
  const d = storyDefaultConfig(), r = (raw && typeof raw === "object") ? raw : {};
  const themes = (Array.isArray(r.themes) ? r.themes : []).map(storyNormalizeTheme).filter(t => t.id && t.name);
  const ids = storyAllThemes(themes).map(t => t.id);
  const okId = v => ids.indexOf(v) !== -1 ? v : "milk";
  const weekly = [];
  for (let i = 0; i < 7; i++) weekly.push(okId(Array.isArray(r.weekly) && r.weekly[i] ? r.weekly[i] : d.weekly[i]));
  return { mode: r.mode === "fixed" ? "fixed" : "weekly", fixedId: okId(r.fixedId || d.fixedId), weekly:weekly, themes:themes };
}
// その日（YYYY-MM-DD）に使う配色の id。weekly は月〜日の順
function storyThemeIdFor(cfg, dateISO){
  const c = storyNormalizeConfig(cfg);
  if (c.mode === "fixed") return c.fixedId;
  const dow = new Date(dateISO + "T00:00:00").getDay(); // 0=日
  return c.weekly[(dow + 6) % 7];
}
// 配色の読みにくさのチェック。戻り値：注意の文章の配列（空なら問題なし）
function storyCheckColors(f){
  const warn = [];
  const card = storyMix_(f.cardColor, f.bgMid, f.cardAlpha/100); // カードの上の実際の色
  const worstText = Math.min(storyContrast_(f.ink, card), storyContrast_(f.ink, f.bgTop), storyContrast_(f.ink, f.bgMid));
  if (worstText < 3.5) warn.push("文字の色が、背景やカードの色と近く、読みにくい可能性があります。");
  if (storyContrast_(f.ok, card) < 2.2) warn.push("「◯」の色が、カードの色と近く、見えにくい可能性があります。");
  if (storyContrast_(f.few, card) < 2.2) warn.push("「△」の色が、カードの色と近く、見えにくい可能性があります。");
  return warn;
}
// 背景画像の表示（HTML）。ロゴなどを置く「logo」と、全面に敷く「cover」。位置は画面に対する割合で指定するので、縮小したプレビューでも同じ見た目になる。
// 上下の端はInstagramの表示と重なるため、少し内側（上14％・下15.5％）に置く。
function storyImageHtml(theme, dataUrl){
  const im = theme && theme.image;
  if (!im || !dataUrl) return "";
  const v = im.pos.charAt(0), h = im.pos.charAt(1), op = im.opacity/100;
  if (im.mode === "cover") {
    const objPos = (h === "l" ? "left" : h === "r" ? "right" : "center") + " " + (v === "t" ? "top" : v === "b" ? "bottom" : "center");
    const mid = storyVarsFor(theme)["--bg"] ? theme.f.bgMid : "#ffffff";
    return '<div class="bgimg" style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden">'
      + '<img src="'+dataUrl+'" alt="" style="width:100%;height:100%;object-fit:cover;object-position:'+objPos+';opacity:'+op+'">'
      + (im.overlay > 0 ? '<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:'+storyRgba_(mid, im.overlay/100)+'"></div>' : '')
      + '</div>';
  }
  let st = "position:absolute;width:"+im.size+"%;height:auto;max-height:62%;object-fit:contain;opacity:"+op+";";
  const tf = [];
  if (h === "l") st += "left:5.5%;"; else if (h === "r") st += "right:5.5%;"; else { st += "left:50%;"; tf.push("translateX(-50%)"); }
  if (v === "t") st += "top:14%;"; else if (v === "b") st += "bottom:15.5%;"; else { st += "top:50%;"; tf.push("translateY(-50%)"); }
  if (tf.length) st += "transform:" + tf.join(" ") + ";";
  return '<div class="bgimg" style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden"><img src="'+dataUrl+'" alt="" style="'+st+'"></div>';
}
