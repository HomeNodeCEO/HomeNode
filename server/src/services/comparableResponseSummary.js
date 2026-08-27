export function summarizeComparableResults(sales) {
  const recommendedSales = [];
  const secondarySales = [];
  let olderThanOneYearCount = 0;
  let olderThanTwoYearsCount = 0;

  for (const sale of sales) {
    if (sale.soldOverOneYear) olderThanOneYearCount += 1;
    if (sale.soldOverTwoYears) olderThanTwoYearsCount += 1;

    if (sale.recommended) {
      recommendedSales.push(sale);
    } else if (
      sale.insideAnalysisPeriod &&
      sale.housingTypeCompatible !== false
    ) {
      secondarySales.push(sale);
    }
  }

  secondarySales.sort((left, right) =>
    Number(Boolean(right.influence_support_candidate)) - Number(Boolean(left.influence_support_candidate)) ||
    Number(right.influence_similarity?.priority_tier || 0) - Number(left.influence_similarity?.priority_tier || 0) ||
    Number(right.comparableScore || 0) - Number(left.comparableScore || 0),
  );

  return {
    recommendedSales,
    secondarySales,
    olderThanOneYearCount,
    olderThanTwoYearsCount,
  };
}
