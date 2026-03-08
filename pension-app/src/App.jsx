import { useState, useMemo, useRef, useEffect } from "react";

// ── formatters ────────────────────────────────────────────────────────────────
const fmt  = (n) => Math.round(n).toLocaleString("ru-RU") + " ₽";
const fmtM = (n) => {
  if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + " млрд ₽";
  if (Math.abs(n) >= 1_000_000)     return (n / 1_000_000).toFixed(1) + " млн ₽";
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
};
const pct     = (n) => (typeof n === "number" ? n.toFixed(1) : "0.0") + "%";
const yrsWord = (n) => n === 1 ? "год" : n < 5 ? "года" : "лет";

// ── constants ─────────────────────────────────────────────────────────────────
const MOBILE_BP = 700;

// ── strategies ────────────────────────────────────────────────────────────────
const STRATEGIES = [
  { id:"auto",         name:"Равномерная нагрузка",       icon:"◈", color:"#50b878",
    desc:"Взносы одинаковы в реальном выражении каждый год — в рублях растут ровно на инфляцию. Нагрузка на бюджет не меняется на протяжении всего срока." },
  { id:"flat_nominal", name:"Фиксированная сумма рублей", icon:"◎", color:"#6090c8",
    desc:"Одна и та же сумма рублей каждый месяц. Удобно для бюджетирования: знаете точную цифру на годы вперёд. Из-за инфляции реальная нагрузка постепенно снижается — поэтому стартовый взнос выше." },
  { id:"back_loaded",  name:"Отложенный старт",           icon:"◐", color:"#d06060",
    desc:"Первые 5 лет — минимальные взносы (30% от нормы), затем резко повышенные. Для тех, кто сейчас ограничен в средствах, но ожидает значительный рост дохода." },
];

// ── math ──────────────────────────────────────────────────────────────────────
function solveMonthlyContribReal(curCap, targetCap, remYears, realReturn) {
  if (remYears <= 0) return 0;
  const r = realReturn / 12, n = remYears * 12;
  const fv = curCap * Math.pow(1 + r, n);
  const needed = targetCap - fv;
  if (needed <= 0) return 0;
  const factor = r > 0 ? (Math.pow(1 + r, n) - 1) / r : n;
  return needed / factor;
}


// ── Strategy helpers ─────────────────────────────────────────────────────────
// Shape for back_loaded strategy
function backLoadedShape(absY) { return absY < 5 ? 0.3 : 1.5; }

// Solve fixed nominal monthly payment reaching targetCapNominal from initSavings
function solveFlatNominal(initSavings, targetCapNominal, years, nomReturn) {
  const r = nomReturn / 12, n = years * 12;
  const fv = initSavings * Math.pow(1 + r, n);
  const needed = targetCapNominal - fv;
  if (needed <= 0) return 0;
  const factor = r > 0 ? (Math.pow(1 + r, n) - 1) / r : n;
  return needed / factor;
}

// Solve fixed NOMINAL monthly contribution (same ruble amount every year)
// Binary search simulating exactly as buildSchedule: contribReal = contribNominal / inflFactor
function solveFlatNominalExact(initSavings, targetCapReal, years, rMonReal, rMonNom, inf) {
  const totalMonths = years * 12;
  // Analytical estimate in nominal terms as starting point
  const fv0    = initSavings * Math.pow(1 + rMonNom, totalMonths);
  const needed = (targetCapReal * Math.pow(1 + inf, years)) - fv0;
  if (needed <= 0) return 0;
  const factor = rMonNom > 0 ? (Math.pow(1 + rMonNom, totalMonths) - 1) / rMonNom : totalMonths;
  let pmt = needed / factor;
  // Binary search: simulate exactly as buildSchedule does
  // Fixed contribNominal → contribReal = contribNominal / inflFactor each year
  let lo = 0, hi = pmt * 4;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    let capR = initSavings;
    for (let y = 0; y < years; y++) {
      const contribReal = mid / Math.pow(1 + inf, y);
      for (let m = 0; m < 12; m++) {
        capR = capR * (1 + rMonReal) + contribReal;
      }
    }
    if (capR < targetCapReal) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Solve back_loaded base nominal payment reaching targetCapNominal from initSavings
function solveBackLoaded(initSavings, targetCapNominal, years, nomReturn, inf) {
  const rMN = nomReturn / 12, n = years * 12;
  const fvS = initSavings * Math.pow(1 + rMN, n);
  const needed = targetCapNominal - fvS;
  if (needed <= 0) return 0;
  let fvFactor = 0, month = 0;
  for (let y = 0; y < years; y++) {
    const mult  = backLoadedShape(y);
    const inflF = Math.pow(1 + inf, y);
    for (let m = 0; m < 12; m++) {
      fvFactor += mult * inflF * Math.pow(1 + rMN, n - month - 1);
      month++;
    }
  }
  return fvFactor > 0 ? needed / fvFactor : 0;
}

function buildSchedule(baseYear, age, retireAge, monthlyExpense, inflation, returnRate, safeRate, fixedContribs, existingSavings, strategy) {
  const years = retireAge - age;
  if (years <= 0) return { rows:[], targetCapitalReal:0, targetCapitalNominal:0 };

  const inf        = inflation / 100;
  const realReturn = (returnRate - inflation) / 100;
  const nomReturn  = returnRate / 100;
  const rMonReal   = realReturn / 12;
  const rMonNom    = nomReturn / 12;

  const futureMonthly        = monthlyExpense * Math.pow(1 + inf, years);
  const targetCapitalNominal = (futureMonthly * 12) / (safeRate / 100);
  const targetCapitalReal    = targetCapitalNominal / Math.pow(1 + inf, years);

  const initSavings = existingSavings || 0;

  // Has any year been overridden manually?
  const hasManual = Object.keys(fixedContribs).some(y => {
    const yi = Number(y) - baseYear;
    return yi >= 0 && yi < years;
  });

  // Pre-compute strategy base (only used when no manual overrides)
  const flatNomBase  = (!hasManual && strategy === "flat_nominal")
    ? solveFlatNominalExact(initSavings, targetCapitalReal, years, rMonReal, rMonNom, inf) : 0;
  const backBase     = (!hasManual && strategy === "back_loaded")
    ? solveBackLoaded(initSavings, targetCapitalNominal, years, nomReturn, inf) : 0;

  // ── Simulate ──
  let capitalReal = initSavings;
  let capitalNom  = initSavings;
  const rows      = [];

  for (let y = 0; y < years; y++) {
    const calYear    = baseYear + y;
    const inflFactor = Math.pow(1 + inf, y);
    const isFixed    = fixedContribs[calYear] !== undefined;

    let contribNominal, contribReal;

    if (isFixed) {
      contribNominal = fixedContribs[calYear];
      contribReal    = contribNominal / inflFactor;
    } else if (hasManual || strategy === 'auto') {
      // Manual mode or auto: equal real payment recalculated from current capital
      contribReal    = solveMonthlyContribReal(capitalReal, targetCapitalReal, years - y, realReturn);
      contribNominal = contribReal * inflFactor;
    } else if (strategy === "flat_nominal") {
      contribNominal = flatNomBase;
      contribReal    = contribNominal / inflFactor;
    } else {
      // back_loaded
      contribNominal = backBase * backLoadedShape(y) * inflFactor;
      contribReal    = contribNominal / inflFactor;
    }

    for (let m = 0; m < 12; m++) {
      capitalReal = capitalReal * (1 + rMonReal) + contribReal;
      capitalNom  = capitalNom  * (1 + rMonNom)  + contribNominal;
    }

    rows.push({
      year: calYear, age: age + y, isFixed,
      contribNominal: Math.round(contribNominal),
      contribReal,
      capitalReal,
      capitalNominal: capitalNom,
      progress: Math.min(200, (capitalReal / targetCapitalReal) * 100),
    });
  }
  return { rows, targetCapitalReal, targetCapitalNominal };
}

function buildDepletion(capitalAtRetireReal, retireAge, age, baseYear, inflation, returnRate) {
  const retireYear = baseYear + (retireAge - age);
  const realReturn = (returnRate - inflation) / 100;
  const rMonth     = realReturn / 12;
  const inf        = inflation / 100;
  const yrToRetire = retireAge - age;
  const capNom     = capitalAtRetireReal * Math.pow(1 + inf, yrToRetire);
  return [1,2,3,4,5,6,7,8,9,10].map(rate => {
    const mwR = capitalAtRetireReal * (rate/100) / 12;
    const mwN = capNom * (rate/100) / 12;
    let cap = capitalAtRetireReal, months = 0;
    while (cap > 0 && months < 1200) { cap = cap*(1+rMonth)-mwR; months++; }
    const yrs = months >= 1200 ? null : Math.floor(months/12);
    return { rate, infinite:months>=1200, years:yrs,
      exhaustAge:  yrs===null?null:retireAge+yrs,
      exhaustYear: yrs===null?null:retireYear+yrs,
      totalNominal: Math.round(mwN),
      totalReal:    Math.round(mwR) };
  });
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
// Глобальный синглтон: только один тултип виден одновременно
let _tooltipCloseAll = null;

function NominalTooltip({ nominalValue, realValue, baseYear, children, onTapEdit }) {
  const [show, setShow] = useState(false);
  const [pos, setPos]   = useState({ top:0, left:0 });
  const trigRef         = useRef(null);
  const hideTimer       = useRef(null);
  const touchStart      = useRef(null); // {x, y} при начале касания
  const myClose         = useRef(null);

  // Регистрируем функцию закрытия этого тултипа
  useEffect(() => {
    myClose.current = () => { clearTimeout(hideTimer.current); setShow(false); };
  });

  const calcPos = () => {
    if (!trigRef.current) return;
    const rect = trigRef.current.getBoundingClientRect();
    const W = 200, H = 40;
    let top  = rect.top - H - 10;
    let left = rect.left + rect.width/2 - W/2;
    if (top < 8) top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    setPos({ top, left });
  };

  // Desktop hover — singleton: закрываем предыдущий перед открытием нового
  const handleEnter = () => {
    if (window.innerWidth <= MOBILE_BP) return;
    // Закрываем любой другой открытый тултип
    if (_tooltipCloseAll) { _tooltipCloseAll(); }
    _tooltipCloseAll = () => { clearTimeout(hideTimer.current); setShow(false); };
    clearTimeout(hideTimer.current);
    calcPos();
    setShow(true);
  };
  const handleLeave = () => {
    if (window.innerWidth <= MOBILE_BP) return;
    hideTimer.current = setTimeout(() => { setShow(false); _tooltipCloseAll = null; }, 80);
  };

  // Mobile touch: запоминаем позицию при начале касания
  const handleTouchStart = (e) => {
    if (window.innerWidth > MOBILE_BP) return;
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };

  // Mobile touch: срабатываем только если палец почти не двигался (< 8px) — это тап, не скролл
  const handleTouchEnd = (e) => {
    if (window.innerWidth > MOBILE_BP) return;
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = Math.abs(t.clientX - touchStart.current.x);
    const dy = Math.abs(t.clientY - touchStart.current.y);
    touchStart.current = null;
    if (dx > 8 || dy > 8) return; // скролл — игнорируем

    e.preventDefault();
    e.stopPropagation();

    if (show) {
      // второй тап — закрыть и перейти к редактированию
      clearTimeout(hideTimer.current);
      setShow(false);
      if (onTapEdit) onTapEdit();
    } else {
      // первый тап — закрыть все остальные, показать этот
      if (_tooltipCloseAll) _tooltipCloseAll();
      _tooltipCloseAll = () => { clearTimeout(hideTimer.current); setShow(false); };
      calcPos();
      setShow(true);
      hideTimer.current = setTimeout(() => { setShow(false); _tooltipCloseAll = null; }, 2500);
    }
  };

  return (
    <>
      <span ref={trigRef} style={{ display:"inline-block" }}
        onMouseEnter={handleEnter} onMouseLeave={handleLeave}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}>
        {children}
      </span>
      {show && (
        <div style={{ position:"fixed", top:pos.top, left:pos.left, zIndex:9999, pointerEvents:"none",
          background:"#1a1828", border:"1px solid #c9a96e55", borderRadius:8,
          padding:"6px 12px", width:200, boxShadow:"0 8px 24px rgba(0,0,0,0.8)" }}>
          <div style={{ fontFamily:"monospace", fontSize:11, color:"#c9a96e", fontWeight:700 }}>
            = {fmtM(realValue)} в ценах {baseYear}г
          </div>
          {onTapEdit && (
            <div style={{ fontFamily:"monospace", fontSize:9, color:"#7870a0", marginTop:3 }}>
              нажмите ещё раз для изменения
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Slider ────────────────────────────────────────────────────────────────────
function Slider({ label, value, min, max, step, onChange, display, hint, color="#c9a96e", editable=false, tooltip=null }) {
  const frac    = Math.max(0, Math.min(1, (value-min)/(max-min)));
  const fillPct = (frac*100).toFixed(2);
  const [editing, setEditing] = useState(false);
  const [rawInput, setRawInput] = useState("");
  const [showTip, setShowTip] = useState(false);
  const [tipPos,  setTipPos]  = useState({x:0, y:0});
  const trackRef = useRef(null);

  const commitEdit = () => {
    const parsed = parseInt(rawInput.replace(/[^0-9]/g,""), 10);
    if (!isNaN(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
    setEditing(false);
  };

  const valueFromClientX = (clientX) => {
    if (!trackRef.current) return value;
    const rect = trackRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw  = min + frac * (max - min);
    const stepped = Math.round(raw / step) * step;
    return Math.max(min, Math.min(max, stepped));
  };

  const justTouched = useRef(false);

  const handleMouseDown = (e) => {
    if (justTouched.current) return; // блокируем синтетический mousedown после touch
    e.preventDefault();
    onChange(valueFromClientX(e.clientX));
    const onMove = (e) => onChange(valueFromClientX(e.clientX));
    const onUp   = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  const handleTouchStart = (e) => {
    justTouched.current = true;
    setTimeout(() => { justTouched.current = false; }, 500);

    const t0 = e.touches[0];
    const startX = t0.clientX;
    const startY = t0.clientY;
    let intentDecided = false;
    let isHorizontal  = false;

    const onMove = (e) => {
      const t = e.touches[0];
      if (!intentDecided) {
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (dx < 4 && dy < 4) return; // ждём чёткого движения
        intentDecided = true;
        isHorizontal  = dx > dy;
      }
      if (!isHorizontal) return; // вертикаль — скролл, не трогаем
      e.preventDefault();
      onChange(valueFromClientX(t.clientX));
    };

    const onEnd = () => {
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend",  onEnd);
    };

    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend",  onEnd);
  };

  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4, gap:8 }}>
        <span style={{ fontSize:11, letterSpacing:"0.05em", textTransform:"uppercase", color:"#9890a8", fontFamily:"monospace", flexShrink:1, minWidth:0 }}>{label}</span>
        {editable && editing
          ? <input autoFocus type="text" value={rawInput}
              onChange={e=>setRawInput(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e=>{if(e.key==="Enter")commitEdit();if(e.key==="Escape")setEditing(false);}}
              style={{ fontSize:18, fontWeight:700, color, fontFamily:"'Playfair Display',serif", background:"transparent", border:"none", borderBottom:`1px solid ${color}`, outline:"none", width:140, textAlign:"right" }} />
          : <span style={{ position:"relative", display:"inline-block" }}>
              <span onClick={()=>{if(editable){setRawInput(String(value));setEditing(true);}}}
                onMouseEnter={e=>{if(tooltip){setShowTip(true);setTipPos({x:e.clientX,y:e.clientY});}}}
                onMouseMove={e=>{if(tooltip){setTipPos({x:e.clientX,y:e.clientY});}}}
                onMouseLeave={()=>setShowTip(false)}
                style={{ fontSize:20, fontWeight:700, color, fontFamily:"'Playfair Display',serif", flexShrink:0, whiteSpace:"nowrap", cursor:editable?"text":tooltip?"default":"default", borderBottom:editable?`1px dashed ${color}44`:tooltip?`1px dashed ${color}55`:"none", paddingBottom:editable||tooltip?1:0 }}>
                {display(value)}
              </span>
              {showTip && tooltip && (
                <div style={{ position:"fixed", left:tipPos.x+14, top:tipPos.y-36, zIndex:9999, pointerEvents:"none",
                  background:"#1a1828", border:`1px solid ${color}44`, borderRadius:8,
                  padding:"6px 12px", whiteSpace:"nowrap", boxShadow:"0 8px 24px rgba(0,0,0,0.8)",
                  fontFamily:"monospace", fontSize:11, color, fontWeight:700 }}>
                  {tooltip}
                </div>
              )}
            </span>
        }
      </div>
      {hint && <div style={{ fontSize:10, color:"#7870a0", fontFamily:"monospace", marginBottom:6 }}>{hint}</div>}
      <div ref={trackRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        style={{ position:"relative", height:28, display:"flex", alignItems:"center", margin:"6px 0", cursor:"pointer" }}>
        <div style={{ position:"absolute", left:0, right:0, height:4, borderRadius:2, background:"#2a2838" }} />
        <div style={{ position:"absolute", left:0, width:`${fillPct}%`, height:4, borderRadius:2, background:color, pointerEvents:"none" }} />
        <div style={{ position:"absolute", left:`calc(${fillPct}% - 9px)`, width:18, height:18, borderRadius:"50%", background:color, boxShadow:`0 0 0 3px #18162288, 0 0 10px ${color}66`, pointerEvents:"none" }} />
      </div>
    </div>
  );
}

// ── Interactive Onboarding ────────────────────────────────────────────────────
function Onboarding({ onClose, onShowStrategy, onStepChange, isMobile }) {
  const [step, setStep] = useState(0);

  const steps = [
    { title:"Добро пожаловать!", sub:"Пенсионный калькулятор", emoji:"🏦", highlight:null, mobPanel:null,
      body:"Этот калькулятор поможет понять, сколько нужно откладывать каждый месяц, чтобы к пенсии накопить достаточно — с учётом инфляции и доходности инвестиций." },
    { title:"Параметры и допущения", sub:"Настройте под себя", emoji:"⚙️", highlight:"onboard-params-assumptions", mobPanel:"params",
      body:"Задайте желаемые расходы на пенсии и возраст выхода на пенсию, затем — ваш текущий возраст и имеющиеся накопления. В разделе допущений укажите инфляцию и доходность инвестиций." },
    { title:"Ставка изъятия", sub:"Ключевой параметр пенсии", emoji:"📐", highlight:"onboard-saferate", mobPanel:"params",
      body:"% от капитала, который вы снимаете каждый год на пенсии. При 4% капитал исторически не уменьшается — \"правило 4%\". Чем ниже ставка, тем дольше хватит денег." },
    { title:"Стратегия взносов", sub:"Как вы хотите копить?", emoji:"🎯", highlight:"onboard-strategy", mobPanel:"params",
      body:"Выберите стратегию накопления в блоке ниже. Равномерная, фиксированная сумма или отложенный старт — все варианты достигают цели.",
    },
    { title:"Таблица взносов", sub:"Вкладка «Таблица»", emoji:"📋", highlight:"onboard-right-panel", mobPanel:"table", desktopSwitchTab:"table", mobArrow:"Вы сейчас на вкладке «Таблица» — план взносов по годам",
      body:"Таблица показывает план ежемесячных взносов по годам. Любую сумму взноса можно изменить вручную — остальные годы пересчитаются автоматически. При нажатии на сумму также можно увидеть её значение в ценах сегодняшнего дня." },
    { title:"Жизнь капитала", sub:"Вторая вкладка", emoji:"📉", highlight:"onboard-right-panel", mobPanel:"depletion", desktopSwitchTab:"depletion", mobArrow:"Вы сейчас на вкладке «Капитал» — на сколько лет хватит денег",
      body:"Показывает, на сколько лет хватит капитала при разных ставках снятия. Зелёные строки — капитал вечен. Чем краснее строка, тем быстрее закончатся деньги на пенсии." },
  ];

  const s         = steps[step];
  const color     = ["#c9a96e","#e8a050","#9060d0","#50b878","#c9a96e","#c9a96e","#c9a96e"][step]||"#c9a96e";
  const cardColor = "#00d4ff";

  // Centralized highlight cleanup function
  const clearHighlight = (id) => {
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.style.outline = "";
    el.style.outlineOffset = "";
    el.style.boxShadow = "";
    el.style.transition = "";
  };

  useEffect(() => {
    if (onStepChange) onStepChange(step);
    // On mobile: switch to the relevant panel before highlighting
    if (isMobile && s.mobPanel) {
      window.dispatchEvent(new CustomEvent("onboard-panel", { detail: s.mobPanel }));
    }
    // On desktop: switch active tab if step requires it
    if (s.desktopSwitchTab && window.innerWidth > MOBILE_BP) {
      window.dispatchEvent(new CustomEvent("onboard-switch-tab", { detail: s.desktopSwitchTab }));
    }

    // Clear ALL highlights first (handles back button correctly)
    steps.forEach(st => clearHighlight(st.highlight));

    if (!s.highlight) return;

    // Small delay to let panel switch render
    const t = setTimeout(() => {
      const el = document.getElementById(s.highlight);
      if (!el) return;
      el.style.transition = "outline 0.25s, box-shadow 0.25s";
      el.style.outline = `2px solid ${color}`;
      el.style.outlineOffset = "4px";
      el.style.boxShadow = `0 0 24px ${color}44`;
      // На мобильном скроллинг для inline-шагов (2, 3) управляется через onboard-set-step —
      // здесь не скроллим, чтобы не дублировать и не прерывать плавную анимацию.
      if (!isMobile) {
        el.scrollIntoView({ behavior:"smooth", block:"nearest" });
      }
    }, 100);

    return () => {
      clearTimeout(t);
      // Cleanup current highlight when step changes
      clearHighlight(s.highlight);
    };
  }, [step]);

  // Cleanup ALL highlights when onboarding closes
  useEffect(() => {
    return () => {
      steps.forEach(st => clearHighlight(st.highlight));
    };
  }, []);

  // Слушаем внешние переключения шага (от inline-карточек)
  useEffect(() => {
    const handler = (e) => {
      const nextStep = e.detail;
      const nextS = steps[nextStep];
      const goingBack = nextStep < step;

      // Шаги 2 и 3 — inline карточки внутри params-панели.
      // Шаги 4+ — переключение на другую панель (table/depletion).
      const currentIsInline = step === 2 || step === 3;
      const nextIsInline    = nextStep === 2 || nextStep === 3;

      if (isMobile) {
        if (nextIsInline) {
          // Переходим на inline-шаг (2 или 3) — панель params уже открыта,
          // просто плавно скроллим к нужному элементу, потом меняем шаг.
          const scrollAndSet = () => {
            setStep(nextStep);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const cardId = nextStep === 2 ? "inline-card-2" : "inline-card-3";
                const el = document.getElementById(cardId);
                if (!el) return;
                el.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            });
          };
          // Если текущий шаг не на params-панели — сначала переключаем панель
          if (!currentIsInline && step > 3) {
            window.dispatchEvent(new CustomEvent("onboard-panel", { detail: "params" }));
            setTimeout(scrollAndSet, 50);
          } else {
            scrollAndSet();
          }
        } else if (nextS?.mobPanel && nextS.mobPanel !== "params") {
          window.dispatchEvent(new CustomEvent("onboard-panel", { detail: nextS.mobPanel }));
          setTimeout(() => setStep(nextStep), 100);
        } else {
          setStep(nextStep);
          // Скроллим к верхнему элементу страницы через два rAF — после рендера
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = document.getElementById("mob-tabs-top");
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          });
        }
      } else {
        setStep(nextStep);
      }
    };
    window.addEventListener("onboard-set-step", handler);
    return () => window.removeEventListener("onboard-set-step", handler);
  }, [step]);

  if (isMobile) {
    const isBanner = step === 2 || step === 3; // шаги где нужно видеть блок

    if (isBanner) {
      // Inline-карточка рендерится прямо в левой панели — здесь ничего не показываем
      return null;
    }

    // Остальные шаги — карточка снизу
    return (
      <div style={{ position:"fixed", inset:0, zIndex:1000, pointerEvents:"none" }}>
        <div className="onboard-card-pulse" style={{
          position:"fixed", bottom:0, left:0, right:0,
          borderRadius:"18px 18px 0 0",
          background:"#0f0e1c",
          border:`1px solid ${cardColor}66`,
          borderBottom:"none",
          padding:"16px 16px 14px",
          pointerEvents:"all",
        }}>
          <button onClick={()=>{steps.forEach(st=>clearHighlight(st.highlight));onClose();}}
            style={{ position:"absolute", top:14, right:16, background:"none", border:"none", color:"#5a5878", cursor:"pointer", fontSize:18 }}>✕</button>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:`${cardColor}18`, border:`1px solid ${cardColor}40`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>{s.emoji}</div>
            <div>
              <div style={{ fontFamily:"monospace", fontSize:9, color:cardColor, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:2 }}>{s.sub}</div>
              <div style={{ fontFamily:"'Playfair Display',serif", fontSize:15, fontWeight:700, color:"#ece4d4" }}>{s.title}</div>
            </div>
          </div>
          <div style={{ fontFamily:"Georgia,serif", fontSize:12, color:"#a098b8", lineHeight:1.5, whiteSpace:"pre-line", marginBottom:s.mobArrow?8:12 }}>{s.body}</div>
          {s.mobArrow && (
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, padding:"6px 10px", background:`${cardColor}10`, borderRadius:8, border:`1px solid ${cardColor}30` }}>
              <span className="onboard-arrow" style={{ color:cardColor }}>↑</span>
              <span style={{ fontFamily:"monospace", fontSize:10, color:cardColor, letterSpacing:"0.05em" }}>{s.mobArrow}</span>
            </div>
          )}
          <div style={{ display:"flex", gap:4, marginBottom:12 }}>
            {steps.map((_,i) => (
              <div key={i} onClick={()=>window.dispatchEvent(new CustomEvent("onboard-set-step",{detail:i}))} style={{ flex:i===step?3:1, height:3, borderRadius:2, background:i===step?cardColor:i<step?`${cardColor}55`:"#252336", cursor:"pointer", transition:"all 0.3s" }} />
            ))}
          </div>
          <div style={{ display:"flex", gap:8 }}>
            {step>0 && <button onClick={()=>window.dispatchEvent(new CustomEvent("onboard-set-step",{detail:step-1}))} style={{ flex:1, padding:"9px 0", background:"none", border:"1px solid #252336", color:"#7870a0", borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11 }}>←</button>}
            {step<steps.length-1
              ? <button onClick={()=>window.dispatchEvent(new CustomEvent("onboard-set-step",{detail:step+1}))} style={{ flex:3, padding:"9px 0", background:`${cardColor}18`, border:`1px solid ${cardColor}55`, color:cardColor, borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700 }}>Далее →</button>
              : <button onClick={()=>{steps.forEach(st=>clearHighlight(st.highlight));onClose();}} style={{ flex:3, padding:"9px 0", background:`${cardColor}25`, border:`1px solid ${cardColor}`, color:cardColor, borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700 }}>Начать ✓</button>
            }
          </div>
          <div style={{ textAlign:"center", marginTop:6, fontFamily:"monospace", fontSize:9, color:"#3a3850", cursor:"pointer" }} onClick={()=>{steps.forEach(st=>clearHighlight(st.highlight));onClose();}}>пропустить</div>
        </div>
      </div>
    );
  }

  // ── Desktop ──
  const cardStyle = {
    position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)",
    background:"#0f0e1c",
    border:`1px solid ${cardColor}66`,
    borderRadius:20,
    padding:"26px 28px", width:350,
    boxShadow:"0 20px 70px rgba(0,0,0,0.9)",
    pointerEvents:"all", zIndex:901
  };

  return (
    <div style={{ position:"fixed", inset:0, zIndex:900, pointerEvents:"none" }}>
      <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.45)", pointerEvents:"all" }} onClick={onClose} />
      <div style={cardStyle}>
        <button onClick={()=>{steps.forEach(st=>clearHighlight(st.highlight));onClose();}} style={{ position:"absolute", top:14, right:16, background:"none", border:"none", color:"#5a5878", cursor:"pointer", fontSize:18 }}>✕</button>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
          <div style={{ width:42, height:42, borderRadius:12, background:`${cardColor}18`, border:`1px solid ${cardColor}40`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{s.emoji}</div>
          <div>
            <div style={{ fontFamily:"monospace", fontSize:9, color:cardColor, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:2 }}>{s.sub}</div>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:16, fontWeight:700, color:"#ece4d4" }}>{s.title}</div>
          </div>
        </div>
        <div style={{ fontFamily:"Georgia,serif", fontSize:13, color:"#a098b8", lineHeight:1.65, whiteSpace:"pre-line", marginBottom:s.mobArrow?10:14 }}>{s.body}</div>
        {s.mobArrow && (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14, padding:"8px 12px", background:`${cardColor}10`, borderRadius:8, border:`1px solid ${cardColor}30` }}>
            <span className="onboard-arrow" style={{ color:cardColor }}>↑</span>
            <span style={{ fontFamily:"monospace", fontSize:10, color:cardColor, letterSpacing:"0.05em" }}>{s.mobArrow}</span>
          </div>
        )}
        {s.action && (
          <button onClick={s.action.fn} style={{ width:"100%", padding:"8px 0", background:`${cardColor}18`, border:`1px solid ${cardColor}55`, borderRadius:10, color:cardColor, cursor:"pointer", fontFamily:"monospace", fontSize:11, marginBottom:12 }}>
            {s.action.label}
          </button>
        )}
        <div style={{ display:"flex", gap:4, marginBottom:14 }}>
          {steps.map((_,i) => (
            <div key={i} onClick={()=>setStep(i)} style={{ flex:i===step?3:1, height:3, borderRadius:2, background:i===step?cardColor:i<step?`${cardColor}55`:"#252336", cursor:"pointer", transition:"all 0.3s" }} />
          ))}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {step>0 && <button onClick={()=>setStep(s=>s-1)} style={{ flex:1, padding:"9px 0", background:"none", border:"1px solid #252336", color:"#7870a0", borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11 }}>←</button>}
          {step<steps.length-1
            ? <button onClick={()=>setStep(s=>s+1)} style={{ flex:3, padding:"9px 0", background:`${cardColor}18`, border:`1px solid ${cardColor}55`, color:cardColor, borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700 }}>Далее →</button>
            : <button onClick={()=>{steps.forEach(st=>clearHighlight(st.highlight));onClose();}} style={{ flex:3, padding:"9px 0", background:`${cardColor}25`, border:`1px solid ${cardColor}`, color:cardColor, borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700 }}>Начать ✓</button>
          }
        </div>
        <div style={{ textAlign:"center", marginTop:8, fontFamily:"monospace", fontSize:9, color:"#3a3850", cursor:"pointer" }} onClick={()=>{steps.forEach(st=>clearHighlight(st.highlight));onClose();}}>пропустить</div>
      </div>
    </div>
  );
}

// ── Strategy Modal ────────────────────────────────────────────────────────────
function StrategyModal({ current, hasManual, onSelect, onClose }) {
  const [confirm, setConfirm] = useState(null); // strategy id pending confirmation

  const handleClick = (id) => {
    if (hasManual) { setConfirm(id); return; }
    onSelect(id); onClose();
  };

  const MANUAL = { id:"manual", name:"Ручная настройка", icon:"✎", color:"#c9a96e",
    desc:"Активируется, когда вы вручную задаёте взнос в одной или нескольких строках. Все остальные строки пересчитываются автоматически так, чтобы пенсионная цель всё равно была достигнута. Для сброса выберите другую стратегию." };

  const visibleStrategies = hasManual ? [MANUAL, ...STRATEGIES] : STRATEGIES;
  const activeid = hasManual ? "manual" : current;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#14131e", border:"1px solid #352f50", borderRadius:20, padding:"28px", maxWidth:560, width:"100%", maxHeight:"88vh", overflowY:"auto" }}>
        <div style={{ fontFamily:"'Playfair Display',serif", fontSize:22, fontWeight:700, color:"#ece4d4", marginBottom:4 }}>Стратегия взносов</div>
        <div style={{ fontFamily:"monospace", fontSize:10, color:"#7870a0", marginBottom:20 }}>Все стратегии достигают пенсионной цели — разница в распределении нагрузки</div>

        {visibleStrategies.map(s => {
          const active = activeid === s.id;
          const disabled = s.id === "manual";
          return (
            <div key={s.id} onClick={()=>!disabled && handleClick(s.id)}
              style={{ marginBottom:8, padding:"14px 16px", borderRadius:12, border:`1px solid ${active?s.color:"#252336"}`, background:active?`${s.color}14`:"rgba(255,255,255,0.02)", cursor:disabled?"default":"pointer", transition:"all 0.15s", opacity:disabled?0.7:1 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:5 }}>
                <span style={{ fontSize:18, color:s.color }}>{s.icon}</span>
                <span style={{ fontFamily:"'Playfair Display',serif", fontSize:15, fontWeight:700, color:active?s.color:"#ece4d4" }}>{s.name}</span>
                {active && <span style={{ marginLeft:"auto", fontFamily:"monospace", fontSize:9, color:s.color, background:`${s.color}22`, padding:"2px 8px", borderRadius:4 }}>АКТИВНА</span>}
              </div>
              <div style={{ fontFamily:"Georgia,serif", fontSize:12, color:"#8880a8", lineHeight:1.6 }}>{s.desc}</div>
            </div>
          );
        })}
        <button onClick={onClose} style={{ marginTop:8, width:"100%", padding:"10px 0", background:"none", border:"1px solid #252336", color:"#7870a0", borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11 }}>Закрыть</button>
      </div>

      {/* Confirmation dialog */}
      {confirm && (
        <div style={{ position:"fixed", inset:0, zIndex:1100, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#14131e", border:"1px solid #c9a96e44", borderRadius:16, padding:"28px", maxWidth:380, width:"100%", boxShadow:"0 24px 80px rgba(0,0,0,0.9)" }}>
            <div style={{ fontSize:28, marginBottom:12, textAlign:"center" }}>⚠️</div>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:17, fontWeight:700, color:"#ece4d4", marginBottom:10, textAlign:"center" }}>Сбросить ручные взносы?</div>
            <div style={{ fontFamily:"Georgia,serif", fontSize:13, color:"#9890b8", lineHeight:1.65, marginBottom:22, textAlign:"center" }}>
              Все значения, введённые вручную, будут заменены на автоматические по стратегии «{STRATEGIES.find(s=>s.id===confirm)?.name}».
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={()=>setConfirm(null)}
                style={{ flex:1, padding:"10px 0", background:"none", border:"1px solid #252336", color:"#7870a0", borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11 }}>
                Отмена
              </button>
              <button onClick={()=>{ onSelect(confirm); onClose(); }}
                style={{ flex:2, padding:"10px 0", background:"rgba(201,169,110,0.15)", border:"1px solid rgba(201,169,110,0.5)", color:"#c9a96e", borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700 }}>
                Сбросить и применить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ── Inline Onboarding Card (мобильный, шаги 2 и 3) ────────────────────────────
function InlineOnboardCard({ color, s, step, steps, onStep, onClose }) {
  return (
    <div style={{ margin:"8px 0 0" }}>
      <div className="onboard-card-pulse" style={{
        background:"#0f0e1c",
        border:`1px solid ${color}66`,
        borderRadius:18,
        padding:"16px 16px 12px",
        position:"relative",
      }}>
        <button onClick={onClose} style={{ position:"absolute", top:14, right:14, background:"none", border:"none", color:"#5a5878", cursor:"pointer", fontSize:18, lineHeight:1 }}>✕</button>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
          <div style={{ width:42, height:42, borderRadius:12, background:`${color}18`, border:`1px solid ${color}40`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{s.emoji}</div>
          <div>
            <div style={{ fontFamily:"monospace", fontSize:9, color, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:2 }}>{s.sub}</div>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:16, fontWeight:700, color:"#ece4d4" }}>{s.title}</div>
          </div>
        </div>
        <div style={{ fontFamily:"Georgia,serif", fontSize:13, color:"#a098b8", lineHeight:1.65, marginBottom:14 }}>{s.body}</div>
        <div style={{ display:"flex", gap:4, marginBottom:14 }}>
          {steps.map((_,i) => (
            <div key={i} onClick={()=>onStep(i)} style={{ flex:i===step?3:1, height:3, borderRadius:2, background:i===step?color:i<step?`${color}55`:"#252336", cursor:"pointer", transition:"all 0.3s" }} />
          ))}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={()=>onStep(step-1)} style={{ flex:1, padding:"9px 0", background:"none", border:"1px solid #252336", color:"#7870a0", borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11 }}>←</button>
          <button onClick={()=>onStep(step+1)} style={{ flex:3, padding:"9px 0", background:`${color}18`, border:`1px solid ${color}55`, color, borderRadius:10, cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700 }}>Далее →</button>
        </div>
        <div style={{ textAlign:"center", marginTop:6, fontFamily:"monospace", fontSize:9, color:"#3a3850", cursor:"pointer" }} onClick={onClose}>пропустить</div>
      </div>
      {/* Стрелка вниз — указывает на блок под ней */}
      <div className="onboard-arrow-down" style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
        <div style={{ width:2, height:12, background:`${color}88` }} />
        <div style={{ width:0, height:0, borderLeft:"7px solid transparent", borderRight:"7px solid transparent", borderTop:`7px solid ${color}bb` }} />
      </div>
    </div>
  );
}// ── Main ──────────────────────────────────────────────────────────────────────
export default function App() {
  const baseYear = new Date().getFullYear();
  const [age,             setAge]             = useState(30);
  const [retireAge,       setRetireAge]       = useState(60);
  const [monthlyExpense,  setMonthlyExpense]  = useState(200000);

  const [inflation,       setInflation]       = useState(8);
  const [returnRate,      setReturnRate]      = useState(12);
  const [safeRate,        setSafeRate]        = useState(4);
  const [existingSavings, setExistingSavings] = useState(0);
  const [fixedContribs,   setFixedContribs]   = useState({});
  const [editingYear,     setEditingYear]     = useState(null);
  const [hoveredRow,      setHoveredRow]      = useState(null);
  const [editValue,       setEditValue]       = useState("");
  const [activeTab,       setActiveTab]       = useState("table");
  const [strategy,        setStrategy]        = useState("auto");
  const [showOnboarding,  setShowOnboarding]  = useState(true);
  const [onboardStep,     setOnboardStep]     = useState(0);
  const [showStrategy,    setShowStrategy]    = useState(false);
  const [mobPanel,        setMobPanel]        = useState("params"); // "params" | "table" | "depletion"
  const [isMobile,        setIsMobile]        = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= MOBILE_BP);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Listen for onboarding panel-switch events
  useEffect(() => {
    const tabHandler = (e) => { setActiveTab(e.detail); };
    window.addEventListener("onboard-switch-tab", tabHandler);
    return () => window.removeEventListener("onboard-switch-tab", tabHandler);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      // Просто переключаем панель без скролла — онбординг сам управляет скроллом
      setMobPanel(e.detail);
      if (e.detail === "depletion") setActiveTab("depletion");
      else if (e.detail === "table") setActiveTab("table");
    };
    window.addEventListener("onboard-panel", handler);
    return () => window.removeEventListener("onboard-panel", handler);
  }, []);

  const years      = retireAge - age;
  const retireYear = baseYear + years;

  const { rows, targetCapitalReal, targetCapitalNominal } = useMemo(()=>
    buildSchedule(baseYear, age, retireAge, monthlyExpense, inflation, returnRate, safeRate, fixedContribs, existingSavings, strategy),
    [baseYear,age,retireAge,monthlyExpense,inflation,returnRate,safeRate,fixedContribs,existingSavings,strategy]
  );

  const finalCapital        = rows[rows.length-1]?.capitalReal    || 0;
  const finalCapitalNominal = rows[rows.length-1]?.capitalNominal || 0;
  const finalProgress       = rows[rows.length-1]?.progress       || 0;
  const isOnTrack           = finalProgress >= 99;
  const fixedCount          = Object.keys(fixedContribs).filter(y=>Number(y)>=baseYear&&Number(y)<baseYear+years).length;
  const hasManual           = fixedCount > 0;

  const depletionData = useMemo(()=>
    buildDepletion(finalCapital, retireAge, age, baseYear, inflation, returnRate),
    [finalCapital,retireAge,age,baseYear,inflation,returnRate]
  );

  const resetViewport = () => {
    const meta = document.querySelector("meta[name=viewport]");
    if (!meta) return;
    const orig = meta.content;
    meta.content = orig + ",maximum-scale=1";
    setTimeout(() => { meta.content = orig; }, 100);
  };

  const editOrigValue = useRef(0);
  const startEdit  = (y,v) => { setEditingYear(y); setEditValue(String(v)); editOrigValue.current = v; };
  const commitEdit = (y)   => { const v=parseInt(editValue.replace(/\D/g,""))||0; if (v !== editOrigValue.current) setFixedContribs(p=>({...p,[y]:v})); setEditingYear(null); resetViewport(); };
  const resetYear  = (y,e) => { e.stopPropagation(); setFixedContribs(p=>{const n={...p};delete n[y];return n;}); };
  const resetAll   = ()    => setFixedContribs({});


  const realReturnHint  = returnRate>inflation ? `Реальная доходность: ${pct(returnRate-inflation)}` : returnRate===inflation?"Реальная доходность: 0%":"⚠ Доходность ниже инфляции";
  const activeStrategy  = STRATEGIES.find(s=>s.id===strategy);
  const displayStrategy = hasManual
    ? { name:"Ручная настройка", icon:"✎", color:"#c9a96e", id:"manual" }
    : activeStrategy;
  const firstContrib    = rows[0]?.contribNominal || 0;
  const firstContribReal = rows[0]?.contribReal   || 0;

  return (
    <div id="app-root" style={{ minHeight:"100vh", background:"#0c0b14", color:"#ddd4c0", fontFamily:"Georgia,serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&display=swap');
        *{box-sizing:border-box;}
        html,body{overscroll-behavior:contain;overscroll-behavior-y:contain;}
        ::-webkit-scrollbar{width:4px;}
        ::-webkit-scrollbar-track{background:#14131e;}
        ::-webkit-scrollbar-thumb{background:#3a3050;border-radius:2px;}
        .cc{cursor:pointer;position:relative;}
        .rb{opacity:0;transition:opacity 0.15s;background:none;border:none;cursor:pointer;color:#aa5050;font-size:11px;padding:0 3px;}
        tr:hover .rb{opacity:1;}
        .rb-visible{opacity:1 !important;}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;}
        .ei{background:#1e1c28;border:1px solid #c9a96e;color:#f0e8d0;padding:3px 8px;font-family:monospace;font-size:16px;width:100px;border-radius:4px;outline:none;text-align:right;}
        .tab{background:none;border:none;cursor:pointer;padding:8px 18px;font-family:monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;border-radius:6px;transition:all 0.15s;}
        .panel{background:#14131e;border:1px solid #252336;border-radius:14px;padding:20px 22px;}
        .section-label{font-family:monospace;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:16px;color:#7870a0;}
        @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(201,169,110,0.35)}50%{box-shadow:0 0 0 10px rgba(201,169,110,0)}}
        @keyframes arrowBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        @keyframes arrowBounceRight{0%,100%{transform:translateX(0)}50%{transform:translateX(6px)}}
        @keyframes arrowBounceDown{0%,100%{transform:translateY(0)}50%{transform:translateY(5px)}}
        .onboard-arrow-down{animation:arrowBounceDown 0.9s ease-in-out infinite;display:inline-flex;flex-direction:column;align-items:center;}
        .onboard-arrow{animation:arrowBounce 0.9s ease-in-out infinite;display:inline-block;font-size:22px;line-height:1;}
        .onboard-arrow-right{animation:arrowBounceRight 0.9s ease-in-out infinite;display:inline-block;font-size:22px;line-height:1;}
        @media(max-width:700px){
          .main-grid{display:block !important;}
          .right-panel{margin-top:0 !important; border-radius:0 !important; border-left:none !important; border-right:none !important;}
          .depletion-summary{grid-template-columns:1fr 1fr !important;}
          .table-wrap{overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;}
          .table-wrap table{table-layout:fixed;width:100%;}
          .col-age{display:none;}
          .table-wrap td,.table-wrap th{padding:6px 8px !important;font-size:10px !important;}
          .table-wrap .contrib-val{font-size:11px !important;}
          .table-wrap .cap-val{font-size:11px !important;}
          .header-buttons .help-btn{display:none !important;}
          .mob-section-tabs{display:flex !important;}
          .desktop-tabs{display:none !important;}
          .left-panel-wrap{ }
          .right-panel{ }
        }
        @media(min-width:701px){
          .mob-section-tabs{display:none !important;}
          .left-panel-wrap{display:block !important;}
        }
        .mob-section-tabs{display:none;background:#0c0b14;border-bottom:1px solid #1e1c2c;padding:10px 12px 0;gap:8px;position:relative;z-index:950;}
        .mob-section-tabs button{flex:1;background:rgba(255,255,255,0.03);border:1px solid #252336;border-bottom:none;border-radius:10px 10px 0 0;padding:10px 4px 8px;font-family:monospace;font-size:9px;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;white-space:nowrap;transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;}
        .mob-section-tabs button .tab-icon{font-size:16px;line-height:1;}
        .mob-section-tabs button.tab-active{background:#14131e;border-color:#c9a96e44;color:#c9a96e !important;border-bottom:2px solid #14131e;margin-bottom:-1px;}
        @keyframes panel-fade{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
        @keyframes onboard-pulse{0%,100%{box-shadow:0 0 8px rgba(0,212,255,0.15);}50%{box-shadow:0 0 20px rgba(0,212,255,0.7);}}
        @keyframes onboard-border{0%,100%{border-color:rgba(0,212,255,0.25);}50%{border-color:rgba(0,212,255,0.95);}}
        .onboard-card-pulse{animation:onboard-pulse 1.6s ease-in-out infinite, onboard-border 1.6s ease-in-out infinite;}
      `}</style>

      {showOnboarding && <Onboarding onClose={()=>{ setShowOnboarding(false); if(isMobile){setMobPanel("params");}else{setActiveTab("table");} }} onShowStrategy={()=>setShowStrategy(true)} onStepChange={setOnboardStep} isMobile={isMobile} />}
      {showStrategy   && <StrategyModal current={strategy} hasManual={hasManual} onSelect={s => { setStrategy(s); setFixedContribs({}); }} onClose={()=>setShowStrategy(false)} />}

      {/* MOBILE SECTION TABS */}
      <div id="mob-tabs-top" className="mob-section-tabs">
        {[
          { id:"params",    icon:"⚙️", label:"Параметры" },
          { id:"table",     icon:"📋", label:"Таблица" },
          { id:"depletion", icon:"📉", label:"Капитал" },
        ].map(({id, icon, label}) => {
          const active = mobPanel === id;
          return (
            <button key={id}
              className={active ? "tab-active" : ""}
              onClick={()=>{ setMobPanel(id); setActiveTab(id==="depletion"?"depletion":"table"); }}
              style={{ color: active ? "#c9a96e" : "#6860a0" }}>
              <span className="tab-icon">{icon}</span>
              <span>{label}</span>
            </button>
          );
        })}
        <button onClick={()=>setShowOnboarding(true)}
          style={{ flex:"0 0 auto", alignSelf:"center", marginBottom:6, width:36, height:36, background:"rgba(144,96,208,0.15)", border:"1px solid rgba(144,96,208,0.4)", borderRadius:"50%", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, color:"#9060d0", boxShadow:"0 0 10px rgba(144,96,208,0.2)", transition:"all 0.2s" }}>
          ❓
        </button>
      </div>

      <div style={{ maxWidth:1160, margin:"0 auto", padding:"0 12px" }}>

        {/* HEADER — скрыт на мобильном вне параметров */}
        <div style={{ display: isMobile ? "none" : "flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12, marginBottom:20, paddingTop:20 }}>
          <div>
            <div style={{ fontFamily:"monospace", fontSize:9, letterSpacing:"0.28em", color:"#3a3850", textTransform:"uppercase", marginBottom:8 }}>Пенсионный калькулятор</div>
            <h1 style={{ fontFamily:"'Playfair Display',serif", fontSize:"clamp(26px,3.5vw,44px)", fontWeight:900, margin:0, lineHeight:1.05, color:"#ece4d4" }}>
              Накопительный <span style={{ color:"#c9a96e", fontStyle:"italic" }}>план</span>
            </h1>
          </div>
          <div className="header-buttons" style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
            <button className="help-btn" onClick={()=>setShowOnboarding(true)}
              style={{ padding:"11px 20px", background:"rgba(255,255,255,0.04)", border:"1px solid #352f50", borderRadius:12, color:"#a098b8", cursor:"pointer", fontFamily:"monospace", fontSize:11, letterSpacing:"0.06em", display:"flex", alignItems:"center", gap:8, transition:"all 0.2s" }}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(255,255,255,0.08)";e.currentTarget.style.color="#ece4d4";e.currentTarget.style.borderColor="#555070";}}
              onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.color="#a098b8";e.currentTarget.style.borderColor="#352f50";}}>
              <span style={{ fontSize:15, opacity:0.8 }}>❓</span> Как это работает
            </button>
          </div>
        </div>


        <div className="main-grid" style={{ display:"grid", gridTemplateColumns:"300px 1fr", gap:16, alignItems:"start" }}>

          {/* LEFT */}
          <div className="left-panel-wrap" style={{ display: isMobile && mobPanel!=="params" ? "none" : "block", animation:"panel-fade 0.3s ease" }}>
          <div id="onboard-left-panel" style={{ display:"flex", flexDirection:"column", gap:12, paddingTop:16, paddingBottom:32 }}>

            <div id="onboard-params-assumptions" style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div className="panel" style={{ background:"linear-gradient(135deg,rgba(232,160,80,0.07),rgba(232,160,80,0.02))", border:"1px solid rgba(232,160,80,0.2)" }}>
              <Slider label="Расходы в месяц на пенсии" value={monthlyExpense} min={20000} max={1000000} step={10000} onChange={setMonthlyExpense} display={fmt} color="#e8a050" hint={`В деньгах ${baseYear}г · без учёта гос. пенсии`} />
              <Slider label="Желаемый возраст выхода на пенсию" value={retireAge} min={age+1} max={80} step={1} onChange={setRetireAge} display={v=>`${v} лет`} hint={`${years} лет до пенсии · выход в ${retireYear}г`} color="#e8a050" />
            </div>

            <div className="panel">
              <div className="section-label">Параметры</div>
              <Slider label="Ваш возраст" value={age} min={18} max={70} step={1} onChange={v=>{setAge(v);if(v>=retireAge)setRetireAge(v+1);}} display={v=>`${v} лет`} />
              <Slider label="Имеющиеся накопления" value={existingSavings} min={0} max={50000000} step={100000} onChange={setExistingSavings} display={v=>v===0?"0 ₽":fmt(v)} color="#c9a96e" hint={existingSavings>0?`Инвестируются под ${pct(returnRate)}`:"Нет накоплений"} editable={true} />
            </div>

            <div className="panel">
              <div className="section-label">Допущения</div>
              <Slider label="Инфляция в год" value={inflation} min={2} max={20} step={0.5} onChange={setInflation} display={pct} color="#d06060" />
              <Slider label="Доходность инвестиций" value={returnRate} min={0} max={25} step={0.5} onChange={setReturnRate} display={pct} hint={realReturnHint} color="#50b878" />
            </div>
            </div>{/* /onboard-params-assumptions */}

            {isMobile && showOnboarding && onboardStep === 2 && (() => {
              const _color = "#00d4ff";
              const _s = { emoji:"📐", sub:"Ключевой параметр пенсии", title:"Ставка изъятия", body:'% от капитала, который вы снимаете каждый год на пенсии. При 4% капитал исторически не уменьшается — "правило 4%". Чем ниже ставка, тем дольше хватит денег.' };
              return <div id="inline-card-2"><InlineOnboardCard color={_color} s={_s} step={2} steps={Array(6).fill(0)} onStep={(i)=>window.dispatchEvent(new CustomEvent("onboard-set-step",{detail:i}))} onClose={()=>{ setShowOnboarding(false); setMobPanel("params"); }} /></div>;
            })()}

            <div id="onboard-saferate" className="panel" style={{ background:"linear-gradient(135deg,rgba(144,96,208,0.07),rgba(144,96,208,0.02))", border:"1px solid rgba(144,96,208,0.2)" }}>
              <div style={{ fontFamily:"monospace", fontSize:9, letterSpacing:"0.14em", textTransform:"uppercase", color:"#9060d0", marginBottom:6 }}>Ставка изъятия на пенсии</div>
              <Slider label="% от капитала в год" value={safeRate} min={1} max={10} step={1} onChange={setSafeRate} display={pct} hint="Если ставка изъятия не превышает реальную доходность (доходность от инвестиций минус инфляция), капитал не исчерпается" color="#9060d0" />
            </div>

            {isMobile && showOnboarding && onboardStep === 3 && (() => {
              const _color = "#00d4ff";
              const _s = { emoji:"🎯", sub:"Как вы хотите копить?", title:"Стратегия взносов", body:"Выберите стратегию накопления в блоке ниже. Равномерная, фиксированная сумма или отложенный старт — все варианты достигают цели." };
              return <div id="inline-card-3"><InlineOnboardCard color={_color} s={_s} step={3} steps={Array(6).fill(0)} onStep={(i)=>window.dispatchEvent(new CustomEvent("onboard-set-step",{detail:i}))} onClose={()=>{ setShowOnboarding(false); setMobPanel("params"); }} /></div>;
            })()}

            <div id="onboard-strategy" className="panel" style={{ cursor:"pointer" }} onClick={()=>setShowStrategy(true)}>
              <div className="section-label">Стратегия взносов</div>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", background:"rgba(255,255,255,0.03)", borderRadius:10, border:"1px solid #252336", transition:"border-color 0.15s" }}
                onMouseEnter={e=>e.currentTarget.style.borderColor=displayStrategy?.color||"#c9a96e"}
                onMouseLeave={e=>e.currentTarget.style.borderColor="#252336"}>
                <span style={{ fontSize:20, color:displayStrategy?.color }}>{displayStrategy?.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"'Playfair Display',serif", fontSize:14, fontWeight:700, color:displayStrategy?.color }}>{displayStrategy?.name}</div>
                  <div style={{ fontFamily:"monospace", fontSize:9, color:"#7870a0", marginTop:2 }}>нажмите для смены →</div>
                </div>
              </div>
            </div>

            {fixedCount>0 && (
              <button onClick={resetAll} style={{ background:"none", border:"1px solid #2a1a1a", color:"#6a3838", borderRadius:8, padding:"10px 14px", fontFamily:"monospace", fontSize:9, letterSpacing:"0.12em", cursor:"pointer", textTransform:"uppercase", transition:"all 0.15s" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="#c05050";e.currentTarget.style.color="#c05050";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="#2a1a1a";e.currentTarget.style.color="#6a3838";}}>
                ↺ Сбросить изменённые взносы ({fixedCount})
              </button>
            )}

          </div>{/* /onboard-left-panel */}
          </div>{/* /left-panel-wrap */}

          {/* RIGHT — always visible on desktop; on mobile shown when params tab NOT active */}
          <div id="onboard-right-panel" className="right-panel" style={{ background:"#14131e", border:"1px solid #252336", borderRadius:14, overflow:"hidden", display: isMobile && mobPanel==="params" ? "none" : "block", animation:"panel-fade 0.3s ease" }}>
            <div className="desktop-tabs" style={{ display:"flex", alignItems:"center", gap:2, padding:"10px 16px", borderBottom:"1px solid #1e1c2c", background:"#111020" }}>
              {[["table","📋 Таблица взносов"],["depletion","📉 Жизнь капитала"]].map(([id,label])=>(
                <button key={id} id={id==="depletion"?"onboard-depletion-tab":undefined} className="tab" onClick={()=>{ setActiveTab(id); setMobPanel(id==="depletion"?"depletion":"table"); }}
                  style={{ color:activeTab===id?"#c9a96e":"#6860a0", background:activeTab===id?"rgba(201,169,110,0.1)":"none", borderBottom:activeTab===id?"2px solid #c9a96e":"2px solid transparent" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* TABLE */}
            {activeTab==="table" && (
              <div className="table-wrap" style={{ overflowY:"auto", overflowX:"hidden", maxHeight:"80vh", WebkitOverflowScrolling:"touch", touchAction:"pan-y" }}>
                <div style={{ display:"flex", gap:0, borderBottom:"1px solid #1e1c2c" }}>
                  <div style={{ flex:1, padding:"12px 18px", borderRight:"1px solid #1e1c2c" }}>
                    <div style={{ fontFamily:"monospace", fontSize:8, letterSpacing:"0.12em", color:"#7870a0", textTransform:"uppercase", marginBottom:4 }}>Нужно накопить</div>
                    <NominalTooltip nominalValue={targetCapitalNominal} realValue={targetCapitalReal} baseYear={baseYear}>
                      <span style={{ fontFamily:"'Playfair Display',serif", fontSize:18, fontWeight:700, color:"#c9a96e", borderBottom:"1px dashed rgba(201,169,110,0.35)", paddingBottom:1, cursor:"default" }}>{fmtM(targetCapitalNominal)}</span>
                    </NominalTooltip>
                  </div>
                  <div style={{ flex:1, padding:"12px 18px" }}>
                    <div style={{ fontFamily:"monospace", fontSize:8, letterSpacing:"0.12em", color: isOnTrack?"#50b878":finalProgress<50?"#c05050":"#c9a96e", textTransform:"uppercase", marginBottom:4 }}>
                      {isOnTrack?"✓ Цель достигается":finalProgress<50?"✗ Недостаточно":"~ Близко к цели"}
                    </div>
                    <span style={{ fontFamily:"'Playfair Display',serif", fontSize:18, fontWeight:700, color:isOnTrack?"#50b878":finalProgress<50?"#c05050":"#c9a96e" }}>{pct(Math.min(finalProgress,100))}</span>
                    <span style={{ fontFamily:"monospace", fontSize:9, color:"#5a5878", marginLeft:8 }}>{isOnTrack?"план выполняется":"скорректируйте взносы"}</span>
                  </div>
                </div>
                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                  <thead style={{ background:"#111020" }}>
                    <tr style={{ borderBottom:"1px solid #1e1c2c" }}>
                      {[["Год","left",null],["Возраст","left","col-age"],["Взнос/мес ✎","right",null],["Капитал к году","right",null],["Прогресс","right",null]].map(([h,a,cn])=>(
                        <th key={h} className={cn||""} style={{ padding:"9px 14px", textAlign:a, fontFamily:"monospace", fontSize:9, letterSpacing:"0.07em", color:h.includes("✎")?"rgba(201,169,110,0.7)":"#7870a0", textTransform:"uppercase", fontWeight:400, whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row=>{
                      const isEditing = editingYear===row.year;
                      const milestone = row.age%5===0;
                      const goalMet   = row.progress>=99.9;
                      const isHovered = hoveredRow===row.year;
                      const rowBg     = isHovered?"rgba(255,255,255,0.045)":milestone?"rgba(201,169,110,0.025)":"transparent";
                      return (
                        <tr key={row.year}
                          onMouseEnter={()=>setHoveredRow(row.year)}
                          onMouseLeave={()=>setHoveredRow(null)}
                          style={{ borderBottom:"1px solid #141222" }}>
                          <td style={{ padding:"8px 14px", fontFamily:"monospace", fontSize:11, color:"#6866a0", background:rowBg }}>{row.year}</td>
                          <td className="col-age" style={{ padding:"8px 14px", fontFamily:"'Playfair Display',serif", fontSize:15, color:milestone?"#c9a96e":"#5a5870", fontWeight:milestone?700:400, background:rowBg }}>{row.age}</td>
                          <td className={isEditing?"":"cc"}
                            onClick={()=>{ if(isEditing) return; if(window.innerWidth>700) startEdit(row.year,row.contribNominal); }}
                            style={{ padding:"8px 14px", textAlign:"right", background:isHovered?"rgba(255,255,255,0.045)":row.isFixed?"rgba(201,169,110,0.04)":milestone?"rgba(201,169,110,0.025)":"transparent" }}>
                            {isEditing ? (
                              <input className="ei" value={editValue} autoFocus onChange={e=>setEditValue(e.target.value)} onBlur={()=>commitEdit(row.year)} onKeyDown={e=>{if(e.key==="Enter")commitEdit(row.year);if(e.key==="Escape")setEditingYear(null);}} />
                            ) : (
                              <span style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", gap:6 }}>
                                {row.isFixed && <button className={`rb${row.isFixed?" rb-visible":""}`} onClick={e=>resetYear(row.year,e)}>↩</button>}
                                <NominalTooltip nominalValue={row.contribNominal} realValue={Math.round(row.contribReal)} baseYear={baseYear}
                                  onTapEdit={()=>startEdit(row.year,row.contribNominal)}>
                                  <span style={{ display:"flex", alignItems:"center", gap:7 }}>
                                    {row.isFixed && (
                                      <span style={{ fontFamily:"monospace", fontSize:8, letterSpacing:"0.06em", textTransform:"uppercase", color:"#a08840", background:"rgba(201,169,110,0.1)", border:"1px solid rgba(201,169,110,0.2)", borderRadius:3, padding:"2px 5px", whiteSpace:"nowrap" }}>✎ вручную</span>
                                    )}
                                    <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:row.isFixed?"#e0c060":"#c9a96e", borderBottom:"1px dashed rgba(201,169,110,0.45)", paddingBottom:1, cursor:"pointer" }}>
                                      {fmt(row.contribNominal)}
                                    </span>
                                  </span>
                                </NominalTooltip>
                              </span>
                            )}
                          </td>
                          <td style={{ padding:"8px 14px", textAlign:"right", background:rowBg }}>
                            <NominalTooltip nominalValue={row.capitalNominal} realValue={Math.round(row.capitalReal)} baseYear={baseYear}>
                              <span style={{ fontFamily:"'Playfair Display',serif", fontSize:13, color:goalMet?"#60c878":"#b0a8c8", fontWeight:600, borderBottom:"1px dashed rgba(255,255,255,0.12)", paddingBottom:1, cursor:"default" }}>
                                {fmtM(row.capitalNominal)}
                              </span>
                            </NominalTooltip>
                          </td>
                          <td style={{ padding:"8px 14px", textAlign:"right", background:rowBg }}>
                            <div style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", gap:6 }}>
                              <div style={{ width:48, height:3, background:"#1e1c2c", borderRadius:2 }}>
                                <div style={{ height:"100%", width:`${Math.min(100,row.progress)}%`, background:row.progress>=99.9?"#50aa58":row.progress>60?"#c9a96e":"#c05050", borderRadius:2 }}/>
                              </div>
                              <span style={{ fontFamily:"monospace", fontSize:9, color:"#7870a0", minWidth:34 }}>{pct(Math.min(row.progress,100))}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* DEPLETION */}
            {activeTab==="depletion" && (() => {
              const currentRow = depletionData.find(d=>d.rate===safeRate)||depletionData[0];
              return (
              <div style={{ overflowY:"auto", maxHeight:"78vh" }}>

                {/* Шапка — ваш текущий план */}
                <div style={{ padding:"16px 20px", background:"rgba(201,169,110,0.07)", borderBottom:"1px solid rgba(201,169,110,0.2)" }}>
                  <div style={{ fontFamily:"monospace", fontSize:8, letterSpacing:"0.14em", textTransform:"uppercase", color:"#c9a96e", marginBottom:8 }}>Ваш план · ставка изъятия {safeRate}% в год</div>
                  <div style={{ display:"flex", gap:20, flexWrap:"wrap", alignItems:"flex-start" }}>
                    <div>
                      <NominalTooltip nominalValue={currentRow.totalNominal} realValue={currentRow.totalReal} baseYear={baseYear}>
                        <div style={{ fontFamily:"'Playfair Display',serif", fontSize:26, fontWeight:700, color:"#d8c880", lineHeight:1, borderBottom:"1px dashed rgba(216,200,128,0.35)", paddingBottom:2, cursor:"default", display:"inline-block" }}>
                          {fmt(currentRow.totalNominal)}<span style={{ fontSize:13, color:"#8880a8", fontWeight:400 }}>/мес</span>
                        </div>
                      </NominalTooltip>
                      <div style={{ fontFamily:"monospace", fontSize:10, color:"#8880a8", marginTop:5, lineHeight:1.6 }}>
                        сумма из капитала, которую можно тратить в месяц (без учёта гос. пенсии)
                      </div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontFamily:"'Playfair Display',serif", fontSize:18, fontWeight:700, color:currentRow.infinite?"#60cc68":"#d8b860", lineHeight:1 }}>
                        {currentRow.infinite?"∞ — навсегда":`${currentRow.years} ${yrsWord(currentRow.years)}`}
                      </div>
                      <div style={{ fontFamily:"monospace", fontSize:9, color:"#7870a0", marginTop:4 }}>
                        {currentRow.infinite?"капитал не иссякнет":`деньги закончатся в ${currentRow.exhaustAge} лет`}
                      </div>
                      {(()=>{
                        const realReturn = returnRate - inflation;
                        const netGrowth  = realReturn - safeRate;
                        if (netGrowth <= 0) return null;
                        return (
                          <div style={{ marginTop:8, padding:"5px 10px", background:"rgba(80,184,120,0.1)", border:"1px solid rgba(80,184,120,0.25)", borderRadius:6, textAlign:"right" }}>
                            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:16, fontWeight:700, color:"#50b878" }}>+{netGrowth.toFixed(1)}% в год</div>
                            <div style={{ fontFamily:"monospace", fontSize:9, color:"#50a870", marginTop:2 }}>капитал растёт после трат</div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Пояснение */}
                <div style={{ padding:"10px 20px", borderBottom:"1px solid #1e1c2c", fontFamily:"monospace", fontSize:10, color:"#7870a0", lineHeight:1.7 }}>
                  Ниже — сколько можно тратить в месяц и на сколько хватит капитала при разных ставках изъятия
                </div>

                {/* Таблица всех ставок */}
                <div style={{ padding:"8px 12px", display:"flex", flexDirection:"column", gap:5 }}>
                  {depletionData.map(d=>{
                    const isCurrent  = d.rate===safeRate;
                    const statusColor = d.infinite?"#60cc68":(d.years||0)>=30?"#d8b860":(d.years||0)>=20?"#d09040":"#d06060";
                    const lifetimeLabel = d.infinite ? "∞ навсегда" : (d.years||0)===0 ? "< 1 года" : `${d.years} ${yrsWord(d.years)}`;
                    const subLabel = d.infinite ? "капитал не иссякнет" : (d.years||0)>0 ? `закончатся в ${d.exhaustAge} лет` : "капитал закончится сразу";
                    return (
                      <div key={d.rate} style={{
                        borderRadius:10,
                        background: isCurrent?"rgba(201,169,110,0.07)":"rgba(255,255,255,0.015)",
                        border: isCurrent?"1px solid rgba(201,169,110,0.35)":"1px solid rgba(255,255,255,0.04)",
                        padding:"11px 14px",
                        display:"grid",
                        gridTemplateColumns:"52px 1fr auto",
                        gap:"0 14px",
                        alignItems:"center",
                        position:"relative",
                        overflow:"hidden"
                      }}>
                        {/* Цветная черта слева */}
                        <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background:statusColor, borderRadius:"10px 0 0 10px" }}/>

                        {/* % изъятия */}
                        <div style={{ paddingLeft:6 }}>
                          <div style={{ fontFamily:"'Playfair Display',serif", fontSize:20, fontWeight:700, color:isCurrent?"#c9a96e":"#7870a0", lineHeight:1 }}>{d.rate}%</div>
                          <div style={{ fontFamily:"monospace", fontSize:8, color:"#7060a0", marginTop:2, letterSpacing:"0.06em" }}>ИЗЪЯТИЕ</div>
                        </div>

                        {/* Доход */}
                        <div>
                          <NominalTooltip nominalValue={d.totalNominal} realValue={d.totalReal} baseYear={baseYear}>
                            <span style={{ fontFamily:"'Playfair Display',serif", fontSize:15, fontWeight:700, color: isCurrent?"#d8c880":"#9890a8", borderBottom:"1px dashed rgba(201,169,110,0.25)", paddingBottom:1, cursor:"default" }}>
                              {fmt(d.totalNominal)}/мес
                            </span>
                          </NominalTooltip>
                          <div style={{ fontFamily:"monospace", fontSize:9, color:"#6860a0", marginTop:3 }}>
                            можно тратить в месяц в {retireYear}г (из капитала + гос. пенсия)
                          </div>
                        </div>

                        {/* Срок */}
                        <div style={{ textAlign:"right" }}>
                          {isCurrent && (
                            <div style={{ fontFamily:"monospace", fontSize:8, letterSpacing:"0.08em", color:"#c9a96e", background:"rgba(201,169,110,0.15)", padding:"2px 5px", borderRadius:3, whiteSpace:"nowrap", display:"inline-block", marginBottom:4 }}>ВАШ ПЛАН</div>
                          )}
                          <div style={{ fontFamily:"'Playfair Display',serif", fontSize:14, fontWeight:700, color:statusColor, lineHeight:1 }}>{lifetimeLabel}</div>
                          <div style={{ fontFamily:"monospace", fontSize:9, color:"#6860a0", marginTop:3 }}>{subLabel}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Легенда */}
                <div style={{ padding:"10px 20px 16px", display:"flex", gap:16, flexWrap:"wrap" }}>
                  {[["#60cc68","Капитал вечен"],["#d8b860","30+ лет"],["#d09040","20–30 лет"],["#d06060","< 20 лет"]].map(([c,l])=>(
                    <div key={l} style={{ display:"flex", alignItems:"center", gap:5, fontFamily:"monospace", fontSize:9, color:"#7870a0" }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background:c, flexShrink:0 }}/>{l}
                    </div>
                  ))}
                </div>
              </div>
              );
            })()}
          </div>
        </div>

      </div>


    </div>
  );
}
