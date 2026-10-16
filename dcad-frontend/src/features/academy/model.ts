export type DcfInputs = {
    noi: number[];
    capital: number[];
    nextNoi: number;
    discount: number;
    exitCap: number;
    selling: number;
};
export const defaultDcf: DcfInputs = { noi: [600000, 650000, 700000, 730000, 760000], capital: [150000, 50000, 40000, 40000, 40000], nextNoi: 790000, discount: 9, exitCap: 7, selling: 2 };
export function calculateDcf(input: DcfInputs) {
    const { noi, capital, nextNoi, discount, exitCap, selling } = input;
    if (noi.length !== 5 || capital.length !== 5 || ![...noi, ...capital, nextNoi, discount, exitCap, selling].every(Number.isFinite)
        || noi.some(n => n < 0) || capital.some(n => n < 0) || nextNoi < 0 || discount < 0 || discount > 100 || exitCap <= 0 || exitCap > 100 || selling < 0 || selling > 100) {
        throw new Error('Use nonnegative cash inputs, a 0–100% discount rate, an exit cap above 0% up to 100%, and selling costs of 0–100%.');
    }
    const sale = nextNoi / (exitCap / 100) * (1 - selling / 100);
    const rows = noi.map((n, i) => {
        const cash = n - capital[i];
        const reversion = i === 4 ? sale : 0;
        const factor = (1 + discount / 100) ** (i + 1);
        return { year: i + 1, noi: n, capital: capital[i], cash, reversion, total: cash + reversion, pv: (cash + reversion) / factor };
    });
    const operatingPv = rows.reduce((sum, row) => sum + row.cash / (1 + discount / 100) ** row.year, 0);
    const salePv = sale / (1 + discount / 100) ** 5;
    if (![sale, operatingPv, salePv, operatingPv + salePv, ...rows.flatMap(row => [row.total, row.pv])].every(Number.isFinite))
        throw new Error('The inputs exceed the model’s numeric range. Use realistic property amounts and rates.');
    return { rows, sale, operatingPv, salePv, value: operatingPv + salePv };
}
export function calculateDirect(units: number, rent: number, loss: number, vacancy: number, concessions: number, credit: number, other: number, expenses: number, cap: number) {
    if (![units, rent, loss, vacancy, concessions, credit, other, expenses, cap].every(Number.isFinite) || [units, rent, loss, concessions, credit, other, expenses].some(n => n < 0) || !Number.isInteger(units) || vacancy < 0 || vacancy > 100 || cap <= 0 || cap > 100)
        throw new Error('Enter nonnegative amounts, whole units, vacancy from 0–100%, and a cap rate above 0% up to 100%.');
    const gross = units * rent * 12;
    const vacancyLoss = gross * vacancy / 100;
    const egi = gross - loss - vacancyLoss - concessions - credit + other;
    const noi = egi - expenses;
    if (![gross, vacancyLoss, egi, noi, noi / (cap / 100)].every(Number.isFinite))
        throw new Error('The inputs exceed the model’s numeric range. Use realistic property amounts and rates.');
    return { gross, vacancyLoss, egi, noi, value: noi / (cap / 100) };
}
export function dcfCsv(input: DcfInputs) {
    calculateDcf(input);
    // Fixed labels and validated finite numeric inputs prevent spreadsheet formula injection.
    const rows: (string | number)[][] = [
        ['HomeNode fictional DCF practice model'],
        ['Discount rate', input.discount / 100], ['Exit cap', input.exitCap / 100], ['Selling cost', input.selling / 100], ['Year 6 NOI', input.nextNoi],
        ['Year', 'NOI', 'Capital and leasing', 'Operating cash flow', 'Net sale', 'Total cash flow', 'PV'],
        ...input.noi.map((n, i) => { const r = i + 7; return [i + 1, n, input.capital[i], `=B${r}-C${r}`, i === 4 ? '=$B$5/$B$3*(1-$B$4)' : 0, `=D${r}+E${r}`, `=F${r}/(1+$B$2)^A${r}`]; }),
        ['Property value', '', '', '', '', '', '=SUM(G7:G11)'],
        ['All receipts at year-end. Unlevered before income tax. Fictional educational inputs.'],
        ['NOI is before capital and leasing costs. Year 6 NOI is for terminal pricing only.'],
        ['Excel NPV check', '', '', '', '', '', '=NPV(B2,F7:F11)'],
    ];
    return rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
}
