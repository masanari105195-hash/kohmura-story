#!/usr/bin/env python3
"""
こうむら接骨院：今日の予約状況を、Instagramストーリー用の画像（1080x1920のJPEG）にして、投稿を依頼するスクリプト。
GitHub Actions（.github/workflows/story.yml）から、毎朝自動で実行される。

  python make_story.py render    … 予約システムから今日の予約状況を取得し、stories/story-日付.jpg を作る
  python make_story.py post      … 画像が公開されたことを確かめて、Apps Script（Code.gs）に「ストーリーに投稿して」と依頼する
  python make_story.py preview 出力先フォルダ  … 見本画像（3つの配色×平日・土曜・休診日など）を作る（動作確認・配色選び用）

設定は、環境変数（GitHubの Settings → Secrets and variables → Actions に登録）で渡す。
  API_URL        予約システムのApps ScriptのURL（.../exec）                      ［必須：render / post］
  STORY_SECRET   Apps Scriptに登録した STORY_PUSH_SECRET と同じ合言葉             ［必須：post］
  SITE_URL       予約ページを公開しているURL（例 https://xxx.pages.dev）。common.jsをここから取得する
                 （未設定なら、このフォルダの common.js を使う）
  （画像の配色と、ストーリーに載せるオプションは、スタッフページで設定します。配色は、予約システムに保存された設定が最優先で、
   未設定の場合のみ、次の STORY_THEME を使います）
  STORY_THEME    milk（明るいミルク色）/ ocean（青緑）/ sunset（夕焼け）（既定 milk）
  STORY_CLINIC   院名（既定 こうむら接骨院）　STORY_HANDLE  Instagramのアカウント名（例 @koumura_b.c）
  STORY_CTA      案内文（既定 ご予約はプロフィールのリンクから）　STORY_NOTE  毎日出したい一言（任意）
"""
import os, sys, json, time, datetime, pathlib, urllib.request, urllib.error

HERE = pathlib.Path(__file__).resolve().parent
JST = datetime.timezone(datetime.timedelta(hours=9))
KEEP_DAYS = 7  # 古い画像は、リポジトリが大きくならないよう、この日数を過ぎたら削除する
THEMES = ("milk", "ocean", "sunset", "sakura", "lemon", "forest", "night")  # 標準の配色（common.js の STORY_BUILTIN_THEMES と同じ）


def choose_theme(data, cfg):
    """配色は、スタッフページで保存された設定（予約システム側）を最優先し、無ければ環境変数、それも無ければmilk"""
    for cand in (str(data.get("storyTheme") or "").strip(), cfg.get("theme", "")):
        if cand in THEMES:
            return cand
    return "milk"


def target_date():
    """投稿する日付（日本時間）。STORY_DATE（YYYY-MM-DD）を指定すれば、その日で作る（動作確認用）"""
    v = os.environ.get("STORY_DATE", "").strip()
    return v if v else datetime.datetime.now(JST).date().isoformat()


def http_get(url, timeout=60, retries=3):
    """Apps Scriptは起動直後に遅いことがあるので、少し待ってやり直す"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "kohmura-story/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # noqa
            last = e
            time.sleep(4 * (i + 1))
    raise RuntimeError("取得に失敗しました: %s (%s)" % (url, last))


REQUIRED_FUNCS = ("storyThemeIdFor", "storyFindTheme", "storyVarsFor", "storyImageHtml", "setOptionDefs", "optionUseFor", "isTrueValue", "getCountsForDate", "getRequiredSlots",
                  "setSlotCapacities", "capacityFor", "normalizeBooking", "setExtraClosures", "setExtraOpenDays")


def _missing_funcs(js):
    return [f for f in REQUIRED_FUNCS if ("function " + f) not in js]


def load_common_js():
    """common.js を探す。公開サイト(SITE_URL)のものが古く、story.html が使う関数が足りない場合は、
    このフォルダに置いた common.js（最新版）に自動で切り替える（古いままだと画像が作れないため）。"""
    p = os.environ.get("COMMON_JS_PATH", "").strip()
    if p:
        return pathlib.Path(p).read_text(encoding="utf-8")
    local = HERE / "common.js"
    local_js = local.read_text(encoding="utf-8") if local.exists() else ""
    site = os.environ.get("SITE_URL", "").strip().rstrip("/")
    if site:
        try:
            js = http_get(site + "/common.js")
            miss = _missing_funcs(js)
            if not miss:
                return js
            print("【注意】公開サイトの common.js が古いようです（不足: %s）。" % ", ".join(miss))
            print("        予約システム（Cloudflare Pages）にも、最新の common.js を上げてください。")
        except Exception as e:  # noqa
            print("【注意】公開サイトの common.js を取得できませんでした:", e)
    if local_js and not _missing_funcs(local_js):
        print("リポジトリ内の common.js を使います。")
        return local_js
    raise RuntimeError("使える最新の common.js がありません。最新の common.js をリポジトリ（story.html と同じ場所）にアップロードしてください。")


def config_from_env():
    return {
        "theme": os.environ.get("STORY_THEME", "").strip(),  # 空＝指定なし（予約システムの設定、無ければmilkを使う）
        "clinic": os.environ.get("STORY_CLINIC", "こうむら接骨院").strip() or "こうむら接骨院",
        "handle": os.environ.get("STORY_HANDLE", "").strip(),
        "cta": os.environ.get("STORY_CTA", "ご予約はプロフィールのリンクから").strip(),
        "note": os.environ.get("STORY_NOTE", "").strip(),
    }


def _render_once(payload, out_path, common_js, block_fonts):
    from playwright.sync_api import sync_playwright
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
            page.on("console", lambda m: logs.append("console.%s: %s" % (m.type, m.text)) if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: logs.append("pageerror: %s" % e))
            if block_fonts or os.environ.get("NO_WEB_FONTS"):  # Webフォントが取れない時は、入っているフォントで描く
                page.route("**/fonts.*/**", lambda r: r.abort())
            page.goto((HERE / "story.html").as_uri(), wait_until="domcontentloaded", timeout=60000)
            page.add_script_tag(content=common_js)
            try:
                page.evaluate("p => window.renderStory(p)", payload)
            except Exception as e:
                raise RuntimeError("画像の描画でエラーが出ました（common.js が古い可能性があります）: %s" % str(e)[:300])
            try:  # 背景画像の読み込み（デコード）を待つ
                page.evaluate("Promise.all(Array.from(document.images).map(i => i.decode().catch(() => null))).then(() => true)")
            except Exception:
                pass
            try:  # フォントの読み込みは最大8秒だけ待つ（待ち続けて固まらないように）
                page.evaluate("Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 8000))]).then(() => true)")
            except Exception:
                pass
            page.wait_for_timeout(600)
            # 描けているかの確認：時間の行（または休診のカード）が1つもなければ失敗扱いにする
            ok = page.evaluate("document.querySelectorAll('#content li, #content .closed').length")
            if not ok:
                raise RuntimeError("画像に内容が描かれていません。")
            page.screenshot(path=str(out_path), type="jpeg", quality=92, clip={"x": 0, "y": 0, "width": 1080, "height": 1920})
        finally:
            browser.close()
    for l in logs[:10]:
        print("  [ブラウザ]", l)


def render_image(payload, out_path, common_js):
    out_path = pathlib.Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt, block in enumerate((False, False, True), 1):  # 1回目・2回目：通常／3回目：Webフォントなし
        try:
            _render_once(payload, out_path, common_js, block)
            if out_path.exists() and out_path.stat().st_size > 20000:
                return out_path
            raise RuntimeError("画像ファイルが小さすぎます。")
        except Exception as e:  # noqa
            last = e
            print("画像づくり %d回目に失敗: %s" % (attempt, e))
    raise RuntimeError("画像を作れませんでした: %s" % last)


def cleanup_old(stories_dir):
    cutoff = datetime.datetime.now(JST).date() - datetime.timedelta(days=KEEP_DAYS)
    for f in pathlib.Path(stories_dir).glob("story-*.jpg"):
        try:
            d = datetime.date.fromisoformat(f.stem.replace("story-", ""))
        except ValueError:
            continue
        if d < cutoff:
            f.unlink()
            print("古い画像を削除:", f.name)


def resolve_theme_id(sc, date):
    """その日に使う配色のid（common.js の storyThemeIdFor と同じ決め方。weekly は月〜日の順）"""
    if sc.get("mode") == "fixed":
        return sc.get("fixedId") or "milk"
    wk = sc.get("weekly") or []
    d = datetime.date.fromisoformat(date)
    return wk[d.weekday()] if len(wk) == 7 and wk[d.weekday()] else "milk"


def fetch_story(api, date):
    """予約システム（スタッフページ）で設定した、曜日ごとの配色・自作配色・背景画像を取得する。
    取得できなければ（Code.gsが古い等）None を返し、従来の配色の決め方に戻す。背景画像だけ取れない場合は、画像なしで続ける。"""
    try:
        sc = json.loads(http_get(api + ("&" if "?" in api else "?") + "action=storyConfig"))
        if not sc.get("ok") or not isinstance(sc.get("weekly"), list):
            raise ValueError("storyConfig が使えません（Code.gs を最新にしてください）")
    except Exception as e:  # noqa
        print("【注意】配色の設定を取得できなかったため、従来の配色の決め方を使います:", str(e)[:150])
        return None
    tid = resolve_theme_id(sc, date)
    images = {}
    theme = next((t for t in sc.get("themes", []) if t.get("id") == tid), None)
    if theme and theme.get("image", {}).get("imageId"):
        iid = theme["image"]["imageId"]
        try:
            im = json.loads(http_get(api + ("&" if "?" in api else "?") + "action=storyImage&id=" + iid, timeout=90))
            if im.get("ok") and str(im.get("dataUrl", "")).startswith("data:image/"):
                images[iid] = im["dataUrl"]
            else:
                print("【注意】背景画像を取得できませんでした。画像なしで作ります。")
        except Exception as e:  # noqa
            print("【注意】背景画像を取得できませんでした。画像なしで作ります:", str(e)[:150])
    return {"config": {k: sc.get(k) for k in ("mode", "fixedId", "weekly", "themes")}, "images": images, "themeId": tid}


def cmd_render():
    api = os.environ.get("API_URL", "").strip()
    if not api:
        sys.exit("API_URL が設定されていません。")
    date = target_date()
    data = json.loads(http_get(api + ("&" if "?" in api else "?") + "action=availability"))
    if not data.get("ok") or not isinstance(data.get("bookings"), list):
        sys.exit("予約システムの応答が想定と違います（Code.gsが最新か確認してください）: %s" % str(data)[:200])
    out = HERE / "stories" / ("story-%s.jpg" % date)
    cfg = config_from_env()
    cfg["theme"] = choose_theme(data, cfg)  # 予約システムが古い場合の予備（従来の方法）
    story = fetch_story(api, date)
    print("配色:", (story or {}).get("themeId") or cfg["theme"])
    payload = {"today": date, "data": data, "config": cfg}
    if story:
        payload["story"] = {"config": story["config"], "images": story["images"]}
    render_image(payload, out, load_common_js())
    cleanup_old(HERE / "stories")
    print("作成しました:", out, "(%d KB)" % (out.stat().st_size // 1024))


def image_public_url(date):
    base = os.environ.get("IMAGE_BASE_URL", "").strip().rstrip("/")
    if not base:
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        branch = os.environ.get("GITHUB_REF_NAME", "main")
        base = "https://raw.githubusercontent.com/%s/%s" % (repo, branch)
    return "%s/stories/story-%s.jpg" % (base, date)


def wait_until_public(url, timeout_sec=150):
    """画像をアップロードした直後は、公開URLで見られるようになるまで数秒かかるので、見られるまで待つ"""
    end = time.time() + timeout_sec
    while time.time() < end:
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "kohmura-story/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def cmd_post():
    api = os.environ.get("API_URL", "").strip()
    secret = os.environ.get("STORY_SECRET", "").strip()
    if not api or not secret:
        sys.exit("API_URL と STORY_SECRET を設定してください。")
    date = target_date()
    url = image_public_url(date)
    print("画像のURL:", url)
    if os.environ.get("SKIP_PUBLIC_CHECK"):  # 動作確認用（実際の運用では使わない）
        print("（公開URLの確認を省略しました）")
    elif not wait_until_public(url):
        sys.exit("画像が公開URLで見られませんでした（リポジトリが「Public」か確認してください）: " + url)
    body = json.dumps({"action": "postStory", "secret": secret, "imageUrl": url, "date": date}).encode("utf-8")
    # Apps Scriptは、POSTを処理した後に応答を別URLへ転送するため、転送先を自動でたどる
    req = urllib.request.Request(api, data=body, headers={"Content-Type": "text/plain;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8")
    try:
        res = json.loads(text)
    except ValueError:
        sys.exit("Apps Scriptの応答がJSONではありません（デプロイが最新か確認してください）: " + text[:200])
    print("結果:", res)
    if not res.get("ok"):
        sys.exit("ストーリーの投稿に失敗しました: %s" % res.get("error"))


# ---------------- 見本づくり（配色選び・動作確認用） ----------------
SAMPLE_OPTIONS = [
    {"name": "特殊電気治療", "duration": 60, "capacity": 1, "showOnStory": True},
    {"name": "トレーニング", "duration": 30, "capacity": 2, "showOnStory": True},
    {"name": "温熱療法", "duration": 30, "capacity": None, "showOnStory": False},   # ストーリーには載せない設定の例
]


def sample_data(counts, extra=None, opts=None):
    """counts：{時間: 予約人数}。opts：[(時間, [オプション名, ...]), ...] を付けると、その枠にオプション付きの予約が1件ずつ入る"""
    bookings = []
    n = 0
    for t, c in counts.items():
        for _ in range(c):
            n += 1
            bookings.append({"id": "s%d" % n, "date": "SAMPLEDATE", "time": t, "duration": 30})
    for t, names in (opts or []):
        n += 1
        use = {}
        for name in names:
            d = next(o for o in SAMPLE_OPTIONS if o["name"] == name)
            use[name] = max(1, -(-d["duration"] // 30))
        bookings.append({"id": "o%d" % n, "date": "SAMPLEDATE", "time": t, "duration": 30,
                         "options": "、".join(names), "optionUse": use})
    d = {"bookings": bookings, "menu": [], "options": SAMPLE_OPTIONS, "closures": [], "openDays": [], "capacity": 3, "slotCapacities": []}
    d.update(extra or {})
    return d


def cmd_preview(outdir):
    outdir = pathlib.Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    common = load_common_js()
    scenarios = {
        "weekday":  ("2026-10-06", sample_data({"8:30": 1, "9:00": 2, "9:30": 1, "16:30": 3, "17:00": 3, "17:30": 2})),
        # オプションの予約がある日（60分のオプションは、次の枠まで ↓ で続く。非表示設定のオプションは載らない）
        "options":  ("2026-10-07", sample_data({"8:30": 1, "9:00": 1, "11:00": 1, "16:00": 2},
                                               opts=[("9:00", ["特殊電気治療"]), ("10:30", ["トレーニング"]), ("10:30", ["トレーニング"]),
                                                     ("11:00", ["特殊電気治療", "トレーニング"]), ("15:30", ["トレーニング"]),
                                                     ("17:00", ["特殊電気治療"]), ("17:30", ["温熱療法"])])),
        "saturday": ("2026-10-10", sample_data({"8:00": 3, "9:30": 2, "10:30": 1})),
        "closed":   ("2026-10-11", sample_data({})),
        "partial":  ("2026-10-07", sample_data({"8:30": 2}, {"closures": [{"date": "2026-10-07", "ranges": [{"start": "10:00", "end": "12:00"}]}]})),
    }
    only = os.environ.get("PREVIEW_ONLY", "")
    for theme in THEMES:
        for name, (date, data) in scenarios.items():
            if only and only != name:
                continue
            if theme in ("sakura", "lemon", "forest", "night") and name not in ("weekday", "options", "closed"):
                continue  # 新しい4色は、主な3パターンだけ確認用に作る
            d = json.loads(json.dumps(data).replace("SAMPLEDATE", date))
            cfg = {"theme": theme, "handle": "@koumura_b.c"}
            out = outdir / ("preview-%s-%s.jpg" % (theme, name))
            render_image({"today": date, "data": d, "config": cfg}, out, common)
            print("作成:", out.name)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "render":
        cmd_render()
    elif cmd == "post":
        cmd_post()
    elif cmd == "preview":
        cmd_preview(sys.argv[2] if len(sys.argv) > 2 else "preview")
    else:
        sys.exit(__doc__)
