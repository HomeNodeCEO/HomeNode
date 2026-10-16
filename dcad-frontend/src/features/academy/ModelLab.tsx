import { useState } from 'react';
import { calculateDcf, calculateDirect, dcfCsv, defaultDcf } from './model';
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const number = (s: string) => s.trim() === '' ? NaN : Number(s);
const directDefaults = ['80', '1500', '48000', '5', '12000', '8000', '60000', '560000', '6.25'];
const directLabels = ['Units', 'Market rent / unit / month ($)', 'Annual loss to lease ($)', 'Vacancy (% of market GPR)', 'Annual concessions ($)', 'Annual credit loss ($)', 'Collected other income ($/yr)', 'Operating expenses ($/yr)', 'Cap rate (%)'];
function download(content: string, filename: string) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function ModelLab() {
    const [mode, setMode] = useState<'dcf' | 'direct'>('dcf');
    const [noi, setNoi] = useState(defaultDcf.noi.map(String));
    const [capital, setCapital] = useState(defaultDcf.capital.map(String));
    const [rates, setRates] = useState(['790000', '9', '7', '2']);
    const [direct, setDirect] = useState(directDefaults);
    const input = { noi: noi.map(number), capital: capital.map(number), nextNoi: number(rates[0]), discount: number(rates[1]), exitCap: number(rates[2]), selling: number(rates[3]) };
    let result: ReturnType<typeof calculateDcf> | undefined;
    let capResult: ReturnType<typeof calculateDirect> | undefined;
    let error = '';
    try {
        if (mode === 'dcf')
            result = calculateDcf(input);
        else
            capResult = calculateDirect(...direct.map(number) as [
                number,
                number,
                number,
                number,
                number,
                number,
                number,
                number,
                number
            ]);
    }
    catch (e) {
        error = e instanceof Error ? e.message : 'Check the inputs.';
    }
    const setAt = (values: string[], index: number, value: string) => values.map((n, i) => i === index ? value : n);
    return <section className="academy-lab">
    <div className="academy-section-heading"><div><span className="academy-kicker">LEARN BY CHANGING THE INPUTS</span><h2>Model lab</h2></div><div className="academy-segment"><button aria-pressed={mode === 'dcf'} onClick={() => setMode('dcf')}>Office DCF</button><button aria-pressed={mode === 'direct'} onClick={() => setMode('direct')}>Multifamily direct cap</button></div></div>
    <p>Fictional educational inputs. Change one assumption, explain the result, then test a coherent scenario. These are practice rates, not current Dallas market estimates.</p>
    {mode === 'dcf' ? <>
      <div className="academy-input-grid">{['Year 6 NOI ($)', 'Discount rate (%)', 'Exit cap (%)', 'Selling costs (%)'].map((label, i) => <label key={label}>{label}<input type="number" step="any" value={rates[i]} onChange={e => setRates(setAt(rates, i, e.target.value))}/></label>)}</div>
      <div className="academy-table-wrap"><table><caption>Parkline Office • five-year unlevered cash flow</caption><thead><tr><th>Year</th><th>NOI ($)</th><th>Capital & leasing ($)</th><th>Operating cash flow</th><th>Net sale</th><th>Present value</th></tr></thead><tbody>{noi.map((n, i) => <tr key={i}><th>{i + 1}</th><td><input aria-label={`Year ${i + 1} NOI`} type="number" value={n} onChange={e => setNoi(setAt(noi, i, e.target.value))}/></td><td><input aria-label={`Year ${i + 1} capital and leasing costs`} type="number" value={capital[i]} onChange={e => setCapital(setAt(capital, i, e.target.value))}/></td><td>{result ? money(result.rows[i].cash) : '—'}</td><td>{result ? money(result.rows[i].reversion) : '—'}</td><td>{result ? money(result.rows[i].pv) : '—'}</td></tr>)}</tbody></table></div>
      {result && <><div className="academy-model-results" aria-live="polite"><div><small>Operating cash-flow PV</small><strong>{money(result.operatingPv)}</strong></div><div><small>Net reversion PV</small><strong>{money(result.salePv)}</strong></div><div><small>Property value</small><strong>{money(result.value)}</strong></div></div>
        <p className="academy-small">Year 5 receives its operating cash flow and the net sale. Year 6 NOI prices the sale; it is not a separate receipt. All cash flows are at year-end, before financing and investor income tax. Capital/leasing costs are separate from NOI.</p>
        {result.value > 0 && <p>Reversion represents <strong>{(result.salePv / result.value * 100).toFixed(1)}%</strong> of this indication. Explain whether the terminal income and exit assumptions deserve that reliance.</p>}
        <div className="academy-table-wrap"><table><caption>Value sensitivity • rows: discount rate; columns: exit cap</caption><thead><tr><th>Yield / cap</th>{[-.5, 0, .5].map(delta => <th key={delta}>{(input.exitCap + delta).toFixed(2)}%</th>)}</tr></thead><tbody>{[-1, 0, 1].map(delta => <tr key={delta}><th>{(input.discount + delta).toFixed(2)}%</th>{[-.5, 0, .5].map(capDelta => { const d = input.discount + delta, c = input.exitCap + capDelta; return <td key={capDelta} className={delta === 0 && capDelta === 0 ? 'academy-base-cell' : ''}>{d < 0 || d > 100 || c <= 0 || c > 100 ? 'Outside range' : money(calculateDcf({ ...input, discount: d, exitCap: c }).value)}</td>; })}</tr>)}</tbody></table></div>
      </>}
      <div className="academy-actions"><button className="academy-primary" disabled={!result} onClick={() => download(dcfCsv(input), 'HomeNode-DCF-practice.csv')}>Download formula CSV</button><button onClick={() => { setNoi(defaultDcf.noi.map(String)); setCapital(defaultDcf.capital.map(String)); setRates(['790000', '9', '7', '2']); }}>Restore case inputs</button></div>
      <p className="academy-small">The CSV includes editable inputs, Excel formulas and an NPV cross-check. Open in Excel or import into a spreadsheet; set rate cells B2:B4 to percentage format. Formula separators may vary with locale.</p>
    </> : <>
      <div className="academy-input-grid">{directLabels.map((label, i) => <label key={label}>{label}<input type="number" step="any" value={direct[i]} onChange={e => setDirect(setAt(direct, i, e.target.value))}/></label>)}</div>
      {capResult && <><div className="academy-model-results" aria-live="polite"><div><small>Market GPR</small><strong>{money(capResult.gross)}</strong></div><div><small>EGI</small><strong>{money(capResult.egi)}</strong></div><div><small>NOI before reserves</small><strong>{money(capResult.noi)}</strong></div><div><small>Direct-cap indication</small><strong>{money(capResult.value)}</strong></div></div>
      <p>Vacancy loss: {money(capResult.vacancyLoss)}. Each loss is separate and non-overlapping. Other income is already a collected estimate. Capital costs, debt service and investor income tax are excluded from this NOI.</p>
      {capResult.noi <= 0 && <p role="status" className="academy-feedback">Nonpositive NOI: the arithmetic alone does not provide a useful stabilized direct-cap market value. Reassess the operating premise and method.</p>}</>}
      <button onClick={() => setDirect(directDefaults)}>Restore case inputs</button>
    </>}
    {error && <p role="alert" className="academy-error">{error}</p>}
    <details className="academy-exercise"><summary>Try a model audit exercise</summary><p>1. Reproduce the base-case value independently. 2. Raise the exit cap by 50 basis points. 3. Double Year 2 leasing costs. 4. Explain why those changes affect value differently. 5. Trace every sale receipt and check that it appears once.</p><p>AI prompt to practice: “Audit this fictional model for timing, signs, units, duplicated costs and unsupported assumptions. Cite the cell or row for each issue. Do not change assumptions merely to reach a target value.” Verify every proposed correction yourself.</p></details>
  </section>;
}
