import { useState, useMemo } from "react";

const fmt = (n) => Math.round(n).toLocaleString("ru-RU") + " ₽";
const fmtM = (n) => {
  if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + " млрд ₽";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + " млн ₽";
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
};
const pct = (n) => (typeof n === "number" ? n.toFixed(1) : "0.0") + "%";
const yrsWord = (n) => n === 1 ? "год" : n < 5 ? "года" : "лет";

function solveFixedReal(curCap, targetCap, remYears, realReturn) {
  if (remYears <= 0) return 0;
  const r = realReturn / 12;
  const n = remYears * 12;
  const fv = curCap * Math.pow(1 + r, n);
  const needed = targetCap - fv;
  if (needed <= 0) return 0;
  const factor = r > 0 ? (Math.pow(1 + r, n) - 1) / r : n;
  return needed / factor;
}

function buildSchedule(baseYear, age, retireAge, monthlyExpense, statePension, inflation, returnRate, safeRate, fixedContribs, existingSavings) {
  const years = retireAge - age;
  if (years <= 0) return { rows: [], targetCapitalReal: 0, targetCapitalNominal: 0 };
  const inf = inflation / 100;
  const realReturn = (returnRate - inflation) / 100;
  const rMonth = realReturn / 12;
  const futureMonthly = monthlyExpense * Math.pow(1 + inf, years);
  const futureStatePension = statePension * Math.pow(1 + inf, years);
  const netYearly = Math.max(0, (futureMonthly - futureStatePension) * 12);
  const targetCapitalNominal = netYearly / (safeRate / 100);
  const targetCapitalReal = targetCapitalNominal / Math.pow(1 + inf, years);
  // Existing savings treated as already invested at real return
  let capitalReal = (existingSavings || 0);
  const rows = [];
  for (let y = 0; y < years; y++) {
    const calYear = baseYear + y;
    const inflFactor = Math.pow(1 + inf, y);
    const isFixed = fixedContribs[calYear] !== undefined;
    let contribReal = isFixed
      ? fixedContribs[calYear] / inflFactor
      : solveFixedReal(capitalReal, targetCapitalReal, years - y, realReturn);
    const contribNominal = contribReal * inflFactor;
    for (let m = 0; m < 12; m++) capitalReal = capitalReal * (1 + rMonth) + contribReal;
    const capitalNominal = capitalReal * Math.pow(1 + inf, y + 1);
    rows.push({
      year: calYear, age: age + y, isFixed,
      contribNominal: Math.round(contribNominal),
      contribReal,
      capitalReal,
      capitalNominal,
      progress: Math.min(200, (capitalReal / targetCapitalReal) * 100),
    });
  }
  return { rows, targetCapitalReal, targetCapitalNominal };
}

function buildDepletion(capitalAtRetireReal, retireAge, age, baseYear, inflation, returnRate, statePension) {
  const retireYear = baseYear + (retireAge - age);
  const realReturn = (returnRate - inflation) / 100;
  const rMonth = realReturn / 12;
  const inf = inflation / 100;
  const yearsToRetire = retireAge - age;
  const capitalNominal = capitalAtRetireReal * Math.pow(1 + inf, yearsToRetire);
  const statePensionNominal = statePension * Math.pow(1 + inf, yearsToRetire);
  return [1,2,3,4,5,6,7,8,9,10].map(rate => {
    const monthlyWithdrawalReal = capitalAtRetireReal * (rate / 100) / 12;
    const monthlyWithdrawalNominal = capitalNominal * (rate / 100) / 12;
    let cap = capitalAtRetireReal;
    let months = 0;
    const maxMonths = 1200;
    while (cap > 0 && months < maxMonths) {
      cap = cap * (1 + rMonth) - monthlyWithdrawalReal;
      months++;
    }
    const yrs = months >= maxMonths ? null : Math.floor(months / 12);
    return {
      rate, infinite: months >= maxMonths, years: yrs,
      exhaustAge: yrs === null ? null : retireAge + yrs,
      exhaustYear: yrs === null ? null : retireYear + yrs,
      totalNominal: Math.round(monthlyWithdrawalNominal + statePensionNominal),
      totalReal: Math.round(monthlyWithdrawalReal + statePension),
    };
  });
}

function Slider({ label, value, min, max, step, onChange, display, hint, color = "#c9a96e" }) {
  const frac = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const trackStyle = `
    .slider-${color.replace('#','')}::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 20px; height: 20px; border-radius: 50%;
      background: ${color}; cursor: pointer;
      box-shadow: 0 0 0 3px #18162288, 0 0 10px ${color}66;
      margin-top: -8px;
    }
    .slider-${color.replace('#','')}::-moz-range-thumb {
      width: 20px; height: 20px; border-radius: 50%; border: none;
      background: ${color}; cursor: pointer;
      box-shadow: 0 0 0 3px #18162288, 0 0 10px ${color}66;
    }
    .slider-${color.replace('#','')}::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(to right, ${color} ${frac*100}%, #2a2838 ${frac*100}%);
    }
    .slider-${color.replace('#','')}::-moz-range-track {
      height: 4px; border-radius: 2px; background: #2a2838;
    }
    .slider-${color.replace('#','')}::-moz-range-progress {
      height: 4px; border-radius: 2px; background: ${color};
    }
    .slider-${color.replace('#','')} { outline: none; }
  `;
  return (
    <div style={{ marginBottom: 20 }}>
      <style>{trackStyle}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9890a8", fontFamily: "monospace", flexShrink: 1, minWidth: 0 }}>{label}</span>
        <span style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "'Playfair Display', serif", flexShrink: 0, whiteSpace: "nowrap" }}>{display(value)}</span>
      </div>
      {hint && <div style={{ fontSize: 10, color: "#7870a0", fontFamily: "monospace", marginBottom: 6 }}>{hint}</div>}
      <input
        type="range" min={min} max={max} step={step} value={value}
        className={`slider-${color.replace('#','')}`}
        onChange={e => onChange(Number(e.target.value))}
        style={{
          width: "100%", height: 4, cursor: "pointer",
          WebkitAppearance: "none", appearance: "none",
          background: "transparent", margin: "6px 0", display: "block",
        }}
      />
    </div>
  );
}

export default function PensionCalculator() {
  const [baseYear, setBaseYear] = useState(2026);
  const [age, setAge] = useState(30);
  const [retireAge, setRetireAge] = useState(60);
  const [monthlyExpense, setMonthlyExpense] = useState(200000);
  const [statePension, setStatePension] = useState(25000);
  const [inflation, setInflation] = useState(8);
  const [returnRate, setReturnRate] = useState(12);
  const [safeRate, setSafeRate] = useState(3);
  const [existingSavings, setExistingSavings] = useState(0);
  const [fixedContribs, setFixedContribs] = useState({});
  const [editingYear, setEditingYear] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [activeTab, setActiveTab] = useState("table");

  const years = retireAge - age;
  const inf = inflation / 100;

  const { rows, targetCapitalReal, targetCapitalNominal } = useMemo(() =>
    buildSchedule(baseYear, age, retireAge, monthlyExpense, statePension, inflation, returnRate, safeRate, fixedContribs, existingSavings),
    [baseYear, age, retireAge, monthlyExpense, statePension, inflation, returnRate, safeRate, fixedContribs, existingSavings]
  );

  const finalCapital = rows[rows.length - 1]?.capitalReal || 0;
  const finalCapitalNominal = rows[rows.length - 1]?.capitalNominal || 0;
  const finalProgress = rows[rows.length - 1]?.progress || 0;
  const isOnTrack = finalProgress >= 99;
  const totalContribReal = rows.reduce((s, r) => s + r.contribReal * 12, 0);
  const fixedCount = Object.keys(fixedContribs).filter(y => Number(y) >= baseYear && Number(y) < baseYear + years).length;

  const depletionData = useMemo(() =>
    buildDepletion(finalCapital, retireAge, age, baseYear, inflation, returnRate, statePension),
    [finalCapital, retireAge, age, baseYear, inflation, returnRate, statePension]
  );

  const startEdit = (year, current) => { setEditingYear(year); setEditValue(String(current)); };
  const commitEdit = (year) => {
    const val = parseInt(editValue.replace(/\D/g, "")) || 0;
    setFixedContribs(prev => ({ ...prev, [year]: val }));
    setEditingYear(null);
  };
  const resetYear = (year, e) => {
    e.stopPropagation();
    setFixedContribs(prev => { const n = { ...prev }; delete n[year]; return n; });
  };
  const resetAll = () => setFixedContribs({});

  const realReturnHint = returnRate > inflation
    ? `Реальная доходность: ${pct(returnRate - inflation)}`
    : returnRate === inflation ? "Реальная доходность: 0% (= инфляция)" : "⚠ Доходность ниже инфляции";

  const retireYear = baseYear + years;

  return (
    <div style={{ minHeight: "100vh", background: "#0c0b14", color: "#ddd4c0", fontFamily: "Georgia, serif", padding: "24px 12px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #14131e; }
        ::-webkit-scrollbar-thumb { background: #3a3050; border-radius: 2px; }
        .rh:hover td { background: rgba(255,255,255,0.025) !important; }
        .cc { cursor: pointer; transition: background 0.1s; }
        .cc:hover { background: rgba(201,169,110,0.12) !important; }
        .rb { opacity: 0; transition: opacity 0.15s; background: none; border: none; cursor: pointer; color: #aa5050; font-size: 12px; padding: 0 3px; line-height: 1; }
        tr:hover .rb { opacity: 1; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; }
        .ei { background: #1e1c28; border: 1px solid #c9a96e; color: #f0e8d0; padding: 3px 8px; font-family: monospace; font-size: 12px; width: 120px; border-radius: 4px; outline: none; text-align: right; }
        .tab { background: none; border: none; cursor: pointer; padding: 7px 16px; font-family: monospace; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; border-radius: 6px; transition: all 0.15s; }
        .panel { background: #14131e; border: 1px solid #252336; border-radius: 14px; padding: 20px 22px; }
        .section-label { font-family: monospace; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; margin-bottom: 16px; color: #7870a0; }
        @media (max-width: 700px) {
          .main-grid { grid-template-columns: 1fr !important; }
          .summary-cards { grid-template-columns: 1fr 1fr !important; }
          .depletion-summary { grid-template-columns: 1fr !important; }
          .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        }
      `}</style>

      <div style={{ maxWidth: 1160, margin: "0 auto" }}>

        {/* ── HEADER ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, marginBottom: 28 }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "0.28em", color: "#3a3850", textTransform: "uppercase", marginBottom: 8 }}>
              Пенсионный калькулятор
            </div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: "clamp(26px,3.5vw,44px)", fontWeight: 900, margin: 0, lineHeight: 1.05, color: "#ece4d4" }}>
              Накопительный <span style={{ color: "#c9a96e", fontStyle: "italic" }}>план</span>
            </h1>
          </div>
          {/* Target capital summary */}
          <div className="summary-cards" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[
              ["Целевой капитал", fmtM(targetCapitalNominal), `${fmtM(targetCapitalReal)} · деньги ${baseYear}г`],
              [isOnTrack ? "✓ Цель достигается" : finalProgress < 50 ? "✗ Недостаточно" : "~ Близко к цели",
                pct(Math.min(finalProgress, 100)),
                isOnTrack ? "план выполняется" : "скорректируйте взносы"],
            ].map(([label, val, sub]) => (
              <div key={label} style={{ background: "#14131e", border: "1px solid #252336", borderRadius: 12, padding: "14px 20px", minWidth: 160 }}>
                <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "0.1em", color: "#7870a0", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
                <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#c9a96e", lineHeight: 1 }}>{val}</div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#7878a0", marginTop: 4 }}>{sub}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="main-grid" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, alignItems: "start" }}>

          {/* ── LEFT PANEL ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Year selector */}
            <div className="panel">
              <div className="section-label">Текущий год</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button onClick={() => setBaseYear(y => Math.max(2000, y - 1))}
                  style={{ background: "#1e1c2c", border: "1px solid #352f50", color: "#a090c0", borderRadius: 6, width: 32, height: 32, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                <div style={{ flex: 1, textAlign: "center", fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 700, color: "#c9a96e" }}>{baseYear}</div>
                <button onClick={() => setBaseYear(y => Math.min(2100, y + 1))}
                  style={{ background: "#1e1c2c", border: "1px solid #352f50", color: "#a090c0", borderRadius: 6, width: 32, height: 32, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
              </div>
            </div>

            {/* Parameters */}
            <div className="panel">
              <div className="section-label">Параметры</div>
              <Slider label="Ваш возраст" value={age} min={18} max={70} step={1}
                onChange={v => { setAge(v); if (v >= retireAge) setRetireAge(v + 1); }} display={v => `${v} лет`} />
              <Slider label="Возраст выхода на пенсию" value={retireAge} min={age + 1} max={80} step={1}
                onChange={setRetireAge} display={v => `${v} лет`}
                hint={`${years} лет до пенсии · выход в ${retireYear}г`} />
              <Slider label="Имеющиеся накопления" value={existingSavings} min={0} max={50000000} step={100000}
                onChange={setExistingSavings} display={v => v === 0 ? "0 ₽" : fmtM(v)} color="#c9a96e"
                hint={existingSavings > 0 ? `Инвестируются под ${pct(returnRate)} годовых` : "Нет накоплений"} />
              <Slider label="Расходы на пенсии" value={monthlyExpense} min={20000} max={1000000} step={10000}
                onChange={setMonthlyExpense} display={fmt} color="#e8a050" hint={`В деньгах ${baseYear}г`} />
              <Slider label="Гос. пенсия (прогноз)" value={statePension} min={0} max={150000} step={1000}
                onChange={setStatePension} display={fmt} color="#6090c8" hint={`В деньгах ${baseYear}г`} />
            </div>

            {/* Assumptions */}
            <div className="panel">
              <div className="section-label">Допущения</div>
              <Slider label="Инфляция в год" value={inflation} min={2} max={20} step={0.5}
                onChange={setInflation} display={pct} color="#d06060" />
              <Slider label="Доходность инвестиций" value={returnRate} min={0} max={25} step={0.5}
                onChange={setReturnRate} display={pct} hint={realReturnHint} color="#50b878" />
              <Slider label="Ставка изъятия" value={safeRate} min={1} max={10} step={0.5}
                onChange={setSafeRate} display={pct} hint="3% — консервативно · 4% — классика · 6%+ — агрессивно" color="#9060d0" />
            </div>

            {/* Summary stats */}
            <div style={{ background: isOnTrack ? "#0e1c10" : "#160e08", border: `1px solid ${isOnTrack ? "#1e3a22" : "#2e1e0a"}`, borderRadius: 14, padding: "16px 20px" }}>
              <div className="section-label" style={{ color: isOnTrack ? "#3a7040" : "#6a4010" }}>
                {isOnTrack ? "✓ Итог" : "⚠ Итог"}
              </div>
              {[
                ["Имеющиеся накопления", fmtM(existingSavings)],
                ["Цель (реал.)", fmtM(targetCapitalReal)],
                ["Цель (номинал)", fmtM(targetCapitalNominal)],
                ["Накопите (реал.)", fmtM(finalCapital)],
                ["Накопите (номинал)", fmtM(finalCapitalNominal)],
                ["Итого взносов (реал.)", fmtM(totalContribReal)],
                ["Зафиксировано", `${fixedCount} из ${years} лет`],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: "#7870a8" }}>{k}</span>
                  <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 13, fontWeight: 700, color: "#ccc4a8", textAlign: "right" }}>{v}</span>
                </div>
              ))}
              <div style={{ marginTop: 12, height: 4, background: "#1c1a28", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${Math.min(100, finalProgress)}%`, background: isOnTrack ? "#50aa58" : finalProgress > 60 ? "#c9a96e" : "#c05050", borderRadius: 2, transition: "width 0.3s" }} />
              </div>
            </div>

            {fixedCount > 0 && (
              <button onClick={resetAll}
                style={{ background: "none", border: "1px solid #2a1a1a", color: "#6a3838", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: 9, letterSpacing: "0.12em", cursor: "pointer", textTransform: "uppercase", transition: "all 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#c05050"; e.currentTarget.style.color = "#c05050"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#2a1a1a"; e.currentTarget.style.color = "#6a3838"; }}>
                ↺ Сбросить зафиксированные взносы ({fixedCount})
              </button>
            )}
          </div>

          {/* ── RIGHT PANEL ── */}
          <div style={{ background: "#14131e", border: "1px solid #252336", borderRadius: 14, overflow: "hidden" }}>

            {/* Tab bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "12px 18px", borderBottom: "1px solid #1e1c2c", background: "#111020" }}>
              {[["table", "Таблица"], ["depletion", "Исчерпание капитала"]].map(([id, label]) => (
                <button key={id} className="tab" onClick={() => setActiveTab(id)}
                  style={{ color: activeTab === id ? "#c9a96e" : "#6860a0", background: activeTab === id ? "rgba(201,169,110,0.1)" : "none", borderBottom: activeTab === id ? "2px solid #c9a96e" : "2px solid transparent" }}>
                  {label}
                </button>
              ))}
              {activeTab === "table" && (
                <div style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 9, color: "#4a4870" }}>
                  клик на взнос → изменить · ✕ → авто
                </div>
              )}
            </div>

            {/* TABLE TAB */}
            {activeTab === "table" && (
              <div className="table-wrap" style={{ overflowY: "auto", maxHeight: "76vh" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead style={{ position: "sticky", top: 0, background: "#111020", zIndex: 2 }}>
                    <tr style={{ borderBottom: "1px solid #1e1c2c" }}>
                      {[
                        ["Год", "left"], ["Возраст", "left"], ["Тип", "center"],
                        ["Взнос/мес (номин.)", "right"], ["Взнос (реал.)", "right"],
                        ["Капитал (номин.)", "right"], ["Капитал (реал.)", "right"],
                        ["Прогресс", "right"]
                      ].map(([h, a]) => (
                        <th key={h} style={{ padding: "9px 14px", textAlign: a, fontFamily: "monospace", fontSize: 9, letterSpacing: "0.08em", color: "#7870a0", textTransform: "uppercase", fontWeight: 400, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const isEditing = editingYear === row.year;
                      const milestone = row.age % 5 === 0;
                      const goalMet = row.capitalReal >= targetCapitalReal;
                      return (
                        <tr key={row.year} className="rh" style={{ borderBottom: "1px solid #141222", background: milestone ? "rgba(201,169,110,0.025)" : "transparent" }}>
                          <td style={{ padding: "8px 14px", fontFamily: "monospace", fontSize: 11, color: "#6866a0" }}>{row.year}</td>
                          <td style={{ padding: "8px 14px", fontFamily: "'Playfair Display', serif", fontSize: 15, color: milestone ? "#c9a96e" : "#5a5870", fontWeight: milestone ? 700 : 400 }}>{row.age}</td>
                          <td style={{ padding: "8px 14px", textAlign: "center" }}>
                            <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontFamily: "monospace", fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", background: row.isFixed ? "rgba(201,169,110,0.12)" : "rgba(80,184,120,0.1)", color: row.isFixed ? "#c0a050" : "#50a870", border: `1px solid ${row.isFixed ? "rgba(201,169,110,0.22)" : "rgba(80,184,120,0.2)"}` }}>
                              {row.isFixed ? "зафикс." : "авто"}
                            </span>
                          </td>
                          <td className={isEditing ? "" : "cc"} onClick={() => !isEditing && startEdit(row.year, row.contribNominal)}
                            style={{ padding: "8px 14px", textAlign: "right", background: row.isFixed ? "rgba(201,169,110,0.04)" : "transparent" }}>
                            {isEditing ? (
                              <input className="ei" value={editValue} autoFocus
                                onChange={e => setEditValue(e.target.value)}
                                onBlur={() => commitEdit(row.year)}
                                onKeyDown={e => { if (e.key === "Enter") commitEdit(row.year); if (e.key === "Escape") setEditingYear(null); }} />
                            ) : (
                              <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                                {row.isFixed && <button className="rb" onClick={e => resetYear(row.year, e)} title="Сбросить на авто">✕</button>}
                                <span style={{ fontFamily: "monospace", fontSize: 12, color: row.isFixed ? "#e0c060" : "#6a6878" }}>{fmt(row.contribNominal)}</span>
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "8px 14px", textAlign: "right", fontFamily: "monospace", fontSize: 11, color: "#8880b0" }}>{fmt(Math.round(row.contribReal))}</td>
                          <td style={{ padding: "8px 14px", textAlign: "right", fontFamily: "'Playfair Display', serif", fontSize: 13, color: goalMet ? "#60c878" : "#b0a8c8", fontWeight: 600 }}>{fmtM(row.capitalNominal)}</td>
                          <td style={{ padding: "8px 14px", textAlign: "right", fontFamily: "'Playfair Display', serif", fontSize: 12, color: goalMet ? "#428858" : "#807898" }}>{fmtM(row.capitalReal)}</td>
                          <td style={{ padding: "8px 14px", textAlign: "right" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                              <div style={{ width: 50, height: 3, background: "#1e1c2c", borderRadius: 2 }}>
                                <div style={{ height: "100%", width: `${Math.min(100, row.progress)}%`, background: row.progress >= 100 ? "#50aa58" : row.progress > 60 ? "#c9a96e" : "#c05050", borderRadius: 2 }} />
                              </div>
                              <span style={{ fontFamily: "monospace", fontSize: 9, color: "#7870a0", minWidth: 36 }}>{pct(Math.min(row.progress, 100))}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* DEPLETION TAB */}
            {activeTab === "depletion" && (
              <div style={{ padding: "24px 26px", overflowY: "auto", maxHeight: "78vh" }}>

                {/* Summary cards */}
                <div className="depletion-summary" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
                  {[
                    [`Капитал (номинал, ${retireYear}г)`, fmtM(finalCapitalNominal), "#c9a96e"],
                    [`Капитал (реал., ${baseYear}г)`, fmtM(finalCapital), "#9090c0"],
                    ["Доходность на пенсии", pct(returnRate), "#50b878"],
                  ].map(([k, v, c]) => (
                    <div key={k} style={{ background: "#111020", border: "1px solid #1e1c2c", borderRadius: 10, padding: "12px 14px" }}>
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#7870a0", textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: 5 }}>{k}</div>
                      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: c }}>{v}</div>
                    </div>
                  ))}
                </div>

                {/* Header label */}
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#7870a0", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, padding: "0 4px" }}>
                  Доход в месяц = из капитала + гос. пенсия {fmt(statePension)}/мес
                </div>

                {/* Rows */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {depletionData.map(d => {
                    const isCurrent = d.rate === safeRate;
                    const barPct = d.infinite ? 100 : Math.min(100, ((d.years || 0) / 50) * 100);
                    const barColor = d.infinite ? "#50aa58" : (d.years || 0) >= 30 ? "#c9a96e" : (d.years || 0) >= 20 ? "#d09040" : "#c05050";
                    const lifeColor = d.infinite ? "#60cc68" : (d.years || 0) >= 30 ? "#d8b860" : (d.years || 0) >= 20 ? "#d09040" : "#d06060";
                    return (
                      <div key={d.rate} style={{
                        borderRadius: 9,
                        background: isCurrent ? "rgba(201,169,110,0.09)" : "rgba(255,255,255,0.02)",
                        border: isCurrent ? "1px solid rgba(201,169,110,0.35)" : "1px solid rgba(255,255,255,0.04)",
                        padding: "10px 14px",
                      }}>
                        {/* Top: rate + bar + lifetime */}
                        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                          <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: isCurrent ? "#c9a96e" : "#8880a8", minWidth: 34 }}>
                            {d.rate}%
                          </div>
                          <div style={{ flex: 1, height: 5, background: "#1e1c2c", borderRadius: 3 }}>
                            <div style={{ height: "100%", width: `${barPct}%`, background: barColor, borderRadius: 3 }} />
                          </div>
                          <div style={{ fontFamily: "monospace", fontSize: 11, color: lifeColor, whiteSpace: "nowrap" }}>
                            {d.infinite ? "∞ — капитал не иссякнет"
                              : (d.years || 0) === 0 ? "< 1 года"
                              : `${d.years} ${yrsWord(d.years)} → ${d.exhaustAge} лет (${d.exhaustYear}г)`}
                          </div>
                          {isCurrent && <div style={{ fontFamily: "monospace", fontSize: 8, color: "#c9a96e", background: "rgba(201,169,110,0.15)", padding: "2px 6px", borderRadius: 3 }}>◀ план</div>}
                        </div>
                        {/* Bottom: single income block */}
                        <div style={{ background: "#0e0d18", borderRadius: 6, padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#5a5878", marginBottom: 4 }}>НОМИНАЛ {retireYear}г</div>
                            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#5a5878" }}>РЕАЛ. {baseYear}г</div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: "#d8c880", marginBottom: 2 }}>{fmt(d.totalNominal)}</div>
                            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 14, color: "#a8a870" }}>{fmt(d.totalReal)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Legend */}
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 16 }}>
                  {[["#60cc68","∞ вечен"],["#d8b860","30+ лет"],["#d09040","20–30 лет"],["#d06060","< 20 лет"]].map(([c, l]) => (
                    <div key={l} style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: "monospace", fontSize: 9, color: "#7870a0" }}>
                      <div style={{ width: 10, height: 6, background: c, borderRadius: 2 }} />{l}
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(201,169,110,0.05)", border: "1px solid rgba(201,169,110,0.1)", borderRadius: 8, fontFamily: "monospace", fontSize: 10, color: "#8880a8", lineHeight: 1.9 }}>
                  Строка плана (<b style={{ color: "#c9a96e" }}>{pct(safeRate)}</b>) выделена рамкой ·
                  Номинал — рубли {retireYear}г · Реал. — покупательная способность {baseYear}г
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontFamily: "monospace", fontSize: 9, color: "#18162a", lineHeight: 2 }}>
          Расчёты носят ориентировочный характер · Реальная доходность и инфляция могут отличаться от прогноза
        </div>
      </div>
    </div>
  );
}
