/* ══════════════════════════════════════════════════════════════════════
   trendview.js — 추세선·박스·돌파 트리거를 '계산으로' 긋고 캔버스에 그린다.

   파이썬 screener/trend.py · screener/breakout.py 와 같은 알고리즘이다.
   브라우저로 옮긴 이유는 종목을 펼칠 때마다 바로 보여야 하기 때문.
   (market/* 엔드포인트는 CORS 가 열려 있어 브라우저에서 직접 호출된다.
    rubik/stat/* 은 안 열려 있으니 여기서 쓰지 말 것.)

   판단에 쓰는 숫자는 셋이다:
     · 터치 수     — 2회짜리는 '선'이 아니라 '두 점'이다
     · 앞 70% 검증 — 지나고 나서 그은 선은 항상 맞는다. 앞 70%로 긋고 뒤에서 확인
     · 가짜 돌파율 — 뚫고 바로 되돌아온 비율. 높으면 돌파매매 금지 = 거미줄 적합
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  const C = {
    gain: "#2FD08A", loss: "#F2605C", accent: "#8B7CFF",
    ink: "#F2F4F9", ink3: "#828B9E", edge: "rgba(255,255,255,.075)",
    ground: "#0A0C11", warn: "#E8B84B",
  };

  const BAR_MIN = { "1m":1, "3m":3, "5m":5, "15m":15, "30m":30,
                    "1H":60, "2H":120, "4H":240, "1D":1440 };
  const FEE = 0.001;                       // 테이커 왕복 0.1% (우리 실측 수준)

  /* ── 스윙 피벗 ─────────────────────────────────────────────────────
     좌우 k봉보다 높은(낮은) 자리만 스윙으로 인정한다. */
  function pivots(v, k, high) {
    const out = [];
    for (let i = k; i < v.length - k; i++) {
      let ok = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (high ? v[j] > v[i] : v[j] < v[i]) { ok = false; break; }
      }
      if (ok && (!out.length || i - out[out.length - 1] > k)) out.push(i);
    }
    return out;
  }

  /* ── 껍질선 ────────────────────────────────────────────────────────
     모든 피벗을 한쪽에 두면서 가장 타이트한 직선. 두 점 조합을 전수 탐색.
     피벗은 보통 20~40개라 O(n^2) 이어도 체감되지 않는다. */
  function hull(xs, ys, upper) {
    let best = null;
    for (let a = 0; a < xs.length; a++) {
      for (let b = a + 1; b < xs.length; b++) {
        if (xs[b] === xs[a]) continue;
        const m = (ys[b] - ys[a]) / (xs[b] - xs[a]);
        const c = ys[a] - m * xs[a];
        let bad = false, err = 0;
        for (let i = 0; i < xs.length; i++) {
          const r = ys[i] - (m * xs[i] + c);
          if (upper ? r > 1e-12 : r < -1e-12) { bad = true; break; }
          err += Math.abs(r);
        }
        if (!bad && (best === null || err < best.err)) best = { m, c, err };
      }
    }
    return best ? { m: best.m, c: best.c } : null;
  }

  function regression(ys) {
    const n = ys.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
    const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const c = (sy - m * sx) / n;
    let s = 0;
    for (let i = 0; i < n; i++) s += (ys[i] - (m * i + c)) ** 2;
    return { m, c, sd: Math.sqrt(s / n) };
  }

  const atrOf = (cs, n) => {
    const a = cs.slice(-n);
    return a.reduce((t, k) => t + (k.h - k.l), 0) / a.length;
  };

  /* 선에 닿았을 때 실제로 튕겼는가.
     껍질선은 정의상 모든 피벗 바깥이라 '종가 돌파'는 표본이 0으로만 나온다.
     그래서 돌파가 아니라 '접근 후 반응'을 센다. */
  function react(cs, L, upper, horizon, tol) {
    let hit = 0, won = 0, last = -99;
    for (let i = 0; i < cs.length - horizon; i++) {
      const line = L.m * i + L.c;
      const v = upper ? cs[i].h : cs[i].l;
      if (Math.abs(v - line) > tol || i - last < horizon / 2) continue;
      last = i; hit++;
      const moved = cs[i + horizon].c - cs[i].c;
      if (upper ? moved < 0 : moved > 0) won++;
    }
    return { hit, won };
  }

  /* 앞 70%로 선을 긋고 뒤 30%에서 지켜졌는지 — 진짜 검증은 이쪽이다. */
  function oos(cs, k, upper, frac) {
    const cut = Math.floor(cs.length * (frac || 0.7));
    const v = cs.slice(0, cut).map(x => upper ? x.h : x.l);
    const pv = pivots(v, k, upper);
    if (pv.length < 2) return null;
    const L = hull(pv, pv.map(i => v[i]), upper);
    if (!L) return null;
    let broke = 0;
    for (let i = cut; i < cs.length; i++) {
      const line = L.m * i + L.c;
      if (upper ? cs[i].c > line : cs[i].c < line) broke++;
    }
    return { broke, of: cs.length - cut };
  }

  /* ── 박스 + 돌파 ───────────────────────────────────────────────────
     직전 win 봉 폭이 maxw 이하이면 횡보로 본다. 돌파 트리거는 그 경계. */
  function boxAt(cs, i, win) {
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, i - win); j < i; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); }
    const mid = (hi + lo) / 2;
    return { hi, lo, mid, width: mid ? (hi - lo) / mid : 0 };
  }

  function simulate(cs, i, entry, stop, target, horizon, long) {
    for (let j = i + 1; j < Math.min(i + 1 + horizon, cs.length); j++) {
      if (long) {
        if (cs[j].l <= stop) return -1;
        if (cs[j].h >= target) return 1;
      } else {
        if (cs[j].h >= stop) return -1;
        if (cs[j].l <= target) return 1;
      }
    }
    const j = Math.min(i + horizon, cs.length - 1);
    const risk = Math.abs(entry - stop);
    return risk ? ((long ? cs[j].c - entry : entry - cs[j].c) / risk) : 0;
  }

  function breakouts(cs, o, long) {
    const { win, maxw, buf, rr, horizon } = o;
    const rs = []; let fake = 0, last = -99;
    for (let i = win; i < cs.length - 1; i++) {
      const b = boxAt(cs, i, win);
      if (b.width > maxw || i - last < win / 2) continue;
      const trig = long ? b.hi * (1 + buf) : b.lo * (1 - buf);
      if (long ? cs[i].c <= trig : cs[i].c >= trig) continue;
      last = i;
      const entry = cs[i].c, stop = long ? b.lo : b.hi;
      const risk = Math.abs(entry - stop);
      if (!risk) continue;
      const target = long ? entry + rr * risk : entry - rr * risk;
      rs.push(simulate(cs, i, entry, stop, target, horizon, long) - (entry * FEE) / risk);
      for (let j = i + 1; j <= Math.min(i + Math.floor(win / 2), cs.length - 1); j++) {
        if (long ? cs[j].c < b.hi : cs[j].c > b.lo) { fake++; break; }
      }
    }
    return { rs, fake };
  }

  /* 대조군 — 아무 자리에서나 같은 손절폭(ATR)으로 같은 규칙을 돌린다.
     돌파 승률 50% 는 대조군이 50% 면 아무 의미가 없다. */
  function control(cs, o, long) {
    const atr = atrOf(cs, cs.length);
    const rs = [];
    let seed = 20260912;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 400; t++) {
      const i = 30 + Math.floor(rnd() * (cs.length - o.horizon - 33));
      const entry = cs[i].c;
      const stop = long ? entry - atr : entry + atr;
      const target = long ? entry + o.rr * atr : entry - o.rr * atr;
      rs.push(simulate(cs, i, entry, stop, target, o.horizon, long) - (entry * FEE) / atr);
    }
    return rs;
  }

  function stats(rs) {
    if (!rs.length) return { n: 0 };
    const n = rs.length;
    const exp = rs.reduce((a, b) => a + b, 0) / n;
    const win = rs.filter(x => x > 0).length / n;
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - exp) ** 2, 0) / Math.max(1, n - 1));
    const se = sd / Math.sqrt(n);
    return { n, win, exp, lo: exp - 1.96 * se, hi: exp + 1.96 * se };
  }

  /* ── 박스권 ────────────────────────────────────────────────────────
     "최근 20봉"으로 자르면 박스가 언제부터 유지됐는지를 못 본다.
     현재 봉에서 과거로 한 봉씩 넓히다가 폭이 기준을 넘기 직전에서 멈춘다 —
     그게 지금 살아 있는 박스다. 거미줄은 이 박스 안에서만 돈이 된다. */
  function currentBox(cs, maxw, minBars) {
    let hi = -Infinity, lo = Infinity, best = null;
    for (let back = 1; back <= cs.length; back++) {
      const k = cs[cs.length - back];
      const nh = Math.max(hi, k.h), nl = Math.min(lo, k.l);
      const mid = (nh + nl) / 2;
      const wid = mid ? (nh - nl) / mid : 0;
      if (wid > maxw && back > minBars) break;
      hi = nh; lo = nl;
      if (back >= minBars) best = { hi, lo, mid, width: wid, bars: back };
    }
    if (!best) return null;

    /* 박스 안에서 몇 번 왕복했나.
       끝단 터치로 세면 넓은 박스에서 거의 0이 나온다(10% 박스의 1/6 은 1.67%라
       가격이 거기까지 안 간다). 그래서 **중앙선 교차**로 센다 — 위아래를 오간 횟수.
       ±10% 완충을 둬서 중앙선에 붙어 떠는 노이즈는 제외한다. */
    const seg = cs.slice(cs.length - best.bars);
    const h = best.hi - best.lo, mid = (best.hi + best.lo) / 2, dead = h * 0.1;
    let side = 0, laps = 0, touchHi = 0, touchLo = 0, path = 0;
    for (let i = 0; i < seg.length; i++) {
      const k = seg[i];
      if (i) path += Math.abs(k.c - seg[i - 1].c);
      if (k.h >= best.hi - h * 0.15) touchHi++;
      if (k.l <= best.lo + h * 0.15) touchLo++;
      if (k.c > mid + dead) { if (side === -1) laps++; side = 1; }
      else if (k.c < mid - dead) { if (side === 1) laps++; side = -1; }
    }
    /* 거미줄의 수익원은 '박스 끝에서 끝까지'가 아니라 **주문 간격 하나를 넘나드는 것**이다.
       그래서 누적 경로를 주문 간격(폭/60)으로 나눈다 = 기대 익절 횟수.
       중앙선 왕복 3회짜리 박스도 이 값은 수백이 될 수 있고, 실제 체결도 그렇게 난다
       (김현우 9/10 IOST 2.5시간 75건). */
    best.path = path;
    best.sweeps = h ? path / h : 0;
    best.fills = h ? path / (h / 60) : 0;          // 60개 사다리 기준 기대 체결 수
    best.laps = laps; best.touchHi = touchHi; best.touchLo = touchLo;
    best.pos = (cs[cs.length - 1].c - best.lo) / (best.hi - best.lo);   // 0=하단 1=상단
    return best;
  }

  /* 우리가 찾는 것: 폭이 충분히 넓고(사다리를 칠 값이 있고) 그 안에서 자주 왕복하는 박스.
     좁은 박스는 주문 간격이 최소 TP(0.05%) 밑으로 내려가 수수료만 나가고,
     넓어도 왕복이 없으면 한쪽만 체결돼 물량만 쌓인다. 둘 다 봐야 한다. */
  function grade(box, perH, dir, o) {
    if (!box) return { ok: false, why: "박스권이 잡히지 않습니다 — 한 방향으로 흐르는 구간입니다" };
    const hours = box.bars / perH;
    const fph = hours ? box.fills / hours : 0;      // 시간당 기대 익절 횟수
    const lph = hours ? box.laps / hours : 0;
    const minw = o.minw || 0.03, minf = o.minf || 25, minlap = o.minlap || 3;
    const wide = box.width >= minw;
    /* '자주 왔다갔다' 판정. 전 종목(154개) 실측 분포에서 시간당 체결의 중앙값이 19건이라
       10건으로는 63%가 통과해 필터 구실을 못 했다. 상위 15% 선인 25건으로 올렸다.
       왕복(중앙선 교차)을 같이 보는 이유: 이게 빠지면 박스 위쪽에 붙어 흐르기만 하는
       종목이 체결 수만 높아서 통과한다 — LAB·BEAT·RIVER 가 위치 83~91%에 왕복 1회였다. */
    const busy = fph >= minf && box.laps >= minlap;
    const wiggly = dir < 0.13;
    const why = !wide
        ? `박스 폭 ${(box.width * 100).toFixed(2)}% — 기준 ${(minw * 100).toFixed(0)}% 미만이라 주문 간격이 수수료에 먹힙니다`
      : box.laps < minlap
        ? `왕복 ${box.laps}회 — 박스 한쪽에 붙어 흐르는 중입니다 (기준 ${minlap}회)`
      : !busy
        ? `시간당 기대 체결 ${fph.toFixed(0)}건 — 되돌림이 부족합니다 (기준 ${minf}건)`
      : !wiggly
        ? `방향성 ${dir.toFixed(3)} — 한 방향 흐름이 강합니다 (기준 0.13 미만)`
      : `폭 ${(box.width * 100).toFixed(2)}% · ${hours.toFixed(1)}시간 유지 · 왕복 ${box.laps}회 · 시간당 기대 체결 ${fph.toFixed(0)}건`;
    return { ok: wide && busy && wiggly, wide, busy, wiggly, hours, lph, fph, why,
             minw, minf, minlap };
  }

  /* ── 추세돌파 판정 ─────────────────────────────────────────────────
     박스매매와 정반대의 종목을 찾는다. 우리 팀 기준으로는:
       · 수동매매 — 트리거를 뚫으면 방향을 따라간다
       · 거미줄   — 칠 수는 있지만 박스형과 세팅이 달라야 한다
                    (폭 전체가 아니라 트리거~목표 구간, 개수·간격을 좁게)

     조건이 박스형과 대칭이 아닌 이유: '추세가 있다'만으로는 부족하고
     **뚫었을 때 되돌아오지 않아야** 쓸 수 있다. 그래서 가짜 돌파율을 같이 본다. */
  function gradeTrend(M, o) {
    const dir = M.dir;
    const slope = M.reg.m * M.perH / M.last * 100;          // 시간당 %
    const fake = (M.bo.long.fake + M.bo.short.fake) / 2;
    const upGap = (M.trigUp / M.last - 1) * 100;
    const dnGap = (M.trigDn / M.last - 1) * 100;
    const near = Math.min(Math.abs(upGap), Math.abs(dnGap));
    const side = Math.abs(upGap) <= Math.abs(dnGap) ? "up" : "dn";

    const maxFake = o.maxFake == null ? 0.5 : o.maxFake;
    const maxNear = o.maxNear == null ? 2.0 : o.maxNear;
    const minSlope = o.minSlope == null ? 0.15 : o.minSlope;

    const trending = dir >= 0.13 || Math.abs(slope) >= minSlope;
    const clean = fake < maxFake;                            // 뚫고 되돌아오지 않는가
    const ready = near <= maxNear;                           // 지금 대기할 자리인가

    /* 돌파 진입이 '아무 자리 진입'보다 나았는지 — 표본이 적으면 참고만 한다 */
    const b = side === "up" ? M.bo.long : M.bo.short;
    const edge = b.n ? b.exp - b.ctl.exp : 0;

    const why = !trending
        ? `방향성 ${dir.toFixed(3)} · 기울기 ${slope.toFixed(2)}%/h — 추세가 없습니다`
      : !clean
        ? `가짜 돌파 ${(fake * 100).toFixed(0)}% — 뚫어도 되돌아옵니다 (기준 ${(maxFake * 100).toFixed(0)}% 미만)`
      : !ready
        ? `트리거까지 ${near.toFixed(1)}% — 아직 멉니다 (기준 ${maxNear}% 이내)`
        : `${side === "up" ? "상단" : "하단"} 트리거 ${near.toFixed(2)}% 앞 · 가짜 돌파 ${(fake * 100).toFixed(0)}% · 기울기 ${slope.toFixed(2)}%/h`;

    return { ok: trending && clean && ready, trending, clean, ready,
             slope, fake, side, near, upGap, dnGap, edge, n: b.n, why };
  }

  /* 박스를 그대로 거미줄 세팅으로 바꾼다 (주문 60개 고정). */
  function ladder(box, orders) {
    if (!box) return null;
    const n = orders || 60;
    const span = box.width * 100;             // 전체 폭 %
    return { span, gap: span / n, orders: n,
             top: box.hi, bot: box.lo,
             minTp: Math.max(0.05, span / n) };
  }

  /* 되돌림/방향성 — 거미줄 적합도. 0.13 미만이면 잔파동. */
  function wiggle(cs) {
    let tot = 0;
    for (let i = 1; i < cs.length; i++) tot += Math.abs(cs[i].c - cs[i - 1].c);
    const net = Math.abs(cs[cs.length - 1].c - cs[0].c);
    return { dir: tot ? net / tot : 0, path: tot };
  }

  /* ── 모델 ─────────────────────────────────────────────────────────── */
  function analyse(cs, bar, opt) {
    const o = Object.assign({ k: 5, win: 20, minw: 0.03, minf: 25, minlap: 3, maxw: 0.12, buf: 0.001, rr: 1.5, hours: 4 }, opt);
    const perH = 60 / (BAR_MIN[bar] || 15);   // 시간당 봉 수
    o.horizon = Math.max(4, Math.round(perH * o.hours));
    const n = cs.length, last = cs[n - 1].c, atr = atrOf(cs, Math.min(30, n));

    const hi = cs.map(x => x.h), lo = cs.map(x => x.l);
    const ph = pivots(hi, o.k, true), pl = pivots(lo, o.k, false);
    const res = ph.length >= 2 ? hull(ph, ph.map(i => hi[i]), true) : null;
    const sup = pl.length >= 2 ? hull(pl, pl.map(i => lo[i]), false) : null;
    const reg = regression(cs.map(x => x.c));

    const line = (L, pv, vals, upper) => {
      if (!L) return null;
      const px = L.m * (n - 1) + L.c;
      let touch = 0;
      pv.forEach(i => { if (Math.abs(vals[i] - (L.m * i + L.c)) <= atr * 0.35) touch++; });
      return { m: L.m, c: L.c, px, touch,
        gap: (px - last) / last * 100,
        slope: L.m * perH / last * 100,
        rx: react(cs, L, upper, o.horizon, atr * 0.5),
        oos: oos(cs, o.k, upper, 0.7) };
    };

    const box = boxAt(cs, n, o.win);
    const live = currentBox(cs, o.maxw, Math.max(8, Math.round(o.win / 2)));
    const bo = {};
    for (const side of ["long", "short"]) {
      const long = side === "long";
      const { rs, fake } = breakouts(cs, o, long);
      bo[side] = stats(rs);
      bo[side].fake = rs.length ? fake / rs.length : 0;
      bo[side].ctl = stats(control(cs, o, long));
      bo[side].edge = bo[side].n ? bo[side].exp - bo[side].ctl.exp : 0;
      bo[side].verdict = !bo[side].n ? "표본 없음"
        : bo[side].lo > bo[side].ctl.exp ? "유의미"
        : bo[side].hi > bo[side].ctl.exp ? "대조군과 구분 안 됨" : "대조군보다 나쁨";
    }

    const w = wiggle(cs);
    const M = { cs, bar, n, last, atr, opt: o, reg,
      res: line(res, ph, hi, true), sup: line(sup, pl, lo, false),
      ph, pl, box, bo, dir: w.dir, path: w.path,
      live, ladder: ladder(live, 60), perH,
      grade: grade(live, perH, w.dir, o),
      trigUp: box.hi * (1 + o.buf), trigDn: box.lo * (1 - o.buf),
      inBox: box.width <= o.maxw };
    M.trend = gradeTrend(M, o);
    return M;
  }

  /* ── 그리기 ───────────────────────────────────────────────────────── */
  function draw(cv, M) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 700, h = cv.clientHeight || 300;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const cs = M.cs, n = M.n;
    const P = { l: 6, r: 76, t: 10, b: 18 };
    const pw = w - P.l - P.r, ph = h - P.t - P.b;

    let lo = Infinity, hi = -Infinity;
    cs.forEach(k => { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
    [M.res, M.sup].forEach(L => {
      if (!L) return;
      [L.c, L.m * (n - 1) + L.c].forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    });
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    const X = i => P.l + (i + 0.5) * (pw / n);
    const Y = v => P.t + (1 - (v - lo) / (hi - lo)) * ph;

    /* 박스 — 지금 사다리를 칠 구간 */
    if (M.live) {
      const x0 = X(n - M.live.bars) - (pw / n) / 2;
      g.fillStyle = "rgba(139,124,255,.10)";
      g.fillRect(x0, Y(M.live.hi), P.l + pw - x0, Y(M.live.lo) - Y(M.live.hi));
      g.strokeStyle = "rgba(139,124,255,.55)"; g.lineWidth = 1;
      g.strokeRect(x0, Y(M.live.hi), P.l + pw - x0, Y(M.live.lo) - Y(M.live.hi));
      g.fillStyle = C.accent; g.font = '600 10px "IBM Plex Sans KR",sans-serif';
      g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillStyle = M.grade && M.grade.ok ? C.gain : C.accent;
      const lab = `박스 ${(M.live.width * 100).toFixed(1)}% · ${(M.live.bars / M.perH).toFixed(1)}h · 왕복 ${
                   M.live.laps}회${M.grade && M.grade.ok ? "  ✓ 거미줄 적합" : ""}`;
      // 박스가 오른쪽 끝에 붙으면 라벨이 축 영역 밖으로 삐져나가 가격 표기와 겹친다
      const lw = g.measureText(lab).width;
      g.fillText(lab, Math.min(x0 + 4, P.l + pw - lw), Y(M.live.hi) - 3);
    }

    /* 회귀 채널 */
    const rTop = i => M.reg.m * i + M.reg.c + 2 * M.reg.sd;
    const rBot = i => M.reg.m * i + M.reg.c - 2 * M.reg.sd;
    g.fillStyle = "rgba(139,124,255,.06)";
    g.beginPath();
    g.moveTo(X(0), Y(rTop(0))); g.lineTo(X(n - 1), Y(rTop(n - 1)));
    g.lineTo(X(n - 1), Y(rBot(n - 1))); g.lineTo(X(0), Y(rBot(0)));
    g.closePath(); g.fill();
    g.strokeStyle = "rgba(139,124,255,.55)"; g.lineWidth = 1.2; g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(X(0), Y(M.reg.c)); g.lineTo(X(n - 1), Y(M.reg.m * (n - 1) + M.reg.c)); g.stroke();
    g.setLineDash([]);

    /* 봉 */
    const bw = Math.max(1, pw / n * 0.62);
    cs.forEach((k, i) => {
      const up = k.c >= k.o;
      g.strokeStyle = g.fillStyle = up ? C.gain : C.loss;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(i), Y(k.h)); g.lineTo(X(i), Y(k.l)); g.stroke();
      const y0 = Y(Math.max(k.o, k.c)), y1 = Y(Math.min(k.o, k.c));
      g.fillRect(X(i) - bw / 2, y0, bw, Math.max(1, y1 - y0));
    });

    /* 추세선 — 검증을 통과한 선만 실선, 나머지는 흐린 점선 */
    [[M.res, C.loss, "저항"], [M.sup, C.gain, "지지"]].forEach(([L, col, lab]) => {
      if (!L) return;
      const solid = L.touch >= 3 && L.oos && L.oos.broke / L.oos.of < 0.1;
      g.strokeStyle = col; g.lineWidth = solid ? 2 : 1.1;
      g.globalAlpha = solid ? 1 : 0.42;
      g.setLineDash(solid ? [] : [4, 4]);
      g.beginPath(); g.moveTo(X(0), Y(L.c)); g.lineTo(X(n - 1), Y(L.m * (n - 1) + L.c)); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = col; g.font = '600 10px "IBM Plex Sans KR",sans-serif';
      g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText(`${lab} ${solid ? "✓" : "?"}`, P.l + pw + 5, Y(L.m * (n - 1) + L.c));
    });

    /* 피벗 점 */
    g.globalAlpha = .8;
    M.ph.forEach(i => { g.fillStyle = C.loss; g.beginPath(); g.arc(X(i), Y(cs[i].h), 2, 0, 7); g.fill(); });
    M.pl.forEach(i => { g.fillStyle = C.gain; g.beginPath(); g.arc(X(i), Y(cs[i].l), 2, 0, 7); g.fill(); });
    g.globalAlpha = 1;

    /* 돌파 트리거 */
    [[M.trigUp, C.warn, "↑돌파"], [M.trigDn, C.warn, "↓이탈"]].forEach(([v, col, lab]) => {
      if (v < lo || v > hi) return;
      g.strokeStyle = col; g.globalAlpha = .55; g.setLineDash([2, 5]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(P.l, Y(v)); g.lineTo(P.l + pw, Y(v)); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = col; g.font = '10px "JetBrains Mono",monospace'; g.textAlign = "left";
      g.fillText(lab, P.l + pw + 5, Y(v));
    });

    /* 현재가 */
    const yL = Y(M.last);
    g.strokeStyle = C.ink; g.globalAlpha = .3; g.setLineDash([1, 3]);
    g.beginPath(); g.moveTo(P.l, yL); g.lineTo(P.l + pw, yL); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    g.fillStyle = C.ink; g.font = '600 10.5px "JetBrains Mono",monospace'; g.textAlign = "left";
    g.fillText(root.fmtPrice ? root.fmtPrice(M.last) : M.last.toPrecision(6), P.l + pw + 5, yL);
  }

  root.TrendView = { analyse, draw, BAR_MIN, pivots, hull, regression, currentBox, ladder, grade, gradeTrend };
})(window);
